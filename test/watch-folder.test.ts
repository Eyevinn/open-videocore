// Watch-folder ingest tests (issue #16, #643).
//
// Exercises WatchFolderService against the in-memory asset repository with a
// fake MinIO client (listObjectsV2 + listenBucketNotification stubbed). Covers:
//   - polling detects a direct-drop object and creates an asset (processing)
//   - onObjectStored fires with the object key (ffprobe trigger)
//   - idempotency: a key already processed is not re-ingested
//   - API-managed `sources/` keys are ignored (no duplicate assets)
//   - a bad/unparseable key is skipped without crashing
//   - bucket-notification events ingest objects
//   - start/stop lifecycle + processedCount + the admin status endpoint
//   - the admin router's late-bound getWatchFolder accessor (issue #643) is used
//
// The current model is single-tenant on OSC (ADR-001): objects are stored under
// bare local keys with no `<workspaceId>/` prefix — OSC provides structural
// isolation — so parseObjectKey yields { localKey } and onObjectStored is
// (assetId, objectKey).
//
// The fake client uses an injectable setInterval so polling is driven manually.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import {
  WatchFolderService,
  parseObjectKey,
  extractKeyFromNotification,
  classifyWatchFolderConfig,
  watchFolderMisconfiguredMessage,
  WATCH_FOLDER_STORAGE_ENV_VAR,
  WATCH_FOLDER_INGEST_METHOD
} from '../src/pipeline/watch-folder.js';
import { adminRouter } from '../src/routes/admin.js';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

// Minimal fake MinIO client. `objects` is the bucket contents (full keys).
// listObjectsV2 returns a stream emitting one record per key. An optional
// notification emitter models listenBucketNotification.
function fakeClient(objects: string[], notifier?: EventEmitter & { stop?: () => void }) {
  return {
    listObjectsV2: (_bucket: string, _prefix: string, _recursive: boolean) => {
      const stream = new EventEmitter();
      // Emit asynchronously so listeners are attached first.
      queueMicrotask(() => {
        for (const name of objects) stream.emit('data', { name });
        stream.emit('end');
      });
      return stream;
    },
    listenBucketNotification: notifier ? () => notifier : undefined
  } as unknown as import('minio').Client;
}

describe('parseObjectKey', () => {
  it('returns the object key as the workspace-local key (OSC structural isolation)', () => {
    // Since the workspaceId-prefix layer was removed (commit 0d65216 — "a stack
    // is a workspace"), the full bucket key IS the local key.
    expect(parseObjectKey('clips/video.mp4')).toEqual({
      localKey: 'clips/video.mp4'
    });
    expect(parseObjectKey('video.mp4')).toEqual({ localKey: 'video.mp4' });
  });

  it('rejects an empty key, a leading slash, or a trailing slash (folder marker)', () => {
    expect(parseObjectKey('')).toBeUndefined();
    expect(parseObjectKey('/video.mp4')).toBeUndefined();
    expect(parseObjectKey('folder/')).toBeUndefined();
  });
});

describe('extractKeyFromNotification', () => {
  it('reads the key from an S3 event record and decodes it', () => {
    const record = { s3: { object: { key: 'my+clip.mp4' } } };
    expect(extractKeyFromNotification(record)).toBe('my clip.mp4');
  });

  it('returns undefined for a malformed record', () => {
    expect(extractKeyFromNotification({})).toBeUndefined();
    expect(extractKeyFromNotification(null)).toBeUndefined();
  });
});

// Fail-loud config validation (issue #642). When watch-folder ingest is enabled
// but the required object-storage connection variable (MINIO_URL) is absent —
// the exact Open Source Cloud scenario — the feature must NOT silently no-op:
// classifyWatchFolderConfig reports 'misconfigured' and
// watchFolderMisconfiguredMessage names the missing config + affected ingest
// method so main.ts can log a clear, actionable error.
describe('classifyWatchFolderConfig (issue #642 fail-loud)', () => {
  it('is disabled when the feature flag is off, regardless of storage', () => {
    expect(classifyWatchFolderConfig(false, false)).toBe('disabled');
    expect(classifyWatchFolderConfig(false, true)).toBe('disabled');
  });

  it('is misconfigured when enabled but the storage variable is absent', () => {
    // This is the silent-no-op trap: the operator asked for the feature but the
    // object-storage endpoint it depends on is not set.
    expect(classifyWatchFolderConfig(true, false)).toBe('misconfigured');
  });

  it('is ready when enabled and storage is present', () => {
    expect(classifyWatchFolderConfig(true, true)).toBe('ready');
  });
});

describe('watchFolderMisconfiguredMessage (issue #642)', () => {
  it('names the missing config variable and the affected ingest method', () => {
    const msg = watchFolderMisconfiguredMessage();
    // Acceptance criteria: the error names the missing configuration...
    expect(msg).toContain(WATCH_FOLDER_STORAGE_ENV_VAR);
    expect(WATCH_FOLDER_STORAGE_ENV_VAR).toBe('MINIO_URL');
    // ...and the ingest method it affects.
    expect(msg).toContain(WATCH_FOLDER_INGEST_METHOD);
    expect(WATCH_FOLDER_INGEST_METHOD).toBe('watch-folder');
    // It is actionable (tells the operator what to do), not a bare "disabled".
    expect(msg).toMatch(/unavailable/i);
    expect(msg).toContain('WATCH_FOLDER_ENABLED');
  });
});

describe('WatchFolderService polling', () => {
  let repo: InMemoryAssetRepository;

  beforeEach(() => {
    repo = new InMemoryAssetRepository();
  });

  it('detects a direct-drop object and creates a processing asset', async () => {
    const stored: Array<[string, string]> = [];
    const svc = new WatchFolderService({
      client: fakeClient(['drop.mp4']),
      bucket: 'src',
      repository: repo,
      log: silentLog,
      onObjectStored: (id, key) => stored.push([id, key]),
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {}
    });

    await svc.poll();

    const { items } = await repo.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe('drop.mp4');
    expect(items[0]?.objectKey).toBe('drop.mp4');
    expect(items[0]?.status).toBe('processing');
    expect(stored).toEqual([[items[0]!.id, 'drop.mp4']]);
    expect(svc.processedCount()).toBe(1);
  });

  it('is idempotent: a second poll does not re-ingest', async () => {
    const svc = new WatchFolderService({
      client: fakeClient(['drop.mp4']),
      bucket: 'src',
      repository: repo,
      log: silentLog
    });
    await svc.poll();
    await svc.poll();
    const { items } = await repo.list();
    expect(items).toHaveLength(1);
  });

  it('ignores API-managed sources/ keys', async () => {
    const svc = new WatchFolderService({
      client: fakeClient(['sources/asset-1']),
      bucket: 'src',
      repository: repo,
      log: silentLog
    });
    await svc.poll();
    const { items } = await repo.list();
    expect(items).toHaveLength(0);
    // It is still marked processed so it is not re-scanned each poll.
    expect(svc.processedCount()).toBe(1);
  });

  it('skips a bad object key without crashing', async () => {
    const svc = new WatchFolderService({
      client: fakeClient(['/bad-leading-slash.mp4', 'good.mp4']),
      bucket: 'src',
      repository: repo,
      log: silentLog
    });
    await svc.poll();
    const { items } = await repo.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe('good.mp4');
  });
});

describe('WatchFolderService notifications', () => {
  it('ingests an object delivered via a bucket notification', async () => {
    const repo = new InMemoryAssetRepository();
    const notifier = new EventEmitter() as EventEmitter & { stop?: () => void };
    notifier.stop = vi.fn();
    const svc = new WatchFolderService({
      client: fakeClient([], notifier),
      bucket: 'src',
      repository: repo,
      log: silentLog,
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {}
    });

    svc.start();
    notifier.emit('notification', { s3: { object: { key: 'live.mp4' } } });
    // Allow the detached ingestKey microtask to settle.
    await new Promise((r) => setImmediate(r));

    const { items } = await repo.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.objectKey).toBe('live.mp4');

    svc.stop();
    expect(notifier.stop).toHaveBeenCalled();
    expect(svc.isRunning()).toBe(false);
  });
});

describe('WatchFolderService lifecycle', () => {
  it('start is idempotent and stop flips running', () => {
    const svc = new WatchFolderService({
      client: fakeClient([]),
      bucket: 'src',
      repository: new InMemoryAssetRepository(),
      log: silentLog,
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {}
    });
    expect(svc.isRunning()).toBe(false);
    svc.start();
    expect(svc.isRunning()).toBe(true);
    svc.start(); // no-op
    expect(svc.isRunning()).toBe(true);
    svc.stop();
    expect(svc.isRunning()).toBe(false);
  });
});

describe('GET /api/v1/admin/watch-folder/status', () => {
  async function build(opts: Parameters<typeof adminRouter>[1]) {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(adminRouter, { prefix: '/api/v1/admin', ...opts });
    await app.ready();
    return app;
  }

  it('reports disabled when no service is wired', async () => {
    const app = await build({});
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/watch-folder/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, running: false, processedCount: 0 });
    await app.close();
  });

  it('reports enabled + running + processedCount when wired', async () => {
    const repo = new InMemoryAssetRepository();
    const svc = new WatchFolderService({
      client: fakeClient(['drop.mp4']),
      bucket: 'src',
      repository: repo,
      log: silentLog,
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {}
    });
    await svc.poll();
    svc.start();
    const app = await build({ watchFolder: svc });
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/watch-folder/status' });
    expect(res.json()).toEqual({ enabled: true, running: true, processedCount: 1 });
    svc.stop();
    await app.close();
  });

  // Issue #643: on Open Source Cloud the watch-folder is built AFTER boot, once
  // the object-storage endpoint is resolved from the parameter store. main.ts
  // exposes the current instance through the getWatchFolder accessor. Verify the
  // admin router honours the accessor (which takes precedence over the
  // boot-time value) so a stack provisioned after boot is reported with no
  // restart.
  it('honours the late-bound getWatchFolder accessor (post-boot OSC wiring)', async () => {
    const repo = new InMemoryAssetRepository();
    // Boot-time: no service wired (fresh OSC deployment, no stack yet).
    let live: WatchFolderService | undefined;
    const app = await build({ watchFolder: undefined, getWatchFolder: () => live });

    const before = await app.inject({ method: 'GET', url: '/api/v1/admin/watch-folder/status' });
    expect(before.json()).toEqual({ enabled: false, running: false, processedCount: 0 });

    // A stack is provisioned; main.ts rewires the watch-folder from the
    // parameter-store-backed storage and the accessor now returns it.
    live = new WatchFolderService({
      client: fakeClient(['drop.mp4']),
      bucket: 'openvideocore-source',
      repository: repo,
      log: silentLog,
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {}
    });
    await live.poll();
    live.start();

    const after = await app.inject({ method: 'GET', url: '/api/v1/admin/watch-folder/status' });
    expect(after.json()).toEqual({ enabled: true, running: true, processedCount: 1 });

    // start via POST reaches the accessor-provided instance too.
    live.stop();
    const start = await app.inject({ method: 'POST', url: '/api/v1/admin/watch-folder/start' });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ enabled: true, running: true });

    live.stop();
    await app.close();
  });
});
