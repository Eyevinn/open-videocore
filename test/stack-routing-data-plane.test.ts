// Regression coverage for issue #1058 — the data plane must resolve the SAME
// stack the request names.
//
// Reproduces the two-stack divergence reported on a live install: stacks
// ['a','b'] provisioned in that order, every request carrying
// `X-Stack-Name: b`. Before the fix the data plane resolved with NO stack name
// (first listed stack = 'a') for asset documents, the URL-pull worker's write
// and the presigned `/files` URLs, while the transcode control plane resolved
// 'b' from the header (issue #615) — so the bytes were written to 'a' and read
// from 'b'. Both stacks' source buckets carry the identical literal name, so the
// only symptom was an indistinguishable 404 from the transcoder.
//
// The harness stubs ONLY the stack resolver boundary (two sets of in-memory
// repositories + fake storage). Everything under test is production code: the
// `onRequest` AsyncLocalStorage hook and the storage factory from
// src/services/request-stack-context.ts (wired exactly as src/main.ts wires
// them), the PerWorkspace* repositories, and the assets router.

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { Readable } from 'node:stream';

import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import {
  PerWorkspaceAssetRepository,
  PerWorkspaceJobRepository,
  PerWorkspacePipelineRepository
} from '../src/data/per-workspace-repos.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import {
  makeRequestScopedStorageFactory,
  requestStackNameFromHeaders,
  runWithRequestStack,
  currentRequestStackName
} from '../src/services/request-stack-context.js';
import type { WorkspaceConnections, WorkspaceStackResolver } from '../src/services/workspace-stack.js';
import type { EncoreClient, EncoreSubmitInput } from '../src/pipeline/encore-client.js';

// Every provisioned stack gets a bucket with the SAME literal name
// (src/routes/provision.ts), which is what makes the divergence silent.
const SOURCE_BUCKET = 'openvideocore-source';

// Fake object store for one stack. Records the keys written and mints presigned
// URLs against that stack's own endpoint host, so a URL alone identifies the
// instance it points at.
class FakeStackStorage {
  readonly stored: string[] = [];
  constructor(private readonly stack: string) {}
  async putStream(
    key: string,
    source: Readable,
    opts: { maxBytes: number; totalBytes?: number; onProgress?: (b: number, t?: number) => void }
  ): Promise<{ etag: string; bytesTransferred: number }> {
    let transferred = 0;
    for await (const chunk of source) {
      transferred += (chunk as Buffer).length;
      opts.onProgress?.(transferred, opts.totalBytes);
    }
    this.stored.push(key);
    return { etag: `etag-${this.stack}`, bytesTransferred: transferred };
  }
  async presignedGet(key: string): Promise<string> {
    return `https://${this.stack}.minio-minio.example/${SOURCE_BUCKET}/${key}?signed=1`;
  }
  async statObject(): Promise<{ size: number; etag: string }> {
    return { size: 1, etag: `etag-${this.stack}` };
  }
}

type Stack = {
  name: string;
  assets: InMemoryAssetRepository;
  jobs: InMemoryJobRepository;
  pipelines: InMemoryPipelineRepository;
  storage: FakeStackStorage;
  connections: WorkspaceConnections;
};

function makeStack(name: string): Stack {
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();
  const storage = new FakeStackStorage(name);
  const connections = {
    assets,
    jobs,
    pipelines,
    storageFor: () => storage,
    storageClient: undefined,
    sourceBucket: SOURCE_BUCKET,
    packagedBucket: 'openvideocore-packaged',
    s3Config: { endpoint: `https://${name}.minio-minio.example`, accessKey: 'admin', secretKey: 'x' },
    stackName: name
  } as unknown as WorkspaceConnections;
  return { name, assets, jobs, pipelines, storage, connections };
}

type Harness = {
  app: FastifyInstance;
  stacks: Record<string, Stack>;
  submitted: EncoreSubmitInput[];
  submittedInputs: Array<{ inputUri?: string }>;
};

// Resolver stub keyed exactly like WorkspaceStackResolver: a name with a stored
// config wins verbatim; anything else (no name, unknown name) falls back to the
// FIRST listed stack. `names[0]` is the default stack.
async function buildApp(
  names: string[],
  opts: { resolveStackContext?: (requested?: string) => Promise<string | undefined> } = {}
): Promise<Harness> {
  const stacks: Record<string, Stack> = {};
  for (const n of names) stacks[n] = makeStack(n);
  const pick = (requested?: string): Stack =>
    (requested && stacks[requested]) || stacks[names[0]!]!;

  const resolver = {
    resolve: async (stackName?: string) => pick(stackName).connections,
    resolveCached: (stackName?: string) => pick(stackName).connections,
    resolveStackName: async (requested?: string) =>
      requested && stacks[requested] ? requested : names[0]
  } as unknown as WorkspaceStackResolver;

  const submitted: EncoreSubmitInput[] = [];
  const encore: EncoreClient = {
    async submit(input) {
      submitted.push(input);
      return { encoreInternalId: 'encore-internal-1' };
    }
  };

  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Exactly the wiring in src/main.ts: the ALS hook first, then the per-request
  // connections resolved from the SAME ambient stack name.
  app.addHook('onRequest', (request, _reply, done) => {
    runWithRequestStack(requestStackNameFromHeaders(request.headers), done);
  });
  app.decorateRequest('connections', null);
  app.addHook('preHandler', async (request) => {
    request.connections = await resolver.resolve(currentRequestStackName());
  });

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: new PerWorkspaceAssetRepository(resolver),
    jobRepository: new PerWorkspaceJobRepository(resolver),
    storageFor: makeRequestScopedStorageFactory(resolver),
    pipelineRepository: new PerWorkspacePipelineRepository(resolver),
    encore,
    sourceBucket: SOURCE_BUCKET,
    outputBucket: 'openvideocore-packaged',
    pullDeps: { sleep: async () => {}, baseBackoffMs: 0 },
    resolveStackContext:
      opts.resolveStackContext ??
      (async (requested?: string) => (requested && stacks[requested] ? requested : names[0]))
  });
  await app.ready();
  return { app, stacks, submitted, submittedInputs: submitted as Array<{ inputUri?: string }> };
}

const AUTH = { authorization: 'Bearer test-token' };

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met in time');
}

describe('data plane resolves the stack the request names (issue #1058)', () => {
  it('writes the URL-pull object to the NAMED stack, not the first-listed one', async () => {
    const payload = Buffer.from('hello-video-bytes');
    const fetch = vi.fn(
      async () => new Response(payload, { headers: { 'content-length': String(payload.length) } })
    ) as unknown as typeof globalThis.fetch;

    const h = await buildApp(['a', 'b']);
    // Re-register is not possible after ready(); inject the fetch through the
    // worker's dep bag by patching the global fetch instead.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/assets/ingest-url',
        headers: { ...AUTH, 'x-stack-name': 'b' },
        payload: { sourceUrl: 'https://example.com/clip.mp4', name: 'clip' }
      });
      expect(res.statusCode).toBe(202);
      const { assetId } = res.json();

      // The asset DOCUMENT is created on the named stack.
      expect(await h.stacks['b']!.assets.get(assetId)).toBeDefined();
      expect(await h.stacks['a']!.assets.get(assetId)).toBeUndefined();

      // ...and so are the BYTES. Pre-fix this landed in stack 'a'.
      await waitFor(() => h.stacks['b']!.storage.stored.length > 0);
      expect(h.stacks['b']!.storage.stored).toEqual([`ingest/${assetId}`]);
      expect(h.stacks['a']!.storage.stored).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('presigns GET /:id/files URLs against the NAMED stack (delivery impact)', async () => {
    const h = await buildApp(['a', 'b']);
    const asset = await h.stacks['b']!.assets.create({ name: 'clip' });
    await h.stacks['b']!.assets.update(asset.id, { objectKey: `ingest/${asset.id}` });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${asset.id}/files`,
      headers: { ...AUTH, 'x-stack-name': 'b' }
    });
    expect(res.statusCode).toBe(200);
    const source = res.json().files.find((f: { type: string }) => f.type === 'source');
    // Pre-fix this URL named stack 'a' under EITHER header value.
    expect(source.url).toContain('https://b.minio-minio.example/');
    expect(source.url).not.toContain('https://a.minio-minio.example/');
  });

  it('submits the transcode source read against the NAMED stack', async () => {
    const h = await buildApp(['a', 'b']);
    const asset = await h.stacks['b']!.assets.create({ name: 'clip' });
    await h.stacks['b']!.assets.update(asset.id, { objectKey: `ingest/${asset.id}` });
    await h.stacks['b']!.assets.update(asset.id, { status: 'processing' });
    await h.stacks['b']!.assets.update(asset.id, { status: 'ready' });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/transcode`,
      headers: { ...AUTH, 'x-stack-name': 'b' },
      payload: {}
    });
    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
    // The scaler partition key (externalId prefix) is the named stack — and the
    // asset it reads was resolved from that same stack, which is the invariant
    // #1058 broke.
    expect(h.submitted[0]!.externalId.split('__')[0]).toBe('b');
    expect(h.submitted[0]!.inputUri).toBe(`s3://${SOURCE_BUCKET}/ingest/${asset.id}`);
  });
});

describe('transcode refuses a data-plane / control-plane stack split (issue #1058)', () => {
  it('fails loud with stack_routing_mismatch instead of submitting an unreadable source', async () => {
    // Control plane pinned to 'a' while the request (and therefore the data
    // plane) names 'b' — the exact split reported on the two-stack install.
    const h = await buildApp(['a', 'b'], { resolveStackContext: async () => 'a' });
    const asset = await h.stacks['b']!.assets.create({ name: 'clip' });
    await h.stacks['b']!.assets.update(asset.id, { objectKey: `ingest/${asset.id}` });
    await h.stacks['b']!.assets.update(asset.id, { status: 'processing' });
    await h.stacks['b']!.assets.update(asset.id, { status: 'ready' });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/transcode`,
      headers: { ...AUTH, 'x-stack-name': 'b' },
      payload: {}
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('stack_routing_mismatch');
    // The message names BOTH stacks — identities, not endpoint hostnames
    // (hostnames legitimately differ in-cluster vs public ingress, issue #991).
    expect(res.json().message).toContain('"b"');
    expect(res.json().message).toContain('"a"');
    expect(h.submitted).toHaveLength(0);
  });

  it('submits normally when both planes resolve the same stack', async () => {
    const h = await buildApp(['a', 'b']);
    const asset = await h.stacks['b']!.assets.create({ name: 'clip' });
    await h.stacks['b']!.assets.update(asset.id, { objectKey: `ingest/${asset.id}` });
    await h.stacks['b']!.assets.update(asset.id, { status: 'processing' });
    await h.stacks['b']!.assets.update(asset.id, { status: 'ready' });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/transcode`,
      headers: { ...AUTH, 'x-stack-name': 'b' },
      payload: {}
    });
    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
  });
});

describe('pipeline execute refuses a stack split too (issue #1058)', () => {
  // POST /:id/execute is the path the live reproduction used
  // (`{"pipeline":"abr-vod"}`), and its transcode step is reached AFTER the
  // execution record is created — so the guard must run before that.
  async function readyAsset(h: Harness): Promise<string> {
    const asset = await h.stacks['b']!.assets.create({ name: 'clip' });
    await h.stacks['b']!.assets.update(asset.id, { objectKey: `ingest/${asset.id}` });
    await h.stacks['b']!.assets.update(asset.id, { status: 'processing' });
    await h.stacks['b']!.assets.update(asset.id, { status: 'ready' });
    return asset.id;
  }

  it('409s abr-vod before creating the execution when the planes disagree', async () => {
    const h = await buildApp(['a', 'b'], { resolveStackContext: async () => 'a' });
    const id = await readyAsset(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/execute`,
      headers: { ...AUTH, 'x-stack-name': 'b' },
      payload: { pipeline: 'abr-vod' }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('stack_routing_mismatch');
    expect(h.submitted).toHaveLength(0);
    // No dangling execution record was left behind.
    expect(await h.stacks['b']!.pipelines.listByAsset(id)).toHaveLength(0);
  });

  it('runs abr-vod normally when both planes resolve the same stack', async () => {
    const h = await buildApp(['a', 'b']);
    const id = await readyAsset(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/execute`,
      headers: { ...AUTH, 'x-stack-name': 'b' },
      payload: { pipeline: 'abr-vod' }
    });

    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.externalId.split('__')[0]).toBe('b');
  });
});

describe('no stack name — unchanged default-stack behaviour (issue #1058)', () => {
  it('resolves the first listed stack when the request names none', async () => {
    const h = await buildApp(['a', 'b']);
    const asset = await h.stacks['a']!.assets.create({ name: 'clip' });
    await h.stacks['a']!.assets.update(asset.id, { objectKey: `ingest/${asset.id}` });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${asset.id}/files`,
      headers: AUTH
    });
    expect(res.statusCode).toBe(200);
    const source = res.json().files.find((f: { type: string }) => f.type === 'source');
    expect(source.url).toContain('https://a.minio-minio.example/');
  });
});
