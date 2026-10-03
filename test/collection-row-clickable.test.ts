// @vitest-environment happy-dom
//
// Collection rows are clickable and keyboard-operable (issue #951).
//
// The Collections tab only opened a collection through the per-row View button:
// a click anywhere else on the row did nothing, and the row was not in the tab
// order at all, so a keyboard user could reach the buttons but never the row
// affordance the rest of the ops UI offers (Assets and Jobs tables both open a
// detail panel on row click). This suite drives the REAL Collections tab
// (public/app.js renderCollectionsTab, reached through the exported
// TAB_RENDERERS map) against the REAL collections router, so "the row opens the
// detail" is asserted against the request the detail panel actually issues.
//
// Verified contract (per CLAUDE.md rule 7):
//   - GET /api/v1/collections — src/routes/collections.ts:315 (`app.get('/')`,
//     mounted at prefix /api/v1/collections). 200 body is an ARRAY of
//     `collectionSchema` (src/routes/collections.ts:80-91); the list row reads
//     `id`, `name`, `assetIds`, `createdAt` and `deleteLock` from it.
//   - GET /api/v1/collections/:id — src/routes/collections.ts:338
//     (`app.get('/:id')`), 200 body `collectionWithAssetsSchema`
//     (:96-98) = collectionSchema + `assets`. This is the request the detail
//     panel makes (showCollectionDetail -> apiFetch('/collections/' + id)), so
//     counting it is how "the detail view opened" and "it opened exactly once"
//     are told apart.
//   - DELETE /api/v1/collections/:id — src/routes/collections.ts:383. Not
//     exercised here beyond opening its confirmation dialog: the point of the
//     Delete case is that the destructive button must not ALSO open the row.
//   - UI request path: apiFetch (public/app.js) supplies the bearer the 401
//     presence gate requires (authGate, src/auth/middleware.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerAuth } from '../src/auth/middleware.js';
import { collectionsRouter } from '../src/routes/collections.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryCollectionRepository } from '../src/data/inmemory-collection-repo.js';

import { TAB_RENDERERS } from '../public/app.js';

async function settle(ticks = 30): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('collection row is clickable and keyboard-operable (issue #951)', () => {
  let app: FastifyInstance;
  let container: HTMLElement;
  let collectionId: string;
  /** Every path apiFetch asked for, so detail opens can be counted. */
  let requested: string[];

  function rows(): HTMLTableRowElement[] {
    return [...container.querySelectorAll('#coll-list-wrap tbody tr')] as HTMLTableRowElement[];
  }

  function detailPanel(): HTMLElement {
    return container.querySelector('#coll-detail') as HTMLElement;
  }

  function detailOpens(): number {
    return requested.filter((p) => p === `/api/v1/collections/${collectionId}`).length;
  }

  function closeDetail(): void {
    (detailPanel().querySelector('#close-coll-detail') as HTMLButtonElement).click();
  }

  beforeEach(async () => {
    const assets = new InMemoryAssetRepository();
    const collections = new InMemoryCollectionRepository();
    const collection = await collections.create({ name: 'Evening bulletins' });
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
    await app.ready();

    requested = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      requested.push(u.pathname);
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
    container = document.createElement('div');
    document.body.appendChild(container);
    await TAB_RENDERERS['collections'](container);
    await settle();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  // Acceptance criterion 1.
  it('opens the detail view when the row itself is clicked', async () => {
    const row = rows()[0];
    expect(row.dataset.id).toBe(collectionId);
    expect(detailPanel().style.display).toBe('none');

    // A cell, not a button: the click the row previously swallowed.
    (row.querySelector('td.cell-id') as HTMLElement).click();
    await settle();

    expect(detailPanel().style.display).toBe('block');
    expect(detailOpens()).toBe(1);
    expect(detailPanel().textContent).toContain('Evening bulletins');
  });

  // Acceptance criterion 2.
  it('keeps the View button working', async () => {
    (rows()[0].querySelector('.coll-view-btn') as HTMLButtonElement).click();
    await settle();

    expect(detailPanel().style.display).toBe('block');
    expect(detailPanel().textContent).toContain('Evening bulletins');
  });

  // The regression the row handler could introduce: View sits inside the row,
  // so without stopPropagation one click would open the detail twice.
  it('opens the detail exactly once when the View button is clicked', async () => {
    (rows()[0].querySelector('.coll-view-btn') as HTMLButtonElement).click();
    await settle();

    expect(detailOpens()).toBe(1);
  });

  // Acceptance criterion 3 — reachable.
  it('puts every row in the keyboard tab order', () => {
    const all = rows();
    expect(all.length).toBeGreaterThan(0);
    all.forEach((row) => {
      expect(row.getAttribute('tabindex')).toBe('0');
      expect(row.tabIndex).toBe(0);
    });
  });

  // Acceptance criterion 3 — activatable.
  it.each(['Enter', ' '])('activates the row with %j', async (key) => {
    const row = rows()[0];
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    row.dispatchEvent(ev);
    await settle();

    expect(detailPanel().style.display).toBe('block');
    expect(detailOpens()).toBe(1);
    // Space must not also scroll the page.
    expect(ev.defaultPrevented).toBe(true);
  });

  it('ignores keys that are not Enter or Space', async () => {
    rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await settle();

    expect(detailPanel().style.display).toBe('none');
    expect(detailOpens()).toBe(0);
  });

  // Enter/Space on an inner button bubbles to the row. Without the target
  // guard, keyboard-activating Delete would open the detail panel too.
  it('does not open the detail when a key is pressed on an inner button', async () => {
    const btn = rows()[0].querySelector('.coll-delete-btn') as HTMLButtonElement;
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(detailPanel().style.display).toBe('none');
    expect(detailOpens()).toBe(0);
  });

  // Clicking the destructive button must raise its confirmation and nothing
  // else — the detail panel must not open behind the dialog.
  it('does not open the detail when the Delete button is clicked', async () => {
    (rows()[0].querySelector('.coll-delete-btn') as HTMLButtonElement).click();
    await settle();

    const dialog = document.querySelector('.confirm-cancel') as HTMLButtonElement | null;
    expect(dialog).not.toBeNull();
    expect(detailPanel().style.display).toBe('none');
    expect(detailOpens()).toBe(0);

    dialog!.click();
    await settle();
  });

  // The row delegates to the same opener the View button uses, so a second
  // activation re-renders the panel rather than stacking panels.
  it('re-opens cleanly after the detail is closed', async () => {
    (rows()[0].querySelector('td.cell-id') as HTMLElement).click();
    await settle();
    closeDetail();
    expect(detailPanel().style.display).toBe('none');

    (rows()[0].querySelector('td.cell-id') as HTMLElement).click();
    await settle();

    expect(detailPanel().style.display).toBe('block');
    expect(container.querySelectorAll('#coll-detail .detail-panel-header').length).toBe(1);
  });
});
