// @vitest-environment happy-dom
//
// DOM/unit + integration tests for the three registration fields the ops UI
// add-backend form never offered: `role`, `publicBaseUrl`, `sessionToken`
// (issue #870). Additive to test/storage-backend-form.test.ts (issue #681),
// which covers the required core six.
//
// Verified contract (per CLAUDE.md rule 7), read from the current main:
//   - POST /api/v1/storage/backends body = `registerBackendSchema`,
//     src/routes/storage.ts:129-141 — nine properties; required are exactly
//     name/bucket/accessKeyId/secretAccessKey (mirrored in openapi.json at
//     "/api/v1/storage/backends".post.requestBody.content['application/json']
//     .schema.required). The three under test:
//       role          storage.ts:133  z.enum(['source','packaged','both','archive']).default('both')
//       sessionToken  storage.ts:139  z.string().min(1).optional()  — SECRET
//       publicBaseUrl storage.ts:140  z.string().url().optional()
//   - PATCH /api/v1/storage/backends/{id} = `updateBackendSchema`,
//     src/routes/storage.ts:179-189 — the same three, all optional.
//   - GET view = `backendViewSchema`, src/routes/storage.ts:150-168 — returns
//     `role` (:153), `publicBaseUrl` (:160) and `hasSessionToken` (:161), and
//     models a stored session token as `credentials.sessionToken` === the
//     literal '***redacted***' marker (:166, same marker as the secret key).
//   - `publicBaseUrl` is what makes packaged output publicly playable:
//     GET /assets/{id}/delivery resolves the packaged-role backend's origin via
//     `externalPublicBaseUrl(stackStorage?.packaged)` (src/routes/assets.ts:4751).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  renderStorageBackendForm,
  validateStorageBackendForm,
  applyStorageBackendFormErrors,
  STORAGE_SECRET_PLACEHOLDER,
  STORAGE_BACKEND_ROLE_OPTIONS,
  STORAGE_BACKEND_DEFAULT_ROLE,
  renderStorageTab,
} from '../public/app.js';

// The four documented role values, in registerBackendSchema order.
const ROLE_VALUES = ['source', 'packaged', 'both', 'archive'];

// A fully-populated required-six form, as the #681 tests use it.
const CORE = {
  name: 'Cold archive',
  endpointUrl: 'https://s3.example.com',
  bucket: 'cold',
  region: 'us-east-1',
  accessKeyId: 'AKIA1',
  secretAccessKey: 'shhh',
};

// ─── Render: the three controls exist, labelled, optional ────────────────────

describe('renderStorageBackendForm — optional field group (issue #870)', () => {
  it('renders a role select, a publicBaseUrl field and a sessionToken field', () => {
    const form = renderStorageBackendForm('add', null);
    const keys = Array.from(form.querySelectorAll('.storage-backend-optional-input')).map(
      (el) => (el as HTMLElement).dataset.field
    );
    expect(keys).toEqual(['role', 'publicBaseUrl', 'sessionToken']);
  });

  it('offers exactly the four documented role values, defaulting to both', () => {
    const form = renderStorageBackendForm('add', null);
    const select = form.querySelector('[data-field="role"]') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(ROLE_VALUES);
    expect(select.value).toBe('both');
    expect(STORAGE_BACKEND_DEFAULT_ROLE).toBe('both');
    expect(STORAGE_BACKEND_ROLE_OPTIONS.map((o) => o.value)).toEqual(ROLE_VALUES);
  });

  it('uses a url input for publicBaseUrl and a password input for sessionToken', () => {
    const form = renderStorageBackendForm('add', null);
    const pub = form.querySelector('[data-field="publicBaseUrl"]') as HTMLInputElement;
    const tok = form.querySelector('[data-field="sessionToken"]') as HTMLInputElement;
    expect(pub.type).toBe('url');
    expect(tok.type).toBe('password');
    expect(tok.autocomplete).toBe('new-password');
  });

  it('marks none of the three required, and leaves the core six untouched', () => {
    const form = renderStorageBackendForm('add', null);
    ['role', 'publicBaseUrl', 'sessionToken'].forEach((key) => {
      const el = form.querySelector('[data-field="' + key + '"]') as HTMLInputElement;
      expect(el.required).toBe(false);
    });
    // The required-six selector still names exactly the six (#681 contract).
    const core = Array.from(form.querySelectorAll('.storage-backend-input')).map(
      (i) => (i as HTMLInputElement).dataset.field
    );
    expect(core).toEqual([
      'name',
      'endpointUrl',
      'bucket',
      'region',
      'accessKeyId',
      'secretAccessKey',
    ]);
  });

  it('labels every control and wires its help text through aria-describedby', () => {
    const form = renderStorageBackendForm('add', null);
    ['role', 'publicBaseUrl', 'sessionToken'].forEach((key) => {
      const el = form.querySelector('[data-field="' + key + '"]') as HTMLElement;
      const label = form.querySelector('label[for="' + el.id + '"]');
      expect(label?.textContent?.length).toBeGreaterThan(0);
      const hintId = el.getAttribute('aria-describedby')!;
      const hint = form.querySelector('#' + hintId);
      expect(hint?.textContent?.length).toBeGreaterThan(0);
    });
  });

  it('explains in the publicBaseUrl help text what the origin does for playback', () => {
    const form = renderStorageBackendForm('add', null);
    const el = form.querySelector('[data-field="publicBaseUrl"]') as HTMLInputElement;
    const hint = form.querySelector('#' + el.getAttribute('aria-describedby'))!;
    expect(hint.textContent!.toLowerCase()).toContain('packaged');
    expect(hint.textContent!.toLowerCase()).toContain('playable');
  });

  it('groups the three in a fieldset with a legend', () => {
    const form = renderStorageBackendForm('add', null);
    const group = form.querySelector('fieldset.storage-backend-optional-group')!;
    expect(group).toBeTruthy();
    expect(group.querySelector('legend')?.textContent).toBe('Optional');
    expect(group.querySelectorAll('[data-field]').length).toBe(3);
  });
});

// ─── Render: edit mode pre-population and secret handling ────────────────────

describe('renderStorageBackendForm — optional fields on edit (issue #870)', () => {
  const VIEW = {
    id: 'be_77',
    name: 'CDN-fronted packaged',
    role: 'packaged',
    backend: 'external',
    bucket: 'packaged-out',
    accessKeyId: 'AKIAPKG',
    endpointUrl: 'https://s3.example.com',
    region: 'eu-north-1',
    publicBaseUrl: 'https://cdn.example.com/media',
    hasSessionToken: true,
    deletable: true,
    createdAt: '2026-04-01T00:00:00.000Z',
    credentials: {
      accessKeyId: 'AKIAPKG',
      secretAccessKey: '***redacted***',
      sessionToken: '***redacted***',
    },
  };

  it('pre-selects the stored role and pre-fills publicBaseUrl', () => {
    const form = renderStorageBackendForm('edit', VIEW);
    expect((form.querySelector('[data-field="role"]') as HTMLSelectElement).value).toBe('packaged');
    expect((form.querySelector('[data-field="publicBaseUrl"]') as HTMLInputElement).value).toBe(
      'https://cdn.example.com/media'
    );
  });

  it('NEVER seeds the session-token field, and never renders the redaction marker', () => {
    const form = renderStorageBackendForm('edit', VIEW);
    const tok = form.querySelector('[data-field="sessionToken"]') as HTMLInputElement;
    expect(tok.value).toBe('');
    expect(tok.placeholder).toBe(STORAGE_SECRET_PLACEHOLDER);
    expect(form.textContent).not.toContain('***redacted***');
    // Both secret fields are password inputs.
    expect(tok.type).toBe('password');
    expect((form.querySelector('[data-field="secretAccessKey"]') as HTMLInputElement).type).toBe(
      'password'
    );
  });

  it('falls back to the schema default role when the view carries an unknown role', () => {
    const form = renderStorageBackendForm('edit', { ...VIEW, role: 'nonsense' });
    expect((form.querySelector('[data-field="role"]') as HTMLSelectElement).value).toBe('both');
  });
});

// ─── Validation: optional means optional ─────────────────────────────────────

describe('validateStorageBackendForm — optional trio (issue #870)', () => {
  it('omitting all three produces exactly today registration body', () => {
    const r = validateStorageBackendForm('add', CORE);
    expect(r.valid).toBe(true);
    expect(r.body).toEqual(CORE);
    expect('role' in r.body).toBe(false);
    expect('publicBaseUrl' in r.body).toBe(false);
    expect('sessionToken' in r.body).toBe(false);
  });

  it('sends a non-default role when one is chosen', () => {
    for (const role of ROLE_VALUES) {
      const r = validateStorageBackendForm('add', { ...CORE, role });
      expect(r.valid).toBe(true);
      expect(r.body.role).toBe(role);
    }
  });

  it('rejects a role outside the documented enum with an actionable message', () => {
    const r = validateStorageBackendForm('add', { ...CORE, role: 'cold' });
    expect(r.valid).toBe(false);
    expect(r.errors.role).toContain('source');
    expect(r.errors.role).toContain('archive');
  });

  it('sends publicBaseUrl when supplied', () => {
    const r = validateStorageBackendForm('add', {
      ...CORE,
      publicBaseUrl: 'https://cdn.example.com/media',
    });
    expect(r.valid).toBe(true);
    expect(r.body.publicBaseUrl).toBe('https://cdn.example.com/media');
  });

  it('rejects a non-http(s) publicBaseUrl (API is z.string().url())', () => {
    const r = validateStorageBackendForm('add', { ...CORE, publicBaseUrl: 'cdn.example.com' });
    expect(r.valid).toBe(false);
    expect(r.errors.publicBaseUrl).toBe('Public base URL must start with http:// or https://');
  });

  it('rejects a malformed http publicBaseUrl', () => {
    const r = validateStorageBackendForm('add', { ...CORE, publicBaseUrl: 'https://' });
    expect(r.valid).toBe(false);
    expect(r.errors.publicBaseUrl).toBeTruthy();
  });

  it('sends sessionToken when supplied and never when blank', () => {
    const withTok = validateStorageBackendForm('add', { ...CORE, sessionToken: 'FwoGZXIvYXdz' });
    expect(withTok.valid).toBe(true);
    expect(withTok.body.sessionToken).toBe('FwoGZXIvYXdz');

    const blank = validateStorageBackendForm('add', { ...CORE, sessionToken: '   ' });
    expect(blank.valid).toBe(true);
    expect('sessionToken' in blank.body).toBe(false);
  });

  it('never requires any of the three (error set is still the core six)', () => {
    const r = validateStorageBackendForm('add', {});
    expect(r.valid).toBe(false);
    expect(Object.keys(r.errors).sort()).toEqual(
      ['accessKeyId', 'bucket', 'endpointUrl', 'name', 'region', 'secretAccessKey'].sort()
    );
  });

  it('carries the three onto a PATCH body too, only when supplied', () => {
    const base = { ...CORE, secretAccessKey: '' };
    const bare = validateStorageBackendForm('edit', base);
    expect(bare.valid).toBe(true);
    expect('role' in bare.body).toBe(false);
    expect('sessionToken' in bare.body).toBe(false);

    const full = validateStorageBackendForm('edit', {
      ...base,
      role: 'archive',
      publicBaseUrl: 'https://cdn.example.com',
      sessionToken: 'tok',
    });
    expect(full.valid).toBe(true);
    expect(full.body.role).toBe('archive');
    expect(full.body.publicBaseUrl).toBe('https://cdn.example.com');
    expect(full.body.sessionToken).toBe('tok');
    // Still no secret rotation — a blank secret must not be sent.
    expect('secretAccessKey' in full.body).toBe(false);
  });

  it('surfaces an optional-field error in that field slot', () => {
    const form = renderStorageBackendForm('add', null);
    const first = applyStorageBackendFormErrors(form, {
      publicBaseUrl: 'Public base URL must start with http:// or https://',
    });
    expect(first).toBe('publicBaseUrl');
    const slot = form.querySelector('.form-error[data-error-for="publicBaseUrl"]');
    expect(slot?.textContent).toBe('Public base URL must start with http:// or https://');
  });
});

// ─── Integration: register through the real tab, with all three set ──────────

function makeStubbedApi() {
  const backends: Record<string, any> = {};
  let seq = 0;
  const calls: { method: string; path: string; body: any }[] = [];

  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api\/v1/, '');
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (path === '/storage/buckets' && method === 'GET') return json([]);
    if (path === '/storage/backends' && method === 'GET') {
      return json({ backends: Object.values(backends) });
    }
    if (path === '/storage/backends' && method === 'POST') {
      const id = 'be_' + ++seq;
      // Server behaviour per registerBackendSchema + backendViewSchema: `role`
      // defaults to 'both' when omitted, and neither secret is ever echoed.
      backends[id] = {
        id,
        name: body.name,
        role: body.role ?? 'both',
        backend: 'external',
        bucket: body.bucket,
        accessKeyId: body.accessKeyId,
        endpointUrl: body.endpointUrl,
        region: body.region,
        publicBaseUrl: body.publicBaseUrl,
        hasSessionToken: body.sessionToken != null,
        deletable: true,
        createdAt: '2026-05-01T00:00:00.000Z',
        credentials: {
          accessKeyId: body.accessKeyId,
          secretAccessKey: '***redacted***',
          ...(body.sessionToken != null ? { sessionToken: '***redacted***' } : {}),
        },
      };
      return json(backends[id], 201);
    }
    return json({ error: 'not_found', message: path }, 404);
  });

  return { fetchStub, calls, backends };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('renderStorageTab — registering with role/publicBaseUrl/sessionToken (issue #870)', () => {
  let stub: ReturnType<typeof makeStubbedApi>;

  beforeEach(() => {
    stub = makeStubbedApi();
    vi.stubGlobal('fetch', stub.fetchStub);
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function openAddForm() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderStorageTab(container);
    await flush();
    (container.querySelector('#storage-add-backend-btn') as HTMLButtonElement).click();
    const form = container.querySelector('.storage-backend-form') as HTMLFormElement;
    const set = (field: string, val: string) => {
      (form.querySelector('[data-field="' + field + '"]') as HTMLInputElement).value = val;
    };
    set('name', 'Archive tier');
    set('endpointUrl', 'https://s3.example.com');
    set('bucket', 'cold');
    set('region', 'us-east-1');
    set('accessKeyId', 'AKIANEW');
    set('secretAccessKey', 'sekret');
    return { container, form, set };
  }

  it('registers a backend with a role other than both', async () => {
    const { form, set } = await openAddForm();
    set('role', 'archive');
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    const post = stub.calls.find((c) => c.method === 'POST' && c.path === '/storage/backends');
    expect(post!.body.role).toBe('archive');
    expect(Object.values(stub.backends)[0].role).toBe('archive');
  });

  it('registers a backend with a publicBaseUrl', async () => {
    const { form, set } = await openAddForm();
    set('role', 'packaged');
    set('publicBaseUrl', 'https://cdn.example.com/media');
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    const post = stub.calls.find((c) => c.method === 'POST' && c.path === '/storage/backends');
    expect(post!.body.publicBaseUrl).toBe('https://cdn.example.com/media');
    // The registered packaged-role backend now carries the public origin that
    // /delivery reads (externalPublicBaseUrl, src/routes/assets.ts:4751).
    const registered = Object.values(stub.backends)[0] as any;
    expect(registered.role).toBe('packaged');
    expect(registered.publicBaseUrl).toBe('https://cdn.example.com/media');
  });

  it('registers a backend with a session token, and never caches either secret', async () => {
    const { container, form, set } = await openAddForm();
    set('sessionToken', 'FwoGZXIvYXdz');
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    const post = stub.calls.find((c) => c.method === 'POST' && c.path === '/storage/backends');
    expect(post!.body.sessionToken).toBe('FwoGZXIvYXdz');
    expect((Object.values(stub.backends)[0] as any).hasSessionToken).toBe(true);
    // Neither secret is persisted client-side, and neither (nor the redaction
    // marker) is rendered back into the page.
    const dump = JSON.stringify(window.localStorage) + JSON.stringify(window.sessionStorage);
    expect(dump).not.toContain('FwoGZXIvYXdz');
    expect(dump).not.toContain('sekret');
    expect(container.textContent).not.toContain('FwoGZXIvYXdz');
    expect(container.textContent).not.toContain('***redacted***');
  });

  it('omitting all three posts exactly the six fields it posts today', async () => {
    const { form } = await openAddForm();
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    const post = stub.calls.find((c) => c.method === 'POST' && c.path === '/storage/backends');
    // The role select has a value ('both') the operator never touched; it is the
    // same registration the server produces from the schema default.
    expect(post!.body).toEqual({
      name: 'Archive tier',
      endpointUrl: 'https://s3.example.com',
      bucket: 'cold',
      region: 'us-east-1',
      accessKeyId: 'AKIANEW',
      secretAccessKey: 'sekret',
      role: 'both',
    });
    expect((Object.values(stub.backends)[0] as any).role).toBe('both');
    expect((Object.values(stub.backends)[0] as any).hasSessionToken).toBe(false);
  });

  it('blocks submit with an inline error when publicBaseUrl is not a URL', async () => {
    const { form, set } = await openAddForm();
    set('publicBaseUrl', 'cdn.example.com');
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    expect(stub.calls.find((c) => c.method === 'POST')).toBeUndefined();
    const slot = form.querySelector('.form-error[data-error-for="publicBaseUrl"]');
    expect(slot?.textContent).toContain('http://');
  });
});
