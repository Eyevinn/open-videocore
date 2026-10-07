// @vitest-environment happy-dom
//
// Collection rename affordance in the ops UI (issue #928, broken out of #855).
//
// `PATCH /api/v1/collections/{id}` accepts `name` (added in #926) but nothing in
// the ops UI could trigger it: a collection could only ever be named once, at
// creation. These tests cover the new control the same way the asset rename
// (#956) is covered — the pure helpers, then the detail view driven through the
// REAL renderer (`showCollectionDetail`, the code path the Collections tab
// opens) against the REAL collections router, so every wire assertion is made
// against the endpoint that actually serves it.
//
// CONTRACT GROUNDING — every path, field, method and status below was read from
// this repo's route source and generated spec before the tests were written
// (CLAUDE.md rule 7), never from the issue text:
//
//   openapi.json .paths["/api/v1/collections/{id}"].patch
//     parameters: exactly one — path `id` (string, required); no query params.
//     requestBody (required): properties `name` (string, minLength 1,
//       maxLength 256), `description` (string), `tags` (array<string>),
//       `custom` (object); additionalProperties: false. All optional.
//     responses: exactly 200 (the collection: id, name, assetIds, createdAt,
//       updatedAt required; description/tags/custom/deleteLock optional), 400,
//       404.
//     Source: `updateBodySchema` src/routes/collections.ts:216-229 — `name:
//       z.string().min(1).max(256).optional()` at :224 (the same type/length rule
//       as the asset rename, per that line's own comment) in a `.strict()`
//       object at :229 — wired at `app.patch('/:id', …)` :389-410, `response:
//       { 200: collectionSchema, 400: errorSchema, 404: errorSchema }` at :395.
//
//   AC3 — "the UI only ever sends allowed fields (never `assetIds`)" is pinned
//     from BOTH sides here: the recorded request bodies are asserted to carry
//     exactly `['name']`, and the `.strict()` body is exercised directly to show
//     that an `assetIds` key is a 400 refusal rather than a silently accepted
//     membership mutation (src/routes/collections.ts:207-215 — membership stays
//     on PUT/DELETE /:id/assets/:assetId).
//
//   Membership survival is a property of the REPOSITORY, verified there rather
//     than assumed: `applyCollectionUpdate` (src/data/collection-repo.ts:92-110)
//     copies the existing collection, bumps `updatedAt` and assigns ONLY the
//     keys the patch carries (`if (patch.name !== undefined) next.name =
//     patch.name;` :96); its contract line states it "never touches `assetIds`
//     or `deleteLock`" (:90). `InMemoryCollectionRepository.update`
//     (src/data/inmemory-collection-repo.ts:73-81) delegates to it, so the real
//     repository is what answers the member assertions below.
//
//   Authorisation — `MATRIX` (src/auth/authorize.ts:54-58) grants `write` to
//     editor and admin only; `methodToAction` (:79-93) maps PATCH -> write;
//     `resourceAuthorizationPreHandler('collection')` is registered on this
//     router (src/routes/collections.ts:267). ADR-018 decision 4: `collection`
//     is NOT distinguished from `asset` by the table. The 403 code is
//     `AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role'` (authorize.ts:99).
//     The 403 path is driven for real here: `registerPrincipal(app, {
//     trustRoleHeader: true })` is wired exactly as the real app does
//     (src/main.ts:488-490) so the UI's own `X-OVC-Role` header (app.js:316)
//     reaches the gate.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerAuth } from '../src/auth/middleware.js';
import { registerPrincipal } from '../src/auth/principal.js';
import { collectionsRouter } from '../src/routes/collections.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryCollectionRepository } from '../src/data/inmemory-collection-repo.js';

import {
  apiFetch,
  canRenameCollection,
  openModal,
  setClientRole,
  showCollectionDetail,
} from '../public/app.js';
import { buildRenameForm, RENAME_COPY } from '../public/asset-rename.js';
import {
  COLLECTION_RENAME_COPY,
  NAME_MAX,
  buildCollectionRenameForm,
  classifyCollectionRenameError,
  mountCollectionRename,
  normaliseCollectionRenameInput,
  renameRequestBody,
  renameResultMessage,
} from '../public/collection-rename.js';

const OLD_NAME = 'Autumn promos';
const NEW_NAME = 'Autumn campaign — masters';

async function settle(ticks = 40): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('collection rename input validation (against the server bounds)', () => {
  it('accepts a changed name and hands back the trimmed value', () => {
    expect(normaliseCollectionRenameInput('  Autumn campaign  ', OLD_NAME)).toEqual({
      value: 'Autumn campaign',
      ok: true,
      reason: null,
      message: null,
    });
  });

  it('refuses an empty or whitespace-only name without inventing a default', () => {
    // `name: z.string().min(1)` — the schema refuses it, so the dialog does too,
    // before a request is made. A collection's name is required, so an empty
    // string is never a "clear this field" instruction.
    for (const raw of ['', '   ', '\n\t']) {
      const r = normaliseCollectionRenameInput(raw, OLD_NAME);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('empty');
      expect(r.message).toBe(COLLECTION_RENAME_COPY.errEmpty);
    }
  });

  it('accepts exactly the maximum length and refuses one character more', () => {
    // The collection bound is the asset bound: both schemas say max(256).
    expect(NAME_MAX).toBe(256);
    expect(normaliseCollectionRenameInput('x'.repeat(NAME_MAX), OLD_NAME).ok).toBe(true);
    const tooLong = normaliseCollectionRenameInput('x'.repeat(NAME_MAX + 1), OLD_NAME);
    expect(tooLong.ok).toBe(false);
    expect(tooLong.reason).toBe('too-long');
    expect(tooLong.message).toBe(COLLECTION_RENAME_COPY.errTooLong);
  });

  it('refuses a no-op rename, including one that differs only in whitespace', () => {
    expect(normaliseCollectionRenameInput(OLD_NAME, OLD_NAME).reason).toBe('unchanged');
    expect(normaliseCollectionRenameInput('  ' + OLD_NAME + ' ', OLD_NAME).reason).toBe(
      'unchanged'
    );
  });
});

describe('collection rename request body (AC3)', () => {
  it('carries exactly one key: name', () => {
    const body = renameRequestBody(NEW_NAME);
    expect(body).toEqual({ name: NEW_NAME });
    expect(Object.keys(body)).toEqual(['name']);
  });

  it('never carries assetIds, nor any sibling field the schema would also accept', () => {
    // `assetIds` is the one AC3 names: membership belongs to
    // PUT/DELETE /:id/assets/:assetId, never to the metadata PATCH.
    // `description`/`tags`/`custom` are declared on this body but are fields the
    // rename action does not own; `deleteLock` has its own routes.
    const body = renameRequestBody(NEW_NAME) as Record<string, unknown>;
    for (const forbidden of [
      'assetIds',
      'assets',
      'description',
      'tags',
      'custom',
      'deleteLock',
      'id',
    ]) {
      expect(body[forbidden]).toBeUndefined();
    }
  });
});

describe('collection rename error classification', () => {
  it('maps the role gate to the role sentence and keeps the dialog open', () => {
    const c = classifyCollectionRenameError({
      status: 403,
      body: { error: 'forbidden_insufficient_role' },
    });
    expect(c.kind).toBe('forbidden');
    expect(c.message).toBe(COLLECTION_RENAME_COPY.errForbidden);
    expect(c.dismiss).toBe(false);
    // The machine code is never shown to the operator.
    expect(c.message).not.toMatch(/forbidden_insufficient_role/);
    expect(classifyCollectionRenameError({ status: 401 }).kind).toBe('forbidden');
  });

  it('treats a 404 as terminal for the dialog', () => {
    const c = classifyCollectionRenameError({ status: 404, body: { error: 'not_found' } });
    expect(c.kind).toBe('not-found');
    expect(c.message).toBe(COLLECTION_RENAME_COPY.errNotFound);
    expect(c.dismiss).toBe(true);
  });

  it('reports the declared 400 as a refusal, not a fault', () => {
    // 400 is the only error status this operation declares besides 404, and it
    // covers both the framework's zod rejection and `metadata_cap_exceeded` —
    // which a name-only patch cannot trigger — so the copy does not claim a cause.
    expect(classifyCollectionRenameError({ status: 400 }).message).toBe(
      COLLECTION_RENAME_COPY.errRejected
    );
  });

  it('reports a transport failure as "nothing changed"', () => {
    const c = classifyCollectionRenameError(new Error('fetch failed') as never);
    expect(c.kind).toBe('other');
    expect(c.message).toBe(COLLECTION_RENAME_COPY.errNetwork);
  });

  it('states the stored name in the success line', () => {
    expect(renameResultMessage(NEW_NAME)).toBe('Renamed to “' + NEW_NAME + '”.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — the same component as the asset rename, not a look-alike
// ─────────────────────────────────────────────────────────────────────────────

describe('same affordance as the asset rename (AC2)', () => {
  let body: HTMLElement;

  beforeEach(() => {
    body = document.createElement('div');
    document.body.appendChild(body);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // Walk a built form down to tag + class + id, dropping the text. If the two
  // resources ever stop sharing public/rename-dialog.js, this diverges.
  function skeleton(root: HTMLElement): string[] {
    return [...root.querySelectorAll('*')].map(
      (n) => n.tagName.toLowerCase() + '#' + (n.id || '') + '.' + (n.className || '')
    );
  }

  it('builds a structurally identical dialog to the asset one', () => {
    const collHost = document.createElement('div');
    const assetHost = document.createElement('div');
    body.append(collHost, assetHost);

    buildCollectionRenameForm(collHost, { currentName: OLD_NAME });
    buildRenameForm(assetHost, { currentName: 'promo-cut.mov' });

    expect(skeleton(collHost)).toEqual(skeleton(assetHost));
    expect(collHost.classList.contains('rename-dialog')).toBe(true);
    // House form furniture, not a second dialog primitive for the second resource.
    expect(collHost.querySelector('.form-field')).not.toBeNull();
    expect(collHost.querySelector('.modal-actions')).not.toBeNull();
    expect(collHost.querySelector('.msg.msg-error')).not.toBeNull();
  });

  it('prefills the current name, caps it at the server maximum and labels the field', () => {
    const form = buildCollectionRenameForm(body, { currentName: OLD_NAME });
    expect(form.input.value).toBe(OLD_NAME);
    expect(form.input.maxLength).toBe(NAME_MAX);
    expect(body.querySelector('label[for="rename-name"]')?.textContent).toBe(
      COLLECTION_RENAME_COPY.fieldLabel
    );
    expect(form.input.getAttribute('aria-describedby')).toBe('rename-name-help');
    // The error area exists but is silent until something goes wrong.
    expect(form.errorEl.style.display).toBe('none');
    expect(form.errorEl.getAttribute('role')).toBe('alert');
  });

  it('says what a collection rename changes and what it leaves alone', () => {
    buildCollectionRenameForm(body, { currentName: OLD_NAME });
    const text = body.textContent || '';
    expect(text).toContain(COLLECTION_RENAME_COPY.dialogIntro);
    // The membership guarantee, stated to the operator rather than left implicit.
    expect(text).toContain(COLLECTION_RENAME_COPY.dialogStability);
  });

  it('renders a collection name as text, never as markup', () => {
    const nasty = '<img src=x onerror="alert(1)">';
    const form = buildCollectionRenameForm(body, { currentName: nasty });
    expect(body.querySelector('img')).toBeNull();
    expect(form.input.value).toBe(nasty);
  });

  it('fills the same copy slots as the asset deck, naming its own subject', () => {
    // Same slots, so the shared component can render either resource without a
    // missing sentence …
    expect(Object.keys(COLLECTION_RENAME_COPY).sort()).toEqual(Object.keys(RENAME_COPY).sort());
    for (const [slot, text] of Object.entries(COLLECTION_RENAME_COPY)) {
      expect(typeof text, slot).toBe('string');
      expect((text as string).length, slot).toBeGreaterThan(0);
    }
    // … and every sentence that names the thing being renamed calls it a
    // collection. (`dialogStability` does mention assets, on purpose: they are
    // the members a rename leaves alone.)
    for (const slot of [
      'dialogTitle',
      'dialogIntro',
      'errEmpty',
      'errUnchanged',
      'errForbidden',
      'errNotFound',
      'errRejected',
      'errNetwork',
    ] as const) {
      const text = COLLECTION_RENAME_COPY[slot];
      expect(text, slot).toMatch(/collection/i);
      expect(text, slot).not.toMatch(/\basset\b/i);
    }
    expect(COLLECTION_RENAME_COPY.dialogTitle).toBe('Rename collection');
  });

  it('offers no control at all to a role that cannot write', () => {
    const row = document.createElement('div');
    row.className = 'mt12 flex-gap';
    body.appendChild(row);

    const r = mountCollectionRename({
      collection: { id: 'coll-1', name: OLD_NAME },
      actionsRow: row,
      canChange: false,
      apiFetch: vi.fn(),
      openModal: vi.fn(),
      onRenamed: vi.fn(),
    });

    expect(r.button).toBeNull();
    // Absent, not "present but disabled".
    expect(row.querySelector('#btn-rename-collection')).toBeNull();
    expect(row.querySelectorAll('button')).toHaveLength(0);
  });

  it('uses the house button styling the asset control uses', () => {
    const row = document.createElement('div');
    row.className = 'mt12 flex-gap';
    body.appendChild(row);

    const r = mountCollectionRename({
      collection: { id: 'coll-1', name: OLD_NAME },
      actionsRow: row,
      canChange: true,
      apiFetch: vi.fn(),
      openModal: vi.fn(),
      onRenamed: vi.fn(),
    });

    expect(r.button!.className).toBe('btn-ghost');
    expect((r.button as HTMLButtonElement).type).toBe('button');
    expect(r.button!.textContent).toBe(COLLECTION_RENAME_COPY.btn);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — a collection can be renamed from the ops UI (real renderer, real router)
// ─────────────────────────────────────────────────────────────────────────────

describe('collection detail — rename affordance (issue #928)', () => {
  let app: FastifyInstance;
  let assets: InMemoryAssetRepository;
  let collections: InMemoryCollectionRepository;
  let collectionId: string;
  let memberIds: string[];
  let detailPanel: HTMLElement;
  let onRefresh: ReturnType<typeof vi.fn>;
  // Every PATCH body this UI sent, in order — the AC3 evidence.
  let patchBodies: Record<string, unknown>[];

  beforeEach(async () => {
    localStorage.clear();
    setClientRole('admin');

    assets = new InMemoryAssetRepository();
    collections = new InMemoryCollectionRepository();
    const first = await assets.create({ name: 'Promo cut' });
    const second = await assets.create({ name: 'Trailer cut' });
    memberIds = [first.id, second.id];

    const collection = await collections.create({ name: OLD_NAME });
    collectionId = collection.id;
    for (const assetId of memberIds) {
      await collections.addAsset(collectionId, assetId);
    }

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerAuth(app);
    // Wired exactly as the real app does (src/main.ts:488-490) so the UI's own
    // X-OVC-Role header reaches the ADR-018 gate and the 403 path is real.
    registerPrincipal(app, { trustRoleHeader: true });
    await app.register(collectionsRouter, {
      prefix: '/api/v1/collections',
      repository: collections,
      assetRepository: assets,
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
    onRefresh = vi.fn();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    localStorage.clear();
    await app.close();
  });

  async function openPanel(): Promise<void> {
    await showCollectionDetail(collectionId, detailPanel, onRefresh);
    await settle();
  }

  function renameBtn(): HTMLButtonElement | null {
    return detailPanel.querySelector<HTMLButtonElement>('#btn-rename-collection');
  }

  function dialogInput(): HTMLInputElement | null {
    return document.querySelector<HTMLInputElement>('#rename-name');
  }

  function dialogError(): string {
    const e = document.querySelector<HTMLElement>('#rename-dialog-error');
    return e && e.style.display !== 'none' ? e.textContent || '' : '';
  }

  function submitDialog(): void {
    document.querySelector<HTMLButtonElement>('#rename-submit')!.click();
  }

  // The "Name" row of the detail grid — what the operator reads as the current
  // name.
  function nameCellText(): string {
    const keys = [...detailPanel.querySelectorAll('.kv-key')];
    const nameKey = keys.find((k) => k.textContent === 'Name');
    return (nameKey?.nextElementSibling?.textContent || '').trim();
  }

  async function storedCollection(): Promise<{ name: string; assetIds: string[] }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collectionId}`,
      headers: { authorization: 'Bearer test' },
    });
    return res.json() as { name: string; assetIds: string[] };
  }

  it('mirrors the ADR-018 write gate: editor and admin only', () => {
    setClientRole('admin');
    expect(canRenameCollection()).toBe(true);
    setClientRole('editor');
    expect(canRenameCollection()).toBe(true);
    setClientRole('viewer');
    expect(canRenameCollection()).toBe(false);
  });

  it('offers a Rename control on the collection detail view', async () => {
    await openPanel();
    const btn = renameBtn();
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe(COLLECTION_RENAME_COPY.btn);
    expect(btn!.type).toBe('button');
    // It joins the detail panel's action row rather than inventing a block.
    expect(btn!.parentElement!.className).toContain('flex-gap');
  });

  it('hides the control from a viewer instead of offering a guaranteed 403', async () => {
    setClientRole('viewer');
    await openPanel();
    expect(renameBtn()).toBeNull();
  });

  it('opens a dialog prefilled with the current name', async () => {
    await openPanel();
    renameBtn()!.click();
    expect(dialogInput()).not.toBeNull();
    expect(dialogInput()!.value).toBe(OLD_NAME);
  });

  it('renames the collection: PATCHes exactly { name } and shows the new name (AC1)', async () => {
    await openPanel();
    expect(nameCellText()).toBe(OLD_NAME);

    renameBtn()!.click();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await settle();

    // The wire: one PATCH, carrying exactly one key.
    expect(patchBodies).toEqual([{ name: NEW_NAME }]);
    // The server stored it.
    expect((await storedCollection()).name).toBe(NEW_NAME);
    // The panel re-read and now shows the stored name, with the outcome reported.
    expect(nameCellText()).toBe(NEW_NAME);
    expect(detailPanel.textContent).toContain(renameResultMessage(NEW_NAME));
    // The dialog is gone.
    expect(dialogInput()).toBeNull();
    // And the collections list behind the panel was refreshed, so its Name
    // column cannot show a stale value.
    expect(onRefresh).toHaveBeenCalled();
  });

  it('sends the same authenticated headers as every other write (shared apiFetch)', async () => {
    const fetchSpy = vi.fn(globalThis.fetch as never);
    vi.stubGlobal('fetch', fetchSpy);

    await openPanel();
    renameBtn()!.click();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await settle();

    const patchCall = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH'
    )!;
    expect(patchCall).toBeDefined();
    expect(String(patchCall[0])).toMatch(
      new RegExp('/api/v1/collections/' + collectionId + '$')
    );
    const headers = (patchCall[1] as RequestInit).headers as Record<string, string>;
    // Not a bespoke fetch: the bearer presence gate (#740), the role mirror and
    // the JSON content type all come from apiFetch.
    expect(headers.Authorization).toMatch(/^Bearer ui-/);
    expect(headers['X-OVC-Role']).toBe('admin');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('leaves the collection’s members and id untouched (AC3)', async () => {
    const before = await storedCollection();
    expect(before.assetIds).toEqual(memberIds);

    await openPanel();
    renameBtn()!.click();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await settle();

    // Nothing that could move membership was ever sent …
    for (const body of patchBodies) {
      expect(Object.keys(body)).toEqual(['name']);
    }
    // … and the stored document agrees: same members, same order, same id.
    const after = await storedCollection();
    expect(after.assetIds).toEqual(memberIds);
    expect(after.name).toBe(NEW_NAME);
    // The member list on screen still shows both assets.
    const members = detailPanel.querySelector('#coll-members')!;
    expect(members.textContent).toContain('Promo cut');
    expect(members.textContent).toContain('Trailer cut');
  });

  it('refuses an empty name locally, without a request, and keeps what was typed', async () => {
    await openPanel();
    renameBtn()!.click();
    dialogInput()!.value = '   ';
    submitDialog();
    await settle();

    expect(patchBodies).toEqual([]);
    expect(dialogError()).toBe(COLLECTION_RENAME_COPY.errEmpty);
    // Still open, so the operator can fix it.
    expect(dialogInput()).not.toBeNull();
    expect((await storedCollection()).name).toBe(OLD_NAME);
  });

  it('refuses a no-op rename rather than spending a write on it', async () => {
    await openPanel();
    renameBtn()!.click();
    submitDialog(); // untouched, still the current name
    await settle();

    expect(patchBodies).toEqual([]);
    expect(dialogError()).toBe(COLLECTION_RENAME_COPY.errUnchanged);
  });

  it('explains the real 403 from the router and stops offering a control that cannot work', async () => {
    // The control is normally absent for a viewer. Mount it with canChange true
    // under a viewer role to drive the SERVER's refusal — the client-side mirror
    // is not the authority.
    await openPanel();
    setClientRole('viewer');
    const row = detailPanel.querySelector<HTMLElement>('.flex-gap')!;
    row.innerHTML = '';

    const mounted = mountCollectionRename({
      collection: { id: collectionId, name: OLD_NAME },
      actionsRow: row,
      canChange: true,
      // The app's own apiFetch and openModal, so the request that reaches the
      // router is the real one (including the X-OVC-Role header).
      apiFetch: apiFetch,
      openModal: openModal,
      onRenamed: vi.fn(),
    });
    expect(mounted.button).not.toBeNull();

    mounted.button!.click();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await settle();

    expect(dialogError()).toBe(COLLECTION_RENAME_COPY.errForbidden);
    // The control that is known to fail is removed, not left to be clicked again.
    expect(row.querySelector('#btn-rename-collection')).toBeNull();
    // The refusal changed nothing.
    expect((await storedCollection()).name).toBe(OLD_NAME);
  });

  it('closes on a 404 and reports it, because there is nothing left to rename', async () => {
    await openPanel();
    renameBtn()!.click();
    dialogInput()!.value = NEW_NAME;

    // The collection disappears between opening the dialog and submitting it.
    await collections.delete(collectionId);
    submitDialog();
    await settle();

    expect(dialogInput()).toBeNull();
    expect(detailPanel.textContent).toContain(COLLECTION_RENAME_COPY.errNotFound);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3, from the server's side: the body is `.strict()`, so membership cannot be
// smuggled through the rename endpoint even by a hand-rolled caller.
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/collections/{id} refuses membership fields', () => {
  let app: FastifyInstance;
  let collections: InMemoryCollectionRepository;
  let collectionId: string;
  let memberId: string;

  beforeEach(async () => {
    const assets = new InMemoryAssetRepository();
    collections = new InMemoryCollectionRepository();
    const asset = await assets.create({ name: 'Promo cut' });
    memberId = asset.id;
    const collection = await collections.create({ name: OLD_NAME });
    collectionId = collection.id;
    await collections.addAsset(collectionId, memberId);

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
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const patch = (payload: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}`,
      headers: { authorization: 'Bearer test', 'x-ovc-role': 'admin' },
      payload: payload as never,
    });

  it('accepts a name-only body with 200 and the updated collection', async () => {
    const res = await patch({ name: NEW_NAME });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; assetIds: string[] };
    expect(body.name).toBe(NEW_NAME);
    expect(body.assetIds).toEqual([memberId]);
  });

  it('rejects an assetIds key outright (.strict), so membership stays on its own routes', async () => {
    const res = await patch({ name: NEW_NAME, assetIds: [] });
    expect(res.statusCode).toBe(400);
    // The rename did not happen as a side effect of the refusal.
    const after = await collections.get(collectionId);
    expect(after?.name).toBe(OLD_NAME);
    expect(after?.assetIds).toEqual([memberId]);
  });

  it('rejects an empty name, which is why the dialog checks it client-side first', async () => {
    const res = await patch({ name: '' });
    expect(res.statusCode).toBe(400);
    expect((await collections.get(collectionId))?.name).toBe(OLD_NAME);
  });
});
