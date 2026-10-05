// @vitest-environment happy-dom
//
// The assets LIST rename affordance (issue #927 — "inline-in-list" alongside the
// detail-view control that shipped with #956).
//
// These tests drive the REAL wiring: TAB_RENDERERS['assets'] builds the real
// assets table with app.js's real handler, real openModal and real apiFetch over a
// stubbed `fetch`. So they cover the thing an operator actually touches — the row
// control, the dialog it opens, the request it sends and the repaint afterwards —
// rather than a re-implementation of it.
//
// Acceptance criteria covered here:
//   AC1 — an asset can be renamed from the ops UI through the existing PATCH.
//   AC2 — the new name appears in the asset list after the rename (and on the
//         free-text search tier, which is the other projection the table renders).
//   AC4 — no PATCH schema change: the body carries exactly `{ name }`.
// AC3 (id / slug / stored object keys unchanged) is a property of the API and is
// asserted against the real route in test/asset-rename-identity-stability.test.ts;
// the client's half of it — that it sends `name` and nothing else — is asserted
// below on the wire.
//
// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT GROUNDING (CLAUDE.md rule 7 — read in this tree, not taken from the
// issue text).
//
//   PATCH /api/v1/assets/{id} — openapi.json .paths["/api/v1/assets/{id}"].patch
//     parameters: exactly one, path `id` (string, required);
//     requestBody properties: `name` (string, minLength 1, maxLength 256),
//       `description`, `objectKey`, `status`, `metadata`, `tags`, all optional,
//       `additionalProperties: false`;
//     responses: 200 (the full asset), 404, 422.
//     Source: `updateSchema` src/routes/assets.ts:418 (`name` at :420), wired at
//     `app.patch('/:id', …)` src/routes/assets.ts:5682.
//
//   The row has everything the rename needs on BOTH tiers:
//     tier 1 (GET /api/v1/assets/) items carry `id`, `slug` and `name`;
//     tier 2 (GET /api/v1/search/) assets carry `id` and `name` — `assetSchema`,
//     src/routes/search.ts:77-90. Neither tier is missing a field this control
//     depends on, unlike the delete-lock badge (whose field the search projection
//     omits), so the control is offered on both.
//
//   Role gate — `MATRIX` (src/auth/authorize.ts:54-58) grants `write` to `editor`
//     and `admin` only; `methodToAction` (:79-93) maps PATCH -> write;
//     `resourceAuthorizationPreHandler('asset')` (:126, registered
//     src/routes/assets.ts:1718) applies it. So a `viewer` would always earn a 403
//     (`forbidden_insufficient_role`, :99) and is offered no control. The client
//     gate is a MIRROR, so the 403 path is still exercised below.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TAB_RENDERERS, setClientRole } from '../public/app.js';
import { RENAME_COPY } from '../public/asset-rename.js';

const ULID = '01J8ZQF7LISTASSETID00000';
const SLUG = 'brave-river-042';
const OLD_NAME = 'promo-cut.mov';
const NEW_NAME = 'Autumn campaign — master';

type Row = {
  id: string;
  slug?: string;
  name: string;
  status: string;
  tags: string[];
  createdAt: string;
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: status === 204 ? {} : { 'content-type': 'application/json' },
  });
}

async function flush() {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
}

type Call = { method: string; path: string; body?: Record<string, unknown> };

/**
 * A fixture API for one asset, served on both tiers.
 *
 * PATCH applies the patch the way the repository does — assigning ONLY the keys
 * the body carries (asset-repo.ts:1631 / couch-asset-repo.ts:379) — so `slug` can
 * only move here if the CLIENT sent it.
 */
function stubApi(opts?: { patchStatus?: number; patchBody?: unknown }) {
  const row: Row = {
    id: ULID,
    slug: SLUG,
    name: OLD_NAME,
    status: 'ready',
    tags: [],
    createdAt: '2026-03-01T00:00:00.000Z',
  };
  const calls: Call[] = [];
  let removed = false;

  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const full = String(url);
    const path = full.replace(/^.*\/api\/v1/, '');
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body });

    if (method === 'PATCH' && /^\/assets\//.test(path)) {
      if (opts?.patchStatus && opts.patchStatus >= 400) {
        if (opts.patchStatus === 404) removed = true;
        return jsonResponse(opts.patchBody ?? { error: 'rejected' }, opts.patchStatus);
      }
      Object.assign(row, body);
      return jsonResponse(row);
    }
    // The detail pane's reads, so a test can open the side panel for this row.
    if (method === 'GET' && /^\/assets\/[^/?]+\/review-state/.test(path)) {
      return jsonResponse({ reviewState: 'draft', allowedTransitions: ['in-review'] });
    }
    if (method === 'GET' && /^\/assets\/[^/?]+\/executions/.test(path)) return jsonResponse([]);
    if (method === 'GET' && /^\/assets\/[^/?]+\/delivery/.test(path)) {
      return jsonResponse({ urls: {} });
    }
    if (method === 'GET' && /^\/assets\/[^/?]+\/files/.test(path)) {
      return jsonResponse({ files: [], fileGroups: [] });
    }
    if (method === 'GET' && /^\/assets\/[^/?]+\/profiles/.test(path)) {
      return jsonResponse({ profiles: [] });
    }
    // A single asset — distinct from the list below, which is `/assets` or
    // `/assets?…`. This is what the detail pane re-reads after a rename.
    if (method === 'GET' && /^\/assets\/[^/?]+$/.test(path)) {
      return jsonResponse(row);
    }
    // Tier 2 — free-text search. Same `name`, read live from the same record.
    if (method === 'GET' && path.startsWith('/search')) {
      const items = removed ? [] : [{ ...row, slug: undefined }];
      return jsonResponse({ assets: items, collections: [], total: items.length, page: 1 });
    }
    // Tier 1 — the list.
    if (method === 'GET' && path.startsWith('/assets')) {
      const items = removed ? [] : [row];
      return jsonResponse({ items, total: items.length, limit: 20, offset: 0 });
    }
    return jsonResponse({});
  });

  return { fetchStub, row, calls };
}

async function renderTab(stub: ReturnType<typeof stubApi>, search = '') {
  vi.stubGlobal('fetch', stub.fetchStub);
  // The table reconstructs sort/filter/page from the URL; seeding `assets.q`
  // selects the free-text tier.
  window.history.replaceState(null, '', '/' + search);

  const container = document.createElement('div');
  document.body.appendChild(container);
  await TAB_RENDERERS['assets'](container);
  await flush();
  return container;
}

const renameBtn = (c: ParentNode) =>
  c.querySelector('.asset-rename-btn[data-id="' + ULID + '"]') as HTMLButtonElement | null;

const dialogInput = () => document.querySelector('#rename-name') as HTMLInputElement | null;
const dialogError = () => {
  const e = document.querySelector('#rename-dialog-error') as HTMLElement | null;
  return e && e.style.display !== 'none' ? e.textContent || '' : '';
};
const submitDialog = () => (document.querySelector('#rename-submit') as HTMLButtonElement).click();
const cancelDialog = () => (document.querySelector('.rename-cancel') as HTMLButtonElement).click();

/** The text of the "Name / Title" cell for the fixture row. */
function titleCellText(c: ParentNode): string {
  const headers = Array.from(c.querySelectorAll('thead th')).map((th) =>
    (th.textContent || '').trim()
  );
  const idx = headers.indexOf('Name / Title');
  const tr = c.querySelector('tbody tr[data-row-key="' + ULID + '"]');
  if (idx < 0 || !tr) throw new Error('no title cell for the fixture row');
  return (tr.querySelectorAll('td')[idx]?.textContent || '').trim();
}

const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH');
const listReads = (calls: Call[]) =>
  calls.filter(
    (c) =>
      c.method === 'GET' && (/^\/assets(\?|$)/.test(c.path) || c.path.startsWith('/search'))
  );
/** GETs for the single asset — what the detail pane reads, not what the list reads. */
const singleAssetReads = (calls: Call[]) =>
  calls.filter((c) => c.method === 'GET' && /^\/assets\/[^/?]+$/.test(c.path));

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('assets list — the row rename control (issue #927)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('offers a Rename control on the row, carrying the ULID and the current title', async () => {
    const stub = stubApi();
    const container = await renderTab(stub);

    const btn = renameBtn(container)!;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe(RENAME_COPY.btn);
    // The ULID, never the slug: PATCH /:id has no slug fallback.
    expect(btn.dataset['id']).toBe(ULID);
    expect(btn.dataset['id']).not.toBe(SLUG);
    // The same label the Name / Title column renders, so the dialog can prefill
    // without a second GET.
    expect(btn.dataset['name']).toBe(OLD_NAME);
    // House button styling, not a bespoke class.
    expect(btn.className).toBe('btn-ghost asset-rename-btn');
  });

  it('offers no control at all to a viewer, rather than one that can only 403', async () => {
    setClientRole('viewer');
    const stub = stubApi();
    const container = await renderTab(stub);
    expect(renameBtn(container)).toBeNull();
    // The row is still there and still archivable-looking — only the write
    // affordance this role cannot use is withheld.
    expect(container.querySelector('tbody tr[data-row-key="' + ULID + '"]')).toBeTruthy();
  });

  it('offers it to an editor, the other role that holds write', async () => {
    setClientRole('editor');
    const stub = stubApi();
    const container = await renderTab(stub);
    expect(renameBtn(container)).toBeTruthy();
  });

  it('opens the detail view’s dialog — prefilled, and without opening the row', async () => {
    const stub = stubApi();
    const container = await renderTab(stub);

    renameBtn(container)!.click();
    await flush();

    // The SAME dialog as the detail view: same field id, same copy deck.
    expect(dialogInput()).toBeTruthy();
    expect(dialogInput()!.value).toBe(OLD_NAME);
    const dialog = document.querySelector('.modal-dialog') as HTMLElement;
    expect(dialog.textContent).toContain(RENAME_COPY.dialogIntro);
    expect(dialog.textContent).toContain(RENAME_COPY.dialogStability);
    // Clicking the control must not also open the side detail panel.
    const panel = document.querySelector('#asset-detail') as HTMLElement;
    expect(panel.style.display).toBe('none');
  });

  it('PATCHes exactly { name } to the ULID path and shows the new title in the list', async () => {
    const stub = stubApi();
    const container = await renderTab(stub);
    const readsBefore = listReads(stub.calls).length;

    renameBtn(container)!.click();
    await flush();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await flush();

    const sent = patches(stub.calls);
    expect(sent.length).toBe(1);
    expect(sent[0]!.path).toBe('/assets/' + ULID);
    // AC4: no schema change — one field, the one the body already declared.
    expect(Object.keys(sent[0]!.body!)).toEqual(['name']);
    expect(sent[0]!.body!['name']).toBe(NEW_NAME);

    // AC2: the list now shows the new name, and it got there by re-reading the
    // list rather than by patching the cell locally.
    expect(listReads(stub.calls).length).toBeGreaterThan(readsBefore);
    expect(titleCellText(container)).toBe(NEW_NAME);
    expect(container.textContent).not.toContain(OLD_NAME);
    // The dialog is gone.
    expect(dialogInput()).toBeNull();
  });

  it('never sends the slug, the id, or any other patchable field', async () => {
    const stub = stubApi();
    const container = await renderTab(stub);

    renameBtn(container)!.click();
    await flush();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await flush();

    for (const forbidden of ['slug', 'id', 'objectKey', 'status', 'description', 'metadata', 'tags']) {
      expect(patches(stub.calls)[0]!.body).not.toHaveProperty(forbidden);
    }
    // And the fixture record agrees: only the name moved.
    expect(stub.row.slug).toBe(SLUG);
    expect(stub.row.id).toBe(ULID);
    expect(stub.row.name).toBe(NEW_NAME);
  });

  it('renames from the free-text search tier too, where the row has no slug', async () => {
    const stub = stubApi();
    const container = await renderTab(stub, '?assets.q=promo');
    // Confirm the rows really came from the search tier.
    expect(stub.calls.some((c) => c.path.startsWith('/search'))).toBe(true);

    const btn = renameBtn(container)!;
    expect(btn).toBeTruthy();
    expect(btn.dataset['id']).toBe(ULID);

    btn.click();
    await flush();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await flush();

    expect(patches(stub.calls).map((c) => c.path)).toEqual(['/assets/' + ULID]);
    expect(titleCellText(container)).toBe(NEW_NAME);
  });

  it('sends nothing when the dialog is cancelled, and leaves the row alone', async () => {
    const stub = stubApi();
    const container = await renderTab(stub);
    const readsBefore = listReads(stub.calls).length;

    renameBtn(container)!.click();
    await flush();
    dialogInput()!.value = NEW_NAME;
    cancelDialog();
    await flush();

    expect(patches(stub.calls)).toEqual([]);
    // No pointless repaint either: nothing changed, so nothing is re-read.
    expect(listReads(stub.calls).length).toBe(readsBefore);
    expect(titleCellText(container)).toBe(OLD_NAME);
  });

  it('refuses an empty name locally, with no request, keeping what was typed', async () => {
    const stub = stubApi();
    const container = await renderTab(stub);

    renameBtn(container)!.click();
    await flush();
    dialogInput()!.value = '   ';
    submitDialog();
    await flush();

    expect(patches(stub.calls)).toEqual([]);
    expect(dialogError()).toBe(RENAME_COPY.errEmpty);
    expect(dialogInput()!.value).toBe('   ');
  });

  it('refuses a no-op rename rather than spending a write on it', async () => {
    const stub = stubApi();
    const container = await renderTab(stub);

    renameBtn(container)!.click();
    await flush();
    submitDialog();
    await flush();

    expect(patches(stub.calls)).toEqual([]);
    expect(dialogError()).toBe(RENAME_COPY.errUnchanged);
  });

  it('explains a 403 in the dialog and does not repaint the list', async () => {
    // The client-side role mirror can be wrong — a deployment that trusts the role
    // header can refuse a write the UI thought was allowed. The server is the
    // authority, so this path must still be handled.
    const stub = stubApi({
      patchStatus: 403,
      patchBody: { error: 'forbidden_insufficient_role', message: 'role cannot write' },
    });
    const container = await renderTab(stub);
    const readsBefore = listReads(stub.calls).length;

    renameBtn(container)!.click();
    await flush();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await flush();

    // Dialog stays open with the explanation, so what was typed is not lost.
    expect(dialogInput()).toBeTruthy();
    expect(dialogError()).toBe(RENAME_COPY.errForbidden);
    expect(listReads(stub.calls).length).toBe(readsBefore);
    expect(titleCellText(container)).toBe(OLD_NAME);
  });

  it('closes on a 404 and refreshes the list, because the row is stale', async () => {
    const stub = stubApi({ patchStatus: 404, patchBody: { error: 'not_found' } });
    const container = await renderTab(stub);
    const readsBefore = listReads(stub.calls).length;

    renameBtn(container)!.click();
    await flush();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await flush();

    expect(dialogInput()).toBeNull();
    // The list is re-read: the asset is gone, and the row must go with it.
    expect(listReads(stub.calls).length).toBeGreaterThan(readsBefore);
    expect(container.querySelector('tbody tr[data-row-key="' + ULID + '"]')).toBeNull();
  });

  it('re-reads an open detail pane that is showing the renamed asset', async () => {
    const stub = stubApi();
    const container = await renderTab(stub);

    // Open the side panel for this row, the way a click does.
    (container.querySelector('tbody tr[data-row-key="' + ULID + '"]') as HTMLElement).click();
    await flush();
    const panel = container.querySelector('#asset-detail') as HTMLElement;
    expect(panel.style.display).toBe('flex');
    const detailReadsBefore = singleAssetReads(stub.calls).length;

    renameBtn(container)!.click();
    await flush();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await flush();

    // The pane renders the same `name`, so it must not be left showing the old
    // title after a rename started from the row behind it.
    expect(singleAssetReads(stub.calls).length).toBeGreaterThan(detailReadsBefore);
    expect(panel.textContent).toContain(NEW_NAME);
  });

  it('does not read the asset again when no detail pane is open', async () => {
    const stub = stubApi();
    const container = await renderTab(stub);

    renameBtn(container)!.click();
    await flush();
    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await flush();

    // The list reload is the only read a closed pane needs; re-reading the single
    // asset would be a request with nowhere to render.
    expect(singleAssetReads(stub.calls)).toEqual([]);
  });

  it('keeps the dialog usable after a transport failure', async () => {
    const stub = stubApi();
    const container = await renderTab(stub);
    renameBtn(container)!.click();
    await flush();

    // Fail only the PATCH, then let a retry succeed.
    const good = stub.fetchStub.getMockImplementation()!;
    let failed = false;
    stub.fetchStub.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!failed && (init?.method || 'GET').toUpperCase() === 'PATCH') {
        failed = true;
        throw new TypeError('network down');
      }
      return good(url, init);
    });

    dialogInput()!.value = NEW_NAME;
    submitDialog();
    await flush();

    expect(dialogError()).toBe(RENAME_COPY.errNetwork);
    expect(dialogInput()).toBeTruthy();
    expect((document.querySelector('#rename-submit') as HTMLButtonElement).disabled).toBe(false);
    expect((document.querySelector('#rename-submit') as HTMLButtonElement).textContent).toBe(
      RENAME_COPY.btnSave
    );

    // The retry goes through and the list catches up.
    submitDialog();
    await flush();
    expect(patches(stub.calls).length).toBe(1);
    expect(titleCellText(container)).toBe(NEW_NAME);
  });
});
