// Durability of the operational log store (issue #996, parent #985).
//
// The regression: the log stream behind GET /api/v1/logs lived in a
// process-local array, so every restart emptied the tab whose purpose is
// reviewing what happened before an incident. These tests pin the fix — entries
// appended through LogStore.append() are persisted and are still returned after
// the process (and with it the store instance and its in-memory sequence
// counter) is gone — and pin that the PUBLIC contract of GET /api/v1/logs is
// unchanged.
//
// Contract grounding (verified before writing, per CLAUDE.md rule 7):
//   - CouchLogStore.append/list/size + the persisted document shape (ULID `_id`,
//     `resourceType: 'log-entry'`, `schemaVersion`, `localId`, `seq`):
//     src/data/log-repo.ts.
//   - `LogStore` contract + the shared query engine both backends run:
//     src/services/log-store.ts.
//   - Public response envelope/record shape/filters that must not change:
//     `logRecordSchema` / `listLogsQuerySchema` / `listLogsResponseSchema`,
//     src/routes/logs.ts:34-64.
//   - StackCouch put/get/find contract: src/data/couchdb.ts:29,39,66.
//   - FakeCouch shape mirrors test/audit-repo.test.ts:26-80 (ascending-`_id`
//     scan, resourceType selector), extended with the `$gt`/`$gte`/`$lte`
//     numeric range predicates CouchLogStore's `seq` window uses.

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { StoredDoc, StackCouch } from './couchdb.js';
import { CouchLogStore, LOG_RESOURCE_TYPE, LOG_SCHEMA_VERSION } from './log-repo.js';
import { InMemoryLogStore, type LogStore } from '../services/log-store.js';
import { logsRouter } from '../routes/logs.js';

// Minimal StackCouch fake. Documents live in a Map that OUTLIVES any store
// instance — that is what makes "restart" simulable: a new CouchLogStore over
// the same Map is exactly a fresh process against the same database.
class FakeCouch {
  private readonly docs = new Map<string, StoredDoc>();
  private rev = 0;

  async put(localId: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    this.rev += 1;
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

  // CouchDB's default Mango scan (no explicit `sort`) walks the primary `_id`
  // index, so results come back in ascending `_id` order — reproduced here so
  // the store cannot accidentally depend on receiving them seq-ordered.
  async find(
    selector: Record<string, unknown>,
    opts: { limit?: number; skip?: number } = {}
  ): Promise<StoredDoc[]> {
    const all = [...this.docs.values()]
      .filter((d) => matchesSelector(d, selector))
      .map((d) => ({ ...d }))
      .sort((a, b) => a._id.localeCompare(b._id));
    const skip = opts.skip ?? 0;
    return opts.limit === undefined ? all.slice(skip) : all.slice(skip, skip + opts.limit);
  }

  async count(selector: Record<string, unknown>): Promise<number> {
    return (await this.find(selector, { limit: undefined })).length;
  }

  async remove(localId: string): Promise<void> {
    this.docs.delete(localId);
  }

  // Test-only: the raw documents, to assert on the persisted shape.
  raw(): StoredDoc[] {
    return [...this.docs.values()];
  }
}

// Equality plus the operators CouchDB Mango exposes and CouchLogStore uses: the
// numeric range on its `seq` window ($gt / $gte / $lte) and `$regex` on
// `message` for the pushed-down `q` filter (src/data/log-repo.ts logMangoFilter).
function matchesSelector(doc: StoredDoc, selector: Record<string, unknown>): boolean {
  return Object.entries(selector).every(([field, condition]) => {
    const value = (doc as Record<string, unknown>)[field];
    if (condition !== null && typeof condition === 'object') {
      return Object.entries(condition as Record<string, unknown>).every(([op, operand]) => {
        if (op === '$regex') {
          if (typeof value !== 'string' || typeof operand !== 'string') return false;
          return couchRegExp(operand).test(value);
        }
        if (typeof value !== 'number' || typeof operand !== 'number') return false;
        switch (op) {
          case '$gt':
            return value > operand;
          case '$gte':
            return value >= operand;
          case '$lt':
            return value < operand;
          case '$lte':
            return value <= operand;
          default:
            throw new Error(`FakeCouch: unsupported Mango operator ${op}`);
        }
      });
    }
    return value === condition;
  });
}

// CouchDB's `$regex` is PCRE-flavoured, so a case-insensitive pattern carries
// the `(?i)` INLINE flag. JavaScript has no inline flags, so translate it to the
// equivalent `i` RegExp flag — keeping the fake faithful to what the server
// would actually evaluate.
function couchRegExp(pattern: string): RegExp {
  return pattern.startsWith('(?i)') ? new RegExp(pattern.slice(4), 'i') : new RegExp(pattern);
}

function makeStore(couch: FakeCouch): CouchLogStore {
  return new CouchLogStore(() => couch as unknown as StackCouch);
}

// Deterministic, strictly-increasing ISO timestamps.
function ts(i: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + i * 1000).toISOString();
}

type LogItem = { seq: number; timestamp: string; message: string; level?: string; category?: string };
type LogPage = { items: LogItem[]; nextCursor: string | null };

async function buildApp(logStore: LogStore) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(logsRouter, { prefix: '/api/v1/logs', logStore });
  await app.ready();
  return app;
}

describe('operational log store survives a restart (issue #996)', () => {
  it('re-reads entries appended before the restart', async () => {
    const couch = new FakeCouch();

    // --- process 1 ---
    const beforeRestart = makeStore(couch);
    await beforeRestart.append({
      message: 'ingest started',
      level: 'info',
      category: 'ingest',
      timestamp: ts(1)
    });
    await beforeRestart.append({ message: 'transcode started', level: 'warn', timestamp: ts(2) });
    expect(await beforeRestart.size()).toBe(2);

    // --- process 2: brand-new store instance (and empty in-process counter)
    // over the SAME database. This is the restart.
    const afterRestart = makeStore(couch);
    const page = await afterRestart.list();
    expect(page.items.map((r) => r.message)).toEqual(['transcode started', 'ingest started']);
    expect(page.items.map((r) => r.seq)).toEqual([2, 1]);
    // Optional metadata round-trips verbatim, and absent metadata stays absent.
    expect(page.items[1]).toEqual({
      seq: 1,
      timestamp: ts(1),
      message: 'ingest started',
      level: 'info',
      category: 'ingest'
    });
    expect(page.items[0]).toEqual({ seq: 2, timestamp: ts(2), message: 'transcode started', level: 'warn' });
    expect(await afterRestart.size()).toBe(2);
  });

  it('continues the sequence after a restart instead of restarting at 1', async () => {
    const couch = new FakeCouch();
    const beforeRestart = makeStore(couch);
    for (let i = 1; i <= 3; i += 1) {
      await beforeRestart.append({ message: `m${i}`, timestamp: ts(i) });
    }

    const afterRestart = makeStore(couch);
    const appended = await afterRestart.append({ message: 'm4', timestamp: ts(4) });
    // Sequence numbers are the ONLY pagination key, so a restart must not
    // re-mint numbers a cursor already points past.
    expect(appended.seq).toBe(4);
    const page = await afterRestart.list();
    expect(page.items.map((r) => r.seq)).toEqual([4, 3, 2, 1]);
    expect(page.items.map((r) => r.message)).toEqual(['m4', 'm3', 'm2', 'm1']);
  });

  it('serves the persisted stream over GET /api/v1/logs after a restart', async () => {
    const couch = new FakeCouch();
    const beforeRestart = makeStore(couch);
    await beforeRestart.append({ message: 'pre-incident detail', timestamp: ts(1) });
    await beforeRestart.append({ message: 'the incident', timestamp: ts(2) });

    // Fresh store instance + freshly registered router == restarted API.
    const app = await buildApp(makeStore(couch));
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LogPage;
    // Same envelope and record shape as before the change (src/routes/logs.ts:34-64).
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('nextCursor');
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((r) => r.message)).toEqual(['the incident', 'pre-incident detail']);
    await app.close();
  });

  it('a reader picks up entries another instance appended', async () => {
    // Two store instances over one database — a second API process, or a reader
    // that has already cached its own high-water mark. The reader must not be
    // pinned to what it happened to write itself.
    const couch = new FakeCouch();
    const reader = makeStore(couch);
    const writer = makeStore(couch);
    await reader.append({ message: 'seen by both', timestamp: ts(1) });
    expect((await reader.list()).items.map((r) => r.message)).toEqual(['seen by both']);

    await writer.append({ message: 'written elsewhere', timestamp: ts(2) });
    const page = await reader.list();
    expect(page.items.map((r) => r.message)).toEqual(['written elsewhere', 'seen by both']);
    expect(await reader.size()).toBe(2);
  });

  it('the in-memory store, by contrast, loses the stream on restart', async () => {
    // The behaviour #996 replaces. Kept as the explicit contrast so a future
    // change back to a process-local store for the provisioned path fails here.
    const beforeRestart = new InMemoryLogStore();
    await beforeRestart.append({ message: 'gone after restart', timestamp: ts(1) });
    const afterRestart = new InMemoryLogStore();
    expect((await afterRestart.list()).items).toEqual([]);
  });
});

describe('persisted log document shape (issue #996)', () => {
  it('writes one immutable ULID document per entry, with schemaVersion', async () => {
    const couch = new FakeCouch();
    const store = makeStore(couch);
    await store.append({ message: 'first', timestamp: ts(1) });
    await store.append({ message: 'second', timestamp: ts(2) });

    const docs = couch.raw();
    // Append-only: two appends leave two distinct documents, neither rewritten.
    expect(docs).toHaveLength(2);
    for (const doc of docs) {
      // Crockford base32 ULID, 26 chars — the same id shape audit entries use.
      expect(doc._id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(doc.resourceType).toBe(LOG_RESOURCE_TYPE);
      expect(doc['schemaVersion']).toBe(LOG_SCHEMA_VERSION);
      expect(doc['localId']).toBe(doc._id);
      expect(typeof doc['seq']).toBe('number');
    }
    expect(docs.map((d) => d['seq']).sort()).toEqual([1, 2]);
  });

  it('ignores foreign documents sharing the database', async () => {
    const couch = new FakeCouch();
    // The log partition shares the per-stack database with every other resource
    // type (ADR-003: one database per deployment), so reads must be scoped.
    await couch.put('asset-1', { resourceType: 'asset', seq: 99, message: 'not a log line' });
    const store = makeStore(couch);
    await store.append({ message: 'real log line', timestamp: ts(1) });

    const page = await store.list();
    expect(page.items.map((r) => r.message)).toEqual(['real log line']);
    expect(page.items.map((r) => r.seq)).toEqual([1]);
  });
});

describe('persisted log paging (issue #996)', () => {
  it('walks a stream larger than one scan window without gaps or repeats', async () => {
    const couch = new FakeCouch();
    const store = makeStore(couch);
    // Deliberately more entries than the store's per-call scan window, so the
    // walk crosses a window boundary.
    const total = 1200;
    for (let i = 1; i <= total; i += 1) {
      await store.append({ message: `m${i}`, timestamp: ts(i) });
    }

    const seen: number[] = [];
    let cursor: string | undefined;
    // Bounded so a cursor bug cannot spin this test forever.
    for (let guard = 0; guard < 50; guard += 1) {
      const page: LogPage = (await store.list({ limit: 200, ...(cursor ? { cursor } : {}) })) as LogPage;
      seen.push(...page.items.map((r) => r.seq));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    // Newest-first, every entry exactly once.
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen[0]).toBe(total);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('applies from/to and q filters server-side across a restart', async () => {
    const couch = new FakeCouch();
    const beforeRestart = makeStore(couch);
    await beforeRestart.append({ message: 'transcode started', timestamp: ts(1) });
    await beforeRestart.append({ message: 'INGEST started', timestamp: ts(2) });
    await beforeRestart.append({ message: 'transcode done', timestamp: ts(3) });

    const afterRestart = makeStore(couch);
    const byText = await afterRestart.list({ q: 'TRANSCODE' });
    expect(byText.items.map((r) => r.message)).toEqual(['transcode done', 'transcode started']);

    const byRange = await afterRestart.list({ from: ts(2), to: ts(3) });
    expect(byRange.items.map((r) => r.message)).toEqual(['transcode done', 'INGEST started']);

    const oldestFirst = await afterRestart.list({ order: 'asc' });
    expect(oldestFirst.items.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('treats a garbage cursor as the first page, as before', async () => {
    const couch = new FakeCouch();
    const store = makeStore(couch);
    await store.append({ message: 'm1', timestamp: ts(1) });
    await store.append({ message: 'm2', timestamp: ts(2) });
    const page = await store.list({ cursor: 'not-a-real-cursor' });
    expect(page.items.map((r) => r.message)).toEqual(['m2', 'm1']);
  });

  it('returns an empty page from an empty partition', async () => {
    const store = makeStore(new FakeCouch());
    expect(await store.list()).toEqual({ items: [], nextCursor: null });
    expect(await store.size()).toBe(0);
  });

  it('still honours a LEGACY bare-`seq` cursor token', async () => {
    // The cursor became a composite `(seq, id)` boundary on the #996 review. A
    // token minted by the previous build (base64url of `seq:N`) must still
    // decode and still resume strictly past the whole of seq N, or every open
    // browser tab breaks on deploy.
    const couch = new FakeCouch();
    const store = makeStore(couch);
    for (let i = 1; i <= 4; i += 1) await store.append({ message: `m${i}`, timestamp: ts(i) });

    const legacy = Buffer.from('seq:3', 'utf8').toString('base64url');
    const page = await store.list({ cursor: legacy });
    expect(page.items.map((r) => r.message)).toEqual(['m2', 'm1']);
  });
});

// Review finding on #996: `seq` is allocated from a store instance's in-memory
// high-water mark, and a store instance is NOT process-wide — the
// WorkspaceConnections cache expires after CACHE_TTL_MS
// (src/services/workspace-stack.ts:70) and every rebuild mints a fresh
// `new CouchLogStore(wc)` (src/services/workspace-stack.ts:235) with an
// undefined mark. Two live instances therefore recover the same mark and mint
// the same `seq`, and the old bare-`seq` cursor made the second of a tied pair
// unreachable whenever the tie fell on a page boundary.
//
// Contract grounding: composite cursor + ordering engine both stores run —
// `encodeLogCursor`/`decodeLogCursor`/`applyLogQuery` and `SequencedLogRecord`,
// src/services/log-store.ts; document ULID carried as the tie-break (`localId`,
// src/data/log-repo.ts fromDoc).
describe('a duplicated `seq` stays reachable through paging (issue #996 review)', () => {
  // Two warm instances over ONE partition, appending concurrently.
  async function twoWarmInstances(): Promise<{
    couch: FakeCouch;
    first: ReturnType<typeof makeStore>;
    second: ReturnType<typeof makeStore>;
  }> {
    const couch = new FakeCouch();
    const first = makeStore(couch);
    const second = makeStore(couch);
    // Shared history, then warm BOTH marks against it: this is the state after
    // a cache rebuild, where the new instance has recovered the same high-water
    // mark the old one is still holding.
    await first.append({ message: 'shared history', timestamp: ts(1) });
    await second.list();
    return { couch, first, second };
  }

  it('mints a duplicate `seq` (the precondition this fix has to survive)', async () => {
    const { couch, first, second } = await twoWarmInstances();
    await Promise.all([
      first.append({ message: 'from the first instance', timestamp: ts(2) }),
      second.append({ message: 'from the second instance', timestamp: ts(2) })
    ]);
    // Both took seq 2 — and both documents exist, neither overwritten.
    expect(couch.raw().filter((d) => d['seq'] === 2)).toHaveLength(2);
    expect(couch.raw()).toHaveLength(3);
  });

  it('pages every entry exactly once, newest-first, across the tie', async () => {
    const { first, second } = await twoWarmInstances();
    await Promise.all([
      first.append({ message: 'from the first instance', timestamp: ts(2) }),
      second.append({ message: 'from the second instance', timestamp: ts(2) })
    ]);

    // limit=1 puts the page boundary ON the duplicated seq — the exact case
    // that used to drop an entry.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await first.list({ limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((r) => r.message));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(seen).toContain('from the first instance');
    expect(seen).toContain('from the second instance');
    // Oldest entry last: the tie is ordered internally, never collapsed.
    expect(seen[2]).toBe('shared history');
  });

  it('pages every entry exactly once oldest-first too', async () => {
    const { first, second } = await twoWarmInstances();
    await Promise.all([
      first.append({ message: 'from the first instance', timestamp: ts(2) }),
      second.append({ message: 'from the second instance', timestamp: ts(2) })
    ]);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await second.list({ limit: 1, order: 'asc', ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((r) => r.message));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(seen[0]).toBe('shared history');
  });

  it('keeps a reader that already paged past the tie from seeing it twice', async () => {
    const { first, second } = await twoWarmInstances();
    await Promise.all([
      first.append({ message: 'from the first instance', timestamp: ts(2) }),
      second.append({ message: 'from the second instance', timestamp: ts(2) })
    ]);

    const p1 = await first.list({ limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await first.list({ limit: 2, cursor: p1.nextCursor! });
    // No repeat of either tied entry on the following page.
    const firstPageMessages = p1.items.map((r) => r.message);
    for (const item of p2.items) expect(firstPageMessages).not.toContain(item.message);
    expect(p2.items.map((r) => r.message)).toEqual(['shared history']);
  });
});

// Review finding on #996: `list` materialised exactly ONE `seq` window and then
// filtered in process, so a filtered page whose match sat beyond that window
// returned `{ items: [], nextCursor: <edge> }` — and the UI rendered "No log
// entries match the current filters." while a match existed. `list` now keeps
// advancing windows internally until the page is filled or the stream is
// exhausted (bounded by LOG_MAX_SCAN_WINDOWS).
describe('a filtered match beyond the first scan window (issue #996 review)', () => {
  // One matching entry at the OLDEST end of a stream longer than one window
  // (LOG_SCAN_WINDOW = 1000, src/data/log-repo.ts), so a newest-first read has
  // to cross a window boundary to find it.
  async function streamWithOneMatch(): Promise<CouchLogStore> {
    const couch = new FakeCouch();
    const store = makeStore(couch);
    await store.append({ message: 'needle: the entry the operator wants', timestamp: ts(1) });
    for (let i = 2; i <= 1200; i += 1) {
      await store.append({ message: `haystack ${i}`, timestamp: ts(i) });
    }
    return store;
  }

  it('returns the match on the FIRST page rather than an empty page', async () => {
    const store = await streamWithOneMatch();
    const page = await store.list({ q: 'needle' });
    expect(page.items.map((r) => r.message)).toEqual([
      'needle: the entry the operator wants'
    ]);
    // The stream really was walked to its end, so "last page" is the truth.
    expect(page.nextCursor).toBeNull();
  });

  it('matches case-insensitively across the window boundary, like the in-process filter', async () => {
    const store = await streamWithOneMatch();
    const page = await store.list({ q: 'NEEDLE' });
    expect(page.items).toHaveLength(1);
  });

  it('finds a match beyond the first window with a time range applied too', async () => {
    const store = await streamWithOneMatch();
    const page = await store.list({ q: 'needle', from: ts(1), to: ts(1) });
    expect(page.items.map((r) => r.seq)).toEqual([1]);
  });

  it('still reports a genuinely absent match as an empty LAST page', async () => {
    const store = await streamWithOneMatch();
    const page = await store.list({ q: 'no such entry anywhere' });
    // Empty AND terminal: nothing matched and nothing is left to scan, so the
    // UI's "no match" message is honest here (and only here).
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it('a non-ASCII query, which is NOT pushed into the selector, still matches', async () => {
    // `q` is only pushed into the Mango selector for printable-ASCII queries
    // (case folding differs between the two engines otherwise); everything else
    // falls back to the in-process filter, which must still find it.
    const couch = new FakeCouch();
    const store = makeStore(couch);
    await store.append({ message: 'packaging färdig', timestamp: ts(1) });
    await store.append({ message: 'packaging done', timestamp: ts(2) });
    const page = await store.list({ q: 'FÄRDIG' });
    expect(page.items.map((r) => r.message)).toEqual(['packaging färdig']);
  });
});
