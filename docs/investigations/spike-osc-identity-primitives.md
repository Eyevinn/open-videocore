# Spike — OSC group/role/identity primitives available to a downstream catalog service

Status: spike complete (research only; NO production code changed). Feeds the
authorisation ADR (#552) and resolves open question 1 of #525.

Issue: #551 — introspect OSC group/role primitives available to a downstream
catalog service such as open-videocore.

## Summary

**There is no per-request principal identity available to this service, and there
is no OSC platform primitive that supplies one.** The runtime auth layer is a pure
bearer-token presence gate that attaches a boolean and nothing else; it reads no
user id, group, role, or claim. At the platform level, the live OSC catalog exposes
no identity/IAM category and no primitive that injects caller identity into a
deployed service — groups/roles exist only as self-deployable IdP *services* (e.g.
Keycloak) that a downstream app would have to run and integrate itself. Any authz
model in #552 must therefore be designed against this absence, not against an
assumed platform-injected identity.

## 1. Is per-request principal identity available to this service at all? (verified from `src/auth`)

**No.** The auth layer is a pure presence gate. It extracts a bearer token from the
`Authorization` header, checks only that the token is *present and non-empty*, and
attaches a single boolean to the request. It does not decode the token, and it does
not surface any user id, group, role, tenant, workspace, or claim downstream.

Exact contract read from code:

- **What is read from the request:** only the `Authorization` header, matched
  against `Bearer <token>` — `src/auth/middleware.ts:20-25`:

  ```ts
  const header = request.headers['authorization'];
  if (typeof header !== 'string') { return undefined; }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
  ```

- **What is attached to the request:** a single boolean `authenticated`, and
  nothing else — `src/auth/middleware.ts:12-17` and `src/auth/middleware.ts:31,38`:

  ```ts
  interface FastifyRequest {
    // Set by the auth preHandler. True on every authenticated route.
    authenticated: boolean;
  }
  ```
  ```ts
  app.decorateRequest('authenticated', false);
  ...
  request.authenticated = await requireAuth(token);
  ```

- **How the token is evaluated:** presence only; the token is *intentionally not
  inspected for identity* — `src/auth/workspace.ts:33-42`:

  ```ts
  // Gate an inbound request: resolve to true when a bearer token is present ...
  // It is a pure presence gate — the token is intentionally not inspected for
  // identity, and nothing is scoped.
  export async function requireAuth(token: string | undefined): Promise<boolean> {
    if (!token || token.trim().length === 0) {
      throw new AuthError('missing access token');
    }
    return true;
  }
  ```

- **No per-request tenant/workspace either.** The module header states the auth wall
  is treated as a "PURE GATE" and that a prior `mysubscriptions` token→tenant
  resolution was **removed** because tenant isolation is *structural* (one deployed
  stack == one tenant), so there is nothing per-request to resolve —
  `src/auth/workspace.ts:3-17`. `DEPLOYMENT_CONTEXT = 'default'` is a fixed
  deployment-wide constant, explicitly "NOT a tenant/workspace identifier derived
  from the request" — `src/auth/workspace.ts:26-31`.

**Confirmed absence of a downstream principal contract:** the fields/headers/claims
available to a handler are limited to `request.authenticated: boolean`. There is no
user, group, role, tenant, or claim object anywhere in `src/auth`.

## 2. Platform-capability answer (OSC live catalog)

Source: OSC live catalog, 2026-09-04, 188 services / 8 categories.

- OSC has **no platform-level identity/IAM category.** The 8 catalog categories are
  `ai`, `app-backend`, `database`, `devel`, `media`, `office`, `other`, `storage` —
  none is identity/auth/iam.
- There is **no platform primitive that injects caller identity / group / role
  claims** into every deployed service at runtime. The platform auth wall is
  separate from (and does not constitute) a downstream identity contract.
- Identity/access exists **only as self-deployable catalog services** that a
  downstream app would have to integrate as its own IdP, notably:
  - `keycloak-keycloak` (Keycloak) — full IAM; provides groups/roles/claims via
    OIDC/SAML.
  - `supertokens-supertokens-core` (SuperTokens) — auth/session.
  - `eyevinn-openauth-pwd` (OpenAuth Password) — password auth.
  - `eyevinn-cat-validate` (Common Access Token Validator) — token validation.
  - `eyevinn-ephtoken-svc` (Ephemeral Token Service).
- **Implication:** OSC does not hand a downstream service a ready-made group/role
  principal. To obtain roles/groups the deployment must run its own IdP (e.g.
  Keycloak) and integrate it — a parallel identity store, which is exactly the cost
  that #525's "no user store" decision was trying to avoid.

## 3. Hard constraint for the authorisation model (#552)

**No OSC-provided group/role principal exists.** For #552, the authz model must be
built on one of two grounded options — and must NOT assume platform-injected
identity:

- **Option A — define roles against the existing gate.** Build authz on the current
  workspace/token presence gate (one deployed stack == one tenant; every
  authenticated caller is the same principal today). This keeps the "no user store"
  posture but yields only coarse, deployment-wide authorisation — there is no
  per-caller role/group to key off (`src/auth/workspace.ts:33-42`,
  `src/auth/middleware.ts:31,38`).
- **Option B — integrate a self-deployed IdP.** Deploy and integrate an IdP catalog
  service (e.g. `keycloak-keycloak`) to obtain OIDC groups/roles/claims, then have
  open-videocore validate and read those claims itself. This reintroduces a parallel
  identity store and the integration/operational cost that #525 sought to avoid.

There is no third "just read the platform-provided role" path — the platform does
not provide one (OSC live catalog, 2026-09-04).

## 4. The exact available contract (or its confirmed absence)

| Source | Available to downstream | Shape |
| ------ | ----------------------- | ----- |
| Runtime request (this service) | `request.authenticated` only | `boolean` — set true when a non-empty `Bearer` token is present (`src/auth/middleware.ts:12-17,31,38`; `src/auth/workspace.ts:33-42`). No user/group/role/claim. |
| `Authorization` header (raw) | The bearer token string, uninspected | Opaque string; never decoded for identity by this service (`src/auth/workspace.ts:35-37`). |
| OSC platform (runtime injection) | **None** | No platform primitive injects identity/group/role claims (OSC live catalog, 2026-09-04). |
| Self-deployed IdP (e.g. Keycloak) | Groups / roles / claims — **only if deployed and integrated by this app** | OIDC/SAML claims; requires running `keycloak-keycloak` and validating claims in-app. Not present today. |

**Confirmed absence:** as shipped, this service has NO downstream principal-identity
contract beyond a presence boolean.

## Note on ADR-003 (discrepancy with the issue's paraphrase — verified, not trusted)

The issue asked me to cross-check `docs/architecture/ADR-003-*.md` for what it says
about "delegating auth to the OSC auth wall" and flagging identity as an open
capability question. **Verified against the actual file, the issue's paraphrase does
NOT match.**

- In THIS repo the only ADR-003 is
  `docs/architecture/ADR-003-delivery-and-stream-url-contract.md`
  (title line `ADR-003-delivery-and-stream-url-contract.md:1`,
  Status ACCEPTED 2026-09-03, issue #509). Its entire scope is the delivery/stream
  URL contract (`GET /api/v1/assets/:id/delivery` + `/stream/*`). It says **nothing**
  about the auth wall, about delegating authentication, about identity, or about an
  open capability question on identity/roles. (Confirmed by full read and a scoped
  grep for `auth|identity|principal` over the file — no such content.)
- The auth-wall delegation the issue attributes to "ADR-003" is actually documented
  in **ADR-001**: open question 2 "Authentication model for v1" is RESOLVED as
  "Gated behind OSC login-wall … No additional API key layer needed for v1"
  (`docs/architecture/ADR-001-osc-stack.md:144`). ADR-001 also lists a *planned*
  "ADR-002: API authentication and multi-tenancy model"
  (`docs/architecture/ADR-001-osc-stack.md:170`) which was never written.
- Separately, the `src/auth/*.ts` and `src/data/*.ts` comments cite "ADR-003" as the
  source for *structural tenant isolation / workspace-guard removal*
  (`src/auth/workspace.ts:3,14,27`; `src/auth/middleware.ts:4`;
  `src/data/couchdb.ts:3`; and ~10 more). That concept is NOT in the on-disk
  ADR-003 (which is about delivery). So the code's "ADR-003" citation refers to an
  auth/tenancy decision that the current ADR-003 file does not actually document —
  a documentation gap #552 should resolve (either write the auth/tenancy ADR, or fix
  the stale citations).

Net: neither ADR-003 nor any accepted ADR flags identity/roles as an open capability
question in the words the issue used; the substantive auth decision lives in
ADR-001 open question 2, and the "no downstream identity" fact is a code + platform
finding, established above.

## Recommendation for #552

Design authz explicitly against the confirmed absence: there is no OSC-provided
group/role principal and no per-request identity in this service today. Choose
Option A (coarse, deployment-wide roles on the existing gate — preserves "no user
store") or Option B (self-deployed IdP integration — reintroduces a parallel store).
Whichever is chosen, #552 should also either author the missing auth/tenancy ADR or
correct the stale "ADR-003" citations in `src/auth` and `src/data`.

## Evidence index

- `src/auth/middleware.ts:12-17` — `request.authenticated: boolean` is the only
  decorated field.
- `src/auth/middleware.ts:20-25` — token extraction reads only the `Authorization`
  `Bearer` header.
- `src/auth/middleware.ts:31,38` — decorates `authenticated=false`, sets it from
  `requireAuth`.
- `src/auth/workspace.ts:3-17` — auth wall treated as a PURE GATE; `mysubscriptions`
  token→tenant resolution removed; structural tenant isolation.
- `src/auth/workspace.ts:26-31` — `DEPLOYMENT_CONTEXT='default'`, explicitly not a
  request-derived tenant identifier.
- `src/auth/workspace.ts:33-42` — presence-only gate; token intentionally not
  inspected for identity.
- `docs/architecture/ADR-001-osc-stack.md:144,170` — auth model resolved to OSC
  login-wall; planned (unwritten) ADR-002 for auth/multi-tenancy.
- `docs/architecture/ADR-003-delivery-and-stream-url-contract.md:1-343` — scope is
  delivery/stream URLs; contains no auth/identity/open-capability content.
- OSC live catalog, 2026-09-04, 188 services / 8 categories — no identity/IAM
  category; no runtime identity-injection primitive; identity only via
  self-deployable services (`keycloak-keycloak`, `supertokens-supertokens-core`,
  `eyevinn-openauth-pwd`, `eyevinn-cat-validate`, `eyevinn-ephtoken-svc`).
</content>
