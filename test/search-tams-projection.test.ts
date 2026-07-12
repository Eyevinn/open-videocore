// TAMS addressing projection into the search index (issue #168, sub-task of the
// #116 TAMS bridge epic).
//
// Discovery note: ADR-005 describes a PostgreSQL search index fed from the
// CouchDB `_changes` feed, but that projector does NOT exist in this codebase
// yet (couch-asset-repo.ts: "Full-text search proper is delegated to the
// PostgreSQL index in a later issue"). The search index that DOES exist is the
// SearchRepository layer: the pure `matchesQuery` predicate (shared by the
// in-memory and CouchDB fallback paths) over assets projected via
// fromAssetDocument. Decision: INDEX the TAMS fields at that layer (see the PR
// note + code comments in search-repo.ts / couch-search-repo.ts). These tests
// prove the projection is:
//   1. idempotent — re-running the same query over the same asset yields the
//      same match result (matchesQuery is pure; no state added), which is what
//      "rebuildable from sequence 0 / re-projection yields the same row" means
//      at this layer; and
//   2. clean for legacy assets — an asset written before #165 (no tams* fields)
//      projects and queries without error and simply does not match TAMS filters.
//
// Symbols under test:
//   - src/data/search-repo.ts: SearchQuery.tamsFlowId / .tamsTimerange,
//     assetTamsFlowIds, assetTamsTimerange, matchesQuery
//   - asset fields (asset-repo.ts): Asset.tamsFlowIds: string[],
//     Asset.tamsTimerange: string

import { describe, it, expect } from 'vitest';
import {
  matchesQuery,
  assetTamsFlowIds,
  assetTamsTimerange,
  type SearchQuery
} from '../src/data/search-repo.js';
import type { Asset } from '../src/data/asset-repo.js';

const FLOW_A = '11111111-1111-1111-1111-111111111111';
const FLOW_B = '22222222-2222-2222-2222-222222222222';
const TIMERANGE = '[0:0_10:0)';

// Minimal asset factory. `tams` overrides the two projected addressing fields;
// omitting them models a legacy (pre-#165) asset where both are absent.
function asset(tams?: { tamsFlowIds?: string[]; tamsTimerange?: string }): Asset {
  return {
    id: 'asset-1',
    name: 'A clip',
    status: 'ready' as Asset['status'],
    statusHistory: [],
    technicalMetadata: null,
    provenance: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    ...(tams ?? {})
  } as Asset;
}

describe('TAMS addressing projection accessors (issue #168)', () => {
  it('projects flow ids and timerange from an addressed asset', () => {
    const a = asset({ tamsFlowIds: [FLOW_A, FLOW_B], tamsTimerange: TIMERANGE });
    expect(assetTamsFlowIds(a)).toEqual([FLOW_A, FLOW_B]);
    expect(assetTamsTimerange(a)).toBe(TIMERANGE);
  });

  it('projects a legacy asset (no TAMS fields) cleanly to empty/undefined', () => {
    const legacy = asset();
    expect(assetTamsFlowIds(legacy)).toEqual([]);
    expect(assetTamsTimerange(legacy)).toBeUndefined();
  });

  it('filters out non-string flow ids defensively', () => {
    const messy = asset({ tamsFlowIds: [FLOW_A, undefined as unknown as string, 42 as unknown as string] });
    expect(assetTamsFlowIds(messy)).toEqual([FLOW_A]);
  });
});

describe('TAMS addressing lookup via matchesQuery (issue #168)', () => {
  it('matches an asset carrying the requested flow id', () => {
    const a = asset({ tamsFlowIds: [FLOW_A, FLOW_B] });
    expect(matchesQuery(a, { tamsFlowId: FLOW_A })).toBe(true);
    expect(matchesQuery(a, { tamsFlowId: FLOW_B })).toBe(true);
  });

  it('does not match a flow id the asset does not carry', () => {
    const a = asset({ tamsFlowIds: [FLOW_A] });
    expect(matchesQuery(a, { tamsFlowId: FLOW_B })).toBe(false);
  });

  it('matches an exact timerange and rejects a different one', () => {
    const a = asset({ tamsTimerange: TIMERANGE });
    expect(matchesQuery(a, { tamsTimerange: TIMERANGE })).toBe(true);
    expect(matchesQuery(a, { tamsTimerange: '[0:0_20:0)' })).toBe(false);
  });

  it('applies flow id and timerange together (AND semantics)', () => {
    const a = asset({ tamsFlowIds: [FLOW_A], tamsTimerange: TIMERANGE });
    expect(matchesQuery(a, { tamsFlowId: FLOW_A, tamsTimerange: TIMERANGE })).toBe(true);
    expect(matchesQuery(a, { tamsFlowId: FLOW_A, tamsTimerange: '[0:0_20:0)' })).toBe(false);
    expect(matchesQuery(a, { tamsFlowId: FLOW_B, tamsTimerange: TIMERANGE })).toBe(false);
  });

  it('a legacy asset (no TAMS fields) never matches a TAMS filter but is unaffected otherwise', () => {
    const legacy = asset();
    expect(matchesQuery(legacy, { tamsFlowId: FLOW_A })).toBe(false);
    expect(matchesQuery(legacy, { tamsTimerange: TIMERANGE })).toBe(false);
    // No TAMS filter -> the legacy asset still matches (projection is additive).
    expect(matchesQuery(legacy, {})).toBe(true);
  });
});

describe('idempotent re-projection (issue #168 — replayable/rebuildable)', () => {
  // "Rebuildable from sequence 0" at this layer means: projecting the same asset
  // record again produces the same indexed match result. matchesQuery is pure
  // over the asset and holds no cross-call state, so N re-projections are equal.
  it('re-projecting the same asset yields the same match result every time', () => {
    const a = asset({ tamsFlowIds: [FLOW_A], tamsTimerange: TIMERANGE });
    const query: SearchQuery = { tamsFlowId: FLOW_A, tamsTimerange: TIMERANGE };
    const runs = Array.from({ length: 5 }, () => matchesQuery(a, query));
    expect(runs).toEqual([true, true, true, true, true]);
    expect(assetTamsFlowIds(a)).toEqual(assetTamsFlowIds(a));
    expect(assetTamsTimerange(a)).toBe(assetTamsTimerange(a));
  });

  it('re-projection does not mutate the source asset (no state introduced)', () => {
    const a = asset({ tamsFlowIds: [FLOW_A], tamsTimerange: TIMERANGE });
    const before = JSON.stringify(a);
    matchesQuery(a, { tamsFlowId: FLOW_A });
    matchesQuery(a, { tamsFlowId: FLOW_A });
    expect(JSON.stringify(a)).toBe(before);
  });
});
