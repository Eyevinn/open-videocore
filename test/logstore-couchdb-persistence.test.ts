// Durable log store: records survive a process restart (issue #996).
//
// Before this, LogStore was a process-local array, so every restart emptied the
// Logs tab. These tests drive the durable CouchLogStore
// (src/data/couch-log-repo.ts) against an in-test StackCouch fake, simulate a
// restart by constructing a SECOND store over the same fake database, and assert
// GET /api/v1/logs still returns the pre-restart records — plus that the public
// response contract is byte-for-byte the in-memory store's.
//
// Contract grounding (verified before writing, CLAUDE.md rule 7):
//   - Write/read primitives under test: `CouchLogStore.append(input)` /
//     `.list(opts)` / `.size()` — src/data/couch-log-repo.ts.
//   - Record + query model: `LogRecord { seq, timestamp, message, level?,
//     category? }`, `AppendLogInput`, `ListLogsOptions { limit, cursor, from,
//     to, q, order }`, `ListLogsResult { items, nextCursor }` and the shared
//     pure `applyLogQuery` — src/services/log-store.ts.
//   - Persistence pattern being mirrored: `CouchAuditRepository.record` mints a
//     fresh `ulid()` as the document `_id` and writes `couch.put(id, toDoc(...))`
//     with no `_rev`; `toDoc` emits `{ resourceType, localId, ...flat fields }`
//     — src/data/audit-repo.ts:199-215, :361-372.
//   - StackCouch surface the fake stands in for: `put(localId, body)`,
//     `get(localId)`, `find(selector, { limit, skip })`, `count(selector)`,
//     `remove(localId)` — src/data/couchdb.ts:29,39,66,78,87.
//   - Public HTTP contract that must NOT change: querystring
//     `{ limit, cursor, from, to, q, order }` and response
//     `{ items, nextCursor }` — src/routes/logs.ts:56-74,110-113.
//   - FakeCouch shape mirrors test/audit-repo.test.ts:26-80.

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { StoredDoc } from '../src/data/couchdb.js';
import type { StackCouch } from '../src/data/couchdb.js';
import { CouchLogStore } from '../src/data/couch-log-repo.js';
import { LogStore, type ListLogsOptions } from '../src/services/log-store.js';
import { logsRouter } from '../src/routes/logs.js';
import { logPipelineEvent } from '../src/services/pipeline-log.js';

// Minimal StackCouch fake. `find` reproduces CouchDB's default ascending-`_id`
// scan (no explicit sort), the assumption the oldest-first paths rely on
// (src/data/audit-repo.ts:249-261). The backing Map is the "database": it
// outlives the store instances built over it, which is how a restart is
// simulated below.
class FakeCouch {
  readonly docs = new Map<string, StoredDoc>();
  private rev = 0;
  puts = 0;

  async put(localId: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    this.rev += 1;
    this.puts += 1;
    const rev = `${this.rev}-x`;
    this.docs.set(localId, {
      ...body,
      _id: localId,
      _rev: rev,
      resourceType: String(body['resourceType'] ?? 'asset')
    } as StoredDoc);
    return { id: localId, rev };
  }

  async get(localId: string): Promise<StoredDoc | undefined> {
    const d = this.docs.get(localId);
    return d ? { ...d } : undefined;
  }

  async find(
    selector: Record<string, unknown>,
    opts: { limit?: number; skip?: number } = {}
  ): Promise<StoredDoc[]> {
    const rt = selector['resourceType'];
    const all = [...this.docs.values()]
      .filter((d) => rt === undefined || d.resourceType === rt)
      .map((d) => ({ ...d }))
      .sort((a, b) => a._id.localeCompare(b._id));
    const skip = opts.skip ?? 0;
    return opts.limit === undefined ? all.slice(skip) : all.slice(skip, skip + opts.limit);
  }

  async count(selector: Record<string, unknown>): Promise<number> {
    return (await this.find(selector)).length;
  }

  async remove(localId: string): Promise<void> {
    this.docs.delete(localId);
  }

  logDocs(): StoredDoc[] {
    return [...this.docs.values()].filter((d) => d.resourceType === 'log-entry');
  }
}

function couchFactory(fake: FakeCouch): () => StackCouch {
  return () => fake as unknown as StackCouch;
}

// Deterministic, strictly-increasing ISO timestamps, as in src/routes/logs.test.ts:38.
function ts(i: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
}

type LogPage = {
  items: { seq: number; timestamp: string; message: string; level?: string; category?: string }[];
  nextCursor: string | null;
};

// Same registration main.ts uses (src/main.ts, `app.register(logsRouter, {
// prefix: '/api/v1/logs', logStore })`), with the durable store injected.
async function buildApp(logStore: CouchLogStore) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(logsRouter, { prefix: '/api/v1/logs', logStore });
  await app.ready();
  return app;
}

describe('CouchLogStore — records survive a process restart (issue #996)', () => {
  it('returns entries appended by a previous process from GET /api/v1/logs', async () => {
    const couch = new FakeCouch();

    // "First process": append three records, then drop the store entirely.
    const before = new CouchLogStore(couchFactory(couch));
    await before.append({ message: 'ingest: pulled source', level: 'info', category: 'ingest', timestamp: ts(1) });
    await before.append({ message: 'transcode: submitted', level: 'info', category: 'transcode', timestamp: ts(2) });
    await before.append({ message: 'package: failed', level: 'error', category: 'package', timestamp: ts(3) });

    // "Restart": a brand-new store over the same database, as a fresh boot
    // rebuilds its connections from the stack config.
    const after = new CouchLogStore(couchFactory(couch));
    const app = await buildApp(after);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as LogPage;
    expect(body.items.map((r) => r.message)).toEqual([
      'package: failed',
      'transcode: submitted',
      'ingest: pulled source'
    ]);
    expect(body.items[0]).toMatchObject({
      message: 'package: failed',
      level: 'error',
      category: 'package',
      timestamp: ts(3)
    });
    await app.close();
  });

  it('continues the seq sequence after a restart instead of reusing numbers', async () => {
    const couch = new FakeCouch();
    const before = new CouchLogStore(couchFactory(couch));
    const first = await before.append({ message: 'one', timestamp: ts(1) });
    const second = await before.append({ message: 'two', timestamp: ts(2) });

    const after = new CouchLogStore(couchFactory(couch));
    const third = await after.append({ message: 'three', timestamp: ts(3) });

    expect([first.seq, second.seq]).toEqual([1, 2]);
    // The restarted process seeds from the persisted high-water mark, so it does
    // NOT restart at 1 and collide with the restored history.
    expect(third.seq).toBe(3);

    const page = await after.list({ limit: 50 });
    expect(page.items.map((r) => r.seq)).toEqual([3, 2, 1]);
    expect(new Set(page.items.map((r) => r.seq)).size).toBe(3);
  });

  it('round-trips optional level/category and omits them when absent', async () => {
    const couch = new FakeCouch();
    const store = new CouchLogStore(couchFactory(couch));
    await store.append({ message: 'bare', timestamp: ts(1) });
    await store.append({ message: 'classified', level: 'warn', category: 'ingest', timestamp: ts(2) });

    const reopened = new CouchLogStore(couchFactory(couch));
    const { items } = await reopened.list({ limit: 50, order: 'asc' });
    expect(items[0]).toEqual({ seq: 1, timestamp: ts(1), message: 'bare' });
    expect(items[0]).not.toHaveProperty('level');
    expect(items[0]).not.toHaveProperty('category');
    expect(items[1]).toEqual({
      seq: 2,
      timestamp: ts(2),
      message: 'classified',
      level: 'warn',
      category: 'ingest'
    });
  });
});

describe('CouchLogStore — persisted document shape follows audit-repo (issue #996)', () => {
  it('writes one immutable document per append under a fresh ULID _id', async () => {
    const couch = new FakeCouch();
    const store = new CouchLogStore(couchFactory(couch));
    await store.append({ message: 'a', timestamp: ts(1) });
    await store.append({ message: 'b', timestamp: ts(2) });

    const docs = couch.logDocs();
    // One document per append — an append never read-modify-writes an earlier
    // record (src/data/audit-repo.ts:210-214).
    expect(docs).toHaveLength(2);
    expect(couch.puts).toBe(2);
    for (const doc of docs) {
      // ULID: 26 Crockford base32 characters, as minted by `ulid()` in
      // CouchAuditRepository.record (src/data/audit-repo.ts:202).
      expect(doc._id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      // resourceType discriminator + localId echoing the document id, the audit
      // body shape (src/data/audit-repo.ts:361-372).
      expect(doc.resourceType).toBe('log-entry');
      expect(doc['localId']).toBe(doc._id);
      expect(typeof doc['seq']).toBe('number');
      expect(typeof doc['timestamp']).toBe('string');
      expect(typeof doc['message']).toBe('string');
      // No schemaVersion: the audit document carries none either (toDoc,
      // src/data/audit-repo.ts:361-372) — schemaVersion is the ASSET document's
      // field (src/data/asset-document.ts:279).
      expect(doc).not.toHaveProperty('schemaVersion');
    }
    expect(await store.size()).toBe(2);
  });

  it('mints strictly increasing document ids for a same-millisecond burst', async () => {
    const couch = new FakeCouch();
    const store = new CouchLogStore(couchFactory(couch));
    // No injected timestamps: a tight loop lands many records in ONE
    // millisecond, which is what a pipeline step does. Ascending `_id` must
    // still equal append order, because the oldest-first eviction and the
    // high-water-mark scan both read the partition in `_id` order.
    for (let i = 1; i <= 20; i += 1) {
      await store.append({ message: `burst-${i}` });
    }
    const byId = couch.logDocs().sort((a, b) => a._id.localeCompare(b._id));
    expect(byId.map((d) => d['seq'])).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('ignores documents of another resourceType in the same database', async () => {
    const couch = new FakeCouch();
    await couch.put('some-asset', { resourceType: 'asset', message: 'not a log', seq: 99 });
    const store = new CouchLogStore(couchFactory(couch));
    await store.append({ message: 'real log', timestamp: ts(1) });

    const { items } = await store.list({ limit: 50 });
    expect(items).toHaveLength(1);
    expect(items[0]?.message).toBe('real log');
    // The foreign document's `seq: 99` must not seed the allocator.
    expect(items[0]?.seq).toBe(1);
  });

  it('skips an unreadable log document rather than failing the whole page', async () => {
    const couch = new FakeCouch();
    const store = new CouchLogStore(couchFactory(couch));
    await store.append({ message: 'good', timestamp: ts(1) });
    // A malformed record (no message/timestamp) must not make the tab unreadable.
    await couch.put('01BX5ZZKBKACTAV9WEVGEMMVRZ', { resourceType: 'log-entry', localId: 'x', seq: 2 });

    const { items } = await new CouchLogStore(couchFactory(couch)).list({ limit: 50 });
    expect(items.map((r) => r.message)).toEqual(['good']);
  });

  it('evicts oldest-first past the retained cap, keeping the newest window', async () => {
    const couch = new FakeCouch();
    const store = new CouchLogStore(couchFactory(couch), { maxRecords: 3 });
    // Appended in a tight loop on purpose: all five land inside the same
    // millisecond, so this also pins that eviction drops the OLDEST of a burst
    // and not an arbitrary member of it.
    for (let i = 1; i <= 5; i += 1) {
      await store.append({ message: `m${i}`, timestamp: ts(i) });
    }
    expect(couch.logDocs()).toHaveLength(3);
    const { items } = await store.list({ limit: 50 });
    expect(items.map((r) => r.message)).toEqual(['m5', 'm4', 'm3']);
    // Eviction never reuses a sequence number.
    expect(items.map((r) => r.seq)).toEqual([5, 4, 3]);
  });
});

describe('GET /api/v1/logs contract is unchanged by persistence (issue #996)', () => {
  // The durable store and the in-memory store must answer every documented
  // query identically — they share `applyLogQuery` (src/services/log-store.ts),
  // and this pins that they are not allowed to drift.
  const queries: ListLogsOptions[] = [
    {},
    { limit: 2 },
    { order: 'asc' },
    { order: 'asc', limit: 2 },
    { q: 'transcode' },
    { from: ts(2), to: ts(3) },
    { q: 'package', order: 'asc' },
    { limit: 200 }
  ];

  it('matches the in-memory store for every documented filter/sort/page', async () => {
    const couch = new FakeCouch();
    const durable = new CouchLogStore(couchFactory(couch));
    const memory = new LogStore();
    const seed = [
      { message: 'ingest: pulled', level: 'info' as const, category: 'ingest', timestamp: ts(1) },
      { message: 'transcode: submitted', level: 'info' as const, category: 'transcode', timestamp: ts(2) },
      { message: 'transcode: complete', level: 'info' as const, category: 'transcode', timestamp: ts(3) },
      { message: 'package: failed', level: 'error' as const, category: 'package', timestamp: ts(4) }
    ];
    for (const input of seed) {
      await durable.append(input);
      memory.append(input);
    }

    for (const query of queries) {
      expect(await durable.list(query)).toEqual(memory.list(query));
    }
  });

  it('pages forward with the opaque cursor and ends on a null nextCursor', async () => {
    const couch = new FakeCouch();
    const store = new CouchLogStore(couchFactory(couch));
    for (let i = 1; i <= 5; i += 1) {
      await store.append({ message: `m${i}`, timestamp: ts(i) });
    }
    const app = await buildApp(new CouchLogStore(couchFactory(couch)));

    const first = (await app.inject({ method: 'GET', url: '/api/v1/logs?limit=2' })).json() as LogPage;
    expect(first.items.map((r) => r.message)).toEqual(['m5', 'm4']);
    expect(first.nextCursor).not.toBeNull();

    const second = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/logs?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`
      })
    ).json() as LogPage;
    expect(second.items.map((r) => r.message)).toEqual(['m3', 'm2']);

    const third = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/logs?limit=2&cursor=${encodeURIComponent(second.nextCursor ?? '')}`
      })
    ).json() as LogPage;
    expect(third.items.map((r) => r.message)).toEqual(['m1']);
    expect(third.nextCursor).toBeNull();
    await app.close();
  });

  it('rejects an out-of-range limit exactly as before', async () => {
    const couch = new FakeCouch();
    const app = await buildApp(new CouchLogStore(couchFactory(couch)));
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?limit=500' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('logPipelineEvent with a promise-returning sink (issue #996)', () => {
  it('appends through the durable store without awaiting the caller', async () => {
    const couch = new FakeCouch();
    const store = new CouchLogStore(couchFactory(couch));
    logPipelineEvent(store, { stage: 'transcode', level: 'info', message: 'submitted job' });
    // Detached write: give the microtask queue a turn, as a pipeline step would.
    await new Promise((resolve) => setImmediate(resolve));
    const { items } = await store.list({ limit: 50 });
    expect(items[0]).toMatchObject({
      message: 'transcode: submitted job',
      level: 'info',
      category: 'transcode'
    });
  });

  it('logs and swallows a rejected append instead of raising an unhandled rejection', async () => {
    const errors: unknown[] = [];
    const failing = {
      append: () => Promise.reject(new Error('couch unreachable'))
    };
    expect(() =>
      logPipelineEvent(failing, { stage: 'ingest', level: 'error', message: 'boom' }, {
        error: (obj: unknown) => {
          errors.push(obj);
        }
      })
    ).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ stage: 'ingest', level: 'error' });
  });
});
