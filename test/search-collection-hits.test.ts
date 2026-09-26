// @vitest-environment happy-dom
//
// DOM/unit tests for the Search tab's results view (issue #849): collection hits
// were read out of the response and thrown away, so a collections-only match
// reported "No results."
//
// The repo has no snapshot harness for the vanilla-JS ops UI, so these exercise
// public/app.js's exported pure helpers directly — they take an already-fetched
// response envelope and make no network call.
//
// Verified contract (CLAUDE.md rule 7) — GET /api/v1/search:
//   - src/routes/search.ts `searchResultSchema`: the 200 response is
//     `{ assets, collections, total, collectionTotal, page }`, all five required.
//   - Asset hits: `assetSchema.extend({ type: z.literal('asset') })`, stamped in
//     the route handler (`assets: result.assets.map((a) => ({ ...a, type: 'asset' }))`).
//   - Collection hits: `collectionHitSchema` — `type: z.literal('collection')`,
//     id, name, description?, tags?, custom?, createdAt, updatedAt (issue #561).
//   - `total` counts ASSETS only; `collectionTotal` counts COLLECTIONS.
//   - Mirrored in openapi.json at "/api/v1/search/".get.responses.200, whose
//     required list is ["assets","collections","total","collectionTotal","page"]
//     and whose `type` property is an enum of the single literal on each side.
//   The server-side behaviour itself is covered by test/search-collections.test.ts.

import { describe, expect, it, vi } from 'vitest';
import {
  normaliseSearchResults,
  searchResultSummary,
  renderSearchResults,
} from '../public/app.js';

// An asset hit exactly as the route returns it (trimmed to the fields the row
// renders; every one of these is in assetSchema).
const ASSET_HIT = {
  type: 'asset',
  id: 'asset_01',
  name: 'Search test clip',
  status: 'ready',
  statusHistory: [],
  createdAt: '2026-09-25T10:00:00.000Z',
  updatedAt: '2026-09-25T10:00:00.000Z',
};

// A collection hit exactly as collectionHitSchema describes it.
const COLLECTION_HIT = {
  type: 'collection',
  id: 'coll_01',
  name: 'Search demo collection',
  description: 'Collection used by the search smoke test',
  tags: ['searchdemo'],
  createdAt: '2026-09-24T09:00:00.000Z',
  updatedAt: '2026-09-24T09:00:00.000Z',
};

// The live evidence from the issue: a query matching only collections.
const COLLECTIONS_ONLY = {
  assets: [],
  collections: [COLLECTION_HIT],
  total: 0,
  collectionTotal: 1,
  page: 1,
};

const BOTH = {
  assets: [ASSET_HIT],
  collections: [COLLECTION_HIT],
  total: 1,
  collectionTotal: 1,
  page: 1,
};

const NEITHER = { assets: [], collections: [], total: 0, collectionTotal: 0, page: 1 };

describe('normaliseSearchResults (issue #849)', () => {
  it('reads collections and collectionTotal, not just assets/total', () => {
    const out = normaliseSearchResults(COLLECTIONS_ONLY);
    expect(out.assetTotal).toBe(0);
    expect(out.collectionTotal).toBe(1);
    expect(out.total).toBe(1);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].type).toBe('collection');
    expect(out.rows[0].item.id).toBe('coll_01');
  });

  it('flattens both kinds, keeping the server-stamped discriminator', () => {
    const out = normaliseSearchResults(BOTH);
    expect(out.rows.map((r: { type: string }) => r.type)).toEqual(['asset', 'collection']);
    expect(out.total).toBe(2);
  });

  it('reports zero on both counts for an empty envelope', () => {
    const out = normaliseSearchResults(NEITHER);
    expect(out).toMatchObject({ assetTotal: 0, collectionTotal: 0, total: 0 });
    expect(out.rows).toHaveLength(0);
  });
});

describe('searchResultSummary (issue #849 count covers both kinds)', () => {
  it('counts assets and collections together', () => {
    expect(searchResultSummary(normaliseSearchResults(BOTH))).toBe(
      '2 results (1 asset, 1 collection)'
    );
  });

  it('reports a collections-only match as a result, not zero', () => {
    expect(searchResultSummary(normaliseSearchResults(COLLECTIONS_ONLY))).toBe(
      '1 result (0 assets, 1 collection)'
    );
  });
});

describe('renderSearchResults (issue #849)', () => {
  it('renders the collections of a collections-only match instead of "No results."', () => {
    const el = renderSearchResults(COLLECTIONS_ONLY, {});
    expect(el.querySelector('.empty')).toBeNull();
    expect(el.textContent).not.toContain('No results.');

    const rows = el.querySelectorAll('.search-hit');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-hit-type')).toBe('collection');
    expect(rows[0].textContent).toContain('Search demo collection');
    // The descriptive projection's tags are surfaced on the shared Tags column.
    expect(rows[0].textContent).toContain('searchdemo');
  });

  it('renders both kinds with each row identifiable', () => {
    const el = renderSearchResults(BOTH, {});
    const rows = el.querySelectorAll('.search-hit');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-hit-type')).toBe('asset');
    expect(rows[0].querySelector('.search-hit-type')?.textContent).toBe('Asset');
    expect(rows[1].getAttribute('data-hit-type')).toBe('collection');
    expect(rows[1].querySelector('.search-hit-type')?.textContent).toBe('Collection');
    expect(el.textContent).toContain('2 results (1 asset, 1 collection)');
  });

  it('shows "No results." only when total AND collectionTotal are both 0', () => {
    const empty = renderSearchResults(NEITHER, {}).querySelector('.empty');
    expect(empty?.textContent).toBe('No results.');

    // Counted but not on this page: still not the "nothing matched" message.
    const offPage = renderSearchResults(
      { assets: [], collections: [], total: 0, collectionTotal: 3, page: 9 },
      {}
    ).querySelector('.empty');
    expect(offPage?.textContent).not.toBe('No results.');
  });

  it('routes a collection hit click to the collection, and an asset hit to the asset', () => {
    const onOpenCollection = vi.fn();
    const onOpenAsset = vi.fn();
    const el = renderSearchResults(BOTH, { onOpenAsset, onOpenCollection });
    const links = el.querySelectorAll('.search-hit-link');
    expect(links).toHaveLength(2);

    (links[1] as HTMLElement).click();
    expect(onOpenCollection).toHaveBeenCalledWith('coll_01');
    expect(onOpenAsset).not.toHaveBeenCalled();

    (links[0] as HTMLElement).click();
    expect(onOpenAsset).toHaveBeenCalledWith('asset_01');
    expect(onOpenCollection).toHaveBeenCalledTimes(1);
  });

  it('escapes hit text rather than injecting markup', () => {
    const el = renderSearchResults(
      {
        assets: [],
        collections: [{ ...COLLECTION_HIT, name: '<img src=x onerror=alert(1)>' }],
        total: 0,
        collectionTotal: 1,
        page: 1,
      },
      {}
    );
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
