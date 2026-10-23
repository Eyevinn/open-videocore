# Investigation — opt-in trust of the fronting layer for the UI presence gate

Status: investigation + design complete (research only; NO functional behaviour
changed). Feeds #734 (bundled-UI-through-`authGate` options) and is the
alternative/complementary path to its option-1 fix.

Issue: #742 — evaluate opt-in trust of the fronting layer for the UI presence
gate.

## Summary

The concrete, unresolved question #734 flagged is: **how does the deployment
ingress authenticate a browser session for `/ui`, and — critically — what (if
anything) does it forward to the process so a same-origin UI `fetch()` to
`/api/v1/*` can pass the `authGate` presence gate from #711?**

That question **cannot be answered from this repository's code alone.** The code
*assumes* the OSC login wall injects an `Authorization: Bearer` token on every
forwarded request (`src/main.ts:228`, `src/main.ts:416-417`), but nothing in the
codebase verifies that injection, and there is **no read of any browser-session
signal** (no cookie, `X-Forwarded-*`, `Sec-Fetch-*`, `Referer`, or `Origin`
header) anywhere in `src/`. So the "fronting-layer signal" this issue is meant to
trust is **not confirmable from code**. Per CLAUDE.md rule 7 ("never guess … if
the real contract is unreachable, stop and ask"), this issue therefore ships as a
**documented finding + a design ready to implement once a human confirms the
ingress mechanism** — no functional trust code is added, so the default
anonymous-401 behaviour from #711 is untouched and `test/workspace-acl.test.ts`
is unchanged.

## 1. What is verified from code (contract sources, cited)

### 1.1 The presence gate only recognises `Authorization: Bearer`

`authGate(app)` (`src/auth/middleware.ts:76-87`) delegates to the `authenticate`
decoration (`src/auth/middleware.ts:34-56`), which extracts the token via
`extractToken` — and that reads **only** the `Authorization` header, matched
against `Bearer <token>` (`src/auth/middleware.ts:23-30`). `requireAuth` is a
pure presence gate: any non-empty bearer string passes, a missing token throws
`AuthError` → `401` + `WWW-Authenticate: Bearer`
(`src/auth/workspace.ts:52-57`; `src/auth/middleware.ts:44-50`).

Consequence: **a request with no `Authorization: Bearer` header is rejected 401,
regardless of any cookie or other credential it carries.** A browser session
authenticated only by a cookie does not, by itself, satisfy this gate.

### 1.2 The protected routers attach `authGate` as their first preHandler

Every workspace-scoped router attaches `authGate(app)` as its first `preHandler`
— e.g. assets (`src/routes/assets.ts:1510`), jobs (`src/routes/jobs.ts:127`),
collections (`src/routes/collections.ts:246`), storage
(`src/routes/storage.ts:307`), asset-upload (`src/routes/asset-upload.ts:131`).
So every `/api/v1/*` data route the bundled UI calls is behind the presence gate.

### 1.3 The `/ui` static assets are NOT themselves behind `authGate`

The web UI is served by `@fastify/static` at the `/ui/` prefix, plus a `/ui` →
`/ui/index.html` redirect (`src/main.ts:2134-2139`). No `authGate` preHandler is
attached to that registration. So *inside the app* the HTML/JS/CSS load without a
bearer token; only the XHR/`fetch` calls those assets make to `/api/v1/*` hit the
gate (§1.1–1.2). Outside the app, the OSC edge login wall still gates `/ui`
(§1.5).

### 1.4 The `OVC_TRUST_ROLE_HEADER` pattern this issue must mirror

The existing opt-in fronting-layer trust is `OVC_TRUST_ROLE_HEADER`:
`src/main.ts:446-448` reads `process.env['OVC_TRUST_ROLE_HEADER'] === 'true'`
into `PrincipalOptions.trustRoleHeader` (`src/auth/principal.ts:150-172`); the
`onRequest` trust boundary strips the client-supplied `X-OVC-Role` header
**unless** the flag is set, then resolves the role (`src/auth/principal.ts:182-207`).
Default (`false`/absent) ⇒ header stripped ⇒ behaviour identical to today
(ADR-018 decision 5, `docs/architecture/ADR-018-authorisation-model.md:204-231`).
This is the exact shape the #742 mechanism must copy: **disabled by default,
trusts a fronting-layer-set request property only when explicitly opted in.**

### 1.5 The OSC login wall gates the browser at the platform edge

`docs/osc-feedback/incoming-08-login-wall-blocks-encore-profile-fetch.md:22`
records (verified against OSC, 2026-07-08) that "the OSC login wall protects
**every path** of an app except `/health` and `/healthz`. There is no per-path
bypass configuration." `src/services/profiles-reachability.ts:24-42,130,177`
corroborates: an unauthenticated fetch to `/api/v1/profiles/index.yml` was
rejected `401` by the edge wall. So a browser reaching `/ui` at all has already
passed the edge login wall.

### 1.6 The app sees NO fronting-layer browser-session signal

Confirmed absence (grep over `src/` for `cookie`, `x-forwarded`, `sec-fetch`,
`referer`, `origin` header reads returns nothing): the app never reads a session
cookie, a forwarded-user header, or an origin/site header. The **only** thing a
handler learns about the caller is `request.authenticated: boolean`, derived
solely from `Authorization: Bearer` (the #551 spike established this in full:
`docs/investigations/spike-osc-identity-primitives.md:126-135`). OSC provides no
runtime identity-injection primitive (spike §2, catalog 2026-09-04).

## 2. The unresolved question, stated precisely

For an **authenticated browser session** that has passed the edge login wall and
whose bundled-UI JavaScript issues a same-origin `fetch('/api/v1/…')`, which of
these does the OSC edge forward to the process?

- **H1 — edge injects `Authorization: Bearer <token>`.** The code *assumes* this
  (`src/main.ts:228` bearerAuth description "injected by the OSC login wall in
  production"; `src/main.ts:416-417` "Auth is handled by the OSC SAT gate
  upstream; the app trusts every request that reaches it"). If true, the bundled
  UI's `fetch` already carries the bearer the edge adds, `authGate` passes with
  **zero UI-side token handling**, and **#742's trust mechanism is unnecessary** —
  the #711 401 only ever fires for direct-to-process anonymous traffic that
  bypassed the wall.
- **H2 — edge authenticates via a session cookie and forwards NO
  `Authorization` header.** The issue author's stated likely case. Then the UI's
  `fetch` has no bearer, `authGate` returns 401, and **the bundled UI is broken
  behind the #711 gate** unless the app is told to trust the edge-authenticated
  same-origin request. This is the case #742/#734-option-2 exists for.

**Neither hypothesis is verified.** The `src/main.ts:228` / `:416-417` comments
assert H1 but the #551 spike only ever verified *what the app reads*
(`request.authenticated` from a bearer), never *what the edge injects*
(spike §1, §4 "confirmed absence … NO downstream principal-identity contract
beyond a presence boolean"). The login-wall friction doc (§1.5) confirms the wall
gates paths but does **not** document what it forwards for an authenticated
browser. This single ambiguity determines whether any code is needed at all and,
if so, what request property it keys on.

## 3. Proposed opt-in trust design (implementable only after §4 is confirmed)

If — and only if — §4 confirms **H2** (or any variant where the edge forwards a
distinguishable, non-spoofable fronting-layer signal for authenticated browser
sessions), add an opt-in trust flag mirroring `OVC_TRUST_ROLE_HEADER` exactly:

- **Env flag:** `OVC_TRUST_FRONTING_UI_SESSION` (naming parallels
  `OVC_TRUST_ROLE_HEADER`), read in `src/main.ts` next to the existing flag
  (`src/main.ts:446-448`) as `=== 'true'`, defaulting **false**.
- **Plumbing:** pass it into `registerAuth` (or a thin wrapper) as a
  `trustFrontingUiSession: boolean` option, structured like
  `PrincipalOptions.trustRoleHeader` (`src/auth/principal.ts:150-172`).
- **Behaviour when `false` (default):** `authGate` is byte-identical to today —
  `Authorization: Bearer` required, anonymous ⇒ 401. **No weakening of #711.**
- **Behaviour when `true`:** inside `authGate`'s presence check
  (`src/auth/middleware.ts:76-87`), before rejecting a bearer-less request, admit
  it **iff** it is a same-origin UI request bearing the confirmed fronting-layer
  signal from §4. The predicate MUST be:
  1. **The `<SIGNAL>` from §4 is present** (e.g. the edge-set cookie/header that
     only exists on an edge-authenticated request — NOT a value any direct client
     can forge; this is the trust boundary, exactly as ADR-018 decision 5 requires
     the role header be trusted only from the fronting layer,
     `docs/architecture/ADR-018-authorisation-model.md:213-220`), **and**
  2. the request targets a UI-originated same-origin API call (scope the
     admission so it cannot become a blanket auth bypass for scripted clients).
- **Set `request.authenticated = true`** for such an admitted request so the
  downstream connection-resolving preHandler behaves as today; do **not** grant a
  role beyond the existing `X-OVC-Role`/default path (§1.4) — this flag governs
  *presence*, not *authorisation*.

This keeps the two flags orthogonal and composable: `OVC_TRUST_ROLE_HEADER`
governs *which role* a trusted edge asserts; `OVC_TRUST_FRONTING_UI_SESSION`
governs *whether a cookie-authenticated same-origin UI request counts as present*
for the 401 gate.

If §4 confirms **H1**, **no code is needed** — close #742/#734-option-2 as
"unnecessary; edge injects the bearer" and record the confirmation here.

## 4. What a human MUST confirm before any code is written

A single observation on a live OSC deployment (or an authoritative OSC answer)
resolves everything above. Capture, for an **authenticated browser session** that
has logged in through the edge wall and whose `/ui` page issues
`fetch('/api/v1/assets')`, the **exact request headers the process receives**:

1. Is there an `Authorization: Bearer …` header on that forwarded request? (Yes ⇒
   **H1**, no code needed.)
2. If not, what distinguishes it from an anonymous direct-to-process request —
   a specific cookie (name?), an `X-Forwarded-*` / edge-identity header, or
   nothing at all? (This is the `<SIGNAL>` the §3 predicate would key on.)
3. Is that signal **set by the edge and unforgeable by a direct client** (so
   trusting it cannot be used to bypass the wall)? If it is client-forgeable, the
   design is unsafe and must not be implemented — the #711 gate stays as-is.

Until (1)–(3) are answered, implementing a bypass would mean guessing the ingress
contract, which CLAUDE.md rule 7 forbids. The safe, shipped state is: **default
anonymous-401 preserved; design ready; awaiting ingress confirmation.**

## Evidence index

- `src/auth/middleware.ts:23-30` — token read from `Authorization: Bearer` only.
- `src/auth/middleware.ts:34-56` — `registerAuth` / `authenticate`; 401 +
  `WWW-Authenticate: Bearer` when absent.
- `src/auth/middleware.ts:76-87` — `authGate(app)` presence gate (the insertion
  point for §3).
- `src/auth/workspace.ts:52-57` — `requireAuth` pure presence gate.
- `src/main.ts:404-414` — 401 presence gate wiring (`registerAuth(app)`, #711).
- `src/main.ts:416-417` — "app trusts every request that reaches it" (H1
  assumption).
- `src/main.ts:228` — bearerAuth "injected by the OSC login wall" (H1 assumption).
- `src/main.ts:446-448` — `OVC_TRUST_ROLE_HEADER` env read (pattern to mirror).
- `src/main.ts:2134-2139` — `/ui/` static serving, not behind `authGate`.
- `src/auth/principal.ts:150-207` — `PrincipalOptions.trustRoleHeader` + strip-
  unless-trusted onRequest boundary (design template for §3).
- `src/routes/assets.ts:1510`, `src/routes/jobs.ts:127`,
  `src/routes/collections.ts:246`, `src/routes/storage.ts:307`,
  `src/routes/asset-upload.ts:131` — routers attach `authGate` first.
- `src/services/profiles-reachability.ts:24-42,130,177` — edge wall returns 401
  on unauthenticated app paths.
- `docs/osc-feedback/incoming-08-login-wall-blocks-encore-profile-fetch.md:22` —
  edge wall gates every path except `/health`/`/healthz`; no per-path bypass.
- `docs/investigations/spike-osc-identity-primitives.md:126-135` — app sees only
  `request.authenticated: boolean`; no OSC identity-injection primitive.
- `docs/architecture/ADR-018-authorisation-model.md:204-231` — trusted-header
  contract; trust only the fronting layer, strip client-supplied values.
- grep over `src/` for `cookie` / `x-forwarded` / `sec-fetch` / `referer` /
  `origin` header reads — **no results** (confirmed absence of any browser-session
  signal read, §1.6).
