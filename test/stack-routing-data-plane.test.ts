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
import { runnerFactory, type RunnerS3Config } from '../src/pipeline/runner-option.js';
import { thumbnailObjectKey, type FrameTarget } from '../src/pipeline/thumbnail.js';

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
  // The pull worker clears any orphaned multipart upload for the key before it
  // writes (issue #1088). Nothing is ever left in progress here.
  async abortIncompleteMultipartUploads(): Promise<number> {
    return 0;
  }
  async presignedGet(key: string): Promise<string> {
    return `https://${this.stack}.minio-minio.example/${SOURCE_BUCKET}/${key}?signed=1`;
  }
  // The thumbnail orchestrator presigns one PUT per frame
  // (src/pipeline/thumbnail.ts:133). Same stack-identifying host as the GET, so
  // a URL alone says which instance the frame would be written to.
  async presignedPut(key: string): Promise<string> {
    return `https://${this.stack}.minio-minio.example/${SOURCE_BUCKET}/${key}?signed=put`;
  }
  // Keys this stack's store does NOT hold. Default is "every key is present"
  // (what the other cases here need); a test marks a key absent in one stack to
  // show which stack a probe actually addressed — the pre-dispatch source
  // readiness check (issue #1059) stats through this method.
  readonly absentKeys = new Set<string>();
  async statObject(key: string): Promise<{ size: number; etag: string } | undefined> {
    if (this.absentKeys.has(key)) return undefined;
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
  // Simulates the resolver cache entry ageing past CACHE_TTL_MS
  // (services/workspace-stack.ts) WITHOUT touching resolve(): only the cached
  // read goes cold, which is exactly the real expiry behaviour and the condition
  // the post-pull continuation can hit on a long transfer (issue #1058 review).
  expireResolverCache: () => void;
  // Storage handles the extractor was actually invoked with, in order.
  extractedWith: Array<{ assetId: string; storage: unknown }>;
  // Every thumbnail dispatch, in order: the credentials the runner FACTORY was
  // built from (control plane, issue #1062) and the presigned source URL the
  // orchestrator read through (data plane, issue #1058). Both carry the stack
  // identity, so one array proves which stack each plane resolved.
  thumbnailedWith: Array<{ s3: RunnerS3Config; sourceUrl: string; frames: FrameTarget[] }>;
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

  // Thumbnails are injected as a FACTORY, exactly as production does
  // (src/main.ts builds the eyevinn-ffmpeg-s3 runner from the stack's MinIO
  // credentials), so the test exercises resolveRunnerOption rather than the
  // plain-runner shortcut tests usually take.
  const thumbnailedWith: Array<{ s3: RunnerS3Config; sourceUrl: string; frames: FrameTarget[] }> =
    [];
  const thumbnailExtractor = runnerFactory<
    (sourceUrl: string, frames: FrameTarget[]) => Promise<void>
  >((s3) => async (sourceUrl, frames) => {
    thumbnailedWith.push({ s3, sourceUrl, frames });
  });

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
    // Probe + extractor stubs so the fire-and-forget extraction actually runs
    // (triggerExtraction no-ops without `probe`). The extractor records the
    // storage handle it was handed instead of doing any work.
    probe: async () => ({ streams: [], format: {} }) as never,
    extract: (async (params: { assetId: string }, deps: { storage: unknown }) => {
      extractedWith.push({ assetId: params.assetId, storage: deps.storage });
    }) as never,
    thumbnailExtractor,
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
    thumbnailedWith
  };
}

const AUTH = { authorization: 'Bearer test-token' };

// `check` may be async (a repository read). The result is AWAITED — a returned
// promise is always truthy, so testing it directly would make every async
// predicate pass on the first tick.
async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
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

  // Issue #1050 / PR review point 3. The URL-ingest poster frame runs from the
  // SAME detached post-pull continuation as the metadata extraction above, so it
  // inherits both of that continuation's stack hazards. Every earlier #1050 test
  // ran on a single default stack, which cannot tell a correctly-threaded handle
  // from an ambient one — on one stack every resolution answers the same thing.
  // These two pin it with a NON-DEFAULT `x-stack-name: b` against stacks
  // ['a','b'], so 'a' (first listed = default) is what a missed thread resolves
  // to and the assertion fails loudly rather than vacuously passing.
  it('extracts the URL-ingest poster frame on the NAMED stack, not the default one', async () => {
    const payload = Buffer.from('hello-video-bytes');
    const fetch = vi.fn(
      async () => new Response(payload, { headers: { 'content-length': String(payload.length) } })
    ) as unknown as typeof globalThis.fetch;

    const h = await buildApp(['a', 'b']);
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

      await waitFor(() => h.thumbnailedWith.length > 0);
      expect(h.thumbnailedWith).toHaveLength(1);
      const run = h.thumbnailedWith[0]!;

      // Control plane: the runner factory was built from stack b's MinIO
      // coordinates (requestRunnerS3Config off request.connections, issue #1062).
      expect(run.s3.endpoint).toBe('https://b.minio-minio.example');
      expect(run.s3.endpoint).not.toBe('https://a.minio-minio.example');

      // Data plane: the source it reads, and the destinations it writes, are
      // presigned by stack b's OWN storage handle — the one threaded in as
      // `pullStorage`, not a fresh ambient resolution.
      expect(run.sourceUrl).toContain('https://b.minio-minio.example/');
      expect(run.sourceUrl).toContain(`ingest/${assetId}`);
      expect(run.frames.map((f) => f.timecodeSeconds)).toEqual([1]);
      expect(run.frames.map((f) => f.objectKey)).toEqual([thumbnailObjectKey(assetId, 1)]);
      for (const f of run.frames) {
        expect(f.putUrl).toContain('https://b.minio-minio.example/');
      }

      // ...and the recorded keys land on the named stack's asset document only.
      await waitFor(async () => {
        const a = await h.stacks['b']!.assets.get(assetId);
        return (a?.thumbnails?.length ?? 0) > 0;
      });
      expect((await h.stacks['b']!.assets.get(assetId))!.thumbnails).toEqual([
        thumbnailObjectKey(assetId, 1)
      ]);
      expect(await h.stacks['a']!.assets.get(assetId)).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('still extracts the poster frame on the NAMED stack when the resolver cache expires mid-pull', async () => {
    // The reason triggerThumbnail needed the `storage?` parameter at all: it used
    // to call `storageFor()` itself, from inside the detached continuation. That
    // factory is a cache read, so on a pull longer than the resolver TTL it
    // THROWS — silently losing the poster frame and raising an unhandled
    // rejection, the identical failure #1058 fixed for the extraction beside it.
    const payload = Buffer.from('hello-video-bytes');
    // Gated body: the pull is provably still open when the cache goes cold.
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

      h.expireResolverCache();
      body.push(payload);
      body.push(null);

      // Pre-fix this stayed empty: the `storageFor()` call inside the
      // continuation threw instead of returning stack b's handle.
      await waitFor(() => h.thumbnailedWith.length > 0);
      expect(h.thumbnailedWith[0]!.sourceUrl).toContain('https://b.minio-minio.example/');
      expect(h.thumbnailedWith[0]!.sourceUrl).toContain(`ingest/${assetId}`);

      // The orchestrator records confirmed keys asynchronously after dispatch
      // (statObject, then assets.update), so poll rather than assert straight off
      // the extractor call.
      await waitFor(async () => {
        const a = await h.stacks['b']!.assets.get(assetId);
        return (a?.thumbnails?.length ?? 0) > 0;
      });
      expect((await h.stacks['b']!.assets.get(assetId))!.thumbnails).toEqual([
        thumbnailObjectKey(assetId, 1)
      ]);

      // Give any stray rejection a turn of the loop before asserting.
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

  // The pre-dispatch source probe (issue #1059) must address the stack the
  // REQUEST names — the one the transcoder will read and the one the reported
  // bucket and endpoint are taken from — not whichever stack a second,
  // independent resolution happens to land on. Asserting the probe's endpoint
  // string equals the transcoder's would be wrong (the spawned transcoder is
  // handed an in-cluster alias of the same store, issue #991); the property that
  // matters is "same resolved stack", so this pins it by presence: the object
  // exists in the default stack 'a' and NOT in the named stack 'b'.
  it('probes the NAMED stack for the source object, not the first-listed one', async () => {
    const h = await buildApp(['a', 'b']);
    const id = await readyAsset(h);
    h.stacks['b']!.storage.absentKeys.add(`ingest/${id}`);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/execute`,
      headers: { ...AUTH, 'x-stack-name': 'b' },
      payload: { pipeline: 'abr-vod' }
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('source_unreadable');
    expect(body.message).toContain('does not exist');
    // The named stack's endpoint is the one reported, and it is the one probed.
    expect(body.message).toContain('b.minio-minio.example');
    expect(h.submitted).toHaveLength(0);
    expect(await h.stacks['b']!.pipelines.listByAsset(id)).toHaveLength(0);
  });

  it('a source present only in the NAMED stack still submits', async () => {
    // Mirror image of the above: the object is missing from the default stack
    // and present in the named one, so a probe that resolved the default stack
    // would refuse a perfectly good transcode.
    const h = await buildApp(['a', 'b']);
    const id = await readyAsset(h);
    h.stacks['a']!.storage.absentKeys.add(`ingest/${id}`);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/execute`,
      headers: { ...AUTH, 'x-stack-name': 'b' },
      payload: { pipeline: 'abr-vod' }
    });

    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
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
