// Tests for GET /api/v1/logs (issue #473).
//
// Builds the logsRouter over a real in-memory LogStore, exactly as
// provision.deprovision.test.ts builds provisionRouter over a real
// OperationStore, and drives it with app.inject(). Covers the acceptance
// criteria: cursor paging with NO offset drift on newly appended entries,
// newest-first default + reversal, and from/to/q server-side filtering.

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';
import { logsRouter } from './logs.js';
import { LogStore, LOG_STORE_MAX_RECORDS } from '../services/log-store.js';
import { registerAuth } from '../auth/middleware.js';

async function buildApp(logStore: LogStore) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(logsRouter, { prefix: '/api/v1/logs', logStore });
  await app.ready();
  return app;
}

type LogItem = {
  seq: number;
  timestamp: string;
  message: string;
  level?: string;
  category?: string;
};
type LogPage = { items: LogItem[]; nextCursor: string | null };

// Deterministic, strictly-increasing ISO timestamps so ordering assertions are
// stable regardless of wall-clock.
function ts(i: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
}

let store: LogStore;

beforeEach(() => {
  store = new LogStore();
});

describe('GET /api/v1/logs — envelope + record shape', () => {
  it('returns an { items, nextCursor } envelope with timestamp + message records', async () => {
    store.append({ message: 'hello', level: 'info', category: 'ingest', timestamp: ts(1) });
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LogPage;
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('nextCursor');
    expect(body.items[0]).toMatchObject({
      message: 'hello',
      level: 'info',
      category: 'ingest',
      timestamp: ts(1)
    });
    expect(typeof body.items[0].seq).toBe('number');
    await app.close();
  });
});

describe('GET /api/v1/logs — sort order', () => {
  it('defaults to newest-first', async () => {
    for (let i = 1; i <= 3; i++) store.append({ message: `m${i}`, timestamp: ts(i) });
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs' });
    const body = res.json() as LogPage;
    expect(body.items.map((r) => r.message)).toEqual(['m3', 'm2', 'm1']);
    await app.close();
  });

  it('reverses to oldest-first with order=asc', async () => {
    for (let i = 1; i <= 3; i++) store.append({ message: `m${i}`, timestamp: ts(i) });
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?order=asc' });
    const body = res.json() as LogPage;
    expect(body.items.map((r) => r.message)).toEqual(['m1', 'm2', 'm3']);
    await app.close();
  });
});

describe('GET /api/v1/logs — cursor paging (no offset drift)', () => {
  it('walks the whole stream via nextCursor without gaps or repeats', async () => {
    for (let i = 1; i <= 5; i++) store.append({ message: `m${i}`, timestamp: ts(i) });
    const app = await buildApp(store);

    const p1 = (await app.inject({ method: 'GET', url: '/api/v1/logs?limit=2' })).json() as LogPage;
    expect(p1.items.map((r) => r.message)).toEqual(['m5', 'm4']);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = (
      await app.inject({ method: 'GET', url: `/api/v1/logs?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}` })
    ).json() as LogPage;
    expect(p2.items.map((r) => r.message)).toEqual(['m3', 'm2']);
    expect(p2.nextCursor).not.toBeNull();

    const p3 = (
      await app.inject({ method: 'GET', url: `/api/v1/logs?limit=2&cursor=${encodeURIComponent(p2.nextCursor!)}` })
    ).json() as LogPage;
    expect(p3.items.map((r) => r.message)).toEqual(['m1']);
    expect(p3.nextCursor).toBeNull();
    await app.close();
  });

  it('does NOT drift when new entries are appended between page fetches', async () => {
    // Newest-first over an append-only stream: this is exactly the offset-drift
    // hazard #371 calls out. With offset paging, appending after page 1 would
    // shift every offset and re-show an already-seen row. With a seq cursor,
    // page 2 must resume strictly after page 1's boundary regardless of appends.
    for (let i = 1; i <= 3; i++) store.append({ message: `m${i}`, timestamp: ts(i) });
    const app = await buildApp(store);

    const p1 = (await app.inject({ method: 'GET', url: '/api/v1/logs?limit=2' })).json() as LogPage;
    expect(p1.items.map((r) => r.message)).toEqual(['m3', 'm2']);

    // Two new entries land at the head of the newest-first stream.
    store.append({ message: 'm4', timestamp: ts(4) });
    store.append({ message: 'm5', timestamp: ts(5) });

    const p2 = (
      await app.inject({ method: 'GET', url: `/api/v1/logs?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}` })
    ).json() as LogPage;
    // Page 2 continues from where page 1 ended — m1 only. No re-showing of m2/m3
    // and no leakage of the newly appended m4/m5 into an already-anchored page.
    expect(p2.items.map((r) => r.message)).toEqual(['m1']);
    expect(p2.nextCursor).toBeNull();
    await app.close();
  });
});

describe('GET /api/v1/logs — server-side filters', () => {
  it('filters by from/to time range', async () => {
    for (let i = 1; i <= 5; i++) store.append({ message: `m${i}`, timestamp: ts(i) });
    const app = await buildApp(store);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/logs?from=${encodeURIComponent(ts(2))}&to=${encodeURIComponent(ts(4))}`
    });
    const body = res.json() as LogPage;
    // Inclusive range [ts(2), ts(4)], newest-first.
    expect(body.items.map((r) => r.message)).toEqual(['m4', 'm3', 'm2']);
    await app.close();
  });

  it('filters by free-text q on message (case-insensitive)', async () => {
    store.append({ message: 'transcode started', timestamp: ts(1) });
    store.append({ message: 'INGEST started', timestamp: ts(2) });
    store.append({ message: 'transcode done', timestamp: ts(3) });
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?q=TRANSCODE' });
    const body = res.json() as LogPage;
    expect(body.items.map((r) => r.message)).toEqual(['transcode done', 'transcode started']);
    await app.close();
  });

  it('combines q with cursor paging', async () => {
    for (let i = 1; i <= 4; i++) store.append({ message: `keep ${i}`, timestamp: ts(i) });
    store.append({ message: 'drop', timestamp: ts(5) });
    const app = await buildApp(store);
    const p1 = (await app.inject({ method: 'GET', url: '/api/v1/logs?q=keep&limit=2' })).json() as LogPage;
    expect(p1.items.map((r) => r.message)).toEqual(['keep 4', 'keep 3']);
    const p2 = (
      await app.inject({ method: 'GET', url: `/api/v1/logs?q=keep&limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}` })
    ).json() as LogPage;
    expect(p2.items.map((r) => r.message)).toEqual(['keep 2', 'keep 1']);
    expect(p2.nextCursor).toBeNull();
    await app.close();
  });
});

describe('GET /api/v1/logs — validation', () => {
  it('rejects limit above the bound', async () => {
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?limit=9999' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('treats a garbage cursor as the first page rather than erroring', async () => {
    for (let i = 1; i <= 2; i++) store.append({ message: `m${i}`, timestamp: ts(i) });
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?cursor=not-a-real-cursor' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LogPage;
    expect(body.items.map((r) => r.message)).toEqual(['m2', 'm1']);
    await app.close();
  });
});

// Bounded retention (issue #995 review). The pipeline producer
// (src/services/pipeline-log.ts) made this store a live, client-drivable writer,
// so the array must not grow without bound. CONTRACT verified before writing:
// `LogStoreOptions.maxRecords` / `LOG_STORE_MAX_RECORDS` and the oldest-first
// eviction in `append()` — src/services/log-store.ts; `size()` reports records
// HELD; the cursor is a `seq` boundary decoded by `decodeCursor`, never an offset.
describe('LogStore — bounded retention (oldest-first eviction)', () => {
  it('caps records held and drops the oldest first', () => {
    const capped = new LogStore({ maxRecords: 3 });
    for (let i = 1; i <= 6; i++) capped.append({ message: `m${i}`, timestamp: ts(i) });

    expect(capped.size()).toBe(3);
    const { items } = capped.list({ limit: 200 });
    // Newest-first: only the final three survive; m1..m3 were evicted.
    expect(items.map((r) => r.message)).toEqual(['m6', 'm5', 'm4']);
    // Sequence numbers are NOT renumbered by eviction — they stay monotonic and
    // keep counting every append ever made, which is what makes cursors stable.
    expect(items.map((r) => r.seq)).toEqual([6, 5, 4]);
  });

  it('applies the default cap without an explicit option', () => {
    const capped = new LogStore();
    for (let i = 0; i < LOG_STORE_MAX_RECORDS + 50; i++) capped.append({ message: `m${i}` });
    expect(capped.size()).toBe(LOG_STORE_MAX_RECORDS);
  });

  it('keeps `q`/from-to filtering and the listing envelope unchanged after eviction', () => {
    const capped = new LogStore({ maxRecords: 3 });
    capped.append({ message: 'keep 1', timestamp: ts(1) }); // evicted
    capped.append({ message: 'drop 2', timestamp: ts(2) }); // evicted
    capped.append({ message: 'keep 3', timestamp: ts(3) });
    capped.append({ message: 'drop 4', timestamp: ts(4) });
    capped.append({ message: 'keep 5', timestamp: ts(5) });

    const byQ = capped.list({ q: 'KEEP', limit: 200 });
    expect(byQ.items.map((r) => r.message)).toEqual(['keep 5', 'keep 3']);
    expect(byQ.nextCursor).toBeNull();

    // from/to still filters on the held window only; the evicted ts(1) entry is
    // simply absent rather than erroring.
    const byRange = capped.list({ from: ts(1), to: ts(4), limit: 200 });
    expect(byRange.items.map((r) => r.message)).toEqual(['drop 4', 'keep 3']);
  });

  it('honours a cursor whose boundary record has aged out (desc and asc)', () => {
    const capped = new LogStore({ maxRecords: 4 });
    for (let i = 1; i <= 4; i++) capped.append({ message: `m${i}`, timestamp: ts(i) });

    // Page 1 (newest-first, limit 2) anchors its cursor on m3 (seq 3).
    const p1 = capped.list({ limit: 2 });
    expect(p1.items.map((r) => r.message)).toEqual(['m4', 'm3']);
    expect(p1.nextCursor).not.toBeNull();

    // Two appends evict m1 and m2 — including the records that page 2 would have
    // returned, and pushing the held window strictly newer than the cursor.
    capped.append({ message: 'm5', timestamp: ts(5) });
    capped.append({ message: 'm6', timestamp: ts(6) });
    expect(capped.size()).toBe(4);

    // Desc: resuming after the aged-out boundary yields an empty, terminal page —
    // no error, no re-showing of the newer entries that arrived since.
    const p2 = capped.list({ limit: 2, cursor: p1.nextCursor! });
    expect(p2.items).toEqual([]);
    expect(p2.nextCursor).toBeNull();

    // Asc from the same boundary returns the still-held records strictly newer
    // than it, in oldest-first order, with paging intact.
    const asc1 = capped.list({ limit: 2, order: 'asc', cursor: p1.nextCursor! });
    expect(asc1.items.map((r) => r.message)).toEqual(['m4', 'm5']);
    expect(asc1.nextCursor).not.toBeNull();
    const asc2 = capped.list({ limit: 2, order: 'asc', cursor: asc1.nextCursor! });
    expect(asc2.items.map((r) => r.message)).toEqual(['m6']);
    expect(asc2.nextCursor).toBeNull();
  });

  it('serves a cursor from an evicted-boundary page over HTTP without erroring', async () => {
    const capped = new LogStore({ maxRecords: 2 });
    for (let i = 1; i <= 2; i++) capped.append({ message: `m${i}`, timestamp: ts(i) });
    const app = await buildApp(capped);

    const p1 = (await app.inject({ method: 'GET', url: '/api/v1/logs?limit=1' })).json() as LogPage;
    expect(p1.items.map((r) => r.message)).toEqual(['m2']);

    capped.append({ message: 'm3', timestamp: ts(3) });
    capped.append({ message: 'm4', timestamp: ts(4) });

    const p2res = await app.inject({
      method: 'GET',
      url: `/api/v1/logs?limit=1&cursor=${encodeURIComponent(p1.nextCursor!)}`
    });
    expect(p2res.statusCode).toBe(200);
    const p2 = p2res.json() as LogPage;
    expect(p2.items).toEqual([]);
    expect(p2.nextCursor).toBeNull();
    await app.close();
  });
});

// 401 presence gate (issue #995 review). Records now carry per-asset detail
// (asset ids, job ids, object keys, raw error strings), so this listing is gated
// exactly like GET /api/v1/jobs. CONTRACT verified before writing: `authGate`
// (src/auth/middleware.ts) attached as the router's first preHandler, matching
// src/routes/jobs.ts:17 and :144; `registerAuth` decorates `app.authenticate`
// and rejects a missing bearer token with 401 + WWW-Authenticate.
describe('GET /api/v1/logs — 401 presence gate', () => {
  async function buildGatedApp(logStore: LogStore) {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerAuth(app);
    await app.register(logsRouter, { prefix: '/api/v1/logs', logStore });
    await app.ready();
    return app;
  }

  it('rejects an anonymous request with 401', async () => {
    store.append({ message: 'transcode done for asset a1', timestamp: ts(1) });
    const app = await buildGatedApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
    await app.close();
  });

  it('serves the listing to an authenticated caller', async () => {
    store.append({ message: 'transcode done for asset a1', timestamp: ts(1) });
    const app = await buildGatedApp(store);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/logs',
      headers: { authorization: 'Bearer token-a' }
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as LogPage).items.map((r) => r.message)).toEqual([
      'transcode done for asset a1'
    ]);
    await app.close();
  });

  it('still works un-gated when registerAuth was never called (isolated router)', async () => {
    store.append({ message: 'm1', timestamp: ts(1) });
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
