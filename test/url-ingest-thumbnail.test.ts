// URL ingest -> poster-frame parity (issue #1050).
//
// POST /api/v1/assets/ingest-url completed without ever triggering thumbnail
// extraction: the HTTP/S pull branch fired technical metadata extraction only,
// so a URL-ingested asset never got `thumbnails` while an uploaded one did
// (src/main.ts:1976/:1981 onObjectStored runs BOTH). These tests lock the two
// paths together and, just as importantly, pin the deliberate asymmetry: the
// external-backend branch must still NOT attempt a thumbnail.
//
// Why the external branch is excluded (and must stay excluded): there the
// recorded objectKey is `s3://<foreign-bucket>/<key>`, and the thumbnail
// orchestrator resolves its source with `deps.storage.presignedGet(objectKey,
// ttl)` (src/pipeline/thumbnail.ts:119) against this deployment's own storage,
// which cannot address a bucket it does not own. triggerExtraction takes an
// `externalSource` parameter for exactly that case; triggerThumbnail has no
// equivalent, so a call there would fail silently rather than loudly.
//
// Contract sources verified against the tree under test (no guessing):
//   - POST /ingest-url handler, HTTP/S branch: src/routes/assets.ts:2899-2923
//     (`void runner(...).then(...)`, guarded on `settled?.status === 'processing'`).
//   - POST /ingest-url handler, external-backend branch: src/routes/assets.ts:2809
//     -> :2860 `triggerExtraction(extAsset.id, extObjectKey, source)`.
//   - triggerThumbnail(assetId, objectKey, request): src/routes/assets.ts:2009;
//     dispatches timecodes `[1]` (:2028) through `thumbnailRunner`.
//   - triggerExtraction(assetId, objectKey, externalSource?): src/routes/assets.ts:1822.
//   - extractThumbnails + thumbnailObjectKey + FrameExtractor/FrameTarget:
//     src/pipeline/thumbnail.ts:102, :72, :64, :49. Source URL comes from
//     `storage.presignedGet` (:119); recorded keys are only those confirmed by
//     `storage.statObject` (:153) and are written as `thumbnails: string[]` via
//     `assets.update` (:165).
//   - assetsRouter options `thumbnailExtractor` / `extractThumbnails` /
//     `probe` / `extract` / `storageBackendRegistry` / `storageFor` / `pullDeps`:
//     src/routes/assets.ts:1002, :1005, :951, :954, :963.
//   - StorageBackendRegistry.resolveSourceCredentials(workspaceId, ref) ->
//     SourceBackendJobCredentials { bucket, awsAccessKeyId, awsSecretAccessKey,
//     ... }: src/services/storage-backend-registry.ts:901.
//   - Asset document field `thumbnails?: string[]`: src/data/asset-repo.ts:552.
//   - ingest-url request body (`sourceUrl`, `name`, `sourceBackend`):
//     ingestUrlSchema, src/routes/assets.ts (POST /ingest-url schema.body).

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = { 'token-a': 'workspace-a' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { jobsRouter } from '../src/routes/jobs.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { thumbnailObjectKey, type FrameExtractor, type FrameTarget } from '../src/pipeline/thumbnail.js';
import type { WorkspaceStorage } from '../src/data/storage.js';
import type { StorageBackendRegistry } from '../src/services/storage-backend-registry.js';
import type {
  ProbeRunner,
  extractTechnicalMetadata
} from '../src/pipeline/metadata-extractor.js';

const A = { authorization: 'Bearer token-a' } as const;

// Storage double covering BOTH surfaces this flow touches: `putStream` for the
// URL-pull worker, and presign/stat for the thumbnail orchestrator.
//
// `presignedGet` doubles as the observable for "a thumbnail run was ATTEMPTED":
// it is the orchestrator's first act (thumbnail.ts:119) and it models real
// storage by REFUSING an `s3://<foreign-bucket>/<key>` locator, since the
// deployment's own storage cannot presign a bucket it does not own. That is
// precisely how a thumbnail call on the external branch would fail silently —
// so asserting on the extractor alone would pass vacuously. The external-branch
// test asserts `presignedGet` is never called, which no silent failure can
// satisfy.
function fakeStorage(): {
  storage: WorkspaceStorage;
  written: Set<string>;
  presignedGet: ReturnType<typeof vi.fn>;
} {
  const written = new Set<string>();
  const ownKey = (key: string) => {
    if (/^s3:\/\//i.test(key)) {
      throw new Error(`cannot presign a foreign bucket locator: ${key}`);
    }
    return key;
  };
  const presignedGet = vi.fn(async (key: string) => `https://storage.example/${ownKey(key)}?sig=get`);
  const storage = {
    async putStream(key: string, source: Readable) {
      let transferred = 0;
      for await (const chunk of source) transferred += (chunk as Buffer).length;
      written.add(key);
      return { etag: 'etag-1', bytesTransferred: transferred };
    },
    presignedGet,
    presignedPut: vi.fn(async (key: string) => `https://storage.example/${ownKey(key)}?sig=put`),
    statObject: vi.fn(async (key: string) =>
      written.has(key) ? { size: 1024, etag: 'etag' } : undefined
    )
  } as unknown as WorkspaceStorage;
  return { storage, written, presignedGet };
}

// A FrameExtractor that "writes" each frame to its own key, so the orchestrator's
// statObject verification confirms them and records them on the asset.
function writingExtractor(written: Set<string>): FrameExtractor {
  return vi.fn(async (_sourceUrl: string, frames: FrameTarget[]) => {
    for (const f of frames) written.add(f.objectKey);
  });
}

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  thumbnailExtractor: ReturnType<typeof vi.fn> & FrameExtractor;
  extract: ReturnType<typeof vi.fn>;
  presignedGet: ReturnType<typeof vi.fn>;
};

async function buildApp(opts: { registry?: StorageBackendRegistry } = {}): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const { storage, written, presignedGet } = fakeStorage();

  const thumbnailExtractor = writingExtractor(written) as ReturnType<typeof vi.fn> & FrameExtractor;
  // Stub the metadata extractor so the parity assertion ("metadata AND poster
  // frame") can observe the extraction call without an ffprobe runner.
  const extract = vi.fn(async () => {});

  const payload = Buffer.from('hello-video-bytes');
  const fetch = vi.fn(async () =>
    new Response(payload, { headers: { 'content-length': String(payload.length) } })
  ) as unknown as typeof globalThis.fetch;

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: jobs,
    storageFor: () => storage,
    pullDeps: { fetch, sleep: async () => {}, baseBackoffMs: 0 },
    probe: (async () => ({})) as unknown as ProbeRunner,
    extract: extract as unknown as typeof extractTechnicalMetadata,
    thumbnailExtractor,
    ...(opts.registry ? { storageBackendRegistry: opts.registry } : {})
  });
  await app.register(jobsRouter, { prefix: '/api/v1/jobs', repository: jobs });
  await app.ready();
  return { app, assets, thumbnailExtractor, extract, presignedGet };
}

async function ingestUrl(
  app: FastifyInstance,
  body: Record<string, unknown>
): Promise<{ assetId: string; jobId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets/ingest-url',
    headers: A,
    payload: body
  });
  expect(res.statusCode).toBe(202);
  return res.json() as { assetId: string; jobId: string };
}

// The pull + both extractions are detached, so poll until the predicate holds.
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

describe('URL ingest poster-frame parity (issue #1050)', () => {
  describe('HTTP/S pull branch', () => {
    it('populates thumbnails[] on the asset once the pull settles to processing', async () => {
      const { app, assets, thumbnailExtractor } = await buildApp();
      const { assetId } = await ingestUrl(app, {
        sourceUrl: 'https://example.com/clip.mp4',
        name: 'clip'
      });

      const got = await waitFor(async () => {
        const a = await assets.get(assetId);
        return (a?.thumbnails?.length ?? 0) > 0;
      });
      expect(got).toBe(true);

      const asset = await assets.get(assetId);
      // Pre-condition for the guard: the pull really did advance the asset.
      expect(asset?.status).toBe('processing');
      // The acceptance criterion: a poster frame, same as an uploaded video.
      expect(asset?.thumbnails).toEqual([thumbnailObjectKey(assetId, 1)]);
      expect(thumbnailExtractor).toHaveBeenCalledTimes(1);
    });

    it('extracts the poster frame from the pulled OSC-managed object key', async () => {
      const { app, assets, thumbnailExtractor } = await buildApp();
      const { assetId } = await ingestUrl(app, {
        sourceUrl: 'https://example.com/clip.mp4',
        name: 'clip'
      });
      expect(await waitFor(() => thumbnailExtractor.mock.calls.length > 0)).toBe(true);

      const asset = await assets.get(assetId);
      expect(asset?.objectKey).toBe(`ingest/${assetId}`);
      // Source handed to the runner is a presigned GET of the key the pull wrote,
      // which is exactly why this branch can presign at all.
      const [sourceUrl, frames] = thumbnailExtractor.mock.calls[0] as [string, FrameTarget[]];
      expect(sourceUrl).toContain(`ingest/${assetId}`);
      expect(frames.map((f) => f.timecodeSeconds)).toEqual([1]);
    });

    it('runs metadata extraction AND thumbnail extraction, like the upload path', async () => {
      const { app, thumbnailExtractor, extract } = await buildApp();
      await ingestUrl(app, { sourceUrl: 'https://example.com/clip.mp4', name: 'clip' });

      expect(
        await waitFor(() => extract.mock.calls.length > 0 && thumbnailExtractor.mock.calls.length > 0)
      ).toBe(true);
    });

    it('does not extract a poster frame when the pull fails (asset never reaches processing)', async () => {
      // Negative control for the `settled?.status === 'processing'` guard: with a
      // rejecting source the asset ends `failed`, so neither extraction runs.
      const app = Fastify();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      registerAuth(app);
      const assets = new InMemoryAssetRepository();
      const jobs = new InMemoryJobRepository();
      const { storage, written } = fakeStorage();
      const thumbnailExtractor = writingExtractor(written);
      await app.register(assetsRouter, {
        prefix: '/api/v1/assets',
        repository: assets,
        jobRepository: jobs,
        storageFor: () => storage,
        pullDeps: {
          fetch: (async () => new Response('nope', { status: 404 })) as unknown as typeof globalThis.fetch,
          sleep: async () => {},
          baseBackoffMs: 0
        },
        probe: (async () => ({})) as unknown as ProbeRunner,
        thumbnailExtractor
      });
      await app.ready();

      const { assetId } = await ingestUrl(app, {
        sourceUrl: 'https://example.com/missing.mp4',
        name: 'clip'
      });
      expect(await waitFor(async () => (await assets.get(assetId))?.status === 'failed')).toBe(true);
      await new Promise((r) => setTimeout(r, 25));
      expect(thumbnailExtractor).not.toHaveBeenCalled();
      expect((await assets.get(assetId))?.thumbnails).toBeUndefined();
    });
  });

  describe('external-backend branch (must NOT attempt a thumbnail)', () => {
    const registry = {
      resolveSourceCredentials: vi.fn(async () => ({
        bucket: 'foreign-bucket',
        awsAccessKeyId: 'AKIAEXAMPLE',
        awsSecretAccessKey: '{{secrets.backend-secret}}',
        s3EndpointUrl: 'https://s3.example.invalid',
        awsRegion: 'eu-north-1'
      }))
    } as unknown as StorageBackendRegistry;

    it('triggers metadata extraction in place but generates no thumbnail', async () => {
      const { app, assets, thumbnailExtractor, extract, presignedGet } = await buildApp({
        registry
      });
      const { assetId } = await ingestUrl(app, {
        sourceUrl: 's3://foreign-bucket/incoming/clip.mp4',
        name: 'clip',
        sourceBackend: 'partner-bucket'
      });

      // This branch settles synchronously; give the detached probe a tick.
      expect(await waitFor(() => extract.mock.calls.length > 0)).toBe(true);
      await new Promise((r) => setTimeout(r, 25));

      const asset = await assets.get(assetId);
      expect(asset?.status).toBe('processing');
      expect(asset?.objectKey).toBe('s3://foreign-bucket/incoming/clip.mp4');
      // Extraction reads the foreign bucket in place via its externalSource.
      const extractParams = extract.mock.calls[0]?.[0] as { externalSource?: { bucket: string } };
      expect(extractParams.externalSource?.bucket).toBe('foreign-bucket');
      // No thumbnail run was even ATTEMPTED. `presignedGet` is the orchestrator's
      // first act, so it catches the attempt whether or not it then fails: adding
      // triggerThumbnail to this branch records a presign of the foreign
      // `s3://` locator and fails here. The extractor/thumbnails assertions below
      // alone would NOT catch it — the presign throws first, which is exactly the
      // silent failure this guard exists to prevent.
      expect(presignedGet).not.toHaveBeenCalled();
      expect(thumbnailExtractor).not.toHaveBeenCalled();
      expect(asset?.thumbnails).toBeUndefined();
    });
  });
});
