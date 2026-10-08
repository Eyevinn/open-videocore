// In-memory stand-in for an open-videocore instance, limited to the endpoints the suite uses.
// Response shapes follow openapi.json v1.5.0. It proves the suite's logic; it does not prove the real
// service behaves this way, only a live run does.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export function startMock({ token = 'tok', commit = 'abc1234', sourceDigest = 'sd0000000000dead', faults = {} } = {}) {
  const assets = new Map();
  const jobs = new Map();
  const calls = [];
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
      if (!faults.ingestJobFails) assets.get(id).status = 'ready';
      return json(res, 202, { assetId: id, jobId });
    }
    if (req.method === 'GET' && (x = m(/^\/api\/v1\/jobs\/([^/]+)$/))) {
      const j = jobs.get(x[1]); return j ? json(res, 200, j) : json(res, 404, {});
    }
    if ((x = m(/^\/api\/v1\/assets\/([^/]+)(\/.*)?$/))) {
      const a = assets.get(x[1]); const sub = x[2] ?? '';
      if (!a) return json(res, 404, {});
      if (req.method === 'GET' && sub === '') return json(res, 200, a);
      if (req.method === 'PATCH' && sub === '') { Object.assign(a, { tags: body.tags ?? a.tags }); return json(res, 200, a); }
      if (req.method === 'DELETE' && sub === '') { assets.delete(a.id); return json(res, 204); }
      if (req.method === 'POST' && sub === '/extract-metadata') { a.technicalMetadata = { codec: 'h264', width: 1280, height: 720, durationSeconds: 5, bitrateBps: 1e6, containerFormat: 'mp4', audioTracks: [], extractedAt: 'now' }; return json(res, 202, {}); }
      if (sub === '/thumbnails') {
        if (req.method === 'GET') return json(res, 200, { assetId: a.id, thumbnails: a.thumbnails ?? [] });
        a.thumbnails = ['thumb0.jpg']; return json(res, 200, { assetId: a.id, thumbnails: a.thumbnails });
      }
      if (req.method === 'POST' && sub === '/transcode') {
        const jobId = randomUUID(); jobs.set(jobId, { id: jobId, type: 'transcode', assetId: a.id, status: 'done', encoreJobId: 'enc1' });
        a.renditions = [{ id: 'r1', label: '360p', width: 640, height: 360, objectKey: 'k' }];
        return json(res, 202, { jobId, encoreJobId: 'enc1' });
      }
      if (req.method === 'POST' && sub === '/package') {
        const jobId = randomUUID(); jobs.set(jobId, { id: jobId, type: 'package', assetId: a.id, status: 'done' });
        if (faults.packagingError) a.packagingError = 'packager failed'; else a.manifestUrls = { hls: 'http://x/master.m3u8' };
        return json(res, 202, { ok: true, jobId });
      }
    }
    if (req.method === 'GET' && p === '/api/v1/search/') {
      const q = url.searchParams.get('q');
      const hits = faults.searchEmpty ? [] : [...assets.values()].filter((a) => a.name === q);
      return json(res, 200, { assets: hits, collections: [], collectionTotal: 0, page: 1, total: hits.length });
    }
    if (req.method === 'GET' && p === '/api/v1/profiles/') return json(res, 200, { profiles: ['default'], items: [{ name: 'default', yaml: '', runnable: true, createdAt: 'a', updatedAt: 'b' }] });
    return json(res, 404, { error: 'not found', p });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}`, token, assets, calls, seed, close: () => new Promise((r) => server.close(r)),
  })));
}
