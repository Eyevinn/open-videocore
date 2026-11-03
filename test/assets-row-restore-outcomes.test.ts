// @vitest-environment happy-dom
//
// The ROW-LEVEL Restore action's failure outcomes (issue #836), driven through
// the real Assets tab so the assertions land on the shipped handler
// (public/app.js `onRestore`) rather than a hand-rolled stand-in.
//
// Two outcomes are pinned here because each one is a rule this repo already
// states elsewhere, and the row-level control has to obey the same rule as the
// detail panel's #btn-restore-asset:
//
//   404 — the row is KNOWN-STALE (it is offering Restore for a lifecycle state
//         the API says the asset is not in), so it must trigger a table reload,
//         the same way onRename treats a 404 ("the row on screen is stale, and
//         the reload is what removes it") and the detail panel re-reads itself.
//   410 — a purged tombstone is terminal: NOT the shared action-failure dialog
//         (whose whole vocabulary is "try again"), and the control that led
//         there is REMOVED from the DOM, not left greyed out (issue #933).
//
// Contract grounding — read in the live tree before these tests were written
// (CLAUDE.md rule 7):
//   - openapi.json .paths["/api/v1/assets/{id}/restore"] — the only key is
//     `post`; `post.responses` keys are exactly 200 / 404 / 410; one required
//     path parameter `id` (string); `requestBody` is absent.
//   - 404 and 410 both answer on the shared error envelope
//     `{ type: object, properties: { error, message }, required: ["error"],
//     additionalProperties: false }` — `error` is the only guaranteed field.
//   - src/routes/assets.ts:8059-8103 — `app.post('/:id/restore')`, schema
//     `response: { 200: assetSchema, 404: errorSchema, 410: errorSchema }`
//     (:8063), mounted under `/api/v1/assets`.
//   - src/routes/assets.ts:8075 — the single 410 emitter,
//     `reply.code(410).send({ error: 'gone', message: 'asset has been purged' })`,
//     reached when `repo.getState(id).kind === 'tombstone'`.
//   - src/routes/assets.ts:8080 — the single 404 emitter,
//     `reply.code(404).send({ error: 'not_found' })`, when `repo.restore(id)`
//     returns nothing (unknown id OR not currently archived — indistinguishable).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetsTab } from '../public/app.js';

const ULID = '01JA000000000000000000ARCH';

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function tick(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

type RestoreOutcome = { status: number; body: unknown };

// A fetch stub that serves the assets list and routes POST /:id/restore to one
// outcome. `listsAfterRestore` is what the list returns once the restore has
// been attempted — the truthful model for a tombstone, which the list tier
// excludes by construction (src/data/asset-repo.ts:1583-1587), is that the row
// disappears.
function stubApi(opts: {
  restore: RestoreOutcome;
  listsAfterRestore: 'row-gone' | 'row-unchanged';
}) {
  const state = { listReads: 0, restorePosts: 0, restored: false };

  const fetchMock = vi.fn(async (url: unknown, init: RequestInit = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();

    if (method === 'POST' && u.includes('/restore')) {
      state.restorePosts += 1;
      state.restored = true;
      return jsonResponse(opts.restore.body, opts.restore.status);
    }

    if (method === 'GET' && u.includes('/assets')) {
      state.listReads += 1;
      const rowGone = state.restored && opts.listsAfterRestore === 'row-gone';
      return jsonResponse({
        items: rowGone
          ? []
          : [
              {
                id: ULID,
                name: 'retired-promo.mov',
                status: 'archived',
                createdAt: '2026-09-20T10:00:00.000Z',
              },
            ],
        total: rowGone ? 0 : 1,
      });
    }

    return jsonResponse({ items: [], total: 0 });
  });

  vi.stubGlobal('fetch', fetchMock);
  return state;
}

function restoreControl(root: ParentNode): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>('.asset-restore-btn');
}

describe('row-level Restore failure outcomes (issue #836)', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  afterEach(() => {
    document.body.innerHTML = '';
    try { localStorage.clear(); } catch { /* ignore */ }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('a 404 reloads the table — the row is known-stale, as onRename treats its 404', async () => {
    const state = stubApi({
      restore: { status: 404, body: { error: 'not_found' } },
      listsAfterRestore: 'row-gone',
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderAssetsTab(container);
    await tick();

    const readsBeforeClick = state.listReads;
    expect(readsBeforeClick).toBeGreaterThan(0);

    const btn = restoreControl(container);
    expect(btn, 'the archived row must offer Restore').toBeTruthy();
    btn!.click();
    await tick();

    expect(state.restorePosts).toBe(1);
    // The reload is the point: a 404 means the API disagrees with what this row
    // is showing, so the list is re-read instead of left stale.
    expect(state.listReads).toBeGreaterThan(readsBeforeClick);
    // A 404 is retryable in class, so it IS reported the ordinary way.
    expect(document.querySelector('.modal-body.error-dialog')).not.toBeNull();
  });

  it('a 410 does not use the action-failure dialog, removes the control, and reloads', async () => {
    const state = stubApi({
      restore: { status: 410, body: { error: 'gone', message: 'asset has been purged' } },
      listsAfterRestore: 'row-gone',
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderAssetsTab(container);
    await tick();

    const readsBeforeClick = state.listReads;
    const btn = restoreControl(container)!;
    expect(btn).toBeTruthy();
    btn.click();
    await tick();

    expect(state.restorePosts).toBe(1);

    // 1. Not the shared action-failure dialog, and not the retryable red box.
    expect(document.querySelector('.modal-body.error-dialog')).toBeNull();
    expect(document.querySelector('.msg-error')).toBeNull();

    // 2. The terminal notice is rendered, in the list view's own host, and says
    //    it is unrecoverable in a machine-readable way.
    const host = container.querySelector('#assets-row-action-msg')!;
    const notice = host.querySelector('.msg-unrecoverable')!;
    expect(notice).not.toBeNull();
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.getAttribute('data-outcome')).toBe('unrecoverable');
    expect(notice.textContent).toContain('retired-promo.mov');

    // 3. The control is REMOVED, not greyed out: the clicked button is detached
    //    from the document, and no Restore control (disabled or otherwise) is
    //    left in the table.
    expect(btn.isConnected).toBe(false);
    expect(restoreControl(container)).toBeNull();

    // 4. The table is re-read, like the detail panel's assetsTable.reload().
    expect(state.listReads).toBeGreaterThan(readsBeforeClick);
  });

  it('a 403 changes nothing: no reload, and the control comes back for a retry', async () => {
    const state = stubApi({
      restore: { status: 403, body: { error: 'forbidden' } },
      listsAfterRestore: 'row-unchanged',
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderAssetsTab(container);
    await tick();

    const readsBeforeClick = state.listReads;
    const btn = restoreControl(container)!;
    btn.click();
    await tick();

    expect(state.restorePosts).toBe(1);
    expect(state.listReads).toBe(readsBeforeClick);
    expect(btn.isConnected).toBe(true);
    expect(btn.disabled).toBe(false);
    expect((btn.textContent || '').trim()).toBe('Restore');
    expect(document.querySelector('.modal-body.error-dialog')).not.toBeNull();
    expect(container.querySelector('#assets-row-action-msg')!.children.length).toBe(0);
  });
});
