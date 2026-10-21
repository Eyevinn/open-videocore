// Abandoned-upload settle sweep + loop (issue #726).
//
// Covers exactly the acceptance criteria and the reviewer's requested cases:
//   (a) an untouched-but-still-PROGRESSING upload (updatedAt refreshed within the
//       threshold, as the #731 heartbeat does) is NEVER settled;
//   (b) threshold = 0 disables the sweep entirely (never settle);
//   (c) the fresh-read re-check guard leaves alone a record that advanced (was
//       heartbeat-touched) between the page snapshot and the settle write;
//   (d) an eligible abandoned upload (updatedAt older than the threshold) is
//       settled to `failed` with an `uploading -> failed` statusHistory entry;
//   plus best-effort-skip semantics, the env parsers, and the loop's
//   unref/overlap-guard/skip-when-disabled behaviour.
//
// The sweep is exercised through the SAME InMemoryAssetRepository the read-path
// tests use, so create()/get()/list()/update() and the `uploading -> failed`
// transition behave exactly as in prod. `updatedAt` is controlled by reaching
// into the in-memory store (mirroring archived-asset-purge-sweep.test.ts), which
// is what the real #731 heartbeat (touchUploadProgress) moves forward in prod.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - settleAbandonedUploads deps/result + fresh-read guard:
//     src/pipeline/abandoned-upload-sweep.ts:88-159
//   - InMemoryAssetRepository.create/get/list/update + updatedAt semantics:
//     src/data/asset-repo.ts:1287-1341,1436-1545
//   - touchUploadProgress heartbeat (no-op off `uploading`, only bumps updatedAt):
//     src/data/asset-repo.ts:1553-1565
//   - uploading -> failed allowed + applyStatus appends the transition:
//     src/data/asset-repo.ts:35,1101-1116; StatusTransition shape: :91-95
//   - loop exports + env parsers: src/pipeline/abandoned-upload-loop.ts:33-151

import { describe, it, expect, vi } from 'vitest';

import {
  InMemoryAssetRepository,
  type Asset
} from '../src/data/asset-repo.js';
import {
  settleAbandonedUploads
} from '../src/pipeline/abandoned-upload-sweep.js';
import {
  AbandonedUploadSweepLoop,
  abandonedUploadIntervalMsFromEnv,
  abandonedUploadThresholdMsFromEnv,
  DEFAULT_ABANDONED_UPLOAD_INTERVAL_MS,
  DEFAULT_ABANDONED_UPLOAD_THRESHOLD_MS
} from '../src/pipeline/abandoned-upload-loop.js';

// A fixed clock so eligibility is deterministic. The sweep computes
// cutoff = now - thresholdMs and settles an asset whose updatedAt <= cutoff.
const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
// cutoff = 2026-05-31T00:00:00.000Z
const OLD_UPDATED_AT = '2026-05-01T00:00:00.000Z'; // well before cutoff -> eligible
const FRESH_UPDATED_AT = '2026-06-01T00:00:00.000Z'; // == now -> NOT eligible

// Create an asset (starts in `uploading`) and stamp its `updatedAt`
// deterministically by reaching into the in-memory store — exactly the value the
// #731 heartbeat (touchUploadProgress) would leave. create() itself stamps a
// real-time updatedAt, so we overwrite it for a controlled liveness age.
async function makeUploading(
  repo: InMemoryAssetRepository,
  name: string,
  updatedAt: string
): Promise<Asset> {
  const created = await repo.create({ name, objectKey: `sources/${name}` });
  const current = (await repo.get(created.id))!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (repo as any).store.set(created.id, { ...current, updatedAt });
  return (await repo.get(created.id))!;
}

describe('settleAbandonedUploads — eligibility (#726)', () => {
  it('(d) settles an abandoned upload (updatedAt past the threshold) to failed with an uploading -> failed history entry', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await makeUploading(repo, 'abandoned', OLD_UPDATED_AT);

    const result = await settleAbandonedUploads({
      assets: repo,
      thresholdMs: THRESHOLD_MS,
      now: () => NOW
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });

    const settled = (await repo.get(asset.id))!;
    expect(settled.status).toBe('failed');
    // The appended transition is specifically `uploading -> failed` — the durable
    // evidence that the UPLOAD (not processing) did not complete.
    const last = settled.statusHistory[settled.statusHistory.length - 1];
    expect(last.from).toBe('uploading');
    expect(last.to).toBe('failed');
    // It is no longer enumerated as `uploading`.
    expect((await repo.list({ status: 'uploading', limit: 100 })).total).toBe(0);
  });

  it('(a) does NOT settle an untouched-but-still-progressing upload whose updatedAt was refreshed within the threshold', async () => {
    const repo = new InMemoryAssetRepository();
    // A heartbeat (#731) has just moved updatedAt forward, inside the window.
    const asset = await makeUploading(repo, 'progressing', FRESH_UPDATED_AT);

    const result = await settleAbandonedUploads({
      assets: repo,
      thresholdMs: THRESHOLD_MS,
      now: () => NOW
    });

    expect(result).toEqual({ scanned: 1, settled: 0 });
    expect((await repo.get(asset.id))!.status).toBe('uploading');
  });

  it('refuses to settle an asset with an unparseable updatedAt (never settle on a bad date)', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await makeUploading(repo, 'baddate', 'not-a-date');

    const result = await settleAbandonedUploads({
      assets: repo,
      thresholdMs: THRESHOLD_MS,
      now: () => NOW
    });

    expect(result).toEqual({ scanned: 1, settled: 0 });
    expect((await repo.get(asset.id))!.status).toBe('uploading');
  });
});

describe('settleAbandonedUploads — disabled threshold (#726)', () => {
  it('(b) is a no-op when the threshold is 0 (never settle)', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await makeUploading(repo, 'old', OLD_UPDATED_AT);

    const result = await settleAbandonedUploads({
      assets: repo,
      thresholdMs: 0,
      now: () => NOW
    });

    expect(result).toEqual({ scanned: 0, settled: 0 });
    expect((await repo.get(asset.id))!.status).toBe('uploading');
  });

  it('is a no-op for a negative or non-finite threshold', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await makeUploading(repo, 'old', OLD_UPDATED_AT);

    expect(
      await settleAbandonedUploads({ assets: repo, thresholdMs: -1, now: () => NOW })
    ).toEqual({ scanned: 0, settled: 0 });
    expect(
      await settleAbandonedUploads({ assets: repo, thresholdMs: NaN, now: () => NOW })
    ).toEqual({ scanned: 0, settled: 0 });
    expect((await repo.get(asset.id))!.status).toBe('uploading');
  });
});

describe('settleAbandonedUploads — fresh-read re-check guard (#726)', () => {
  it('(c) leaves alone a record that advanced (heartbeat-touched) between the page snapshot and the settle write', async () => {
    const repo = new InMemoryAssetRepository();
    // The page snapshot will see an OLD (eligible) updatedAt...
    const asset = await makeUploading(repo, 'racing', OLD_UPDATED_AT);

    // ...but between the snapshot and the settle write a heartbeat lands, moving
    // updatedAt inside the window. Model that by having the fresh get() observe a
    // refreshed stamp (the sweep re-reads via get() immediately before writing).
    const realGet = repo.get.bind(repo);
    const getSpy = vi.spyOn(repo, 'get').mockImplementation(async (id: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (repo as any).store as Map<string, Asset>;
      const cur = store.get(id);
      if (cur && cur.status === 'uploading') {
        store.set(id, { ...cur, updatedAt: FRESH_UPDATED_AT });
      }
      return realGet(id);
    });

    try {
      const result = await settleAbandonedUploads({
        assets: repo,
        thresholdMs: THRESHOLD_MS,
        now: () => NOW
      });

      // Scanned (it was eligible in the snapshot) but NOT settled — the fresh
      // re-read showed it had advanced back inside the window.
      expect(result).toEqual({ scanned: 1, settled: 0 });
      expect(getSpy).toHaveBeenCalledWith(asset.id);
      expect((await realGet(asset.id))!.status).toBe('uploading');
    } finally {
      getSpy.mockRestore();
    }
  });

  it('leaves alone a record that left `uploading` between the snapshot and the write', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await makeUploading(repo, 'completed', OLD_UPDATED_AT);

    // Simulate the upload completing (uploading -> processing) between snapshot
    // and settle: the fresh get() observes it is no longer `uploading`.
    const realGet = repo.get.bind(repo);
    const getSpy = vi.spyOn(repo, 'get').mockImplementationOnce(async (id: string) => {
      await repo.update(id, { status: 'processing' });
      return realGet(id);
    });

    try {
      const result = await settleAbandonedUploads({
        assets: repo,
        thresholdMs: THRESHOLD_MS,
        now: () => NOW
      });
      expect(result).toEqual({ scanned: 1, settled: 0 });
      expect((await realGet(asset.id))!.status).toBe('processing');
    } finally {
      getSpy.mockRestore();
    }
  });
});

describe('settleAbandonedUploads — best-effort per asset (#726)', () => {
  it('logs and skips one asset whose settle throws, and still settles the rest', async () => {
    const repo = new InMemoryAssetRepository();
    const good = await makeUploading(repo, 'good', OLD_UPDATED_AT);
    const bad = await makeUploading(repo, 'bad', OLD_UPDATED_AT);

    const realUpdate = repo.update.bind(repo);
    vi.spyOn(repo, 'update').mockImplementation(async (id: string, patch) => {
      if (id === bad.id) throw new Error('couch conflict');
      return realUpdate(id, patch);
    });

    const warns: unknown[][] = [];
    try {
      const result = await settleAbandonedUploads({
        assets: repo,
        thresholdMs: THRESHOLD_MS,
        now: () => NOW,
        logger: { warn: (...a: unknown[]) => warns.push(a) }
      });

      // Both scanned; only the good one settled; the run did NOT abort.
      expect(result.scanned).toBe(2);
      expect(result.settled).toBe(1);
      expect((await repo.get(good.id))!.status).toBe('failed');
      expect((await repo.get(bad.id))!.status).toBe('uploading'); // retried next tick
      expect(warns.some((w) => String(w[0]).includes('failed to settle asset'))).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('pages through more than one list page of uploading assets', async () => {
    const repo = new InMemoryAssetRepository();
    // 250 > the sweep's 200-per-page SCAN_PAGE_SIZE, so the offset walk must span
    // two pages to cover them all.
    const count = 250;
    for (let i = 0; i < count; i += 1) {
      await makeUploading(repo, `bulk-${String(i).padStart(3, '0')}`, OLD_UPDATED_AT);
    }

    const result = await settleAbandonedUploads({
      assets: repo,
      thresholdMs: THRESHOLD_MS,
      now: () => NOW
    });

    expect(result).toEqual({ scanned: count, settled: count });
    expect((await repo.list({ status: 'uploading', limit: 1 })).total).toBe(0);
  });
});

describe('abandonedUploadThresholdMsFromEnv (#726)', () => {
  const KEY = 'ABANDONED_UPLOAD_THRESHOLD_MS';
  const original = process.env[KEY];
  const restore = () => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  };

  it('defaults when unset, honours a positive override, and treats 0 as an explicit disable', () => {
    delete process.env[KEY];
    expect(abandonedUploadThresholdMsFromEnv()).toBe(DEFAULT_ABANDONED_UPLOAD_THRESHOLD_MS);

    process.env[KEY] = '3600000';
    expect(abandonedUploadThresholdMsFromEnv()).toBe(3_600_000);

    // 0 is an honoured "disabled" (the sweep no-ops), NOT the default.
    process.env[KEY] = '0';
    expect(abandonedUploadThresholdMsFromEnv()).toBe(0);

    // Non-numeric falls back to the default so a typo never silently disables.
    process.env[KEY] = 'nope';
    expect(abandonedUploadThresholdMsFromEnv()).toBe(DEFAULT_ABANDONED_UPLOAD_THRESHOLD_MS);

    restore();
  });
});

describe('abandonedUploadIntervalMsFromEnv (#726)', () => {
  const KEY = 'ABANDONED_UPLOAD_SWEEP_INTERVAL_MS';
  const original = process.env[KEY];
  const restore = () => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  };

  it('defaults when unset and honours a positive override; non-positive/non-numeric fall back', () => {
    delete process.env[KEY];
    expect(abandonedUploadIntervalMsFromEnv()).toBe(DEFAULT_ABANDONED_UPLOAD_INTERVAL_MS);

    process.env[KEY] = '5000';
    expect(abandonedUploadIntervalMsFromEnv()).toBe(5000);

    process.env[KEY] = '0';
    expect(abandonedUploadIntervalMsFromEnv()).toBe(DEFAULT_ABANDONED_UPLOAD_INTERVAL_MS);

    process.env[KEY] = 'nope';
    expect(abandonedUploadIntervalMsFromEnv()).toBe(DEFAULT_ABANDONED_UPLOAD_INTERVAL_MS);

    restore();
  });
});

describe('AbandonedUploadSweepLoop — unref, overlap guard, skip-when-disabled (#726)', () => {
  it('installs an unref\'d, overlap-guarded interval and is idempotent on start', () => {
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
      const loop = new AbandonedUploadSweepLoop({
        thresholdMs: () => THRESHOLD_MS, // enabled so tick() reaches the sweep
        sweepDeps: { assets: new InMemoryAssetRepository() }
      });
      const tickSpy = vi
        .spyOn(loop, 'tick')
        .mockImplementation(() => new Promise<void>((res) => { resolveTick = res; }));

      loop.start(1000);
      expect(unref).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      // start() is idempotent — no second timer.
      loop.start(1000);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      // First fire -> tick starts (never resolves yet).
      intervalCb?.();
      expect(tickSpy).toHaveBeenCalledTimes(1);
      // Second fire while the first tick is in-flight -> SKIPPED (overlap guard).
      intervalCb?.();
      expect(tickSpy).toHaveBeenCalledTimes(1);
      resolveTick?.();

      loop.stop();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('tick() runs the sweep with the LIVE threshold and skips it entirely when disabled', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await makeUploading(repo, 'old', OLD_UPDATED_AT);

    let threshold = 0; // start disabled
    const loop = new AbandonedUploadSweepLoop({
      thresholdMs: () => threshold,
      sweepDeps: { assets: repo, now: () => NOW }
    });

    // Disabled: tick is a no-op, nothing settled.
    await loop.tick();
    expect((await repo.get(asset.id))!.status).toBe('uploading');

    // Hot-enable the threshold: the next tick settles the abandoned upload with
    // no restart.
    threshold = THRESHOLD_MS;
    await loop.tick();
    expect((await repo.get(asset.id))!.status).toBe('failed');
  });
});
