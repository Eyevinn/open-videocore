// @vitest-environment happy-dom
//
// Searchable multi-select asset picker for collection membership (issue #915).
//
// Adding a member used to require hand-typing a 26-character ULID into
// input#add-asset-id, with nothing in the UI to find that id — made worse by
// #851, where the Assets table's ID column shows the slug. This suite drives
// the REAL picker (public/app.js renderCollectionAssetPicker) against the REAL
// search and collections routers, so "find by name" and "add several" are
// asserted against the endpoints they actually call.
//
// Verified contract (per CLAUDE.md rule 7):
//   - GET /api/v1/search/ — src/routes/search.ts:260 (`app.get('/')`, mounted at
//     prefix /api/v1/search). Free-text param `q` and `pageSize` come from
//     searchQuerySchema (src/routes/search.ts:154-164, :215); `q` is matched
//     case-insensitively against the asset's canonical `name` and description.
//     There is no `type=asset` parameter — the 200 envelope separates the kinds
//     (`searchResultSchema`, src/routes/search.ts:123-135 →
//     `{ assets, collections, total, collectionTotal, page }`), so the picker
//     reads `assets` only. Asset hit fields used: `id`, `name`, `status`
//     (assetSchema, src/routes/search.ts:78-105).
//   - PUT /api/v1/collections/:id/assets/:assetId — src/routes/collections.ts:
//     492-531. `params: z.object({ id: z.string(), assetId: z.string() })`
//     (:497), no body schema, responses 200 | 404 | 422 (:498). No batch
//     membership route exists on that router, so several assets are added with
//     one PUT each from a single user interaction.
//   - Envelope `total` is the count of matching ASSETS across the whole matched
//     set, not the returned page (src/routes/search.ts:130; the repository
//     returns `assets: matched.slice(start, start + pageSize)` alongside
//     `total: matched.length`, src/data/inmemory-search-repo.ts:53-57). Issue
//     #949 leans on that: when `total` exceeds the hits on screen the picker
//     says the list is cut short, so "not shown" cannot read as "not there".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerAuth } from '../src/auth/middleware.js';
import { collectionsRouter } from '../src/routes/collections.js';
import { searchRouter } from '../src/routes/search.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryCollectionRepository } from '../src/data/inmemory-collection-repo.js';
import { InMemorySearchRepository } from '../src/data/inmemory-search-repo.js';

import {
  renderCollectionAssetPicker,
  addAssetsSummary,
  assetPickerHits,
  assetPickerTotal,
  assetPickerResultNote,
  ASSET_PICKER_PAGE_SIZE,
} from '../public/app.js';

async function settle(ticks = 30): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('collection asset picker (issue #915)', () => {
  let app: FastifyInstance;
  let assets: InMemoryAssetRepository;
  let collections: InMemoryCollectionRepository;
  let collectionId: string;
  let host: HTMLElement;
  let picker: HTMLElement;
  let ids: Record<string, string>;

  beforeEach(async () => {
    assets = new InMemoryAssetRepository();
    collections = new InMemoryCollectionRepository();
    const morning = await assets.create({ name: 'Morning news bulletin' });
    const evening = await assets.create({ name: 'Evening news bulletin' });
    const weather = await assets.create({ name: 'Weather report' });
    ids = { morning: morning.id, evening: evening.id, weather: weather.id };

    const collection = await collections.create({ name: 'News' });
    collectionId = collection.id;

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
    host = document.createElement('div');
    document.body.appendChild(host);
    picker = renderCollectionAssetPicker(collectionId, {}) as HTMLElement;
    host.appendChild(picker);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  async function search(term: string): Promise<void> {
    (picker.querySelector('#add-asset-search') as HTMLInputElement).value = term;
    (picker.querySelector('#add-asset-search-btn') as HTMLButtonElement).click();
    await settle();
  }

  function hitBoxes(): HTMLInputElement[] {
    return [...picker.querySelectorAll('.add-asset-hit')] as HTMLInputElement[];
  }

  function tick(box: HTMLInputElement): void {
    box.checked = true;
    box.dispatchEvent(new Event('change'));
  }

  async function memberIds(): Promise<string[]> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collectionId}`,
      headers: { authorization: 'Bearer test' },
    });
    const body = res.json() as { assets?: Array<{ id: string }> };
    return (body.assets ?? []).map((a) => a.id);
  }

  // Acceptance criterion 2: assets are findable by name.
  it('finds assets by name and lists them with their ids', async () => {
    await search('bulletin');
    const boxes = hitBoxes();
    expect(boxes.map((b) => b.value).sort()).toEqual([ids.morning, ids.evening].sort());
    const results = picker.querySelector('#add-asset-results') as HTMLElement;
    expect(results.textContent).toContain('Morning news bulletin');
    expect(results.textContent).toContain('Evening news bulletin');
    // The non-matching asset is not offered.
    expect(results.textContent).not.toContain('Weather report');
  });

  // Acceptance criteria 1 + 3: added without typing an id, and several assets
  // in one interaction (one Add click), not one add flow per asset.
  it('adds several selected assets in a single interaction', async () => {
    await search('bulletin');
    const boxes = hitBoxes();
    expect(boxes).toHaveLength(2);
    boxes.forEach(tick);

    const addBtn = picker.querySelector('#add-asset-selected-btn') as HTMLButtonElement;
    expect(addBtn.disabled).toBe(false);
    expect(addBtn.textContent).toContain('2');

    addBtn.click();
    await settle();

    expect((await memberIds()).sort()).toEqual([ids.morning, ids.evening].sort());
    expect((picker.querySelector('#add-asset-msg') as HTMLElement).textContent).toContain(
      'Added 2 assets.'
    );
    // Nothing was typed into the raw-id field at any point.
    expect((picker.querySelector('#add-asset-id') as HTMLInputElement).value).toBe('');
  });

  // Selection is not lost when the operator searches again, so assets found
  // under different terms still go in together.
  it('keeps selections across searches and adds them together', async () => {
    await search('morning');
    tick(hitBoxes()[0]!);
    await search('weather');
    tick(hitBoxes()[0]!);

    const addBtn = picker.querySelector('#add-asset-selected-btn') as HTMLButtonElement;
    expect(addBtn.textContent).toContain('2');
    addBtn.click();
    await settle();

    expect((await memberIds()).sort()).toEqual([ids.morning, ids.weather].sort());
  });

  it('lets a selected asset be removed before adding', async () => {
    await search('bulletin');
    hitBoxes().forEach(tick);
    const deselect = picker.querySelector('.add-asset-deselect') as HTMLButtonElement;
    deselect.click();
    await settle(2);

    const addBtn = picker.querySelector('#add-asset-selected-btn') as HTMLButtonElement;
    expect(addBtn.textContent).toContain('1');
    addBtn.click();
    await settle();
    expect(await memberIds()).toHaveLength(1);
  });

  // Acceptance criterion 4: the raw-id path still works.
  it('keeps the raw asset-id field as a fallback', async () => {
    const raw = picker.querySelector('#add-asset-id') as HTMLInputElement;
    expect(raw).not.toBeNull();
    raw.value = ids.weather!;
    (picker.querySelector('#add-asset-btn') as HTMLButtonElement).click();
    await settle();
    expect(await memberIds()).toEqual([ids.weather]);
  });

  // A rejected member (422 asset_not_found, src/routes/collections.ts:505-511)
  // must be named rather than folded into a blanket success.
  it('reports a partial failure rather than claiming success', () => {
    expect(
      addAssetsSummary({ added: ['a'], failed: [{ id: 'b', message: 'asset not found: b' }] })
    ).toBe('Added 1 of 2 assets. Failed: b (asset not found: b)');
    expect(addAssetsSummary({ added: ['a'], failed: [] })).toBe('Added 1 asset.');
  });

  it('surfaces the server rejection when an unknown id is added', async () => {
    const raw = picker.querySelector('#add-asset-id') as HTMLInputElement;
    raw.value = '01NOTAREALASSETID0000000000';
    (picker.querySelector('#add-asset-btn') as HTMLButtonElement).click();
    await settle();
    expect((picker.querySelector('#add-asset-msg') as HTMLElement).textContent).toContain(
      'asset not found'
    );
    expect(await memberIds()).toHaveLength(0);
  });

  // Collection hits arrive in their own array; a collection can never be a
  // member of a collection through PUT /:id/assets/:assetId.
  it('reads asset hits only from the search envelope', () => {
    const hits = assetPickerHits({
      assets: [{ id: 'A1', name: 'clip', status: 'ready', type: 'asset' }],
      collections: [{ id: 'C1', name: 'News', type: 'collection' }],
      total: 1,
      collectionTotal: 1,
      page: 1,
    });
    expect(hits).toEqual([{ id: 'A1', name: 'clip', status: 'ready' }]);
  });

  // Issue #949: a common term can match more assets than one page holds. The
  // picker must not present a cut-short list as the whole answer.
  it('says so when the hit list is cut short by the page size', async () => {
    const many = [];
    for (let i = 0; i < ASSET_PICKER_PAGE_SIZE + 4; i += 1) {
      many.push(await assets.create({ name: `News segment ${i}` }));
    }
    await search('news segment');

    expect(hitBoxes()).toHaveLength(ASSET_PICKER_PAGE_SIZE);
    const note = picker.querySelector('#add-asset-results-note') as HTMLElement;
    expect(note).not.toBeNull();
    expect(note.textContent).toContain(`Showing the first ${ASSET_PICKER_PAGE_SIZE} of ${many.length}`);
    expect(note.textContent).toMatch(/narrow the search/i);
  });

  it('adds no truncation note when every match is on screen', async () => {
    await search('bulletin');
    expect(hitBoxes()).toHaveLength(2);
    expect(picker.querySelector('#add-asset-results-note')).toBeNull();
  });

  it('derives the truncation note from the envelope total only', () => {
    expect(assetPickerTotal({ assets: [], collections: [], total: 57, collectionTotal: 0, page: 1 })).toBe(
      57
    );
    expect(assetPickerTotal({})).toBeNull();
    expect(assetPickerResultNote(20, 57)).toBe(
      'Showing the first 20 of 57 matching assets. Add a word from the name to narrow the search.'
    );
    expect(assetPickerResultNote(2, 2)).toBe('');
    // A total the server did not report is never guessed at.
    expect(assetPickerResultNote(20, null)).toBe('');
  });

  it('labels the search field and announces results accessibly', () => {
    const label = picker.querySelector('label[for="add-asset-search"]') as HTMLLabelElement;
    expect(label.textContent).toMatch(/name/i);
    const input = picker.querySelector('#add-asset-search') as HTMLInputElement;
    expect(input.getAttribute('aria-controls')).toBe('add-asset-results');
    expect(input.getAttribute('aria-describedby')).toBe('add-asset-search-hint');
    expect(
      (picker.querySelector('#add-asset-selected') as HTMLElement).getAttribute('aria-live')
    ).toBe('polite');
    expect((picker.querySelector('#add-asset-msg') as HTMLElement).getAttribute('aria-live')).toBe(
      'polite'
    );
  });
});
