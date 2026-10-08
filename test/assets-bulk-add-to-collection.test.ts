// @vitest-environment happy-dom
//
// Component-level tests for the Assets-tab bulk "add to collection" action
// (issue #916).
//
// VERIFIED BACKEND CONTRACT (read before these tests were written; the
// assertions below pin the exact wire shape, so a drift fails here):
//   - PUT /api/v1/collections/{id}/assets/{assetId}
//     src/routes/collections.ts:586-620 — `app.put('/:id/assets/:assetId', ...)`
//     declared at :587; schema `params: z.object({ id: z.string(), assetId:
//     z.string() })`, NO body schema, `response: { 200: collectionSchema,
//     404: errorSchema, 422: errorSchema }` (:589-592). Route header comment at
//     src/routes/collections.ts:18. Spec mirror: openapi.json
//     `.paths["/api/v1/collections/{id}/assets/{assetId}"].put` (this spec emits
//     no operationId — path + method is the identifier).
//   - The router still exposes NO batch membership route; its only other
//     membership route is DELETE `/:id/assets/:assetId`
//     (src/routes/collections.ts:625). So N selected assets == N PUTs from one
//     interaction, which is what the shared helper does.
//   - GET /api/v1/collections/ -> `{ collections: [{ id, name, assetIds,
//     createdAt, updatedAt, ... }] }` (openapi.json
//     `.paths["/api/v1/collections/"].get.responses["200"]`). Only id + name are
//     read by the target picker.
//
// The acceptance criterion that matters most here is the third one: this view
// must REUSE the collection-detail picker's add-membership path rather than
// duplicate it. That is asserted structurally — the bar's requests are compared
// against the requests `addAssetsToCollection()` itself makes, the same function
// `renderCollectionAssetPicker` calls.

import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

type Mod = typeof import('../public/app.js');

async function loadApp(): Promise<Mod> {
  // app.js only boots the tab UI when window.__OPS_MAIN__ is true AND a tab bar
  // exists, so a bare import is a pure module load.
  return (await import('../public/app.js')) as Mod;
}

// Record every request app.js's apiFetch issues, answering collection reads and
// membership PUTs with the contract-shaped responses above.
function stubApi(opts: { failFor?: Set<string> } = {}) {
  const calls: Array<{ method: string; path: string; body: string | null }> = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = (init && init.method) || 'GET';
    calls.push({
      method,
      path,
      body: init && typeof init.body === 'string' ? init.body : null,
    });

    if (method === 'GET' && path.includes('/collections')) {
      return jsonRes({
        collections: [
          {
            id: 'coll-alpha',
            name: 'Alpha',
            assetIds: [],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          {
            id: 'coll-beta',
            name: 'Beta',
            assetIds: [],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });
    }

    if (method === 'PUT') {
      const assetId = path.split('/assets/')[1] || '';
      if (opts.failFor && opts.failFor.has(assetId)) {
        // The real 422 for an asset that does not resolve
        // (src/routes/collections.ts:598-603).
        return jsonRes(
          { error: 'asset_not_found', message: `asset not found: ${assetId}` },
          422
        );
      }
      return jsonRes({
        id: 'coll-alpha',
        name: 'Alpha',
        assetIds: [assetId],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });
    }

    return jsonRes({});
  }) as unknown as typeof fetch;
  return calls;
}

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function membershipPuts(calls: Array<{ method: string; path: string }>) {
  return calls.filter((c) => c.method === 'PUT' && c.path.includes('/assets/')).map((c) => c.path);
}

describe('bulkCollectionOptions — collections envelope', () => {
  it('reads the documented { collections: [...] } envelope and keeps id + name only', async () => {
    const { bulkCollectionOptions } = await loadApp();
    expect(
      bulkCollectionOptions({
        collections: [
          { id: 'c1', name: 'One', assetIds: [], createdAt: 'x', updatedAt: 'x' },
          { id: 'c2', name: 'Two', assetIds: [], createdAt: 'x', updatedAt: 'x' },
        ],
      })
    ).toEqual([
      { id: 'c1', name: 'One' },
      { id: 'c2', name: 'Two' },
    ]);
  });

  it('drops entries with no usable id rather than offering an unaddressable target', async () => {
    const { bulkCollectionOptions } = await loadApp();
    expect(bulkCollectionOptions({ collections: [{ name: 'nameless' }] })).toEqual([]);
  });

  it('returns an empty list for a malformed or absent envelope', async () => {
    const { bulkCollectionOptions } = await loadApp();
    expect(bulkCollectionOptions(undefined)).toEqual([]);
    expect(bulkCollectionOptions({})).toEqual([]);
  });
});

describe('bulk bar wording', () => {
  it('names the count in the primary button so the action is never ambiguous', async () => {
    const { bulkAddButtonLabel } = await loadApp();
    expect(bulkAddButtonLabel(0)).toBe('Add to collection');
    expect(bulkAddButtonLabel(1)).toBe('Add 1 asset to collection');
    expect(bulkAddButtonLabel(3)).toBe('Add 3 assets to collection');
  });

  it('names the single selected asset, and only counts beyond one', async () => {
    const { bulkSelectionSummary } = await loadApp();
    expect(bulkSelectionSummary([])).toBe('No assets selected.');
    expect(bulkSelectionSummary([{ id: 'a1', label: 'Clip one' }])).toBe(
      '1 asset selected: Clip one.'
    );
    expect(
      bulkSelectionSummary([
        { id: 'a1', label: 'Clip one' },
        { id: 'a2', label: 'Clip two' },
      ])
    ).toBe('2 assets selected.');
  });
});

describe('renderAssetsBulkBar — add-membership call path', () => {
  it('issues one PUT per selected asset against the contract path, and nothing else', async () => {
    const calls = stubApi();
    const { renderAssetsBulkBar } = await loadApp();

    const selection = [
      { id: 'asset-1', label: 'One' },
      { id: 'asset-2', label: 'Two' },
    ];
    const bar = renderAssetsBulkBar({ getSelection: () => selection });
    document.body.appendChild(bar.el);
    await tick();

    const select = bar.el.querySelector('#assets-bulk-collection') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toContain('coll-alpha');

    bar.setSelection(selection);
    select.value = 'coll-alpha';
    select.dispatchEvent(new Event('change'));

    const addBtn = bar.el.querySelector('#assets-bulk-add-btn') as HTMLButtonElement;
    expect(addBtn.disabled).toBe(false);
    expect(addBtn.textContent).toBe('Add 2 assets to collection');

    addBtn.click();
    await tick();
    await tick();
    await tick();

    expect(membershipPuts(calls)).toEqual([
      '/api/v1/collections/coll-alpha/assets/asset-1',
      '/api/v1/collections/coll-alpha/assets/asset-2',
    ]);
  });

  it('matches, request for request, what the collection-detail picker helper issues', async () => {
    // Acceptance criterion 3: one add-membership path, not two. Run the bar and
    // then the shared helper the detail picker calls, and compare the wire.
    const barCalls = stubApi();
    const { renderAssetsBulkBar, addAssetsToCollection } = await loadApp();

    const selection = [
      { id: 'asset-1', label: 'One' },
      { id: 'asset-2', label: 'Two' },
    ];
    const bar = renderAssetsBulkBar({ getSelection: () => selection });
    document.body.appendChild(bar.el);
    await tick();
    bar.setSelection(selection);
    const select = bar.el.querySelector('#assets-bulk-collection') as HTMLSelectElement;
    select.value = 'coll-alpha';
    select.dispatchEvent(new Event('change'));
    (bar.el.querySelector('#assets-bulk-add-btn') as HTMLButtonElement).click();
    await tick();
    await tick();
    await tick();
    const fromBar = membershipPuts(barCalls);

    const helperCalls = stubApi();
    await addAssetsToCollection('coll-alpha', ['asset-1', 'asset-2']);
    const fromHelper = membershipPuts(helperCalls);

    expect(fromBar).toEqual(fromHelper);
    expect(fromBar.length).toBe(2);
  });

  it('reports a partial failure and keeps the failed asset selected for retry', async () => {
    stubApi({ failFor: new Set(['asset-2']) });
    const { renderAssetsBulkBar } = await loadApp();

    const selection = [
      { id: 'asset-1', label: 'One' },
      { id: 'asset-2', label: 'Two' },
    ];
    let cleared = 0;
    const bar = renderAssetsBulkBar({
      getSelection: () => selection,
      clearSelection: () => {
        cleared += 1;
      },
    });
    document.body.appendChild(bar.el);
    await tick();
    bar.setSelection(selection);
    const select = bar.el.querySelector('#assets-bulk-collection') as HTMLSelectElement;
    select.value = 'coll-alpha';
    select.dispatchEvent(new Event('change'));
    (bar.el.querySelector('#assets-bulk-add-btn') as HTMLButtonElement).click();
    await tick();
    await tick();
    await tick();

    const msg = bar.el.querySelector('#assets-bulk-msg') as HTMLElement;
    expect(msg.textContent).toContain('Added 1 of 2 assets');
    expect(msg.querySelector('.msg-error')).not.toBeNull();
    // The one that failed is still selected — and still NAMED — and the
    // selection was NOT wiped.
    expect((bar.el.querySelector('#assets-bulk-count') as HTMLElement).textContent).toBe(
      '1 asset selected: Two.'
    );
    expect(cleared).toBe(0);
  });

  it('cannot be submitted with no selection or no target collection', async () => {
    const calls = stubApi();
    const { renderAssetsBulkBar } = await loadApp();
    const bar = renderAssetsBulkBar({ getSelection: () => [] });
    document.body.appendChild(bar.el);
    await tick();

    const addBtn = bar.el.querySelector('#assets-bulk-add-btn') as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);

    // A selection alone is not enough — a target is still required.
    bar.setSelection([{ id: 'asset-1', label: 'One' }]);
    expect(addBtn.disabled).toBe(true);

    addBtn.click();
    await tick();
    expect(membershipPuts(calls)).toEqual([]);
  });

  it('names the bar as a labelled region and announces the count politely (WCAG 1.3.1 / 4.1.3)', async () => {
    stubApi();
    const { renderAssetsBulkBar } = await loadApp();
    const bar = renderAssetsBulkBar({ getSelection: () => [] });
    document.body.appendChild(bar.el);
    await tick();

    expect(bar.el.getAttribute('role')).toBe('group');
    expect(bar.el.getAttribute('aria-label')).toBe('Bulk actions for selected assets');
    expect(
      (bar.el.querySelector('#assets-bulk-count') as HTMLElement).getAttribute('aria-live')
    ).toBe('polite');
    // Every control the operator can reach carries a programmatic name.
    const select = bar.el.querySelector('#assets-bulk-collection') as HTMLSelectElement;
    expect(bar.el.querySelector('label[for="assets-bulk-collection"]')).not.toBeNull();
    expect(select.getAttribute('aria-describedby')).toBe('assets-bulk-hint');
  });

  it('says so, and offers no target, when there are no collections to add to', async () => {
    globalThis.fetch = vi.fn(async () => jsonRes({ collections: [] })) as unknown as typeof fetch;
    const { renderAssetsBulkBar } = await loadApp();
    const bar = renderAssetsBulkBar({ getSelection: () => [{ id: 'a1', label: 'One' }] });
    document.body.appendChild(bar.el);
    await tick();

    const select = bar.el.querySelector('#assets-bulk-collection') as HTMLSelectElement;
    expect(select.options.length).toBe(1);
    expect(select.options[0].textContent).toContain('No collections');
    expect((bar.el.querySelector('#assets-bulk-add-btn') as HTMLButtonElement).disabled).toBe(true);
  });
});
