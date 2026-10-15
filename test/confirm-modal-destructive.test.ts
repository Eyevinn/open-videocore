// @vitest-environment happy-dom
//
// DOM/unit tests for the destructive-action confirmation dialog that replaces
// native `confirm()` across the ops UI (issue #919, broken out from #853).
//
// Acceptance criteria under test:
//   1. No native `confirm()` remains on any destructive operator-facing path in
//      public/app.js (source scan — the only way to assert absence).
//   2. Every destructive confirmation names its subject by a human-readable name,
//      not an id.
//   3. Every destructive confirmation states what IS and what is NOT affected.
//   4. One dialog per action.
//
// Verified contract sources for the impact wording asserted below (CLAUDE.md
// rule 7 — each was read in the live tree, not assumed):
//   - Asset archive is a SOFT delete: DELETE /api/v1/assets/{id} sets status to
//     `archived` and destroys nothing (src/routes/assets.ts:5474-5560, "Soft
//     delete: archive rather than destroy"; file header :10-11). Reversible via
//     POST /api/v1/assets/{id}/restore (:5626-5660). Files are deleted only by
//     the retention purge sweep (src/pipeline/archived-asset-purge-sweep.ts) and
//     only when a window is configured (RETENTION_DISABLED_MS,
//     src/routes/retention.ts:36).
//   - Collection delete removes ONLY the grouping: the handler calls
//     `repo.delete(id)` with no cascade (src/routes/collections.ts:383-436) and a
//     collection is a flat list of member ids (src/data/collection-repo.ts:19-25).
//     A non-empty collection is refused 409 `delete_blocked` /
//     `member_of_collection` unless `?force=true` (collections.ts:407-414), which
//     this UI deliberately does not send.
//   - Collection list read shape: `assetIds` is the authoritative member list
//     (collectionSchema, src/routes/collections.ts:80-91); `assets` exists only
//     on GET /collections/{id} (collectionWithAssetsSchema, :96-98).
//   - Webhook read shape has NO name field: { id, url, events, hasSecret,
//     createdAt } (registrationBaseSchema, src/routes/webhooks.ts:43-49), so the
//     URL is the human-readable identifier. Secrets are never readable back
//     (:25-26).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  confirmModal,
  nameOrFallback,
  TAB_RENDERERS,
} from '../public/app.js';

// Read from the repo root (vitest runs with cwd = project root). `import.meta.url`
// is not a file: URL under the happy-dom environment, so it cannot be used here.
const APP_JS = readFileSync(resolve(process.cwd(), 'public/app.js'), 'utf8');

function jsonResponse(payload: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: status === 204 ? {} : { 'content-type': 'application/json' },
  });
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function dialog() {
  return document.querySelector('.confirm-dialog') as HTMLElement | null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
  document.body.innerHTML = '';
});

// ─── AC1: no native confirm() anywhere in the UI source ────────────────────────

describe('no native confirm() remains (issue #919 AC1)', () => {
  it('public/app.js contains no native confirm() call', () => {
    // Strip line comments first so prose mentioning confirm() cannot mask a real
    // call (and so a real call cannot hide behind one).
    const code = APP_JS.split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    // A native call is `confirm(` not preceded by an identifier character or a
    // dot — this still matches `window.confirm(`? No: that is caught by the
    // separate assertion below.
    const bare = code.match(/(^|[^\w.])confirm\s*\(/g) || [];
    expect(bare).toEqual([]);
    expect(code).not.toMatch(/window\s*\.\s*confirm\s*\(/);
  });

  it('every destructive path in app.js goes through confirmModal', () => {
    // The nine operator-facing destructive/bulk-write actions that used to call
    // confirm(): archive asset, delete collection, delete profile, seed profiles,
    // delete webhook, delete object, remove stack, deprovision scene detection,
    // deprovision subtitle generation.
    const calls = APP_JS.match(/confirmModal\(\{/g) || [];
    expect(calls.length).toBe(9);
  });
});

// ─── AC2/AC3/AC4: the confirmModal primitive ───────────────────────────────────

const SPEC = {
  title: 'Delete collection',
  subject: 'Summer campaign rushes',
  question: 'Delete collection "Summer campaign rushes"?',
  confirmLabel: 'Delete collection',
  affected: ['The collection record and its list of members are deleted.'],
  unaffected: ['No assets are deleted.'],
};

describe('confirmModal (issue #919 AC2/AC3/AC4)', () => {
  it('names the subject by its human-readable name and never by an id', () => {
    void confirmModal(SPEC);
    const el = dialog();
    expect(el).toBeTruthy();
    expect(el!.textContent).toContain('Summer campaign rushes');
  });

  it('states BOTH what is affected and what is not affected', () => {
    void confirmModal(SPEC);
    const el = dialog()!;

    const affected = el.querySelector('.confirm-affected') as HTMLElement;
    const unaffected = el.querySelector('.confirm-unaffected') as HTMLElement;
    expect(affected).toBeTruthy();
    expect(unaffected).toBeTruthy();
    expect(affected.textContent).toContain('What this affects');
    expect(affected.querySelectorAll('li').length).toBe(1);
    expect(affected.textContent).toContain('list of members are deleted');
    expect(unaffected.textContent).toContain('What this does not affect');
    expect(unaffected.querySelectorAll('li').length).toBe(1);
    expect(unaffected.textContent).toContain('No assets are deleted');
  });

  it('opens exactly ONE dialog per call', () => {
    void confirmModal(SPEC);
    expect(document.querySelectorAll('.modal-backdrop').length).toBe(1);
    expect(document.querySelectorAll('.confirm-dialog').length).toBe(1);
  });

  it('resolves true only when the confirm control is activated', async () => {
    const p = confirmModal(SPEC);
    (dialog()!.querySelector('.confirm-accept') as HTMLButtonElement).click();
    await expect(p).resolves.toBe(true);
    expect(dialog()).toBeNull();
  });

  it('resolves false on Cancel', async () => {
    const p = confirmModal(SPEC);
    (dialog()!.querySelector('.confirm-cancel') as HTMLButtonElement).click();
    await expect(p).resolves.toBe(false);
    expect(dialog()).toBeNull();
  });

  it('resolves false on the × close control', async () => {
    const p = confirmModal(SPEC);
    (document.querySelector('.modal-close-btn') as HTMLButtonElement).click();
    await expect(p).resolves.toBe(false);
  });

  it('resolves false on Escape', async () => {
    const p = confirmModal(SPEC);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(p).resolves.toBe(false);
  });

  it('resolves false on a backdrop click', async () => {
    const p = confirmModal(SPEC);
    const backdrop = document.querySelector('.modal-backdrop') as HTMLElement;
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await expect(p).resolves.toBe(false);
  });

  it('focuses Cancel, not the destructive control, so a stray Enter cannot act', () => {
    void confirmModal(SPEC);
    expect(document.activeElement).toBe(dialog()!.querySelector('.confirm-cancel'));
  });

  it('settles exactly once even if the dialog is dismissed after confirming', async () => {
    const p = confirmModal(SPEC);
    const el = dialog()!;
    (el.querySelector('.confirm-accept') as HTMLButtonElement).click();
    // A second interaction (or a late Escape) must not flip the result.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(p).resolves.toBe(true);
  });

  it('renders subject names as text, never as markup', () => {
    void confirmModal({
      ...SPEC,
      subject: '<img src=x onerror=alert(1)>',
      question: 'Delete collection "<img src=x onerror=alert(1)>"?',
    });
    const el = dialog()!;
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

// ─── nameOrFallback: never degrade to an id ────────────────────────────────────

describe('nameOrFallback (issue #919)', () => {
  it('prefers the first non-empty candidate', () => {
    expect(nameOrFallback('Rushes reel', 'slug', 'this asset')).toBe('Rushes reel');
    expect(nameOrFallback('', '  ', 'my-slug', 'this asset')).toBe('my-slug');
  });

  it('falls back to a descriptive phrase, not an id, when no name exists', () => {
    expect(nameOrFallback('', null, undefined, 'this collection')).toBe('this collection');
  });
});

// ─── Integration: the Collections tab delete flow ──────────────────────────────

describe('Collections tab delete confirmation (issue #919)', () => {
  // EMPTY, so the delete is actually offered. Issue #921 short-circuits a
  // collection the list already shows as blocked (locked, or still holding
  // members) BEFORE the confirmation, so the confirm path below is the
  // empty-collection path; the blocked path has its own suite in
  // test/preflight-destructive-validation.test.ts.
  const COLLECTION = {
    id: '01J8ZQF7TESTCOLLECTIONID',
    name: 'Summer campaign rushes',
    assetIds: [] as string[],
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  };

  async function renderTab(collection: Record<string, unknown>) {
    const calls: { method: string; path: string }[] = [];
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api\/v1/, '');
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ method, path });
      if (path === '/collections' && method === 'GET') {
        return jsonResponse({ collections: [collection] });
      }
      if (method === 'DELETE') return jsonResponse(null, 204);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchStub);

    const container = document.createElement('div');
    document.body.appendChild(container);
    await TAB_RENDERERS['collections'](container);
    await flush();
    return { container, calls };
  }

  it('names the collection by name (never by id) and issues NO DELETE until confirmed', async () => {
    const { container, calls } = await renderTab(COLLECTION);

    const deleteBtn = container.querySelector('.coll-delete-btn') as HTMLButtonElement;
    expect(deleteBtn).toBeTruthy();
    deleteBtn.click();
    await flush();

    const el = dialog();
    expect(el).toBeTruthy();
    // Exactly one dialog for the action.
    expect(document.querySelectorAll('.confirm-dialog').length).toBe(1);
    // Subject is the human-readable name; the opaque id is NOT presented as the
    // subject anywhere in the dialog.
    expect(el!.textContent).toContain('Summer campaign rushes');
    expect(el!.textContent).not.toContain(COLLECTION.id);
    // Impact is stated both ways, grounded in the real handler semantics.
    expect(el!.querySelector('.confirm-affected')!.textContent).toContain('audit log');
    expect(el!.querySelector('.confirm-unaffected')!.textContent).toContain('No assets are deleted');
    // Nothing was sent by merely opening the dialog.
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);

    // Cancelling still sends nothing.
    (el!.querySelector('.confirm-cancel') as HTMLButtonElement).click();
    await flush();
    expect(dialog()).toBeNull();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('does not ask for confirmation at all once the API is known to refuse (issue #921)', async () => {
    // The #919 behaviour was a confirmation that WARNED about the refusal; #921
    // replaced it with an explanation and no confirm control. assetIds.length
    // === 2 (collectionSchema, src/routes/collections.ts:95).
    const { container, calls } = await renderTab({
      ...COLLECTION,
      assetIds: ['01J8A', '01J8B'],
    });
    (container.querySelector('.coll-delete-btn') as HTMLButtonElement).click();
    await flush();
    const el = dialog()!;
    expect(el.querySelector('.confirm-accept')).toBeNull();
    expect(el.textContent).toContain('still holds 2 assets');
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('says the delete will go through when the collection is empty', async () => {
    const { container } = await renderTab(COLLECTION);
    (container.querySelector('.coll-delete-btn') as HTMLButtonElement).click();
    await flush();
    const affected = dialog()!.querySelector('.confirm-affected')!.textContent || '';
    expect(affected).toContain('empty');
    expect(affected).not.toContain('refuse the delete');
  });

  // A delete-locked collection is refused whatever its member count: the lock
  // guard (src/routes/collections.ts:453-455, CollectionDeleteProtectedError ->
  // 409 delete_blocked / reason delete_protected) runs BEFORE the emptiness
  // check (:490-492) and `?force=true` never applies to it. An EMPTY locked
  // collection is the trap case, so that is what this pins — and since #921 it
  // is explained instead of confirmed.
  it('explains an empty but delete-locked collection instead of confirming it', async () => {
    const { container, calls } = await renderTab({
      ...COLLECTION,
      assetIds: [],
      deleteLock: { locked: true, lockedAt: '2026-01-01T00:00:00.000Z' },
    });
    (container.querySelector('.coll-delete-btn') as HTMLButtonElement).click();
    await flush();
    const el = dialog()!;
    const text = el.textContent || '';
    expect(el.querySelector('.confirm-accept')).toBeNull();
    expect(text).toContain('delete lock');
    // Must NOT promise an outcome the lock guard will veto.
    expect(text).not.toContain('will go through');
    // Names the only route that lifts the lock (collections.ts:572-584).
    expect(text).toContain('/collections/{id}/lock');
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('DELETEs the collection once the operator confirms', async () => {
    const { container, calls } = await renderTab(COLLECTION);
    (container.querySelector('.coll-delete-btn') as HTMLButtonElement).click();
    await flush();
    (dialog()!.querySelector('.confirm-accept') as HTMLButtonElement).click();
    await flush();

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(1);
    expect(deletes[0]!.path).toBe('/collections/' + COLLECTION.id);
  });
});

// ─── Integration: the Assets tab archive flow ──────────────────────────────────

describe('Assets tab archive confirmation (issue #919)', () => {
  const ASSET = {
    id: '01J8ZQF7TESTASSETID00000',
    slug: 'summer-promo',
    name: 'Summer promo master',
    status: 'ready',
    tags: [],
    createdAt: '2026-03-01T00:00:00.000Z',
  };

  async function renderTab() {
    const calls: { method: string; path: string }[] = [];
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api\/v1/, '');
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ method, path });
      if (method === 'GET' && path.startsWith('/assets')) {
        return jsonResponse({ items: [ASSET], total: 1, limit: 25, offset: 0 });
      }
      if (method === 'DELETE') return jsonResponse(null, 204);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchStub);

    const container = document.createElement('div');
    document.body.appendChild(container);
    await TAB_RENDERERS['assets'](container);
    await flush();
    return { container, calls };
  }

  it('names the asset by its title, states the soft-delete impact, and archives only on confirm', async () => {
    const { container, calls } = await renderTab();

    const archiveBtn = container.querySelector('.asset-delete-btn') as HTMLButtonElement;
    expect(archiveBtn).toBeTruthy();
    // The human-readable label is carried on the control itself.
    expect(archiveBtn.dataset['name']).toBe('Summer promo master');

    archiveBtn.click();
    await flush();

    const el = dialog();
    expect(el).toBeTruthy();
    expect(document.querySelectorAll('.confirm-dialog').length).toBe(1);
    expect(el!.textContent).toContain('Summer promo master');
    expect(el!.textContent).not.toContain(ASSET.id);

    // The wording reflects the VERIFIED soft-delete semantics: status -> archived,
    // reversible via Restore, files removed only by the retention sweep.
    const affected = el!.querySelector('.confirm-affected')!.textContent || '';
    const unaffected = el!.querySelector('.confirm-unaffected')!.textContent || '';
    expect(affected).toContain('archived');
    expect(affected).toContain('retention');
    expect(unaffected).toContain('Restore');
    expect(unaffected).toContain('stay in storage');
    // The archive is not guaranteed: four guards run ahead of it
    // (src/routes/assets.ts:5499-5540 — delete lock, active job reference,
    // countChildren, collection membership) and this UI sends no `force`, so the
    // dialog must admit the archive can be refused with nothing changed.
    expect(affected).toContain('refuses the archive and nothing changes');

    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);

    (el!.querySelector('.confirm-accept') as HTMLButtonElement).click();
    await flush();

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(1);
    expect(deletes[0]!.path).toBe('/assets/' + ASSET.id);
  });

  it('cancelling the archive dialog sends nothing', async () => {
    const { container, calls } = await renderTab();
    (container.querySelector('.asset-delete-btn') as HTMLButtonElement).click();
    await flush();
    (dialog()!.querySelector('.confirm-cancel') as HTMLButtonElement).click();
    await flush();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });
});
