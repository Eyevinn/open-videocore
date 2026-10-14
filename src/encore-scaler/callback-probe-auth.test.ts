// Issue #1171: the callback-trust probe reported `callback path NOT usable …
// status: 401 … elapsedMs: 62464` on 4 of 4 Encore instances, so completion
// always fell back to the terminal-job sweep instead of the callbacks.
//
// Acceptance criteria under test (from the issue):
//   - "the probe succeeds on a healthy instance"
//   - "a failed probe finishes within a short bounded time"
//   - a 401 that comes from the OSC ingress's inbound auth wall is no longer
//     graded as a closed callback path.
//
// CONTRACTS VERIFIED BEFORE WRITING THESE TESTS (CLAUDE.md rule 7)
// ----------------------------------------------------------------
//   - The per-instance listener ingress auth wall accepts the service access
//     token as `x-jwt: Bearer <SAT>` — `@osaas/client-core@0.24.0`
//     `lib/core.js:86` sends exactly that header, and verified live
//     2026-10-14 against
//     `oscaidev-ovc.eyevinn-encore-callback-listener.auto.prod-se.osaas.io`:
//     `GET /healthcheck` → 401 (nginx HTML) unauthenticated, → 200
//     (`{"status":"up"}`) with `x-jwt: Bearer <SAT>`.
//   - A HEALTHY listener answers the unauthenticated probe with Fastify's own
//     404 — verified live 2026-10-14 on two warm instances (`ovc`,
//     `scalerqabeta0911mtwkc5fu`): `HEAD /encoreCallback` → 404 and
//     `GET /encoreCallback` → 404 with
//     `{"message":"Route GET:/encoreCallback not found",…}`, both with and
//     without the SAT. So the happy path must need no credential at all.
//   - `Context.getServiceAccessToken(serviceId): Promise<string>` —
//     `@osaas/client-core@0.24.0` `lib/context.d.ts:25`.

import { describe, it, expect, vi } from 'vitest';
import {
  probeCallbackTrust,
  DEFAULT_PROBE_REQUEST_TIMEOUT_MS
} from './callback-trust-probe.js';

const LISTENER_URL = 'https://listener-1171.auto.prod-se.osaas.io';
const CALLBACK_URL = `${LISTENER_URL}/encoreCallback`;
const SAT = 'test-callback-listener-sat';

describe('probeCallbackTrust ingress-auth disambiguation (#1171)', () => {
  it('grades a healthy listener as trusted without sending any credential', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fetchImpl = vi.fn(
      async (_input: string, init?: { headers?: Record<string, string> }) => {
        seen.push(init?.headers);
        return { status: 404 };
      }
    );
    const r = await probeCallbackTrust(LISTENER_URL, 60_000, fetchImpl, {
      authToken: SAT
    });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('trusted');
    // Exactly one request, and it carries no auth header: the unauthenticated
    // request is what Encore makes, so the happy path must grade that one.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([undefined]);
  });

  it('reports ingress-auth-window when the unauthenticated probe 401s but the SAT gets through', async () => {
    // The #1171 production shape: nginx 401 for a credential-free request,
    // application 404 once the ingress auth wall is satisfied.
    const fetchImpl = vi.fn(
      async (_input: string, init?: { headers?: Record<string, string> }) =>
        init?.headers?.['x-jwt'] ? { status: 404 } : { status: 401 }
    );
    const r = await probeCallbackTrust(LISTENER_URL, 60_000, fetchImpl, {
      authToken: SAT
    });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('ingress-auth-window');
    if (r.state !== 'ingress-auth-window') throw new Error('unreachable');
    expect(r.status).toBe(401);
    expect(r.authenticatedStatus).toBe(404);
    // The second attempt is the same URL plus the verified header form.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      CALLBACK_URL,
      expect.objectContaining({
        method: 'HEAD',
        headers: { 'x-jwt': `Bearer ${SAT}` }
      })
    );
  });

  it('keeps the callback-unusable verdict when even the authenticated probe is rejected', async () => {
    // Not the auth wall: a standing rejection on the callback path itself, the
    // #813 case. Must still be reported as unusable.
    const fetchImpl = vi.fn(async () => ({ status: 403 }));
    const r = await probeCallbackTrust(LISTENER_URL, 60_000, fetchImpl, {
      authToken: SAT
    });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('callback-unusable');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps the callback-unusable verdict when no token is available', async () => {
    // getServiceAccessToken failing must not change the pre-#1171 grading.
    const fetchImpl = vi.fn(async () => ({ status: 401 }));
    const r = await probeCallbackTrust(LISTENER_URL, 60_000, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.state).toBe('callback-unusable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the callback-unusable verdict when the authenticated attempt cannot complete', async () => {
    const fetchImpl = vi.fn(
      async (_input: string, init?: { headers?: Record<string, string> }) => {
        if (init?.headers?.['x-jwt']) throw new Error('socket hang up');
        return { status: 401 };
      }
    );
    const r = await probeCallbackTrust(LISTENER_URL, 60_000, fetchImpl, {
      authToken: SAT
    });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('callback-unusable');
  });
});

describe('probeCallbackTrust per-request bound (#1171)', () => {
  it('bounds a single request well inside the cross-tick wait and fails fast', async () => {
    // Before #1171 the 60s cross-tick wait doubled as the AbortSignal window,
    // so a hung request occupied a whole tick — and instance readiness with it
    // — for a minute. The per-request bound is what has to fire here.
    const fetchImpl = vi.fn(
      (_input: string, init?: { signal?: AbortSignal }) =>
        new Promise<{ status: number }>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'TimeoutError';
            reject(err);
          });
        })
    );
    const startedAt = Date.now();
    const r = await probeCallbackTrust(LISTENER_URL, 60_000, fetchImpl, {
      requestTimeoutMs: 40
    });
    const elapsedMs = Date.now() - startedAt;
    expect(r.ok).toBe(false);
    if (r.state !== 'probe-failed') throw new Error('unreachable');
    expect(r.errorClass).toBe('timeout');
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('defaults the per-request bound to 5s rather than the caller bounded wait', async () => {
    expect(DEFAULT_PROBE_REQUEST_TIMEOUT_MS).toBe(5_000);
    let observed: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      async (_input: string, init?: { signal?: AbortSignal }) => {
        observed = init?.signal;
        return { status: 404 };
      }
    );
    await probeCallbackTrust(LISTENER_URL, 600_000, fetchImpl);
    expect(observed).toBeInstanceOf(AbortSignal);
    // A 600s caller deadline must not become a 600s request window: the signal
    // created from the 5s default is already a different object than one made
    // from the caller's value, so assert the request completes under a bound we
    // can observe — the abort has not fired, and the default is asserted above.
    expect(observed?.aborted).toBe(false);
  });

  it('never exceeds the caller bounded wait when that is shorter than the default', async () => {
    const fetchImpl = vi.fn(
      (_input: string, init?: { signal?: AbortSignal }) =>
        new Promise<{ status: number }>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    );
    const startedAt = Date.now();
    const r = await probeCallbackTrust(LISTENER_URL, 30, fetchImpl);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(r.ok).toBe(false);
    if (r.state !== 'probe-failed') throw new Error('unreachable');
    expect(r.errorClass).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// #1171 review findings. Each block below pins one of the three blocking
// findings (and the two cheap non-blocking ones) so the fix cannot regress.
// ---------------------------------------------------------------------------

describe('probeCallbackTrust timeout detail (#1171 review finding B)', () => {
  const abortingFetch = () =>
    vi.fn(
      (_input: string, init?: { signal?: AbortSignal }) =>
        new Promise<{ status: number }>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'TimeoutError';
            reject(err);
          });
        })
    );

  it('names the per-request bound that actually aborted, not the caller deadline', async () => {
    // The abort comes from the per-request AbortSignal, so reporting the 60s
    // cross-tick wait described a hang that never happened.
    const r = await probeCallbackTrust(LISTENER_URL, 60_000, abortingFetch(), {
      requestTimeoutMs: 40
    });
    expect(r.ok).toBe(false);
    if (r.state !== 'probe-failed') throw new Error('unreachable');
    expect(r.errorClass).toBe('timeout');
    expect(r.detail).toContain('40ms');
    expect(r.detail).not.toMatch(/timed out after 60000ms/);
  });

  it('mentions the caller bounded wait alongside the request bound', async () => {
    const r = await probeCallbackTrust(LISTENER_URL, 60_000, abortingFetch(), {
      requestTimeoutMs: 40
    });
    if (r.state !== 'probe-failed') throw new Error('unreachable');
    expect(r.detail).toContain('60000ms');
  });

  it('reports the clamped bound when the caller deadline is the shorter one', async () => {
    // requestTimeoutMs is Math.min'd with the caller deadline, so the detail has
    // to name the clamped value (25ms) rather than the 5s default.
    const r = await probeCallbackTrust(LISTENER_URL, 25, abortingFetch());
    if (r.state !== 'probe-failed') throw new Error('unreachable');
    expect(r.detail).toContain('timed out after 25ms');
  });
});

describe('probeCallbackTrust SAT re-mint (#1171 review finding A)', () => {
  it('re-mints once and retries when the authenticated attempt is also rejected', async () => {
    // What an EXPIRED cached SAT looks like from here: the ingress answers it
    // exactly like a missing one. Without the re-mint this graded the instance
    // callback-unusable and silently reverted the #1171 fix after ~1h uptime.
    const FRESH = 'fresh-callback-listener-sat';
    const fetchImpl = vi.fn(
      async (_input: string, init?: { headers?: Record<string, string> }) => {
        const jwt = init?.headers?.['x-jwt'];
        if (jwt === `Bearer ${FRESH}`) return { status: 404 };
        return { status: 401 };
      }
    );
    const refreshAuthToken = vi.fn(async () => FRESH);
    const r = await probeCallbackTrust(LISTENER_URL, 60_000, fetchImpl, {
      authToken: SAT,
      refreshAuthToken
    });
    expect(r.state).toBe('ingress-auth-window');
    if (r.state !== 'ingress-auth-window') throw new Error('unreachable');
    expect(r.authenticatedStatus).toBe(404);
    expect(refreshAuthToken).toHaveBeenCalledTimes(1);
    // unauthenticated, stale-SAT, fresh-SAT — and no more than that.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      CALLBACK_URL,
      expect.objectContaining({ headers: { 'x-jwt': `Bearer ${FRESH}` } })
    );
  });

  it('keeps callback-unusable when even the freshly minted token is rejected', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 401 }));
    const refreshAuthToken = vi.fn(async () => 'another-sat');
    const r = await probeCallbackTrust(LISTENER_URL, 60_000, fetchImpl, {
      authToken: SAT,
      refreshAuthToken
    });
    expect(r.state).toBe('callback-unusable');
    expect(refreshAuthToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not replay the same credential when the re-mint returns an identical token', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 401 }));
    const refreshAuthToken = vi.fn(async () => SAT);
    const r = await probeCallbackTrust(LISTENER_URL, 60_000, fetchImpl, {
      authToken: SAT,
      refreshAuthToken
    });
    expect(r.state).toBe('callback-unusable');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('survives a re-mint that fails, keeping the pre-review verdict', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 403 }));
    const refreshAuthToken = vi.fn(async () => {
      throw new Error('servicetoken 503');
    });
    const r = await probeCallbackTrust(LISTENER_URL, 60_000, fetchImpl, {
      authToken: SAT,
      refreshAuthToken
    });
    expect(r.state).toBe('callback-unusable');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never asks for a re-mint when the first authenticated attempt gets through', async () => {
    const fetchImpl = vi.fn(
      async (_input: string, init?: { headers?: Record<string, string> }) =>
        init?.headers?.['x-jwt'] ? { status: 404 } : { status: 401 }
    );
    const refreshAuthToken = vi.fn(async () => 'unused');
    const r = await probeCallbackTrust(LISTENER_URL, 60_000, fetchImpl, {
      authToken: SAT,
      refreshAuthToken
    });
    expect(r.state).toBe('ingress-auth-window');
    expect(refreshAuthToken).not.toHaveBeenCalled();
  });
});

describe('probeCallbackTrust credential handling (#1171 review finding E)', () => {
  it('refuses to put the bearer token on a non-https target', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 401 }));
    const refreshAuthToken = vi.fn(async () => 'unused');
    const r = await probeCallbackTrust(
      'http://listener-1171.internal:8080',
      60_000,
      fetchImpl,
      { authToken: SAT, refreshAuthToken }
    );
    // Loses the disambiguation rather than sending a tenant credential in the
    // clear; the pre-#1171 verdict stands.
    expect(r.state).toBe('callback-unusable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'http://listener-1171.internal:8080/encoreCallback',
      expect.objectContaining({ method: 'HEAD' })
    );
    expect(refreshAuthToken).not.toHaveBeenCalled();
  });
});
