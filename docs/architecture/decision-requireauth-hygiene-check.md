# Decision: `requireAuth()` bearer-token hygiene check

**Status:** DECIDED — NO CHANGE (2026-09-07)
**Issue:** #598 (decision gate)
**Parent:** #594 (proposed option b: reject weak bearer tokens)
**Companion test issue:** #599 (single-char rejection test) — **NOT APPLICABLE** (see below)
**Auth authority:** issue #59 (the authoritative auth decision that removed
in-app token resolution and established the OSC auth wall as a pure gate).

> Note on ADR citations: the source comments in `src/auth/workspace.ts` and
> `src/data/guard.ts` cite "ADR-003" alongside issue #59 for the auth-wall
> rationale. That citation is imprecise: ADR-003 in this repo
> (`ADR-003-delivery-and-stream-url-contract.md`) is the delivery / stream-URL
> contract (issue #509), **not** the auth decision. The authoritative auth
> decision is **issue #59**. This note cites issue #59 accordingly and does not
> rely on ADR-003 for the auth boundary.

---

## Question

Should `requireAuth()` reject obviously malformed bearer values (e.g. below a
minimum length, or trivially low entropy) as opt-in defense-in-depth, WITHOUT
parsing OSC token semantics (identity, issuer, or claims)?

## Decision

**NO.** `requireAuth()` remains a pure presence gate. No length or entropy
hygiene check is added.

## Rationale (grounded in the actual code)

Verified contracts:

- `src/auth/workspace.ts` — `requireAuth(token: string | undefined):
  Promise<boolean>` throws `AuthError('missing access token')` only when the
  token is absent or whitespace-only, and otherwise returns `true`. Its comments
  state the wall is a PURE GATE and the token is "intentionally not inspected for
  identity, and nothing is scoped."
- `src/auth/middleware.ts` — `extractToken()` already enforces a well-formed
  `^Bearer\s+(.+)$` header and trims the captured value, so the only value that
  reaches `requireAuth()` is a non-empty bearer string. A malformed header
  (missing scheme, empty value) is already rejected with 401 upstream of
  `requireAuth()`.

Given that:

1. **The OSC auth wall is the real authentication boundary (issue #59).** Every
   request that reaches the process has already been authenticated by the
   platform. In-app token resolution against the OSC issuer was deliberately
   REMOVED. The presence gate exists only to reject anonymous traffic if a
   deployment is accidentally exposed without the wall (or behind an equivalent
   proxy). It is not, and is not intended to be, an authentication check.

2. **A format/entropy check adds negligible security.** Because the app never
   authenticates the token itself, rejecting a "short" or "low-entropy" bearer
   value blocks nothing that the wall would have admitted, and stops nothing the
   wall would have admitted from being served. Any attacker able to reach the
   process behind the wall has already been authenticated; any attacker in front
   of the wall never reaches this code.

3. **A length/entropy check risks false rejection of legitimate tokens.** OSC
   tokens are opaque to this application by design (issue #59 forbids
   interpreting their shape). A minimum-length or entropy heuristic encodes an
   assumption about token format that the auth model explicitly refuses to make.
   If the OSC token format changes (length, alphabet, encoding), a hygiene
   heuristic could reject valid, wall-authenticated callers — a real
   availability regression in exchange for no real security gain.

4. **It blurs the boundary.** Adding a shape check invites future readers to
   treat `requireAuth()` as if it partially validates the token, eroding the
   deliberate "presence gate only; the wall is the boundary" contract and
   creating pressure to grow the heuristic toward de-facto token parsing.

The presence gate is therefore **intentional and complete** for its stated job:
reject anonymous traffic; delegate all authentication to the OSC wall.

## Consequence for #594 / #599

- The #594 "reject a single arbitrary character" criterion is **declined**. A
  single-character bearer value is a syntactically valid, wall-authenticated
  opaque token from this application's point of view; rejecting it would require
  an out-of-band assumption about OSC token format that the auth model forbids.
- Issue **#599** (the companion test asserting single-char rejection) is
  therefore **NOT APPLICABLE** and should be closed as won't-do, referencing this
  decision.

## Scope guard for any future reconsideration

If this is ever revisited, any check MUST remain format/entropy-only and MUST
NOT parse OSC token identity, issuer, or claims. That constraint is a hard
boundary set by issue #59, independent of this decision.
