# ADR-018: Authorisation model — roles + per-asset / per-collection permissions on a deployment that has no downstream identity

**Status:** PROPOSED 2026-09-04
**Date:** 2026-09-04
**Author agent:** claude-opus-4-8 (surface-backend-api)
**Issue:** #552 (authorisation ADR — roles + per-asset/per-collection permission model)
**Builds on:** #551 spike (`docs/investigations/spike-osc-identity-primitives.md`, on branch `issue-551/spike-osc-identity-primitives`)
**Supersedes the placeholder:** ADR-001's planned-but-never-written "ADR-002: API authentication and multi-tenancy model" (`docs/architecture/ADR-001-osc-stack.md:170`)

---

## Context

open-videocore needs an authorisation model — roles and per-resource
(read/write/delete) permissions on assets and collections — for the Media
Developer persona. Issue #552 asks us to decide role-based vs capability/ACL,
where the principal comes from, where enforcement sits, how per-resource grants
interact with tenant isolation, and the collection→asset cascade semantics
(#525 open questions 2 and 4).

This ADR is **authorisation only**. It does not add an authentication stack:
ADR-001 resolved authentication for v1 to "Gated behind OSC login-wall …
No additional API key layer needed for v1"
(`docs/architecture/ADR-001-osc-stack.md:144`). That delegation stands.

### The hard constraint (verified by the #551 spike)

The #551 spike established, from code and from the live OSC catalog, that
**there is no per-request principal identity available to this service, and no
OSC platform primitive that supplies one**:

- The runtime auth layer is a **pure presence gate**. It extracts the bearer
  token, checks only that it is present and non-empty, and attaches a single
  boolean `request.authenticated` — nothing else. It never decodes the token for
  a user id, group, role, tenant, or claim
  (`src/auth/middleware.ts:12-17` decorates only `authenticated: boolean`;
  `src/auth/middleware.ts:20-25` reads only the `Authorization: Bearer` header;
  `src/auth/middleware.ts:31,38` sets the boolean from `requireAuth`;
  `src/auth/workspace.ts:33-42` is presence-only, "the token is intentionally
  not inspected for identity, and nothing is scoped").
- OSC exposes **no platform-level identity/IAM primitive** that injects caller
  identity/group/role claims into a deployed service at runtime. Identity exists
  only as self-deployable catalog *services* (e.g. `keycloak-keycloak`,
  `supertokens-supertokens-core`, `eyevinn-openauth-pwd`) that a downstream app
  would have to run and integrate itself (OSC live catalog, 2026-09-04;
  spike §2).

### Correction to the issue's ADR paraphrase (verified, not trusted)

The issue and older code comments attribute the auth/tenancy decision to
"ADR-003". That is wrong. `docs/architecture/ADR-003-delivery-and-stream-url-contract.md`
is scoped entirely to the delivery/stream-URL contract and says nothing about
authentication, identity, or roles (`ADR-003-delivery-and-stream-url-contract.md:1`,
Status ACCEPTED 2026-09-03). The substantive authentication decision lives in
**ADR-001 open question 2** (`docs/architecture/ADR-001-osc-stack.md:144`). The
`src/auth/*` and `src/data/*` comments that cite "ADR-003" for structural tenant
isolation (e.g. `src/auth/workspace.ts:3`, `src/data/guard.ts:2`) refer to a
decision the on-disk ADR-003 does not actually document — a documentation gap.
**This ADR is the missing auth/tenancy ADR; it is the authoritative cross-ref
for authorisation. Correcting the stale `src/auth`/`src/data` "ADR-003"
citations is left to the enforcement sub-issue (#553/#554), which touches those
files anyway.**

---

## Decision

### 1. Role-based, with the role carried in a trusted request header — NOT capability/ACL, and NOT an in-app user store

We adopt a **fixed role model** (`viewer` / `editor` / `admin`) rather than a
per-resource capability/ACL grant system.

Rationale:

- **No in-app user store (#525 open question 2).** A per-resource ACL grant
  system requires a durable subject→grant table keyed by a stable principal id.
  We have no principal id: the service sees only `request.authenticated: boolean`
  (`src/auth/middleware.ts:12-17`). Building ACLs would force us to invent and
  persist a principal identity — exactly the parallel user store #525 rejected.
  A small fixed set of roles has no such requirement.
- **Media Developer persona.** The persona is a developer integrating against a
  single deployment they operate; they need coarse read-only vs read-write vs
  admin separation (e.g. a read-only API token for a downstream dashboard), not
  fine-grained sharing between many named end-users.

**Where the principal/role comes from — stated honestly given the spike.**
There is *no* downstream identity today, so the role cannot come from the OSC
platform or from the bearer token as decoded by this service. The role is
supplied by whatever authenticates the request in front of the app, via a
**trusted request header** (see decision 5). Concretely:

- On OSC today, every authenticated caller is the *same* deployment-wide
  principal (the OSC login-wall gate; `src/auth/workspace.ts:33-42`). With no
  header present, the effective role defaults to `admin` for that single
  operator principal — this preserves today's "authenticated ⇒ full access"
  behaviour and is a no-op migration.
- To get *distinct* per-caller roles, the operator fronts open-videocore with a
  trusted proxy or a self-deployed IdP (Option B in the spike, e.g.
  `keycloak-keycloak`) that maps an authenticated caller to a role and injects
  it as the trusted header. open-videocore never runs the IdP itself; it only
  trusts the header on the already-gated request path.

This keeps the "no user store" posture: open-videocore stores no users, no
passwords, and no per-subject grant rows. It reads a role off the request and
maps `{role} × {action}` to allow/deny from a static table.

Static permission matrix (assets and collections):

| Role     | read | write (create/update) | delete |
| -------- | :--: | :-------------------: | :----: |
| viewer   |  ✓   |           ✗           |   ✗    |
| editor   |  ✓   |           ✓           |   ✓    |
| admin    |  ✓   |           ✓           |   ✓    |

`admin` additionally covers infrastructure/management routes that are out of
this ADR's asset/collection scope. `viewer`/`editor` differ only by write; the
matrix is intentionally tiny so it needs no persistence.

### 2. Per-resource permission-check surface and where enforcement sits in the request path

The check is `authorize(role, action, resourceType)` where `action ∈
{read, write, delete}` and `resourceType ∈ {asset, collection}`. It is a pure
lookup against the decision-1 matrix — no I/O, no store.

**Enforcement seam (cited for the enforcement sub-issue #553/#554).** There are
two seams in the current request path; the enforcement issue should use both:

1. **Coarse method→action gate at the router-registration layer**, mirroring the
   existing global `preHandler` that already runs on every request
   (`src/main.ts:317`). A per-route `preHandler` on the assets and collections
   routers derives `action` from the HTTP method (`GET`→read, `POST`/`PUT`/
   `PATCH`→write, `DELETE`→delete) and calls `authorize(role, action,
   resourceType)`, returning 403 before the handler runs. The router option
   objects already exist to hang this off
   (`src/routes/assets.ts` — router `app.get/post/put/patch/delete` registrations
   starting at `src/routes/assets.ts:1650`; `src/routes/collections.ts:78-187`).
   Each route option block already carries an (empty) options slot where a
   `preHandler` attaches (e.g. `src/routes/collections.ts:80-83`).

2. **Fine-grained resource-scoped hook** at the existing ownership seam
   `assertOwned` in `src/data/guard.ts:26-32`. That function is *deliberately
   empty today* ("Intentionally empty: structural isolation means there is
   nothing to guard") and is the natural home if a future per-resource grant is
   ever added. It is called on the resource *after* it is loaded (handlers load
   the resource with `repo.get(request.params.id)`, e.g.
   `src/routes/assets.ts:3514`, `src/routes/collections.ts:112`). For decision 1
   (fixed roles, no per-resource grants) this hook stays a no-op; we name it so a
   later ACL evolution has a single, already-wired insertion point rather than
   scattering checks across ~40 handlers.

The role itself is read once, near the existing global `preHandler`
(`src/main.ts:317`), and decorated onto the request (alongside the existing
`request.authenticated`, `src/auth/middleware.ts:12-17`) so both seams read the
same value.

### 3. Interaction with structural per-deployment tenant isolation

Tenant isolation is **structural and orthogonal** to roles, and this ADR does
not change it. One deployed stack == one tenant's workspace: OSC provisions a
separate set of backing resources (CouchDB, PostgreSQL, MinIO, Encore) per
deploying tenant, so a deployed instance *is* the tenant's workspace and there is
no shared backing store to scope across
(`src/auth/workspace.ts:3-17`; `src/data/guard.ts:1-7` — "There is therefore NO
in-app workspace scoping"; `assertOwned` is empty at `src/data/guard.ts:26-32`).

Consequence: roles are **within-tenant** only. A role authorises *actions on the
one workspace's resources*; there is no cross-tenant grant, because there is no
cross-tenant surface. `DEPLOYMENT_CONTEXT = 'default'`
(`src/auth/workspace.ts:26-31`) remains a fixed deployment-wide constant, not a
request-derived identifier, and is unaffected. Roles therefore layer *on top of*
structural isolation: isolation answers "which workspace" (always this one);
roles answer "which action within it".

### 4. Cascade semantics collection → member assets: **AUTHORITATIVE at the role level, no independent per-asset grant** (#525 open question 4)

Because decision 1 uses fixed **workspace-wide roles** and no per-resource
grants, there is nothing to cascade between a collection and its member assets:
a caller's role applies uniformly to every asset and every collection in the
workspace. We therefore choose the **authoritative** interpretation and state it
plainly:

- A collection confers **no** additional or reduced permission on its member
  assets. Membership is an organisational grouping only
  (`src/routes/collections.ts:2-8` — "a lightweight way to organise assets …
  without changing the assets themselves"). Adding an asset to a collection does
  not widen or narrow who can read/write/delete that asset.
- Access to an asset *through* a collection (e.g. the resolved-asset list on
  `GET /collections/:id`, `src/routes/collections.ts:112-121`) is authorised by
  the same `read` action as accessing the asset directly. There is no "the
  collection granted me access" path.

We reject **additive** and **per-asset override-able** cascade because both
require per-resource grants, which require a principal-keyed grant store, which
reintroduces the user store #525 forbids and the spike shows we cannot populate
(no downstream principal). #527 and its rights-cascade follow-on are hereby
unblocked with this authoritative-no-cascade decision: rights on a collection do
not flow to member assets; each resource is authorised independently against the
caller's workspace role.

If a future ADR reverses decision 1 to introduce ACLs, cascade must be revisited
— but that is explicitly deferred and gated on first acquiring a downstream
principal identity (spike Option B).

### 5. Minimal off-OSC contract — a single trusted role header

So the model degrades sensibly off-platform and stays OSC-neutral, the principal
role is carried by **one trusted request header**:

- `X-OVC-Role: viewer | editor | admin`

Contract:

- The header is **only trusted when set by the fronting auth layer** (the OSC
  login-wall, a reverse proxy, or a self-deployed IdP integration) on a request
  that has already passed the presence gate (`src/auth/workspace.ts:33-42`).
  The enforcement issue MUST strip any client-supplied `X-OVC-Role` at the trust
  boundary before re-injecting the authenticated value, exactly as the app
  already trusts the upstream gate for authentication
  (`src/main.ts:315-316` — "Auth is handled by the OSC SAT gate upstream; the
  app trusts every request that reaches it").
- **Absent header ⇒ `admin`** (single-operator default), preserving today's
  authenticated-⇒-full-access behaviour so this ADR's enforcement is a no-op for
  existing OSC deployments until an operator opts into distinct roles.
- **Unrecognised value ⇒ 403** (fail closed), never silently downgraded to a
  weaker-but-nonzero role.

This is deliberately not OSC-proprietary: it is a plain HTTP header, mirroring
the existing `X-Stack-Name` trusted-header pattern the app already relies on
(`src/main.ts:318`). On OSC the login-wall + optional self-deployed IdP populate
it; off OSC any equivalent proxy can. open-videocore reads roles the same way in
both environments and needs no OSC-specific identity API.

---

## Consequences

**Positive:**

- No in-app user store, no per-subject grant table, no persistence added — the
  role is read off the request and matched against a static matrix (#525 open
  question 2 satisfied).
- Enforcement has two named, already-wired seams (`src/main.ts:317` router-layer
  gate; `src/data/guard.ts:26-32` resource-layer hook) so the enforcement issue
  implements against a concrete contract, not a redesign.
- The collection→asset cascade question (#525 q4, #527) is closed with a single
  justified answer (authoritative / no cascade), unblocking the rights-cascade
  follow-on.
- Degrades cleanly on and off OSC via one plain header; no OSC-proprietary
  identity dependency.
- Backwards compatible: absent header ⇒ admin ⇒ identical to today's behaviour.

**Negative / risks:**

- Roles are workspace-wide and coarse. Fine-grained per-end-user sharing is not
  possible without a future ADR that first acquires a downstream principal
  (spike Option B, self-deployed IdP). This is an accepted limitation for v1.
- The `X-OVC-Role` header is only as trustworthy as the fronting layer. A
  deployment that exposes open-videocore without a role-stripping trust boundary
  could be spoofed. The enforcement issue MUST strip/re-inject the header at the
  boundary (decision 5).
- Distinct roles require operator effort (proxy or IdP integration) that OSC does
  not provide out of the box — a direct consequence of the confirmed absence of
  an OSC identity primitive (spike §2/§3). Logged as OSC friction.

**Follow-up:**

- Enforcement implementation is out of scope here — sub-issues #553/#554. Those
  issues should also correct the stale "ADR-003" auth/tenancy citations in
  `src/auth/*` and `src/data/*` to point at this ADR-018.
