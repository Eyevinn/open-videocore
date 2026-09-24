// @vitest-environment happy-dom
//
// Regression tests for issue #740 — the bundled ops UI must present a non-empty,
// UI-scoped `Authorization: Bearer` header on every gated request, and must
// never persist that token to web storage (AC#1, AC#2, AC#3).
//
// These exercise the REAL code path (uiAuthHeader() at public/app.js:164-166,
// minted at public/app.js:153-160) through exported renderers — no hand-rolled
// fake that bypasses uiAuthHeader():
//   - AC#1: renderAssetFiles() -> apiFetch() -> fetch(GET /assets/:id/files).
//     apiFetch is the shared helper at public/app.js:172-186 that spreads
//     `...uiAuthHeader()` onto every gated call.
//   - AC#2: renderAssetsTab() drives the Upload modal whose raw streaming PUT at
//     public/app.js:1292-1304 bypasses apiFetch but spreads the SAME
//     `...uiAuthHeader()` (public/app.js:1302).
//   - AC#3: the minted token is held only in the module realm; after a gated
//     call neither localStorage nor sessionStorage contains it.
//
// Gate contract (why a non-empty bearer suffices, and why persisting it is
// unnecessary): requireAuth is a pure presence gate — src/auth/workspace.ts:22-32
// admits ANY non-empty bearer and throws AuthError('missing access token') when
// absent; asset-upload attaches the same gate at src/routes/asset-upload.ts:131.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetFiles, renderAssetsTab } from '../public/app.js';

const BEARER_RE = /^Bearer\s+(\S.*)$/;

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Pull the token out of an `Authorization: Bearer <token>` header, asserting the
// header exists and carries a non-empty value.
function bearerTokenOf(headers: Record<string, string> | undefined): string {
  expect(headers, 'the request must carry a headers object').toBeTruthy();
  const auth = (headers as Record<string, string>)['Authorization'];
  expect(auth, 'Authorization header must be present').toBeTypeOf('string');
  const m = BEARER_RE.exec(auth);
  expect(m, `Authorization must be "Bearer <non-empty>", got: ${auth}`).not.toBeNull();
  return (m as RegExpExecArray)[1];
}

function clearStorage() {
  try { localStorage.clear(); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }
}

describe('UI auth header (issue #740)', () => {
  beforeEach(() => {
    clearStorage();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    clearStorage();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('AC#1 — a gated apiFetch call sends Authorization: Bearer with a non-empty token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ files: [], fileGroups: [] });
      })
    );

    const container = document.createElement('div');
    document.body.appendChild(container);

    // renderAssetFiles() reaches the network only through the real apiFetch().
    await renderAssetFiles('asset-1', container);

    expect(calls.length).toBeGreaterThan(0);
    const token = bearerTokenOf(calls[0].init.headers as Record<string, string>);
    expect(token.length).toBeGreaterThan(0);
  });

  it('AC#3 — the minted token is never written to localStorage or sessionStorage', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ files: [], fileGroups: [] });
      })
    );

    const container = document.createElement('div');
    document.body.appendChild(container);

    await renderAssetFiles('asset-1', container);

    const token = bearerTokenOf(calls[0].init.headers as Record<string, string>);

    // The exact minted token must not appear in either web store...
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i) as string;
        const value = store.getItem(key) ?? '';
        expect(value).not.toContain(token);
        // ...nor should any UI-scoped bearer material be persisted at all.
        expect(value).not.toContain('Bearer ');
        expect(value.startsWith('ui-')).toBe(false);
      }
    }
  });

  it('AC#2 — the raw upload PUT (public/app.js:1298) sends the same UI-scoped bearer', async () => {
    let uploadCall: { url: string; init: RequestInit } | null = null;
    let firstGatedGetAuth: string | null = null;

    const fetchMock = vi.fn(async (url: unknown, init: RequestInit = {}) => {
      const u = String(url);
      const method = (init.method || 'GET').toUpperCase();

      // The raw streaming PUT that bypasses apiFetch (public/app.js:1292-1304).
      if (u.includes('/upload') && method === 'PUT') {
        uploadCall = { url: u, init };
        return jsonResponse({ ok: true });
      }
      // The modal creates the asset first via apiFetch POST /assets.
      if (u.includes('/assets') && method === 'POST') {
        return jsonResponse({ id: 'asset-123', name: 'clip.mp4', status: 'created' });
      }
      // The initial assets-table load (and post-upload reload): gated GET /assets.
      if (u.includes('/assets') && method === 'GET') {
        const headers = init.headers as Record<string, string> | undefined;
        if (firstGatedGetAuth === null && headers && headers['Authorization']) {
          firstGatedGetAuth = headers['Authorization'];
        }
        return jsonResponse({ items: [], total: 0 });
      }
      return jsonResponse({ items: [], total: 0 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const container = document.createElement('div');
    document.body.appendChild(container);

    // Drive the real Assets tab (kicks off the initial gated GET /assets).
    await renderAssetsTab(container);

    // Open the Upload modal.
    container.querySelector<HTMLButtonElement>('#btn-open-upload')!.click();

    // Populate the file input with a real File, exactly as a user would.
    const fileInput = document.querySelector<HTMLInputElement>('#upload-file')!;
    const file = new File(['fake-video-bytes'], 'clip.mp4', { type: 'video/mp4' });
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;

    // Click Upload — runs POST /assets then the raw streaming PUT.
    document.querySelector<HTMLButtonElement>('#upload-btn')!.click();

    await vi.waitFor(() => expect(uploadCall).not.toBeNull());

    const call = uploadCall as unknown as { url: string; init: RequestInit };
    expect((call.init.method || '').toUpperCase()).toBe('PUT');
    expect(call.url).toContain('/assets/asset-123/upload');

    const uploadToken = bearerTokenOf(call.init.headers as Record<string, string>);
    expect(uploadToken.length).toBeGreaterThan(0);

    // The raw PUT must present the SAME UI-scoped bearer as the gated apiFetch
    // GET — both spread the single module-realm token via uiAuthHeader().
    expect(firstGatedGetAuth).toBe('Bearer ' + uploadToken);

    // AC#3 also holds through the upload flow: the token stays out of storage.
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i) as string;
        expect(store.getItem(key) ?? '').not.toContain(uploadToken);
      }
    }
  });
});
