// In-memory stand-in for an open-videocore instance, limited to the endpoints the suite uses.
// Response shapes follow openapi.json v1.5.0. It proves the suite's logic; it does not prove the real
// service behaves this way, only a live run does.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export function startMock({ token = 'tok', commit = 'abc1234', sourceDigest = 'sd0000000000dead', faults = {} } = {}) {
  const assets = new Map();
  const jobs = new Map();
  const calls = [];
  let transcodeJobReads = 0;
  const seed = (a) => assets.set(a.id, { tags: [], renditions: [], status: 'ready', ...a });
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push(`${req.method} ${url.pathname}`);
    const p = url.pathname;
    // Like the platform ingress: every path, /health included, needs x-jwt: Bearer <token>.
    if (!faults.openAuth && req.headers['x-jwt'] !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' });
    if (p.startsWith('/api/') && !faults.appOpen && !/^Bearer\s+\S+/.test(req.headers.authorization ?? '')) return json(res, 401, { error: 'unauthorized', message: 'missing access token' });
    if (p === '/health') return json(res, 200, { status: 'ok', service: 'open-videocore-api', build: { version: '1.5.0', commit, sourceDigest, builtAt: null, packageVersion: '1.5.0' } });
    const m = (re) => p.match(re);
    let x;
    if (req.method === 'GET' && p === '/api/v1/assets/') {
      const all = [...assets.values()]; const limit = Number(url.searchParams.get('limit') ?? 50); const offset = Number(url.searchParams.get('offset') ?? 0);
      return json(res, 200, { items: all.slice(offset, offset + limit), limit, offset, total: all.length });
    }
    if (req.method === 'POST' && p === '/api/v1/assets/ingest-url') {
      const id = randomUUID(); const jobId = randomUUID();
      assets.set(id, { id, name: body.title, status: 'processing', tags: [], renditions: [], createdAt: new Date().toISOString() });
      jobs.set(jobId, { id: jobId, type: 'ingest-url', assetId: id, status: faults.ingestJobFails ? 'failed' : 'done', error: faults.ingestJobFails ? 'download failed' : undefined });
      if (!faults.ingestJobFails) assets.get(id).status = faults.slowReady ? 'processing' : 'ready';
      if (faults.slowReady) assets.get(id).readyAfter = faults.slowReady;
      return json(res, 202, { assetId: id, jobId });
    }
    if (req.method === 'GET' && (x = m(/^\/api\/v1\/jobs\/([^/]+)$/))) {
      const j = jobs.get(x[1]);
      // A gateway answer while a transcode job is polled: the platform, not the application.
      if (j?.type === 'transcode' && faults.transcodeJobGateway) return json(res, Number(faults.transcodeJobGateway), { error: 'dependency_unreachable', dependency: 'queue', message: 'queue did not answer' });
      // No answer at all: the connection is dropped, which is what a TLS failure or a vanished ingress looks like to
      // `fetch` (TypeError: fetch failed). `transcodeJobReadsOk` reads are answered first, then
      // `transcodeJobDropReads` of them are dropped, after which reads are answered again.
      if (j?.type === 'transcode' && faults.transcodeJobDropReads) {
        transcodeJobReads += 1;
        const okFirst = Number(faults.transcodeJobReadsOk ?? 0);
        if (transcodeJobReads > okFirst && transcodeJobReads <= okFirst + Number(faults.transcodeJobDropReads)) {
          return req.socket.destroy();
        }
      }
      return j ? json(res, 200, j) : json(res, 404, {});
    }
    if ((x = m(/^\/api\/v1\/assets\/([^/]+)(\/.*)?$/))) {
      const a = assets.get(x[1]); const sub = x[2] ?? '';
      if (!a) return json(res, 404, {});
      if (req.method === 'GET' && sub === '') {
        if (a.readyAfter !== undefined && a.status === 'processing' && --a.readyAfter <= 0) { a.status = faults.extractionError ? 'processing' : 'ready'; if (faults.extractionError) a.technicalMetadataError = 'ffprobe failed'; }
        return json(res, 200, a);
      }
      if (req.method === 'PATCH' && sub === '') { Object.assign(a, { tags: body.tags ?? a.tags }); return json(res, 200, a); }
      if (req.method === 'DELETE' && sub === '') { if (faults.hardDelete) assets.delete(a.id); else a.status = 'archived'; return json(res, 204); }
      if (req.method === 'POST' && sub === '/extract-metadata') { a.technicalMetadata = { codec: 'h264', width: 1280, height: 720, durationSeconds: 5, bitrateBps: 1e6, containerFormat: 'mp4', audioTracks: [], extractedAt: 'now' }; return json(res, 202, {}); }
      if (sub === '/thumbnails') {
        if (req.method === 'GET') return json(res, 200, { assetId: a.id, thumbnails: a.thumbnails ?? [] });
        a.thumbnails = ['thumb0.jpg']; return json(res, 200, { assetId: a.id, thumbnails: a.thumbnails });
      }
      if (req.method === 'POST' && sub === '/transcode') {
        calls.push(`PROFILE ${body.profile}`);
        // A gateway answer: the application documents 502/504 as {error: dependency_unreachable, dependency}
        // (openapi.json), the platform ingress answers with an HTML page and no JSON at all.
        if (faults.transcodeGateway) {
          const code = Number(faults.transcodeGateway);
          if (faults.transcodeGatewayHtml) { res.writeHead(code, { 'content-type': 'text/html' }); return res.end('<html><head><title>504 Gateway Time-out</title></head><body>504</body></html>'); }
          return json(res, code, { error: faults.transcodeGatewayError ?? 'dependency_unreachable', dependency: 'encore', endpoint: 'http://encore/encoreJobs', message: 'encore did not answer' });
        }
        const jobId = randomUUID();
        // faults.transcodeJobStatus keeps the job in a non-terminal state for ever: 'queued' is the platform never
        // picking the job up, 'running' with no progress is a stalled encode.
        const stuck = faults.transcodeJobStatus;
        const job = { id: jobId, type: 'transcode', assetId: a.id, sourceUrl: 'http://fixture/clip.mp4', attempts: 1, progress: 0, bytesTransferred: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), encoreJobId: 'enc1', status: stuck ?? (faults.transcodeJobFails ? 'failed' : 'done') };
        if (job.status === 'failed') job.error = 'encore job failed: no suitable encoder for the input';
        if (job.status === 'done') { job.progress = 100; job.renditionAssetIds = faults.noRenditions ? [] : ['ra1']; }
        if (stuck === 'running' && faults.transcodeProgress) job.progress = faults.transcodeProgress;
        // openapi.json v1.5.0 GET /api/v1/jobs/{id}: an interrupted job stays `running` (it is NOT reported failed)
        // and carries interruptionReason `interrupted_by_scaledown`.
        if (faults.transcodeJobInterrupted) { job.interrupted = true; job.interruptionReason = 'interrupted_by_scaledown'; }
        jobs.set(jobId, job);
        if (job.status === 'done' && !faults.noRenditions) a.renditions = [{ id: 'r1', label: '360p', width: 640, height: 360, objectKey: 'k' }];
        return json(res, 202, { jobId, encoreJobId: 'enc1' });
      }
      if (req.method === 'POST' && sub === '/package') {
        const jobId = randomUUID(); jobs.set(jobId, { id: jobId, type: 'package', assetId: a.id, status: faults.silentPackager ? 'running' : 'done' });
        if (faults.silentPackager) { /* the packager failed and never called back: no manifestUrls, no packagingError */ }
        else if (faults.packagingError) a.packagingError = 'packager failed'; else a.manifestUrls = { hls: 'http://x/master.m3u8' };
        return json(res, 202, { ok: true, jobId });
      }
    }
    if (req.method === 'GET' && p === '/api/v1/search/') {
      const q = url.searchParams.get('q');
      const hits = faults.searchEmpty ? [] : [...assets.values()].filter((a) => a.name === q);
      return json(res, 200, { assets: hits, collections: [], collectionTotal: 0, page: 1, total: hits.length });
    }
    if (req.method === 'GET' && p === '/api/v1/profiles/') {
      const names = faults.noProgramProfile ? ['archive'] : ['archive', 'program']; // `archive` first, as on the real instance
      return json(res, 200, { profiles: names, items: names.map((name) => ({ name, yaml: '', runnable: true, createdAt: 'a', updatedAt: 'b' })) });
    }
    return json(res, 404, { error: 'not found', p });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}`, token, assets, calls, seed, close: () => new Promise((r) => server.close(r)),
  })));
}
