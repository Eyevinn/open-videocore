// @vitest-environment happy-dom
//
// Asset rename affordance in the ops UI (issue #956).
//
// PATCH /api/v1/assets/{id} has always accepted `name` and round-tripped it;
// nothing in the UI could trigger it. These tests cover the new control end to
// end: the pure input/body/error helpers, the detail-view integration driven
// through the REAL renderer (renderAssetDetailBody — the same code path the
// asset side panel and the detached detail window use), and the list/search
// tiers picking the new name up (acceptance criterion 1).
//
// CONTRACT GROUNDING — every path, field, method and status below was read from
// this repo's route source and generated spec before the tests were written
// (CLAUDE.md rule 7), never from the issue text:
//
//   openapi.json .paths["/api/v1/assets/{id}"].patch
//     parameters: exactly one — path `id` (string, required); no query params.
//     requestBody schema: properties name (string, minLength 1, maxLength 256),
//       description, objectKey, status, metadata, tags;
//       additionalProperties: false. All optional.
//     responses: exactly 200 (the FULL asset), 404, 422.
//     Source: `updateSchema` src/routes/assets.ts:409-419 — `name:
//       z.string().min(1).max(256).optional()` at :411, `.refine(b =>
//       Object.keys(b).length > 0)` at :419 — wired at `app.patch('/:id', …)`
//       src/routes/assets.ts:5532-5541.
//
//   `name` is the canonical editorial title and the single documented location
//     for it across GET, list and search responses (the property's own
//     description in openapi.json). Both search backends read live asset
//     documents — InMemorySearchRepository via `assets.list()`
//     (src/data/inmemory-search-repo.ts:38), CouchSearchRepository via
//     `couch.find` (src/data/couch-search-repo.ts:50-56) — so there is no
//     separate name index that a rename could leave stale.
//
//   AC2 (id / slug / object keys survive a rename) is a property of the
//     REPOSITORY, verified there rather than assumed: `slug` is minted once in
//     `create` by `generateUniqueSlug` (src/data/asset-repo.ts:1424) and neither
//     update path assigns it — `InMemoryAssetRepository.update`
//     (src/data/asset-repo.ts:1620-1701) and `CouchAssetRepository.applyPatch`
//     (src/data/couch-asset-repo.ts:376-447) copy the existing asset and assign
//     ONLY the keys the patch carries (`if (patch.name !== undefined) next.name
//     = patch.name;` at :1631 / :379). Object keys derive from the ASSET ID:
//     `sourceObjectKey(assetId) => 'sources/' + assetId`
//     (src/routes/asset-upload.ts:96-98). The UI's side of that criterion is
//     that it sends `name` and nothing else, which the wire assertions below
//     pin down, and the fixture server here mirrors the repository rule so a
//     regression that started deriving a slug from the name would fail loudly.
//
//   Authorisation — MATRIX (src/auth/authorize.ts:54-58) grants `write` to
//     editor and admin only; methodToAction (:79-93) maps PATCH -> write;
//     resourceAuthorizationPreHandler('asset') (:126, registered
//     src/routes/assets.ts:1718) applies it. 403 code
//     AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role' (:99).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetDetailBody, setClientRole, canRenameAsset } from '../public/app.js';
import { createAssetsTable } from '../public/assets-table.js';
import {
  NAME_MAX,
  RENAME_COPY,
  buildRenameForm,
  classifyRenameError,
  mountAssetRename,
  normaliseRenameInput,
  renameRequestBody,
  renameResultMessage,
} from '../public/asset-rename.js';

const ULID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';
const SLUG = 'brave-river-042';
const OBJECT_KEY = 'sources/' + ULID;
const OLD_NAME = 'promo-cut.mov';
const NEW_NAME = 'Autumn campaign — master';

type AssetDoc = {
  id: string;
  name: string;
  slug: string;
  objectKey: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  statusHistory: { at: string; from: string | null; to: string }[];
};

const freshAsset = (): AssetDoc => ({
  id: ULID,
  name: OLD_NAME,
  slug: SLUG,
  objectKey: OBJECT_KEY,
  status: 'ready',
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
  statusHistory: [{ at: '2026-09-20T10:00:00.000Z', from: null, to: 'ready' }],
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('rename input validation (against the server bounds)', () => {
  it('accepts a changed name and hands back the trimmed value', () => {
    const r = normaliseRenameInput('  Autumn campaign  ', OLD_NAME);
    expect(r).toEqual({ value: 'Autumn campaign', ok: true, reason: null, message: null });
  });

  it('refuses an empty or whitespace-only name without inventing a default', () => {
    // `name: z.string().min(1)` — the schema refuses it, so the dialog does too,
    // before a request is made.
    for (const raw of ['', '   ', '\n\t']) {
      const r = normaliseRenameInput(raw, OLD_NAME);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('empty');
      expect(r.message).toBe(RENAME_COPY.errEmpty);
    }
  });

  it('accepts exactly the maximum length and refuses one character more', () => {
    expect(NAME_MAX).toBe(256);
    expect(normaliseRenameInput('x'.repeat(NAME_MAX), OLD_NAME).ok).toBe(true);
    const tooLong = normaliseRenameInput('x'.repeat(NAME_MAX + 1), OLD_NAME);
    expect(tooLong.ok).toBe(false);
    expect(tooLong.reason).toBe('too-long');
    expect(tooLong.message).toBe(RENAME_COPY.errTooLong);
  });

  it('refuses a no-op rename, including one that differs only in whitespace', () => {
    expect(normaliseRenameInput(OLD_NAME, OLD_NAME).reason).toBe('unchanged');
    expect(normaliseRenameInput('  ' + OLD_NAME + ' ', OLD_NAME).reason).toBe('unchanged');
  });

  it('treats a missing current name as renameable rather than unchanged', () => {
    expect(normaliseRenameInput('First title', undefined).ok).toBe(true);
  });
});

describe('rename request body', () => {
  it('carries exactly one key: name', () => {
    const body = renameRequestBody(NEW_NAME);
    expect(body).toEqual({ name: NEW_NAME });
    expect(Object.keys(body)).toEqual(['name']);
  });

  it('never carries a sibling field the schema would also accept', () => {
    // additionalProperties: false means only the six declared properties can be
    // sent at all — the risk is sending a DECLARED one by accident. `objectKey`
    // is the stored-file pointer AC2 requires to stay put, and `status` /
    // `tags` / `metadata` / `description` are fields this action does not own.
    const body = renameRequestBody(NEW_NAME) as Record<string, unknown>;
    for (const forbidden of ['objectKey', 'status', 'tags', 'metadata', 'description', 'slug', 'id']) {
      expect(body[forbidden]).toBeUndefined();
    }
  });
});

describe('rename error classification', () => {
  it('maps the role gate to the role sentence and keeps the dialog open', () => {
    const c = classifyRenameError({ status: 403, body: { error: 'forbidden_insufficient_role' } });
    expect(c.kind).toBe('forbidden');
    expect(c.message).toBe(RENAME_COPY.errForbidden);
    expect(c.dismiss).toBe(false);
    // The machine code is never shown to the operator.
    expect(c.message).not.toMatch(/forbidden_insufficient_role/);
    expect(classifyRenameError({ status: 401 }).kind).toBe('forbidden');
  });

  it('treats a 404 as terminal for the dialog', () => {
    const c = classifyRenameError({ status: 404, body: { error: 'not_found' } });
    expect(c.kind).toBe('not-found');
    expect(c.message).toBe(RENAME_COPY.errNotFound);
    expect(c.dismiss).toBe(true);
  });

  it('reports a schema/state rejection as a refusal, not a fault', () => {
    expect(classifyRenameError({ status: 400 }).message).toBe(RENAME_COPY.errRejected);
    expect(classifyRenameError({ status: 422 }).message).toBe(RENAME_COPY.errRejected);
  });

  it('reports a transport failure as "nothing changed"', () => {
    const c = classifyRenameError(new Error('fetch failed') as never);
    expect(c.kind).toBe('other');
    expect(c.message).toBe(RENAME_COPY.errNetwork);
  });

  it('states the stored name in the success line', () => {
    expect(renameResultMessage(NEW_NAME)).toBe('Renamed to “' + NEW_NAME + '”.');
  });
});

describe('rename form (pure render)', () => {
  let body: HTMLElement;

  beforeEach(() => {
    body = document.createElement('div');
    document.body.appendChild(body);
  });

  afterEach(() => {
    body.remove();
  });

  it('prefills the current name, caps it at the server maximum and labels the field', () => {
    const form = buildRenameForm(body, { currentName: OLD_NAME });
    expect(form.input.value).toBe(OLD_NAME);
    expect(form.input.maxLength).toBe(NAME_MAX);
    expect(body.querySelector('label[for="rename-name"]')?.textContent).toBe(RENAME_COPY.fieldLabel);
    expect(form.input.getAttribute('aria-describedby')).toBe('rename-name-help');
    // The error area exists but is silent until something goes wrong.
    expect(form.errorEl.style.display).toBe('none');
    expect(form.errorEl.getAttribute('role')).toBe('alert');
  });

  it('says what a rename changes and what it leaves alone', () => {
    buildRenameForm(body, { currentName: OLD_NAME });
    const text = body.textContent || '';
    expect(text).toContain(RENAME_COPY.dialogIntro);
    // The AC2 guarantee, stated to the operator rather than left implicit.
    expect(text).toContain(RENAME_COPY.dialogStability);
  });

  it('renders an asset name as text, never as markup', () => {
    const nasty = '<img src=x onerror="alert(1)">';
    const form = buildRenameForm(body, { currentName: nasty });
    expect(body.querySelector('img')).toBeNull();
    expect(form.input.value).toBe(nasty);
  });

  it('reuses the house form furniture rather than a new dialog primitive', () => {
    buildRenameForm(body, { currentName: OLD_NAME });
    expect(body.classList.contains('rename-dialog')).toBe(true);
    expect(body.querySelector('.form-field')).not.toBeNull();
    expect(body.querySelector('.modal-actions')).not.toBeNull();
    expect(body.querySelector('.msg.msg-error')).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mount-level behaviour (no network, injected openModal/apiFetch)
// ─────────────────────────────────────────────────────────────────────────────

describe('rename control mounting', () => {
  let row: HTMLElement;

  beforeEach(() => {
    row = document.createElement('div');
    row.className = 'mt12 flex-gap';
    document.body.appendChild(row);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('offers no control at all to a role that cannot write', () => {
    const r = mountAssetRename({
      asset: freshAsset(),
      actionsRow: row,
      canChange: false,
      apiFetch: vi.fn(),
      openModal: vi.fn(),
      onRenamed: vi.fn(),
    });
    expect(r.button).toBeNull();
    // Absent, not "present but disabled".
    expect(row.querySelector('#btn-rename-asset')).toBeNull();
    expect(row.querySelectorAll('button')).toHaveLength(0);
  });

  it('places the control in the existing action row, before the given anchor', () => {
    const anchor = document.createElement('button');
    anchor.id = 'btn-extract-meta';
    row.appendChild(anchor);

    mountAssetRename({
      asset: freshAsset(),
      actionsRow: row,
      beforeEl: anchor,
      canChange: true,
      apiFetch: vi.fn(),
      openModal: vi.fn(),
      onRenamed: vi.fn(),
    });

    const ids = Array.from(row.querySelectorAll('button')).map((b) => b.id);
    expect(ids).toEqual(['btn-rename-asset', 'btn-extract-meta']);
    // House button styling, not a bespoke class.
    expect(row.querySelector('#btn-rename-asset')!.className).toBe('btn-ghost');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail view integration — the real renderer against a stubbed API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fixture server for one asset. PATCH applies the patch the same way the
 * repository does — assigning ONLY the keys the body carries — so `slug`,
 * `id` and `objectKey` can only change here if the CLIENT sent them.
 */
function assetServer(overrides?: { patchStatus?: number; patchBody?: unknown }) {
  const store = freshAsset();
  const patches: Record<string, unknown>[] = [];
  const fetchSpy = vi.fn(async (url: string, opts?: RequestInit) => {
    const path = String(url);
    const method = (opts && opts.method) || 'GET';
    if (/\/review-state$/.test(path)) {
      return json({ reviewState: 'draft', allowedTransitions: ['in-review'] });
    }
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) {
      if (method === 'PATCH') {
        const patch = JSON.parse(String(opts?.body || '{}')) as Record<string, unknown>;
        patches.push(patch);
        if (overrides?.patchStatus && overrides.patchStatus >= 400) {
          return json(overrides.patchBody ?? { error: 'rejected' }, overrides.patchStatus);
        }
        // Mirror of the repository rule (asset-repo.ts:1631 /
        // couch-asset-repo.ts:379): assign only what the patch carries.
        Object.assign(store, patch);
        store.updatedAt = '2026-09-21T09:00:00.000Z';
        return json(store);
      }
      return json(store);
    }
    return json({});
  });
  return { fetchSpy, store, patches };
}

async function settle(ticks = 40) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function titleCellText(container: ParentNode): string {
  const keys = Array.from(container.querySelectorAll('.kv-key'));
  const titleKey = keys.find((k) => k.textContent === 'Title');
  return (titleKey?.nextElementSibling?.textContent || '').trim();
}

function slugCellText(container: ParentNode): string {
  const keys = Array.from(container.querySelectorAll('.kv-key'));
  const slugKey = keys.find((k) => k.textContent === 'Slug');
  return (slugKey?.nextElementSibling?.textContent || '').trim();
}

function dialogInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('#rename-name');
}

function dialogError(): string {
  const e = document.querySelector<HTMLElement>('#rename-dialog-error');
  return e && e.style.display !== 'none' ? e.textContent || '' : '';
}

function submitDialog() {
  document.querySelector<HTMLButtonElement>('#rename-submit')!.click();
}

describe('asset detail — rename affordance (issue #956)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('mirrors the ADR-018 write gate: editor and admin only', () => {
    setClientRole('admin');
    expect(canRenameAsset()).toBe(true);
    setClientRole('editor');
    expect(canRenameAsset()).toBe(true);
    setClientRole('viewer');
    expect(canRenameAsset()).toBe(false);
  });

  it('offers a Rename control on the detail view', async () => {
    const { fetchSpy } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const btn = container.querySelector<HTMLButtonElement>('#btn-rename-asset');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe(RENAME_COPY.btn);
    expect(btn!.type).toBe('button');
  });

  it('hides the control from a viewer instead of offering a guaranteed 403', async () => {
    setClientRole('viewer');
    const { fetchSpy } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(container.querySelector('#btn-rename-asset')).toBeNull();
  });

  it('opens a dialog prefilled with the current name', async () => {
    const { fetchSpy } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-rename-asset')!.click();

    expect(dialogInput()).not.toBeNull();
    expect(dialogInput()!.value).toBe(OLD_NAME);
  });

  it('PATCHes the ULID path with exactly { name } and shows the new title', async () => {
    const { fetchSpy, patches } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    expect(titleCellText(container)).toBe(OLD_NAME);

    container.querySelector<HTMLButtonElement>('#btn-rename-asset')!.click();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await settle();

    const patchCall = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH'
    )!;
    expect(patchCall).toBeDefined();
    // The ULID, never the slug: PATCH /:id has no slug fallback.
    expect(String(patchCall[0])).toMatch(new RegExp('/api/v1/assets/' + ULID + '$'));
    expect(patches).toEqual([{ name: NEW_NAME }]);

    // The pane re-read from the API and now shows the stored name.
    expect(titleCellText(container)).toBe(NEW_NAME);
    expect(container.textContent).toContain(renameResultMessage(NEW_NAME));
    // The dialog is gone.
    expect(dialogInput()).toBeNull();
  });

  it('sends the same authenticated headers as every other write (shared apiFetch)', async () => {
    const { fetchSpy } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-rename-asset')!.click();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await settle();

    const patchCall = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH'
    )!;
    const headers = (patchCall[1] as RequestInit).headers as Record<string, string>;
    // Not a bespoke fetch: the bearer presence gate (#740), the role mirror and
    // the JSON content type all come from apiFetch.
    expect(headers.Authorization).toMatch(/^Bearer ui-/);
    expect(headers['X-OVC-Role']).toBe('admin');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('leaves id, slug and the stored object key untouched (AC2)', async () => {
    const { fetchSpy, store, patches } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    const slugBefore = slugCellText(container);

    container.querySelector<HTMLButtonElement>('#btn-rename-asset')!.click();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await settle();

    // Nothing that could move the identity or the bytes was ever sent.
    for (const patch of patches) {
      expect(Object.keys(patch)).toEqual(['name']);
    }
    // And the server-side document agrees: only the name (and updatedAt) moved.
    expect(store.name).toBe(NEW_NAME);
    expect(store.id).toBe(ULID);
    expect(store.slug).toBe(SLUG);
    expect(store.objectKey).toBe(OBJECT_KEY);
    // The rendered slug is the same one that was on screen before the rename —
    // no slug is re-derived from the new name.
    expect(slugCellText(container)).toBe(slugBefore);
    expect(slugCellText(container)).toBe(SLUG);
    expect(container.textContent).not.toContain('autumn-campaign');
  });

  it('refuses an empty name locally, without a request, and keeps what was typed', async () => {
    const { fetchSpy, patches } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-rename-asset')!.click();
    dialogInput()!.value = '   ';
    submitDialog();
    await settle();

    expect(patches).toEqual([]);
    expect(dialogError()).toBe(RENAME_COPY.errEmpty);
    // Still open, so the operator can fix it.
    expect(dialogInput()).not.toBeNull();
  });

  it('refuses a no-op rename rather than spending a write on it', async () => {
    const { fetchSpy, patches } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-rename-asset')!.click();
    submitDialog(); // untouched, still the current name
    await settle();

    expect(patches).toEqual([]);
    expect(dialogError()).toBe(RENAME_COPY.errUnchanged);
  });

  it('explains a 403 in the dialog and stops offering a control that cannot work', async () => {
    const { fetchSpy } = assetServer({
      patchStatus: 403,
      patchBody: { error: 'forbidden_insufficient_role', message: 'write denied' },
    });
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-rename-asset')!.click();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await settle();

    expect(dialogError()).toBe(RENAME_COPY.errForbidden);
    expect(container.querySelector('#btn-rename-asset')).toBeNull();
    // The title is unchanged — the refusal changed nothing.
    expect(titleCellText(container)).toBe(OLD_NAME);
  });

  it('closes on a 404 and reports it, because there is nothing left to rename', async () => {
    const { fetchSpy } = assetServer({ patchStatus: 404, patchBody: { error: 'not_found' } });
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-rename-asset')!.click();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await settle();

    expect(dialogInput()).toBeNull();
    expect(container.textContent).toContain(RENAME_COPY.errNotFound);
  });

  it('keeps the dialog usable after a transport failure', async () => {
    const { fetchSpy } = assetServer();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();
    container.querySelector<HTMLButtonElement>('#btn-rename-asset')!.click();
    dialogInput()!.value = NEW_NAME;

    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    submitDialog();
    await settle();

    expect(dialogError()).toBe(RENAME_COPY.errNetwork);
    const submit = document.querySelector<HTMLButtonElement>('#rename-submit')!;
    // Never left stuck in its pending state.
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe(RENAME_COPY.btnSave);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — the new name shows up in the asset list AND in search results
// ─────────────────────────────────────────────────────────────────────────────

describe('renamed asset in the list and search tiers (AC1)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  // The table routes to GET /api/v1/assets/ with no `q` and to GET
  // /api/v1/search/ when a free-text term is present (public/assets-table.js).
  // Both tiers project the same `name` field off the live asset document, so one
  // store serves both here.
  function tableDeps(store: AssetDoc, calls: string[]) {
    return {
      renderBadge: (s: string) => '<span class="badge">' + s + '</span>',
      renderTags: () => '',
      fmtDate: (v: string) => String(v || '—'),
      isAssetWedged: () => false,
      apiFetch: vi.fn(async (path: string) => {
        calls.push(path);
        if (path.startsWith('/search')) {
          return { assets: [store], collections: [], total: 1, collectionTotal: 0, page: 1 };
        }
        return { items: [store], limit: 20, offset: 0, total: 1 };
      }),
      win: {
        location: { search: '', pathname: '/', hash: '' },
        history: { state: null, replaceState: () => {}, pushState: () => {} },
      },
    };
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('shows the new name on the list tier after a reload', async () => {
    const store = freshAsset();
    const calls: string[] = [];
    const t = createAssetsTable(tableDeps(store, calls));
    document.body.appendChild(t.el);
    await tick();
    expect(t.el.querySelector('tbody')!.textContent).toContain(OLD_NAME);

    // The rename landed server-side; the table re-reads exactly as the detail
    // pane's onRenamed hook makes it.
    store.name = NEW_NAME;
    await t.reload();
    await tick();

    expect(calls.every((c) => c.startsWith('/assets'))).toBe(true);
    const bodyText = t.el.querySelector('tbody')!.textContent || '';
    expect(bodyText).toContain(NEW_NAME);
    expect(bodyText).not.toContain(OLD_NAME);
    // The row is still the same asset.
    expect(t.el.querySelector('tbody tr[data-row-key]')!.getAttribute('data-row-key')).toBe(ULID);
  });

  it('shows the new name on the search tier after a reload', async () => {
    const store = freshAsset();
    const calls: string[] = [];
    const t = createAssetsTable(tableDeps(store, calls));
    document.body.appendChild(t.el);
    await tick();

    // Switch to the free-text tier.
    const q = t.el.querySelector<HTMLInputElement>('.ops-filter-q input')!;
    q.value = 'campaign';
    q.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    await tick();
    expect(calls.some((c) => c.startsWith('/search'))).toBe(true);

    store.name = NEW_NAME;
    await t.reload();
    await tick();

    expect(calls[calls.length - 1].startsWith('/search')).toBe(true);
    expect(t.el.querySelector('tbody')!.textContent).toContain(NEW_NAME);
  });
});
