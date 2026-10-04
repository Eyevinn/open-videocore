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
import { LogStore, type ListLogsOptions, type LogRecord } from '../src/services/log-store.js';
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
  // When set, `remove` rejects — standing in for a CouchDB that accepts writes
  // but fails the eviction delete (#996 review finding 2).
  removeError: Error | undefined;

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
    if (this.removeError) throw this.removeError;
    this.docs.delete(localId);
  }

  logDocs(): StoredDoc[] {
    return [...this.docs.values()].filter((d) => d.resourceType === 'log-entry');
  }
}

function couchFactory(fake: FakeCouch): () => StackCouch {
  return () => fake as unknown as StackCouch;
}

// Drop the internal ordering key before comparing records. `LogRecord.id`
// (src/services/log-store.ts) is the monotonic ULID the sort and the cursor use;
// it is deliberately NOT in the HTTP response schema (src/routes/logs.ts:55-63),
// so two stores over different databases have different ids for equivalent
// records.
function withoutId(record: LogRecord | undefined): Omit<LogRecord, 'id'> | undefined {
  if (!record) return undefined;
  const { id: _id, ...rest } = record;
  return rest;
}

// A logger spy matching LogStoreErrorLog (src/services/log-store.ts) — the same
// shape `StackResolverLogger` satisfies, which is what the resolver passes in.
function errorLogSpy(): { log: { error: (obj: unknown, msg?: string) => void }; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    log: {
      error: (obj: unknown, msg?: string) => {
        calls.push({ obj, msg });
      }
    }
  };
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
    // `id` is the internal ordering/cursor key (#996 review finding 1) and is
    // stripped from the HTTP body by the response schema — asserted separately
    // below — so the record comparison here is over the public fields.
    expect(withoutId(items[0])).toEqual({ seq: 1, timestamp: ts(1), message: 'bare' });
    expect(items[0]).not.toHaveProperty('level');
    expect(items[0]).not.toHaveProperty('category');
    expect(withoutId(items[1])).toEqual({
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
      const fromDurable = await durable.list(query);
      const fromMemory = memory.list(query);
      // Public fields, in order: the two stores must answer identically.
      expect(fromDurable.items.map(withoutId)).toEqual(fromMemory.items.map(withoutId));
      // The cursor is opaque and now keys on the per-record id, so the two
      // stores mint different tokens for the same position — but they must agree
      // on WHETHER there is a next page.
      expect(fromDurable.nextCursor === null).toBe(fromMemory.nextCursor === null);
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

// Review finding 1 (#996): `seq` was minted by a per-instance counter, but a new
// CouchLogStore is constructed on every resolver cache miss
// (buildConnectionsFromStack -> new CouchLogStore,
// src/services/workspace-stack.ts, CACHE_TTL_MS), so two live instances over one
// database mint the SAME next `seq`. Paging resumed strictly past the cursor's
// `seq` (`applyLogQuery`, src/services/log-store.ts), so a duplicate straddling a
// page boundary silently dropped a durably-written record from the stream.
describe('CouchLogStore — paging never drops a record when two stores share a database (#996 review)', () => {
  // Two stores over ONE database, appending interleaved: exactly the shape the
  // resolver cache produces.
  async function seedTwoStores(couch: FakeCouch, rounds: number): Promise<string[]> {
    const a = new CouchLogStore(couchFactory(couch));
    const b = new CouchLogStore(couchFactory(couch));
    const written: string[] = [];
    for (let i = 1; i <= rounds; i += 1) {
      written.push((await a.append({ message: `a${i}`, timestamp: ts(i) })).message);
      written.push((await b.append({ message: `b${i}`, timestamp: ts(i) })).message);
    }
    return written;
  }

  // Walk `nextCursor` to the end exactly as a client does, returning every
  // message the stream yielded.
  async function walkAll(store: CouchLogStore, limit: number, order: 'asc' | 'desc') {
    const seen: string[] = [];
    let cursor: string | undefined;
    // Generous bound so a paging bug shows up as a failed assertion below, not
    // as a hung test.
    for (let page = 0; page < 100; page += 1) {
      const result: { items: LogRecord[]; nextCursor: string | null } = await store.list({
        limit,
        order,
        ...(cursor !== undefined ? { cursor } : {})
      });
      seen.push(...result.items.map((r) => r.message));
      if (result.nextCursor === null) return seen;
      cursor = result.nextCursor;
    }
    throw new Error('cursor walk did not terminate');
  }

  it('actually mints duplicate seq values across the two stores (the precondition)', async () => {
    const couch = new FakeCouch();
    await seedTwoStores(couch, 4);
    const seqs = couch.logDocs().map((d) => d['seq'] as number);
    expect(seqs).toHaveLength(8);
    // Duplicates exist — which is why `seq` must not be the cursor key.
    expect(new Set(seqs).size).toBeLessThan(seqs.length);
  });

  it.each([1, 2, 3])(
    'reaches every persisted record walking nextCursor with limit %i',
    async (limit) => {
      const couch = new FakeCouch();
      const written = await seedTwoStores(couch, 6);
      const reader = new CouchLogStore(couchFactory(couch));

      const desc = await walkAll(reader, limit, 'desc');
      expect(desc).toHaveLength(written.length);
      expect(new Set(desc)).toEqual(new Set(written));
      // No record is yielded twice either.
      expect(new Set(desc).size).toBe(desc.length);

      const asc = await walkAll(reader, limit, 'asc');
      expect(asc).toEqual([...desc].reverse());
    }
  );

  it('keeps paging after a restart that re-seeds seq from the high-water mark', async () => {
    const couch = new FakeCouch();
    const written = await seedTwoStores(couch, 3);
    // A third store "restarts": it seeds `seq` from the persisted high-water
    // mark and so re-mints numbers the live stores may also still be using.
    const restarted = new CouchLogStore(couchFactory(couch));
    written.push((await restarted.append({ message: 'after-restart', timestamp: ts(9) })).message);

    const seen = await walkAll(restarted, 2, 'desc');
    expect(new Set(seen)).toEqual(new Set(written));
  });

  it('keeps the cursor out of the response body and the record id out of the wire', async () => {
    const couch = new FakeCouch();
    await seedTwoStores(couch, 2);
    const app = await buildApp(new CouchLogStore(couchFactory(couch)));
    const first = (
      await app.inject({ method: 'GET', url: '/api/v1/logs?limit=1' })
    ).json() as LogPage;
    // The public record shape is unchanged: no `id` key leaks through the
    // response schema (src/routes/logs.ts:55-63).
    expect(Object.keys(first.items[0] ?? {}).sort()).toEqual([
      'message',
      'seq',
      'timestamp'
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));

    // And the whole stream is still reachable over HTTP.
    const seen: string[] = [...first.items.map((r) => r.message)];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/logs?limit=1&cursor=${encodeURIComponent(cursor)}`
        })
      ).json() as LogPage;
      seen.push(...page.items.map((r) => r.message));
      cursor = page.nextCursor;
    }
    expect(new Set(seen)).toEqual(new Set(['a1', 'b1', 'a2', 'b2']));
    await app.close();
  });
});

// Review finding 2 (#996): `list()` served a stale window past the fetch cap with
// an ordinary 200, and the eviction that kept the partition inside that cap
// swallowed every error.
describe('CouchLogStore — an over-cap window and a failed eviction are reported (#996 review)', () => {
  it('still returns the NEWEST records when the partition exceeds one fetch', async () => {
    const couch = new FakeCouch();
    const spy = errorLogSpy();
    // fetchCap 3 with no eviction (maxRecords far above the record count): the
    // partition outgrows a single capped, oldest-first fetch.
    const store = new CouchLogStore(couchFactory(couch), {
      fetchCap: 3,
      maxRecords: 100,
      log: spy.log
    });
    for (let i = 1; i <= 7; i += 1) {
      await store.append({ message: `m${i}`, timestamp: ts(i) });
    }

    const page = await store.list({ limit: 3 });
    // Before the fix a single oldest-first fetch of 3 made m4..m7 invisible.
    expect(page.items.map((r) => r.message)).toEqual(['m7', 'm6', 'm5']);
    // The caller is told the window was not scanned in one go...
    expect(page.degraded).toBe(true);
    // ...and the condition is on the operator's error log, not swallowed.
    expect(spy.calls).not.toHaveLength(0);
    expect(spy.calls[0]).toMatchObject({ obj: { fetchCap: 3, hitPageLimit: false } });
  });

  it('serves the response header when the window is degraded, body unchanged', async () => {
    const couch = new FakeCouch();
    const store = new CouchLogStore(couchFactory(couch), { fetchCap: 2, maxRecords: 100 });
    for (let i = 1; i <= 5; i += 1) {
      await store.append({ message: `m${i}`, timestamp: ts(i) });
    }
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?limit=2' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-log-window-degraded']).toBe('true');
    const body = res.json() as LogPage;
    // `{ items, nextCursor }` and nothing else — the contract is untouched.
    expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor']);
    expect(body.items.map((r) => r.message)).toEqual(['m5', 'm4']);
    await app.close();
  });

  it('omits the header and the flag on a healthy single-fetch window', async () => {
    const couch = new FakeCouch();
    const store = new CouchLogStore(couchFactory(couch), { fetchCap: 50 });
    await store.append({ message: 'only', timestamp: ts(1) });
    expect(await store.list({ limit: 10 })).not.toHaveProperty('degraded');

    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs' });
    expect(res.headers['x-log-window-degraded']).toBeUndefined();
    await app.close();
  });

  it('logs a failed overflow eviction at error level instead of swallowing it', async () => {
    const couch = new FakeCouch();
    const spy = errorLogSpy();
    const store = new CouchLogStore(couchFactory(couch), { maxRecords: 1, log: spy.log });
    await store.append({ message: 'first', timestamp: ts(1) });
    couch.removeError = new Error('couch unreachable');

    // The append itself still succeeds — the record is already durable, so a
    // failed eviction must not fail the write that triggered it.
    const written = await store.append({ message: 'second', timestamp: ts(2) });
    expect(written.message).toBe('second');

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toMatchObject({
      obj: { err: couch.removeError, maxRecords: 1 },
      msg: expect.stringContaining('eviction failed')
    });
    // Nothing was evicted, so both records are still listed.
    const { items } = await store.list({ limit: 10 });
    expect(items.map((r) => r.message)).toEqual(['second', 'first']);
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
