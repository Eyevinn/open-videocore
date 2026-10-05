// @vitest-environment happy-dom
//
// Whole-row activation on the collections list (issue #917).
//
// Before this change a collection row opened its detail panel ONLY via the View
// button (public/app.js:3992 as it now stands), clicking anywhere else on the row
// did nothing, and the rows were not in the keyboard tab order at all. These
// tests drive the REAL Collections tab (public/app.js renderCollectionsTab)
// against a stubbed fetch, so the assertions are against the markup and handlers
// the operator actually gets, not a reconstruction of them.
//
// Verified contract (per CLAUDE.md rule 7) — read before editing the renderer:
//   - List row markup + the View button it must not fight with:
//     public/app.js:3986-3995 (the `<tr class="coll-row" ... tabindex="0">`
//     template; View at :3992, Delete at :3993) and public/app.js:4009-4011
//     (row activation wired alongside the per-button handlers at :4013-4016).
//     The row has FIVE cells — ID, Name, Asset count, Created, Actions — per the
//     thead at public/app.js:4001.
//   - Row activation helper: wireCollectionRowActivation (public/app.js:3878) and
//     the inner-control guard COLLECTION_ROW_CONTROL_SELECTOR (:3859).
//   - Detail panel entry point: showCollectionDetail(id, detailPanel, onRefresh)
//     at public/app.js:4439, which sets `detailPanel.style.display = 'block'`
//     (:4440) and renders `#coll-detail-body` before fetching
//     GET /collections/{id} (:4460).
//   - List response shape: GET /api/v1/collections returns the array under
//     `items`/`collections` or bare (public/app.js:3949), with
//     `id`, `name`, `createdAt`, `assetIds`, `deleteLock` per collectionSchema
//     (src/routes/collections.ts:80-91). `assets` is only on the single-collection
//     response (collectionWithAssetsSchema, src/routes/collections.ts:96-98),
//     which is why the row renders `assetIds.length`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderCollectionsTab, COLLECTION_ROW_CONTROL_SELECTOR } from '../public/app.js';

const COLLECTIONS = [
  {
    id: '01HZX0000000000000000000A1',
    name: 'Season one promos',
    createdAt: '2026-05-01T10:00:00.000Z',
    assetIds: ['01HZASSET0000000000000001'],
    deleteLock: { locked: false },
  },
  {
    id: '01HZX0000000000000000000B2',
    name: 'Archive candidates',
    createdAt: '2026-05-02T10:00:00.000Z',
    assetIds: [],
    deleteLock: { locked: false },
  },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function settle(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('collection row is clickable and keyboard-focusable (issue #917)', () => {
  let container: HTMLElement;
  let detailFetches: string[];

  beforeEach(async () => {
    detailFetches = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = String(url);
        const match = path.match(/\/collections\/([^/?]+)$/);
        if (match) {
          detailFetches.push(decodeURIComponent(match[1]));
          const coll = COLLECTIONS.find((c) => c.id === decodeURIComponent(match[1]));
          return jsonResponse({ ...coll, assets: [] });
        }
        if (path.includes('/collections')) return jsonResponse({ items: COLLECTIONS });
        // Any other call the tab makes (e.g. the picker's search) is irrelevant
        // here; answer it with an empty envelope rather than letting it throw.
        return jsonResponse({ assets: [], collections: [], total: 0, collectionTotal: 0, page: 0 });
      }),
    );

    container = document.createElement('div');
    document.body.appendChild(container);
    await renderCollectionsTab(container);
    await settle();
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function rows(): HTMLTableRowElement[] {
    return Array.from(container.querySelectorAll<HTMLTableRowElement>('tr.coll-row'));
  }

  function detailPanel(): HTMLElement {
    const panel = container.querySelector<HTMLElement>('#coll-detail');
    if (!panel) throw new Error('collection detail panel missing');
    return panel;
  }

  it('renders one activatable row per collection', () => {
    expect(rows().map((tr) => tr.dataset.id)).toEqual(COLLECTIONS.map((c) => c.id));
  });

  it('opens the detail when a non-control cell is clicked', async () => {
    const nameCell = rows()[1].querySelectorAll('td')[1];
    expect(nameCell.textContent).toContain('Archive candidates');

    nameCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(detailFetches).toEqual([COLLECTIONS[1].id]);
    expect(detailPanel().style.display).toBe('block');
  });

  it('still opens the detail from the View button, and only once', async () => {
    const view = rows()[0].querySelector<HTMLButtonElement>('.coll-view-btn');
    expect(view).not.toBeNull();

    view!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    // One fetch, not two: the row handler must ignore an event that originated
    // on an inner control, so View does not double-trigger navigation.
    expect(detailFetches).toEqual([COLLECTIONS[0].id]);
  });

  it('does not navigate when the Delete button inside a row is clicked', async () => {
    const del = rows()[0].querySelector<HTMLButtonElement>('.coll-delete-btn');
    expect(del).not.toBeNull();

    del!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(detailFetches).toEqual([]);
  });

  it('puts every row in the keyboard tab order', () => {
    rows().forEach((tr) => {
      expect(tr.getAttribute('tabindex')).toBe('0');
      expect(tr.tabIndex).toBe(0);
    });
  });

  it('activates on Enter when the row itself has focus', async () => {
    const tr = rows()[0];
    tr.focus();
    tr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(detailFetches).toEqual([COLLECTIONS[0].id]);
  });

  it('activates on Space and suppresses the page scroll', async () => {
    const tr = rows()[1];
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    tr.dispatchEvent(event);
    await settle();

    expect(detailFetches).toEqual([COLLECTIONS[1].id]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores an Enter keydown that originated on an inner control', async () => {
    // The View button handles its own Enter natively (producing a click). If the
    // row also acted on the bubbled keydown, the detail would be fetched twice.
    const view = rows()[0].querySelector<HTMLButtonElement>('.coll-view-btn')!;
    view.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(detailFetches).toEqual([]);
  });

  it('marks the activated row as selected, one at a time', async () => {
    rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(rows()[0].classList.contains('row-selected')).toBe(true);

    rows()[1].querySelectorAll('td')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(rows()[1].classList.contains('row-selected')).toBe(true);
    expect(rows()[0].classList.contains('row-selected')).toBe(false);
  });

  it('treats the row controls it must not hijack as controls', () => {
    const view = rows()[0].querySelector<HTMLButtonElement>('.coll-view-btn')!;
    const del = rows()[0].querySelector<HTMLButtonElement>('.coll-delete-btn')!;
    expect(view.closest(COLLECTION_ROW_CONTROL_SELECTOR)).toBe(view);
    expect(del.closest(COLLECTION_ROW_CONTROL_SELECTOR)).toBe(del);
    // A plain cell is not a control, so clicking it activates the row.
    expect(rows()[0].querySelectorAll('td')[1].closest(COLLECTION_ROW_CONTROL_SELECTOR)).toBeNull();
  });
});
