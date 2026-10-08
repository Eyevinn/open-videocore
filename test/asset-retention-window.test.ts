// @vitest-environment happy-dom
//
// Remaining retention window on the archived asset detail view (issue #891,
// broken out from #787). Depends on the contract verification in #888.
//
// Contract grounding (CLAUDE.md rule 7) — read directly from this tree, not
// assumed:
//   - `assetSchema` (src/routes/assets.ts:1096 `retention:
//     retentionSchema.optional()`, serialised with
//     `additionalProperties: false`) is the schema BOTH `GET /api/v1/assets/{id}`
//     and the `200` of `POST /api/v1/assets/{id}/restore` use. On THIS branch it
//     carries an OPTIONAL `retention: { archivedAt, purgeAfter, retentionMs }`
//     object (`retentionSchema`, src/routes/assets.ts:990-1017), attached by
//     `withRetention()` (src/routes/assets.ts:2012) and present in the
//     committed spec (openapi.json, `GET /api/v1/assets/{id}` 200 →
//     `retention`).
//   - The shape is the additive one recommended by
//     docs/findings/asset-restore-contract-888.md §4 ("Preferred"). That
//     finding recorded the field as NOT exposed when it was written, against
//     the pre-#891 contract; this branch is what adds it.
//   - `purgeAfter` is `null` exactly when `retentionMs === 0`
//     (RETENTION_DISABLED_MS, src/routes/retention.ts:36) — retention disabled,
//     never purge.
//
// The field is OPTIONAL, so these tests pin both directions: no countdown is
// fabricated for a body that carries no `retention` (non-archived asset, the
// list endpoint, or a deployment that wires no live retention window), AND the
// remaining window is rendered near the restore action when the object is
// present.
//
// Target: `formatRetentionRemaining` (pure formatter) and
// `renderAssetDetailBody` (the real detail renderer), both imported from
// '../public/app.js' exactly as test/asset-detail-restore.test.ts does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRetentionRemaining, renderAssetDetailBody } from '../public/app.js';

const ULID = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';

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

function routedFetch(currentAsset: () => unknown) {
  return vi.fn(async (url: string) => {
    const path = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(currentAsset());
    return json({}, 200);
  });
}

describe('formatRetentionRemaining — pure formatter (issue #891)', () => {
  it('returns null when no retention object is present (the field is optional on the wire)', () => {
    expect(formatRetentionRemaining(undefined)).toBeNull();
    expect(formatRetentionRemaining(null)).toBeNull();
  });

  it('returns null for a malformed retention object rather than guessing', () => {
    expect(formatRetentionRemaining({})).toBeNull();
    expect(formatRetentionRemaining({ purgeAfter: 123 })).toBeNull();
    expect(formatRetentionRemaining({ purgeAfter: 'not-a-date' })).toBeNull();
  });

  it('reports "no retention limit" when purgeAfter is explicitly null (retentionMs === 0)', () => {
    const text = formatRetentionRemaining({ purgeAfter: null, retentionMs: 0 });
    expect(text).toContain('No retention limit');
  });

  it('reports the remaining window when purgeAfter is in the future', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    const text = formatRetentionRemaining({
      archivedAt: '2026-09-25T08:30:00.000Z',
      purgeAfter: '2026-10-25T08:30:00.000Z',
      retentionMs: 2592000000,
    });
    expect(text).toContain('24 days');
    expect(text).toContain('remain');
    vi.useRealTimers();
  });

  it('reports the window has elapsed when purgeAfter is in the past, without claiming the asset is already gone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'));
    const text = formatRetentionRemaining({
      purgeAfter: '2026-10-25T08:30:00.000Z',
      retentionMs: 2592000000,
    });
    expect(text).toContain('elapsed');
    expect(text).not.toContain('remain');
    vi.useRealTimers();
  });
});

describe('asset detail — retention window near the restore action (issue #891)', () => {
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
    vi.useRealTimers();
  });

  it('omits the retention window when the body carries no retention object — no fabricated countdown', async () => {
    vi.stubGlobal('fetch', routedFetch(() => ARCHIVED_ASSET));

    await renderAssetDetailBody(ARCHIVED_ASSET.id, container);

    // The restore action is still offered...
    expect(container.querySelector('#btn-restore-asset')).not.toBeNull();
    // ...but no retention-window element is rendered, because this fixture
    // body carries no `retention` field — the case of an older server, or a
    // deployment that wires no live retention window, where `withRetention()`
    // omits the object (src/routes/assets.ts:2012).
    expect(container.querySelector('#retention-window')).toBeNull();
    expect(container.textContent).not.toMatch(/remain before/);
  });

  it('renders the remaining window near the restore action once the server sends asset.retention', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    const assetWithRetention = {
      ...ARCHIVED_ASSET,
      retention: {
        archivedAt: '2026-09-25T08:30:00.000Z',
        purgeAfter: '2026-10-25T08:30:00.000Z',
        retentionMs: 2592000000,
      },
    };
    vi.stubGlobal('fetch', routedFetch(() => assetWithRetention));

    await renderAssetDetailBody(ARCHIVED_ASSET.id, container);

    const restoreBtn = container.querySelector('#btn-restore-asset');
    const note = container.querySelector('#restore-note');
    const retentionEl = container.querySelector('#retention-window');
    expect(restoreBtn).not.toBeNull();
    expect(note).not.toBeNull();
    expect(retentionEl).not.toBeNull();
    expect(retentionEl?.textContent).toContain('24 days');

    // "Near the restore action": the retention note sits alongside the
    // restore note, inside the same detail body, immediately after it in
    // document order.
    expect(note?.compareDocumentPosition(retentionEl as Node) &
      Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers no retention-window text at all for a non-archived asset', async () => {
    const readyAsset = {
      ...ARCHIVED_ASSET,
      status: 'ready',
      retention: { archivedAt: null, purgeAfter: '2026-10-25T08:30:00.000Z', retentionMs: 2592000000 },
    };
    vi.stubGlobal('fetch', routedFetch(() => readyAsset));

    await renderAssetDetailBody(ARCHIVED_ASSET.id, container);

    expect(container.querySelector('#btn-restore-asset')).toBeNull();
    expect(container.querySelector('#retention-window')).toBeNull();
  });
});
