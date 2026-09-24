# Finding: why Encore's progress callback to the paired Callback Listener returns 401 on a fresh stack (issue #812)

**Status of the core question: CONFIRMED, and reproduced twice against the live platform.**
**Scope: investigation / documentation only — no production code changed.**
Related: #811 (parent symptom), #814 (paired fix), #457 / #463 (the prior
first-job freshness race). Verified on branch `issue-812/diagnose-callback-401`,
based on `origin/main`.

---

## One-paragraph root cause

The 401 is emitted by the **OSC ingress (nginx) in front of the per-instance
`eyevinn-encore-callback-listener`**, not by the listener application, and it is
**transient, not a standing policy**. In steady state that ingress explicitly
allows unauthenticated requests to `/` and `/encoreCallback` (exactly so Encore
can deliver callbacks) while auth-walling every other path. But for roughly
**13–18 seconds after the ingress hostname first starts answering**, the
unauthenticated allowlist is not yet in effect and the ingress applies its
default auth wall to *all* paths — including `/encoreCallback`. A first job
dispatched inside that window produces precisely the reported
`401 Unauthorized from POST https://<…>/encoreCallback`. The window is not
merely *unguarded* by this repo — it is actively **licensed** by the readiness
gate: `probeCallbackTrust()` HEADs the ingress **origin** and treats *any* HTTP
status as success (`src/encore-scaler/callback-trust-probe.ts:116-122`), and the
origin `/` is on the unauthenticated allowlist, so the probe flips
`callbackTrustReady = true` at the exact moment the origin starts answering —
while `/encoreCallback` is still returning 401 for another ~15 seconds.

**Classification: ingress-level (OSC platform), not listener-app-level.**
**Regression: no.** This is the same *class* of fresh-instance readiness race as
#457, surfacing at a different layer. Nothing in this repo regressed.

---

## 1. Ingress-level vs listener-app-level — CONFIRMED ingress-level

### 1a. The listener application cannot produce a 401

Verified against the service's own published source — the live catalog record
names `repoUrl: https://github.com/Eyevinn/encore-callback-listener`, read at
commit `247ba3721ad0bb578077f9b16a1bc7a7c0ab0640` (2025-04-25, default branch tip):

- `src/api.ts` — builds the Fastify instance and registers exactly four things:
  `@fastify/cors`, `@fastify/swagger`, `@fastify/swagger-ui`, `healthcheck`, and
  `encoreCallbackApi`. **No auth plugin, no `onRequest`/`preHandler` hook, no
  token check.**
- `src/encoreCallbackApi.ts:23-44` — the `POST /encoreCallback` route. Its
  schema declares only `response: { 200: Type.Null() }`; the handler logs the
  body, calls `onCallback`, calls `onSuccess` when
  `status.toUpperCase() === 'SUCCESSFUL'`, then `reply.send()`. There is **no
  code path in this route that can emit 401**.
- `src/config.ts:22-36` — `readConfig()` reads only `HOST`, `PORT`, `REDIS_URL`,
  `REDIS_QUEUE`, `ENCORE_URL`. **No auth/secret/token environment variable
  exists**, so the app cannot be configured to validate a payload-level
  credential even if we wanted it to.

### 1b. The 401 body identifies the ingress

A live unauthenticated request to a warm listener instance returns:

```
HTTP/1.1 401
<html><head><title>401 Authorization Required</title></head>
<body><center><h1>401 Authorization Required</h1></center>
<hr><center>nginx</center></body></html>
```

That is an nginx error page. The listener is Fastify and answers JSON (e.g.
`{"message":"Route GET:/ not found","error":"Not Found","statusCode":404}`), so
the 401 demonstrably never reaches the application.

### 1c. The steady-state ingress policy is a path allowlist, and `/encoreCallback` is ON it

Probed live against `https://oscaidev-ovc.eyevinn-encore-callback-listener.auto.prod-se.osaas.io`
(and reproduced identically on four separate warm instances, including
scaler-created ones):

| Request (no credential) | Result | Answered by |
|---|---|---|
| `POST /encoreCallback` | **200** | Fastify app |
| `PUT /encoreCallback` | 404 (JSON) | Fastify app |
| `GET /` | 404 (JSON) | Fastify app |
| `GET /healthcheck` | **401** (HTML) | nginx ingress |
| `POST /healthcheck` | **401** (HTML) | nginx ingress |
| `GET /docs` | **401** (HTML) | nginx ingress |
| `GET /nope`, `POST /nope` | **401** (HTML) | nginx ingress |
| `GET /healthcheck` **with** `x-jwt: Bearer <SAT>` | 200 `{"status":"up"}` | Fastify app |

So the ingress is not method-based and not blanket: it passes `/` and
`/encoreCallback` through unauthenticated and 401s everything else. **A standing
platform requirement for a bearer token on `/encoreCallback` does not exist.**
This rules out the first hypothesis in #812 as a *steady-state* explanation and
forced the investigation to fresh-instance timing.

---

## 2. The actual mechanism: a fresh-instance ingress-configuration window

Two throwaway `eyevinn-encore-callback-listener` instances were created via the
live OSC API and polled from `t0 = create`, then destroyed (both `DELETE` →
`204`; the service instance list was re-read afterwards to confirm no residue).

**Run 1** (`diag812`):

```
t+0s  … t+18s   POST /encoreCallback → (no connection)   HEAD origin → (no connection)
t+21s           POST /encoreCallback → (no connection)   HEAD origin → 200   ← probe would pass HERE
t+25s           POST /encoreCallback → 401               HEAD origin → 200
t+28s           POST /encoreCallback → 401               HEAD origin → 200
t+32s           POST /encoreCallback → 401               HEAD origin → 200
t+35s           POST /encoreCallback → 401               HEAD origin → 200
t+39s           POST /encoreCallback → 200               HEAD origin → 404 (app now up)
```

**Run 2** (`diag812b`):

```
t+0s  … t+28s   POST /encoreCallback → (no connection)   HEAD origin → (no connection)
t+32s           POST /encoreCallback → 401               HEAD origin → 200   ← probe would pass HERE
t+35s …t+42s    POST /encoreCallback → 401               HEAD origin → 200
t+45s           POST /encoreCallback → 200               HEAD origin → 404 (app now up)
```

Both runs show the same three-phase sequence, and the middle phase is the bug:

1. **Unreachable** — the per-instance ingress hostname does not answer at all.
2. **Reachable but auth-walled (~13–18s)** — the ingress answers, but the
   unauthenticated-path allowlist has not been applied yet, so `/encoreCallback`
   401s along with everything else. **This is the #812 window.**
3. **Steady state** — the allowlist is applied; `/encoreCallback` returns 200
   unauthenticated, `/healthcheck` stays 401.

The reported failure (`instance scalerstack2media0924mufmr3fj`, job
`job-1o28hwajqv7w`) is phase 2. It is consistent with #457's observation that the
Encore instance was **~35 seconds old** when its callback failed — the same
early-lifetime band.

### Why the existing readiness gate does not catch it — and makes it worse

- `src/encore-scaler/scaler-loop.ts:252` — `if (!(await this.ensureCallbackTrust(inst))) continue;`
  gates first-job dispatch.
- `src/encore-scaler/scaler-loop.ts:878-907` — `ensureCallbackTrust()` calls
  `probeCallbackTrust(inst.callbackListenerUrl, timeoutMs)` at line 900 and, on
  `result.ok`, sets `inst.callbackTrustReady = true` (line 903) permanently
  (line 879: a ready instance is never re-probed).
- `src/encore-scaler/callback-trust-probe.ts:105` — the probe rewrites the URL to
  `new URL(callbackListenerUrl).origin`, deliberately discarding the
  `/encoreCallback` path ("we probe the ingress ORIGIN, not a specific route",
  comment at lines 31-34).
- `src/encore-scaler/callback-trust-probe.ts:116-122` — it issues `HEAD` and
  returns `{ ok: true }` for **any** HTTP response: *"Any HTTP response —
  including 404/405 — means the TLS handshake succeeded"*.

That logic is correct for the question #463 asked (is TLS trust established?) and
wrong for the question #812 asks (is the callback path usable?). The origin `/`
is on the unauthenticated allowlist, so it starts returning 200 **before** the
allowlist covers `/encoreCallback`. In both runs above, the probe's own request
(`HEAD origin`) returned 200 at t+21s / t+32s — i.e. the scaler would have marked
the instance `callbackTrustReady` and dispatched its first job while
`/encoreCallback` still had ~15 seconds of 401 left. The gate converts a race
into a near-certainty for the first job on a fresh stack.

Note the second-order effect: because `callbackTrustReady` is sticky
(`scaler-loop.ts:879`, `types.ts:159`), the wrong verdict is cached for the
instance's entire lifetime.

---

## 3. Regression vs longstanding — NOT a platform regression

#812 raised the possibility that the platform newly started requiring a token,
citing #457's PKIX/TLS error as proof the request "used to reach the listener".
The evidence does not support a regression:

- **No standing token requirement exists today.** Section 1c shows
  `/encoreCallback` is explicitly allowlisted unauthenticated on every warm
  instance tested. If OSC had introduced a token requirement on this path, warm
  instances would 401 too. They do not.
- **Nothing in this repo changed.** `progressCallbackUri` has been injected
  without any credential since the feature landed — `git log -S progressCallbackUri`
  on `src/encore-scaler/scaler-loop.ts` returns exactly one commit, `7eb6217`
  ("feat(scaler): pair callback listener with each Encore instance", 2026-07-07);
  the same single commit introduced `ENCORE_CALLBACK_LISTENER_SERVICE_ID` in
  `src/encore-scaler/instance-pool.ts`. There has never been a credential to lose.
- **#457 and #812 are the same race at different layers.** #457 (2026-08-31)
  caught the window at the TLS layer (ingress certificate not yet trusted);
  #812 catches it at the authorisation layer (allowlist not yet applied). Both
  are "the per-instance ingress is answering before it is fully configured". The
  prior friction log
  (`eng-open-videocore-agents/docs/osc-feedback/incoming-callback-listener-tls-trust-race-first-job.md`)
  already frames this as "a **race** between per-instance ingress certificate
  readiness/trust and the instance beginning to process its first job — not a
  permanent misconfiguration". The 401 is the next layer of the same race, now
  visible because #463's fix removed the TLS failure that used to mask it.

**Conclusion: longstanding race, newly *observable*.** #463's TLS gate did its
job — it stopped the handshake failure — and in doing so exposed the
authorisation-configuration lag that was previously hidden behind it. Calling
this a regression would be wrong; calling #463 complete would also be wrong.

---

## 4. Contract verification (CLAUDE.md rule 7) — the live catalog says there is no auth knob

Both contracts below were fetched **live** in this session, not assumed. The
access pattern itself was taken from the `@osaas/client-core` package the repo
already depends on:
`node_modules/@osaas/client-core/lib/context.js:24,28` (catalog
`/mysubscriptions`, header `x-pat-jwt: Bearer <PAT>`),
`context.js:36-45` (`POST https://token.svc.prod.osaas.io/servicetoken` →
service access token), and `core.js:76-90` (instance API, header
`x-jwt: Bearer <SAT>`).

### 4a. `eyevinn-encore-callback-listener` catalog record

`GET https://catalog.svc.prod.osaas.io/mysubscriptions` → element with
`serviceId: "eyevinn-encore-callback-listener"` (HTTP 200, fetched this session):

- `availableServiceInstanceOptions`: **`["name", "RedisUrl", "EncoreUrl", "RedisQueue"]`** — that is the
  complete set. `serviceInstanceOptions` carries the same four entries
  (`name` mandatory, `regexValidator: "^\\w+$"`; `RedisUrl` mandatory;
  `EncoreUrl` mandatory; `RedisQueue` optional).
- **There is no auth, token, secret, apiKey, or allowlist option**, and no field
  anywhere in the record documenting an inbound authentication requirement for
  the instance ingress. The record's only auth-adjacent content is
  `apiUrl: "https://api-eyevinn-encore-callback-listener.auto.prod-se.osaas.io/encore-callback-listenerinstance"`
  (the *management* API, which does require a SAT).
- `serviceAssociations` documents only `RedisUrl → valkey-io-valkey` (TCP/redis)
  and `EncoreUrl → encore` (HTTP/https).

So: **the 401 behaviour is undocumented in the service contract**, and the
contract offers no knob to configure it. This is the OSC-side gap logged in
section 6.

### 4b. Encore's job-submission contract has no callback-credential field

Fetched from a **live Encore instance of the same class the scaler dispatches to**:
`GET https://oscaidev-scalerqa2609160604mu3piiqh.encore.auto.prod-se.osaas.io/v3/api-docs`
(HTTP 200, 22 949 bytes, `openapi: 3.1.0`, `info.title: "Encore OpenAPI"`):

- `components.schemas.EncoreJobRequestBody.properties.progressCallbackUri`
  = `{"type": "string", "description": "An url to which the progress status callback should be directed", "example": "http://projectx/encorecallback"}`
- The full property set of `EncoreJobRequestBody` is:
  `baseName, completedDate, createdDate, debugOverlay, duration, externalId, id,
  inputs, logContext, message, output, outputFolder, priority, profile,
  profileParams, progress, progressCallbackUri, seekTo, segmentLength, speed,
  startedDate, status, thumbnailTime`.
  **No field matching auth / token / credential / header / secret / bearer /
  apiKey exists.** `progressCallbackUri` is a bare URL string with no companion.
- The document declares **no top-level `security`** and
  **`components.securitySchemes` is empty**.
- The same shape appears in the vendored copy in the listener repo
  (`Eyevinn/encore-callback-listener` → `encore-api.yaml:341-345`), confirming
  this is not an instance-local quirk.

**Direct consequence: it is contractually impossible to give Encore a credential
to present on the callback leg.** There is no header map, no auth block, and no
URL-credential convention in the job payload. The `authorization: Bearer ${token}`
at `src/encore-scaler/scaler-loop.ts:958` authenticates *our* dispatch to Encore
and is not and cannot be propagated onto Encore's outbound POST.

---

## 5. Implementation direction for #814

#814 is currently titled/scoped as *"give Encore a credential to authenticate its
progress callback"*. **That approach is not implementable and, more importantly,
not necessary** — sections 4b and 1c respectively. #814 should be re-scoped to a
**readiness gate on the callback path itself**. Concretely:

1. **Probe the real callback path, not the origin.**
   Change `probeCallbackTrust()` (`src/encore-scaler/callback-trust-probe.ts:96-140`)
   to target `${callbackListenerUrl}/encoreCallback` instead of
   `new URL(callbackListenerUrl).origin` (line 105). The origin is on the
   unauthenticated allowlist and therefore opens too early; `/encoreCallback` is
   the only URL whose readiness actually matters.

2. **Stop treating every HTTP status as success.**
   Lines 116-122 return `{ ok: true }` for any response. Split the verdict:
   - `401` / `403` → **not ready** (new `errorClass: 'ingress-auth'`), retry next
     tick. This is exactly the behaviour #811's acceptance criteria asks for
     ("treats 401/403 from the listener as 'callback path not usable' instead of
     'trusted'").
   - TLS/handshake signatures → `'tls-trust'` (unchanged, preserves #463).
   - Any other status (including 404/405 for a `HEAD`/`GET` against a POST-only
     route) → ready. Note the live app returns a Fastify **404** for
     `GET /encoreCallback` and **200** for `POST /encoreCallback`; a `GET` is the
     safe probe verb because it reaches the app without invoking the handler, and
     a 404-from-Fastify proves both TLS trust *and* that the allowlist is live.
     Do **not** probe with `POST`, which would enqueue a synthetic callback.

3. **Keep the bounded wait, and make sure it is long enough.**
   `ensureCallbackTrust()` already re-probes on later ticks within
   `DEFAULT_CALLBACK_TRUST_TIMEOUT_MS = 60_000`
   (`src/encore-scaler/scaler-loop.ts:44,885,913-916`) and quarantines past the
   deadline (lines 918-935). The observed window closes at t+39s and t+45s from
   instance creation, so 60 s is adequate but not generous; consider raising the
   default to ~120 s once the probe can actually fail on 401.

4. **Do not cache a premature pass.** `callbackTrustReady` is sticky
   (`scaler-loop.ts:879`, `types.ts:159`). With fix (2) this becomes correct,
   because the probe will no longer pass during the 401 window — no additional
   invalidation logic is needed.

5. **Keep `sweepTerminalJobs` as the backstop.** It is what saved the reported
   run; the gate reduces reliance on it but should not replace it.

This is an in-repo fix. No OSC change is required to unblock #814 — but the
underlying platform behaviour is still a gap worth reporting (section 6).

---

## 6. OSC friction logged

Two distinct platform issues fall out of this and are logged in the agent-team
repo per CLAUDE.md rule 6 (OSC friction lives in `eng-open-videocore-agents`, not
here):

- `docs/osc-feedback/incoming-callback-listener-ingress-auth-allowlist-race-fresh-instance.md`
  — a freshly-created `eyevinn-encore-callback-listener` instance's ingress
  starts answering ~13–18 s **before** its unauthenticated-path allowlist is
  applied, so `/encoreCallback` 401s during that window while the origin already
  returns 200. Requested capability: a readiness signal that means "ingress
  routing *and* authorisation policy are both live", or ordering the allowlist
  before the hostname starts serving.
- The same log records the contract gap: the inbound authentication policy for
  per-instance ingresses (which paths are auth-walled, which are allowlisted) is
  **not represented anywhere in the catalog service record**
  (`availableServiceInstanceOptions` = `["name","RedisUrl","EncoreUrl","RedisQueue"]`),
  so it cannot be verified contract-first ahead of time — it can only be
  discovered empirically, as it was here.

---

## Fact ledger: confirmed vs. inferred

| Fact | Status |
|---|---|
| 401 is emitted by nginx, not the listener app | **Confirmed** — nginx HTML error page + app source has no auth |
| Listener app has no auth code or auth env var | **Confirmed** — `Eyevinn/encore-callback-listener@247ba37` `src/api.ts`, `src/encoreCallbackApi.ts:23-44`, `src/config.ts:22-36` |
| `/encoreCallback` is allowlisted unauthenticated in steady state | **Confirmed** — live probe, 4 warm instances |
| A fresh instance 401s on `/encoreCallback` for ~13–18 s after the origin opens | **Confirmed** — 2/2 reproductions, instances created and destroyed live |
| `probeCallbackTrust` passes during that window | **Confirmed** — `HEAD origin → 200` observed in both runs at the moment `/encoreCallback` was still 401; code at `callback-trust-probe.ts:105,116-122` |
| Encore's job payload has no callback-credential field | **Confirmed** — live `/v3/api-docs` from an Encore instance; `EncoreJobRequestBody` property list |
| Catalog record documents no auth requirement or knob | **Confirmed** — live `/mysubscriptions` record |
| No in-repo regression | **Confirmed** — `git log -S "progressCallbackUri"` → single commit `7eb6217` (2026-07-07) |
| The `testsimon` tenant's instance failed for this same reason | **Inferred (high confidence)** — reproduced in tenant `oscaidev`; the reported symptom, path, status code and instance age all match phase 2. Not reproduced in `testsimon` itself, which this session cannot reach |
| Exact mechanism *inside* the OSC ingress (why the allowlist lags) | **Not determined** — black box; observable only from outside. Does not change the fix direction |

---

## Contract sources cited

Live platform (fetched this session):

- `GET https://catalog.svc.prod.osaas.io/mysubscriptions` → `serviceId: "eyevinn-encore-callback-listener"`:
  `availableServiceInstanceOptions`, `serviceInstanceOptions`, `serviceAssociations`, `apiUrl`, `repoUrl`.
- `GET https://api-eyevinn-encore-callback-listener.auto.prod-se.osaas.io/encore-callback-listenerinstance` (`x-jwt: Bearer <SAT>`) → instance list + `url` per instance.
- `GET <encore-instance>/v3/api-docs` → `components.schemas.EncoreJobRequestBody.properties.progressCallbackUri`; `components.securitySchemes` (empty).
- Live HTTP probes of listener ingresses, warm and freshly created (tables and timelines above).

Upstream service source:

- `Eyevinn/encore-callback-listener@247ba3721ad0bb578077f9b16a1bc7a7c0ab0640` — `src/api.ts`, `src/encoreCallbackApi.ts:23-44`, `src/config.ts:22-36`, `encore-api.yaml:341-345`.

This repo:

- `src/encore-scaler/scaler-loop.ts:44` — `DEFAULT_CALLBACK_TRUST_TIMEOUT_MS = 60_000`.
- `src/encore-scaler/scaler-loop.ts:252` — dispatch gated on `ensureCallbackTrust`.
- `src/encore-scaler/scaler-loop.ts:878-935` — `ensureCallbackTrust()`: probe, sticky pass, bounded wait, quarantine.
- `src/encore-scaler/scaler-loop.ts:951-953` — `progressCallbackUri` injection (no credential).
- `src/encore-scaler/scaler-loop.ts:954-961` — dispatch `authorization: Bearer ${token}` (authenticates us → Encore only).
- `src/encore-scaler/callback-trust-probe.ts:105` — origin rewrite.
- `src/encore-scaler/callback-trust-probe.ts:116-122` — any-status-is-success.
- `src/encore-scaler/instance-pool.ts:33-34` — `ENCORE_CALLBACK_LISTENER_SERVICE_ID`.
- `src/encore-scaler/instance-pool.ts:216-254` — paired listener creation (`name`, `RedisUrl`, `EncoreUrl`, `RedisQueue` — matching the catalog options exactly).
- `src/encore-scaler/instance-pool.ts:259` — `callbackListenerUrl: instanceUrl(callback)`.
- `src/encore-scaler/types.ts:151,159-173` — `callbackListenerUrl`, `callbackTrustReady`/`ConfirmedAt`/`FirstProbeAt`/`QuarantinedAt`.
- `node_modules/@osaas/client-core/lib/context.js:24,28,36-45`, `core.js:76-90` — the OSC API access contract used above.

Side note: #814 and several code comments cite
`docs/architecture/ADR-006-encore-autoscaler.md`. **That file does not exist** —
`docs/architecture/ADR-021-audit-log-retention.md:13-15` already records that
`ADR-006` is a known stale reference. The routing behaviour #814 attributes to
ADR-006 is nonetheless accurately described by the code cited above.
