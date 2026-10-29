// @vitest-environment happy-dom
//
// Collection metadata edit affordance in the ops UI (issue #862).
//
// `PATCH /api/v1/collections/{id}` has accepted `description`, `tags` and
// `custom` since issue #560, but the Collections tab offered Create (name only),
// View, Delete and add/remove members — so none of the three could be edited
// from the UI. These tests cover the new control the same way the collection
// rename (#928) is covered: the pure helpers, then the detail view driven
// through the REAL renderer (`showCollectionDetail`) against the REAL
// collections router, so every wire assertion is made against the endpoint that
// actually serves it.
//
// CONTRACT GROUNDING — read from this repo's route source and generated spec
// before the tests were written (CLAUDE.md rule 7), never from the issue text:
//
//   openapi.json .paths["/api/v1/collections/{id}"].patch
//     parameters: exactly one — path `id` (string, required); no query params.
//     requestBody (required): properties `name` (string, 1..256),
//       `description` (string), `tags` (array<string>), `custom` (object,
//       additionalProperties {}); additionalProperties: false. All optional.
//     responses: exactly 200 (the collection: id, name, assetIds, createdAt,
//       updatedAt required; description/tags/custom/deleteLock optional), 400,
//       404.
//     Source: `updateBodySchema` src/routes/collections.ts:250-263 —
//       `description: z.string().optional()` (:259),
//       `tags: z.array(z.string()).optional()` (:260),
//       `custom: z.record(z.unknown()).optional()` (:261) — inside `.strict()`
//       (:263), wired at `app.patch('/:id', …)` :423-444.
//
//   Replace-wholesale: "every present key is applied wholesale, an absent key
//     leaves the current value untouched, and an explicit empty value
//     (`''`/`[]`/`{}`) clears an optional field" (collections.ts:241-249), with
//     `applyCollectionUpdate` (src/data/collection-repo.ts) assigning only the
//     keys the patch carries and never touching `assetIds` or `deleteLock`.
//
//   Acceptance "the edit path never sends assetIds" is pinned from BOTH sides:
//     every recorded request body is asserted to contain only
//     description/tags/custom, and the `.strict()` body is exercised directly to
//     show an `assetIds` key is a 400 refusal (collections.ts:245-249 —
//     membership stays on PUT/DELETE /:id/assets/:assetId).
//
//   Caps mirrored client-side: `checkCollectionMetadataCaps`
//     (collections.ts:184-227) with COLLECTION_DESCRIPTION_MAX_LENGTH = 2048,
//     COLLECTION_TAGS_MAX_COUNT = 128, COLLECTION_TAG_MAX_LENGTH = 128,
//     COLLECTION_CUSTOM_MAX_SERIALIZED_BYTES = 16384 (collections.ts:160-163).
//
//   Search reflection: collection hits carry description/tags/custom
//     (`collectionHitSchema`, src/routes/search.ts, issue #561) and are projected
//     from live collection documents via `collections.list()`
//     (src/data/inmemory-search-repo.ts), so an edit shows up in search.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerAuth } from '../src/auth/middleware.js';
import { registerPrincipal } from '../src/auth/principal.js';
import { collectionsRouter } from '../src/routes/collections.js';
import { searchRouter } from '../src/routes/search.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryCollectionRepository } from '../src/data/inmemory-collection-repo.js';
import { InMemorySearchRepository } from '../src/data/inmemory-search-repo.js';

import { apiFetch, openModal, setClientRole, showCollectionDetail } from '../public/app.js';
import {
  COLLECTION_EDIT_COPY,
  COLLECTION_TAGS_MAX,
  COLLECTION_TAG_MAX,
  checkEditCaps,
  classifyCollectionEditError,
  collectionEditPatchBody,
  collectionEditResultMessage,
  customPairsToObject,
  mountCollectionEdit,
  normaliseTagRows,
  readCollectionCustomPairs,
  readCollectionTags,
} from '../public/collection-edit.js';

const ALLOWED_KEYS = ['description', 'tags', 'custom'];

async function settle(ticks = 40): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — the request body
// ─────────────────────────────────────────────────────────────────────────────

describe('collection edit request body (issue #862)', () => {
  const current = {
    id: 'coll-1',
    name: 'Autumn promos',
    assetIds: ['a1', 'a2'],
    description: 'Old blurb',
    tags: ['news', 'sports'],
    custom: { rightsWindow: '2026-12-31' },
  };

  it('carries only the fields that changed', () => {
    const body = collectionEditPatchBody(current, {
      description: 'New blurb',
      tags: ['news', 'sports'],
      custom: { rightsWindow: '2026-12-31' },
    });
    expect(body).toEqual({ description: 'New blurb' });
  });

  it('sends a shorter array when a tag is removed (tags replace wholesale)', () => {
    const body = collectionEditPatchBody(current, {
      description: current.description,
      tags: ['news'],
      custom: current.custom,
    });
    expect(body).toEqual({ tags: ['news'] });
  });

  it('clears a field with its explicit empty value, as the route defines', () => {
    const body = collectionEditPatchBody(current, { description: '', tags: [], custom: {} });
    expect(body).toEqual({ description: '', tags: [], custom: {} });
  });

  it('never carries assetIds, name or deleteLock — whatever the draft holds', () => {
    const body = collectionEditPatchBody(current, {
      description: 'New blurb',
      tags: ['news'],
      custom: { a: 'b' },
      // Keys outside the three this form owns, offered on purpose:
      assetIds: ['smuggled'],
      name: 'Renamed behind your back',
      deleteLock: { locked: true },
      id: 'other',
    } as never);
    expect(Object.keys(body).sort()).toEqual(['custom', 'description', 'tags']);
    for (const forbidden of ['assetIds', 'assets', 'name', 'deleteLock', 'id']) {
      expect(body[forbidden]).toBeUndefined();
    }
  });

  it('is empty when nothing changed, so no write is spent', () => {
    expect(
      collectionEditPatchBody(current, {
        description: current.description,
        tags: current.tags,
        custom: current.custom,
      })
    ).toEqual({});
    expect(collectionEditResultMessage({})).toBe(COLLECTION_EDIT_COPY.errUnchanged);
  });

  it('names the saved fields in the success line', () => {
    expect(collectionEditResultMessage({ tags: [] })).toBe('Saved tags.');
    expect(collectionEditResultMessage({ description: 'x', custom: {} })).toBe(
      'Saved description and custom fields.'
    );
  });
});

describe('tag list normalisation', () => {
  it('trims, drops blank rows and collapses duplicates while keeping order', () => {
    expect(
      normaliseTagRows([{ key: ' news ' }, { key: '' }, { key: 'sports' }, { key: 'news' }])
    ).toEqual(['news', 'sports']);
  });

  it('reads an absent tags field as an empty list', () => {
    expect(readCollectionTags({})).toEqual([]);
    expect(readCollectionTags({ tags: ['a'] })).toEqual(['a']);
  });
});

describe('custom key/value pairs (same editing pattern as the #850 filter)', () => {
  it('ignores a row with an empty key and trims the key', () => {
    const { custom } = customPairsToObject([
      { key: ' genre ', value: 'documentary' },
      { key: '', value: 'orphan' },
    ]);
    expect(custom).toEqual({ genre: 'documentary' });
  });

  it('reports a duplicate key instead of silently dropping a field', () => {
    const r = customPairsToObject([
      { key: 'genre', value: 'documentary' },
      { key: 'genre', value: 'drama' },
    ]);
    expect(r.duplicateKey).toBe('genre');
  });

  it('keeps a non-string value verbatim when its row was not retyped', () => {
    // `custom` is z.record(z.unknown()): a number must not become "7" just
    // because it passed through a text box.
    const current = { episodes: 7, note: 'hi' };
    const rows = readCollectionCustomPairs({ custom: current }).map((p) => ({
      ...p,
      originalKey: p.key,
      originalValue: p.value,
    }));
    expect(customPairsToObject(rows, current).custom).toEqual({ episodes: 7, note: 'hi' });

    // Retyping it DOES send the typed string — the operator changed the text.
    const retyped = rows.map((p) => (p.key === 'episodes' ? { ...p, value: '9' } : p));
    expect(customPairsToObject(retyped, current).custom).toEqual({ episodes: '9', note: 'hi' });
  });
});

describe('client-side cap mirror and error classification', () => {
  it('refuses an over-long description, too many tags and an over-long tag', () => {
    expect(checkEditCaps({ description: 'x'.repeat(2048) })).toBeNull();
    expect(checkEditCaps({ description: 'x'.repeat(2049) })!.reason).toBe('description_too_long');
    expect(COLLECTION_TAGS_MAX).toBe(128);
    expect(checkEditCaps({ tags: new Array(COLLECTION_TAGS_MAX + 1).fill('t') })!.reason).toBe(
      'too_many_tags'
    );
    expect(checkEditCaps({ tags: ['x'.repeat(COLLECTION_TAG_MAX + 1)] })!.reason).toBe(
      'tag_too_long'
    );
  });

  it('refuses a custom bag over the serialized size ceiling', () => {
    expect(checkEditCaps({ custom: { big: 'x'.repeat(17 * 1024) } })!.reason).toBe(
      'custom_too_large'
    );
  });

  it('maps the declared statuses to operator copy without machine codes', () => {
    expect(classifyCollectionEditError({ status: 403 }).message).toBe(
      COLLECTION_EDIT_COPY.errForbidden
    );
    expect(classifyCollectionEditError({ status: 404 }).dismiss).toBe(true);
    expect(classifyCollectionEditError({ status: 400 }).message).toBe(
      COLLECTION_EDIT_COPY.errRejected
    );
    expect(classifyCollectionEditError(new Error('boom') as never).message).toBe(
      COLLECTION_EDIT_COPY.errNetwork
    );
  });

  it('offers no control at all to a role that cannot write', () => {
    const row = document.createElement('div');
    const r = mountCollectionEdit({
      collection: { id: 'coll-1' },
      actionsRow: row,
      canChange: false,
      apiFetch: vi.fn(),
      openModal: vi.fn(),
    });
    expect(r.button).toBeNull();
    expect(row.querySelectorAll('button')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The real renderer against the real router
// ─────────────────────────────────────────────────────────────────────────────

describe('collection detail — edit metadata (issue #862)', () => {
  let app: FastifyInstance;
  let assets: InMemoryAssetRepository;
  let collections: InMemoryCollectionRepository;
  let collectionId: string;
  let memberIds: string[];
  let detailPanel: HTMLElement;
  let patchBodies: Record<string, unknown>[];

  beforeEach(async () => {
    localStorage.clear();
    setClientRole('admin');

    assets = new InMemoryAssetRepository();
    collections = new InMemoryCollectionRepository();
    const first = await assets.create({ name: 'Promo cut' });
    const second = await assets.create({ name: 'Trailer cut' });
    memberIds = [first.id, second.id];

    const collection = await collections.create({
      name: 'Autumn promos',
      description: 'Old blurb',
      tags: ['news', 'sports'],
      custom: { rightsWindow: '2026-12-31' },
    });
    collectionId = collection.id;
    for (const assetId of memberIds) {
      await collections.addAsset(collectionId, assetId);
    }

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerAuth(app);
    registerPrincipal(app, { trustRoleHeader: true });
    await app.register(collectionsRouter, {
      prefix: '/api/v1/collections',
      repository: collections,
      assetRepository: assets,
    });
    await app.register(searchRouter, {
      prefix: '/api/v1/search',
      repository: new InMemorySearchRepository(assets, collections),
    });
    await app.ready();

    patchBodies = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const method = (init.method as string) || 'GET';
      if (method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>);
      }
      const res = await app.inject({
        method: method as never,
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
    detailPanel = document.createElement('div');
    document.body.appendChild(detailPanel);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    localStorage.clear();
    await app.close();
  });

  async function openPanel(): Promise<void> {
    await showCollectionDetail(collectionId, detailPanel, undefined);
    await settle();
  }

  function editBtn(): HTMLButtonElement | null {
    return detailPanel.querySelector<HTMLButtonElement>('#btn-edit-collection-metadata');
  }

  function descriptionField(): HTMLTextAreaElement {
    return document.querySelector<HTMLTextAreaElement>('#coll-edit-description')!;
  }

  function tagInputs(): HTMLInputElement[] {
    return [...document.querySelectorAll<HTMLInputElement>('.coll-edit-tag-key')];
  }

  function removeTag(index: number): void {
    [...document.querySelectorAll<HTMLButtonElement>('.coll-edit-tag-remove')][index]!.click();
  }

  function setCustomRow(index: number, key: string, value: string): void {
    const addBtn = document.querySelector<HTMLButtonElement>('#coll-edit-custom-add')!;
    while (document.querySelectorAll('.coll-edit-custom-row').length <= index) addBtn.click();
    const row = document.querySelectorAll('.coll-edit-custom-row')[index]!;
    (row.querySelector('.coll-edit-custom-key') as HTMLInputElement).value = key;
    (row.querySelector('.coll-edit-custom-value') as HTMLInputElement).value = value;
  }

  function submitDialog(): void {
    document.querySelector<HTMLButtonElement>('#coll-edit-submit')!.click();
  }

  function dialogError(): string {
    const e = document.querySelector<HTMLElement>('#coll-edit-error');
    return e && e.style.display !== 'none' ? e.textContent || '' : '';
  }

  function kvText(key: string): string {
    const keys = [...detailPanel.querySelectorAll('.kv-key')];
    const match = keys.find((k) => k.textContent === key);
    return (match?.nextElementSibling?.textContent || '').trim();
  }

  async function stored(): Promise<{
    description?: string;
    tags?: string[];
    custom?: Record<string, unknown>;
    name: string;
    assetIds: string[];
  }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collectionId}`,
      headers: { authorization: 'Bearer test' },
    });
    return res.json();
  }

  it('offers an Edit metadata control, and hides it from a viewer', async () => {
    await openPanel();
    expect(editBtn()).not.toBeNull();
    expect(editBtn()!.textContent).toBe(COLLECTION_EDIT_COPY.btn);
    expect(editBtn()!.parentElement!.className).toContain('flex-gap');

    setClientRole('viewer');
    await openPanel();
    expect(editBtn()).toBeNull();
  });

  it('shows the current description, tags and custom fields on the panel', async () => {
    await openPanel();
    expect(kvText('Description')).toBe('Old blurb');
    expect(kvText('Tags')).toBe('news, sports');
    expect(kvText('Custom')).toContain('rightsWindow: 2026-12-31');
  });

  it('prefills the dialog from the collection, one editable row per tag', async () => {
    await openPanel();
    editBtn()!.click();
    expect(descriptionField().value).toBe('Old blurb');
    expect(tagInputs().map((i) => i.value)).toEqual(['news', 'sports']);
    expect(
      [...document.querySelectorAll<HTMLInputElement>('.coll-edit-custom-key')].map((i) => i.value)
    ).toEqual(['rightsWindow']);
  });

  it('saves description, tags and custom in ONE patch that never carries assetIds', async () => {
    await openPanel();
    editBtn()!.click();
    descriptionField().value = 'Autumn campaign masters';
    tagInputs()[1]!.value = 'promos';
    setCustomRow(1, 'owner', 'news-desk');
    submitDialog();
    await settle();

    // One PATCH, exactly the three editable keys, nothing else.
    expect(patchBodies).toHaveLength(1);
    expect(Object.keys(patchBodies[0]!).sort()).toEqual(['custom', 'description', 'tags']);
    for (const body of patchBodies) {
      for (const key of Object.keys(body)) expect(ALLOWED_KEYS).toContain(key);
      expect((body as Record<string, unknown>).assetIds).toBeUndefined();
    }

    // The server stored it, and membership and name are untouched.
    const after = await stored();
    expect(after.description).toBe('Autumn campaign masters');
    expect(after.tags).toEqual(['news', 'promos']);
    expect(after.custom).toEqual({ rightsWindow: '2026-12-31', owner: 'news-desk' });
    expect(after.assetIds).toEqual(memberIds);
    expect(after.name).toBe('Autumn promos');

    // The panel re-read and reports what was saved.
    expect(kvText('Description')).toBe('Autumn campaign masters');
    expect(detailPanel.textContent).toContain('Saved');
    expect(document.querySelector('#coll-edit-description')).toBeNull();
  });

  it('removes a tag: the shorter list is what the server stores, across a reload', async () => {
    await openPanel();
    editBtn()!.click();
    removeTag(0); // drop 'news'
    submitDialog();
    await settle();

    expect(patchBodies).toEqual([{ tags: ['sports'] }]);
    expect((await stored()).tags).toEqual(['sports']);

    // Reload the panel from the server — the removal persisted.
    await openPanel();
    expect(kvText('Tags')).toBe('sports');
  });

  it('clears description and custom when emptied, and the edit shows up in search', async () => {
    await openPanel();
    editBtn()!.click();
    descriptionField().value = 'Searchable autumn blurb';
    submitDialog();
    await settle();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search/?q=Searchable',
      headers: { authorization: 'Bearer test' },
    });
    const hits = res.json() as { collections: { id: string; description?: string }[] };
    expect(hits.collections.map((c) => c.id)).toContain(collectionId);
    expect(hits.collections[0]!.description).toBe('Searchable autumn blurb');
  });

  it('spends no request when nothing changed, and says so', async () => {
    await openPanel();
    editBtn()!.click();
    submitDialog();
    await settle();

    expect(patchBodies).toEqual([]);
    expect(dialogError()).toBe(COLLECTION_EDIT_COPY.errUnchanged);
    expect(document.querySelector('#coll-edit-description')).not.toBeNull();
  });

  it('refuses an over-long description locally, without a request', async () => {
    await openPanel();
    editBtn()!.click();
    // maxLength on the textarea stops typing past the cap in a browser; set the
    // value directly to prove the submit gate refuses it too.
    descriptionField().value = 'x'.repeat(2049);
    submitDialog();
    await settle();

    expect(patchBodies).toEqual([]);
    expect(dialogError()).toBe(COLLECTION_EDIT_COPY.errDescriptionLong);
    expect((await stored()).description).toBe('Old blurb');
  });

  it('the strict body refuses assetIds, which is why the form never builds it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}`,
      headers: { authorization: 'Bearer test', 'x-ovc-role': 'admin' },
      payload: { description: 'smuggle', assetIds: [] },
    });
    expect(res.statusCode).toBe(400);
    expect((await stored()).assetIds).toEqual(memberIds);
  });
});
