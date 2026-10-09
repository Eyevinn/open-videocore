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
import { poll } from '../lib/poll.mjs';

export const SUITE_VERSION = 'v1';

class CaseFailure extends Error {}
const fail = (msg) => { throw new CaseFailure(msg); };
const expectStatus = (res, ...codes) => {
  if (!codes.includes(res.status)) fail(`expected HTTP ${codes.join('/')}, got ${res.status}: ${res.text.slice(0, 300)}`);
};
const TERMINAL_JOB = new Set(['done', 'failed', 'cancelled']);

/** Poll a job to a terminal state; fails unless it ends `done`. */
async function waitForJob(ctx, jobId, timeoutMs, what) {
  const job = await poll(async () => {
    const r = await ctx.client.request('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}`);
    expectStatus(r, 200);
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
      const wanted = ctx.config.transcodeProfile ?? 'program';
      const list = await ctx.client.request('GET', '/api/v1/profiles/');
      expectStatus(list, 200);
      const names = new Set([...(list.body?.profiles ?? []), ...(list.body?.items ?? []).map((p) => p.name)]);
      if (!names.has(wanted)) fail(`transcode profile "${wanted}" is not on the instance; available: ${[...names].slice(0, 20).join(', ') || 'none'}`);
      const json = { profile: wanted };
      const r = await ctx.client.request('POST', `/api/v1/assets/${ctx.state.assetId}/transcode`, { json });
      expectStatus(r, 202);
      if (!r.body?.jobId) fail('202 response lacks jobId');
      ctx.state.encoreJobId = r.body.encoreJobId;
      const job = await waitForJob(ctx, r.body.jobId, ctx.config.timeouts.transcodeMs, 'transcode job');
      const asset = await getAsset(ctx);
      if (!asset.renditions?.length && !job.renditionAssetIds?.length) fail('no renditions after transcode');
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
      expectStatus(await ctx.client.request('GET', `/api/v1/assets/${ctx.state.assetId}`), 404, 410);
    },
  },
];

export { CaseFailure };
