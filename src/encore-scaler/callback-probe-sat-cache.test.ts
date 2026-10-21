// #1171 REVIEW FINDING A: the callback-listener service access token used to
// disambiguate an ingress auth-wall 401 was cached for the scaler loop's whole
// process lifetime, while the minted token expires in ~1h and the OSC client
// renews nothing. After an hour every authenticated re-probe carried an expired
// JWT, the ingress answered 401 exactly as it does for a missing credential, and
// every instance graded back to 'callback-unusable' — silently reverting the
// #1171 fix. These tests pin the expiry-aware cache and the forced re-mint.
//
// CONTRACTS VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
// ---------------------------------------------------
//   - `Context.getServiceAccessToken(serviceId: string): Promise<string>` —
//     `@osaas/client-core@0.24.0` `lib/context.d.ts:25`. Its implementation
//     (`lib/context.js:22-45`) POSTs
//     `https://token.svc.<env>.osaas.io/servicetoken` on EVERY call and returns
//     `serviceAccessToken.token` only, discarding the `expiry` field of the
//     `ServiceAccessToken` type (`lib/context.d.ts:5-9`:
//     `{ serviceId; token; expiry }`). `refreshServiceAccessToken`
//     (`lib/context.js:58-60`) is a plain re-mint, so there is no client-side
//     renewal to lean on and the expiry has to be read off the JWT.
//   - `exp` is a NumericDate (SECONDS since the epoch) in the JWS payload
//     segment — RFC 7519 §4.1.4 with RFC 7515 §3.1 for the three-segment
//     base64url encoding.

import { describe, it, expect, vi } from 'vitest';
import {
  EncoreScalerLoop,
  jwtExpiryEpochMs,
  SAT_EXPIRY_MARGIN_MS,
  SAT_UNKNOWN_EXPIRY_TTL_MS
} from './scaler-loop.js';
import type { EncoreScalerConfig } from './types.js';

// Minimal JWT in the shape a service access token arrives in: three base64url
// segments, `exp` in seconds.
function makeSat(expEpochSeconds: number, nonce = 'n'): string {
  const seg = (o: unknown) =>
    Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg({
    exp: expEpochSeconds,
    nonce
  })}.sig-${nonce}`;
}

// The loop constructor only stores its config (scaler-loop.ts), so the token
// accessor can be exercised with the one dependency it touches.
function loopWithTokens(
  getServiceAccessToken: (serviceId: string) => Promise<string>
): {
  getSat: (opts?: { forceRefresh?: boolean }) => Promise<string | undefined>;
} {
  const loop = new EncoreScalerLoop({
    workspaceId: 'ws-1171',
    oscContext: { getServiceAccessToken } as unknown as never
  } as unknown as EncoreScalerConfig);
  const reach = loop as unknown as {
    getCallbackListenerSat: (opts?: {
      forceRefresh?: boolean;
    }) => Promise<string | undefined>;
  };
  return { getSat: (opts) => reach.getCallbackListenerSat(opts) };
}

describe('jwtExpiryEpochMs (#1171 review finding A)', () => {
  it('reads exp as seconds and returns epoch ms', () => {
    const exp = Math.floor(Date.now() / 1000) + 3601;
    expect(jwtExpiryEpochMs(makeSat(exp))).toBe(exp * 1000);
  });

  it('returns undefined for a token that is not a three-segment JWT', () => {
    expect(jwtExpiryEpochMs('not-a-jwt')).toBeUndefined();
    expect(jwtExpiryEpochMs('two.segments')).toBeUndefined();
  });

  it('returns undefined when the payload has no usable exp claim', () => {
    const seg = (o: unknown) =>
      Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    expect(jwtExpiryEpochMs(`h.${seg({ sub: 'x' })}.s`)).toBeUndefined();
    expect(jwtExpiryEpochMs(`h.${seg({ exp: 'soon' })}.s`)).toBeUndefined();
    expect(jwtExpiryEpochMs(`h.${seg({ exp: 0 })}.s`)).toBeUndefined();
    expect(jwtExpiryEpochMs('h.!!!not-base64-json!!!.s')).toBeUndefined();
  });

  it('re-mints inside a margin of expiry rather than at expiry', () => {
    // A margin at least as long as one probe request (5s) plus clock skew.
    expect(SAT_EXPIRY_MARGIN_MS).toBeGreaterThanOrEqual(5_000);
    expect(SAT_UNKNOWN_EXPIRY_TTL_MS).toBeGreaterThan(0);
    // An unreadable expiry must not be trusted for anything like the ~1h a real
    // token lasts.
    expect(SAT_UNKNOWN_EXPIRY_TTL_MS).toBeLessThan(3_601_000);
  });
});

describe('callback-listener SAT cache (#1171 review finding A)', () => {
  it('reuses a token that is still comfortably inside its exp', async () => {
    const sat = makeSat(Math.floor(Date.now() / 1000) + 3601);
    const mint = vi.fn(async () => sat);
    const { getSat } = loopWithTokens(mint);
    expect(await getSat()).toBe(sat);
    expect(await getSat()).toBe(sat);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('re-mints once the cached token is within the expiry margin', async () => {
    // Exactly the regression: the old cache would hand this token out forever.
    const nearlyExpired = makeSat(
      Math.floor((Date.now() + SAT_EXPIRY_MARGIN_MS / 2) / 1000),
      'stale'
    );
    const fresh = makeSat(Math.floor(Date.now() / 1000) + 3601, 'fresh');
    const mint = vi
      .fn<(serviceId: string) => Promise<string>>()
      .mockResolvedValueOnce(nearlyExpired)
      .mockResolvedValue(fresh);
    const { getSat } = loopWithTokens(mint);
    expect(await getSat()).toBe(nearlyExpired);
    expect(await getSat()).toBe(fresh);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('re-mints an already expired token instead of replaying it', async () => {
    const expired = makeSat(Math.floor(Date.now() / 1000) - 10, 'expired');
    const fresh = makeSat(Math.floor(Date.now() / 1000) + 3601, 'fresh');
    const mint = vi
      .fn<(serviceId: string) => Promise<string>>()
      .mockResolvedValueOnce(expired)
      .mockResolvedValue(fresh);
    const { getSat } = loopWithTokens(mint);
    await getSat();
    expect(await getSat()).toBe(fresh);
  });

  it('forceRefresh discards the cached token and mints a new one', async () => {
    // The probe calls this when the ingress rejected the authenticated attempt.
    const first = makeSat(Math.floor(Date.now() / 1000) + 3601, 'first');
    const second = makeSat(Math.floor(Date.now() / 1000) + 3601, 'second');
    const mint = vi
      .fn<(serviceId: string) => Promise<string>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(second);
    const { getSat } = loopWithTokens(mint);
    expect(await getSat()).toBe(first);
    expect(await getSat({ forceRefresh: true })).toBe(second);
    // And the new token is what later probes get.
    expect(await getSat()).toBe(second);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('caches a token with an unreadable expiry for a short window only', async () => {
    const opaque = 'opaque-not-a-jwt';
    const mint = vi.fn(async () => opaque);
    const { getSat } = loopWithTokens(mint);
    expect(await getSat()).toBe(opaque);
    expect(await getSat()).toBe(opaque);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('leaves no token cached when the mint fails, and recovers on the next call', async () => {
    const fresh = makeSat(Math.floor(Date.now() / 1000) + 3601, 'after-failure');
    const mint = vi
      .fn<(serviceId: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('servicetoken 503'))
      .mockResolvedValue(fresh);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { getSat } = loopWithTokens(mint);
    expect(await getSat()).toBeUndefined();
    expect(await getSat()).toBe(fresh);
    warn.mockRestore();
  });

  it('asks for the callback-listener service id, not the Encore one', async () => {
    const mint = vi.fn(async () => makeSat(Math.floor(Date.now() / 1000) + 3601));
    const { getSat } = loopWithTokens(mint);
    await getSat();
    expect(mint).toHaveBeenCalledWith('eyevinn-encore-callback-listener');
  });
});
