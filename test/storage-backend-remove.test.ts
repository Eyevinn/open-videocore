// @vitest-environment happy-dom
//
// DOM/unit + integration tests for the ops UI "remove storage backend" flow
// with a confirmation dialog and in-use guard (issue #682). Builds on the list
// view (issue #680) and add/edit form (issue #681) — the Remove control per row
// becomes a guarded confirmation flow, not a raw confirm().
//
// Verified contract (per CLAUDE.md rule 7):
//   - Endpoint: DELETE /api/v1/storage/backends/{id}
//       openapi.json "/api/v1/storage/backends/{id}".delete — responses
//       204 (removed), 409 (conflict/in-use), 501.
//       Local handler: src/routes/storage.ts:282-... (app.delete '/backends/:id').
//   - Authoritative 409 in-use body (branch
//       issue-679/storage-backend-api-endpoints, src/routes/storage.ts:216-224
//       inUseErrorSchema + :274-283 handler):
//         { error: 'backend_in_use', message: string,
//           references: { assetIds: string[], activeJobIds: string[] } }
//       The human-readable `message` is surfaced verbatim; we never invent the
//       field name.
//   - The default backend (deletable:false) carries NO remove control — its
//       control is disabled by the pure render (issue #680), so the tab never
//       wires a dialog to it.
//   - Roles viewer|editor|admin (src/auth/principal.ts:31); management is
//       editor/admin — reuse canManageStorage (issue #680).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openStorageBackendRemoveDialog,
  describeBackendInUse,
  renderStorageTab,
} from '../public/app.js';

// A redacted external (deletable) backend view as GET /storage/backends returns.
const EXTERNAL_BACKEND = {
  id: 'be_01',
  name: 'Archive bucket',
  role: 'archive',
  backend: 'external',
  bucket: 'cold-archive',
  accessKeyId: 'AKIAOTHER',
  endpointUrl: 'https://s3.example.com',
  region: 'us-east-1',
  hasSessionToken: false,
  deletable: true,
  createdAt: '2026-02-01T00:00:00.000Z',
  credentials: { accessKeyId: 'AKIAOTHER', secretAccessKey: '***redacted***' },
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: status === 204 ? {} : { 'content-type': 'application/json' },
  });
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// ─── describeBackendInUse (409 formatter) ──────────────────────────────────────

describe('describeBackendInUse (issue #682 in-use message)', () => {
  it('prefers the server-supplied human message verbatim', () => {
    const err: any = new Error('backend_in_use');
    err.status = 409;
    err.body = {
      error: 'backend_in_use',
      message: 'This backend is still referenced by 3 assets or active jobs and cannot be removed.',
      references: { assetIds: ['a1', 'a2', 'a3'], activeJobIds: [] },
    };
    expect(describeBackendInUse(err)).toBe(err.body.message);
  });

  it('synthesises a count-based message from references when message is absent', () => {
    const err: any = new Error('backend_in_use');
    err.status = 409;
    err.body = {
      error: 'backend_in_use',
      references: { assetIds: ['a1', 'a2'], activeJobIds: ['j1'] },
    };
    expect(describeBackendInUse(err)).toContain('3');
    expect(describeBackendInUse(err)).toContain('cannot be removed');
  });
});

// ─── openStorageBackendRemoveDialog ────────────────────────────────────────────

describe('openStorageBackendRemoveDialog (issue #682)', () => {
  beforeEach(() => {
    localStorage.setItem('ovc_role', 'admin');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
    localStorage.removeItem('ovc_role');
  });

  it('opens a dialog naming the backend and makes NO DELETE before confirmation', async () => {
    const fetchStub = vi.fn(async () => jsonResponse(null, 204));
    vi.stubGlobal('fetch', fetchStub);

    openStorageBackendRemoveDialog(EXTERNAL_BACKEND, {});
    const dialog = document.querySelector('.storage-remove-dialog') as HTMLElement;
    expect(dialog).toBeTruthy();
    // The dialog names the backend.
    expect(dialog.textContent).toContain('Archive bucket');
    // No network call was made just by opening the dialog.
    expect(fetchStub).not.toHaveBeenCalled();

    // Cancelling closes the dialog and still makes no DELETE.
    (dialog.querySelector('.storage-remove-cancel') as HTMLButtonElement).click();
    await flush();
    expect(document.querySelector('.storage-remove-dialog')).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('add -> remove (confirmed) -> entry gone: DELETE on confirm, onRemoved fires, dialog closes', async () => {
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.method || 'GET').toUpperCase()).toBe('DELETE');
      expect(String(url)).toContain('/storage/backends/be_01');
      return jsonResponse(null, 204);
    });
    vi.stubGlobal('fetch', fetchStub);

    const onRemoved = vi.fn();
    openStorageBackendRemoveDialog(EXTERNAL_BACKEND, { onRemoved });

    const dialog = document.querySelector('.storage-remove-dialog') as HTMLElement;
    (dialog.querySelector('.storage-remove-confirm') as HTMLButtonElement).click();
    await flush();

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledTimes(1);
    // Dialog closes on success.
    expect(document.querySelector('.storage-remove-dialog')).toBeNull();
  });

  it('409 in-use -> human-readable error shown, dialog stays open, onRemoved NOT called', async () => {
    const inUseBody = {
      error: 'backend_in_use',
      message: 'This backend is still referenced by 2 assets or active jobs and cannot be removed.',
      references: { assetIds: ['a1', 'a2'], activeJobIds: [] },
    };
    const fetchStub = vi.fn(async () => jsonResponse(inUseBody, 409));
    vi.stubGlobal('fetch', fetchStub);

    const onRemoved = vi.fn();
    openStorageBackendRemoveDialog(EXTERNAL_BACKEND, { onRemoved });

    const dialog = document.querySelector('.storage-remove-dialog') as HTMLElement;
    (dialog.querySelector('.storage-remove-confirm') as HTMLButtonElement).click();
    await flush();

    // Dialog remains open.
    const stillOpen = document.querySelector('.storage-remove-dialog') as HTMLElement;
    expect(stillOpen).toBeTruthy();
    // The human-readable message is surfaced (not the raw machine code).
    const errEl = stillOpen.querySelector('.storage-remove-error') as HTMLElement;
    expect(errEl.textContent).toBe(inUseBody.message);
    expect(errEl.style.display).not.toBe('none');
    // No removal happened.
    expect(onRemoved).not.toHaveBeenCalled();
    // The confirm button is re-enabled so the operator can retry after fixing.
    expect((stillOpen.querySelector('.storage-remove-confirm') as HTMLButtonElement).disabled).toBe(false);
  });
});

// ─── Integration: renderStorageTab remove flow ─────────────────────────────────
// Drives the real Storage tab so the row-level Remove control -> dialog -> DELETE
// -> row disappears path is exercised end to end (acceptance criteria).

function makeStubbedApi(inUse: boolean) {
  const backends: Record<string, any> = {
    default: {
      id: 'default',
      name: 'Platform default',
      role: 'both',
      backend: 'external',
      bucket: 'ovc-source',
      accessKeyId: 'AKIADEF',
      endpointUrl: 'https://minio.internal',
      region: 'eu-north-1',
      hasSessionToken: false,
      deletable: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      credentials: { accessKeyId: 'AKIADEF', secretAccessKey: '***redacted***' },
    },
    be_01: { ...EXTERNAL_BACKEND },
  };
  const calls: { method: string; path: string }[] = [];

  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api\/v1/, '');
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ method, path });

    if (path === '/storage/buckets' && method === 'GET') return jsonResponse([]);
    if (path === '/storage/backends' && method === 'GET') {
      return jsonResponse({ backends: Object.values(backends) });
    }
    const m = path.match(/^\/storage\/backends\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const id = decodeURIComponent(m[1]);
      if (inUse) {
        return jsonResponse(
          {
            error: 'backend_in_use',
            message: 'This backend is still referenced by 1 asset or active job and cannot be removed.',
            references: { assetIds: ['a1'], activeJobIds: [] },
          },
          409
        );
      }
      delete backends[id];
      return jsonResponse(null, 204);
    }
    return jsonResponse({ error: 'not_found', message: path }, 404);
  });

  return { fetchStub, calls, backends };
}

describe('renderStorageTab remove flow (issue #682)', () => {
  beforeEach(() => {
    localStorage.setItem('ovc_role', 'admin');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
    localStorage.removeItem('ovc_role');
    document.body.innerHTML = '';
  });

  it('the platform default row exposes NO usable remove control', async () => {
    const stub = makeStubbedApi(false);
    vi.stubGlobal('fetch', stub.fetchStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderStorageTab(container);
    await flush();

    const defaultRow = container.querySelector('[data-backend-id="default"]') as HTMLElement;
    const del = defaultRow.querySelector('.storage-backend-delete') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    // Clicking the disabled default control opens no dialog.
    del.click();
    await flush();
    expect(document.querySelector('.storage-remove-dialog')).toBeNull();
  });

  it('remove (confirmed) removes the entry from the rendered list without a reload', async () => {
    const stub = makeStubbedApi(false);
    vi.stubGlobal('fetch', stub.fetchStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderStorageTab(container);
    await flush();

    // The external backend is present.
    expect(container.querySelector('[data-backend-id="be_01"]')).toBeTruthy();

    // Click its Remove control -> dialog opens.
    const row = container.querySelector('[data-backend-id="be_01"]') as HTMLElement;
    (row.querySelector('.storage-backend-delete') as HTMLButtonElement).click();
    const dialog = document.querySelector('.storage-remove-dialog') as HTMLElement;
    expect(dialog).toBeTruthy();

    // Confirm.
    (dialog.querySelector('.storage-remove-confirm') as HTMLButtonElement).click();
    await flush();

    // DELETE was issued exactly once, and only after confirmation.
    const deletes = stub.calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(1);
    expect(deletes[0].path).toBe('/storage/backends/be_01');

    // The entry is gone from the rendered list, with NO extra GET reload.
    expect(container.querySelector('[data-backend-id="be_01"]')).toBeNull();
    const listGets = stub.calls.filter(
      (c) => c.method === 'GET' && c.path === '/storage/backends'
    );
    expect(listGets.length).toBe(1);
  });

  it('remove -> 409 keeps the row and surfaces the human-readable error', async () => {
    const stub = makeStubbedApi(true);
    vi.stubGlobal('fetch', stub.fetchStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderStorageTab(container);
    await flush();

    const row = container.querySelector('[data-backend-id="be_01"]') as HTMLElement;
    (row.querySelector('.storage-backend-delete') as HTMLButtonElement).click();
    const dialog = document.querySelector('.storage-remove-dialog') as HTMLElement;
    (dialog.querySelector('.storage-remove-confirm') as HTMLButtonElement).click();
    await flush();

    // Dialog stays open with the message; the row is still present.
    const stillOpen = document.querySelector('.storage-remove-dialog') as HTMLElement;
    expect(stillOpen).toBeTruthy();
    expect((stillOpen.querySelector('.storage-remove-error') as HTMLElement).textContent).toContain(
      'cannot be removed'
    );
    expect(container.querySelector('[data-backend-id="be_01"]')).toBeTruthy();
  });
});
