// @vitest-environment happy-dom
//
// DOM/unit tests for the ops UI storage-backend list view (issue #680).
//
// The repo has no snapshot/visual-regression harness for the vanilla-JS ops UI,
// so per the acceptance criterion we cover the pure render function + role gate
// with a DOM/unit test. These exercise public/app.js's exported helpers with no
// network call — renderStorageBackendsList takes an already-fetched array.
//
// Verified contract (per CLAUDE.md rule 7):
//   - Endpoint + redacted view shape: GET /api/v1/storage/backends
//     src/routes/storage.ts:144-166 (backendViewSchema) & :261-274 (route);
//     mirrored in openapi.json "/api/v1/storage/backends".get.responses.200.
//     Fields rendered: name, endpointUrl, bucket, region, deletable.
//   - `deletable:false` marks the OSC-managed default (ADR-017 D3,
//     src/routes/storage.ts:140-142) — distinguished + delete disabled.
//   - Secret is always '***redacted***' (credentials.secretAccessKey,
//     src/routes/storage.ts:159) — never rendered.
//   - Roles are viewer|editor|admin (src/auth/principal.ts:31); absent ⇒ admin
//     (src/auth/principal.ts:98-104). Storage management is editor/admin
//     (matches the write row of src/auth/authorize.ts:54-58).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  renderStorageBackendsList,
  storageBackendStatus,
  isDefaultStorageBackend,
  getClientRole,
  setClientRole,
  canManageStorage,
} from '../public/app.js';

// A redacted default-backend view as GET /storage/backends returns it.
const DEFAULT_BACKEND = {
  id: 'default',
  name: 'Platform default',
  role: 'both',
  backend: 'external',
  bucket: 'ovc-source',
  accessKeyId: 'AKIAEXAMPLE',
  endpointUrl: 'https://minio.example.internal',
  region: 'eu-north-1',
  hasSessionToken: false,
  deletable: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: '***redacted***' },
};

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

describe('storageBackendStatus (issue #680 badge derivation)', () => {
  it('defaults to Unknown when no explicit status is stored', () => {
    expect(storageBackendStatus(DEFAULT_BACKEND)).toEqual({
      label: 'Unknown',
      cls: 'badge-unknown',
    });
    expect(storageBackendStatus({})).toEqual({ label: 'Unknown', cls: 'badge-unknown' });
  });

  it('maps a stored connectionStatus to the matching badge', () => {
    expect(storageBackendStatus({ connectionStatus: 'connected' })).toEqual({
      label: 'Connected',
      cls: 'badge-ready',
    });
    expect(storageBackendStatus({ connectionStatus: 'unreachable' })).toEqual({
      label: 'Unreachable',
      cls: 'badge-failed',
    });
  });

  it('treats an unrecognised status value as Unknown', () => {
    expect(storageBackendStatus({ connectionStatus: 'weird' }).label).toBe('Unknown');
  });
});

describe('isDefaultStorageBackend', () => {
  it('is true when the backend is not deletable', () => {
    expect(isDefaultStorageBackend(DEFAULT_BACKEND)).toBe(true);
  });
  it('is false for a deletable external backend', () => {
    expect(isDefaultStorageBackend(EXTERNAL_BACKEND)).toBe(false);
  });
});

describe('renderStorageBackendsList (issue #680 list view)', () => {
  it('renders correctly with the default backend only', () => {
    const el = renderStorageBackendsList([DEFAULT_BACKEND]);
    const rows = el.querySelectorAll('.storage-backend-row');
    expect(rows.length).toBe(1);

    const row = rows[0];
    // Name, endpoint, bucket, region are all present.
    expect(row.textContent).toContain('Platform default');
    expect(row.textContent).toContain('https://minio.example.internal');
    expect(row.textContent).toContain('ovc-source');
    expect(row.textContent).toContain('eu-north-1');

    // Default is visually distinguished + its delete control is disabled.
    expect(row.classList.contains('is-default')).toBe(true);
    expect(row.querySelector('.storage-default-tag')?.textContent).toBe('Default');
    const del = row.querySelector('.storage-backend-delete') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
  });

  it('renders multiple backends and distinguishes only the default', () => {
    const el = renderStorageBackendsList([DEFAULT_BACKEND, EXTERNAL_BACKEND]);
    const rows = el.querySelectorAll('.storage-backend-row');
    expect(rows.length).toBe(2);

    const external = el.querySelector('[data-backend-id="be_01"]') as HTMLElement;
    expect(external.classList.contains('is-default')).toBe(false);
    expect(external.querySelector('.storage-default-tag')).toBeNull();
    const del = external.querySelector('.storage-backend-delete') as HTMLButtonElement;
    expect(del.disabled).toBe(false);
  });

  it('shows Unknown badges on first load (no explicit status stored)', () => {
    const el = renderStorageBackendsList([DEFAULT_BACKEND, EXTERNAL_BACKEND]);
    const badges = el.querySelectorAll('.storage-backend-status');
    expect(badges.length).toBe(2);
    badges.forEach((b) => {
      expect(b.textContent).toBe('Unknown');
      expect(b.classList.contains('badge-unknown')).toBe(true);
    });
  });

  it('reflects the connection status returned by the API', () => {
    const el = renderStorageBackendsList([
      { ...DEFAULT_BACKEND, connectionStatus: 'connected' },
      { ...EXTERNAL_BACKEND, connectionStatus: 'unreachable' },
    ]);
    const badges = el.querySelectorAll('.storage-backend-status');
    expect(badges[0].textContent).toBe('Connected');
    expect(badges[0].classList.contains('badge-ready')).toBe(true);
    expect(badges[1].textContent).toBe('Unreachable');
    expect(badges[1].classList.contains('badge-failed')).toBe(true);
  });

  it('never renders a raw secret', () => {
    const el = renderStorageBackendsList([DEFAULT_BACKEND, EXTERNAL_BACKEND]);
    // The redaction marker is the ONLY secret-shaped string, and even it must
    // not surface in the list view (we render no credentials column).
    expect(el.textContent).not.toContain('***redacted***');
    expect(el.textContent).not.toContain('AKIA');
  });

  it('escapes hostile field values (no HTML injection)', () => {
    const el = renderStorageBackendsList([
      { ...EXTERNAL_BACKEND, name: '<img src=x onerror=alert(1)>' },
    ]);
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('shows an empty state for an empty backend array', () => {
    const el = renderStorageBackendsList([]);
    expect(el.querySelector('.storage-backends-table')).toBeNull();
    expect(el.querySelector('.empty')?.textContent).toBe('No storage backends available.');
  });
});

describe('storage nav role gate (issue #680)', () => {
  const KEY = 'ovc_role';
  beforeEach(() => localStorage.removeItem(KEY));
  afterEach(() => localStorage.removeItem(KEY));

  it('defaults to admin when no role is stored (single-operator default)', () => {
    expect(getClientRole()).toBe('admin');
    expect(canManageStorage()).toBe(true);
  });

  it('grants storage management to editor and admin only', () => {
    setClientRole('editor');
    expect(canManageStorage()).toBe(true);
    setClientRole('admin');
    expect(canManageStorage()).toBe(true);
  });

  it('denies storage management to viewer', () => {
    setClientRole('viewer');
    expect(getClientRole()).toBe('viewer');
    expect(canManageStorage()).toBe(false);
  });

  it('falls back to admin for an unrecognised stored role', () => {
    localStorage.setItem(KEY, 'operator'); // not a real role in this codebase
    expect(getClientRole()).toBe('admin');
    expect(canManageStorage()).toBe(true);
  });
});
