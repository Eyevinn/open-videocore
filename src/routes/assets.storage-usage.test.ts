// Per-asset storage usage of the current output set (issue #1242).
//
// Pins `GET /api/v1/assets/:id/storage-usage` against the real route plus fake
// object-store surfaces, so the contract an operator reads before deciding to
// re-encode cannot drift:
//
//   - renditions are measured with statObject per objectKey, including the
//     `s3://bucket/key` form Encore writes, and are reported per rendition
//   - packaged output is measured as a recursive sum over the SAME prefix the
//     stream proxy serves from, and reports the bucket/prefix/objectCount
//   - totalBytes = counted rendition bytes + packaged bytes
//   - an object inside the measured packaged prefix is NOT counted twice
//   - two renditions pointing at one object contribute its bytes once
//   - a missing/unreadable object reports sizeBytes null, counted false and
//     flips `complete` to false (the total is then a lower bound)
//   - an asset with no outputs is 200 with zero bytes and packagedOutput null,
//     and never touches the object store
//   - unknown asset is 404; outputs with no storage configured at all is 501

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { Readable } from 'node:stream';

import { assetsRouter } from './assets.js';
import { WorkspaceStorage } from '../data/storage.js';
import { InMemoryAssetRepository, type Rendition } from '../data/asset-repo.js';

type StorageUsageRead = {
  assetId: string;
  totalBytes: number;
  complete: boolean;
  renditions: {
    count: number;
    countedCount: number;
    bytes: number;
    items: Array<{
      id: string;
      label?: string;
      objectKey: string;
      bucket?: string;
      sizeBytes: number | null;
      counted: boolean;
    }>;
  };
  packagedOutput: { bucket: string; prefix: string; objectCount: number; bytes: number } | null;
};

// One object in a fake store, keyed `<bucket>/<key>`.
type ObjectMap = Record<string, number>;

// A minio-shaped client covering exactly the two primitives the endpoint uses:
//   - statObject(bucket, key) -> { size, etag }, throwing { code: 'NotFound' }
//     for a missing key (WorkspaceStorage.statObject maps that to undefined,
//     src/data/storage.ts:146-156)
//   - listObjectsV2(bucket, prefix, recursive) -> stream of { name, size }
//     (the BucketItem object arm, used by sumObjectSizesUnderPrefix)
function fakeStoreClient(objects: ObjectMap, opts: { listThrows?: boolean } = {}) {
  const statObject = vi.fn(async (bucket: string, key: string) => {
    const size = objects[`${bucket}/${key}`];
    if (size === undefined) {
      throw Object.assign(new Error('not found'), { code: 'NotFound' });
    }
    return { size, etag: 'etag' };
  });
  const listObjectsV2 = vi.fn((bucket: string, prefix: string, _recursive: boolean) => {
    if (opts.listThrows) {
      const stream = new Readable({ objectMode: true, read() {} });
      // Emit asynchronously so the consumer has its error listener attached.
      setImmediate(() => stream.destroy(new Error('object store unreachable')));
      return stream;
    }
    const matched = Object.entries(objects)
      .filter(([k]) => k.startsWith(`${bucket}/${prefix}`))
      .map(([k, size]) => ({ name: k.slice(bucket.length + 1), size }));
    return Readable.from(matched, { objectMode: true });
  });
  return { statObject, listObjectsV2 };
}

// The source-bucket storage factory, i.e. what /:id/files presigns plain object
// keys through. Backed by the same object map as the client.
function sourceStorage(client: ReturnType<typeof fakeStoreClient>, bucket: string) {
  return new WorkspaceStorage(client as unknown as never, bucket);
}

const SOURCE_BUCKET = 'openvideocore-source';
const PACKAGED_BUCKET = 'openvideocore-packaged';

async function buildApp(
  opts: {
    objects?: ObjectMap;
    withStorage?: boolean;
    withClient?: boolean;
    listThrows?: boolean;
  } = {}
): Promise<{
  app: FastifyInstance;
  repo: InMemoryAssetRepository;
  client: ReturnType<typeof fakeStoreClient>;
}> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const client = fakeStoreClient(opts.objects ?? {}, { listThrows: opts.listThrows });
  const repo = new InMemoryAssetRepository();

  // Populate request.connections exactly as src/main.ts's preHandler does
  // (buildConnectionsFromStack: the stack's minio client + packaged bucket).
  app.decorateRequest('connections', null);
  app.addHook('preHandler', async (request) => {
    request.connections = (
      opts.withClient === false
        ? {}
        : { storageClient: client, packagedBucket: PACKAGED_BUCKET }
    ) as unknown as NonNullable<typeof request.connections>;
  });

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor:
      opts.withStorage === false ? undefined : () => sourceStorage(client, SOURCE_BUCKET),
    outputBucket: PACKAGED_BUCKET
  });
  await app.ready();
  return { app, repo, client };
}

async function createAsset(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/assets', payload: { name: 'clip' } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function readUsage(app: FastifyInstance, id: string): Promise<StorageUsageRead> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/storage-usage` });
  expect(res.statusCode).toBe(200);
  return res.json() as StorageUsageRead;
}

function rendition(over: Partial<Rendition> & { id: string; objectKey: string }): Rendition {
  return { label: '1080p', width: 1920, height: 1080, ...over };
}

describe('GET /:id/storage-usage', () => {
  it('sums rendition objects and the packaged prefix into totalBytes', async () => {
    const prefix = 'asset-x/job-1/';
    const { app, repo } = await buildApp({
      objects: {
        [`${PACKAGED_BUCKET}/transcode/a/1080p.mp4`]: 1000,
        [`${PACKAGED_BUCKET}/transcode/a/720p.mp4`]: 400,
        [`${PACKAGED_BUCKET}/${prefix}index.m3u8`]: 10,
        [`${PACKAGED_BUCKET}/${prefix}manifest.mpd`]: 20,
        [`${PACKAGED_BUCKET}/${prefix}seg-00001.m4s`]: 70
      }
    });
    const id = await createAsset(app);
    await repo.update(id, {
      renditions: [
        rendition({
          id: 'r1',
          label: '1080p',
          objectKey: `s3://${PACKAGED_BUCKET}/transcode/a/1080p.mp4`
        }),
        rendition({
          id: 'r2',
          label: '720p',
          width: 1280,
          height: 720,
          objectKey: `s3://${PACKAGED_BUCKET}/transcode/a/720p.mp4`
        })
      ],
      packagedOutput: { bucket: PACKAGED_BUCKET, prefix, masterHlsKey: `${prefix}index.m3u8` }
    });

    const usage = await readUsage(app, id);
    expect(usage.assetId).toBe(id);
    expect(usage.complete).toBe(true);
    expect(usage.renditions.count).toBe(2);
    expect(usage.renditions.countedCount).toBe(2);
    expect(usage.renditions.bytes).toBe(1400);
    // Rendition keys are reported bucket-excluded, with the bucket alongside.
    expect(usage.renditions.items.map((i) => i.objectKey)).toEqual([
      'transcode/a/1080p.mp4',
      'transcode/a/720p.mp4'
    ]);
    expect(usage.renditions.items[0].bucket).toBe(PACKAGED_BUCKET);
    expect(usage.renditions.items[0].sizeBytes).toBe(1000);
    expect(usage.packagedOutput).toEqual({
      bucket: PACKAGED_BUCKET,
      prefix,
      objectCount: 3,
      bytes: 100
    });
    expect(usage.totalBytes).toBe(1500);
  });

  it('measures a plain rendition object key through the source-bucket storage', async () => {
    const { app, repo } = await buildApp({
      objects: { [`${SOURCE_BUCKET}/renditions/r1.mp4`]: 512 }
    });
    const id = await createAsset(app);
    await repo.update(id, {
      renditions: [rendition({ id: 'r1', objectKey: 'renditions/r1.mp4' })]
    });

    const usage = await readUsage(app, id);
    expect(usage.renditions.items[0].sizeBytes).toBe(512);
    expect(usage.renditions.items[0].counted).toBe(true);
    expect(usage.totalBytes).toBe(512);
    expect(usage.packagedOutput).toBeNull();
    expect(usage.complete).toBe(true);
  });

  it('does not count a rendition that lives inside the packaged prefix twice', async () => {
    const prefix = 'asset-y/job-2/';
    const { app, repo } = await buildApp({
      objects: {
        [`${PACKAGED_BUCKET}/${prefix}index.m3u8`]: 10,
        [`${PACKAGED_BUCKET}/${prefix}1080p.mp4`]: 990
      }
    });
    const id = await createAsset(app);
    await repo.update(id, {
      renditions: [
        rendition({ id: 'r1', objectKey: `s3://${PACKAGED_BUCKET}/${prefix}1080p.mp4` })
      ],
      packagedOutput: { bucket: PACKAGED_BUCKET, prefix }
    });

    const usage = await readUsage(app, id);
    expect(usage.renditions.items[0].sizeBytes).toBe(990);
    expect(usage.renditions.items[0].counted).toBe(false);
    expect(usage.renditions.bytes).toBe(0);
    expect(usage.packagedOutput?.bytes).toBe(1000);
    expect(usage.totalBytes).toBe(1000);
    expect(usage.complete).toBe(true);
  });

  it('counts one object once when two renditions point at it', async () => {
    const { app, repo } = await buildApp({
      objects: { [`${PACKAGED_BUCKET}/transcode/a/1080p.mp4`]: 800 }
    });
    const id = await createAsset(app);
    await repo.update(id, {
      renditions: [
        rendition({ id: 'r1', objectKey: `s3://${PACKAGED_BUCKET}/transcode/a/1080p.mp4` }),
        rendition({ id: 'r2', objectKey: `s3://${PACKAGED_BUCKET}/transcode/a/1080p.mp4` })
      ]
    });

    const usage = await readUsage(app, id);
    expect(usage.renditions.count).toBe(2);
    expect(usage.renditions.countedCount).toBe(1);
    expect(usage.totalBytes).toBe(800);
  });

  it('reports a missing rendition object as unmeasured and marks the read incomplete', async () => {
    const { app, repo } = await buildApp({
      objects: { [`${PACKAGED_BUCKET}/transcode/a/1080p.mp4`]: 600 }
    });
    const id = await createAsset(app);
    await repo.update(id, {
      renditions: [
        rendition({ id: 'r1', objectKey: `s3://${PACKAGED_BUCKET}/transcode/a/1080p.mp4` }),
        rendition({ id: 'r2', objectKey: `s3://${PACKAGED_BUCKET}/transcode/a/gone.mp4` })
      ]
    });

    const usage = await readUsage(app, id);
    const missing = usage.renditions.items.find((i) => i.id === 'r2');
    expect(missing?.sizeBytes).toBeNull();
    expect(missing?.counted).toBe(false);
    expect(usage.renditions.bytes).toBe(600);
    expect(usage.totalBytes).toBe(600);
    expect(usage.complete).toBe(false);
  });

  it('reports packaged output as unmeasured (not a 500) when the prefix listing fails', async () => {
    const { app, repo } = await buildApp({ listThrows: true });
    const id = await createAsset(app);
    await repo.update(id, {
      packagedOutput: { bucket: PACKAGED_BUCKET, prefix: 'asset-z/job-3/' }
    });

    const usage = await readUsage(app, id);
    expect(usage.packagedOutput).toBeNull();
    expect(usage.complete).toBe(false);
    expect(usage.totalBytes).toBe(0);
  });

  it('returns zero usage without touching storage when the asset has no outputs', async () => {
    const { app, client } = await buildApp();
    const id = await createAsset(app);

    const usage = await readUsage(app, id);
    expect(usage).toEqual({
      assetId: id,
      totalBytes: 0,
      complete: true,
      renditions: { count: 0, countedCount: 0, bytes: 0, items: [] },
      packagedOutput: null
    });
    expect(client.statObject).not.toHaveBeenCalled();
    expect(client.listObjectsV2).not.toHaveBeenCalled();
  });

  it('404s an unknown asset', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/01JUNKJUNKJUNKJUNKJUNKJUNK/storage-usage'
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('501s when there is an output set to measure but no object storage is configured', async () => {
    const { app, repo } = await buildApp({ withStorage: false, withClient: false });
    const id = await createAsset(app);
    await repo.update(id, {
      renditions: [rendition({ id: 'r1', objectKey: 'renditions/r1.mp4' })]
    });

    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/storage-usage` });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_configured');
  });
});
