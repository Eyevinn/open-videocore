// @vitest-environment happy-dom
//
// Tests for the "wedged asset" ops-UI affordance (issue #282): assets stuck in
// `processing` with a non-empty `technicalMetadataError` are flagged, filterable,
// and offer a re-drive action that hits the recovery endpoint.
//
// We test the two pure helpers directly (isAssetWedged / filterWedgedAssets) and
// the asset-detail renderer (renderAssetDetailBody) — the exact code path the
// asset side panel and the standalone detail window both invoke — so asserting
// its output proves the flag/error/re-drive behaviour without rendering the full
// tab chrome.
//
// Verified contracts:
//   - ASSET_STATUSES ('processing' member)         src/data/asset-repo.ts:28
//   - assetSchema.technicalMetadataError           src/routes/assets.ts:439 (z.string().optional())
//   - GET  /api/v1/assets/:id                       src/routes/assets.ts (GET '/:id')
//   - POST /api/v1/assets/:id/extract-metadata      src/routes/assets.ts:1859-1906
//        wedged asset -> runs sync, 200 { assetId, status } (issue #281)
//   - public/app.js: isAssetWedged, filterWedgedAssets, renderAssetDetailBody

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isAssetWedged,
  filterWedgedAssets,
  renderAssetDetailBody,
} from '../public/app.js';

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('isAssetWedged', () => {
  it('is true only for processing + non-empty technicalMetadataError', () => {
    expect(isAssetWedged({ status: 'processing', technicalMetadataError: 'ffprobe: boom' })).toBe(true);
  });

  it('is false when status is not processing (even with an error)', () => {
    // A `failed`/`ready` asset with a stored error is not "wedged" — only a
    // processing asset is stuck mid-lifecycle.
    expect(isAssetWedged({ status: 'ready', technicalMetadataError: 'old error' })).toBe(false);
    expect(isAssetWedged({ status: 'failed', technicalMetadataError: 'boom' })).toBe(false);
  });

  it('is false when there is no error string', () => {
    expect(isAssetWedged({ status: 'processing' })).toBe(false);
    expect(isAssetWedged({ status: 'processing', technicalMetadataError: '' })).toBe(false);
    expect(isAssetWedged({ status: 'processing', technicalMetadataError: undefined })).toBe(false);
  });

  it('is false for nullish input', () => {
    expect(isAssetWedged(null)).toBe(false);
    expect(isAssetWedged(undefined)).toBe(false);
  });
});

describe('filterWedgedAssets', () => {
  it('keeps only wedged assets and drops the rest', () => {
    const assets = [
      { id: 'a', status: 'ready' },
      { id: 'b', status: 'processing', technicalMetadataError: 'boom' },
      { id: 'c', status: 'processing' }, // processing but healthy (no error)
      { id: 'd', status: 'processing', technicalMetadataError: 'kaboom' },
      { id: 'e', status: 'failed', technicalMetadataError: 'x' },
    ];
    expect(filterWedgedAssets(assets).map((a) => a.id)).toEqual(['b', 'd']);
  });

  it('returns [] for non-array input', () => {
    expect(filterWedgedAssets(null as unknown as unknown[])).toEqual([]);
    expect(filterWedgedAssets(undefined as unknown as unknown[])).toEqual([]);
  });
});

// ─── Detail renderer: flag + error + re-drive ────────────────────────────────

// renderAssetDetailBody fetches several endpoints. We route the stub by URL path
// and let unrelated ones return benign empty payloads so the renderer completes.
function routedFetch(assetById: Record<string, unknown>, onExtract?: () => unknown) {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const path = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    // POST .../extract-metadata (the re-drive recovery call).
    if (/\/extract-metadata$/.test(path) && opts && opts.method === 'POST') {
      return json(onExtract ? onExtract() : { assetId: 'x', status: 'ready' });
    }
    // GET .../delivery, .../executions, /profiles — benign shapes.
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    // GET /assets/:id — return the current asset (keyed by trailing id segment).
    const m = path.match(/\/assets\/([^/?]+)(?:\?|$)/);
    if (m && assetById[decodeURIComponent(m[1])]) {
      return json(assetById[decodeURIComponent(m[1])]);
    }
    return json({}, 200);
  });
}

const WEDGED_ASSET = {
  id: 'asset-wedged',
  name: 'stuck.mov',
  status: 'processing',
  technicalMetadata: null,
  technicalMetadataError: 'ffprobe exited with code 1: moov atom not found',
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

describe('renderAssetDetailBody — wedged asset', () => {
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

  it('flags the asset with a "Needs attention" badge and surfaces the error text', async () => {
    vi.stubGlobal('fetch', routedFetch({ [WEDGED_ASSET.id]: WEDGED_ASSET }));

    await renderAssetDetailBody(WEDGED_ASSET.id, container);

    const flag = container.querySelector('.badge-attention');
    expect(flag).not.toBeNull();
    expect(flag?.textContent).toContain('Needs attention');
    // The error message is reachable to the operator (tooltip + detail row).
    expect(container.textContent).toContain('moov atom not found');
    expect(flag?.getAttribute('title')).toContain('moov atom not found');
  });

  it('offers a "Re-drive extraction" action for a wedged asset', async () => {
    vi.stubGlobal('fetch', routedFetch({ [WEDGED_ASSET.id]: WEDGED_ASSET }));

    await renderAssetDetailBody(WEDGED_ASSET.id, container);

    const btn = container.querySelector<HTMLButtonElement>('#btn-extract-meta');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain('Re-drive');
  });

  it('re-drive calls the recovery endpoint and reflects the resulting status change', async () => {
    // After the re-drive the asset has recovered to `ready`; the re-render must
    // pick up the new state (no more "Needs attention" flag) and report status.
    let recovered = false;
    const store: Record<string, unknown> = {
      get [WEDGED_ASSET.id]() {
        return recovered
          ? { ...WEDGED_ASSET, status: 'ready', technicalMetadataError: undefined }
          : WEDGED_ASSET;
      },
    };
    const fetchSpy = routedFetch(store, () => {
      recovered = true;
      return { assetId: WEDGED_ASSET.id, status: 'ready' };
    });
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(WEDGED_ASSET.id, container);

    const btn = container.querySelector<HTMLButtonElement>('#btn-extract-meta');
    expect(btn?.textContent).toContain('Re-drive');
    btn!.click();
    // Let the async click handler (fetch + re-render) settle.
    await new Promise((r) => setTimeout(r, 0));

    // The recovery endpoint was hit with POST.
    const posted = fetchSpy.mock.calls.some(
      ([u, o]) => /\/extract-metadata$/.test(String(u)) && (o as RequestInit)?.method === 'POST'
    );
    expect(posted).toBe(true);

    // The re-rendered detail reflects the recovered status and no longer flags it.
    expect(container.querySelector('.badge-attention')).toBeNull();
    expect(container.textContent).toContain('ready');
  });
});

describe('renderAssetDetailBody — healthy asset', () => {
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

  it('does not flag a ready asset and keeps the plain "Extract Metadata" label', async () => {
    const ready = {
      id: 'asset-ready',
      name: 'ok.mov',
      status: 'ready',
      technicalMetadata: null,
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
    };
    vi.stubGlobal('fetch', routedFetch({ [ready.id]: ready }));

    await renderAssetDetailBody(ready.id, container);

    expect(container.querySelector('.badge-attention')).toBeNull();
    const btn = container.querySelector<HTMLButtonElement>('#btn-extract-meta');
    expect(btn?.textContent).toBe('Extract Metadata');
  });
});
