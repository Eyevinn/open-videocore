// Principal identity + role resolution (ADR-018, issue #553).
//
// This is the RESOLUTION half of the authorisation model (ADR-018, issue #552):
// read the caller's role off a single trusted request header and attach a
// principal descriptor to the request. It performs NO enforcement — it never
// returns 403, never gates a route, and does not change any endpoint's
// behaviour. Enforcement (the fail-closed 403 on an unrecognised role, header
// stripping at the trust boundary, and the authorize() matrix) is deferred to
// issue #554 (ADR-018 decisions 2 and 5).
//
// Identity is stated honestly per the #551 spike and ADR-018: OSC provides no
// downstream per-request principal identity, so every authenticated caller is
// the same deployment-wide operator principal (`src/auth/workspace.ts:33-42`).
// We therefore do NOT fabricate a user id or store. The descriptor names that
// single operator principal and carries the resolved role so #529's audit log
// can consume a real principal shape instead of a coarse user/system/ai enum.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Role header + defaulting rules: ADR-018 decisions 1 & 5
//     (branch issue-552/authorisation-adr,
//     docs/architecture/ADR-018-authorisation-model.md).
//   - Request-decoration pattern mirrored: src/auth/middleware.ts:12-17.
//   - preHandler seam mirrored: src/main.ts:316-329 (x-stack-name resolution).
//   - Single-operator principal / presence-only gate: src/auth/workspace.ts:33-42.

import type { FastifyInstance, FastifyRequest } from 'fastify';

// The three roles ADR-018 decision 1 defines. Within-tenant only (decision 3);
// this slice does not touch tenant/workspace logic — DEPLOYMENT_CONTEXT stays
// 'default'.
export type PrincipalRole = 'viewer' | 'editor' | 'admin';

// The one trusted header ADR-018 decision 5 carries the role in. Fastify
// lowercases header keys, so we read the lowercased form off request.headers
// (mirroring the existing `x-stack-name` trusted-header read at src/main.ts:318).
export const ROLE_HEADER = 'x-ovc-role';

// How the role was arrived at, kept for observability (this slice populates and
// observes only; #554 will act on `unrecognised`).
//   - 'default'      : header absent ⇒ admin (single-operator default, ADR-018
//                      decision 5; preserves today's authenticated-⇒-full-access).
//   - 'header'       : header present and a recognised role.
//   - 'unrecognised' : header present but not one of the three roles. ADR-018
//                      decision 5 says this MUST become a 403 (fail closed) —
//                      but that is ENFORCEMENT, deferred to #554. Here we resolve
//                      to a null role WITHOUT throwing so the value is observable
//                      and no existing behaviour changes; #554 applies the 403.
export type RoleResolutionSource = 'default' | 'header' | 'unrecognised';

// The single deployment-wide operator principal (ADR-018 decision 1 / #551
// spike): there is no downstream identity, so this is a fixed descriptor, not a
// user record. `kind` distinguishes it from future principal kinds a later ADR
// (with a real downstream identity) might introduce, and gives #529's audit log
// an honest, non-fabricated subject to record.
export interface OperatorPrincipal {
  kind: 'operator';
}

// The single operator principal instance. Frozen so no caller can mutate the
// shared descriptor attached to every request.
export const OPERATOR_PRINCIPAL: OperatorPrincipal = Object.freeze({ kind: 'operator' });

// Structured result of resolving the role header. Pure data — no I/O — so it is
// unit-testable in isolation from Fastify.
export interface ResolvedPrincipal {
  // The single deployment-wide operator principal (see OperatorPrincipal).
  principal: OperatorPrincipal;
  // The resolved role. `null` ONLY for an unrecognised header value, which this
  // slice surfaces as an observable sentinel rather than enforcing. #554 turns a
  // null role into a fail-closed 403 (ADR-018 decision 5).
  role: PrincipalRole | null;
  // How `role` was arrived at (observability). See RoleResolutionSource.
  source: RoleResolutionSource;
  // The raw header value exactly as received, retained for observability so #554
  // (and audit logging, #529) can report what the caller supplied. `undefined`
  // when the header was absent.
  rawHeaderValue: string | string[] | undefined;
}

const KNOWN_ROLES: ReadonlySet<string> = new Set<PrincipalRole>(['viewer', 'editor', 'admin']);

// Pure resolver for the caller's role, per ADR-018 decisions 1 & 5.
//
// No I/O, no throwing, no enforcement — it maps a raw header value to a
// structured, observable result:
//   - absent (undefined / empty) ⇒ role 'admin', source 'default'.
//   - a recognised role string   ⇒ that role, source 'header'.
//   - anything else              ⇒ role null, source 'unrecognised'
//                                  (observable sentinel; #554 will 403 on it).
//
// Fastify types a header as `string | string[] | undefined` (a repeated header
// yields an array), so we accept exactly that. A repeated header is treated as
// unrecognised: the trusted fronting layer sets a single value, so multiple
// values are an anomaly we surface rather than pick from.
export function resolvePrincipalRole(rawHeaderValue: string | string[] | undefined): ResolvedPrincipal {
  // Absent header ⇒ single-operator default of admin (ADR-018 decision 5).
  // An empty / whitespace-only string is treated as absent.
  if (rawHeaderValue === undefined || (typeof rawHeaderValue === 'string' && rawHeaderValue.trim().length === 0)) {
    return {
      principal: OPERATOR_PRINCIPAL,
      role: 'admin',
      source: 'default',
      rawHeaderValue
    };
  }

  // A repeated header (array) is not a single trusted value — surface as
  // unrecognised (observable, non-throwing) for #554 to fail closed on.
  if (typeof rawHeaderValue !== 'string') {
    return {
      principal: OPERATOR_PRINCIPAL,
      role: null,
      source: 'unrecognised',
      rawHeaderValue
    };
  }

  const normalised = rawHeaderValue.trim().toLowerCase();
  if (KNOWN_ROLES.has(normalised)) {
    return {
      principal: OPERATOR_PRINCIPAL,
      role: normalised as PrincipalRole,
      source: 'header',
      rawHeaderValue
    };
  }

  // Present but not a recognised role. ADR-018 decision 5 mandates a fail-closed
  // 403 here — deferred to #554. This slice resolves to a null role WITHOUT
  // throwing so the value stays observable and no endpoint behaviour changes.
  return {
    principal: OPERATOR_PRINCIPAL,
    role: null,
    source: 'unrecognised',
    rawHeaderValue
  };
}

// Decorate FastifyRequest with the resolved principal, mirroring the
// `authenticated: boolean` augmentation at src/auth/middleware.ts:12-17.
declare module 'fastify' {
  interface FastifyRequest {
    // Set by the principal preHandler on every request. Carries the single
    // operator principal + resolved role + observability metadata (ADR-018,
    // issue #553). Populated and observable only — NOT enforced here (#554).
    principal: ResolvedPrincipal;
  }
}

// Register the request decoration + a preHandler that resolves the role header
// once per request and attaches it, alongside the existing `request.authenticated`
// (src/auth/middleware.ts) and `request.connections` (src/main.ts:316). This
// performs NO enforcement: it never returns 403 and never gates a route
// (deferred to #554, ADR-018 decision 5). Call once at app setup.
export function registerPrincipal(app: FastifyInstance): void {
  // Default decoration so a request always carries a valid principal even before
  // the preHandler runs (e.g. onRequest-stage errors), mirroring the safe default
  // `authenticated: false` at src/auth/middleware.ts:31. The default is the
  // absent-header resolution (single-operator admin, ADR-018 decision 5), kept as
  // a non-null value so the request field type has no null case for callers.
  app.decorateRequest<ResolvedPrincipal>('principal', resolvePrincipalRole(undefined));

  app.addHook('preHandler', async (request: FastifyRequest) => {
    // Fastify lowercases header keys; read the lowercased ROLE_HEADER exactly as
    // the existing x-stack-name read does (src/main.ts:318). Observability only —
    // no enforcement, so no reply is ever sent here.
    request.principal = resolvePrincipalRole(request.headers[ROLE_HEADER]);
  });
}
