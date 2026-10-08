// Delete assets a crashed earlier run left behind: name starts with "e2e-" and older than maxAgeMs.
// Contract: GET /api/v1/assets/ -> {items[{id,name,createdAt}], limit, offset, total} with limit/offset query;
// DELETE /api/v1/assets/{id}?force=true -> 204. The runner owns its own instance, so only test data can match.
export async function sweepLeftovers({ client, now = Date.now, maxAgeMs = 60 * 60_000, pageSize = 100, maxPages = 20 }) {
  // Collect first, delete after: deleting while paging by offset shifts the list and skips items.
  const stale = [];
  for (let page = 0, offset = 0; page < maxPages; page++, offset += pageSize) {
    const r = await client.request('GET', '/api/v1/assets/', { query: { limit: pageSize, offset } });
    if (r.status !== 200 || !Array.isArray(r.body?.items)) break;
    for (const a of r.body.items) {
      if (typeof a.name === 'string' && a.name.startsWith('e2e-') && now() - Date.parse(a.createdAt) > maxAgeMs) stale.push(a.id);
    }
    if (offset + pageSize >= (r.body.total ?? 0)) break;
  }
  let deleted = 0;
  for (const id of stale) {
    const d = await client.request('DELETE', `/api/v1/assets/${encodeURIComponent(id)}`, { query: { force: 'true' } });
    if (d.status === 204) deleted++;
  }
  return deleted;
}
