// #1171 REVIEW FINDING H (maintainer decision 2026-10-15, issue #1171): the
// callback-listener service-access-token mint is awaited inside the scaler's
// non-overlapping tick guard, and the OSC client passes no `signal`/`timeout` to
// its own fetch. A token service that accepts the connection and then never
// answers therefore stalled the whole tick — readiness, dispatch and the orphan
// sweep — for as long as that socket lived: a worse version of the ~60s stall
// #1171 was filed to fix.
//
// These tests pin the bound: the mint is raced against a short timer that
// resolves `undefined`, which lands on the same fail-safe path the mint's own
// `catch` already defines (no token -> the probe keeps its pre-#1171
// unauthenticated behaviour), so the tick always proceeds.
//
// CONTRACTS VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
// ---------------------------------------------------
//   - `Context.getServiceAccessToken(serviceId: string): Promise<string>` —
//     `@osaas/client-core@0.24.0` `lib/context.d.ts:25`. Its implementation
//     (`lib/context.js:22-45`) POSTs
//     `https://token.svc.<env>.osaas.io/servicetoken` with no `signal` and no
//     `timeout` option, so nothing below this layer bounds the call; the awaited
//     promise is the only place a bound can be applied.
//   - `EncoreScalerLoop.getCallbackListenerSat(opts?: { forceRefresh?: boolean })
//     : Promise<string | undefined>` — `src/encore-scaler/scaler-loop.ts`; its
//     documented fail-safe contract is "returns undefined, never throws", which
//     is the contract the timeout branch has to satisfy too.
//   - `SAT_MINT_TIMEOUT_MS` / `DEFAULT_PROBE_REQUEST_TIMEOUT_MS` —
//     `src/encore-scaler/scaler-loop.ts` and
//     `src/encore-scaler/callback-trust-probe.ts:207`.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  EncoreScalerLoop,
  SAT_MINT_TIMEOUT_MS
} from './scaler-loop.js';
import { DEFAULT_PROBE_REQUEST_TIMEOUT_MS } from './callback-trust-probe.js';
import type { EncoreScalerConfig } from './types.js';

// Same minimal JWT shape a real service access token arrives in: three
// base64url segments with `exp` in SECONDS (RFC 7519 §4.1.4).
function makeSat(expEpochSeconds: number, nonce = 'n'): string {
  const seg = (o: unknown) =>
    Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg({
    exp: expEpochSeconds,
    nonce
  })}.sig-${nonce}`;
}

// The loop constructor only stores its config, so the token accessor can be
// exercised against the single dependency it touches.
function loopWithTokens(
  getServiceAccessToken: (serviceId: string) => Promise<string>
): {
  getSat: (opts?: { forceRefresh?: boolean }) => Promise<string | undefined>;
} {
  const loop = new EncoreScalerLoop({
    workspaceId: 'ws-1171-h',
    oscContext: { getServiceAccessToken } as unknown as never
  } as unknown as EncoreScalerConfig);
  const reach = loop as unknown as {
    getCallbackListenerSat: (opts?: {
      forceRefresh?: boolean;
    }) => Promise<string | undefined>;
  };
  return { getSat: (opts) => reach.getCallbackListenerSat(opts) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('callback-listener SAT mint bound (#1171 review finding H)', () => {
  it('resolves undefined at the bound when the mint never resolves, instead of hanging the tick', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Exactly the reported failure mode: the token service accepts the call and
    // never answers. No rejection, no abort — the promise simply never settles.
    const mint = vi.fn(
      () => new Promise<string>(() => undefined)
    );
    const { getSat } = loopWithTokens(mint);

    const pending = getSat();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    // Just before the bound the accessor is still waiting (it is a real bound,
    // not an immediate give-up that would lose the token on every healthy mint).
    await vi.advanceTimersByTimeAsync(SAT_MINT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    // At the bound it resolves — undefined, not a rejection: the documented
    // fail-safe shape, so the probe just continues unauthenticated.
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeUndefined();
    expect(mint).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('caches nothing when the mint times out, so the next call can still get a token', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fresh = makeSat(Math.floor(Date.now() / 1000) + 3601, 'after-timeout');
    const mint = vi
      .fn<(serviceId: string) => Promise<string>>()
      .mockImplementationOnce(() => new Promise<string>(() => undefined))
      .mockResolvedValue(fresh);
    const { getSat } = loopWithTokens(mint);

    const first = getSat();
    await vi.advanceTimersByTimeAsync(SAT_MINT_TIMEOUT_MS);
    await expect(first).resolves.toBeUndefined();

    // A timed-out mint must not leave a half-state behind: the recovery path is
    // the same one a rejected mint already has.
    await expect(getSat()).resolves.toBe(fresh);
    expect(mint).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('bounds a never-resolving forceRefresh re-mint the same way', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cached = makeSat(Math.floor(Date.now() / 1000) + 3601, 'cached');
    const mint = vi
      .fn<(serviceId: string) => Promise<string>>()
      .mockResolvedValueOnce(cached)
      .mockImplementation(() => new Promise<string>(() => undefined));
    const { getSat } = loopWithTokens(mint);

    await expect(getSat()).resolves.toBe(cached);

    // The probe's one re-mint-and-retry (review finding A) goes through the same
    // accessor, so it has to be bounded too — it runs in the same tick.
    const refreshed = getSat({ forceRefresh: true });
    await vi.advanceTimersByTimeAsync(SAT_MINT_TIMEOUT_MS);
    await expect(refreshed).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('does not hold the process open on the guard timer', async () => {
    // The bound adds a timer on a path that runs every tick while instances are
    // being gated. If it were not unref'd it would keep the event loop (and the
    // test runner) alive; assert the timer handle is unref'd rather than relying
    // on the suite hanging to reveal it.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unrefs: unknown[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: () => void, ms?: number) => {
        const handle = realSetTimeout(fn, ms) as unknown as {
          unref?: () => unknown;
        };
        const originalUnref = handle.unref;
        if (typeof originalUnref === 'function') {
          handle.unref = () => {
            unrefs.push(handle);
            return originalUnref.call(handle);
          };
        }
        return handle as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);

    const { getSat } = loopWithTokens(
      () => new Promise<string>(() => undefined)
    );
    const pending = getSat();
    await vi.advanceTimersByTimeAsync(SAT_MINT_TIMEOUT_MS);
    await expect(pending).resolves.toBeUndefined();
    expect(unrefs.length).toBeGreaterThan(0);

    spy.mockRestore();
    warn.mockRestore();
  });

  it('keeps the mint bound short and no longer than one probe request', () => {
    // The mint exists only to feed the callback-trust probe, so letting the
    // token leg outlast the probe request it feeds would re-open the stall.
    expect(SAT_MINT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SAT_MINT_TIMEOUT_MS).toBeLessThanOrEqual(
      DEFAULT_PROBE_REQUEST_TIMEOUT_MS
    );
    // Comfortably inside the 10s tick cadence, which is the property finding H
    // is about.
    expect(SAT_MINT_TIMEOUT_MS).toBeLessThan(10_000);
  });
});
