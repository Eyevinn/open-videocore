// Opt-in fronting-layer trust for the UI presence gate (issue #767).
//
// Two halves are covered: the env-config resolver (feature OFF unless explicitly
// and validly configured) and the gate itself driven through a REAL gated router,
// asserting both the DEFAULT-OFF path (identical to #711's 401 behaviour) and the
// OPT-IN-ON path (only same-origin /ui requests carrying the declared signal are
// admitted; everything else still 401s).
//
// Verified contract (per CLAUDE.md rule 7):
//   - registerAuth(app, opts) / `authenticate`: src/auth/middleware.ts — 401 +
//     `WWW-Authenticate: Bearer` and `{ error: 'unauthorized' }` on an anonymous
//     request; `AuthOptions.uiPresenceTrust` defaults to null (feature off).
//   - authGate(app) presence gate the routers attach: src/auth/middleware.ts:76-87
//     (issue #711).
//   - requireAuth() pure presence semantics: src/auth/workspace.ts:52-57.
//   - resolveUiPresenceTrust / isTrustedUiPresenceRequest / UI_PATH_PREFIX and the
//     env var names: src/auth/ui-presence-trust.ts.
//   - GET/POST /api/v1/assets router used as the gated surface:
//     src/routes/assets.ts (assetsRouter) + InMemoryAssetRepository
//     (src/data/asset-repo.ts), mirroring test/workspace-acl.test.ts:15-24.
//   - /ui mount the trusted Referer must point at: src/main.ts (fastifyStatic
//     `prefix: '/ui/'` + the `/ui` → `/ui/index.html` redirect).

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerAuth, type AuthOptions } from '../src/auth/middleware.js';
import {
  resolveUiPresenceTrust,
  isTrustedUiPresenceRequest,
  UI_PRESENCE_TRUST_HEADER_ENV,
  UI_PRESENCE_TRUST_VALUE_ENV,
  type UiPresenceTrustConfig
} from '../src/auth/ui-presence-trust.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';

const SIGNAL_HEADER = 'x-fronting-authenticated';
const HOST = 'ovc.example.test';

async function buildApp(opts: AuthOptions = {}): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app, opts);
  const repository = new InMemoryAssetRepository();
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository });
  await app.ready();
  return app;
}

// The full set of headers a browser on this instance's own /ui page sends once
// the fronting layer has injected the declared signal.
function uiRequestHeaders(overrides: Record<string, string | string[]> = {}): Record<string, string | string[]> {
  return {
    host: HOST,
    referer: `https://${HOST}/ui/index.html`,
    'sec-fetch-site': 'same-origin',
    [SIGNAL_HEADER]: 'yes',
    ...overrides
  };
}

describe('resolveUiPresenceTrust (issue #767 config)', () => {
  it('is disabled when the env var is unset — the default', () => {
    expect(resolveUiPresenceTrust({})).toEqual({ config: null, reason: 'disabled' });
  });

  it('is disabled when the env var is blank', () => {
    expect(resolveUiPresenceTrust({ [UI_PRESENCE_TRUST_HEADER_ENV]: '   ' })).toEqual({
      config: null,
      reason: 'disabled'
    });
  });

  it('enables with the header name trimmed and lowercased', () => {
    expect(
      resolveUiPresenceTrust({ [UI_PRESENCE_TRUST_HEADER_ENV]: '  X-Fronting-Authenticated ' })
    ).toEqual({ config: { headerName: 'x-fronting-authenticated' }, reason: 'enabled' });
  });

  it('carries the optional expected value when one is configured', () => {
    expect(
      resolveUiPresenceTrust({
        [UI_PRESENCE_TRUST_HEADER_ENV]: SIGNAL_HEADER,
        [UI_PRESENCE_TRUST_VALUE_ENV]: ' shared-secret '
      })
    ).toEqual({
      config: { headerName: SIGNAL_HEADER, expectedValue: 'shared-secret' },
      reason: 'enabled'
    });
  });

  it('ignores a blank expected value (any non-empty signal value qualifies)', () => {
    expect(
      resolveUiPresenceTrust({
        [UI_PRESENCE_TRUST_HEADER_ENV]: SIGNAL_HEADER,
        [UI_PRESENCE_TRUST_VALUE_ENV]: '  '
      })
    ).toEqual({ config: { headerName: SIGNAL_HEADER }, reason: 'enabled' });
  });

  it.each([
    'authorization',
    'Cookie',
    'host',
    'referer',
    'origin',
    'sec-fetch-site',
    'x-ovc-role',
    'x-stack-name'
  ])('fails closed when %s is nominated as the trusted signal', (name) => {
    const resolved = resolveUiPresenceTrust({ [UI_PRESENCE_TRUST_HEADER_ENV]: name });
    expect(resolved.config).toBeNull();
    expect(resolved.reason).toBe('forbidden-header-name');
  });
});

describe('isTrustedUiPresenceRequest (issue #767 predicate)', () => {
  const config: UiPresenceTrustConfig = { headerName: SIGNAL_HEADER };

  it('trusts a same-origin /ui request carrying the declared signal', () => {
    expect(isTrustedUiPresenceRequest(uiRequestHeaders(), config)).toBe(true);
  });

  it('trusts the bare /ui path (the redirect target parent) as the referring page', () => {
    expect(
      isTrustedUiPresenceRequest(uiRequestHeaders({ referer: `https://${HOST}/ui` }), config)
    ).toBe(true);
  });

  it('does not trust a request without the declared signal', () => {
    const headers = uiRequestHeaders();
    delete headers[SIGNAL_HEADER];
    expect(isTrustedUiPresenceRequest(headers, config)).toBe(false);
  });

  it('does not trust a repeated signal header', () => {
    expect(
      isTrustedUiPresenceRequest(uiRequestHeaders({ [SIGNAL_HEADER]: ['yes', 'yes'] }), config)
    ).toBe(false);
  });

  it('does not trust an empty signal value', () => {
    expect(isTrustedUiPresenceRequest(uiRequestHeaders({ [SIGNAL_HEADER]: '  ' }), config)).toBe(
      false
    );
  });

  it('requires Sec-Fetch-Site: same-origin, failing closed when it is absent', () => {
    const headers = uiRequestHeaders();
    delete headers['sec-fetch-site'];
    expect(isTrustedUiPresenceRequest(headers, config)).toBe(false);
    expect(
      isTrustedUiPresenceRequest(uiRequestHeaders({ 'sec-fetch-site': 'cross-site' }), config)
    ).toBe(false);
    expect(
      isTrustedUiPresenceRequest(uiRequestHeaders({ 'sec-fetch-site': 'same-site' }), config)
    ).toBe(false);
  });

  it('does not trust a Referer from another host', () => {
    expect(
      isTrustedUiPresenceRequest(
        uiRequestHeaders({ referer: 'https://attacker.example/ui/index.html' }),
        config
      )
    ).toBe(false);
  });

  it('does not trust a Referer outside the /ui mount', () => {
    for (const referer of [
      `https://${HOST}/docs`,
      `https://${HOST}/`,
      `https://${HOST}/uixyz/page`,
      `https://${HOST}/api/v1/assets`
    ]) {
      expect(isTrustedUiPresenceRequest(uiRequestHeaders({ referer }), config)).toBe(false);
    }
  });

  it('does not trust an unparseable or missing Referer', () => {
    expect(isTrustedUiPresenceRequest(uiRequestHeaders({ referer: '/ui/index.html' }), config)).toBe(
      false
    );
    const headers = uiRequestHeaders();
    delete headers['referer'];
    expect(isTrustedUiPresenceRequest(headers, config)).toBe(false);
  });

  it('does not trust a request with no Host to compare the Referer against', () => {
    const headers = uiRequestHeaders();
    delete headers['host'];
    expect(isTrustedUiPresenceRequest(headers, config)).toBe(false);
  });

  it('requires an exact match when an expected value is configured', () => {
    const withSecret: UiPresenceTrustConfig = {
      headerName: SIGNAL_HEADER,
      expectedValue: 'shared-secret'
    };
    expect(
      isTrustedUiPresenceRequest(uiRequestHeaders({ [SIGNAL_HEADER]: 'shared-secret' }), withSecret)
    ).toBe(true);
    expect(
      isTrustedUiPresenceRequest(uiRequestHeaders({ [SIGNAL_HEADER]: 'shared-secre' }), withSecret)
    ).toBe(false);
    expect(
      isTrustedUiPresenceRequest(uiRequestHeaders({ [SIGNAL_HEADER]: 'wrong' }), withSecret)
    ).toBe(false);
  });
});

describe('presence gate with fronting-layer trust UNSET — default off (issues #711, #767)', () => {
  it('rejects an anonymous API request (401), unchanged from #711', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/assets' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.json().error).toBe('unauthorized');
    await app.close();
  });

  it('still rejects a same-origin /ui request carrying a fronting-layer signal (401)', async () => {
    // The exact request the opt-in would admit must be rejected while the
    // deployment has not opted in — the signal is inert by default.
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: uiRequestHeaders()
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    await app.close();
  });

  it('admits a bearer token as before', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: { authorization: 'Bearer any-token' }
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('is also off when uiPresenceTrust is explicitly null', async () => {
    const app = await buildApp({ uiPresenceTrust: null });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: uiRequestHeaders()
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('presence gate with fronting-layer trust ENABLED — opt-in on (issue #767)', () => {
  const opts: AuthOptions = { uiPresenceTrust: { headerName: SIGNAL_HEADER } };

  it('admits a same-origin /ui request carrying the declared signal, with no bearer token', async () => {
    const app = await buildApp(opts);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: uiRequestHeaders()
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [], total: 0 });
    await app.close();
  });

  it('admits a write from the UI too (the gate, not the route, is what changes)', async () => {
    const app = await buildApp(opts);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: uiRequestHeaders(),
      payload: { name: 'clip one' }
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('still rejects an anonymous request from OUTSIDE the UI (401, #711 default preserved)', async () => {
    const app = await buildApp(opts);
    // No fronting signal, no fetch metadata, no /ui referer — a plain API caller.
    const bare = await app.inject({ method: 'GET', url: '/api/v1/assets', headers: { host: HOST } });
    expect(bare.statusCode).toBe(401);
    expect(bare.headers['www-authenticate']).toBe('Bearer');

    // A caller that forges the signal but is not a same-origin /ui request.
    const forged = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: { host: HOST, [SIGNAL_HEADER]: 'yes' }
    });
    expect(forged.statusCode).toBe(401);

    // Cross-site fetch metadata, signal present.
    const crossSite = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: uiRequestHeaders({ 'sec-fetch-site': 'cross-site' })
    });
    expect(crossSite.statusCode).toBe(401);

    // Same-origin but referred from outside the /ui mount.
    const offUi = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: uiRequestHeaders({ referer: `https://${HOST}/docs` })
    });
    expect(offUi.statusCode).toBe(401);

    await app.close();
  });

  it('requires the configured shared secret when one is set', async () => {
    const app = await buildApp({
      uiPresenceTrust: { headerName: SIGNAL_HEADER, expectedValue: 'shared-secret' }
    });
    const wrong = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: uiRequestHeaders({ [SIGNAL_HEADER]: 'guess' })
    });
    expect(wrong.statusCode).toBe(401);

    const right = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: uiRequestHeaders({ [SIGNAL_HEADER]: 'shared-secret' })
    });
    expect(right.statusCode).toBe(200);
    await app.close();
  });

  it('leaves the bearer-token path untouched', async () => {
    const app = await buildApp(opts);
    // A token is still admitted on its own, with none of the /ui headers...
    const withToken = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: { authorization: 'Bearer any-token' }
    });
    expect(withToken.statusCode).toBe(200);
    // ...and an empty bearer is still rejected even from a trusted-looking /ui
    // request only when the trust conditions fail (here: no signal header).
    const headers = uiRequestHeaders();
    delete headers[SIGNAL_HEADER];
    const noSignal = await app.inject({ method: 'GET', url: '/api/v1/assets', headers });
    expect(noSignal.statusCode).toBe(401);
    await app.close();
  });
});
