// @vitest-environment happy-dom
//
// Add-to-collection started from the Assets tab (issue #950).
//
// Membership used to be editable from a collection's own detail view only, so
// an operator who had already found an asset in the Assets table had to go
// collection-first anyway. This suite drives the two new entry points — the row
// action on the real assets table and the real dialog it opens — against the
// REAL collections and search routers, and pins the thing the issue actually
// asks for: that the dialog re-mounts the SHARED picker rather than growing a
// second copy of the multi-select/confirm flow.
//
// Verified contract (per CLAUDE.md rule 7):
//   - GET /api/v1/collections/ — openapi.json path key "/api/v1/collections/"
//     (`get`). 200 schema is `{ collections: Collection[] }`, `collections`
//     required, `additionalProperties: false`. NO query parameters are declared
//     (`.get.parameters` is absent), so the target select is populated from the
//     whole list. Route: src/routes/collections.ts:341 (`app.get('/')`,
//     response `z.object({ collections: z.array(collectionSchema) })`), handler
//     `repo.list()`. Fields used: `id`, `name`, `assetIds` (all three in
//     `collectionSchema.required`).
//   - PUT /api/v1/collections/{id}/assets/{assetId} — openapi.json path key
//     "/api/v1/collections/{id}/assets/{assetId}" (`put`): two required path
//     params, NO requestBody, responses 200 | 404 | 422. Route:
//     src/routes/collections.ts:586-623 — `params: z.object({ id: z.string(),
//     assetId: z.string() })`, 422 `asset_not_found` for an asset that does not
//     resolve, 404 for an unknown collection. Still no batch route, so several
//     assets are added with one PUT each from one confirmation.
//     Re-adding an existing member is a 200 no-op: `addAssetId()` dedupes while
//     preserving order (src/data/collection-repo.ts:236-238).
//   - GET /api/v1/search/ — src/routes/search.ts (`app.get('/')`, mounted at
//     prefix /api/v1/search). `q` + `pageSize` from `searchQuerySchema`; the 200
//     envelope separates the kinds (`{ assets, collections, total,
//     collectionTotal, page }`), so the picker reads `assets` only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerAuth } from '../src/auth/middleware.js';
import { collectionsRouter } from '../src/routes/collections.js';
import { searchRouter } from '../src/routes/search.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryCollectionRepository } from '../src/data/inmemory-collection-repo.js';
import { InMemorySearchRepository } from '../src/data/inmemory-search-repo.js';

import { createAssetsTable } from '../public/assets-table.js';
import { openAddToCollectionDialog, collectionOptionLabel } from '../public/app.js';

async function settle(ticks = 30): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ─────────────────────────────────────────────────────────────────────────────
// The row action on the real assets table
// ─────────────────────────────────────────────────────────────────────────────

const tableDeps = () => ({
  renderBadge: (s: string) => '<span class="badge">' + s + '</span>',
  renderTags: () => '',
  fmtDate: (v: string) => String(v || '—'),
  isAssetWedged: () => false,
});

function stubWin(search = '') {
  return {
    location: { search, pathname: '/', hash: '' },
    history: { state: null, replaceState: () => {}, pushState: () => {} },
  };
}

const ROW = {
  id: '01J8ZZZZZZZZZZZZZZZZZZZZZZ',
  slug: 'morning-news',
  name: 'Morning news bulletin',
  status: 'ready',
  createdAt: '2026-01-01T00:00:00Z',
};

async function mountTable(extra: Record<string, unknown> = {}) {
  const apiFetch = vi.fn(async () => ({ items: [ROW], total: 1 }));
  const t = createAssetsTable({
    ...tableDeps(),
    apiFetch,
    win: stubWin(),
    ...extra,
  });
  document.body.appendChild(t.el);
  await tick();
  return t;
}

function addBtn(el: HTMLElement): HTMLButtonElement | null {
  return el.querySelector('.asset-add-collection-btn') as HTMLButtonElement | null;
}

describe('assets table — add-to-collection row action (issue #950)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('offers the action on every row when a handler is wired', async () => {
    const onAddToCollection = vi.fn();
    const t = await mountTable({ onAddToCollection });

    const btn = addBtn(t.el);
    expect(btn).toBeTruthy();
    expect((btn!.textContent || '').trim()).toBe('Add to collection');
    // The ULID, because that is the handle PUT /collections/:id/assets/:assetId
    // resolves (a slug 422s there).
    expect(btn!.dataset.id).toBe(ROW.id);
    // …and the human-readable label the Name / Title column shows, so the
    // dialog can name its subject rather than echoing an opaque id.
    expect(btn!.dataset.name).toBe(ROW.name);
  });

  it('is absent — not disabled — when no handler is wired', async () => {
    const t = await mountTable();
    expect(addBtn(t.el)).toBeNull();
    // The rest of the actions cell is untouched by the opt-in.
    expect(t.el.querySelector('.asset-delete-btn')).toBeTruthy();
  });

  it('hands the row id and name to the handler without opening the detail panel', async () => {
    const onAddToCollection = vi.fn();
    const onRowClick = vi.fn();
    const t = await mountTable({ onAddToCollection, onRowClick });

    addBtn(t.el)!.click();

    expect(onAddToCollection).toHaveBeenCalledTimes(1);
    expect(onAddToCollection).toHaveBeenCalledWith(ROW.id, ROW.name);
    // "Add this to a collection" is not "show me this asset": the row-level
    // click handler must not also fire.
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('does not refetch the table: membership is not one of its columns', async () => {
    const apiFetch = vi.fn(async () => ({ items: [ROW], total: 1 }));
    const t = createAssetsTable({
      ...tableDeps(),
      apiFetch,
      win: stubWin(),
      onAddToCollection: () => {},
    });
    document.body.appendChild(t.el);
    await tick();
    const before = apiFetch.mock.calls.length;

    addBtn(t.el)!.click();
    await tick();

    expect(apiFetch.mock.calls.length).toBe(before);
  });

  it('adds no column: the table keeps the shape it had', async () => {
    const t = await mountTable({ onAddToCollection: () => {} });
    const headers = [...t.el.querySelectorAll('thead th')].map((th) =>
      // Strip the tri-state sort arrow the primitive appends to a sortable
      // header: this assertion is about the column SET, not the active sort.
      (th.textContent || '').replace(/[▲▼]/g, '').trim()
    );
    expect(headers).toEqual([
      '',
      'ID',
      'Slug',
      'Name / Title',
      'Status',
      'Tags',
      'Created',
      'Actions',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The dialog, against the real routers
// ─────────────────────────────────────────────────────────────────────────────

describe('add-to-collection dialog (issue #950)', () => {
  let app: FastifyInstance;
  let assets: InMemoryAssetRepository;
  let collections: InMemoryCollectionRepository;
  let ids: Record<string, string>;
  let collIds: Record<string, string>;

  async function boot(withCollections = true) {
    assets = new InMemoryAssetRepository();
    collections = new InMemoryCollectionRepository();
    const morning = await assets.create({ name: 'Morning news bulletin' });
    const evening = await assets.create({ name: 'Evening news bulletin' });
    const weather = await assets.create({ name: 'Weather report' });
    ids = { morning: morning.id, evening: evening.id, weather: weather.id };

    collIds = {};
    if (withCollections) {
      const news = await collections.create({ name: 'News' });
      const archive = await collections.create({ name: 'Archive' });
      await collections.addAsset(archive.id, weather.id);
      collIds = { news: news.id, archive: archive.id };
    }

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerAuth(app);
    await app.register(collectionsRouter, {
      prefix: '/api/v1/collections',
      repository: collections,
      assetRepository: assets,
    });
    await app.register(searchRouter, {
      prefix: '/api/v1/search',
      repository: new InMemorySearchRepository(assets),
    });
    await app.ready();

    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const res = await app.inject({
        method: (init.method as never) || 'GET',
        url: u.pathname + u.search,
        headers: init.headers as Record<string, string>,
        payload: init.body as never,
      });
      return new Response(res.body, {
        status: res.statusCode,
        headers: res.headers as Record<string, string>,
      });
    });

    document.body.innerHTML = '';
  }

  function dialog(): HTMLElement {
    const el = document.querySelector('.modal-dialog');
    if (!el) throw new Error('no dialog open');
    return el as HTMLElement;
  }

  function targetSelect(): HTMLSelectElement {
    return dialog().querySelector('#atc-collection') as HTMLSelectElement;
  }

  function optionLabels(): string[] {
    return [...targetSelect().querySelectorAll('option')].map((o) => o.textContent || '');
  }

  // Read membership back through the real route, with the same presence-gate
  // header the UI sends (issue #740: every gated router 401s without one).
  async function membersOf(collectionId: string): Promise<string[]> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/' + collectionId,
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { assetIds: string[] }).assetIds;
  }

  async function search(term: string): Promise<void> {
    const input = dialog().querySelector('#add-asset-search') as HTMLInputElement;
    input.value = term;
    (dialog().querySelector('#add-asset-search-btn') as HTMLButtonElement).click();
    await settle();
  }

  function tick_(id: string): void {
    const box = [
      ...dialog().querySelectorAll('.add-asset-hit'),
    ].find((b) => (b as HTMLInputElement).value === id) as HTMLInputElement;
    if (!box) throw new Error('no hit checkbox for ' + id);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
  }

  function confirmBtn(): HTMLButtonElement {
    return dialog().querySelector('#add-asset-selected-btn') as HTMLButtonElement;
  }

  function msgText(): string {
    return (dialog().querySelector('#add-asset-msg')?.textContent || '').trim();
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    if (app) await app.close();
  });

  describe('with collections to add to', () => {
    beforeEach(async () => {
      await boot(true);
    });

    it('lists every existing collection as a destination, with its member count', async () => {
      openAddToCollectionDialog({ assets: [] });
      await settle();

      // Placeholder first — the dialog never guesses a destination.
      expect(optionLabels()[0]).toBe('Choose a collection…');
      expect(targetSelect().value).toBe('');
      // `assetIds` is a required field on the verified list schema, so the count
      // is read from the payload rather than inferred.
      expect(optionLabels()).toContain('News (0 assets)');
      expect(optionLabels()).toContain('Archive (1 asset)');
    });

    it('mounts the SHARED picker rather than a second multi-select of its own', async () => {
      openAddToCollectionDialog({ assets: [] });
      await settle();

      // The collection-side picker's own ids: one component, mounted twice.
      expect(dialog().querySelector('#add-asset-search')).toBeTruthy();
      expect(dialog().querySelector('#add-asset-results')).toBeTruthy();
      expect(dialog().querySelector('#add-asset-selected')).toBeTruthy();
      expect(confirmBtn()).toBeTruthy();
      // Including its raw-id fallback — so the fallback is not quietly dropped
      // on this surface either.
      expect(dialog().querySelector('#add-asset-fallback')).toBeTruthy();
      // Exactly one hit list: no duplicated picker UI.
      expect(dialog().querySelectorAll('#add-asset-results').length).toBe(1);
    });

    it('seeds the asset the operator started from, and adds it alone', async () => {
      openAddToCollectionDialog({
        assets: [{ id: ids.morning, name: 'Morning news bulletin' }],
      });
      await settle();

      // Pre-ticked: no second search for an asset already in hand.
      expect(dialog().querySelector('#add-asset-selected')!.textContent).toContain(
        'Morning news bulletin'
      );
      expect(confirmBtn().disabled).toBe(false);
      expect(confirmBtn().textContent).toBe('Add 1 selected asset');

      targetSelect().value = collIds.news;
      targetSelect().dispatchEvent(new Event('change'));
      confirmBtn().click();
      await settle();

      expect(await membersOf(collIds.news)).toEqual([ids.morning]);
      expect(msgText()).toBe('Added 1 asset.');
    });

    it('adds the seeded asset together with others found in the dialog, in one confirmation', async () => {
      openAddToCollectionDialog({
        assets: [{ id: ids.morning, name: 'Morning news bulletin' }],
      });
      await settle();

      targetSelect().value = collIds.news;
      targetSelect().dispatchEvent(new Event('change'));

      await search('bulletin');
      tick_(ids.evening);
      expect(confirmBtn().textContent).toBe('Add 2 selected assets');

      confirmBtn().click();
      await settle();

      expect((await membersOf(collIds.news)).sort()).toEqual([ids.evening, ids.morning].sort());
      expect(msgText()).toBe('Added 2 assets.');
    });

    it('refuses to guess a destination, and issues nothing until one is chosen', async () => {
      openAddToCollectionDialog({
        assets: [{ id: ids.morning, name: 'Morning news bulletin' }],
      });
      await settle();

      confirmBtn().click();
      await settle();

      expect(msgText()).toContain('Choose a target collection first.');
      // Nothing was written anywhere.
      expect(await membersOf(collIds.news)).toEqual([]);
      expect(await membersOf(collIds.archive)).toEqual([ids.weather]);
      // And the selection survives the refusal, so the operator only has to
      // supply the missing half.
      expect(confirmBtn().textContent).toBe('Add 1 selected asset');
    });

    it('keeps the selection when the operator changes their mind about the destination', async () => {
      openAddToCollectionDialog({
        assets: [{ id: ids.morning, name: 'Morning news bulletin' }],
      });
      await settle();

      targetSelect().value = collIds.news;
      targetSelect().dispatchEvent(new Event('change'));
      targetSelect().value = collIds.archive;
      targetSelect().dispatchEvent(new Event('change'));
      expect(confirmBtn().textContent).toBe('Add 1 selected asset');

      confirmBtn().click();
      await settle();

      // The target is resolved at add time, so the LAST choice is the one used.
      expect(await membersOf(collIds.news)).toEqual([]);
      expect((await membersOf(collIds.archive)).sort()).toEqual(
        [ids.weather, ids.morning].sort()
      );
    });

    it('re-adding an existing member is reported as the no-op the API performs', async () => {
      openAddToCollectionDialog({ assets: [{ id: ids.weather, name: 'Weather report' }] });
      await settle();

      targetSelect().value = collIds.archive;
      targetSelect().dispatchEvent(new Event('change'));
      confirmBtn().click();
      await settle();

      // 200, and the membership list is unchanged (addAssetId dedupes).
      expect(msgText()).toBe('Added 1 asset.');
      expect(await membersOf(collIds.archive)).toEqual([ids.weather]);
    });

    it('reports a failed add instead of swallowing it', async () => {
      openAddToCollectionDialog({ assets: [{ id: 'no-such-asset', name: 'Ghost' }] });
      await settle();

      targetSelect().value = collIds.news;
      targetSelect().dispatchEvent(new Event('change'));
      confirmBtn().click();
      await settle();

      // 422 asset_not_found from the real route, surfaced per asset.
      expect(msgText()).toContain('Added 0 of 1 assets.');
      expect(msgText()).toContain('no-such-asset');
      expect(await membersOf(collIds.news)).toEqual([]);
    });

    it('refreshes the destination counts after a successful add', async () => {
      openAddToCollectionDialog({ assets: [{ id: ids.morning, name: 'Morning news' }] });
      await settle();

      targetSelect().value = collIds.news;
      targetSelect().dispatchEvent(new Event('change'));
      confirmBtn().click();
      await settle();

      expect(optionLabels()).toContain('News (1 asset)');
      // The chosen destination is still chosen after the refresh.
      expect(targetSelect().value).toBe(collIds.news);
    });

    it('names the destination and its size for a screen reader as well as the eye', async () => {
      openAddToCollectionDialog({ assets: [] });
      await settle();

      const select = targetSelect();
      const label = dialog().querySelector('label[for="atc-collection"]') as HTMLElement;
      expect(label.textContent).toBe('Target collection');
      const hint = dialog().querySelector('#atc-collection-hint') as HTMLElement;
      expect(select.getAttribute('aria-describedby')).toBe('atc-collection-hint');
      expect(hint.getAttribute('aria-live')).toBe('polite');

      select.value = collIds.archive;
      select.dispatchEvent(new Event('change'));
      expect(hint.textContent).toContain('holds 1 asset');
    });

    it('opens with the one field the row action cannot pre-fill focused', async () => {
      openAddToCollectionDialog({ assets: [{ id: ids.morning, name: 'Morning news' }] });
      await settle();
      expect(document.activeElement).toBe(targetSelect());
    });
  });

  describe('with no collections yet', () => {
    beforeEach(async () => {
      await boot(false);
    });

    it('says where a collection is made instead of offering an unusable form', async () => {
      openAddToCollectionDialog({ assets: [{ id: ids.morning, name: 'Morning news' }] });
      await settle();

      expect(dialog().textContent).toContain('No collections yet');
      // No picker, because there is nowhere for it to add to.
      expect(dialog().querySelector('#add-asset-selected-btn')).toBeNull();
      expect(targetSelect().disabled).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Destination labelling
// ─────────────────────────────────────────────────────────────────────────────

describe('collectionOptionLabel', () => {
  it('pairs the name with the member count, singular and plural', () => {
    expect(collectionOptionLabel({ name: 'News', assetIds: [] })).toBe('News (0 assets)');
    expect(collectionOptionLabel({ name: 'News', assetIds: ['a'] })).toBe('News (1 asset)');
    expect(collectionOptionLabel({ name: 'News', assetIds: ['a', 'b'] })).toBe('News (2 assets)');
  });

  it('omits a count the payload did not carry rather than printing zero', () => {
    expect(collectionOptionLabel({ name: 'News' })).toBe('News');
  });

  it('never renders a blank option', () => {
    // `name` is required on the verified schema, so this is the belt-and-braces
    // case: an option still names itself rather than rendering as empty.
    expect(collectionOptionLabel({ assetIds: [] })).toBe('(untitled) (0 assets)');
    expect(collectionOptionLabel(null)).toBe('(untitled)');
  });
});
