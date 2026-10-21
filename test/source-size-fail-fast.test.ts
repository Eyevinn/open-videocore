// End-to-end: a source whose size no longer matches what ingest stored is
// refused at submit time (issue #1059, acceptance criterion 2).
//
// The other #1059 suite (src/routes/assets.execute-source-presence.test.ts)
// drives the readiness check with a hand-fed expected size. This suite closes
// the loop the reviewer asked for: the expected size is NOT supplied by the
// test. It is produced by a REAL URL-pull ingest run (the pull worker's
// `bytesTransferred`), persisted on the asset, and read back by the execute
// route — so the size-mismatch branch is exercised exactly as a deployment
// would reach it.
//
//   1. POST /assets/ingest-url pulls N bytes; the worker records N.
//   2. The stored object is then truncated behind the API's back (the #1057 /
//      #1058 failure mode: the bytes change after ingest reported success).
//   3. POST /assets/:id/execute { abr-vod } must 409 BEFORE anything is
//      submitted, naming both lengths.
//
// Contract sources (CLAUDE.md rule 7):
//   - `WorkspaceStorage.putStream(key, stream, opts): Promise<{ etag: string;
//     bytesTransferred: number }>` (src/data/storage.ts) — the transferred
//     length the worker records.
//   - `WorkspaceStorage.statObject(localKey): Promise<{ size: number; etag:
//     string } | undefined>` (src/data/storage.ts) — the HEAD equivalent the
//     readiness check uses; `undefined` is NotFound.
//   - `Asset.sourceSizeBytes` / `UpdateAssetInput.sourceSizeBytes`
//     (src/data/asset-repo.ts), persisted at
//     `AssetDocument.administrative.storage.sizeBytes`
//     (src/data/asset-document.ts).
//   - The verified location is the transcoder's only input,
//     `s3://${sourceBucket}/${sourceObjectKey}` (src/pipeline/transcode.ts)
//     -> `EncoreSubmitInput.inputUri` (src/pipeline/encore-client.ts).
//   - `BUILT_IN_PIPELINES['abr-vod'] = ['transcode', 'package']`
//     (src/pipeline/pipelines.ts).

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import type { EncoreClient, EncoreSubmitInput } from '../src/pipeline/encore-client.js';

const SOURCE_BUCKET = 'src-bucket';

// A fake object store that serves BOTH halves of the loop: the pull worker's
// putStream (which produces the recorded length) and the readiness check's
// statObject (which reports the length the transcoder would find). Mutating
// `objects` afterwards changes the stored object behind the API's back, which
// is the failure this issue is about.
class FakeStore {
  readonly objects = new Map<string, number>();
  async abortIncompleteMultipartUploads(): Promise<number> {
    return 0;
  }
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
    this.objects.set(key, transferred);
    return { etag: 'etag-1', bytesTransferred: transferred };
  }
  async statObject(key: string): Promise<{ size: number; etag: string } | undefined> {
    const size = this.objects.get(key);
    return size === undefined ? undefined : { size, etag: 'etag-1' };
  }
}

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  store: FakeStore;
  submitted: EncoreSubmitInput[];
};

async function buildApp(payload: Buffer): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const submitted: EncoreSubmitInput[] = [];
  const encore: EncoreClient = {
    async submit(input) {
      submitted.push(input);
      return { encoreInternalId: 'internal-1' };
    },
    async getJobStatus() {
      return undefined;
    },
    async cancel() {
      /* no-op */
    }
  };

  const assets = new InMemoryAssetRepository();
  const store = new FakeStore();
  const fetch = vi.fn(
    async () =>
      new Response(new Uint8Array(payload), {
        headers: { 'content-length': String(payload.length) }
      })
  ) as unknown as typeof globalThis.fetch;

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: new InMemoryJobRepository(),
    pipelineRepository: new InMemoryPipelineRepository(),
    encore,
    sourceBucket: SOURCE_BUCKET,
    outputBucket: 'out-bucket',
    storageFor: () => store as never,
    pullDeps: { sleep: async () => {}, baseBackoffMs: 0, fetch }
  });
  await app.ready();
  return { app, assets, store, submitted };
}

// The pull worker runs detached from the 202, so wait for the asset to carry
// the recorded length before driving execute.
async function waitForRecordedSize(h: Harness, assetId: string): Promise<number> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const asset = await h.assets.get(assetId);
    if (asset?.sourceSizeBytes !== undefined) return asset.sourceSizeBytes;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('ingest never recorded a source size on the asset');
}

async function ingest(h: Harness): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/assets/ingest-url',
    payload: { sourceUrl: 'https://example.com/clip.mp4', name: 'clip' }
  });
  expect(res.statusCode).toBe(202);
  return (res.json() as { assetId: string }).assetId;
}

describe('recorded ingest size gates the transcode submit (issue #1059)', () => {
  it('URL-pull ingest records the transferred length on the asset', async () => {
    const payload = Buffer.alloc(4096, 7);
    const h = await buildApp(payload);
    const assetId = await ingest(h);

    expect(await waitForRecordedSize(h, assetId)).toBe(payload.length);
  });

  it('source truncated after ingest => 409 naming both lengths, nothing submitted', async () => {
    const payload = Buffer.alloc(4096, 7);
    const h = await buildApp(payload);
    const assetId = await ingest(h);
    const recorded = await waitForRecordedSize(h, assetId);

    // The object is still THERE, under the right key — it is just not the
    // object we stored any more. Presence alone would happily submit this.
    h.store.objects.set(`ingest/${assetId}`, 1024);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/execute`,
      payload: { pipeline: 'abr-vod', profile: 'program' }
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('source_unreadable');
    // Actionable: both lengths and the exact location.
    expect(body.message).toContain('1024');
    expect(body.message).toContain(String(recorded));
    expect(body.message).toContain(`ingest/${assetId}`);
    expect(body.message).toContain(SOURCE_BUCKET);
    expect(h.submitted).toHaveLength(0);
  });

  it('source unchanged after ingest => 202 and the transcode is submitted', async () => {
    // Positive control: the recorded length must not make a healthy source fail.
    const payload = Buffer.alloc(4096, 7);
    const h = await buildApp(payload);
    const assetId = await ingest(h);
    await waitForRecordedSize(h, assetId);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/execute`,
      payload: { pipeline: 'abr-vod', profile: 'program' }
    });

    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.inputUri).toBe(`s3://${SOURCE_BUCKET}/ingest/${assetId}`);
  });

  it('source deleted after ingest => 409 absent (presence still wins over size)', async () => {
    const payload = Buffer.alloc(4096, 7);
    const h = await buildApp(payload);
    const assetId = await ingest(h);
    await waitForRecordedSize(h, assetId);

    h.store.objects.delete(`ingest/${assetId}`);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/execute`,
      payload: { pipeline: 'abr-vod', profile: 'program' }
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('source_unreadable');
    expect(body.message).toContain('does not exist');
    expect(h.submitted).toHaveLength(0);
  });
});
