// Clip / trim tests (issue #17).
//
// Covers:
//   - the orchestration in clip() (child asset creation, key naming, status
//     transitions, failure handling)
//   - the OSC ffmpeg cmdline builder + ephemeral-job runner lifecycle
//   - the assets router endpoint (POST /:id/clip) with statuses 201, 400, 404,
//     409, 501, 502
//
// The runner is AWAITED by the route, so tests assert on the synchronous
// response and the resulting child asset document directly.

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = { 'token-a': 'workspace-a', 'token-b': 'workspace-b' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import {
  clip,
  clipObjectKey,
  clipTechnicalMetadata,
  type ClipRunner
} from '../src/pipeline/clip.js';
import {
  makeOscClipRunner,
  clipCmdLine,
  clipDestinationUri,
  redactLogQueryStrings,
  oscClipJobLog,
  type OscJobApi
} from '../src/pipeline/osc-clip.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

// `statObject` is part of the storage contract clip() now depends on: it is what
// proves the ffmpeg job actually wrote an object before the child asset is
// flipped to `ready` (issue #786). Shape verified against
// src/data/storage.ts:114 `statObject(localKey): Promise<{size, etag}|undefined>`.
// `null` models "the object is not there" (statObject resolves undefined for a
// NotFound — src/data/storage.ts:117); a stat object models a written object.
function fakeStorage(
  stat: { size: number; etag: string } | null = { size: 1024, etag: 'etag-clip' }
): WorkspaceStorage {
  return {
    presignedGet: vi.fn(async (key: string) => `https://minio.example/${key}?sig=get`),
    presignedPut: vi.fn(async (key: string) => `https://minio.example/${key}?sig=put`),
    statObject: vi.fn(async () => stat ?? undefined)
  } as unknown as WorkspaceStorage;
}

async function buildApp(
  opts: { clipRunner?: ClipRunner; withStorage?: boolean } = {}
): Promise<{ app: FastifyInstance; repo: InMemoryAssetRepository }> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor: opts.withStorage === false ? undefined : () => fakeStorage(),
    clipRunner: opts.clipRunner
  });
  await app.ready();
  return { app, repo };
}

async function createAssetWithObject(app: FastifyInstance, repo: InMemoryAssetRepository) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'source' }
  });
  const id = res.json().id as string;
  await repo.update(id, { objectKey: `ingest/${id}` });
  return id;
}

describe('clip object key naming', () => {
  it('builds the documented key shape', () => {
    expect(clipObjectKey('asset-7')).toBe('clips/asset-7.mp4');
  });
});

describe('clip orchestration', () => {
  it('creates a ready child asset pointing at the source', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create({ name: 'src', objectKey: 'ingest/src' });
    const runner: ClipRunner = vi.fn(async () => undefined);

    const child = await clip(
      {
        sourceAssetId: source.id,
        objectKey: 'ingest/src',
        startSeconds: 5,
        endSeconds: 12
      },
      { assets: repo, storage: fakeStorage(), runner }
    );

    expect(child.parentId).toBe(source.id);
    expect(child.status).toBe('ready');
    expect(child.objectKey).toBe(clipObjectKey(child.id));
    expect(runner).toHaveBeenCalledOnce();
    const stored = await repo.get(child.id);
    expect(stored?.status).toBe('ready');
  });

  it('uses outputName for the child asset name when given', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create({ name: 'src', objectKey: 'ingest/src' });
    const child = await clip(
      {
        sourceAssetId: source.id,
        objectKey: 'ingest/src',
        startSeconds: 0,
        endSeconds: 3,
        outputName: 'intro'
      },
      { assets: repo, storage: fakeStorage(), runner: vi.fn(async () => undefined) }
    );
    expect(child.name).toBe('intro');
  });

  it('marks the child failed and rethrows when the runner fails', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create({ name: 'src', objectKey: 'ingest/src' });
    const runner: ClipRunner = vi.fn(async () => {
      throw new Error('ffmpeg exited 1');
    });

    await expect(
      clip(
        {
          sourceAssetId: source.id,
          objectKey: 'ingest/src',
          startSeconds: 1,
          endSeconds: 2
        },
        { assets: repo, storage: fakeStorage(), runner }
      )
    ).rejects.toThrow('ffmpeg exited 1');

    // The child exists and is recorded as failed.
    const children = await repo.list({ parentId: source.id });
    expect(children.items).toHaveLength(1);
    expect(children.items[0]?.status).toBe('failed');
  });

  // Issue #786: a job reporting success is not proof it wrote anything, so the
  // object is verified before the child is flipped to `ready`.
  it('fails the child when no object landed even though the runner resolved', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create({ name: 'src', objectKey: 'ingest/src' });

    await expect(
      clip(
        { sourceAssetId: source.id, objectKey: 'ingest/src', startSeconds: 1, endSeconds: 4 },
        { assets: repo, storage: fakeStorage(null), runner: vi.fn(async () => undefined) }
      )
    ).rejects.toThrow(/not found in storage/);

    const children = await repo.list({ parentId: source.id });
    expect(children.items[0]?.status).toBe('failed');
    // Crucially: no objectKey pointing at an object that answers NoSuchKey.
    expect(children.items[0]?.objectKey).toBeUndefined();
  });

  it('fails the child when the written object is empty', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create({ name: 'src', objectKey: 'ingest/src' });

    await expect(
      clip(
        { sourceAssetId: source.id, objectKey: 'ingest/src', startSeconds: 1, endSeconds: 4 },
        {
          assets: repo,
          storage: fakeStorage({ size: 0, etag: 'etag-empty' }),
          runner: vi.fn(async () => undefined)
        }
      )
    ).rejects.toThrow(/is empty \(0 bytes\)/);

    const children = await repo.list({ parentId: source.id });
    expect(children.items[0]?.status).toBe('failed');
    expect(children.items[0]?.objectKey).toBeUndefined();
  });

  // Issue #786: ffmpeg cannot mux an MP4 to a presigned HTTPS PUT URL, so the
  // runner is handed the destination OBJECT KEY and writes via s3://.
  it('hands the runner the destination object key, not a presigned PUT URL', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create({ name: 'src', objectKey: 'ingest/src' });
    const storage = fakeStorage();
    const runner: ClipRunner = vi.fn(async () => undefined);

    const child = await clip(
      { sourceAssetId: source.id, objectKey: 'ingest/src', startSeconds: 2, endSeconds: 5 },
      { assets: repo, storage, runner }
    );

    const [sourceUrl, outputKey, start, end] = (runner as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, number, number];
    expect(outputKey).toBe(clipObjectKey(child.id));
    expect(outputKey).not.toMatch(/^https?:/);
    expect(sourceUrl).toBe('https://minio.example/ingest/src?sig=get');
    expect([start, end]).toEqual([2, 5]);
    // No presigned PUT is minted for the output any more.
    expect(storage.presignedPut).not.toHaveBeenCalled();
    // The verification HEADs the key the runner was told to write.
    expect(storage.statObject).toHaveBeenCalledWith(outputKey);
  });

  it('records the clip window as the child technical metadata', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create({ name: 'src', objectKey: 'ingest/src' });

    const child = await clip(
      { sourceAssetId: source.id, objectKey: 'ingest/src', startSeconds: 5, endSeconds: 12 },
      { assets: repo, storage: fakeStorage(), runner: vi.fn(async () => undefined) }
    );

    expect(child.technicalMetadata?.durationSeconds).toBe(7);
    expect(child.technicalMetadata?.containerFormat).toBe('mp4');
  });
});

describe('clipTechnicalMetadata', () => {
  it('reports the requested window and an MP4 container', () => {
    const meta = clipTechnicalMetadata(undefined, 5, 12, 1024, '2026-09-24T00:00:00.000Z');
    expect(meta.durationSeconds).toBe(7);
    expect(meta.containerFormat).toBe('mp4');
    // Bitrate describes the clip (size over the window), not the source.
    expect(meta.bitrateBps).toBe(Math.round((1024 * 8) / 7));
    expect(meta.extractedAt).toBe('2026-09-24T00:00:00.000Z');
  });

  it('inherits the probed source streams for a stream copy', () => {
    const meta = clipTechnicalMetadata(
      {
        id: 'a',
        technicalMetadata: {
          codec: 'h264',
          width: 1920,
          height: 1080,
          durationSeconds: 60,
          bitrateBps: 5_000_000,
          containerFormat: 'mov',
          audioTracks: [],
          extractedAt: '2026-09-01T00:00:00.000Z'
        }
      } as never,
      0,
      4,
      2048,
      '2026-09-24T00:00:00.000Z'
    );
    expect(meta.codec).toBe('h264');
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
    // Container follows the clip's own `.mp4` key, not the source's.
    expect(meta.containerFormat).toBe('mp4');
  });
});

describe('clipCmdLine', () => {
  it('emits a stream-copy clip with seek + end bound', () => {
    const cmd = clipCmdLine('https://minio/src?sig=s', 'https://minio/dst?sig=p', 5, 12);
    expect(cmd).toContain('-ss 5');
    expect(cmd).toContain('-to 12');
    expect(cmd).toContain('-c copy');
    expect(cmd).toContain('"https://minio/src?sig=s"');
    expect(cmd).toContain('"https://minio/dst?sig=p"');
  });

  // Issue #786: the output target must be a native S3 URI. A presigned HTTPS PUT
  // URL produced a job that "succeeded" while writing nothing.
  it('writes to the s3:// destination built from bucket + key', () => {
    expect(clipDestinationUri('openvideocore-source', 'clips/a.mp4')).toBe(
      's3://openvideocore-source/clips/a.mp4'
    );
    const cmd = clipCmdLine(
      'https://minio/src?sig=s',
      clipDestinationUri('openvideocore-source', 'clips/a.mp4'),
      5,
      12
    );
    expect(cmd).toContain('"s3://openvideocore-source/clips/a.mp4"');
    expect(cmd).not.toMatch(/-c copy "https?:/);
  });
});

describe('redactLogQueryStrings', () => {
  // The captured log is surfaced in the 502 body, and ffmpeg echoes its `-i`
  // argument — a presigned GET URL carrying a live SigV4 signature.
  it('strips presigned query strings while keeping the failure text', () => {
    const log =
      'Opening \'https://minio.example/openvideocore-source/sources/abc?X-Amz-Signature=deadbeef&X-Amz-Expires=600\' for reading\n' +
      'Output file is empty, nothing was encoded';
    const redacted = redactLogQueryStrings(log);
    expect(redacted).not.toContain('X-Amz-Signature');
    expect(redacted).not.toContain('deadbeef');
    expect(redacted).toContain('?<redacted>');
    expect(redacted).toContain('Output file is empty, nothing was encoded');
  });
});

describe('makeOscClipRunner', () => {
  function fakeApi(): OscJobApi {
    const context = {
      getServiceAccessToken: vi.fn(async () => 'sat-token')
    } as unknown as OscJobApi['context'];
    return {
      context,
      createJob: vi.fn(async () => ({ name: 'x' })),
      // The runner polls getJob until a terminal status (osc-job-poll.ts);
      // 'SuccessCriteriaMet' is eyevinn-ffmpeg-s3's terminal success value.
      getJob: vi.fn(async () => ({ status: 'SuccessCriteriaMet' })),
      getLogsForInstance: vi.fn(async () => ''),
      removeJob: vi.fn(async () => undefined),
      s3Endpoint: 'https://minio.example',
      s3AccessKey: 'AK',
      s3SecretKey: 'SK',
      s3Bucket: 'openvideocore-source'
    } as unknown as OscJobApi;
  }

  it('creates a job, waits, and cleans up', async () => {
    const api = fakeApi();
    await makeOscClipRunner(api)('https://minio/src', 'https://minio/dst', 1, 4);
    expect(api.createJob).toHaveBeenCalledOnce();
    expect(api.getJob).toHaveBeenCalledOnce();
    expect(api.removeJob).toHaveBeenCalledOnce();
  });

  it('still cleans up the job when the wait fails', async () => {
    const api = fakeApi();
    (api.getJob as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    await expect(
      makeOscClipRunner(api)('https://minio/src', 'https://minio/dst', 1, 4)
    ).rejects.toThrow('boom');
    expect(api.removeJob).toHaveBeenCalledOnce();
  });

  // Issue #786: the job body — not the command line — carries the S3 credentials
  // that let eyevinn-ffmpeg-s3 upload its output, and the output target is an
  // s3:// URI.
  it('dispatches an s3:// output with the credentials in the job body', async () => {
    const api = fakeApi();
    await makeOscClipRunner(api)('https://minio/src?sig=get', 'clips/a.mp4', 5, 12);

    const body = (api.createJob as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as Record<
      string,
      unknown
    >;
    expect(body['cmdLineArgs']).toContain('"s3://openvideocore-source/clips/a.mp4"');
    expect(body['awsAccessKeyId']).toBe('AK');
    expect(body['awsSecretAccessKey']).toBe('SK');
    expect(body['s3EndpointUrl']).toBe('https://minio.example');
    // The credentials must not ride on the command line.
    expect(String(body['cmdLineArgs'])).not.toContain('SK');
  });

  it('captures the ffmpeg log before the instance is removed on failure', async () => {
    const api = fakeApi();
    (api.getJob as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'Failed' });
    (api.getLogsForInstance as ReturnType<typeof vi.fn>).mockResolvedValue([
      "Opening 'https://minio.example/src?X-Amz-Signature=deadbeef' for reading",
      'Output file is empty, nothing was encoded'
    ]);

    const err = (await makeOscClipRunner(api)(
      'https://minio/src?sig=get',
      'clips/a.mp4',
      1,
      4
    ).catch((e: unknown) => e)) as Error & { jobLog?: string };

    // The status-bearing sentence is the message (that is what the 502 body
    // carries); the ffmpeg output rides along as DATA for the server log only.
    expect(err.message).toMatch(/non-success status "Failed"/);
    expect(err.jobLog).toContain('Output file is empty, nothing was encoded');

    // Logs are only fetchable while the ephemeral instance exists, so the fetch
    // must happen BEFORE removeJob.
    const logsOrder = (api.getLogsForInstance as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0] as number;
    const removeOrder = (api.removeJob as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0] as number;
    expect(logsOrder).toBeLessThan(removeOrder);
    expect(api.removeJob).toHaveBeenCalledOnce();
  });

  it('redacts presigned signatures from the log it attaches to the failure', async () => {
    const api = fakeApi();
    (api.getJob as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'Failed' });
    (api.getLogsForInstance as ReturnType<typeof vi.fn>).mockResolvedValue(
      "Opening 'https://minio.example/src?X-Amz-Signature=deadbeef' for reading"
    );

    const err = (await makeOscClipRunner(api)(
      'https://minio/src?sig=get',
      'clips/a.mp4',
      1,
      4
    ).catch((e: unknown) => e)) as Error & { jobLog?: string };
    // Redaction applies to the captured text itself, because that text reaches
    // the server log — a live presigned signature does not belong there either.
    expect(err.jobLog).not.toContain('X-Amz-Signature');
    expect(err.jobLog).not.toContain('deadbeef');
    expect(err.jobLog).toContain('?<redacted>');
    expect(err.message).not.toContain('X-Amz-Signature');
    expect(err.message).not.toContain('deadbeef');
  });

  // Issue #786 round-2 review: the ffmpeg log is produced by a service we do not
  // control and can name storage endpoints, buckets and container paths. It must
  // stay out of `message`, because routes/assets.ts returns `message` verbatim in
  // the 502 body.
  it('keeps the third-party job log out of the error message', async () => {
    const api = fakeApi();
    (api.getJob as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'Failed' });
    (api.getLogsForInstance as ReturnType<typeof vi.fn>).mockResolvedValue([
      'internal-storage.svc.cluster.local:9000',
      'S3_SECRET_KEY=super-secret',
      'Output file is empty, nothing was encoded'
    ]);

    const err = (await makeOscClipRunner(api)(
      'https://minio/src?sig=get',
      'clips/a.mp4',
      1,
      4
    ).catch((e: unknown) => e)) as Error & { jobLog?: string };

    expect(err.message).not.toContain('internal-storage.svc.cluster.local');
    expect(err.message).not.toContain('super-secret');
    expect(err.message).not.toContain('Output file is empty');
    expect(err.message).not.toContain('ffmpeg log');
    // ...but an operator can still read all of it from the server-side log.
    expect(oscClipJobLog(err)).toContain('super-secret');
    expect(oscClipJobLog(err)).toContain('Output file is empty');
  });

  it('exposes no job log when none could be captured', async () => {
    const api = fakeApi();
    (api.getJob as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'Failed' });
    (api.getLogsForInstance as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gone'));

    const err = (await makeOscClipRunner(api)('https://minio/src', 'clips/a.mp4', 1, 4).catch(
      (e: unknown) => e
    )) as Error;
    expect(err.message).toMatch(/non-success status "Failed"/);
    expect(oscClipJobLog(err)).toBeUndefined();
  });

  it('does not fetch logs on success', async () => {
    const api = fakeApi();
    await makeOscClipRunner(api)('https://minio/src', 'clips/a.mp4', 1, 4);
    expect(api.getLogsForInstance).not.toHaveBeenCalled();
  });
});

describe('POST /:id/clip', () => {
  it('returns 201 with the new child asset on success', async () => {
    const runner: ClipRunner = vi.fn(async () => undefined);
    const { app, repo } = await buildApp({ clipRunner: runner });
    const id = await createAssetWithObject(app, repo);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: A,
      payload: { startSeconds: 5, endSeconds: 12 }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.parentId).toBe(id);
    expect(body.status).toBe('ready');
    expect(runner).toHaveBeenCalledOnce();
  });

  it('returns 400 when endSeconds is not greater than startSeconds', async () => {
    const { app, repo } = await buildApp({ clipRunner: vi.fn(async () => undefined) });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: A,
      payload: { startSeconds: 10, endSeconds: 10 }
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 502 when the OSC job fails', async () => {
    const runner: ClipRunner = vi.fn(async () => {
      throw new Error('ffmpeg exited 1');
    });
    const { app, repo } = await buildApp({ clipRunner: runner });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: A,
      payload: { startSeconds: 1, endSeconds: 2 }
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('clip_failed');
  });

  it('returns 409 when the source asset has no stored object', async () => {
    const { app } = await buildApp({ clipRunner: vi.fn(async () => undefined) });
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: A,
      payload: { name: 'no-object' }
    });
    const id = create.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: A,
      payload: { startSeconds: 1, endSeconds: 2 }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_object');
  });

  it('returns 501 when clip extraction is not configured', async () => {
    const { app, repo } = await buildApp({ clipRunner: undefined });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: A,
      payload: { startSeconds: 1, endSeconds: 2 }
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_configured');
  });

  it('returns 404 for an unknown asset', async () => {
    const { app } = await buildApp({ clipRunner: vi.fn(async () => undefined) });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/nope/clip',
      headers: A,
      payload: { startSeconds: 1, endSeconds: 2 }
    });
    expect(res.statusCode).toBe(404);
  });

  it.skip('does not leak existence across workspaces (404)', async () => {
    const { app, repo } = await buildApp({ clipRunner: vi.fn(async () => undefined) });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: auth('token-b'),
      payload: { startSeconds: 1, endSeconds: 2 }
    });
    expect(res.statusCode).toBe(404);
  });
});
