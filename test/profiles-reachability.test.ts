// Boot-time profiles-index reachability self-check tests (issue #284).
//
// The check fetches this app's OWN derived Encore profiles index URL exactly as
// Encore would — an unauthenticated GET — and must log a HARD ERROR when the OSC
// login wall rejects it (401/403) or it is otherwise unreachable, while staying
// quiet (info-only) on a 200. Uses an injected fetch so there is no real network
// I/O; unrelated to the workspace-scoping suite failures.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  checkProfilesIndexReachable,
  nodeSelfProbeFetch,
  type FetchLike,
  type ReachabilityLogger
} from '../src/services/profiles-reachability.js';

const LOCAL_URL = 'https://app.example.test/api/v1/profiles/index.yml';

function makeLogger(): ReachabilityLogger & {
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  return { error: vi.fn(), info: vi.fn() };
}

describe('profiles-index reachability self-check (issue #284)', () => {
  it('logs a HARD ERROR (not info) when the login wall returns 401', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: false, status: 401 }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: LOCAL_URL,
      origin: 'app-path',
      log,
      fetchImpl
    });

    expect(outcome).toEqual({ ok: false, kind: 'auth-wall', status: 401 });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
    // Fetched unauthenticated: no headers/authorization passed to fetch.
    expect(fetchImpl).toHaveBeenCalledWith(LOCAL_URL, expect.objectContaining({}));
    const initArg = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1] ?? {};
    expect(initArg).not.toHaveProperty('headers');
  });

  it('logs a HARD ERROR when the login wall returns 403', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: false, status: 403 }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: LOCAL_URL,
      origin: 'app-path',
      log,
      fetchImpl
    });

    expect(outcome).toEqual({ ok: false, kind: 'auth-wall', status: 403 });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('stays quiet (info only, no error) on a 200', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: LOCAL_URL,
      origin: 'app-path',
      log,
      fetchImpl
    });

    expect(outcome).toEqual({ ok: true, status: 200 });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('logs a HARD ERROR on other non-OK statuses (e.g. 500)', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: false, status: 500 }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: LOCAL_URL,
      origin: 'app-path',
      log,
      fetchImpl
    });

    expect(outcome).toEqual({ ok: false, kind: 'unreachable', status: 500 });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('logs a HARD ERROR when the fetch throws (unreachable / network error)', async () => {
    const log = makeLogger();
    const boom = new Error('ECONNREFUSED');
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw boom;
    });

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: LOCAL_URL,
      origin: 'app-path',
      log,
      fetchImpl
    });

    expect(outcome).toEqual({ ok: false, kind: 'unreachable', error: boom });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('is a no-op (no fetch, no logs) when no local index was derived', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: undefined,
      origin: 'remote-default',
      log,
      fetchImpl
    });

    expect(outcome).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('is a no-op when the derived URL is the REMOTE default (not the local index)', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: 'https://raw.githubusercontent.com/Eyevinn/encore-test-profiles/refs/heads/main/profiles.yml',
      origin: 'remote-default',
      log,
      fetchImpl
    });

    expect(outcome).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// Regression: the default production probe must TOLERATE a self-signed cert on
// the app's OWN URL (issue #337). The app's public URL serves a self-signed cert
// from inside the cluster, so the previous strict-TLS global fetch hard-failed
// this self-check on the cert alone. We start a real HTTPS server with a freshly
// generated self-signed cert and assert: (a) nodeSelfProbeFetch reaches it and
// gets the real status code, while (b) the strict global fetch throws on the
// same URL — proving the tolerance is specific to the probe, not a global TLS
// relaxation.
describe('nodeSelfProbeFetch self-signed cert tolerance (issue #337)', () => {
  let server: Server | undefined;
  let certDir: string | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (certDir) {
      rmSync(certDir, { recursive: true, force: true });
      certDir = undefined;
    }
  });

  function startSelfSignedServer(status: number): Promise<string> {
    certDir = mkdtempSync(join(tmpdir(), 'ovc-selfsigned-'));
    const keyPath = join(certDir, 'key.pem');
    const certPath = join(certDir, 'cert.pem');
    // Generate a genuine self-signed cert (untrusted by the system CA store).
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048',
        '-keyout', keyPath, '-out', certPath,
        '-days', '1', '-nodes', '-subj', '/CN=localhost'
      ],
      { stdio: 'ignore' }
    );
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);
    server = createHttpsServer({ key, cert }, (_req, res) => {
      res.statusCode = status;
      res.end('profiles-index');
    });
    return new Promise<string>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const { port } = server!.address() as AddressInfo;
        resolve(`https://127.0.0.1:${port}/api/v1/profiles/index.yml`);
      });
    });
  }

  it('reaches a self-signed HTTPS endpoint and returns its status (where strict fetch would throw)', async () => {
    const url = await startSelfSignedServer(200);

    // The strict global fetch must reject on the self-signed cert — this is the
    // exact failure mode the fix targets.
    await expect(fetch(url)).rejects.toThrow();

    // The default production probe tolerates the self-signed cert and returns
    // the real status.
    const res = await nodeSelfProbeFetch(url);
    expect(res).toEqual({ ok: true, status: 200 });
  });

  it('surfaces the real status (e.g. 401 login wall) over a self-signed endpoint instead of masking it as a TLS error', async () => {
    const url = await startSelfSignedServer(401);
    const res = await nodeSelfProbeFetch(url);
    expect(res).toEqual({ ok: false, status: 401 });
  });

  it('the full check reports OK over a self-signed self URL using the default probe', async () => {
    const url = await startSelfSignedServer(200);
    const log = makeLogger();
    // No fetchImpl injected => uses the default nodeSelfProbeFetch.
    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: url,
      origin: 'app-path',
      log
    });
    expect(outcome).toEqual({ ok: true, status: 200 });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ADR-026 D4 (issue #1209): the probe follows the RESOLVED profilesUrl tier.
//
// Two mis-scopings had to be fixed, in opposite directions, and both are pinned
// here: (1) with the published object-store index winning, the probe used to
// fire at the BUCKET while emitting login-wall/#284 wording that is wrong for an
// object-store origin; (2) on a catalog deploy PUBLIC_BASE_URL is unsettable
// (ADR-026 C9), so the old `usingLocalIndex: Boolean(publicBaseUrl)` boolean
// skipped the check entirely and the new PRIMARY tier got no boot check at all.
// Plus D4's publish verification: the published index must not only be fetchable
// but serve the profile count the publisher actually wrote.
// ---------------------------------------------------------------------------

const PUBLISHED_URL =
  'http://minio-abc.minio-minio.svc.cluster.local:8080/openvideocore-profiles/index.yml';

// Exactly the body renderPublishedProfileIndex emits (see
// src/services/profile-index-publisher.ts): one `name: <name>.yml` line per
// runnable profile.
const PUBLISHED_INDEX_BODY = 'program_h264: program_h264.yml\nprogram_hevc: program_hevc.yml\n';

describe('profiles-index probe scoped to the resolved tier (ADR-026 D4, issue #1209)', () => {
  it('PROBES the object-store origin even with no PUBLIC_BASE_URL (the catalog-deploy case the old boolean skipped)', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: PUBLISHED_INDEX_BODY,
      bodyTruncated: false
    }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: PUBLISHED_URL,
      origin: 'object-store',
      expectedProfileCount: 2,
      bucket: 'openvideocore-profiles',
      endpointKind: 'in-cluster',
      log,
      fetchImpl
    });

    expect(outcome).toEqual({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    // The body is needed for the count comparison, so it must be requested.
    const initArg = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1] ?? {};
    expect(initArg).toMatchObject({ collectBody: true });
    // Still an unauthenticated GET: no headers of any kind.
    expect(initArg).not.toHaveProperty('headers');
    // Log context names the origin, bucket and key, not the app path.
    const infoCtx = (log.info as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(infoCtx).toMatchObject({
      origin: 'object-store',
      bucket: 'openvideocore-profiles',
      objectKey: 'index.yml',
      endpointKind: 'in-cluster',
      publishedProfileCount: 2,
      countVerified: true
    });
  });

  it('describes an object-store 401/403 WITHOUT the login-wall / issue-#284 wording', async () => {
    for (const status of [401, 403]) {
      const log = makeLogger();
      const fetchImpl: FetchLike = vi.fn(async () => ({ ok: false, status }));

      const outcome = await checkProfilesIndexReachable({
        profilesIndexUrl: PUBLISHED_URL,
        origin: 'object-store',
        expectedProfileCount: 2,
        log,
        fetchImpl
      });

      expect(outcome).toEqual({ ok: false, kind: 'auth-wall', status });
      expect(log.error).toHaveBeenCalledTimes(1);
      const msg = String((log.error as ReturnType<typeof vi.fn>).mock.calls[0][1]);
      expect(msg).not.toMatch(/login wall/i);
      expect(msg).not.toMatch(/#284/);
      expect(msg).not.toMatch(/\/api\/v1\/profiles/);
      // Points at the thing this app actually controls (ADR-026 D3).
      expect(msg).toMatch(/GetObject/);
      expect(msg).toMatch(/bucket/i);
    }
  });

  it('KEEPS the login-wall / issue-#284 wording for the app-path origin', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: false, status: 401 }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: LOCAL_URL,
      origin: 'app-path',
      log,
      fetchImpl
    });

    expect(outcome).toEqual({ ok: false, kind: 'auth-wall', status: 401 });
    const msg = String((log.error as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(msg).toMatch(/login wall/i);
    expect(msg).toMatch(/issue #284/);
    // The app-path probe only needs the status code, so it must NOT ask for the
    // body (unchanged cost, ADR-026 D4).
    const initArg = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1] ?? {};
    expect(initArg).not.toHaveProperty('collectBody');
  });

  it('reports stale-index when the published index serves a different profile count than was written', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: 'program_h264: program_h264.yml\n',
      bodyTruncated: false
    }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: PUBLISHED_URL,
      origin: 'object-store',
      expectedProfileCount: 2,
      log,
      fetchImpl
    });

    expect(outcome).toEqual({
      ok: false,
      kind: 'stale-index',
      status: 200,
      publishedProfileCount: 1,
      expectedProfileCount: 2
    });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
    expect(String((log.error as ReturnType<typeof vi.fn>).mock.calls[0][1])).toMatch(/STALE/);
  });

  it('counts the empty-store index body ({}, issue #459) as zero entries', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: '{}\n',
      bodyTruncated: false
    }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: PUBLISHED_URL,
      origin: 'object-store',
      expectedProfileCount: 0,
      log,
      fetchImpl
    });

    expect(outcome).toEqual({ ok: true, status: 200 });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('reports OK but SKIPS count verification when the body is truncated or unavailable', async () => {
    for (const res of [
      { ok: true, status: 200, body: 'program_h264: program_h264.yml\n', bodyTruncated: true },
      { ok: true, status: 200 }
    ]) {
      const log = makeLogger();
      const outcome = await checkProfilesIndexReachable({
        profilesIndexUrl: PUBLISHED_URL,
        origin: 'object-store',
        expectedProfileCount: 2,
        log,
        fetchImpl: vi.fn(async () => res)
      });

      expect(outcome).toEqual({ ok: true, status: 200 });
      expect(log.error).not.toHaveBeenCalled();
      expect((log.info as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
        countVerified: false
      });
    }
  });

  it('probes fetchability only (no body) when no published profile count is supplied', async () => {
    const log = makeLogger();
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));

    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: PUBLISHED_URL,
      origin: 'object-store',
      log,
      fetchImpl
    });

    expect(outcome).toEqual({ ok: true, status: 200 });
    expect(log.error).not.toHaveBeenCalled();
    const initArg = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1] ?? {};
    expect(initArg).not.toHaveProperty('collectBody');
  });

  it('reports an unreachable object store without the app-path wording', async () => {
    const log = makeLogger();
    const boom = new Error('ECONNREFUSED');
    const outcome = await checkProfilesIndexReachable({
      profilesIndexUrl: PUBLISHED_URL,
      origin: 'object-store',
      expectedProfileCount: 1,
      log,
      fetchImpl: vi.fn(async () => {
        throw boom;
      })
    });

    expect(outcome).toEqual({ ok: false, kind: 'unreachable', error: boom });
    const msg = String((log.error as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(msg).not.toMatch(/#284/);
    expect(msg).toMatch(/object-store/);
  });

  it('stays a no-op for the operator-typed / third-party tiers (override, param-store, remote-default)', async () => {
    for (const origin of ['override', 'param-store', 'remote-default'] as const) {
      const log = makeLogger();
      const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));

      const outcome = await checkProfilesIndexReachable({
        profilesIndexUrl: 'https://operator.example.test/their/index.yml',
        origin,
        log,
        fetchImpl
      });

      expect(outcome).toBeUndefined();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
      expect(log.info).not.toHaveBeenCalled();
    }
  });
});

// The default production probe gains an OPT-IN bounded body read for the
// publish verification (ADR-026 D4). Default behaviour — drain and discard —
// must be unchanged, so the app-path probe costs exactly what it did before.
describe('nodeSelfProbeFetch body collection (issue #1209)', () => {
  let server: HttpServer | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  function startServer(body: string): Promise<string> {
    server = createHttpServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/yaml; charset=utf-8');
      res.end(body);
    });
    return new Promise<string>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const { port } = server!.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}/openvideocore-profiles/index.yml`);
      });
    });
  }

  it('returns the body when collectBody is requested', async () => {
    const url = await startServer(PUBLISHED_INDEX_BODY);
    const res = await nodeSelfProbeFetch(url, { collectBody: true });
    expect(res).toEqual({
      ok: true,
      status: 200,
      body: PUBLISHED_INDEX_BODY,
      bodyTruncated: false
    });
  });

  it('drains and discards the body by default (unchanged)', async () => {
    const url = await startServer(PUBLISHED_INDEX_BODY);
    const res = await nodeSelfProbeFetch(url);
    expect(res).toEqual({ ok: true, status: 200 });
  });

  it('flags an oversized body as truncated instead of buffering it', async () => {
    const url = await startServer('x'.repeat(300 * 1024));
    const res = await nodeSelfProbeFetch(url, { collectBody: true });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.bodyTruncated).toBe(true);
  });
});
