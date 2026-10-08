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
      const r = await ctx.anon.request('GET', '/health');
      expectStatus(r, 200);
      const build = r.body?.build;
      if (!build?.commit) fail('GET /health has no build.commit');
      ctx.state.build = { commit: build.commit, sourceDigest: build.sourceDigest, version: build.version };
      if (ctx.config.expectCommit && build.commit !== ctx.config.expectCommit) {
        fail(`instance runs ${build.commit}, expected ${ctx.config.expectCommit}`);
      }
    },
  },
  {
    id: 'auth-required',
    async run(ctx) {
      const r = await ctx.anon.request('GET', '/api/v1/assets/');
      expectStatus(r, 401); // regression guard for #711: the auth gate must reject anonymous reads
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
      const asset = await getAsset(ctx);
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
      const list = await ctx.client.request('GET', '/api/v1/profiles/');
      expectStatus(list, 200);
      const runnable = (list.body?.items ?? []).find((p) => p.runnable)?.name ?? list.body?.profiles?.[0];
      const json = runnable
        ? { profile: runnable }
        : { customProfile: { name: `e2e-${ctx.config.runId}`, outputs: [{ label: '360p', width: 640, height: 360, videoBitrateBps: 800_000, audioBitrateBps: 64_000, format: 'mp4' }] } };
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
      if (r.body.jobId) await waitForJob(ctx, r.body.jobId, ctx.config.timeouts.packageMs, 'package job');
      const asset = await poll(async () => {
        const a = await getAsset(ctx);
        return a.packagingError || a.manifestUrls?.hls || a.manifestUrls?.dash ? a : undefined;
      }, { timeoutMs: ctx.config.timeouts.packageMs, intervalMs: ctx.config.pollMs, sleep: ctx.sleep, now: ctx.now, what: 'manifestUrls' });
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
