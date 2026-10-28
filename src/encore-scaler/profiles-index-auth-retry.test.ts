// #1101: a 401/403 on the UNAUTHENTICATED profiles index is retryable, driven by
// the structured HTTP status + URL path rather than an English substring list.
//
// WHAT BROKE (#1091, reported from production)
// --------------------------------------------
// An asset died permanently at `encodeAttempts: 1` because Encore got a 401
// fetching its profile index:
//
//   dropped by Encore: Server returned HTTP response code: 401 for URL:
//   .../api/v1/profiles/index.yml
//
// classifyEncoreFailure matched that against two hand-maintained English needle
// lists, found nothing, and returned 'deterministic' — so decideRetry settled on
// the FIRST observation and MAX_ENCODE_ATTEMPTS (3) with its 15s/60s backoff was
// never reached. The same Encore instance then ran the customer's SECOND asset
// with the SAME profile, which is what proves the 401 was transient.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - parseHttpFailureDetail / isProfilesIndexUrl / isProfilesIndexAuthFailure /
//     classifyEncoreFailure / isRetryableFailureClass / MAX_ENCODE_ATTEMPTS /
//     BACKOFF_MS — src/encore-scaler/retry-policy.ts.
//   - decideRetry(redis, workspaceId, jobId, failureMessage, cancelPrior?) =>
//     RetryDecision { action:'retry'|'skip'|'settle', ... }; recordDispatch;
//     clearRetryState — src/encore-scaler/retry-store.ts:151-165, 273-374. The
//     classification happens at retry-store.ts:284, the ONE place both paths
//     share.
//   - The failure-string shape of each path:
//       callback path — `job.message ?? 'encore status: ${status}'`
//         (src/pipeline/encore-callback-poller.ts:552), i.e. Encore's raw message
//         with NO prefix.
//       drop path     — `dropped by Encore: ${reason}`
//         (src/main.ts:1357-1360), i.e. the same Encore message PREFIXED.
//     Both forms are exercised below, because the prefix is the only textual
//     difference between the two paths and the fix must survive it.
//   - The JDK failure-string format `Server returned HTTP response code: <code>
//     for URL: <url>` thrown by java.net.HttpURLConnection#getInputStream, which
//     is what Encore's tokenless UrlResource profile fetch surfaces
//     (src/services/profiles-reachability.ts:1-10). Both observed instances are
//     recorded verbatim on #1091 and #110.
//   - Profiles index path: profilesRouter mounted at '/api/v1/profiles'
//     (src/main.ts:1869-1870) serving GET '/index.yml' with no auth
//     (src/routes/profiles.ts:20-24, :132).
//   - settleFailedTranscode(deps, job, error, reason?) + 'gone-from-active-set'
//     conditional settle (#709) — src/pipeline/failed-transcode-reconciler.ts.
//   - keys.queue / jobStatus / jobInstance / jobPayload / jobAttempts +
//     QueuedJob — src/encore-scaler/types.ts.
//   - encodeEncoreJobId / decodeEncoreJobId / InMemory{Job,Asset,Pipeline}-
//     Repository — src/data/job-repo.ts, asset-repo.ts, pipeline-repo.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

import {
  parseHttpFailureDetail,
  isProfilesIndexUrl,
  isProfilesIndexAuthFailure,
  classifyEncoreFailure,
  isRetryableFailureClass,
  PROFILES_INDEX_PATH,
  MAX_ENCODE_ATTEMPTS,
  BACKOFF_MS
} from './retry-policy.js';
import { decideRetry, recordDispatch, clearRetryState } from './retry-store.js';
import { keys, type QueuedJob } from './types.js';
import {
  InMemoryJobRepository,
  encodeEncoreJobId,
  decodeEncoreJobId
} from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import { settleFailedTranscode } from '../pipeline/failed-transcode-reconciler.js';

// The deployment's real profiles URL shape: PUBLIC_BASE_URL + the router mount +
// the index document (resolveEncoreProfilesUrl, src/main.ts:957).
const PROFILES_INDEX_URL = `https://videocore.example.osaas.io${PROFILES_INDEX_PATH}`;

// Encore's own message, exactly as #1091 recorded it (host elided by the
// reporter) and as #110 recorded it (full java.io.IOException form). Both must
// classify identically — the conclusion must not depend on the part of the
// string a log excerpt happened to cut.
const ENCORE_401_ELIDED = `Server returned HTTP response code: 401 for URL: .../api/v1/profiles/index.yml`;
const ENCORE_401_FULL = `java.io.IOException: Server returned HTTP response code: 401 for URL: ${PROFILES_INDEX_URL}`;
const ENCORE_403_FULL = `java.io.IOException: Server returned HTTP response code: 403 for URL: ${PROFILES_INDEX_URL}`;

// A 401 from somewhere that is NOT the profiles index. Must stay deterministic:
// a 401 anywhere an authenticated call is made is a credential verdict, and
// retrying it burns the budget to no purpose.
const ENCORE_401_OTHER_URL =
  'java.io.IOException: Server returned HTTP response code: 401 for URL: ' +
  'https://minio.example.osaas.io/ovc-media/src/clip.mov';

// A 404 on the profiles index. Also deterministic: the index genuinely is not
// being served, so re-running reproduces it.
const ENCORE_404_PROFILES_INDEX =
  `java.io.IOException: Server returned HTTP response code: 404 for URL: ${PROFILES_INDEX_URL}`;

// #1058's misrouted-source failure, the case the issue names as "must stay
// deterministic": the object really is absent.
const FFPROBE_404 =
  'ffprobe failed for input s3://ovc-media/src/missing.mov: Server returned 404 Not Found';

// The drop path's prefix (src/main.ts:1357-1360).
const dropped = (reason: string) => `dropped by Encore: ${reason}`;

// ---------------------------------------------------------------------------
// Layer 1: the ONE parser
// ---------------------------------------------------------------------------

describe('parseHttpFailureDetail (#1101 — the single status+URL parser)', () => {
  it('recovers status and URL from the JDK HttpURLConnection failure string', () => {
    expect(parseHttpFailureDetail(ENCORE_401_FULL)).toEqual({
      status: 401,
      url: PROFILES_INDEX_URL
    });
  });

  it('recovers them through the drop path prefix and the bare (unprefixed) form', () => {
    // The two paths differ ONLY by this prefix, so the parser must see through it.
    expect(parseHttpFailureDetail(dropped(ENCORE_401_ELIDED))).toEqual({
      status: 401,
      url: '.../api/v1/profiles/index.yml'
    });
    expect(parseHttpFailureDetail(ENCORE_401_ELIDED)).toEqual({
      status: 401,
      url: '.../api/v1/profiles/index.yml'
    });
  });

  it('is case-insensitive and tolerates extra whitespace', () => {
    expect(
      parseHttpFailureDetail(
        'SERVER RETURNED HTTP RESPONSE CODE:  503   FOR URL:  https://h.example/x'
      )
    ).toEqual({ status: 503, url: 'https://h.example/x' });
  });

  it('returns undefined when the string carries no HTTP failure of this shape', () => {
    expect(parseHttpFailureDetail(undefined)).toBeUndefined();
    expect(parseHttpFailureDetail('')).toBeUndefined();
    expect(parseHttpFailureDetail('Error during demuxing: I/O error')).toBeUndefined();
    // #1058's wording is a DIFFERENT shape (no "response code:" / "for URL:"),
    // so the parser declines it rather than guessing.
    expect(parseHttpFailureDetail(FFPROBE_404)).toBeUndefined();
    // A bare three-digit run is not an HTTP failure. This is the #1071 defect
    // (any message merely CONTAINING '503' was retried) in parser form.
    expect(parseHttpFailureDetail('job 503 of 900 failed after 401 frames')).toBeUndefined();
  });
});

describe('isProfilesIndexUrl (#1101 — path-only comparison)', () => {
  it('matches the real derived profiles index URL', () => {
    expect(isProfilesIndexUrl(PROFILES_INDEX_URL)).toBe(true);
  });

  it('matches a host-elided excerpt and an ingress path prefix', () => {
    expect(isProfilesIndexUrl('.../api/v1/profiles/index.yml')).toBe(true);
    expect(isProfilesIndexUrl('https://h.example/videocore/api/v1/profiles/index.yml')).toBe(
      true
    );
  });

  it('does not match a different profiles document, or the path in a query string', () => {
    // A per-profile YAML document is NOT the index.
    expect(isProfilesIndexUrl('https://h.example/api/v1/profiles/abr-vod/yaml')).toBe(false);
    // The query is stripped before comparison, so a URL that merely MENTIONS the
    // path does not match.
    expect(
      isProfilesIndexUrl('https://h.example/redirect?to=/api/v1/profiles/index.yml')
    ).toBe(false);
    expect(isProfilesIndexUrl('https://minio.example/ovc-media/src/clip.mov')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: classification — the four acceptance cases, on BOTH path shapes
// ---------------------------------------------------------------------------

describe('classifyEncoreFailure — profiles-index auth failures (#1101)', () => {
  it('classifies 401 on the profiles index as retryable, prefixed or not', () => {
    for (const msg of [ENCORE_401_ELIDED, ENCORE_401_FULL]) {
      // Callback-path shape (raw Encore message).
      expect(classifyEncoreFailure(msg)).toBe('transport');
      expect(isRetryableFailureClass(classifyEncoreFailure(msg))).toBe(true);
      // Drop-path shape (same message, prefixed).
      expect(classifyEncoreFailure(dropped(msg))).toBe('transport');
      expect(isRetryableFailureClass(classifyEncoreFailure(dropped(msg)))).toBe(true);
    }
  });

  it('classifies 403 on the profiles index as retryable, prefixed or not', () => {
    expect(classifyEncoreFailure(ENCORE_403_FULL)).toBe('transport');
    expect(isRetryableFailureClass(classifyEncoreFailure(ENCORE_403_FULL))).toBe(true);
    expect(classifyEncoreFailure(dropped(ENCORE_403_FULL))).toBe('transport');
    expect(isRetryableFailureClass(classifyEncoreFailure(dropped(ENCORE_403_FULL)))).toBe(true);
  });

  it('keeps a 401 from ANY OTHER url deterministic (a credential verdict, not infrastructure)', () => {
    expect(isProfilesIndexAuthFailure(ENCORE_401_OTHER_URL)).toBe(false);
    expect(classifyEncoreFailure(ENCORE_401_OTHER_URL)).toBe('deterministic');
    expect(isRetryableFailureClass(classifyEncoreFailure(ENCORE_401_OTHER_URL))).toBe(false);
    expect(classifyEncoreFailure(dropped(ENCORE_401_OTHER_URL))).toBe('deterministic');
  });

  it('keeps a 404 deterministic — on the profiles index and on a missing source', () => {
    // Narrow by STATUS as well as by URL: only 401/403 are infrastructure here.
    expect(isProfilesIndexAuthFailure(ENCORE_404_PROFILES_INDEX)).toBe(false);
    expect(classifyEncoreFailure(ENCORE_404_PROFILES_INDEX)).toBe('deterministic');
    expect(classifyEncoreFailure(dropped(ENCORE_404_PROFILES_INDEX))).toBe('deterministic');
    // #1058: the object genuinely is not there, so retrying would burn two
    // attempts for nothing.
    expect(classifyEncoreFailure(FFPROBE_404)).toBe('deterministic');
    expect(classifyEncoreFailure(dropped(FFPROBE_404))).toBe('deterministic');
  });

  it('does not widen to other statuses on the profiles index (#1101 out-of-scope guard)', () => {
    for (const status of [400, 404, 429, 500, 502, 503, 504]) {
      const msg = `java.io.IOException: Server returned HTTP response code: ${status} for URL: ${PROFILES_INDEX_URL}`;
      expect(classifyEncoreFailure(msg)).toBe('deterministic');
    }
  });

  it('leaves the pre-existing classes untouched', () => {
    expect(
      classifyEncoreFailure(
        'SdkClientException: Acquire operation took longer than the configured maximum time'
      )
    ).toBe('transport');
    expect(classifyEncoreFailure('Error during demuxing: I/O error')).toBe('io-retryable');
    expect(
      classifyEncoreFailure("Profile 'abr-vod' requires an audio stream but the input has none")
    ).toBe('deterministic');
    expect(classifyEncoreFailure(undefined)).toBe('deterministic');
  });
});

// ---------------------------------------------------------------------------
// Minimal in-memory Valkey fake — exactly the commands decideRetry /
// recordDispatch / clearRetryState touch. Mirrors the fakes in
// retry-policy.test.ts and reconcile-drop-retry-gate.test.ts so every file
// exercises decideRetry identically.
// ---------------------------------------------------------------------------

class FakeRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  lists = new Map<string, string[]>();

  async set(key: string, val: string): Promise<'OK'> {
    this.strings.set(key, val);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.strings.has(key) ? (this.strings.get(key) as string) : null;
  }
  async del(...args: string[]): Promise<number> {
    let n = 0;
    for (const k of args) if (this.strings.delete(k)) n++;
    return n;
  }
  async hset(key: string, field: string, val: string): Promise<number> {
    const h = this.hashes.get(key) ?? new Map<string, string>();
    const isNew = !h.has(field);
    h.set(field, val);
    this.hashes.set(key, h);
    return isNew ? 1 : 0;
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hdel(key: string, field: string): Promise<number> {
    const h = this.hashes.get(key);
    return h && h.delete(field) ? 1 : 0;
  }
  async lpush(key: string, val: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    l.unshift(val);
    this.lists.set(key, l);
    return l.length;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.lists.get(key) ?? [];
    const end = stop === -1 ? l.length - 1 : stop;
    return l.slice(start, end + 1);
  }
}

function asRedis(f: FakeRedis): Redis {
  return f as unknown as Redis;
}

const WS = 'ws1';
const PAYLOAD = { profile: 'vod-compat', inputs: [{ uri: 's3://b/k' }] };

// Drain the re-queued entry the way the scaler loop does (RPOPLPUSH + persist
// the next attempt count, scaler-loop.ts dispatch()), so the NEXT failure is
// observed against a clean queue with the attempt counter advanced. Without this
// the #743 idempotence guard would answer 'skip' on the second failure.
async function dispatchQueuedRetry(redis: FakeRedis, externalId: string): Promise<QueuedJob> {
  const entries = await redis.lrange(keys.queue(WS), 0, -1);
  expect(entries).toHaveLength(1);
  const queued = JSON.parse(entries[0]!) as QueuedJob;
  expect(queued.jobId).toBe(externalId);
  redis.lists.set(keys.queue(WS), []);
  // The loop persists `attempts + 1` on dispatch.
  await redis.set(keys.jobAttempts(externalId), String((queued.attempts ?? 0) + 1));
  return queued;
}

// ---------------------------------------------------------------------------
// Layer 3a: the CALLBACK path (encore-callback-poller.ts:552-559) — Encore's
// raw `message`, no prefix. Retries with backoff up to MAX_ENCODE_ATTEMPTS and
// then settles terminal.
// ---------------------------------------------------------------------------

describe('#1101 callback path — profiles-index 401/403 retries to the bound, then settles', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  // The acceptance criterion, for 401 and 403, on the callback path's exact
  // failure-string shape: retry with backoff up to the bound, then terminal.
  for (const [label, failureMessage] of [
    ['401', ENCORE_401_FULL],
    ['403', ENCORE_403_FULL]
  ] as const) {
    it(`${label} on the profiles index retries up to MAX_ENCODE_ATTEMPTS, then settles terminal`, async () => {
      const externalId = encodeEncoreJobId(WS, `job-cb-${label}`);
      await recordDispatch(asRedis(redis), externalId, PAYLOAD, 1);

      // Attempts 1 .. MAX-1 all re-dispatch, each with the documented backoff.
      for (let attemptsSoFar = 1; attemptsSoFar < MAX_ENCODE_ATTEMPTS; attemptsSoFar++) {
        const decision = await decideRetry(asRedis(redis), WS, externalId, failureMessage);
        expect(decision).toEqual({
          action: 'retry',
          attempt: attemptsSoFar + 1,
          failureClass: 'transport',
          backoffMs: BACKOFF_MS[Math.min(attemptsSoFar - 1, BACKOFF_MS.length - 1)]
        });
        // Non-terminal while the retry is pending: the scaler-facing status is
        // pinned back to RUNNING so the caller never sees a settled job.
        expect(await redis.hget(keys.jobStatus(WS), externalId)).toBe('RUNNING');
        const queued = await dispatchQueuedRetry(redis, externalId);
        expect(queued.notBefore).toBeGreaterThan(Date.now());
        expect(queued.payload).toEqual(PAYLOAD);
      }

      // The bound is now reached, so the next observation settles terminal and
      // fails clearly rather than retrying forever.
      const final = await decideRetry(asRedis(redis), WS, externalId, failureMessage);
      expect(final).toEqual({
        action: 'settle',
        reason: 'exhausted',
        failureClass: 'transport'
      });
      expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
    });
  }

  it('a 401 from another URL settles terminal on attempt 1 (never reaches the bound)', async () => {
    const externalId = encodeEncoreJobId(WS, 'job-cb-401-other');
    await recordDispatch(asRedis(redis), externalId, PAYLOAD, 1);

    const decision = await decideRetry(asRedis(redis), WS, externalId, ENCORE_401_OTHER_URL);

    expect(decision).toEqual({
      action: 'settle',
      reason: 'not-retryable',
      failureClass: 'deterministic'
    });
    // No re-dispatch at all, even though a payload and 2 attempts were available.
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
    expect(await redis.hget(keys.jobStatus(WS), externalId)).toBeNull();
  });

  it('a 404 stays deterministic and settles on attempt 1', async () => {
    const externalId = encodeEncoreJobId(WS, 'job-cb-404');
    await recordDispatch(asRedis(redis), externalId, PAYLOAD, 1);

    const decision = await decideRetry(
      asRedis(redis),
      WS,
      externalId,
      ENCORE_404_PROFILES_INDEX
    );

    expect(decision).toEqual({
      action: 'settle',
      reason: 'not-retryable',
      failureClass: 'deterministic'
    });
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Layer 3b: the DROP path (main.ts onJobsDropped, :1344-1500) — the SAME Encore
// message behind the `dropped by Encore: ` prefix, driven through the exact
// per-drop logic that handler runs, against the real settleFailedTranscode so
// the caller-facing job/asset/pipeline effects are asserted too.
//
// This is the path #1091 actually hit: Encore's own FAILED document message was
// recovered by reconcile() and carried on `reason` (#704).
// ---------------------------------------------------------------------------

type Repos = {
  jobs: InMemoryJobRepository;
  assets: InMemoryAssetRepository;
  pipeline: InMemoryPipelineRepository;
};

// Faithful mirror of main.ts's onJobsDropped per-drop body (:1344-1500).
async function handleDrop(
  redis: FakeRedis,
  repos: Repos,
  drop: { encoreJobId: string; reason?: string }
): Promise<{ redispatched: boolean }> {
  const { encoreJobId, reason } = drop;
  const found = await repos.jobs.findByEncoreJobId(encoreJobId);
  if (!found) return { redispatched: false };

  const failureText =
    reason && reason.trim().length > 0
      ? `dropped by Encore: ${reason}`
      : 'dropped by Encore: gone from active set with no completion';

  const decoded = decodeEncoreJobId(encoreJobId);
  const isTerminal =
    found.job.status === 'done' ||
    found.job.status === 'failed' ||
    found.job.status === 'cancelled';
  if (decoded && !isTerminal) {
    const decision = await decideRetry(
      asRedis(redis),
      decoded.workspaceId,
      encoreJobId,
      failureText
    );
    if (decision.action === 'retry' || decision.action === 'skip') {
      return { redispatched: decision.action === 'retry' };
    }
    // action:'settle' -> fall through to the terminal settle below.
  }

  await settleFailedTranscode(
    { jobs: repos.jobs, assets: repos.assets, pipeline: repos.pipeline },
    found.job,
    failureText,
    'gone-from-active-set'
  );
  if (decoded) {
    await clearRetryState(asRedis(redis), encoreJobId).catch(() => {});
  }
  return { redispatched: false };
}

// A `running` transcode over a `processing` source asset plus a running pipeline
// lock — the shape reconcile() observes when a job leaves Encore's live set.
async function runningScalerJob(repos: Repos, externalId: string) {
  const asset = await repos.assets.create({ name: 'clip.mov', objectKey: 'src/clip.mov' });
  await repos.assets.update(asset.id, { status: 'processing' });

  const job = await repos.jobs.create({
    type: 'transcode',
    assetId: asset.id,
    profile: 'vod-compat',
    encoreJobId: externalId
  });
  await repos.jobs.update(job.id, { status: 'queued' });
  await repos.jobs.update(job.id, { status: 'running', encoreInternalJobId: externalId });

  const execution = await repos.pipeline.create({
    assetId: asset.id,
    pipelineName: 'transcode',
    steps: ['transcode']
  });
  await repos.pipeline.update(execution.id, {
    steps: execution.steps.map((s) => ({ ...s, status: 'running' as const }))
  });

  return { assetId: asset.id, jobId: job.id, executionId: execution.id };
}

describe('#1101 drop path — profiles-index 401/403 retries to the bound, then settles', () => {
  let redis: FakeRedis;
  let repos: Repos;

  beforeEach(() => {
    redis = new FakeRedis();
    repos = {
      jobs: new InMemoryJobRepository(),
      assets: new InMemoryAssetRepository(),
      pipeline: new InMemoryPipelineRepository()
    };
  });

  for (const [label, reason] of [
    ['401', ENCORE_401_ELIDED],
    ['403', ENCORE_403_FULL]
  ] as const) {
    it(`${label} on the profiles index re-dispatches up to the bound, then settles terminal`, async () => {
      const externalId = encodeEncoreJobId(WS, `job-drop-${label}`);
      const { jobId, assetId, executionId } = await runningScalerJob(repos, externalId);
      await recordDispatch(asRedis(redis), externalId, PAYLOAD, 1);

      for (let attemptsSoFar = 1; attemptsSoFar < MAX_ENCODE_ATTEMPTS; attemptsSoFar++) {
        const { redispatched } = await handleDrop(redis, repos, {
          encoreJobId: externalId,
          reason
        });
        expect(redispatched).toBe(true);
        // NOT settled: the caller-facing job and its source asset stay live
        // while the retry is pending. This is the regression #1091 reported —
        // before the fix the asset was `failed` here, permanently.
        expect((await repos.jobs.get(jobId))?.status).toBe('running');
        expect((await repos.assets.get(assetId))?.status).toBe('processing');
        expect(await redis.hget(keys.jobStatus(WS), externalId)).toBe('RUNNING');
        const queued = await dispatchQueuedRetry(redis, externalId);
        expect(queued.notBefore).toBeGreaterThan(Date.now());
      }

      // Bound reached: settle terminal and fail clearly, with Encore's own cause
      // surfaced to the caller.
      const { redispatched } = await handleDrop(redis, repos, {
        encoreJobId: externalId,
        reason
      });
      expect(redispatched).toBe(false);
      expect((await repos.jobs.get(jobId))?.status).toBe('failed');
      expect((await repos.assets.get(assetId))?.status).toBe('failed');
      expect((await repos.pipeline.get(executionId))?.status).toBe('failed');
      expect((await repos.jobs.get(jobId))?.error).toContain(reason);
      // Retry bookkeeping cleared on settle; nothing left queued.
      expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
      expect(await redis.get(keys.jobPayload(externalId))).toBeNull();
      expect(await redis.get(keys.jobAttempts(externalId))).toBeNull();
    });
  }

  it('a 401 from another URL settles terminal on attempt 1', async () => {
    const externalId = encodeEncoreJobId(WS, 'job-drop-401-other');
    const { jobId, assetId } = await runningScalerJob(repos, externalId);
    await recordDispatch(asRedis(redis), externalId, PAYLOAD, 1);

    const { redispatched } = await handleDrop(redis, repos, {
      encoreJobId: externalId,
      reason: ENCORE_401_OTHER_URL
    });

    expect(redispatched).toBe(false);
    expect((await repos.jobs.get(jobId))?.status).toBe('failed');
    expect((await repos.assets.get(assetId))?.status).toBe('failed');
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
  });

  it('a 404 stays deterministic and settles on attempt 1', async () => {
    const externalId = encodeEncoreJobId(WS, 'job-drop-404');
    const { jobId } = await runningScalerJob(repos, externalId);
    await recordDispatch(asRedis(redis), externalId, PAYLOAD, 1);

    const { redispatched } = await handleDrop(redis, repos, {
      encoreJobId: externalId,
      reason: FFPROBE_404
    });

    expect(redispatched).toBe(false);
    expect((await repos.jobs.get(jobId))?.status).toBe('failed');
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
  });
});
