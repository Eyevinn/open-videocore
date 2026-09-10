// Audit-log retention purge sweep (issue #566, aligned with the archived-asset
// purge lifecycle #327/#323).
//
// Covers exactly the acceptance criteria, mirroring
// test/archived-asset-purge-sweep.test.ts:
//   (1) an audit entry past its window is purged on a tick (whole-entry expiry);
//   (2) one per-entry failure is logged and skipped and never aborts the run;
//   (3) an entry inside the window is NOT purged, and the oldest-first walk stops
//       at the first live-window entry;
//   (4) the loop is unref'd, overlap-guarded, and skipped entirely when the
//       audit-retention window is unset (0 = indefinite retention);
//   (5) append-only-UNTIL-purge: purge is whole-entry, never an in-place edit.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - purgeExpiredAuditEntries deps/result + disabled/oldest-first-stop:
//     src/pipeline/audit-retention-purge-sweep.ts
//   - AuditRetentionPurgeLoop unref/overlap/skip + env cadence:
//     src/pipeline/audit-retention-purge-loop.ts
//   - CouchAuditRepository.listOldestPage/purgeEntry + AuditEntry.at:
//     src/data/audit-repo.ts
//   - Loop test harness (fake timers, captured interval cb) mirrored from
//     test/archived-asset-purge-sweep.test.ts:373-460

import { describe, it, expect, vi } from 'vitest';

import type { AuditEntry } from '../src/data/audit-repo.js';
import {
  purgeExpiredAuditEntries,
  type AuditRetentionStore
} from '../src/pipeline/audit-retention-purge-sweep.js';
import {
  AuditRetentionPurgeLoop,
  auditPurgeIntervalMsFromEnv,
  DEFAULT_AUDIT_PURGE_INTERVAL_MS
} from '../src/pipeline/audit-retention-purge-loop.js';

// A minimal in-memory audit store implementing exactly the sweep's surface
// (listOldestPage / purgeEntry). Holds entries in ascending-id (oldest-first)
// order and records purge calls so tests can assert whole-entry expiry.
class FakeAuditStore implements AuditRetentionStore {
  private entries: AuditEntry[] = [];
  readonly purged: string[] = [];
  constructor(
    entries: AuditEntry[],
    private readonly failOnId?: string
  ) {
    // Keep ascending by id (oldest-first), matching CouchAuditRepository.listOldestPage.
    this.entries = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  }
  async listOldestPage(opts: { limit: number; offset?: number }): Promise<AuditEntry[]> {
    const skip = opts.offset ?? 0;
    return this.entries.slice(skip, skip + opts.limit);
  }
  async purgeEntry(id: string): Promise<boolean> {
    if (this.failOnId && id === this.failOnId) {
      throw new Error(`boom purging ${id}`);
    }
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    const removed = this.entries.length < before;
    if (removed) this.purged.push(id);
    return removed;
  }
  get live(): string[] {
    return this.entries.map((e) => e.id);
  }
}

// Build an AuditEntry with a controllable write instant. `id` is set ascending
// by the caller so oldest-first order is deterministic.
function entry(id: string, at: string): AuditEntry {
  return {
    id,
    at,
    actor: { principalId: null, origin: 'system' },
    action: 'x',
    targetType: 'asset',
    targetId: 'asset-1',
    detail: {}
  };
}

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

describe('purgeExpiredAuditEntries — whole-entry expiry (#566)', () => {
  it('purges entries aged past the window and leaves entries inside it', async () => {
    const store = new FakeAuditStore([
      entry('01A', '2026-01-01T00:00:00.000Z'), // ~150d old -> expired
      entry('01B', '2026-02-01T00:00:00.000Z'), // ~120d old -> expired
      entry('01C', '2026-05-28T00:00:00.000Z') // 4d old -> inside window
    ]);

    const result = await purgeExpiredAuditEntries({
      audit: store,
      retentionMs: THIRTY_DAYS,
      now: () => NOW
    });

    // Scanned the two expired plus the first in-window entry (where it stopped).
    expect(result.purged).toBe(2);
    expect(store.purged).toEqual(['01A', '01B']);
    // The in-window entry survives untouched (append-only-until-purge).
    expect(store.live).toEqual(['01C']);
  });

  it('is a no-op when the window is unset (0 = indefinite retention)', async () => {
    const store = new FakeAuditStore([entry('01A', '2020-01-01T00:00:00.000Z')]);
    const result = await purgeExpiredAuditEntries({
      audit: store,
      retentionMs: 0,
      now: () => NOW
    });
    expect(result).toEqual({ scanned: 0, purged: 0 });
    expect(store.purged).toHaveLength(0);
    expect(store.live).toEqual(['01A']);
  });

  it('logs and skips one entry whose purge throws, and still purges the rest', async () => {
    // `01B` fails to purge; the run must not abort — `01A` and `01C` still purge.
    const store = new FakeAuditStore(
      [
        entry('01A', '2026-01-01T00:00:00.000Z'),
        entry('01B', '2026-01-02T00:00:00.000Z'),
        entry('01C', '2026-01-03T00:00:00.000Z')
      ],
      '01B'
    );
    const warns: unknown[][] = [];

    const result = await purgeExpiredAuditEntries({
      audit: store,
      retentionMs: THIRTY_DAYS,
      now: () => NOW,
      logger: { warn: (...a: unknown[]) => warns.push(a) }
    });

    expect(result.scanned).toBe(3);
    expect(result.purged).toBe(2); // 01A + 01C
    expect(store.live).toEqual(['01B']); // the failed one survives, retried next tick
    expect(warns.some((w) => String(w[0]).includes('failed to purge audit entry'))).toBe(true);
  });

  it('refuses to purge an entry with an unparseable timestamp', async () => {
    const store = new FakeAuditStore([entry('01A', 'not-a-date')]);
    const warns: unknown[][] = [];
    const result = await purgeExpiredAuditEntries({
      audit: store,
      retentionMs: THIRTY_DAYS,
      now: () => NOW,
      logger: { warn: (...a: unknown[]) => warns.push(a) }
    });
    expect(result.purged).toBe(0);
    expect(store.live).toEqual(['01A']);
    expect(warns.some((w) => String(w[0]).includes('unparseable timestamp'))).toBe(true);
  });

  it('pages through more than one page of expired entries', async () => {
    // 250 expired entries (> SCAN_PAGE_SIZE of 200) force a second page.
    const many = Array.from({ length: 250 }, (_, i) =>
      entry(`01${String(i).padStart(4, '0')}`, '2026-01-01T00:00:00.000Z')
    );
    const store = new FakeAuditStore(many);
    const result = await purgeExpiredAuditEntries({
      audit: store,
      retentionMs: THIRTY_DAYS,
      now: () => NOW
    });
    expect(result.purged).toBe(250);
    expect(store.live).toHaveLength(0);
  });
});

describe('AuditRetentionPurgeLoop — unref, overlap guard, skip-when-unset (#566)', () => {
  it("installs an unref'd, overlap-guarded interval and skips the sweep when retention is unset", () => {
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
      const loop = new AuditRetentionPurgeLoop({
        retentionMs: () => 30_000,
        sweepDeps: {
          audit: {
            listOldestPage: async () => [],
            purgeEntry: async () => false
          }
        }
      });
      const tickSpy = vi
        .spyOn(loop, 'tick')
        .mockImplementation(() => new Promise<void>((res) => { resolveTick = res; }));

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
    const store = new FakeAuditStore([entry('01A', '2026-01-01T00:00:00.000Z')]);
    let retention = 0; // disabled
    const loop = new AuditRetentionPurgeLoop({
      retentionMs: () => retention,
      sweepDeps: { audit: store, now: () => NOW } as ConstructorParameters<
        typeof AuditRetentionPurgeLoop
      >[0]['sweepDeps']
    });

    await loop.tick();
    expect(store.live).toEqual(['01A']); // disabled: nothing purged

    // Hot-enable (as PATCH /retention/config would): the next tick purges it.
    retention = THIRTY_DAYS;
    await loop.tick();
    expect(store.live).toHaveLength(0);
  });
});

describe('auditPurgeIntervalMsFromEnv (#566)', () => {
  const original = process.env['AUDIT_PURGE_INTERVAL_MS'];
  const restore = () => {
    if (original === undefined) delete process.env['AUDIT_PURGE_INTERVAL_MS'];
    else process.env['AUDIT_PURGE_INTERVAL_MS'] = original;
  };

  it('defaults when unset and honours a positive override', () => {
    delete process.env['AUDIT_PURGE_INTERVAL_MS'];
    expect(auditPurgeIntervalMsFromEnv()).toBe(DEFAULT_AUDIT_PURGE_INTERVAL_MS);
    process.env['AUDIT_PURGE_INTERVAL_MS'] = '5000';
    expect(auditPurgeIntervalMsFromEnv()).toBe(5000);
    process.env['AUDIT_PURGE_INTERVAL_MS'] = 'nope';
    expect(auditPurgeIntervalMsFromEnv()).toBe(DEFAULT_AUDIT_PURGE_INTERVAL_MS);
    restore();
  });
});
