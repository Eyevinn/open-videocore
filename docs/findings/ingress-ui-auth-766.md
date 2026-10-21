# Finding: ingress browser-authentication mechanism for `/ui` (issue #766)

**Status of the core question: UNCONFIRMED from the repository alone.**
**Scope: investigation / documentation only — no production code changes.**
Related: #734, #711. Verified against branch `issue-766/ingress-auth-finding`,
based on `origin/main`.

---

## Question

How does the deployment's fronting / ingress layer authenticate a *browser
session* when serving `/ui`? Is it a session cookie or another mechanism, and
what is the exact signal (cookie/header name, verifiability, spoof-resistance)?
Compare against the in-app `OVC_TRUST_ROLE_HEADER` trust-header pattern and how
`authGate()` consumes headers, to unblock design of any opt-in trust option.

---

## What the code actually shows

### 1. How `/ui` is served today

`/ui` is a **static file mount**, not an authenticated route:

- `src/main.ts:2134-2138` — `app.register(fastifyStatic, { root: <…>/public,
  prefix: '/ui/', decorateReply: false })`. The `@fastify/static` import is at
  `src/main.ts:4`.
- `src/main.ts:2139` — `app.get('/ui', async (_req, reply) =>
  reply.redirect('/ui/index.html'))`.

Critically, **this registration attaches no auth pre-handler**. It does not call
`app.authenticate` (`src/auth/middleware.ts:37-55`) nor the plugin-scoped
`authGate(app)` presence gate (`src/auth/middleware.ts:76-87`). Those gates are
attached by the workspace-scoped API routers, not by the static `/ui/` mount. So
the application process itself performs **no bearer-token check on `/ui` or its
assets** — a request that reaches the process is served the static files
regardless of any `Authorization` header.

### 2. The in-app authentication the process *does* perform (for the API)

For API routes, the app performs a **bearer-token presence gate only**, not
session/cookie auth:

- `src/auth/middleware.ts:23-30` — `extractToken()` reads *only* the
  `authorization` header and matches `^Bearer\s+(.+)$`. There is **no cookie
  read anywhere in this path.**
- `src/auth/middleware.ts:34-55` — `registerAuth()` decorates `authenticate`,
  which on failure replies `401` with `WWW-Authenticate: Bearer`.
- `src/auth/workspace.ts:52-57` — `requireAuth()` is a **pure presence gate**:
  it passes *any* non-empty bearer string without inspecting identity, validity,
  or authorisation. Its own header comment
  (`src/auth/workspace.ts:22-32`) states it "provides NO protection against a
  missing, bypassed, or misconfigured auth wall" and that "the sole security
  boundary for inbound authentication is the OSC auth wall (or, off-OSC, an
  equivalent upstream proxy)".
- `src/auth/middleware.ts:76-87` — `authGate(app)` returns a `presenceGate`
  pre-handler that resolves `app.authenticate` **lazily** and no-ops when the
  `authenticate` decoration is absent; it "only calls the pure presence gate
  `requireAuth` via `app.authenticate`" and never reintroduces per-request
  workspace scoping. So `authGate` consumes exactly one signal: the `Bearer`
  token in the `Authorization` header.

The design intent that real authentication is upstream is stated inline:
`src/main.ts:416-417` — "Auth is handled by the OSC SAT gate upstream; the app
trusts every request that reaches it." (SAT = the OSC subscription/service
access token gate.)

### 3. The `OVC_TRUST_ROLE_HEADER` trust-header pattern (the comparison baseline)

- `src/main.ts:442-448` — `registerPrincipal(app, { trustRoleHeader:
  process.env['OVC_TRUST_ROLE_HEADER'] === 'true' })`. The surrounding comment
  (`src/main.ts:433-445`) names this the **trust boundary**: unless the
  deployment opts in, any client-supplied `X-OVC-Role` is stripped so it can
  never be spoofed downstream; absent/false ⇒ admin default ⇒ backwards
  compatible with today's authenticated-⇒-full-access behaviour.
- `src/auth/principal.ts:36` — `ROLE_HEADER = 'x-ovc-role'` (Fastify lowercases
  header keys).
- `src/auth/principal.ts:150-172` — `PrincipalOptions.trustRoleHeader` doc: the
  header is "only trusted when set by the fronting auth layer" and any
  client-supplied value must be stripped at the trust boundary "exactly as the
  app already trusts the upstream gate for authentication".
- `src/auth/principal.ts:193-206` — the `onRequest` hook is that boundary: when
  `trustRoleHeader` is false it `delete request.headers[ROLE_HEADER]` and then
  resolves via `resolvePrincipalRole()` (`src/auth/principal.ts:95-137`), which
  maps absent ⇒ `admin`/`default`, a known role ⇒ `header`, anything else ⇒
  `null`/`unrecognised`.
- This deliberately mirrors the existing trusted `X-Stack-Name` read at
  `src/main.ts:420` (`request.headers['x-stack-name']`).

**Key property of this pattern:** the app never *verifies* the trust-header
value cryptographically. Trust is binary and configuration-driven
(`OVC_TRUST_ROLE_HEADER`): either the fronting layer is declared trustworthy (so
the header is honoured) or it is not (so the header is stripped). Spoof-resistance
lives entirely in the fronting layer + the strip-at-boundary rule, **not** in any
signature the app checks.

---

## Why the browser-auth mechanism is UNCONFIRMED

The question asks for the *ingress* browser-session signal (cookie vs header,
its name, verifiability, spoof-resistance). **That cannot be determined from this
repository**, because:

1. **The ingress / login-wall configuration is not in this repo.** The code and
   ADRs repeatedly locate browser/session authentication *upstream* of the
   process (`src/auth/workspace.ts:22-32`, `src/main.ts:416-417`, README
   `README.md:53-73`, `docs/architecture/ADR-018-authorisation-model.md:213-231`).
   The app is explicitly designed to trust "every request that reaches it" and to
   hold no session/cookie logic of its own.
2. **The app reads no cookie and no session anywhere.** The only inbound auth
   signals the process consumes are the `Authorization: Bearer` header
   (`src/auth/middleware.ts:23-30`) and the trusted `X-OVC-Role` / `X-Stack-Name`
   headers (`src/auth/principal.ts:36`, `src/main.ts:420`). There is no cookie
   parser, no session store, and no browser-login redirect in the codebase.
3. **`/ui` in particular has no app-level gate at all** (`src/main.ts:2134-2139`).
   Whatever authenticates a browser hitting `/ui` therefore lives *entirely* in
   the fronting layer, whose config is out of this repo's tree.

The repo's own comments name the upstream gate as "the OSC login-wall" / "OSC SAT
gate" and, off-OSC, "an equivalent authenticating reverse proxy" (README
`README.md:60-73`; ADR-018 `docs/architecture/ADR-018-authorisation-model.md:213-231`),
but **none of these documents specify the browser-facing signal** — i.e. whether
the login-wall establishes a session cookie, what that cookie/header is named,
whether it is signed/JWT/opaque, or how a downstream service could verify it. That
detail is a property of the OSC platform ingress, which this repository does not
contain and this session cannot introspect.

---

## Comparison summary

| Aspect | In-app bearer gate (`authGate`) | `OVC_TRUST_ROLE_HEADER` pattern | Ingress `/ui` browser auth |
|---|---|---|---|
| Signal | `Authorization: Bearer <token>` | `X-OVC-Role` header | **UNKNOWN** (cookie? header? not in repo) |
| Where read | `src/auth/middleware.ts:23-30` | `src/auth/principal.ts:36,205` | Upstream ingress (not in repo) |
| Verified by app? | No — presence only (`workspace.ts:52-57`) | No — trust is config-gated, value stripped unless opted in | **Cannot tell — config absent** |
| Spoof-resistance | Relies on upstream wall | Strip-at-boundary + trusted fronting layer | **UNCONFIRMED** |
| Applies to `/ui`? | No (static mount has no gate) | Resolved per-request but not enforced on `/ui` | This is exactly the open question |

The `/ui` path is authenticated by the *same* assumed-upstream mechanism as the
API (the app trusts every request that reaches it), but with *even less* in-app
checking than the API routes, because the static mount attaches no presence gate.

---

## What a follow-up would need to verify it

To confirm (rather than assume) the `/ui` browser-auth mechanism, a follow-up
must inspect artefacts **outside this repository**:

1. **The OSC ingress / login-wall configuration** for a deployed instance — the
   reverse-proxy or platform ingress that fronts the container. Capture the
   response of an unauthenticated browser GET to `/ui`: is it a `302` to a login
   endpoint, a `401`, and what `Set-Cookie` / auth headers appear on a
   successful authenticated request?
2. **The exact signal name and shape** — cookie name vs header name; opaque vs
   signed/JWT; issuer; and whether a downstream service can *verify* it (public
   key / introspection endpoint) or must simply trust the proxy stripped/injected
   it. This is the datum needed to decide whether an opt-in trust option can
   verify the signal or must remain trust-by-configuration like
   `OVC_TRUST_ROLE_HEADER`.
3. **The off-OSC contract** — the equivalent reverse proxy expectation
   (`README.md:64-66`) so the opt-in trust option is not OSC-proprietary,
   consistent with ADR-018 decision 5's "plain HTTP header" goal
   (`docs/architecture/ADR-018-authorisation-model.md:227-231`).
4. **Terraform / deploy config** — the `terraform/` directory in the product repo
   defines OSC provisioning but was not confirmed in this session to carry
   ingress auth config; a follow-up should confirm whether the ingress signal is
   declared there or is a platform default outside any repo.

Until items 1-2 are answered with a captured live response, the mechanism stays
**UNCONFIRMED**, and any opt-in trust option must be designed defensively:
strip-at-boundary + config-gated trust (mirroring `OVC_TRUST_ROLE_HEADER`),
*not* verification of an assumed cookie whose shape is unknown.

---

## Contract sources cited (contract-first, CLAUDE.md rule 7)

All symbols below were read directly in this session:

- `src/main.ts:4` — `@fastify/static` import.
- `src/main.ts:2134-2139` — `/ui/` static mount + `/ui` redirect (no auth gate).
- `src/main.ts:416-417,420` — upstream-trust comment + `x-stack-name` read.
- `src/main.ts:442-448` — `registerPrincipal` wiring `OVC_TRUST_ROLE_HEADER`.
- `src/auth/middleware.ts:23-30` — `extractToken` (Authorization/Bearer only).
- `src/auth/middleware.ts:34-55` — `registerAuth` / `authenticate` (401).
- `src/auth/middleware.ts:76-87` — `authGate` presence gate.
- `src/auth/workspace.ts:22-32,52-57` — presence-gate security boundary + `requireAuth`.
- `src/auth/principal.ts:36,95-137,150-172,193-206` — `ROLE_HEADER`, resolver,
  trust-boundary options, and the strip-or-honour `onRequest` hook.
- `README.md:50-73` — presence-gate limitation + required upstream-wall/proxy deployment.
- `docs/architecture/ADR-018-authorisation-model.md:204-231` — single trusted
  role header; fronting-layer-only trust; strip/re-inject boundary.

## OSC limitation logged

The absence of a documented, verifiable downstream browser-session signal is an
OSC-platform gap. Per the agent-team convention (CLAUDE.md rule 6), OSC friction
is logged in the `eng-open-videocore-agents` repo, not here; this gap is recorded
there at `docs/osc-feedback/incoming-ingress-ui-auth.md`.
