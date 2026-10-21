// E2E suite v1. Every path, field and enum below comes from openapi.json (v1.5.0):
//   health            GET /health                         build.{commit,sourceDigest,version}
//   ingest            POST /api/v1/assets/ingest-url      202 {assetId, jobId}
//   jobs              GET /api/v1/jobs/{id}               status: pending|queued|running|done|failed|cancelled
//   asset             GET /api/v1/assets/{id}             status, technicalMetadata, renditions, manifestUrls, packagingError, tags
//   metadata          POST /api/v1/assets/{id}/extract-metadata   200|202
//   thumbnails        GET|POST /api/v1/assets/{id}/thumbnails     {assetId, thumbnails: string[]}; POST {timecodes:number[]}
//   transcode         POST /api/v1/assets/{id}/transcode  202 {jobId, encoreJobId}
//   package           POST /api/v1/assets/{id}/package    202 {ok, jobId}
//   search            GET /api/v1/search/                 {assets[], total, page, ...}
//   patch/delete      PATCH /api/v1/assets/{id}; DELETE /api/v1/assets/{id}?force=true  204
import { poll, PollTimeout } from '../lib/poll.mjs';

export const SUITE_VERSION = 'v1';

/**
 * A case failure. `observed` carries structured facts the verdict should keep (see `runSuite`, which copies it
 * into the case result as `observed`).
 */
class CaseFailure extends Error {
  constructor(message, observed) { super(message); if (observed) this.observed = observed; }
}
/** A failure caused by the platform, not by the image under test: the suite ends `infra-error`, which is not final. */
class InfraFailure extends CaseFailure {}
const fail = (msg, observed) => { throw new CaseFailure(msg, observed); };
const infraFail = (msg, observed) => { throw new InfraFailure(msg, observed); };
const expectStatus = (res, ...codes) => {
  if (!codes.includes(res.status)) fail(`expected HTTP ${codes.join('/')}, got ${res.status}: ${res.text.slice(0, 300)}`);
};
const TERMINAL_JOB = new Set(['done', 'failed', 'cancelled']);
/** The states a job has not started work in yet (openapi.json GET /api/v1/jobs/{id} status enum). */
const INITIAL_JOB = new Set(['pending', 'queued']);
/**
 * Gateway answers that mean a dependency, not the code, is unreachable. On POST /api/v1/assets/{id}/transcode
 * openapi.json v1.5.0 documents **504** as `{error: "dependency_unreachable", dependency: "queue"|"encore"|"storage",
 * endpoint, message}` — `dependency` is 504's alone — and **502** as the generic `{error, message}`. **503** is not
 * documented at all: it comes from the platform ingress answering for the instance (an HTML page, not JSON) before
 * the application is reached. GET /api/v1/jobs/{id} documents only 200 and 404, so any of the three on a job read is
 * the ingress as well.
 */
const GATEWAY_STATUS = new Set([502, 503, 504]);
/** How many job reads in a row may go unanswered before the wait is given up as a platform failure. */
const MAX_CONSECUTIVE_READ_ERRORS = 3;

/**
 * The job reports an infrastructure interruption, not a media failure. openapi.json v1.5.0 GET /api/v1/jobs/{id}:
 * `interrupted` is "True when the job was interrupted by an infrastructure/topology event (not a media failure) and
 * is being auto-retried. The job stays `running` — it is NOT reported as `failed`", and `interruptionReason`
 * (`interrupted_by_scaledown`) is "RECOVERABLE and typically AUTO-RETRIED by the service". Never a verdict on the
 * encode, so never red (#1248).
 */
const isInterrupted = (seen) => seen.interrupted === true || Boolean(seen.interruptionReason);

/** What the last look at a job says it was doing, in the words the verdict should use. */
function jobPhase(seen) {
  if (seen.status === undefined) return 'never read';
  if (TERMINAL_JOB.has(seen.status)) return seen.status;
  // An interrupted job is neither working nor stalled: the work was lost to a topology event and the service is
  // retrying it, so it gets its own word rather than being read as a slow or stuck encode.
  if (isInterrupted(seen)) return 'interrupted';
  if (INITIAL_JOB.has(seen.status)) return 'queued';
  return seen.maxProgress > 0 ? 'running' : 'stalled';
}
/** The structured facts a transcode failure keeps in the verdict, plus a sentence for the detail text. */
function jobObserved(seen, extra = {}) {
  const phase = jobPhase(seen);
  const observed = {
    jobStatus: seen.status ?? null, progress: seen.progress ?? null, maxProgress: seen.maxProgress, phase, polls: seen.polls,
    ...(seen.attempts !== undefined && { attempts: seen.attempts }),
    ...(seen.interrupted !== undefined && { interrupted: seen.interrupted }),
    ...(seen.interruptionReason !== undefined && { interruptionReason: seen.interruptionReason }),
    ...(seen.readErrors !== undefined && { readErrors: seen.readErrors, lastReadError: seen.lastReadError }),
    ...extra,
  };
  const says = `last job status ${observed.jobStatus ?? 'never read'}, progress ${observed.progress ?? 'none'} (${phase})`
    + (isInterrupted(observed) ? `, interrupted${observed.interruptionReason ? ` (${observed.interruptionReason})` : ''}` : '')
    + (observed.readErrors ? `, ${observed.readErrors} unanswered read${observed.readErrors === 1 ? '' : 's'} (${observed.lastReadError})` : '');
  return { observed, says };
}

/**
 * Poll a job to a terminal state; fails unless it ends `done`.
 * @param {object} [seen] filled in with the last body seen ({status, progress, maxProgress, polls, ...}), so a
 *   timeout can say whether the job was queued, running or stalled.
 */
async function waitForJob(ctx, jobId, timeoutMs, what, seen) {
  const job = await poll(async () => {
    let r;
    try {
      r = await ctx.client.request('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}`);
    } catch (e) {
      // Not an answer at all: a dropped connection (`TypeError: fetch failed`), a TLS failure, or the AbortError from
      // the per-request budget (lib/http.mjs `timeoutMs`). None of them says anything about the encode, and `poll`
      // does not catch for us — so for the cases that ask for `seen` one blip does not end a 900 s wait: keep
      // polling and give up, as a platform failure, only after MAX_CONSECUTIVE_READ_ERRORS reads in a row go
      // unanswered. Elsewhere the error propagates as before.
      if (!seen) throw e;
      seen.readErrors = (seen.readErrors ?? 0) + 1;
      seen.consecutiveReadErrors = (seen.consecutiveReadErrors ?? 0) + 1;
      seen.lastReadError = `${e?.name}: ${e?.message}`;
      if (seen.consecutiveReadErrors >= MAX_CONSECUTIVE_READ_ERRORS) {
        infraFail(`reading ${what} went unanswered ${seen.consecutiveReadErrors} times in a row: ${seen.lastReadError}`,
          jobObserved(seen, { request: 'job-status' }).observed);
      }
      return undefined; // a transient read error: try again on the next tick, within the same budget
    }
    if (seen) seen.consecutiveReadErrors = 0;
    // Only the cases that ask for `seen` (the transcode case) classify a gateway answer as the platform's doing;
    // elsewhere a non-200 on the job read stays a plain case failure, as before.
    if (seen && GATEWAY_STATUS.has(r.status)) {
      infraFail(`reading ${what} answered HTTP ${r.status}: ${r.text.slice(0, 200)}`, { httpStatus: r.status, request: 'job-status' });
    }
    expectStatus(r, 200);
    if (seen && r.body) {
      // Field names from openapi.json GET /api/v1/jobs/{id}: status, progress, attempts, interrupted, interruptionReason.
      seen.polls = (seen.polls ?? 0) + 1;
      seen.status = r.body.status;
      seen.progress = r.body.progress;
      seen.maxProgress = Math.max(seen.maxProgress ?? 0, Number(r.body.progress) || 0);
      seen.attempts = r.body.attempts;
      if (r.body.interrupted !== undefined) seen.interrupted = r.body.interrupted;
      if (r.body.interruptionReason !== undefined) seen.interruptionReason = r.body.interruptionReason;
    }
    return TERMINAL_JOB.has(r.body?.status) ? r.body : undefined;
  }, { timeoutMs, intervalMs: ctx.config.pollMs, sleep: ctx.sleep, now: ctx.now, what });
  if (job.status !== 'done') fail(`${what} ended ${job.status}${job.error ? `: ${String(job.error).slice(0, 300)}` : ''}`);
  return job;
}

async function getAsset(ctx) {
  const r = await ctx.client.request('GET', `/api/v1/assets/${encodeURIComponent(ctx.state.assetId)}`);
  expectStatus(r, 200);
  return r.body;
}

/** Cases 3-8 share one asset: a failure in one marks the rest `skipped`. */
export const cases = [
  {
    id: 'health',
    async run(ctx) {
      // /health sits behind the same ingress wall as everything else, so this call is authenticated.
      const r = await ctx.client.request('GET', '/health');
      expectStatus(r, 200);
      const build = r.body?.build;
      if (!build) fail('GET /health has no build object');
      ctx.state.build = { commit: build.commit, sourceDigest: build.sourceDigest, version: build.version };
      // The platform builds the image without git metadata, so build.commit is normally "unknown"; it is only checked
      // when the build does report one.
      if (ctx.config.expectCommit && build.commit && build.commit !== 'unknown' && build.commit !== ctx.config.expectCommit) {
        fail(`instance runs ${build.commit}, expected ${ctx.config.expectCommit}`);
      }
    },
  },
  {
    id: 'auth-required',
    async run(ctx) {
      // Through the platform ingress this is answered by the login wall (nginx), not by the application: it only
      // proves the instance is not publicly open. The application's own gate is the next case.
      const r = await ctx.anon.request('GET', '/api/v1/assets/');
      expectStatus(r, 401);
    },
  },
  {
    id: 'app-auth-required',
    async run(ctx) {
      // x-jwt gets past the wall; without Authorization the application itself must reject (regression guard for
      // #711, the auth gate returning 401). The message proves the answer came from the application, not nginx.
      const r = await ctx.ingress.request('GET', '/api/v1/assets/');
      expectStatus(r, 401);
      if (r.body?.error !== 'unauthorized') fail(`401 did not come from the application: ${r.text.slice(0, 200)}`);
    },
  },
  {
    id: 'auth-accepted',
    async run(ctx) {
      expectStatus(await ctx.client.request('GET', '/api/v1/assets/'), 200);
    },
  },
  {
    id: 'ingest-url',
    chain: true,
    async run(ctx) {
      const title = `e2e-${ctx.config.runId}`;
      const r = await ctx.client.request('POST', '/api/v1/assets/ingest-url', {
        json: { sourceUrl: ctx.config.sourceUrl, title },
      });
      expectStatus(r, 202);
      if (!r.body?.assetId || !r.body?.jobId) fail('202 response lacks assetId/jobId');
      ctx.state.assetId = r.body.assetId; // recorded first so teardown can still delete it
      ctx.state.title = title;
      await waitForJob(ctx, r.body.jobId, ctx.config.timeouts.ingestMs, 'ingest job');
      // The ingest job finishing does not make the asset ready: a detached metadata extraction (an ffprobe job, which
      // may have to start its service first) advances `processing` -> `ready` (src/pipeline/metadata-extractor.ts),
      // or records technicalMetadataError and leaves it in `processing`. Wait for either outcome.
      const asset = await poll(async () => {
        const a = await getAsset(ctx);
        return a.status === 'ready' || a.status === 'failed' || a.technicalMetadataError ? a : undefined;
      }, { timeoutMs: ctx.config.timeouts.readyMs, intervalMs: ctx.config.pollMs, sleep: ctx.sleep, now: ctx.now, what: `asset ${ctx.state.assetId} to leave processing` });
      if (asset.technicalMetadataError) fail(`metadata extraction failed: ${String(asset.technicalMetadataError).slice(0, 300)}`);
      if (asset.status !== 'ready') fail(`asset status is ${asset.status}, expected ready`);
    },
  },
  {
    id: 'metadata',
    chain: true,
    async run(ctx) {
      let asset = await getAsset(ctx);
      if (!asset.technicalMetadata) {
        expectStatus(await ctx.client.request('POST', `/api/v1/assets/${ctx.state.assetId}/extract-metadata`), 200, 202);
        asset = await poll(async () => {
          const a = await getAsset(ctx);
          return a.technicalMetadata || a.technicalMetadataError ? a : undefined;
        }, { timeoutMs: ctx.config.timeouts.metadataMs, intervalMs: ctx.config.pollMs, sleep: ctx.sleep, now: ctx.now, what: 'technicalMetadata' });
      }
      if (asset.technicalMetadataError) fail(`technicalMetadataError: ${String(asset.technicalMetadataError).slice(0, 300)}`);
      const m = asset.technicalMetadata;
      if (!m?.codec || !(m.width > 0) || !(m.height > 0) || !(m.durationSeconds > 0)) {
        fail(`technicalMetadata incomplete: ${JSON.stringify(m)}`);
      }
    },
  },
  {
    id: 'thumbnails',
    chain: true,
    async run(ctx) {
      const path = `/api/v1/assets/${ctx.state.assetId}/thumbnails`;
      let r = await ctx.client.request('GET', path);
      expectStatus(r, 200);
      if (!r.body?.thumbnails?.length) {
        r = await ctx.client.request('POST', path, { json: { timecodes: [0] } });
        expectStatus(r, 200);
      }
      if (!Array.isArray(r.body?.thumbnails) || r.body.thumbnails.length === 0) fail('no thumbnails after generation');
    },
  },
  {
    id: 'transcode',
    chain: true,
    async run(ctx) {
      // Use a NAMED profile whose output the packager can package. The first runnable profile in the list is
      // `archive` (DNxHD video + 24-bit PCM audio in MXF), which Shaka Packager rejects with "Failed to detect the
      // container type" (seen 2026-10-09 in the packager log), so the package case then waits for manifest URLs that never
      // come. `program` is the standard x264 profile. Inline `customProfile.outputs` is rejected by the product
      // (open-videocore #1022), so there is no custom fallback.
      //
      // Platform failures here are classed `infra-error`, not red (#1248): a 502/503/504 on the transcode request or
      // on a read of its job; reads that go unanswered (a dropped connection, a TLS failure) for
      // MAX_CONSECUTIVE_READ_ERRORS ticks in a row, or any error that breaks the wait itself; and a timeout while the
      // job was interrupted by the platform or never left `pending`/`queued`. A job that ends `failed`, a
      // non-interrupted job that ran and stopped progressing, and a job that finishes with no renditions stay RED —
      // those are the product's own verdict on the encode (regression guard for #1167).
      const wanted = ctx.config.transcodeProfile ?? 'program';
      const list = await ctx.client.request('GET', '/api/v1/profiles/');
      expectStatus(list, 200);
      const names = new Set([...(list.body?.profiles ?? []), ...(list.body?.items ?? []).map((p) => p.name)]);
      if (!names.has(wanted)) fail(`transcode profile "${wanted}" is not on the instance; available: ${[...names].slice(0, 20).join(', ') || 'none'}`);
      const json = { profile: wanted };
      const r = await ctx.client.request('POST', `/api/v1/assets/${ctx.state.assetId}/transcode`, { json });
      if (GATEWAY_STATUS.has(r.status)) {
        // 504 carries {error: "dependency_unreachable", dependency} when it comes from the application; the ingress
        // answers with an HTML page and no body at all, so both are reported from what is there.
        const dep = r.body?.dependency ? ` (dependency ${r.body.dependency})` : '';
        infraFail(`transcode request answered HTTP ${r.status}${dep}: ${r.text.slice(0, 200)}`,
          { httpStatus: r.status, ...(r.body?.dependency && { dependency: r.body.dependency }), ...(r.body?.error && { error: r.body.error }) });
      }
      expectStatus(r, 202);
      if (!r.body?.jobId) fail('202 response lacks jobId');
      ctx.state.encoreJobId = r.body.encoreJobId;
      const seen = { maxProgress: 0, polls: 0 };
      let job;
      try {
        job = await waitForJob(ctx, r.body.jobId, ctx.config.timeouts.transcodeMs, 'transcode job', seen);
      } catch (e) {
        const { observed, says } = jobObserved(seen);
        // Already classified inside waitForJob: a terminal failed/cancelled job is red; a gateway answer on the job
        // read, or reads that went unanswered MAX_CONSECUTIVE_READ_ERRORS times in a row, are infra. Either way the
        // verdict gets what the last look at the job saw.
        if (e instanceof CaseFailure) { e.observed ??= observed; e.message = `${e.message} [${says}]`; throw e; }
        const msg = `${String(e?.message)}; ${says}`;
        // Not the budget running out: the wait itself broke (a transport or TLS error, the AbortError from the
        // per-request budget in lib/http.mjs). That is the platform whatever the job was last seen doing — an
        // unreachable instance is no evidence about the encode.
        if (!(e instanceof PollTimeout)) infraFail(`${e?.name}: ${msg}`, observed);
        // The budget ran out. Infrastructure, not the image: a job the product itself reports as interrupted by a
        // topology event and auto-retried (see isInterrupted), and a job nothing ever picked up.
        if (isInterrupted(observed)) infraFail(msg, observed);
        if (observed.phase === 'queued' || observed.phase === 'never read') infraFail(msg, observed);
        fail(msg, observed); // a job that was not interrupted, did run and stopped progressing: the image's, red
      }
      const asset = await getAsset(ctx);
      if (!asset.renditions?.length && !job.renditionAssetIds?.length) {
        const { observed, says } = jobObserved(seen);
        fail(`no renditions after transcode; ${says}`, observed);
      }
    },
  },
  {
    id: 'package',
    chain: true,
    async run(ctx) {
      const r = await ctx.client.request('POST', `/api/v1/assets/${ctx.state.assetId}/package`, {
        json: ctx.state.encoreJobId ? { encoreJobId: ctx.state.encoreJobId } : {},
      });
      expectStatus(r, 202);
      if (r.body?.ok !== true) fail('202 response is not {ok:true}');
      ctx.state.packageJobId = r.body.jobId;
      const explain = async (why) => {
        // Say what the product knows when packaging does not complete: the package job's state and error.
        let extra = '';
        if (ctx.state.packageJobId) {
          const j = await ctx.client.request('GET', `/api/v1/jobs/${encodeURIComponent(ctx.state.packageJobId)}`);
          if (j.status === 200) extra = `; package job is ${j.body?.status}${j.body?.error ? `: ${String(j.body.error).slice(0, 200)}` : ''}`;
        }
        fail(`${why}${extra}`);
      };
      if (r.body.jobId) {
        try { await waitForJob(ctx, r.body.jobId, ctx.config.timeouts.packageMs, 'package job'); } catch (e) {
          if (e instanceof CaseFailure) throw e;
          await explain(String(e.message));
        }
      }
      let asset;
      try {
        asset = await poll(async () => {
          const a = await getAsset(ctx);
          return a.packagingError || a.manifestUrls?.hls || a.manifestUrls?.dash ? a : undefined;
        }, { timeoutMs: ctx.config.timeouts.packageMs, intervalMs: ctx.config.pollMs, sleep: ctx.sleep, now: ctx.now, what: 'manifestUrls' });
      } catch (e) { await explain(String(e.message)); }
      if (asset.packagingError) fail(`packagingError: ${String(asset.packagingError).slice(0, 300)}`);
    },
  },
  {
    id: 'search',
    chain: true,
    async run(ctx) {
      const found = await poll(async () => {
        const r = await ctx.client.request('GET', '/api/v1/search/', { query: { q: ctx.state.title } });
        expectStatus(r, 200);
        return r.body?.assets?.some((a) => a.id === ctx.state.assetId) ? true : undefined;
      }, { timeoutMs: ctx.config.timeouts.searchMs, intervalMs: ctx.config.pollMs, sleep: ctx.sleep, now: ctx.now, what: 'asset in search results' });
      if (!found) fail('asset not found by search');
    },
  },
  {
    id: 'tags-roundtrip',
    chain: true,
    async run(ctx) {
      const tag = `e2e-${ctx.config.runId}`;
      expectStatus(await ctx.client.request('PATCH', `/api/v1/assets/${ctx.state.assetId}`, { json: { tags: [tag] } }), 200);
      const asset = await getAsset(ctx);
      if (!asset.tags?.includes(tag)) fail(`tag not persisted: ${JSON.stringify(asset.tags)}`);
    },
  },
  {
    id: 'delete',
    chain: true,
    async run(ctx) {
      expectStatus(await ctx.client.request('DELETE', `/api/v1/assets/${ctx.state.assetId}`, { query: { force: 'true' } }), 204);
      ctx.state.deleted = true;
      // DELETE is a SOFT delete (src/routes/assets.ts header: status -> archived; `force` only bypasses the delete lock).
      // The asset stays readable as `archived` until the purge sweep tombstones it, after which a read returns 410 (404
      // for a slug); a purged or never-existing asset reads 404/410.
      const r = await ctx.client.request('GET', `/api/v1/assets/${ctx.state.assetId}`);
      if (r.status === 200) {
        if (r.body?.status !== 'archived') fail(`asset still reads as ${r.body?.status} after DELETE, expected archived`);
      } else expectStatus(r, 404, 410);
    },
  },
];

export { CaseFailure, InfraFailure };
