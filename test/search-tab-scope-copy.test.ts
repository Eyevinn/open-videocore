// @vitest-environment happy-dom
//
// Search-tab scope copy (issue #913).
//
// The Search tab is the only ops-UI surface whose results include collections
// as well as assets, but every label on it said "Search" / "Search assets", so
// an operator had no way to know collections were in scope. These tests pin the
// copy (and that the behaviour it describes is real) so the two cannot drift
// apart again.
//
// ─── Contract grounding (verified before writing, per CLAUDE.md rule 7) ──────
//   - GET /api/v1/search/ (src/routes/search.ts, `app.get('/')` mounted at
//     prefix /api/v1/search; summary "Search assets and collections").
//     openapi.json .paths["/api/v1/search/"].get is the generated mirror.
//   - Response envelope `searchResultSchema` (src/routes/search.ts): required
//     `{ assets, collections, total, collectionTotal, page }`.
//   - Collection hits: `collectionHitSchema` (src/routes/search.ts) carries
//     `type: z.literal('collection')` with id / name / description? / tags? /
//     custom? / createdAt / updatedAt (issue #561). Asset hits are stamped
//     `type: 'asset'` in the route handler's return.
//   - Projection source: `toCollectionHit` (src/data/search-repo.ts) emits
//     `type: 'collection'`.
// The copy change is label-only: this suite also asserts the request the tab
// sends is still the plain `/search?...` query with no new parameters.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  renderSearchTab,
  SEARCH_TAB_TITLE,
  SEARCH_SECTION_TITLE,
  SEARCH_SCOPE_HINT,
} from '../public/app.js';

// One envelope exactly as searchResultSchema defines it: one asset hit and one
// collection hit, each carrying the server's own `type` discriminator.
const ENVELOPE = {
  assets: [
    {
      type: 'asset',
      id: 'asset-1',
      name: 'Probed MP4',
      status: 'ready',
      statusHistory: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  collections: [
    {
      type: 'collection',
      id: 'coll-1',
      name: 'Season one',
      description: 'Every episode',
      tags: ['series'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  total: 1,
  collectionTotal: 1,
  page: 1,
};

let container: HTMLElement;
let requested: string[];

async function runSearch(section: Element): Promise<void> {
  (section.querySelector('#search-btn') as HTMLButtonElement).click();
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('Search tab scope copy (issue #913)', () => {
  beforeEach(async () => {
    requested = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(new URL(url).pathname + new URL(url).search);
      return new Response(JSON.stringify(ENVELOPE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    await renderSearchTab(container);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names collections in the panel heading and section title', () => {
    const heading = container.querySelector('h2.panel-title') as HTMLElement;
    expect(heading.textContent).toBe(SEARCH_TAB_TITLE);

    const sectionTitle = container.querySelector('.section-title') as HTMLElement;
    expect(sectionTitle.textContent).toBe(SEARCH_SECTION_TITLE);
    expect(sectionTitle.textContent).toMatch(/collection/i);
    expect(sectionTitle.textContent).toMatch(/asset/i);
  });

  it('describes the query field as covering assets and collections', () => {
    const hint = container.querySelector('#search-scope-hint') as HTMLElement;
    expect(hint.textContent).toBe(SEARCH_SCOPE_HINT);
    expect(hint.textContent).toMatch(/collection/i);
    expect(hint.textContent).toMatch(/asset/i);

    // The hint is announced with the field it describes, not merely nearby.
    const input = container.querySelector('#search-q') as HTMLInputElement;
    expect(input.getAttribute('aria-describedby')).toBe('search-scope-hint');
  });

  it('still reaches collection results — copy change only', async () => {
    const section = container.querySelector('.section') as HTMLElement;
    (section.querySelector('#search-q') as HTMLInputElement).value = 'season';
    await runSearch(section);

    // The request is the unchanged plain query: `q` and nothing invented.
    expect(requested).toHaveLength(1);
    const url = new URL(requested[0], 'http://localhost');
    expect(url.pathname.endsWith('/search')).toBe(true);
    expect([...url.searchParams.keys()]).toEqual(['q']);
    expect(url.searchParams.get('q')).toBe('season');

    // And the collection hit is still rendered and reachable.
    const rows = container.querySelectorAll('tr.search-hit');
    expect(rows).toHaveLength(2);
    const kinds = Array.from(rows).map((r) => r.getAttribute('data-hit-type'));
    expect(kinds).toContain('collection');
    const summary = container.querySelector('.search-result-summary') as HTMLElement;
    expect(summary.textContent).toMatch(/1 collection/);
  });
});
