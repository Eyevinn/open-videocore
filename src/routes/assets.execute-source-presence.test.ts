// Fail-fast source verification on the abr-vod pipeline (issue #1059).
//
// Reported failure: the asset reaches `ready`, POST /:id/execute is accepted
// with a 202, and ~2 minutes later the transcode fails with an opaque probe 404
// because the source object is no longer in the bucket named in the job's
// `s3://<bucket>/<key>` input (root cause context: #1057 / #1058). Nothing on
// the submit path ever asked the object store whether the bytes were still
// there.
//
// This suite drives real HTTP requests through the assets router with a FAKE
// object store (statObject) and a FAKE transcode client, asserting the
// observable guarantee:
//   - source present      => 202, exactly one job submitted (unchanged)
//   - source deleted       => 409 `source_unreadable`, message names bucket +
//                             key, NOTHING submitted, NO pipeline execution left
//                             behind
//   - source zero-length   => 409, nothing submitted
//   - stat throws          => 502 `source_verification_failed`, nothing submitted
//   - no object store wired => 202 (opt-in guard, behaviour unchanged)
//
// Contract sources (CLAUDE.md rule 7):
//   - `WorkspaceStorage.statObject(localKey): Promise<{ size, etag } |
//     undefined>` (src/data/storage.ts:136-146) — the HEAD equivalent, faked
//     here; `StorageFactory = () => WorkspaceStorage` (src/routes/assets.ts:928).
//   - The verified location is the transcoder's only input,
//     `s3://${sourceBucket}/${sourceObjectKey}` (src/pipeline/transcode.ts:120)
//     -> `EncoreSubmitInput.inputUri` (src/pipeline/encore-client.ts:25).
//   - `BUILT_IN_PIPELINES['abr-vod'] = ['transcode', 'package']`
//     (src/pipeline/pipelines.ts:51) — so `transcode` is the first step the
//     guard gates.
//   - 409 and 502 are already declared response codes for POST /:id/execute
//     (the `response` map on the route in src/routes/assets.ts).

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter, type StorageFactory } from './assets.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryJobRepository } from '../data/job-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import type { EncoreClient, EncoreSubmitInput } from '../pipeline/encore-client.js';

const SOURCE_BUCKET = 'src-bucket';
const SOURCE_KEY = 'sources/clip.mxf';

// Fake object store exposing only the narrow statObject surface the check uses.
// A key absent from `objects` stats as undefined (NotFound), exactly as the real
// WorkspaceStorage.statObject does for a deleted object.
function fakeStorage(objects: Record<string, number>): StorageFactory {
  const store = {
    async statObject(objectKey: string): Promise<{ size: number; etag: string } | undefined> {
      if (Object.prototype.hasOwnProperty.call(objects, objectKey)) {
        return { size: objects[objectKey]!, etag: 'etag-' + objectKey };
      }
      return undefined;
    }
  };
  return () => store as never;
}

// Fake object store whose stat fails outright (object store unreachable).
function throwingStorage(): StorageFactory {
  const store = {
    async statObject(): Promise<never> {
      throw new Error('connection refused');
    }
  };
  return () => store as never;
}

function fakeTranscoder(): { client: EncoreClient; submitted: EncoreSubmitInput[] } {
  const submitted: EncoreSubmitInput[] = [];
  const client: EncoreClient = {
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
  return { client, submitted };
}

type Harness = {
  app: FastifyInstance;
  repo: InMemoryAssetRepository;
  pipelines: InMemoryPipelineRepository;
  submitted: EncoreSubmitInput[];
};

async function buildApp(
  storageFor: StorageFactory | undefined,
  // `withSourceBucket: false` leaves the deployment with NO source bucket at all
  // (neither stack connections nor the boot default) — the check has nothing to
  // stat against and nothing to name, so it must step aside rather than produce
  // a diagnostic about a bucket called "undefined".
  opts: { withSourceBucket?: boolean } = {}
): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const { client, submitted } = fakeTranscoder();
  const repo = new InMemoryAssetRepository();
  const pipelines = new InMemoryPipelineRepository();

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    jobRepository: new InMemoryJobRepository(),
    pipelineRepository: pipelines,
    encore: client,
    ...(opts.withSourceBucket === false ? {} : { sourceBucket: SOURCE_BUCKET }),
    outputBucket: 'out-bucket',
    ...(storageFor ? { storageFor } : {})
  });
  await app.ready();
  return { app, repo, pipelines, submitted };
}

// An asset that LOOKS runnable: it records the authoritative source key, so the
// unified resolver (source-object.ts) is satisfied. Whether the bytes exist is
// the object store's business — which is the whole point of this issue.
async function seedAsset(repo: InMemoryAssetRepository): Promise<string> {
  const asset = await repo.create({ name: 'clip', objectKey: SOURCE_KEY });
  return asset.id;
}

async function execute(h: Harness, id: string, pipeline = 'abr-vod') {
  return h.app.inject({
    method: 'POST',
    url: `/api/v1/assets/${id}/execute`,
    payload: { pipeline, profile: 'program' }
  });
}

describe('POST /:id/execute abr-vod source verification (issue #1059)', () => {
  it('source object present => 202 and the transcode is submitted (unchanged)', async () => {
    const h = await buildApp(fakeStorage({ [SOURCE_KEY]: 251_658_240 }));
    const id = await seedAsset(h.repo);

    const res = await execute(h, id);

    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.inputUri).toBe(`s3://${SOURCE_BUCKET}/${SOURCE_KEY}`);
  });

  it('source object DELETED => 409 source_unreadable naming bucket + key, nothing submitted', async () => {
    // The bucket is empty: the asset records the key, the bytes are gone.
    const h = await buildApp(fakeStorage({}));
    const id = await seedAsset(h.repo);

    const res = await execute(h, id);

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('source_unreadable');
    expect(body.message).toContain(SOURCE_KEY);
    expect(body.message).toContain(SOURCE_BUCKET);
    // The job never reached the transcoder, so there is no late opaque 404...
    expect(h.submitted).toHaveLength(0);
    // ...and no dangling `running` execution was created for it.
    expect(await h.pipelines.listByAsset(id)).toHaveLength(0);
  });

  it('source object present but zero-length => 409, nothing submitted', async () => {
    const h = await buildApp(fakeStorage({ [SOURCE_KEY]: 0 }));
    const id = await seedAsset(h.repo);

    const res = await execute(h, id);

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('source_unreadable');
    expect(body.message).toContain('zero-length');
    expect(h.submitted).toHaveLength(0);
  });

  it('object store unreachable => 502 source_verification_failed, nothing submitted', async () => {
    const h = await buildApp(throwingStorage());
    const id = await seedAsset(h.repo);

    const res = await execute(h, id);

    expect(res.statusCode).toBe(502);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('source_verification_failed');
    expect(body.message).toContain(SOURCE_KEY);
    expect(h.submitted).toHaveLength(0);
  });

  it('no object store wired => 202 (the guard is opt-in and cannot block a pipeline it cannot verify)', async () => {
    const h = await buildApp(undefined);
    const id = await seedAsset(h.repo);

    const res = await execute(h, id);

    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
  });

  it('`full` (transcode is not the first step) is gated too: deleted source => 409, nothing submitted', async () => {
    // BUILT_IN_PIPELINES['full'] runs the fire-and-forget steps first and then
    // transcode (src/pipeline/pipelines.ts:56), so the guard is keyed on the
    // pipeline CONTAINING a transcode step, not on it being first.
    const h = await buildApp(fakeStorage({}));
    const id = await seedAsset(h.repo);

    const res = await execute(h, id, 'full');

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('source_unreadable');
    expect(h.submitted).toHaveLength(0);
    expect(await h.pipelines.listByAsset(id)).toHaveLength(0);
  });

  it('a pipeline with no transcode step is unaffected (`ingest` still starts with a missing source object)', async () => {
    // `ingest` = [extract-metadata, thumbnail] (pipelines.ts:53): fire-and-forget
    // steps that record their own outcome, and no transcode input to verify.
    const h = await buildApp(fakeStorage({}));
    const id = await seedAsset(h.repo);

    const res = await execute(h, id, 'ingest');

    expect(res.statusCode).toBe(202);
  });

  it('an external-bucket `s3://` source locator is left alone => 202, nothing refused', async () => {
    // External-bucket registration stores the FULL locator as `objectKey`
    // (POST /assets/external, assets.ts), not a workspace-local key. Stat'ing it
    // against the stack source bucket would 409 while naming the wrong bucket,
    // so those sources are skipped: the transcode step composes its own URI for
    // them (src/pipeline/transcode.ts).
    const h = await buildApp(fakeStorage({}));
    const asset = await h.repo.create({
      name: 'external',
      objectKey: 's3://partner-bucket/incoming/clip.mp4'
    });

    const res = await execute(h, asset.id);

    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
  });

  it('no source bucket resolved at all => 202 (nothing to stat, nothing to name)', async () => {
    // `full` reaches the check without tripping the transcode-first 501 guard,
    // so this is the one shape that can arrive with no bucket from either
    // source. It must not produce a diagnostic about bucket "undefined".
    const h = await buildApp(fakeStorage({}), { withSourceBucket: false });
    const id = await seedAsset(h.repo);

    const res = await execute(h, id, 'full');

    expect(res.statusCode).toBe(202);
  });

  it('asset with no recorded source key still fails with the pre-existing 409 no_object', async () => {
    // The unified resolver still owns the "no key at all" case; this guard only
    // adds the "key is there, bytes are not" case.
    const h = await buildApp(fakeStorage({}));
    const asset = await h.repo.create({ name: 'keyless' });

    const res = await execute(h, asset.id);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('no_object');
    expect(h.submitted).toHaveLength(0);
  });
});
