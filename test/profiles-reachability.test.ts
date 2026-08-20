// Boot-time profiles-index reachability self-check tests (issue #284).
//
// The check fetches this app's OWN derived Encore profiles index URL exactly as
// Encore would — an unauthenticated GET — and must log a HARD ERROR when the OSC
// login wall rejects it (401/403) or it is otherwise unreachable, while staying
// quiet (info-only) on a 200. Uses an injected fetch so there is no real network
// I/O; unrelated to the workspace-scoping suite failures.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer as createHttpsServer, type Server } from 'node:https';
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
      usingLocalIndex: true,
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
      usingLocalIndex: true,
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
      usingLocalIndex: true,
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
      usingLocalIndex: true,
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
      usingLocalIndex: true,
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
      usingLocalIndex: false,
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
      usingLocalIndex: false,
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
      usingLocalIndex: true,
      log
    });
    expect(outcome).toEqual({ ok: true, status: 200 });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});
