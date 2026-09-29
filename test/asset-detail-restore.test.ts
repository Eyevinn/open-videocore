// @vitest-environment happy-dom
//
// Restore action on the asset detail view (issue #889).
//
// POST /api/v1/assets/:id/restore is the only way back out of `archived`, but it
// had no affordance anywhere in the ops UI. These tests drive the real detail
// renderer (renderAssetDetailBody — the exact code path used by BOTH the asset
// side panel and the detached detail window) against a stubbed fetch and assert:
//   - an archived asset offers the restore action; a non-archived one does not;
//   - restoring calls the documented route with the asset's ULID and no body;
//   - the re-rendered view shows the returned pre-archive status AND the newly
//     appended `archived -> ready|failed` transition in the status history;
//   - 410 (purged) is reported as unrecoverable and retires the control;
//   - 404 (nothing to restore) is reported honestly, without guessing which of
//     its two indistinguishable causes applied.
//
// Contract grounding — fetched from the spec + route source before these tests
// were written (CLAUDE.md rule 7):
//   - openapi.json .paths["/api/v1/assets/{id}/restore"]: the only key is `post`;
//     its `responses` keys are exactly 200 / 404 / 410; one path parameter `id`
//     (string, required); no requestBody.
//   - src/routes/assets.ts:5645-5690 — `app.post('/:id/restore', ...)` with
//     schema `{ 200: assetSchema, 404: errorSchema, 410: errorSchema }` (:5650),
//     mounted under the `/api/v1/assets` prefix.
//   - 200 body = the full asset (assetSchema, src/routes/assets.ts:811): `status`
//     is `ready` when the pre-archive status was `ready`, else `failed`
//     (restoreTargetStatus, src/data/asset-repo.ts:1006-1014), and exactly one
//     `{ at, from: 'archived', to: <status> }` entry is appended to
//     `statusHistory` (assets.ts:855; applyRestore, asset-repo.ts:1022-1030).
//   - 410 body = { error: 'gone', message: 'asset has been purged' }
//     (src/routes/assets.ts:5662).
//   - 404 body = { error: 'not_found' } (src/routes/assets.ts:5667) for BOTH an
//     unknown id and a not-currently-archived asset
//     (docs/findings/asset-restore-contract-888.md §3, gap G1).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetDetailBody } from '../public/app.js';

const ULID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';

// statusHistory shape per the 200 schema: { at, from: status|null, to: status }.
const ARCHIVED_ASSET = {
  id: ULID,
  name: 'retired-promo.mov',
  slug: 'retired-promo',
  status: 'archived',
  statusHistory: [
    { at: '2026-09-20T10:00:00.000Z', from: null, to: 'uploading' },
    { at: '2026-09-20T10:04:00.000Z', from: 'processing', to: 'ready' },
    { at: '2026-09-25T08:30:00.000Z', from: 'ready', to: 'archived' },
  ],
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-25T08:30:00.000Z',
};

// What the endpoint returns for the asset above: pre-archive status was `ready`,
// so the target is `ready`, with one appended `archived -> ready` entry.
const RESTORED_ASSET = {
  ...ARCHIVED_ASSET,
  status: 'ready',
  statusHistory: [
    ...ARCHIVED_ASSET.statusHistory,
    { at: '2026-09-29T09:15:00.000Z', from: 'archived', to: 'ready' },
  ],
  updatedAt: '2026-09-29T09:15:00.000Z',
};

const READY_ASSET = {
  id: '01J8AAAAAAAAAAAAAAAAAAAAAA',
  name: 'live.mov',
  status: 'ready',
  statusHistory: [{ at: '2026-09-20T10:00:00.000Z', from: null, to: 'ready' }],
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
};

type RestoreOutcome = { status: number; body: unknown };

// Route the stub by URL path; unrelated endpoints return benign empty payloads so
// the renderer completes. `currentAsset()` is read lazily so a restore can flip
// what the next GET /assets/:id returns.
function routedFetch(currentAsset: () => unknown, restore?: () => RestoreOutcome) {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const path = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (/\/restore$/.test(path) && opts && opts.method === 'POST') {
      const out = restore ? restore() : { status: 200, body: RESTORED_ASSET };
      return json(out.body, out.status);
    }
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(currentAsset());
    return json({}, 200);
  });
}

// Let the async click handler (POST + full re-render, which itself awaits several
// fetches) settle.
async function settle(ticks = 25) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function historyRows(container: HTMLElement): string[] {
  const section = container.querySelector('#status-history');
  if (!section) return [];
  return Array.from(section.querySelectorAll('tbody tr')).map((tr) =>
    (tr.textContent || '').replace(/\s+/g, ' ').trim()
  );
}

describe('asset detail — restore action visibility (issue #889)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('offers a restore action for an archived asset', async () => {
    vi.stubGlobal('fetch', routedFetch(() => ARCHIVED_ASSET));

    await renderAssetDetailBody(ARCHIVED_ASSET.id, container);

    const btn = container.querySelector<HTMLButtonElement>('#btn-restore-asset');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe('Restore');
    // The control explains itself, and is programmatically associated with that
    // explanation (WCAG 2.1 AA — 1.3.1 / 3.3.2).
    expect(btn?.getAttribute('aria-describedby')).toBe('restore-note');
    const note = container.querySelector('#restore-note');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain('archived');
  });

  it('offers NO restore action for a non-archived asset', async () => {
    vi.stubGlobal('fetch', routedFetch(() => READY_ASSET));

    await renderAssetDetailBody(READY_ASSET.id, container);

    expect(container.querySelector('#btn-restore-asset')).toBeNull();
    expect(container.querySelector('#restore-note')).toBeNull();
  });

  it('renders the audited status history for any asset', async () => {
    vi.stubGlobal('fetch', routedFetch(() => ARCHIVED_ASSET));

    await renderAssetDetailBody(ARCHIVED_ASSET.id, container);

    const rows = historyRows(container);
    expect(rows).toHaveLength(ARCHIVED_ASSET.statusHistory.length);
    // Newest transition first.
    expect(rows[0]).toContain('ready');
    expect(rows[0]).toContain('archived');
    // The first-ever entry has `from: null` and is labelled, not blank.
    expect(rows[rows.length - 1]).toContain('created');
  });
});

describe('asset detail — restore success (issue #889)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('POSTs to the documented route with the ULID and no request body', async () => {
    let restored = false;
    const fetchSpy = routedFetch(
      () => (restored ? RESTORED_ASSET : ARCHIVED_ASSET),
      () => {
        restored = true;
        return { status: 200, body: RESTORED_ASSET };
      }
    );
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ARCHIVED_ASSET.id, container);
    container.querySelector<HTMLButtonElement>('#btn-restore-asset')!.click();
    await settle();

    const call = fetchSpy.mock.calls.find(([u]) => /\/restore$/.test(String(u)));
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit];
    // The restore handler does NOT resolve slugs (it passes the raw param to
    // repo.restore), so the call must carry the ULID, never the slug.
    expect(String(url)).toContain('/assets/' + ULID + '/restore');
    expect(String(url)).not.toContain(ARCHIVED_ASSET.slug);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('re-renders with the returned pre-archive status and the appended transition', async () => {
    let restored = false;
    vi.stubGlobal(
      'fetch',
      routedFetch(
        () => (restored ? RESTORED_ASSET : ARCHIVED_ASSET),
        () => {
          restored = true;
          return { status: 200, body: RESTORED_ASSET };
        }
      )
    );

    await renderAssetDetailBody(ARCHIVED_ASSET.id, container);
    expect(historyRows(container)).toHaveLength(3);

    container.querySelector<HTMLButtonElement>('#btn-restore-asset')!.click();
    await settle();

    // Status now reflects the pre-archive status the endpoint returned...
    const statusBadges = Array.from(container.querySelectorAll('.kv-grid .badge')).map(
      (b) => b.textContent
    );
    expect(statusBadges).toContain('ready');
    expect(statusBadges).not.toContain('archived');

    // ...and the new audited transition is visible in the history, appended
    // rather than rewriting the earlier `ready -> archived` entry.
    const rows = historyRows(container);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('archived');
    expect(rows[0]).toContain('ready');
    expect(rows.some((r) => /ready.*archived/.test(r))).toBe(true);

    // The asset is no longer archived, so the action retires itself.
    expect(container.querySelector('#btn-restore-asset')).toBeNull();

    // And the outcome is reported.
    expect(container.textContent).toContain('Restored');
  });
});

describe('asset detail — restore failures (issue #889)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports a 410 as unrecoverable and retires the control', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch(
        () => ARCHIVED_ASSET,
        () => ({
          status: 410,
          body: { error: 'gone', message: 'asset has been purged' },
        })
      )
    );

    await renderAssetDetailBody(ARCHIVED_ASSET.id, container);
    const btn = container.querySelector<HTMLButtonElement>('#btn-restore-asset')!;
    btn.click();
    await settle();

    const notice = container.querySelector('#restore-gone-notice');
    expect(notice).not.toBeNull();
    expect(notice?.className).toContain('msg-error');
    // Announced to assistive tech, since it appears without a page change.
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(notice?.textContent).toContain('purged');
    expect(notice?.textContent).toContain('410');

    // No retry is possible, so the button must not invite one.
    const after = container.querySelector<HTMLButtonElement>('#btn-restore-asset')!;
    expect(after.disabled).toBe(true);
    expect(after.textContent).toBe('Restore unavailable');
  });

  it('reports a 404 without guessing which of its two causes applied', async () => {
    // A concurrent writer left `archived` between this pane's read and the
    // click, so the restore 404s and the re-read shows a live asset.
    let attempted = false;
    vi.stubGlobal(
      'fetch',
      routedFetch(
        () => (attempted ? READY_ASSET : ARCHIVED_ASSET),
        () => {
          attempted = true;
          return { status: 404, body: { error: 'not_found' } };
        }
      )
    );

    await renderAssetDetailBody(ARCHIVED_ASSET.id, container);
    container.querySelector<HTMLButtonElement>('#btn-restore-asset')!.click();
    await settle();

    const text = container.textContent || '';
    expect(text).toContain('404');
    expect(text).toContain('no longer archived');
    expect(text).toContain('id is unknown');
    // The refreshed view shows the true current state.
    expect(container.querySelector('#btn-restore-asset')).toBeNull();
  });

  it('surfaces any other failure via the shared error pattern and re-enables the control', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch(
        () => ARCHIVED_ASSET,
        () => ({
          status: 403,
          body: { error: 'forbidden_insufficient_role', message: 'write not permitted' },
        })
      )
    );

    await renderAssetDetailBody(ARCHIVED_ASSET.id, container);
    const btn = container.querySelector<HTMLButtonElement>('#btn-restore-asset')!;
    btn.click();
    await settle();

    const msg = container.querySelector('#action-msg');
    expect(msg?.textContent).toContain('Restore failed');
    expect(msg?.textContent).toContain('write not permitted');
    // A retryable failure leaves the control usable.
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Restore');
  });
});
