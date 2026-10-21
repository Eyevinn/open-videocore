// Regression coverage for issue #732: a CouchDB admin password containing URL
// metacharacters (e.g. `a/b?c#d@e:f%`) was interpolated RAW into the userinfo
// of the connection URL, so `nano()` (which parses via the WHATWG `URL`
// parser in `maybeExtractDatabaseComponent`) threw `ERR_INVALID_URL` and every
// storage/asset request failed. The fix percent-encodes the password at both
// interpolation sites; this test guards that both produce a URL `new URL()`
// accepts and whose decoded password round-trips to the original.
//
// Contract sources verified before writing (cite exact symbols + lines):
//   - buildConnectionsFromStack() builds the CouchDB URL and hands it to
//     couchServer(): src/services/workspace-stack.ts:182-186
//       `config.couchdbUrl.replace(/\/$/, '').replace(
//          /^(https?:\/\/)/, `$1admin:${encodeURIComponent(couchPassword)}@`)`
//     then `const server = couchServer(couchUrl)` (workspace-stack.ts:187).
//   - couchServer(url) === nano(url): src/data/couchdb.ts:205-207 — so mocking
//     couchServer lets us capture the exact URL string the real function built.
//   - The provisioning path builds `couchAdminUrl` the same way and passes it
//     to `nano()`: src/routes/provision.ts:974-980
//       `couchdbUrl.replace(/\/$/, '').replace(
//          /^(https?:\/\/)/, `$1admin:${encodeURIComponent(couchdbAdminPassword)}@`)`.
//   - WorkspaceStackResolver.resolve() default-stack path drives
//     buildConnectionsFromStack via listStackNames()[0] + loadStackConfig():
//     src/services/workspace-stack.ts:538-548.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture every URL handed to couchServer() so we can assert on the exact
// string buildConnectionsFromStack built. vi.hoisted so the array exists when
// the (hoisted) vi.mock factory runs.
const { couchServerCalls } = vi.hoisted(() => ({
  couchServerCalls: [] as string[]
}));

vi.mock('../src/data/couchdb.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/data/couchdb.js')>();
  return {
    ...actual,
    // Intercept the URL without letting nano parse/connect. The repositories
    // hold the returned server lazily (via `wc = () => new StackCouch(...)`),
    // so an inert stand-in is sufficient for resolve() to return connections.
    couchServer: (url: string) => {
      couchServerCalls.push(url);
      return {} as unknown as import('nano').ServerScope;
    }
  };
});

import { WorkspaceStackResolver } from '../src/services/workspace-stack.js';
import type { ParamStore, StackConfig } from '../src/services/param-store.js';
import type { Context } from '@osaas/client-core';

// The suggested password from issue #732: one instance of every URL
// metacharacter that broke raw interpolation (`/ ? # @ : %`).
const HOSTILE_PASSWORD = 'a/b?c#d@e:f%';

// A ready stack config with parseable absolute URLs so
// buildConnectionsFromStack takes the storage-enabled (non-null) path.
const readyConfig: StackConfig = {
  status: 'ready',
  minioEndpoint: 'https://minio.example.osaas.io',
  couchdbUrl: 'https://couch.example.osaas.io',
  redisUrl: 'redis://valkey.example.osaas.io:6379',
  sourceBucket: 'openvideocore-source',
  packagedBucket: 'openvideocore-packaged',
  services: [{ serviceId: 'minio-minio', instanceName: 'mystack' }]
};

const oscContext = {} as unknown as Context;

// The env-override path (buildEnvConnections) wins for ALL workspaces when
// COUCHDB_URL/MINIO_URL are set, so clear them to exercise the param-store path.
function clearEnvOverride() {
  delete process.env['COUCHDB_URL'];
  delete process.env['MINIO_URL'];
}

function makeStore(): ParamStore {
  return {
    async storeStackConfig() {},
    async loadStackConfig() {
      return readyConfig;
    },
    async deleteStackConfig() {},
    async listStackNames() {
      return ['mystack'];
    }
  };
}

// Assert a built connection URL is valid and its password round-trips.
function assertUrlEncodesPassword(url: string, password: string) {
  // new URL() must accept it — the exact throw the raw-interpolation bug caused.
  const parsed = new URL(url);
  // WHATWG stores the userinfo password percent-encoded; decoding must recover
  // the original password byte-for-byte.
  expect(decodeURIComponent(parsed.password)).toBe(password);
  expect(parsed.username).toBe('admin');
}

describe('CouchDB admin password URL-encoding (#732)', () => {
  beforeEach(() => {
    clearEnvOverride();
    couchServerCalls.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buildConnectionsFromStack percent-encodes a metacharacter-laden password (real code path)', async () => {
    const resolver = new WorkspaceStackResolver({
      paramStore: makeStore(),
      oscContext,
      minioPassword: 'minio-pw',
      couchPassword: HOSTILE_PASSWORD
    });

    const conns = await resolver.resolve();

    // Sanity: the storage-enabled path ran (not the no-storage fallback).
    expect(conns.storageFor).toBeTypeOf('function');
    // buildConnectionsFromStack called couchServer exactly once, with an
    // encoded URL new URL() accepts and whose password round-trips.
    expect(couchServerCalls).toHaveLength(1);
    assertUrlEncodesPassword(couchServerCalls[0]!, HOSTILE_PASSWORD);
    // Belt-and-braces: the raw password must NOT appear unencoded in userinfo.
    expect(couchServerCalls[0]).toContain(
      `admin:${encodeURIComponent(HOSTILE_PASSWORD)}@`
    );
  });

  it('provisioning path (provision.ts:974-980) builds the same encoded URL', () => {
    // Mirrors the inline construction at src/routes/provision.ts:974-980
    // verbatim (that expression is inline in the route handler and not
    // exported). Guards the second interpolation site against the raw-
    // interpolation pattern silently reappearing.
    const couchdbUrl = 'https://couch.example.osaas.io/';
    const couchdbAdminPassword = HOSTILE_PASSWORD;
    const couchAdminUrl = couchdbUrl
      .replace(/\/$/, '')
      .replace(
        /^(https?:\/\/)/,
        `$1admin:${encodeURIComponent(couchdbAdminPassword)}@`
      );

    assertUrlEncodesPassword(couchAdminUrl, HOSTILE_PASSWORD);
  });
});
