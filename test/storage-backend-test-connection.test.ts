// @vitest-environment happy-dom
//
// DOM/unit + integration tests for the ops UI per-row test-connection action in
// the storage-backend list (issue #683). Builds on the list view (issue #680),
// the add/edit form (issue #681) and the remove flow (issue #682): each row now
// carries a "Test connection" control that probes the backend and reflects the
// outcome inline on the row (spinner -> Connected / Unreachable + message).
//
// Verified contract (per CLAUDE.md rule 7), against branch
// issue-679/storage-backend-api-endpoints:
//   - Endpoint: POST /api/v1/storage/backends/{id}/test-connection
//       Handler: src/routes/storage.ts:478-501 (app.post '/backends/:id/test-connection').
//       Request body (testConnectionBodySchema, src/routes/storage.ts:206-209):
//         { secretAccessKey: string(min 1), sessionToken?: string(min 1) } —
//         secretAccessKey is REQUIRED; the secret was never persisted
//         (ADR-017 D1) so the caller re-supplies it to probe with.
//       Response (testConnectionResultSchema, src/routes/storage.ts:210-213;
//         openapi.json "/api/v1/storage/backends/{id}/test-connection"
//         .post.responses.200.content."application/json".schema):
//         { status: 'connected' | 'unreachable', message: string }.
//   - The OSC-managed default (id 'default' == DEFAULT_BACKEND_ID,
//       src/services/storage-backend-registry.ts:57) is answered `connected`
//       BEFORE any probe (registry.testConnection, storage-backend-registry.ts
//       :815-826), so its secret value is irrelevant — the UI sends a non-empty
//       placeholder to satisfy the required-field schema.
//   - Server hard 10s ceiling: TEST_CONNECTION_TIMEOUT_MS
//       (storage-backend-registry.ts:558). The UI additionally aborts client-side
//       at 10s (issue #683 acceptance) and surfaces a timeout inline.
//   - Roles viewer|editor|admin (src/auth/principal.ts:31); management is
//       editor/admin — the whole Storage tab is gated on canManageStorage
//       (issue #680 ROLE_GATED_TABS), so the control's visibility matches the
//       surrounding management controls without a second gate.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  testStorageBackendConnection,
  setStorageBackendRowProbing,
  applyStorageBackendRowTestResult,
  renderStorageBackendsList,
  renderStorageTab,
  STORAGE_TEST_CONNECTION_TIMEOUT_MS,
  STORAGE_TEST_DEFAULT_SECRET,
} from '../public/app.js';

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

const DEFAULT_BACKEND = {
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
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: status === 204 ? {} : { 'content-type': 'application/json' },
  });
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

// ─── testStorageBackendConnection (shared probe helper) ─────────────────────────

describe('testStorageBackendConnection (issue #683 shared probe helper)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('POSTs the required secretAccessKey to the contract path and returns { status, message }', async () => {
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.method || 'GET').toUpperCase()).toBe('POST');
      expect(String(url)).toContain('/storage/backends/be_01/test-connection');
      // The secret is re-supplied in the body (required, min 1).
      expect(JSON.parse(String(init?.body))).toEqual({ secretAccessKey: 'sekret' });
      return jsonResponse({ status: 'connected', message: 'the storage backend is reachable' });
    });
    vi.stubGlobal('fetch', fetchStub);

    const result = await testStorageBackendConnection('be_01', 'sekret');
    expect(result).toEqual({ status: 'connected', message: 'the storage backend is reachable' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('surfaces a client-side timeout when the call exceeds 10s', async () => {
    vi.useFakeTimers();
    // A fetch that never resolves within the bound.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    const promise = testStorageBackendConnection('be_01', 'sekret');
    const assertion = expect(promise).rejects.toMatchObject({ isTimeout: true });
    await vi.advanceTimersByTimeAsync(STORAGE_TEST_CONNECTION_TIMEOUT_MS + 1);
    await assertion;
  });
});

// ─── Pure row renderers (spinner / result) ──────────────────────────────────────

describe('storage-backend row test renderers (issue #683)', () => {
  function oneRow(backend: unknown) {
    const listEl = renderStorageBackendsList([backend]);
    return listEl.querySelector('.storage-backend-row') as HTMLElement;
  }

  it('setStorageBackendRowProbing swaps the badge for a spinner', () => {
    const row = oneRow(EXTERNAL_BACKEND);
    setStorageBackendRowProbing(row);
    const probing = row.querySelector('.storage-backend-status.is-probing') as HTMLElement;
    expect(probing).toBeTruthy();
    expect(probing.querySelector('.spinner')).toBeTruthy();
    expect(probing.textContent).toContain('Testing');
  });

  it('applyStorageBackendRowTestResult (pass) sets the badge to Connected, no error', () => {
    const row = oneRow(EXTERNAL_BACKEND);
    setStorageBackendRowProbing(row);
    applyStorageBackendRowTestResult(row, { status: 'connected', message: 'reachable' });
    const badge = row.querySelector('.storage-backend-status') as HTMLElement;
    expect(badge.textContent).toBe('Connected');
    expect(badge.classList.contains('badge-ready')).toBe(true);
    expect(row.querySelector('.storage-backend-test-error')).toBeNull();
    expect(row.querySelector('.is-probing')).toBeNull();
  });

  it('applyStorageBackendRowTestResult (fail) sets Unreachable and shows the message', () => {
    const row = oneRow(EXTERNAL_BACKEND);
    setStorageBackendRowProbing(row);
    applyStorageBackendRowTestResult(row, {
      status: 'unreachable',
      message: 'endpoint refused the connection',
    });
    const badge = row.querySelector('.storage-backend-status') as HTMLElement;
    expect(badge.textContent).toBe('Unreachable');
    expect(badge.classList.contains('badge-failed')).toBe(true);
    const err = row.querySelector('.storage-backend-test-error') as HTMLElement;
    expect(err.textContent).toBe('endpoint refused the connection');
  });
});

// ─── Integration: renderStorageTab per-row test-connection ───────────────────────
// Drives the real Storage tab so the row Test-connection control -> prompt ->
// POST -> badge update path is exercised end to end (acceptance criteria).

function makeStubbedApi(testResult: { status: string; message: string } | 'error') {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api\/v1/, '');
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    if (path === '/storage/buckets' && method === 'GET') return jsonResponse([]);
    if (path === '/storage/backends' && method === 'GET') {
      return jsonResponse({ backends: [DEFAULT_BACKEND, { ...EXTERNAL_BACKEND }] });
    }
    if (/\/storage\/backends\/[^/]+\/test-connection$/.test(path) && method === 'POST') {
      if (testResult === 'error') return jsonResponse({ error: 'boom', message: 'probe crashed' }, 500);
      return jsonResponse(testResult);
    }
    return jsonResponse({ error: 'not_found', message: path }, 404);
  });
  return { fetchStub, calls };
}

describe('renderStorageTab per-row test-connection flow (issue #683)', () => {
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

  it('every row (default + external) exposes a Test connection control', async () => {
    const stub = makeStubbedApi({ status: 'connected', message: 'ok' });
    vi.stubGlobal('fetch', stub.fetchStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderStorageTab(container);
    await flush();

    for (const id of ['default', 'be_01']) {
      const row = container.querySelector(`[data-backend-id="${id}"]`) as HTMLElement;
      expect(row.querySelector('.storage-backend-test-conn')).toBeTruthy();
    }
  });

  it('list -> test-connection (mocked pass) -> badge updated to Connected', async () => {
    const stub = makeStubbedApi({ status: 'connected', message: 'the storage backend is reachable' });
    vi.stubGlobal('fetch', stub.fetchStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderStorageTab(container);
    await flush();

    const row = container.querySelector('[data-backend-id="be_01"]') as HTMLElement;
    (row.querySelector('.storage-backend-test-conn') as HTMLButtonElement).click();
    await flush();

    // External backend prompts for the secret (never persisted).
    const dialog = document.querySelector('.storage-test-dialog') as HTMLElement;
    expect(dialog).toBeTruthy();
    (dialog.querySelector('.storage-test-secret') as HTMLInputElement).value = 'sekret';
    (dialog.querySelector('.storage-test-run') as HTMLButtonElement).click();
    await flush();

    const posts = stub.calls.filter((c) => c.method === 'POST');
    expect(posts.length).toBe(1);
    expect(posts[0].path).toBe('/storage/backends/be_01/test-connection');
    expect(posts[0].body).toEqual({ secretAccessKey: 'sekret' });

    const badge = row.querySelector('.storage-backend-status') as HTMLElement;
    expect(badge.textContent).toBe('Connected');
    expect(badge.classList.contains('badge-ready')).toBe(true);
    expect(row.querySelector('.storage-backend-test-error')).toBeNull();
  });

  it('list -> test-connection (mocked fail) -> badge Unreachable, error shown', async () => {
    const stub = makeStubbedApi({ status: 'unreachable', message: 'bucket not found' });
    vi.stubGlobal('fetch', stub.fetchStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderStorageTab(container);
    await flush();

    const row = container.querySelector('[data-backend-id="be_01"]') as HTMLElement;
    (row.querySelector('.storage-backend-test-conn') as HTMLButtonElement).click();
    await flush();
    const dialog = document.querySelector('.storage-test-dialog') as HTMLElement;
    (dialog.querySelector('.storage-test-secret') as HTMLInputElement).value = 'sekret';
    (dialog.querySelector('.storage-test-run') as HTMLButtonElement).click();
    await flush();

    const badge = row.querySelector('.storage-backend-status') as HTMLElement;
    expect(badge.textContent).toBe('Unreachable');
    expect(badge.classList.contains('badge-failed')).toBe(true);
    const err = row.querySelector('.storage-backend-test-error') as HTMLElement;
    expect(err.textContent).toBe('bucket not found');
  });

  it('the default row probes with a placeholder secret and needs no prompt', async () => {
    const stub = makeStubbedApi({ status: 'connected', message: 'platform-provisioned default backend' });
    vi.stubGlobal('fetch', stub.fetchStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderStorageTab(container);
    await flush();

    const row = container.querySelector('[data-backend-id="default"]') as HTMLElement;
    (row.querySelector('.storage-backend-test-conn') as HTMLButtonElement).click();
    await flush();

    // No secret prompt for the default.
    expect(document.querySelector('.storage-test-dialog')).toBeNull();
    const posts = stub.calls.filter((c) => c.method === 'POST');
    expect(posts.length).toBe(1);
    expect(posts[0].path).toBe('/storage/backends/default/test-connection');
    expect(posts[0].body).toEqual({ secretAccessKey: STORAGE_TEST_DEFAULT_SECRET });

    const badge = row.querySelector('.storage-backend-status') as HTMLElement;
    expect(badge.textContent).toBe('Connected');
  });

  it('a probe HTTP error renders Unreachable + the error message inline', async () => {
    const stub = makeStubbedApi('error');
    vi.stubGlobal('fetch', stub.fetchStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderStorageTab(container);
    await flush();

    const row = container.querySelector('[data-backend-id="be_01"]') as HTMLElement;
    (row.querySelector('.storage-backend-test-conn') as HTMLButtonElement).click();
    await flush();
    const dialog = document.querySelector('.storage-test-dialog') as HTMLElement;
    (dialog.querySelector('.storage-test-secret') as HTMLInputElement).value = 'sekret';
    (dialog.querySelector('.storage-test-run') as HTMLButtonElement).click();
    await flush();

    const badge = row.querySelector('.storage-backend-status') as HTMLElement;
    expect(badge.textContent).toBe('Unreachable');
    const err = row.querySelector('.storage-backend-test-error') as HTMLElement;
    expect(err.textContent).toContain('probe crashed');
  });
});

// ─── Session-token backends: the probe must carry the token (issue #870) ────────
//
// A backend registered with temporary credentials only authenticates with its
// session token, so a probe sent without one can never succeed for it.
//
// Verified contract (CLAUDE.md rule 7), re-read on branch
// issue-870/add-backend-role-publicbaseurl-sessiontoken:
//   - Request body `testConnectionBodySchema` (src/routes/storage.ts:207-210):
//       { secretAccessKey: z.string().min(1),
//         sessionToken: z.string().min(1).optional() }.
//   - The route forwards it only when truthy (src/routes/storage.ts:501-508:
//       `...(request.body.sessionToken ? { sessionToken: ... } : {})`).
//   - `storageBackendRegistry.testConnection` builds the probe target from the
//       CALLER-supplied value alone (src/services/storage-backend-registry.ts
//       :830-837: `...(secret.sessionToken ? { sessionToken: secret.sessionToken } : {})`)
//       — the stored token is never read back out for the probe, and the
//       redacted view only reports its presence as `hasSessionToken`
//       (storage.ts:160) with `credentials.sessionToken` as the redacted marker
//       (storage-backend-registry.ts:164).

const SESSION_TOKEN_BACKEND = {
  ...EXTERNAL_BACKEND,
  id: 'be_tmp',
  name: 'Temporary credentials bucket',
  hasSessionToken: true,
  credentials: {
    accessKeyId: 'AKIAOTHER',
    secretAccessKey: '***redacted***',
    sessionToken: '***redacted***',
  },
};

function makeSessionTokenApi(testResult: { status: string; message: string }) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api\/v1/, '');
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (path === '/storage/buckets' && method === 'GET') return jsonResponse([]);
    if (path === '/storage/backends' && method === 'GET') {
      return jsonResponse({
        backends: [{ ...SESSION_TOKEN_BACKEND }, { ...EXTERNAL_BACKEND }],
      });
    }
    if (/\/storage\/backends\/[^/]+\/test-connection$/.test(path) && method === 'POST') {
      return jsonResponse(testResult);
    }
    return jsonResponse({ error: 'not_found', message: path }, 404);
  });
  return { fetchStub, calls };
}

describe('test-connection carries sessionToken (issue #870)', () => {
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

  it('the probe helper puts a supplied sessionToken in the body', async () => {
    const fetchStub = vi.fn(async () => jsonResponse({ status: 'connected', message: 'ok' }));
    vi.stubGlobal('fetch', fetchStub);
    await testStorageBackendConnection('be_tmp', 'sekret', { sessionToken: 'FwoGZXIvYXdz' });
    const body = JSON.parse(String((fetchStub.mock.calls[0] as any[])[1].body));
    expect(body).toEqual({ secretAccessKey: 'sekret', sessionToken: 'FwoGZXIvYXdz' });
  });

  it('the probe helper omits the key when the token is blank', async () => {
    const fetchStub = vi.fn(async () => jsonResponse({ status: 'connected', message: 'ok' }));
    vi.stubGlobal('fetch', fetchStub);
    await testStorageBackendConnection('be_tmp', 'sekret', { sessionToken: '' });
    const body = JSON.parse(String((fetchStub.mock.calls[0] as any[])[1].body));
    expect(body).toEqual({ secretAccessKey: 'sekret' });
    expect('sessionToken' in body).toBe(false);
  });

  it('a row with a stored session token is offered an optional token field', async () => {
    const stub = makeSessionTokenApi({ status: 'connected', message: 'ok' });
    vi.stubGlobal('fetch', stub.fetchStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderStorageTab(container);
    await flush();

    const row = container.querySelector('[data-backend-id="be_tmp"]') as HTMLElement;
    (row.querySelector('.storage-backend-test-conn') as HTMLButtonElement).click();
    await flush();

    const dialog = document.querySelector('.storage-test-dialog') as HTMLElement;
    const tokenInput = dialog.querySelector('.storage-test-session-token') as HTMLInputElement;
    expect(tokenInput).toBeTruthy();
    expect(tokenInput.type).toBe('password');
    // WCAG 2.1 AA: the field is labelled and its hint is programmatically
    // associated, like every other secret input in this UI.
    expect((tokenInput.parentElement as HTMLElement).tagName).toBe('LABEL');
    expect((tokenInput.parentElement as HTMLElement).textContent).toContain('Session token');
    const hintId = tokenInput.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    expect(dialog.querySelector('#' + hintId)).toBeTruthy();
  });

  it('the per-row probe body carries the typed sessionToken', async () => {
    const stub = makeSessionTokenApi({ status: 'connected', message: 'reachable' });
    vi.stubGlobal('fetch', stub.fetchStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderStorageTab(container);
    await flush();

    const row = container.querySelector('[data-backend-id="be_tmp"]') as HTMLElement;
    (row.querySelector('.storage-backend-test-conn') as HTMLButtonElement).click();
    await flush();
    const dialog = document.querySelector('.storage-test-dialog') as HTMLElement;
    (dialog.querySelector('.storage-test-secret') as HTMLInputElement).value = 'sekret';
    (dialog.querySelector('.storage-test-session-token') as HTMLInputElement).value = 'FwoGZXIvYXdz';
    (dialog.querySelector('.storage-test-run') as HTMLButtonElement).click();
    await flush();

    const post = stub.calls.find((c) => c.method === 'POST');
    expect(post!.path).toBe('/storage/backends/be_tmp/test-connection');
    expect(post!.body).toEqual({ secretAccessKey: 'sekret', sessionToken: 'FwoGZXIvYXdz' });

    const badge = row.querySelector('.storage-backend-status') as HTMLElement;
    expect(badge.textContent).toBe('Connected');
  });

  it('a row without a stored token gets no token field and an unchanged body', async () => {
    const stub = makeSessionTokenApi({ status: 'connected', message: 'reachable' });
    vi.stubGlobal('fetch', stub.fetchStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderStorageTab(container);
    await flush();

    const row = container.querySelector('[data-backend-id="be_01"]') as HTMLElement;
    (row.querySelector('.storage-backend-test-conn') as HTMLButtonElement).click();
    await flush();
    const dialog = document.querySelector('.storage-test-dialog') as HTMLElement;
    expect(dialog.querySelector('.storage-test-session-token')).toBeNull();
    (dialog.querySelector('.storage-test-secret') as HTMLInputElement).value = 'sekret';
    (dialog.querySelector('.storage-test-run') as HTMLButtonElement).click();
    await flush();

    const post = stub.calls.find((c) => c.method === 'POST');
    expect(post!.body).toEqual({ secretAccessKey: 'sekret' });
  });

  it('the edit form Test connection forwards the sessionToken typed into the form', async () => {
    const stub = makeSessionTokenApi({ status: 'connected', message: 'reachable' });
    vi.stubGlobal('fetch', stub.fetchStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderStorageTab(container);
    await flush();

    const row = container.querySelector('[data-backend-id="be_tmp"]') as HTMLElement;
    (row.querySelector('.storage-backend-edit') as HTMLButtonElement).click();
    await flush();

    const form = container.querySelector('.storage-backend-form') as HTMLFormElement;
    (form.querySelector('[data-field="secretAccessKey"]') as HTMLInputElement).value = 'sekret';
    (form.querySelector('[data-field="sessionToken"]') as HTMLInputElement).value = 'FwoGZXIvYXdz';
    (form.querySelector('.storage-backend-test') as HTMLButtonElement).click();
    await flush();

    const post = stub.calls.find((c) => c.method === 'POST');
    expect(post!.path).toBe('/storage/backends/be_tmp/test-connection');
    expect(post!.body).toEqual({ secretAccessKey: 'sekret', sessionToken: 'FwoGZXIvYXdz' });
  });

  it('the edit form omits sessionToken when the field is left blank', async () => {
    const stub = makeSessionTokenApi({ status: 'connected', message: 'reachable' });
    vi.stubGlobal('fetch', stub.fetchStub);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderStorageTab(container);
    await flush();

    const row = container.querySelector('[data-backend-id="be_tmp"]') as HTMLElement;
    (row.querySelector('.storage-backend-edit') as HTMLButtonElement).click();
    await flush();

    const form = container.querySelector('.storage-backend-form') as HTMLFormElement;
    (form.querySelector('[data-field="secretAccessKey"]') as HTMLInputElement).value = 'sekret';
    (form.querySelector('.storage-backend-test') as HTMLButtonElement).click();
    await flush();

    const post = stub.calls.find((c) => c.method === 'POST');
    expect(post!.body).toEqual({ secretAccessKey: 'sekret' });
  });
});
