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

// Marker inside every fake object-store secret, so "no secret in the logs"
// (issue #1093) is a substring assertion over the captured log stream rather
// than an eyeball check.
const OBJECT_STORE_SECRET_MARKER = 'objectstore-secret-must-never-be-logged';

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
  // The pull worker clears any orphaned multipart upload for the key before it
  // writes (issue #1088). Nothing is ever left in progress here.
  async abortIncompleteMultipartUploads(): Promise<number> {
    return 0;
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

// `credentialStack` is the stack the object-store credential/endpoint was
// resolved from (WorkspaceConnections.s3Config.stackName, issue #1093). It
// defaults to this stack — the correct case — and is overridden only to
// construct the deliberately mis-routed credential the #1093 suite needs.
function makeStack(name: string, credentialStack: string = name): Stack {
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
    s3Config: {
      endpoint: `https://${credentialStack}.minio-minio.example`,
      accessKey: 'admin',
      // Distinctive so a test can assert the refusal log (and any other log
      // line) never carries the object-store secret (issue #1093).
      secretKey: `${OBJECT_STORE_SECRET_MARKER}-${credentialStack}`,
      stackName: credentialStack
    },
    stackName: name
  } as unknown as WorkspaceConnections;
  return { name, assets, jobs, pipelines, storage, connections };
}

type Harness = {
  app: FastifyInstance;
  stacks: Record<string, Stack>;
  submitted: EncoreSubmitInput[];
  submittedInputs: Array<{ inputUri?: string }>;
  // Simulates the resolver cache entry ageing past CACHE_TTL_MS
  // (services/workspace-stack.ts) WITHOUT touching resolve(): only the cached
  // read goes cold, which is exactly the real expiry behaviour and the condition
  // the post-pull continuation can hit on a long transfer (issue #1058 review).
  expireResolverCache: () => void;
  // Storage handles the extractor was actually invoked with, in order.
  extractedWith: Array<{ assetId: string; storage: unknown }>;
  // Every line the app's own logger emitted, raw (issue #1093): the no-secret
  // assertion reads the serialised output, not a structured stub, so a secret
  // smuggled through a nested object or an `err` field would still show up.
  logLines: string[];
};

// Resolver stub keyed exactly like WorkspaceStackResolver: a name with a stored
// config wins verbatim; anything else (no name, unknown name) falls back to the
// FIRST listed stack. `names[0]` is the default stack.
async function buildApp(
  names: string[],
  opts: {
    resolveStackContext?: (requested?: string) => Promise<string | undefined>;
    // Stack name -> the stack its object-store credential actually belongs to
    // (issue #1093). Absent entries keep the correct same-stack credential.
    credentialStack?: Record<string, string>;
  } = {}
): Promise<Harness> {
  const stacks: Record<string, Stack> = {};
  for (const n of names) stacks[n] = makeStack(n, opts.credentialStack?.[n] ?? n);
  const pick = (requested?: string): Stack =>
    (requested && stacks[requested]) || stacks[names[0]!]!;

  let cacheCold = false;
  const resolver = {
    resolve: async (stackName?: string) => pick(stackName).connections,
    resolveCached: (stackName?: string) =>
      cacheCold ? undefined : pick(stackName).connections,
    resolveStackName: async (requested?: string) =>
      requested && stacks[requested] ? requested : names[0]
  } as unknown as WorkspaceStackResolver;

  // Records which WorkspaceStorage each extraction ran against, so a test can
  // assert the handle came from the right stack rather than only that an
  // extraction happened.
  const extractedWith: Array<{ assetId: string; storage: unknown }> = [];

  const submitted: EncoreSubmitInput[] = [];
  const encore: EncoreClient = {
    async submit(input) {
      submitted.push(input);
      return { encoreInternalId: 'encore-internal-1' };
    }
  };

  // Capture the app's real log output so the no-secret assertion runs against
  // what a deployment would actually write to stdout (issue #1093).
  const logLines: string[] = [];
  const app = Fastify({
    logger: {
      level: 'info',
      stream: {
        write(line: string) {
          logLines.push(line);
        }
      }
    }
  });
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
    // Probe + extractor stubs so the fire-and-forget extraction actually runs
    // (triggerExtraction no-ops without `probe`). The extractor records the
    // storage handle it was handed instead of doing any work.
    probe: async () => ({ streams: [], format: {} }) as never,
    extract: (async (params: { assetId: string }, deps: { storage: unknown }) => {
      extractedWith.push({ assetId: params.assetId, storage: deps.storage });
    }) as never,
    resolveStackContext:
      opts.resolveStackContext ??
      (async (requested?: string) => (requested && stacks[requested] ? requested : names[0]))
  });
  await app.ready();
  return {
    app,
    stacks,
    submitted,
    submittedInputs: submitted as Array<{ inputUri?: string }>,
    expireResolverCache: () => {
      cacheCold = true;
    },
    extractedWith,
    logLines
  };
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

  // Issue #1058 review, finding 3. The post-pull metadata extraction used to call
  // the request-scoped storage factory a SECOND time, from inside the detached
  // `.then()` that runs after the pull settles. That factory is a cache read, so
  // on a transfer longer than the resolver TTL it returned undefined and THREW —
  // inside a promise with no `.catch` — losing the extraction silently and
  // raising an unhandled rejection. The handle is now captured once, before the
  // pull, and reused.
  it('still extracts metadata on the NAMED stack when the resolver cache expires mid-pull', async () => {
    const payload = Buffer.from('hello-video-bytes');
    // Gate the response body so the pull is provably still in flight when the
    // cache goes cold — no sleep-based race.
    const body = new Readable({ read() {} });
    const fetch = vi.fn(
      async () =>
        new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
          headers: { 'content-length': String(payload.length) }
        })
    ) as unknown as typeof globalThis.fetch;

    const h = await buildApp(['a', 'b']);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch;
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/assets/ingest-url',
        headers: { ...AUTH, 'x-stack-name': 'b' },
        payload: { sourceUrl: 'https://example.com/clip.mp4', name: 'clip' }
      });
      expect(res.statusCode).toBe(202);
      const { assetId } = res.json();

      // The request has returned and the pull is open: age the cache entry out,
      // then let the bytes through.
      h.expireResolverCache();
      body.push(payload);
      body.push(null);

      // The bytes still land on the named stack (the pull holds its own handle).
      await waitFor(() => h.stacks['b']!.storage.stored.length > 0);
      expect(h.stacks['b']!.storage.stored).toEqual([`ingest/${assetId}`]);

      // ...and the extraction STILL runs, against stack b's storage, even though
      // a fresh `resolveCached('b')` would now return undefined. Pre-fix this
      // array stayed empty and an unhandled rejection was raised instead.
      await waitFor(() => h.extractedWith.length > 0);
      expect(h.extractedWith).toHaveLength(1);
      expect(h.extractedWith[0]!.assetId).toBe(assetId);
      expect(h.extractedWith[0]!.storage).toBe(h.stacks['b']!.storage);
      expect(h.extractedWith[0]!.storage).not.toBe(h.stacks['a']!.storage);

      // Give any stray rejection a turn of the loop to surface before asserting.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
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

describe('submit asserts the object-store credential belongs to the routed stack (issue #1093)', () => {
  // The split #1058's guard cannot see. Documents and control plane BOTH
  // resolve 'b', so stackRoutingMismatch is satisfied — but the object-store
  // credential and endpoint carried on those connections were resolved for
  // stack 'a'. Every stack's source bucket has the identical literal name, so
  // pre-#1093 this submitted happily and the transcoder failed later with a
  // missing-object error (NoSuchKey) that named neither stack.
  async function misRoutedCredentialHarness(): Promise<Harness> {
    return buildApp(['a', 'b'], { credentialStack: { b: 'a' } });
  }

  async function readyAssetOnB(h: Harness): Promise<string> {
    const asset = await h.stacks['b']!.assets.create({ name: 'clip' });
    await h.stacks['b']!.assets.update(asset.id, { objectKey: `ingest/${asset.id}` });
    await h.stacks['b']!.assets.update(asset.id, { status: 'processing' });
    await h.stacks['b']!.assets.update(asset.id, { status: 'ready' });
    return asset.id;
  }

  it('fails fast naming the expected and actual stack ids instead of a missing-object error', async () => {
    const h = await misRoutedCredentialHarness();
    const id = await readyAssetOnB(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { ...AUTH, 'x-stack-name': 'b' },
      payload: {}
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('stack_routing_mismatch');
    // EXPECTED (routed) and ACTUAL (credential) stack ids are both named.
    expect(res.json().message).toContain('belong to stack "a"');
    expect(res.json().message).toContain('routes to stack "b"');
    // Nothing was handed to the transcoder, so there is no NoSuchKey to wait for.
    expect(h.submitted).toHaveLength(0);
  });

  it('refuses a pipeline whose transcode step would read with the wrong credential', async () => {
    const h = await misRoutedCredentialHarness();
    const id = await readyAssetOnB(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/execute`,
      headers: { ...AUTH, 'x-stack-name': 'b' },
      payload: { pipeline: 'abr-vod' }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('stack_routing_mismatch');
    expect(h.submitted).toHaveLength(0);
    // ...and no dangling execution record, same invariant as #1058.
    expect(await h.stacks['b']!.pipelines.listByAsset(id)).toHaveLength(0);
  });

  it('never writes the object-store secret to the log, only the stack id and endpoint host', async () => {
    const h = await misRoutedCredentialHarness();
    const id = await readyAssetOnB(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { ...AUTH, 'x-stack-name': 'b' },
      payload: {}
    });
    expect(res.statusCode).toBe(409);

    const log = h.logLines.join('\n');
    // The refusal WAS logged, with both identities and the endpoint host.
    expect(log).toContain('"reason":"object-store-credential"');
    expect(log).toContain('"expectedStack":"b"');
    expect(log).toContain('"actualStack":"a"');
    expect(log).toContain('"actualEndpointHost":"a.minio-minio.example"');
    // ...and the secret appears nowhere in the output.
    expect(log).not.toContain(OBJECT_STORE_SECRET_MARKER);
  });

  it('submits normally when the credential belongs to the routed stack', async () => {
    const h = await buildApp(['a', 'b']);
    const id = await readyAssetOnB(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { ...AUTH, 'x-stack-name': 'b' },
      payload: {}
    });

    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
    expect(h.logLines.join('\n')).not.toContain(OBJECT_STORE_SECRET_MARKER);
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
