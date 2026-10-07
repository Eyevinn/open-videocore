// Operational-log retention purge sweep (issue #1067), mirroring the audit-log
// retention tests (test/audit-retention-purge-sweep.test.ts, #566).
//
// Covers exactly the acceptance criteria:
//   (1) a log record past its window is purged on a tick (whole-record expiry);
//   (2) one per-record failure is logged and skipped and never aborts the run;
//   (3) a record inside the window is NOT purged, and the oldest-first walk
//       stops at the first live-window record;
//   (4) the loop is unref'd, overlap-guarded, and skipped entirely when the
//       log-retention window is unset (0 = indefinite retention);
//   (5) append-only-UNTIL-purge: purge is whole-record, never an in-place edit;
//   (6) BOTH concrete stores answer listOldestPage/purgeEntry identically — the
//       in-memory LogStore and the durable CouchLogStore — so the sweep drives
//       whichever store the resolved stack surfaces.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - purgeExpiredLogRecords deps/result + disabled/oldest-first-stop:
//     src/pipeline/log-retention-purge-sweep.ts
//   - LogRetentionPurgeLoop unref/overlap/skip + env cadence:
//     src/pipeline/log-retention-purge-loop.ts
//   - Retention pair under test + record shape: `LogRetentionStore`,
//     `LogRecord { id, seq, timestamp, message, level?, category? }`,
//     `LogStore.listOldestPage` / `.purgeEntry` — src/services/log-store.ts;
//     `CouchLogStore.listOldestPage` / `.purgeEntry` —
//     src/data/couch-log-repo.ts.
//   - StackCouch surface the fake stands in for: `put(localId, body)`,
//     `get(localId)`, `find(selector, { limit, skip })`, `remove(localId)` —
//     src/data/couchdb.ts. FakeCouch shape mirrored from
//     test/logstore-couchdb-persistence.test.ts:44-90.
//   - Loop test harness (fake timers, captured interval cb) mirrored from
//     test/audit-retention-purge-sweep.test.ts:174-240.

import { describe, it, expect, vi } from 'vitest';

import type { StackCouch, StoredDoc } from '../src/data/couchdb.js';
import { CouchLogStore } from '../src/data/couch-log-repo.js';
import { LogStore, type LogRecord, type LogRetentionStore } from '../src/services/log-store.js';
import { purgeExpiredLogRecords } from '../src/pipeline/log-retention-purge-sweep.js';
import {
  LogRetentionPurgeLoop,
  logPurgeIntervalMsFromEnv,
  DEFAULT_LOG_PURGE_INTERVAL_MS
} from '../src/pipeline/log-retention-purge-loop.js';

// A minimal in-memory log store implementing exactly the sweep's surface
// (listOldestPage / purgeEntry). Holds records in ascending-id (oldest-first)
// order and records purge calls so tests can assert whole-record expiry.
class FakeLogStore implements LogRetentionStore {
  private records: LogRecord[];
  readonly purged: string[] = [];
  constructor(
    records: LogRecord[],
    private readonly failOnId?: string
  ) {
    // Keep ascending by id (oldest-first), matching CouchLogStore.listOldestPage.
    this.records = [...records].sort((a, b) => a.id.localeCompare(b.id));
  }
  async listOldestPage(opts: { limit: number; offset?: number }): Promise<LogRecord[]> {
    const skip = opts.offset ?? 0;
    return this.records.slice(skip, skip + opts.limit);
  }
  async purgeEntry(id: string): Promise<boolean> {
    if (this.failOnId && id === this.failOnId) {
      throw new Error(`boom purging ${id}`);
    }
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    const removed = this.records.length < before;
    if (removed) this.purged.push(id);
    return removed;
  }
  get live(): string[] {
    return this.records.map((r) => r.id);
  }
}

// Build a LogRecord with a controllable append instant. `id` is set ascending by
// the caller so oldest-first order is deterministic.
function record(id: string, timestamp: string): LogRecord {
  return { id, seq: 1, timestamp, message: `msg ${id}`, level: 'info', category: 'transcode' };
}

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

describe('purgeExpiredLogRecords — whole-record expiry (#1067)', () => {
  it('purges records aged past the window and leaves records inside it', async () => {
    const store = new FakeLogStore([
      record('01A', '2026-01-01T00:00:00.000Z'), // ~150d old -> expired
      record('01B', '2026-02-01T00:00:00.000Z'), // ~120d old -> expired
      record('01C', '2026-05-28T00:00:00.000Z') // 4d old -> inside window
    ]);

    const result = await purgeExpiredLogRecords({
      logs: store,
      retentionMs: THIRTY_DAYS,
      now: () => NOW
    });

    // Scanned the two expired plus the first in-window record (where it stopped).
    expect(result.scanned).toBe(3);
    expect(result.purged).toBe(2);
    expect(store.purged).toEqual(['01A', '01B']);
    // The in-window record survives untouched (append-only-until-purge).
    expect(store.live).toEqual(['01C']);
  });

  it('is a no-op when the window is unset (0 = indefinite retention)', async () => {
    const store = new FakeLogStore([record('01A', '2020-01-01T00:00:00.000Z')]);
    const result = await purgeExpiredLogRecords({
      logs: store,
      retentionMs: 0,
      now: () => NOW
    });
    expect(result).toEqual({ scanned: 0, purged: 0 });
    expect(store.purged).toHaveLength(0);
    expect(store.live).toEqual(['01A']);
  });

  it('logs and skips one record whose purge throws, and still purges the rest', async () => {
    // `01B` fails to purge; the run must not abort — `01A` and `01C` still purge.
    const store = new FakeLogStore(
      [
        record('01A', '2026-01-01T00:00:00.000Z'),
        record('01B', '2026-01-02T00:00:00.000Z'),
        record('01C', '2026-01-03T00:00:00.000Z')
      ],
      '01B'
    );
    const warns: unknown[][] = [];

    const result = await purgeExpiredLogRecords({
      logs: store,
      retentionMs: THIRTY_DAYS,
      now: () => NOW,
      logger: { warn: (...a: unknown[]) => warns.push(a) }
    });

    expect(result.scanned).toBe(3);
    expect(result.purged).toBe(2); // 01A + 01C
    expect(store.live).toEqual(['01B']); // the failed one survives, retried next tick
    expect(warns.some((w) => String(w[0]).includes('failed to purge log record'))).toBe(true);
  });

  it('refuses to purge a record with an unparseable timestamp', async () => {
    const store = new FakeLogStore([record('01A', 'not-a-date')]);
    const warns: unknown[][] = [];
    const result = await purgeExpiredLogRecords({
      logs: store,
      retentionMs: THIRTY_DAYS,
      now: () => NOW,
      logger: { warn: (...a: unknown[]) => warns.push(a) }
    });
    expect(result.purged).toBe(0);
    expect(store.live).toEqual(['01A']);
    expect(warns.some((w) => String(w[0]).includes('unparseable timestamp'))).toBe(true);
  });

  it('pages through more than one page of expired records', async () => {
    // 250 expired records (> SCAN_PAGE_SIZE of 200) force a second page. Log
    // volume is far higher than audit volume, so multi-page runs are the norm
    // here rather than the exception.
    const many = Array.from({ length: 250 }, (_, i) =>
      record(`01${String(i).padStart(4, '0')}`, '2026-01-01T00:00:00.000Z')
    );
    const store = new FakeLogStore(many);
    const result = await purgeExpiredLogRecords({
      logs: store,
      retentionMs: THIRTY_DAYS,
      now: () => NOW
    });
    expect(result.purged).toBe(250);
    expect(store.live).toHaveLength(0);
  });
});

describe('LogRetentionPurgeLoop — unref, overlap guard, skip-when-unset (#1067)', () => {
  it("installs an unref'd, overlap-guarded interval and is idempotent on start", () => {
    vi.useFakeTimers();
    try {
      const unref = vi.fn();
      const timer = { unref } as unknown as NodeJS.Timeout;
      let intervalCb: (() => void) | undefined;
      const setIntervalSpy = vi
        .spyOn(globalThis, 'setInterval')
        .mockImplementation((cb: () => void) => {
          intervalCb = cb;
          return timer;
        });

      let resolveTick: (() => void) | undefined;
      const loop = new LogRetentionPurgeLoop({
        retentionMs: () => 30_000,
        sweepDeps: {
          logs: {
            listOldestPage: async () => [],
            purgeEntry: async () => false
          }
        }
      });
      const tickSpy = vi.spyOn(loop, 'tick').mockImplementation(
        () =>
          new Promise<void>((res) => {
            resolveTick = res;
          })
      );

      loop.start(1000);
      expect(unref).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      // Idempotent start.
      loop.start(1000);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      intervalCb?.();
      expect(tickSpy).toHaveBeenCalledTimes(1);
      // Overlap guard: a second fire while the first tick is in-flight is skipped.
      intervalCb?.();
      expect(tickSpy).toHaveBeenCalledTimes(1);
      resolveTick?.();

      loop.stop();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('tick() runs the sweep with the LIVE window and skips it when unset', async () => {
    const store = new FakeLogStore([record('01A', '2026-01-01T00:00:00.000Z')]);
    let retention = 0; // disabled
    const loop = new LogRetentionPurgeLoop({
      retentionMs: () => retention,
      sweepDeps: { logs: store, now: () => NOW }
    });

    await loop.tick();
    expect(store.live).toEqual(['01A']); // disabled: nothing purged

    // Hot-enable (as PATCH /retention/config would): the next tick purges it.
    retention = THIRTY_DAYS;
    await loop.tick();
    expect(store.live).toHaveLength(0);
  });
});

describe('logPurgeIntervalMsFromEnv (#1067)', () => {
  const original = process.env['LOG_PURGE_INTERVAL_MS'];
  const restore = () => {
    if (original === undefined) delete process.env['LOG_PURGE_INTERVAL_MS'];
    else process.env['LOG_PURGE_INTERVAL_MS'] = original;
  };

  it('defaults when unset and honours a positive override', () => {
    delete process.env['LOG_PURGE_INTERVAL_MS'];
    expect(logPurgeIntervalMsFromEnv()).toBe(DEFAULT_LOG_PURGE_INTERVAL_MS);
    process.env['LOG_PURGE_INTERVAL_MS'] = '5000';
    expect(logPurgeIntervalMsFromEnv()).toBe(5000);
    process.env['LOG_PURGE_INTERVAL_MS'] = 'nope';
    expect(logPurgeIntervalMsFromEnv()).toBe(DEFAULT_LOG_PURGE_INTERVAL_MS);
    restore();
  });
});

// Minimal StackCouch fake. `find` reproduces CouchDB's default ascending-`_id`
// scan (no explicit sort) — the assumption CouchLogStore.listOldestPage rests on
// — mirroring the fake in test/logstore-couchdb-persistence.test.ts.
class FakeCouch {
  readonly docs = new Map<string, StoredDoc>();
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
}

function couchFactory(fake: FakeCouch): () => StackCouch {
  return () => fake as unknown as StackCouch;
}

function ts(i: number): string {
  return new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString();
}

describe('log stores answer the retention pair identically (#1067)', () => {
  it('CouchLogStore.listOldestPage returns oldest-first and honours limit/offset', async () => {
    const couch = new FakeCouch();
    const store = new CouchLogStore(couchFactory(couch));
    const written: LogRecord[] = [];
    for (let i = 0; i < 5; i += 1) {
      written.push(await store.append({ message: `m${i}`, timestamp: ts(i) }));
    }
    const ascending = written.map((r) => r.id);

    const firstTwo = await store.listOldestPage({ limit: 2, offset: 0 });
    expect(firstTwo.map((r) => r.id)).toEqual(ascending.slice(0, 2));

    const nextTwo = await store.listOldestPage({ limit: 2, offset: 2 });
    expect(nextTwo.map((r) => r.id)).toEqual(ascending.slice(2, 4));

    const all = await store.listOldestPage({ limit: 10 });
    expect(all.map((r) => r.id)).toEqual(ascending);
    // Oldest-first is the REVERSE of the newest-first read path, which is
    // untouched by this addition.
    const listed = await store.list({ limit: 10 });
    expect(listed.items.map((r) => r.id)).toEqual([...ascending].reverse());
  });

  it('CouchLogStore.purgeEntry removes the WHOLE document and returns true, false when absent', async () => {
    const couch = new FakeCouch();
    const store = new CouchLogStore(couchFactory(couch));
    const first = await store.append({ message: 'oldest', timestamp: ts(0) });
    const second = await store.append({ message: 'newest', timestamp: ts(1) });

    expect(await store.purgeEntry(first.id)).toBe(true);
    // Whole-document removal: no tombstone/edited copy left behind.
    expect(couch.docs.has(first.id)).toBe(false);
    expect(await store.size()).toBe(1);
    // The surviving record is byte-for-byte what was written (never rewritten).
    const remaining = await store.listOldestPage({ limit: 10 });
    expect(remaining).toEqual([second]);

    // Already gone, and a non-log document, both answer false.
    expect(await store.purgeEntry(first.id)).toBe(false);
    await couch.put('not-a-log', { resourceType: 'asset' });
    expect(await store.purgeEntry('not-a-log')).toBe(false);
    expect(couch.docs.has('not-a-log')).toBe(true);
  });

  it('the in-memory LogStore answers the same pair, so the sweep runs on the no-Couch path', async () => {
    const store = new LogStore();
    const written = [
      store.append({ message: 'a', timestamp: '2026-01-01T00:00:00.000Z' }),
      store.append({ message: 'b', timestamp: '2026-01-02T00:00:00.000Z' }),
      store.append({ message: 'c', timestamp: '2026-05-28T00:00:00.000Z' })
    ];

    expect(store.listOldestPage({ limit: 10 }).map((r) => r.id)).toEqual(
      written.map((r) => r.id)
    );
    expect(store.listOldestPage({ limit: 1, offset: 1 }).map((r) => r.message)).toEqual(['b']);

    // Drive the real sweep over the real store: the two aged records go, the
    // in-window one stays, and the read path still answers correctly after.
    const result = await purgeExpiredLogRecords({
      logs: store,
      retentionMs: THIRTY_DAYS,
      now: () => NOW
    });
    expect(result.purged).toBe(2);
    expect(store.size()).toBe(1);
    expect(store.list({ limit: 10 }).items.map((r) => r.message)).toEqual(['c']);
    expect(store.purgeEntry('does-not-exist')).toBe(false);
  });

  it('drives the real sweep over the durable store end to end', async () => {
    const couch = new FakeCouch();
    const store = new CouchLogStore(couchFactory(couch));
    await store.append({ message: 'aged-1', timestamp: '2026-01-01T00:00:00.000Z' });
    await store.append({ message: 'aged-2', timestamp: '2026-02-01T00:00:00.000Z' });
    await store.append({ message: 'fresh', timestamp: '2026-05-28T00:00:00.000Z' });

    const result = await purgeExpiredLogRecords({
      logs: store,
      retentionMs: THIRTY_DAYS,
      now: () => NOW
    });

    expect(result.purged).toBe(2);
    expect(await store.size()).toBe(1);
    const { items } = await store.list({ limit: 10 });
    expect(items.map((r) => r.message)).toEqual(['fresh']);
  });
});
