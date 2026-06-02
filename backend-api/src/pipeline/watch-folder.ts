// Watch-folder ingest (issue #16).
//
// When a file is uploaded directly to the MinIO source bucket (bypassing the
// API upload route — e.g. an operator drops a file via mc/rclone or another
// system writes into a workspace prefix), the watch-folder service detects it
// and creates an asset record so the object becomes a first-class asset that
// flows through the rest of the pipeline (ffprobe metadata extraction, etc.).
//
// Two detection strategies, preferred in order:
//   1. MinIO bucket notifications — `listenBucketNotification` streams
//      `s3:ObjectCreated:*` events. This is event-driven (low latency, no
//      polling load) and is the primary path.
//   2. Polling fallback — if notification streaming is unavailable on the
//      deployment (some S3-compatible backends do not expose it), we poll
//      `listObjectsV2` every WATCH_FOLDER_POLL_INTERVAL_SECONDS and diff
//      against the set of keys we have already processed.
//
// Key model: WorkspaceStorage stores objects under `<workspaceId>/<localKey>`
// (see data/storage.ts + guard.objectPrefix). The watch-folder parses the
// leading path segment as the workspaceId and the remainder as the
// workspace-local object key, which is what the asset record + onObjectStored
// callback expect.
//
// Idempotency: an in-memory set of processed keys prevents duplicate asset
// creation within a single process lifetime. On restart we re-scan the bucket;
// objects uploaded through the normal API route already have an asset record,
// but the watch-folder has no cross-process memory, so it would re-create
// assets for keys it ingested before the restart. To avoid that we ONLY ingest
// keys that look like direct drops, NOT keys under the API's own `sources/`
// prefix (those already have asset records created by the upload route). This
// keeps the feature additive and safe to enable alongside the upload route.
//
// Resilience: a bad/unparseable object key (e.g. one with no workspace prefix)
// is logged and skipped — the service never crashes on a single bad object.

import type { Client as MinioClient } from 'minio';
import type { AssetRepository } from '../data/asset-repo.js';
import { assertValidWorkspaceId } from '../data/guard.js';

// Logger surface we depend on (subset of Fastify's logger). Injected so the
// service stays decoupled from Fastify and is trivial to stub in tests.
export type WatchFolderLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export const DEFAULT_POLL_INTERVAL_SECONDS = 30;

// Resolve the configured poll interval (12-factor: config via env). Falls back
// to the 30s default when unset or invalid.
export function pollIntervalSeconds(): number {
  const raw = process.env['WATCH_FOLDER_POLL_INTERVAL_SECONDS'];
  if (!raw) return DEFAULT_POLL_INTERVAL_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_SECONDS;
}

// Opt-in flag. The service is disabled by default; an operator must set
// WATCH_FOLDER_ENABLED=true to turn it on.
export function watchFolderEnabled(): boolean {
  return process.env['WATCH_FOLDER_ENABLED'] === 'true';
}

// Object keys created by the direct-upload route live under `<ws>/sources/...`
// (see routes/asset-upload.sourceObjectKey). Those already have an asset
// record, so the watch-folder ignores them to avoid duplicating assets for
// objects the API itself wrote.
const API_MANAGED_LOCAL_PREFIX = 'sources/';

// Parse a fully-namespaced bucket object key into its workspaceId + local key.
// Returns undefined for a key that does not match the `<workspaceId>/<rest>`
// shape or carries an invalid workspaceId. Pure + exported for unit testing.
export function parseObjectKey(
  fullKey: string
): { workspaceId: string; localKey: string } | undefined {
  const slash = fullKey.indexOf('/');
  if (slash <= 0 || slash === fullKey.length - 1) {
    // No prefix, leading slash, or trailing slash (a "folder" marker).
    return undefined;
  }
  const workspaceId = fullKey.slice(0, slash);
  const localKey = fullKey.slice(slash + 1);
  try {
    assertValidWorkspaceId(workspaceId);
  } catch {
    return undefined;
  }
  return { workspaceId, localKey };
}

export type WatchFolderOptions = {
  client: MinioClient;
  bucket: string;
  repository: AssetRepository;
  log: WatchFolderLogger;
  // Same callback the upload route fires post-upload (issue #6 ffprobe). When
  // provided, a newly ingested object triggers fire-and-forget extraction.
  onObjectStored?: (workspaceId: string, assetId: string, objectKey: string) => void;
  // Polling cadence; defaults to the env-derived value.
  pollIntervalMs?: number;
  // Injectable timers for fast, deterministic tests.
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
};

export class WatchFolderService {
  private readonly client: MinioClient;
  private bucket: string;
  private readonly repo: AssetRepository;
  private readonly log: WatchFolderLogger;
  private readonly onObjectStored?: (
    workspaceId: string,
    assetId: string,
    objectKey: string
  ) => void;
  private readonly pollIntervalMs: number;
  private readonly setIntervalFn: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;

  // Keys we have already turned into assets this process lifetime.
  private readonly processed = new Set<string>();
  private running = false;
  private pollHandle?: ReturnType<typeof setInterval>;
  // The active notification stream (MinIO EventEmitter-like). Typed loosely
  // because the minio types model it as a NodeJS.EventEmitter.
  private notificationStream?: { stop?: () => void };

  constructor(opts: WatchFolderOptions) {
    this.client = opts.client;
    this.bucket = opts.bucket;
    this.repo = opts.repository;
    this.log = opts.log;
    this.onObjectStored = opts.onObjectStored;
    this.pollIntervalMs = opts.pollIntervalMs ?? pollIntervalSeconds() * 1000;
    this.setIntervalFn = opts.setIntervalFn ?? ((h, ms) => setInterval(h, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((handle) => clearInterval(handle));
  }

  isRunning(): boolean {
    return this.running;
  }

  processedCount(): number {
    return this.processed.size;
  }

  // The bucket currently being watched. Callers (e.g. the storage router's
  // per-bucket toggle) read this to decide whether the watch-folder is active
  // on a given bucket.
  currentBucket(): string {
    return this.bucket;
  }

  // Repoint the watcher at a different source bucket. Stops the current watcher
  // (detaching any notification listener + poll timer), swaps the bucket, and
  // restarts if it was running so the change takes effect immediately. A no-op
  // when the bucket is unchanged. The processed-key set is cleared so the new
  // bucket is scanned from scratch (its keys are independent of the old one).
  setBucket(bucket: string): void {
    if (bucket === this.bucket) return;
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    this.bucket = bucket;
    this.processed.clear();
    if (wasRunning) this.start();
  }

  // Begin watching. Tries to attach a bucket-notification listener; if that is
  // unavailable (the SDK call throws or the backend does not support it) it
  // falls back to polling. Always also runs an initial poll so objects already
  // present (or dropped while the service was down) are picked up promptly.
  start(): void {
    if (this.running) return;
    this.running = true;

    this.attachNotificationListener();

    // Kick off an immediate scan, then schedule periodic polling. The poll is
    // cheap (a prefix-less listing diffed against the processed set) and also
    // serves as a safety net for any notification the listener missed.
    void this.poll();
    this.pollHandle = this.setIntervalFn(() => void this.poll(), this.pollIntervalMs);

    this.log.info(
      { bucket: this.bucket, pollIntervalMs: this.pollIntervalMs },
      'watch-folder ingest started'
    );
  }

  // Stop watching: detach the notification listener and clear the poll timer.
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pollHandle) {
      this.clearIntervalFn(this.pollHandle);
      this.pollHandle = undefined;
    }
    if (this.notificationStream?.stop) {
      try {
        this.notificationStream.stop();
      } catch {
        // Best-effort detach; nothing more to do on teardown.
      }
    }
    this.notificationStream = undefined;
    this.log.info({ bucket: this.bucket }, 'watch-folder ingest stopped');
  }

  // Attach a MinIO bucket-notification listener for object-created events. Any
  // failure here is non-fatal: we log and rely on the polling fallback.
  private attachNotificationListener(): void {
    const listen = (
      this.client as unknown as {
        listenBucketNotification?: (
          bucket: string,
          prefix: string,
          suffix: string,
          events: string[]
        ) => { on: (event: string, cb: (record: unknown) => void) => void; stop?: () => void };
      }
    ).listenBucketNotification;
    if (typeof listen !== 'function') {
      this.log.warn(
        { bucket: this.bucket },
        'listenBucketNotification unavailable — using polling only'
      );
      return;
    }
    try {
      const emitter = listen.call(this.client, this.bucket, '', '', ['s3:ObjectCreated:*']);
      emitter.on('notification', (record: unknown) => {
        const key = extractKeyFromNotification(record);
        if (key) void this.ingestKey(key);
      });
      emitter.on('error', (err: unknown) => {
        this.log.warn({ err, bucket: this.bucket }, 'watch-folder notification stream error');
      });
      this.notificationStream = emitter;
    } catch (err) {
      this.log.warn(
        { err, bucket: this.bucket },
        'failed to attach bucket-notification listener — using polling only'
      );
    }
  }

  // List the bucket and ingest any not-yet-processed object. Never throws: a
  // listing error is logged so the periodic poll keeps running.
  async poll(): Promise<void> {
    try {
      const keys = await this.listAllKeys();
      for (const key of keys) {
        if (!this.processed.has(key)) {
          await this.ingestKey(key);
        }
      }
    } catch (err) {
      this.log.warn({ err, bucket: this.bucket }, 'watch-folder poll failed');
    }
  }

  private listAllKeys(): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const keys: string[] = [];
      const stream = this.client.listObjectsV2(this.bucket, '', true);
      stream.on('data', (obj) => {
        if (obj.name) keys.push(obj.name);
      });
      stream.on('end', () => resolve(keys));
      stream.on('error', reject);
    });
  }

  // Turn one bucket object key into an asset (idempotent + defensive). Marks the
  // key processed before any awaited work so a concurrent notification + poll
  // for the same key cannot double-create. NEVER throws.
  async ingestKey(fullKey: string): Promise<void> {
    if (this.processed.has(fullKey)) return;

    const parsed = parseObjectKey(fullKey);
    if (!parsed) {
      this.log.warn({ key: fullKey }, 'watch-folder: skipping unparseable object key');
      this.processed.add(fullKey); // do not retry a permanently-bad key every poll
      return;
    }

    // Ignore objects the API's own upload route manages; they already have an
    // asset record (see file header).
    if (parsed.localKey.startsWith(API_MANAGED_LOCAL_PREFIX)) {
      this.processed.add(fullKey);
      return;
    }

    // Reserve the key first so a racing poll/notification is a no-op.
    this.processed.add(fullKey);

    try {
      const name = parsed.localKey.split('/').pop() || parsed.localKey;
      const asset = await this.repo.create(parsed.workspaceId, {
        name,
        objectKey: parsed.localKey
      });
      // Advance to processing and fire metadata extraction, mirroring the
      // upload route's post-upload behaviour.
      await this.repo.update(parsed.workspaceId, asset.id, { status: 'processing' });
      this.onObjectStored?.(parsed.workspaceId, asset.id, parsed.localKey);
      this.log.info(
        { workspaceId: parsed.workspaceId, assetId: asset.id, objectKey: parsed.localKey },
        'watch-folder: ingested direct-drop object'
      );
    } catch (err) {
      // Un-reserve so a later poll can retry a transient failure.
      this.processed.delete(fullKey);
      this.log.error({ err, key: fullKey }, 'watch-folder: failed to ingest object');
    }
  }
}

// Extract the object key from a MinIO bucket-notification record. The record
// follows the S3 event shape: { Records: [{ s3: { object: { key } } }] }. S3
// URL-encodes the key (spaces -> '+', etc.); we decode it. Returns undefined
// for an unexpected shape so a malformed event is skipped rather than crashing.
export function extractKeyFromNotification(record: unknown): string | undefined {
  const r = record as {
    Records?: { s3?: { object?: { key?: string } } }[];
    s3?: { object?: { key?: string } };
  };
  // MinIO emits one record per 'notification' event, but be lenient about
  // whether it is wrapped in a Records array or delivered bare.
  const s3 = r?.s3 ?? r?.Records?.[0]?.s3;
  const rawKey = s3?.object?.key;
  if (typeof rawKey !== 'string' || rawKey.length === 0) return undefined;
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    return rawKey;
  }
}
