// Tests for backfillTamsIndex (issue #173).
//
// The function is tested against a FAKE lister (implementing the verified
// `AssetLister.list(opts?) => Promise<ListResult>` subset of AssetRepository,
// src/data/asset-repo.ts line ~512) and a MOCK indexer. We assert the four
// acceptance behaviours: unconfigured no-op, configured full index of ready
// assets only, idempotency reliance (running twice), and per-asset failure
// isolation.
//
// `process.env.TAMS_STORE_URL` is manipulated and restored per the ADR-009 gate
// grammar (`typeof v==='string' && v.trim().length>0`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backfillTamsIndex,
  type AssetLister,
  type BackfillLogger,
  type SingleAssetIndexer
} from './tams-backfill.js';
import type { Asset, AssetStatus, ListOptions, ListResult } from '../data/asset-repo.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Minimal Asset builder — only the fields the backfill reads (`id`, `status`)
// need to be meaningful; the rest are filled to satisfy the `Asset` type.
function makeAsset(id: string, status: AssetStatus): Asset {
  const now = '2026-07-12T00:00:00.000Z';
  return {
    id,
    name: `asset-${id}`,
    status,
    statusHistory: [{ at: now, from: null, to: 'uploading' }],
    createdAt: now,
    updatedAt: now
  };
}

// A fake lister backed by a fixed asset array. Honours the `status`, `limit`,
// and `offset` fields of ListOptions exactly like InMemoryAssetRepository.list
// (src/data/asset-repo.ts line ~827), so paging + server-side status filtering
// are exercised. Records every `list` call for assertions.
function makeLister(assets: Asset[]): AssetLister & { calls: ListOptions[] } {
  const calls: ListOptions[] = [];
  return {
    calls,
    async list(opts: ListOptions = {}): Promise<ListResult> {
      calls.push(opts);
      let all = assets;
      if (opts.status) {
        all = all.filter((a) => a.status === opts.status);
      }
      const limit = opts.limit ?? 50;
      const offset = opts.offset ?? 0;
      const items = all.slice(offset, offset + limit);
      return { items, limit, offset, total: all.length };
    }
  };
}

function makeLogger(): BackfillLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const ORIGINAL_TAMS_STORE_URL = process.env.TAMS_STORE_URL;

beforeEach(() => {
  delete process.env.TAMS_STORE_URL;
});

afterEach(() => {
  if (ORIGINAL_TAMS_STORE_URL === undefined) {
    delete process.env.TAMS_STORE_URL;
  } else {
    process.env.TAMS_STORE_URL = ORIGINAL_TAMS_STORE_URL;
  }
});

// ---------------------------------------------------------------------------
// (a) unconfigured -> indexer never called, no-op summary
// ---------------------------------------------------------------------------

describe('backfillTamsIndex — unconfigured (no-op)', () => {
  it('does not call the indexer and returns an all-zero summary when TAMS_STORE_URL is unset', async () => {
    const lister = makeLister([makeAsset('a1', 'ready'), makeAsset('a2', 'ready')]);
    const indexer = vi.fn<SingleAssetIndexer>(async () => {});
    const logger = makeLogger();

    // env unset (deleted in beforeEach).
    const summary = await backfillTamsIndex({ lister, indexer, logger });

    expect(indexer).not.toHaveBeenCalled();
    expect(summary).toEqual({
      configured: false,
      total: 0,
      indexed: 0,
      skipped: 0,
      failed: []
    });
    // Never even enumerates.
    expect(lister.calls).toHaveLength(0);
  });

  it('treats a blank/whitespace TAMS_STORE_URL as unconfigured (ADR-009 gate)', async () => {
    process.env.TAMS_STORE_URL = '   ';
    const lister = makeLister([makeAsset('a1', 'ready')]);
    const indexer = vi.fn<SingleAssetIndexer>(async () => {});
    const logger = makeLogger();

    const summary = await backfillTamsIndex({ lister, indexer, logger });

    expect(indexer).not.toHaveBeenCalled();
    expect(summary.configured).toBe(false);
  });

  it('honours an injected env over process.env', async () => {
    // process.env unset, but injected env is configured.
    const lister = makeLister([makeAsset('a1', 'ready')]);
    const indexer = vi.fn<SingleAssetIndexer>(async () => {});
    const logger = makeLogger();

    const summary = await backfillTamsIndex({
      lister,
      indexer,
      logger,
      env: { TAMS_STORE_URL: 'https://tams.example' }
    });

    expect(indexer).toHaveBeenCalledTimes(1);
    expect(summary.configured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) configured -> every ready asset indexed once, non-ready skipped
// ---------------------------------------------------------------------------

describe('backfillTamsIndex — configured', () => {
  beforeEach(() => {
    process.env.TAMS_STORE_URL = 'https://tams.example';
  });

  it('indexes every ready asset exactly once and skips non-ready assets', async () => {
    const assets = [
      makeAsset('ready-1', 'ready'),
      makeAsset('uploading-1', 'uploading'),
      makeAsset('ready-2', 'ready'),
      makeAsset('processing-1', 'processing'),
      makeAsset('failed-1', 'failed'),
      makeAsset('archived-1', 'archived'),
      makeAsset('ready-3', 'ready')
    ];
    const lister = makeLister(assets);
    const seen: string[] = [];
    const indexer = vi.fn<SingleAssetIndexer>(async (a) => {
      seen.push(a.id);
    });
    const logger = makeLogger();

    const summary = await backfillTamsIndex({ lister, indexer, logger });

    // Only the three ready assets, each once.
    expect(indexer).toHaveBeenCalledTimes(3);
    expect(seen.sort()).toEqual(['ready-1', 'ready-2', 'ready-3']);
    expect(summary).toEqual({
      configured: true,
      total: 3,
      indexed: 3,
      skipped: 0,
      failed: []
    });
    // Enumeration used the server-side status filter.
    expect(lister.calls[0]?.status).toBe('ready');
  });

  it('pages through more ready assets than one page holds', async () => {
    // 5 ready assets with a page size of 2 -> 3 pages (2, 2, 1).
    const assets = Array.from({ length: 5 }, (_, i) => makeAsset(`r${i}`, 'ready'));
    const lister = makeLister(assets);
    const indexer = vi.fn<SingleAssetIndexer>(async () => {});
    const logger = makeLogger();

    const summary = await backfillTamsIndex({ lister, indexer, logger, pageSize: 2 });

    expect(indexer).toHaveBeenCalledTimes(5);
    expect(summary.indexed).toBe(5);
    expect(summary.total).toBe(5);
    // 3 list calls with advancing offsets.
    expect(lister.calls.map((c) => c.offset)).toEqual([0, 2, 4]);
  });

  it('is a clean no-op summary when there are no ready assets', async () => {
    const lister = makeLister([makeAsset('u', 'uploading')]);
    const indexer = vi.fn<SingleAssetIndexer>(async () => {});
    const logger = makeLogger();

    const summary = await backfillTamsIndex({ lister, indexer, logger });

    expect(indexer).not.toHaveBeenCalled();
    expect(summary).toEqual({
      configured: true,
      total: 0,
      indexed: 0,
      skipped: 0,
      failed: []
    });
  });
});

// ---------------------------------------------------------------------------
// (c) idempotency relied upon: running twice is safe + stable summary
// ---------------------------------------------------------------------------

describe('backfillTamsIndex — idempotency reliance', () => {
  beforeEach(() => {
    process.env.TAMS_STORE_URL = 'https://tams.example';
  });

  it('running twice calls the (idempotent) indexer again without error and yields a stable summary', async () => {
    const assets = [makeAsset('ready-1', 'ready'), makeAsset('ready-2', 'ready')];
    const lister = makeLister(assets);
    // Idempotent upsert stand-in: safe to call repeatedly with the same asset.
    const store = new Set<string>();
    const indexer = vi.fn<SingleAssetIndexer>(async (a) => {
      store.add(a.id); // upsert: second write is a no-op on the set
    });
    const logger = makeLogger();

    const first = await backfillTamsIndex({ lister, indexer, logger });
    const second = await backfillTamsIndex({ lister, indexer, logger });

    // The backfill re-invokes the indexer on the second run (it relies on the
    // indexer's own idempotency, it does not skip already-indexed assets).
    expect(indexer).toHaveBeenCalledTimes(4);
    // Upsert converged: still just the two ids.
    expect([...store].sort()).toEqual(['ready-1', 'ready-2']);
    // Summary is stable across runs.
    expect(second).toEqual(first);
    expect(first).toEqual({
      configured: true,
      total: 2,
      indexed: 2,
      skipped: 0,
      failed: []
    });
  });
});

// ---------------------------------------------------------------------------
// (d) per-asset failure isolation: one throw -> recorded, others still index
// ---------------------------------------------------------------------------

describe('backfillTamsIndex — per-asset failure isolation', () => {
  beforeEach(() => {
    process.env.TAMS_STORE_URL = 'https://tams.example';
  });

  it('records a throwing asset in failed[] and continues indexing the rest', async () => {
    const assets = [
      makeAsset('ok-1', 'ready'),
      makeAsset('boom', 'ready'),
      makeAsset('ok-2', 'ready')
    ];
    const lister = makeLister(assets);
    const indexed: string[] = [];
    const indexer = vi.fn<SingleAssetIndexer>(async (a) => {
      if (a.id === 'boom') {
        throw new Error('gateway 500');
      }
      indexed.push(a.id);
    });
    const logger = makeLogger();

    const summary = await backfillTamsIndex({ lister, indexer, logger });

    // Attempted all three; the good two indexed.
    expect(indexer).toHaveBeenCalledTimes(3);
    expect(indexed.sort()).toEqual(['ok-1', 'ok-2']);
    expect(summary.total).toBe(3);
    expect(summary.indexed).toBe(2);
    expect(summary.failed).toEqual([{ assetId: 'boom', error: 'gateway 500' }]);
    // The failure was logged as a structured error.
    expect(logger.error).toHaveBeenCalledWith(
      'tams-backfill: index failed',
      expect.objectContaining({ assetId: 'boom', error: 'gateway 500' })
    );
  });

  it('normalizes a non-Error throw into a string message and does not abort', async () => {
    const assets = [makeAsset('ok', 'ready'), makeAsset('weird', 'ready')];
    const lister = makeLister(assets);
    const indexer = vi.fn<SingleAssetIndexer>(async (a) => {
      if (a.id === 'weird') {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'not-an-error';
      }
    });
    const logger = makeLogger();

    const summary = await backfillTamsIndex({ lister, indexer, logger });

    expect(summary.indexed).toBe(1);
    expect(summary.failed).toEqual([{ assetId: 'weird', error: 'not-an-error' }]);
  });
});
