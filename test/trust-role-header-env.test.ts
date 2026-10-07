// OVC_TRUST_ROLE_HEADER — trusted vs untrusted end-to-end coverage
// (issue #1105; acceptance criterion 2 + the 'How to verify' steps of #1092).
//
// #1092 asks for a managed instance to be able to trust a fronting layer that
// injects `X-OVC-Role`, and verifies it by sending `X-OVC-Role: viewer` to a
// WRITE route and expecting 403 `forbidden_insufficient_role` with the option on,
// and the same request passing as admin with it off. This file pins that
// behaviour at the repo level, driven by the env var itself rather than by a
// hand-passed boolean, so the env ⇒ trust ⇒ HTTP-status chain is covered:
//
//   OVC_TRUST_ROLE_HEADER (env) ⇒ trustRoleHeader (registerPrincipal)
//     ⇒ header honoured or stripped (trust boundary)
//     ⇒ role-gate verdict on a write route (403 vs 201).
//
// It also pins that ONLY the exact string "true" enables trust — the production
// read is a strict `=== 'true'` with no case-folding or trimming, so "TRUE",
// "True", "1", "yes" and " true" all leave the deployment untrusted. That matters
// because #1092's proposed catalog option is a free-text string config value, so
// an operator typo must fail SAFE (header stripped, behaviour unchanged) rather
// than half-enable role enforcement.
//
// Tests only — no production behaviour is changed here. The complementary
// matrix (role × action × resourceType) already lives in
// test/permissions-enforcement.test.ts; this file is specifically about the env
// switch.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Env read site: src/main.ts:505-507
//     `registerPrincipal(app, { trustRoleHeader: process.env['OVC_TRUST_ROLE_HEADER'] === 'true' })`.
//     MIRRORED by `trustRoleHeaderFromEnv()` below and pinned against drift by
//     the first test, which reads src/main.ts and asserts that exact text.
//   - Trusted header name: src/auth/principal.ts:36
//     `export const ROLE_HEADER = 'x-ovc-role'` (imported here, not retyped).
//   - Trust boundary / stripping: src/auth/principal.ts:199-201
//     (`if (!opts.trustRoleHeader) delete request.headers[ROLE_HEADER]`).
//   - Untrusted ⇒ admin default: src/auth/principal.ts:98-105
//     (absent header ⇒ role 'admin', source 'default').
//   - Write route under the gate: POST /api/v1/assets — spec path
//     `/api/v1/assets/` → `post` → response `201` (openapi.json), router
//     src/routes/assets.ts:2918 with the gate attached plugin-scoped at
//     src/routes/assets.ts:1773 `resourceAuthorizationPreHandler('asset')`.
//   - Method → action mapping (POST ⇒ 'write'): src/auth/authorize.ts:79-93.
//   - viewer may not write: src/auth/authorize.ts:54-58 (MATRIX.viewer.write === false).
//   - Error code: src/auth/authorize.ts:99
//     `export const AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role'`
//     (imported here, not retyped) and the 403 body shape at
//     src/auth/authorize.ts:150-164 (`error`, `message`, `action`, `resourceType`,
//     `role`). NOTE: openapi.json does not yet document a 403 response on
//     `/api/v1/assets/` → `post`, so the code above is the authoritative source
//     for the code and body shape.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerPrincipal, ROLE_HEADER, type ResolvedPrincipal } from '../src/auth/principal.js';
import { AUTHZ_FORBIDDEN_ERROR } from '../src/auth/authorize.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';

const ENV_VAR = 'OVC_TRUST_ROLE_HEADER';

// The write route #1092's 'How to verify' drives, and the status it returns when
// the caller is authorised (openapi.json: `/api/v1/assets/` → `post` → 201).
const WRITE_ROUTE = '/api/v1/assets';
const WRITE_OK_STATUS = 201;

// Verbatim text of the production read site (src/main.ts:505-507). The first test
// asserts src/main.ts still contains exactly this, so the mirror below cannot
// drift away from production without a test failure.
const PRODUCTION_READ_SITE =
  "trustRoleHeader: process.env['OVC_TRUST_ROLE_HEADER'] === 'true'";

// Mirror of src/main.ts:506 — read at call time so each test can set the env var
// first and exercise the real env ⇒ boolean mapping (strict equality, no
// case-folding, no trimming).
function trustRoleHeaderFromEnv(): boolean {
  return process.env[ENV_VAR] === 'true';
}

// Build an app wired exactly as production does for this concern: the principal
// onRequest hook (the trust boundary) in front of the assets router, which
// carries the plugin-scoped role gate (src/routes/assets.ts:1773). Mirrors
// buildApp() in test/permissions-enforcement.test.ts, except `trustRoleHeader`
// comes from the ENV VAR rather than a literal — that is the point of this file.
//
// `/__principal` is a test-only probe route registered OUTSIDE the assets router
// (so no role gate applies to it) that echoes `request.principal`. It lets the
// untrusted cases assert the positive claim "resolves as admin, header ignored"
// instead of only inferring it from a 201.
async function buildAppFromEnv(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerPrincipal(app, { trustRoleHeader: trustRoleHeaderFromEnv() });
  app.get('/__principal', async (request) => request.principal);
  await app.register(assetsRouter, {
    prefix: WRITE_ROUTE,
    repository: new InMemoryAssetRepository()
  });
  await app.ready();
  return app;
}

function asViewer(): Record<string, string> {
  return { [ROLE_HEADER]: 'viewer' };
}

// POST a minimal asset create — the write action #1092 verifies with.
async function writeAs(
  app: FastifyInstance,
  headers: Record<string, string>,
  name = 'trust-header-probe'
) {
  return app.inject({ method: 'POST', url: WRITE_ROUTE, headers, payload: { name } });
}

async function principalOf(
  app: FastifyInstance,
  headers: Record<string, string>
): Promise<ResolvedPrincipal> {
  const res = await app.inject({ method: 'GET', url: '/__principal', headers });
  expect(res.statusCode).toBe(200);
  return res.json() as ResolvedPrincipal;
}

describe('OVC_TRUST_ROLE_HEADER — production read site (src/main.ts:505-507)', () => {
  it('src/main.ts still reads the env var with a strict === "true" comparison', () => {
    const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    // Pins the mirror used by every test below. If the read site moves or gains
    // normalisation (e.g. `.toLowerCase()`), this fails and the mirror must be
    // re-verified against production rather than silently diverging.
    expect(mainSource).toContain(PRODUCTION_READ_SITE);
    // Exactly one READ of the env var in production code, so there is no second
    // site with different semantics (comment mentions are not counted).
    expect(mainSource.match(/process\.env\['OVC_TRUST_ROLE_HEADER'\]/g)).toHaveLength(1);
    // No case-folding / trimming on the value: only the exact string enables trust.
    expect(mainSource).not.toMatch(
      /process\.env\['OVC_TRUST_ROLE_HEADER'\]\s*(\?\.)?\s*\.?\s*(toLowerCase|toUpperCase|trim)/
    );
  });
});

describe('OVC_TRUST_ROLE_HEADER — trusted and untrusted behaviour (#1105 / #1092 AC2)', () => {
  const original = process.env[ENV_VAR];
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    delete process.env[ENV_VAR];
  });

  afterEach(async () => {
    if (original === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = original;
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('="true": X-OVC-Role: viewer on a WRITE route ⇒ 403 forbidden_insufficient_role', async () => {
    process.env[ENV_VAR] = 'true';
    app = await buildAppFromEnv();

    const res = await writeAs(app, asViewer());

    expect(res.statusCode).toBe(403);
    // Stable machine-readable code (src/auth/authorize.ts:99), plus the
    // observability fields of AuthorizationFailureBody (:105-111).
    expect(res.json()['error']).toBe(AUTHZ_FORBIDDEN_ERROR);
    expect(res.json()['role']).toBe('viewer');
    expect(res.json()['action']).toBe('write');
    expect(res.json()['resourceType']).toBe('asset');
  });

  it('="true": the header is honoured, not blanket-denied — viewer reads pass, editor writes pass', async () => {
    process.env[ENV_VAR] = 'true';
    app = await buildAppFromEnv();

    // Same trusted viewer header, read action ⇒ allowed (MATRIX.viewer.read).
    const read = await app.inject({ method: 'GET', url: WRITE_ROUTE, headers: asViewer() });
    expect(read.statusCode).not.toBe(403);

    // A trusted editor header ⇒ the write succeeds, so the 403 above is the role
    // decision and not an artefact of trusting the header at all.
    const write = await writeAs(app, { [ROLE_HEADER]: 'editor' }, 'editor-write');
    expect(write.statusCode).toBe(WRITE_OK_STATUS);

    // And the trusted header really is what was resolved.
    const principal = await principalOf(app, asViewer());
    expect(principal.role).toBe('viewer');
    expect(principal.source).toBe('header');
    expect(principal.rawHeaderValue).toBe('viewer');
  });

  it('unset: the same viewer request passes as admin — header ignored, behaviour unchanged', async () => {
    // env var absent (beforeEach deleted it) ⇒ untrusted.
    app = await buildAppFromEnv();
    expect(trustRoleHeaderFromEnv()).toBe(false);

    const res = await writeAs(app, asViewer(), 'unset-passes');
    expect(res.statusCode).toBe(WRITE_OK_STATUS);

    // Positive claim: the client-supplied header was STRIPPED at the trust
    // boundary and the caller resolved to the single-operator admin default
    // (src/auth/principal.ts:199-201 and :98-105).
    const principal = await principalOf(app, asViewer());
    expect(principal.role).toBe('admin');
    expect(principal.source).toBe('default');
    expect(principal.rawHeaderValue).toBeUndefined();
  });

  it('="false": the same viewer request passes as admin — header ignored', async () => {
    process.env[ENV_VAR] = 'false';
    app = await buildAppFromEnv();

    const res = await writeAs(app, asViewer(), 'false-passes');
    expect(res.statusCode).toBe(WRITE_OK_STATUS);

    const principal = await principalOf(app, asViewer());
    expect(principal.role).toBe('admin');
    expect(principal.source).toBe('default');
  });

  it('="true" is the ONLY value that enables trust (strict equality, no case-folding/trimming)', async () => {
    // Values an operator might plausibly set on the proposed catalog option
    // (#1092) that must all fail SAFE: untrusted ⇒ header stripped ⇒ admin.
    const untrustedValues = [
      'TRUE',
      'True',
      'tRuE',
      ' true',
      'true ',
      '\ttrue',
      '1',
      'yes',
      'on',
      'enabled',
      'false',
      'FALSE',
      '0',
      'no',
      'off',
      '',
      ' '
    ];

    for (const value of untrustedValues) {
      process.env[ENV_VAR] = value;
      expect(trustRoleHeaderFromEnv(), `value ${JSON.stringify(value)} must not trust`).toBe(
        false
      );

      const untrusted = await buildAppFromEnv();
      try {
        const res = await writeAs(untrusted, asViewer(), `value-${JSON.stringify(value)}`);
        expect(
          res.statusCode,
          `OVC_TRUST_ROLE_HEADER=${JSON.stringify(value)} must leave the header untrusted`
        ).toBe(WRITE_OK_STATUS);

        const principal = await principalOf(untrusted, asViewer());
        expect(principal.role).toBe('admin');
        expect(principal.source).toBe('default');
      } finally {
        await untrusted.close();
      }
    }

    // The one value that does enable trust, asserted through the same path so the
    // contrast is in a single test.
    process.env[ENV_VAR] = 'true';
    expect(trustRoleHeaderFromEnv()).toBe(true);
    const trusted = await buildAppFromEnv();
    try {
      const res = await writeAs(trusted, asViewer(), 'value-true');
      expect(res.statusCode).toBe(403);
      expect(res.json()['error']).toBe(AUTHZ_FORBIDDEN_ERROR);
    } finally {
      await trusted.close();
    }
  });
});
