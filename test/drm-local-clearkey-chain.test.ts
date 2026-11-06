// Local clear-key end-to-end chain: key acquisition -> encrypt -> packaged output ->
// protection signalling in the manifests (issue #1268 item 1, ADR-008 §13 "Clear-key
// end-to-end (local)").
//
// WHY THIS IS LOCAL-ONLY AND SKIP-GUARDED.
// The OSC catalog packager cannot encrypt at all (no encryption option in the packaging
// library, the instance config, or the queue envelope), which is why the product's probe
// answers `encryption: false` (`NO_ENCRYPTION_CAPABILITY`, src/pipeline/packaging.ts) and
// a protected package request is refused `409 drm_unsupported`. The upstream change is
// requested in the engagement's OSC friction log
// `docs/osc-feedback/incoming-packager-no-encryption-support.md` (ADR-008 §7.2). Until it
// ships, the ONLY way to exercise an encrypting package run is a packager image built
// locally from the branch that adds encryption support, run through the `local-drm`
// docker-compose profile. There is therefore no DRM-positive case in the OSC e2e suite —
// see the comment in `e2e/suite/cases.mjs`.
//
// This file asserts on MANIFEST CONTENT (`#EXT-X-SESSION-KEY`, `<ContentProtection`), not
// on playback: a player is not a test dependency.
//
// It SKIPS — never fails — when the local image is absent, which is the normal state in CI
// and in the OSC e2e environment. `describe.runIf` reports the whole group as skipped and
// the reason is printed once, named, below.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
//   - `enqueuePackagingStep`, `PackagingStepRequest` (`{ job, drm? }`), `EncryptingPackagingRunner`
//     (`capabilities()` + `enqueue(job & { encryption? }, { signal? })`), `EncryptionParams`
//     (`{ scheme, keys[{label,keyId,key}], pssh, hlsKeyUri?, protectionSystems }`),
//     `PackagingJob` (`{ jobId, url }`), `outputPrefix` (`packaged/<assetId>`),
//     `DEFAULT_PACKAGED_BUCKET` (`openvideocore-packaged`), `manifestUrlsFor`
//     (`index.m3u8` / `manifest.mpd`) — src/pipeline/packaging.ts.
//   - `packagerQueueKey()` (`PACKAGER_QUEUE_KEY` or `encore-packager:jobs`) and the envelope
//     `zadd(key, Date.now(), JSON.stringify(job))` — src/pipeline/osc-packager-queue.ts:33-63.
//   - `ClearKeyDevProvider` + `ClearKeyDevProviderOptions` (`{ id?, systemIds?, licenceUrl? }`),
//     `CONTENT_KEY_BYTES` = 16 — src/drm/clearkey-dev-provider.ts.
//   - `KeyRequest` (`{ contentId, systems, scheme, trackGroups, keyIds? }`),
//     `CLEAR_KEY_SYSTEM_ID` — src/drm/key-provider.ts.
//   - The packager's input is an Encore job URL, not a media URL
//     (`docs/osc-feedback/incoming-packager-input-encore-job-url-only.md`), so the job URL is
//     supplied by the operator through `LOCAL_DRM_ENCORE_JOB_URL`; nothing here invents an
//     Encore job document.

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client as MinioClient } from 'minio';
import Redis from 'ioredis';
import {
  enqueuePackagingStep,
  outputPrefix,
  DEFAULT_PACKAGED_BUCKET,
  type EncryptingPackagingRunner,
  type EncryptionParams,
  type PackagingJob
} from '../src/pipeline/packaging.js';
import { packagerQueueKey } from '../src/pipeline/osc-packager-queue.js';
import { ClearKeyDevProvider } from '../src/drm/clearkey-dev-provider.js';
import { CLEAR_KEY_SYSTEM_ID } from '../src/drm/key-provider.js';

const run = promisify(execFile);

// Everything is an override with a development default; no credential is hardcoded.
const IMAGE =
  process.env['LOCAL_DRM_PACKAGER_IMAGE'] ??
  'open-videocore-local/encore-packager-encryption:dev';
const ENCORE_JOB_URL = process.env['LOCAL_DRM_ENCORE_JOB_URL'];
const REDIS_URL = process.env['LOCAL_DRM_TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379';
const S3_ENDPOINT = process.env['LOCAL_DRM_TEST_S3_ENDPOINT'] ?? '127.0.0.1:9000';
const S3_ACCESS_KEY = process.env['LOCAL_DRM_S3_ACCESS_KEY'] ?? 'minioadmin';
const S3_SECRET_KEY = process.env['LOCAL_DRM_S3_SECRET_KEY'] ?? 'minioadmin';
const BUCKET = process.env['LOCAL_DRM_PACKAGED_BUCKET'] ?? DEFAULT_PACKAGED_BUCKET;
const CHAIN_TIMEOUT_MS = Number(process.env['LOCAL_DRM_TIMEOUT_MS'] ?? 600_000);

/** Is the locally built, encryption-capable packager image on this machine? */
async function packagerImagePresent(image: string): Promise<boolean> {
  try {
    await run('docker', ['image', 'inspect', image], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const imagePresent = await packagerImagePresent(IMAGE);
const haveJobUrl = typeof ENCORE_JOB_URL === 'string' && ENCORE_JOB_URL.length > 0;
// One named reason, printed once, so a skipped run says exactly what is missing instead of
// silently reporting nothing. Named reasons, not a bare boolean (acceptance criterion:
// "skipped with a named reason").
const skipReason = !imagePresent
  ? `no local encryption-capable packager image "${IMAGE}": build one from the packaging ` +
    'branch that adds encryption support (see docs/osc-feedback/incoming-packager-no-encryption-support.md), ' +
    'tag it, and set LOCAL_DRM_PACKAGER_IMAGE'
  : !haveJobUrl
    ? 'LOCAL_DRM_ENCORE_JOB_URL is not set: the packager consumes an Encore job URL, not a media ' +
      'URL (docs/osc-feedback/incoming-packager-input-encore-job-url-only.md), and no transcoder runs ' +
      'in the local-drm compose profile'
    : '';
const canRunChain = skipReason === '';
if (!canRunChain) {
  // The reason has to reach the test output: a group reported as skipped with no explanation
  // is indistinguishable from a group nobody wrote.
  console.info(`[local-drm] clear-key chain skipped: ${skipReason}`);
}

/** The packaged objects the chain has to produce (`manifestUrlsFor` filenames). */
const manifestKeys = (assetId: string) => ({
  hls: `${outputPrefix(assetId)}/index.m3u8`,
  dash: `${outputPrefix(assetId)}/manifest.mpd`
});

async function readObject(client: MinioClient, key: string): Promise<string> {
  const stream = await client.getObject(BUCKET, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Wait for `key` to exist in the packaged bucket, within `timeoutMs`. */
async function waitForObject(
  client: MinioClient,
  key: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.statObject(BUCKET, key);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new Error(
    `packaged object ${BUCKET}/${key} never appeared within ${timeoutMs} ms ` +
      `(last error: ${String((lastError as Error)?.message)})`
  );
}

describe('local clear-key chain guard (issue #1268)', () => {
  it('either runs the chain or names the missing piece', () => {
    // A guard that cannot say what it skipped for is a silent pass.
    if (canRunChain) {
      expect(skipReason).toBe('');
      return;
    }
    expect(skipReason).toMatch(/packager image|LOCAL_DRM_ENCORE_JOB_URL/);
  });
});

describe.runIf(canRunChain)('local clear-key chain (issue #1268, ADR-008 §13)', () => {
  it(
    'acquires keys through clearkey-dev, packages encrypted, and the manifests carry the protection signalling',
    async () => {
      // 1. Bring up the profile. Idempotent: already-running services are left alone, and the
      //    profile means nothing else in the compose file is touched.
      await run(
        'docker',
        ['compose', '--profile', 'local-drm', 'up', '-d', 'minio', 'valkey', 'packager-encrypting'],
        { timeout: 180_000, env: { ...process.env, LOCAL_DRM_PACKAGER_IMAGE: IMAGE } }
      );

      const storage = new MinioClient({
        endPoint: S3_ENDPOINT.split(':')[0] as string,
        port: Number(S3_ENDPOINT.split(':')[1] ?? 9000),
        useSSL: false,
        accessKey: S3_ACCESS_KEY,
        secretKey: S3_SECRET_KEY
      });
      if (!(await storage.bucketExists(BUCKET))) await storage.makeBucket(BUCKET);

      const redis = new Redis(REDIS_URL);
      try {
        // 2. The real key provider. No external provider, no OSC credential: `clearkey-dev`
        //    mints the content key locally and marks the signalling `dev: true`.
        const keyProvider = new ClearKeyDevProvider({ id: 'primary' });

        // 3. The encrypting runner. Its `capabilities()` is what an encryption-capable packager
        //    build reports, and `enqueue` writes the PER-JOB envelope the friction log asks
        //    upstream for — `{ jobId, url, encryption }` on the product's own queue key, scored
        //    by time exactly as `makeOscPackagerQueue` does. This adapter is the one piece that
        //    cannot come from src yet: the deployed library has no slot for `encryption`.
        const queueKey = packagerQueueKey();
        const enqueued: (PackagingJob & { encryption?: EncryptionParams })[] = [];
        const runner: EncryptingPackagingRunner = {
          async capabilities() {
            return {
              encryption: true,
              schemes: ['cbcs'],
              systems: [CLEAR_KEY_SYSTEM_ID]
            };
          },
          async enqueue(job) {
            enqueued.push(job);
            await redis.zadd(queueKey, Date.now(), JSON.stringify(job));
          }
        };

        const assetId = `local-drm-${Date.now()}`;
        const job: PackagingJob = { jobId: assetId, url: ENCORE_JOB_URL as string };

        // 4. The product's own step: key acquisition -> encryption params -> enqueue.
        const outcome = await enqueuePackagingStep(
          { runner, keyProvider },
          {
            job,
            drm: { requested: true, scheme: 'cbcs', systems: [CLEAR_KEY_SYSTEM_ID] }
          }
        );
        expect(outcome).toEqual({ ok: true, encrypted: true });

        const params = enqueued[0]?.encryption;
        expect(params?.scheme).toBe('cbcs');
        expect(params?.protectionSystems).toEqual([CLEAR_KEY_SYSTEM_ID]);
        // 16 raw key bytes, base64 — the material that must never leave this call stack.
        const contentKey = params?.keys[0]?.key as string;
        expect(Buffer.from(contentKey, 'base64')).toHaveLength(16);

        // 5. The packager consumes the entry, encrypts and writes the packaged output. The
        //    callback leg is the packager's own `CALLBACK_URL`; what is asserted here is the
        //    delivered artefact, because that is what a player reads.
        const keys = manifestKeys(assetId);
        await waitForObject(storage, keys.hls, CHAIN_TIMEOUT_MS);
        await waitForObject(storage, keys.dash, 60_000);

        // 6. The signalling, asserted on manifest CONTENT (not on playback).
        const hls = await readObject(storage, keys.hls);
        expect(hls).toContain('#EXT-X-SESSION-KEY');
        const dash = await readObject(storage, keys.dash);
        expect(dash).toContain('ContentProtection');
        // The key id is signalling and may appear; the KEY never may (ADR-008 D4/§10).
        expect(hls).not.toContain(contentKey);
        expect(dash).not.toContain(contentKey);

        // The queue entry is consumed, not left behind as a ghost.
        expect(await redis.zcard(queueKey)).toBe(0);
      } finally {
        redis.disconnect();
      }
    },
    CHAIN_TIMEOUT_MS + 240_000
  );
});
