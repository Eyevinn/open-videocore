# Finding: why Encore's progress callback to the paired Callback Listener returns 401 on a fresh stack (issue #812)

**Status of the core question: CONFIRMED, and reproduced twice against the live platform.**
**Scope: investigation / documentation only — no production code changed.**
Related: #811 (parent symptom), #814 (paired fix), #813 / #818 (the 401/403 probe
verdict that landed while this was in review), #457 / #463 (the prior first-job
freshness race). Verified on branch `issue-812/diagnose-callback-401` with
`origin/main` (`92a13cc`) merged in, so **every in-repo line citation below is
against a tree that already contains #818** (`29b669c`).

---

## One-paragraph root cause

The 401 is emitted by the **OSC ingress (nginx) in front of the per-instance
`eyevinn-encore-callback-listener`**, not by the listener application, and it is
**transient, not a standing policy**. In steady state that ingress lets
unauthenticated requests to `/` and `/encoreCallback` reach the application
(exactly so Encore can deliver callbacks) while auth-walling every other path.
But for roughly **13–18 seconds after the ingress hostname first starts
answering**, `/encoreCallback` is still behind the ingress auth wall and returns
401, while the **origin `/` already answers 200**. A first job dispatched inside
that window produces precisely the reported
`401 Unauthorized from POST https://<…>/encoreCallback`. The window is not
merely *unguarded* by this repo — it is actively **licensed** by the readiness
gate: `probeCallbackTrust()` HEADs the ingress **origin**, not the callback path
(`src/encore-scaler/callback-trust-probe.ts:138,151`), and the origin is the one
URL that answers non-401 during the window, so the probe flips
`callbackTrustReady = true` at the exact moment the origin starts answering —
while `/encoreCallback` is still returning 401 for another ~15 seconds. **#818's
new 401/403 → `callback-unusable` verdict does not change this**, because the
probe it grades is still aimed at the origin, which never returns 401 in this
window (see §5a).

**Classification: ingress-level (OSC platform), not listener-app-level.**
**Regression: no.** This is the same *class* of fresh-instance readiness race as
#457, surfacing at a different layer. Nothing in this repo regressed.

**What is *not* established:** why the origin answers 200 during the window.
Two readings fit the data equally well — (a) `/` is on the unauthenticated
allowlist and `/encoreCallback` is added to it later, or (b) the phase-2 `200` on
`/` is an ingress-level placeholder, not the application, since the application
answers `404` on `/` once it is actually up (`t+39s` / `t+45s` in §2). This
finding does **not** pick between them, and the fix direction is identical under
both: the only URL whose readiness can be trusted is `/encoreCallback` itself.

---

## 1. Ingress-level vs listener-app-level — CONFIRMED ingress-level

### 1a. The listener application cannot produce a 401

Verified against the service's own published source — the live catalog record
names `repoUrl: https://github.com/Eyevinn/encore-callback-listener`, read at
commit `247ba3721ad0bb578077f9b16a1bc7a7c0ab0640` (2025-04-25, default branch tip):

- `src/api.ts:53,56,65,69,76` — builds the Fastify instance and registers
  exactly five things: `@fastify/cors`, `@fastify/swagger`,
  `@fastify/swagger-ui`, `healthcheck`, and `encoreCallbackApi`. **No auth
  plugin, no `onRequest`/`preHandler` hook, no token check.**
- `src/encoreCallbackApi.ts:23-43` — the `POST /encoreCallback` route. Its
  schema declares only `response: { 200: Type.Null() }`; the handler logs the
  body, calls `onCallback`, calls `onSuccess` when
  `status.toUpperCase() === 'SUCCESSFUL'`, then `reply.send()`. There is **no
  code path in this route that can emit 401**.
- `src/config.ts:17-31` — `readConfig()` (the whole file is 31 lines) reads only
  `HOST`, `PORT`, `REDIS_URL`, `REDIS_QUEUE`, `ENCORE_URL`. **No auth/secret/
  token environment variable exists**, so the app cannot be configured to
  validate a payload-level credential even if we wanted it to.

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
| `GET /encoreCallback` | 404 (JSON) | Fastify app |
| `HEAD /encoreCallback` | 404 | Fastify app |
| `PUT /encoreCallback` | 404 (JSON) | Fastify app |
| `GET /` | 404 (JSON) | Fastify app |
| `HEAD /` | 404 | Fastify app |
| `GET /healthcheck` | **401** (HTML) | nginx ingress |
| `POST /healthcheck` | **401** (HTML) | nginx ingress |
| `GET /docs` | **401** (HTML) | nginx ingress |
| `GET /nope`, `POST /nope` | **401** (HTML) | nginx ingress |
| `GET /healthcheck` **with** `x-jwt: Bearer <SAT>` | 200 `{"status":"up"}` | Fastify app |

The `GET`/`HEAD` 404 body is `{"message":"Route GET:/encoreCallback not
found",...}` — Fastify's own router message, which proves the request reached
the application rather than being answered by the ingress.

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
2. **Origin answering, callback path still auth-walled (~13–18s)** — the origin
   `/` returns **200**, but `/encoreCallback` returns **401** from the ingress.
   **This is the #812 window.**
3. **Steady state** — `/encoreCallback` returns 200 unauthenticated from the
   application, `/` returns the application's 404, `/healthcheck` stays 401.

The one thing the data proves about phase 2 is the *divergence*: the origin
answers non-401 while `/encoreCallback` does not. It does **not** show a blanket
auth wall — if it did, `/` would 401 too, and it does not. Nor is the phase-2
`200` on `/` the application: once the application is actually up (t+39s / t+45s)
`/` flips to the Fastify **404**. So the phase-2 `200` is served by something
that stops serving it once the application appears. Whether that is the
unauthenticated allowlist covering `/` before `/encoreCallback`, or an
ingress-level placeholder answering ahead of any allowlist, **was not
determined** — the ingress is a black box from outside. Both readings produce the
same actionable conclusion and the same fix.

The reported failure (`instance scalerstack2media0924mufmr3fj`, job
`job-1o28hwajqv7w`) is phase 2. It is consistent with #457's observation that the
Encore instance was **~35 seconds old** when its callback failed — the same
early-lifetime band.

### Why the existing readiness gate does not catch it — and makes it worse

All line numbers below are against `main` **including #818** (`29b669c`).

- `src/encore-scaler/scaler-loop.ts:252` — `if (!(await this.ensureCallbackTrust(inst))) continue;`
  gates first-job dispatch.
- `src/encore-scaler/scaler-loop.ts:886-919` — `ensureCallbackTrust()` calls
  `probeCallbackTrust(inst.callbackListenerUrl, timeoutMs)` at line 913 and, on
  `result.ok`, sets `inst.callbackTrustReady = true` (line 916) permanently
  (line 887: a ready instance is never re-probed).
- `src/encore-scaler/callback-trust-probe.ts:138` — the probe rewrites the URL to
  `new URL(callbackListenerUrl).origin`, deliberately discarding the
  `/encoreCallback` path ("we probe the ingress ORIGIN, not a specific route",
  comment at lines 31-34).
- `src/encore-scaler/callback-trust-probe.ts:151-169` — it issues `HEAD` against
  that origin and, post-#818, returns `state: 'trusted'` for every status except
  401/403 (`CALLBACK_REJECTED_STATUSES`, line 77), which return
  `state: 'callback-unusable'` (lines 158-165).

That logic is correct for the question #463 asked (is TLS trust established?) and
wrong for the question #812 asks (is the callback path usable?). The origin
starts answering 200 **before** `/encoreCallback` stops returning 401. In both
runs above, the probe's own request (`HEAD origin`) returned 200 at t+21s /
t+32s — i.e. the scaler would have marked the instance `callbackTrustReady` and
dispatched its first job while `/encoreCallback` still had ~15 seconds of 401
left. The gate converts a race into a near-certainty for the first job on a fresh
stack.

**#818 does not change that outcome.** Its 401/403 branch only fires when the URL
the probe actually requests answers 401/403 — and the URL it requests is the
origin (line 138), which answers **200** throughout the window (§2, both runs).
The new `callback-unusable` state is therefore unreachable in the #812 scenario.
See §5a.

Note the second-order effect: because `callbackTrustReady` is sticky
(`scaler-loop.ts:887`, `types.ts:159`), the wrong verdict is cached for the
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
  `src/encore-scaler/instance-pool.ts`. (Run repo-wide, the same `-S` search
  returns six commits; the oldest **call site** that puts `progressCallbackUri`
  into an Encore job payload is `f128ae1`, 2026-06-02 — the superseded
  `backend-api` Encore client, a different, pre-scaler code path. It read the URI
  from `ENCORE_CALLBACK_URL` in `backend-api/src/pipeline/transcode.ts:75` and
  likewise attached no credential to the listener leg, so the claim holds under
  either scoping. The three older hits are not call sites: `799a678` adds an
  optional `progressCallbackUri` to an inbound request schema and states in the
  same diff that it is *not* forwarded, `c292546` is a code comment, and
  `2f8349a` is a prose row in `ADR-001-osc-stack.md`.) There has never been a
  credential to lose.
- **#457 and #812 are the same race at different layers.** #457 (2026-08-31)
  caught the window at the TLS layer (ingress certificate not yet trusted);
  #812 catches it at the authorisation layer (the callback path still
  auth-walled). Both
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
- The document declares **no top-level `security`**, and `components` contains
  only `schemas` — the **`securitySchemes` key is absent entirely**.
- The same shape appears in the vendored copy in the listener repo
  (`Eyevinn/encore-callback-listener` → `encore-api.yaml:341-345`), confirming
  this is not an instance-local quirk.

**Direct consequence: it is contractually impossible to give Encore a credential
to present on the callback leg.** There is no header map, no auth block, and no
URL-credential convention in the job payload. The `authorization: Bearer ${token}`
at `src/encore-scaler/scaler-loop.ts:1002` authenticates *our* dispatch to Encore
and is not and cannot be propagated onto Encore's outbound POST.

---

## 5. Implementation direction for #814

#814 is currently titled/scoped as *"give Encore a credential to authenticate its
progress callback"*. **That approach is not implementable and, more importantly,
not necessary** — sections 4b and 1c respectively. #814 should be re-scoped to a
**readiness gate on the callback path itself**.

### 5a. Why #818 does not close this window — read this before anything else

While this diagnosis was in review, **#818** (`29b669c`, closes **#813**) landed
on `main`. It did exactly what an earlier draft of this section proposed as new
work: `probeCallbackTrust()` now returns `state: 'callback-unusable'` for
`CALLBACK_REJECTED_STATUSES = new Set([401, 403])`
(`src/encore-scaler/callback-trust-probe.ts:77,158-165`) instead of folding a
401/403 into `trusted`, and `ensureCallbackTrust()` handles that state
(`src/encore-scaler/scaler-loop.ts:942-960`).

**That branch can never fire in the #812 window.** #818 changed how the probe
*grades* a response; it did not change *which URL is requested*. `main` still
rewrites the target to `new URL(callbackListenerUrl).origin`
(`callback-trust-probe.ts:138`) and HEADs that origin (`:151`) — and §2's
timelines show the origin answering **200** throughout the window in which
`/encoreCallback` is 401 (run 1: t+21s→t+35s; run 2: t+32s→t+42s). A 200 is not
in `CALLBACK_REJECTED_STATUSES`, so the probe still returns `trusted`, still sets
`callbackTrustReady = true`, and still licenses the first job into the 401
window. **#812 is not fixed by #818.**

Anyone reading #818 and concluding this is already handled would be wrong: #818
fixes the case where the *origin itself* is auth-walled (a real, separate case —
`/healthcheck` and every other path do 401 permanently); #812 is the case where
the origin is open and only the callback path is not.

### 5b. The remaining work for #814

With #818 merged, **step 1 below is the sole remaining code change.**

1. **Probe the real callback path, not the origin.** ✅ **Landed 2026-09-26 as
   #814.** `probeCallbackTrust()` now targets
   `${callbackListenerUrl}/encoreCallback` via a shared `buildCallbackUri()`
   helper that the dispatch-time `progressCallbackUri` injection also uses, so
   the probed URL and the dispatched URL cannot drift. The §5b(2) verb question
   was settled empirically at the same time — see the note under step 2.
   Change `probeCallbackTrust()` (`src/encore-scaler/callback-trust-probe.ts:129-192`)
   to target `${callbackListenerUrl.replace(/\/$/, '')}/encoreCallback` instead
   of `new URL(callbackListenerUrl).origin` (line 138), matching the URI the
   scaler actually injects at `scaler-loop.ts:996`. The origin answers non-401
   before `/encoreCallback` does, so it opens too early; `/encoreCallback` is the
   only URL whose readiness actually matters. The probe's own header comment
   (lines 31-34) explicitly justifies the origin rewrite on TLS grounds — update
   it, since the question is no longer only about the handshake.

2. **Stop treating every HTTP status as success.** ✅ **Already landed in #818.**
   401/403 → `state: 'callback-unusable'`; TLS/handshake signatures →
   `errorClass: 'tls-trust'` (unchanged, preserves #463); every other status →
   `trusted`. No further work needed here — it only becomes *effective* once
   step 1 points it at `/encoreCallback`.

   On verb choice for step 1: the live app returns a Fastify **404** for
   `GET /encoreCallback` and **200** for `POST /encoreCallback`, and a `HEAD`
   is routed as the `GET` (both verified live on a warm instance, §1c). So
   `HEAD`/`GET` reaches the app without invoking the callback handler, and a
   404-from-Fastify proves both TLS trust *and* that the path is no longer
   auth-walled. Do **not** probe with `POST`, which would enqueue a synthetic
   callback.

   ✅ **The inference flagged here was confirmed directly by #814 on
   2026-09-26.** Two more throwaway instances (`diag814a`, `diag814b`, both
   created and destroyed, `DELETE` → 204) were polled with `GET`, `HEAD` and
   `POST` on `/encoreCallback` simultaneously from creation: in `diag814b` all
   three returned 401 together from t+29 s to t+43 s and all flipped together at
   t+44 s. A `HEAD` probe is therefore a faithful proxy for Encore's `POST`.
   The same runs also narrowed the "not determined" question in §2 — `/` went
   200 → Fastify-404 on the *same* tick that `POST /encoreCallback` went
   401 → 200, so the phase-2 200 is definitely not the application. Details in
   `docs/osc-feedback/incoming-callback-listener-ingress-auth-window-fresh-instance.md`.

3. **Keep the bounded wait, and make sure it is long enough.**
   `ensureCallbackTrust()` already re-probes on later ticks within
   `DEFAULT_CALLBACK_TRUST_TIMEOUT_MS = 60_000`
   (`src/encore-scaler/scaler-loop.ts:44,897-898,928-931`), then either records
   the #818 degraded `callbackPathUnusableAt` state (lines 942-960) or
   quarantines (lines 962-980). The observed window closes at t+39s and t+45s
   from instance creation, so 60 s is adequate but not generous; consider raising
   the default to ~120 s once the probe can actually fail on 401.

4. **Do not cache a premature pass — still true today.** `callbackTrustReady` is
   sticky (`scaler-loop.ts:887`, `types.ts:159`), so the premature pass is cached
   for the instance's whole lifetime. Because `main`'s probe still targets the
   origin, **#818 did not fix this**: the gate still caches a pass taken during
   the 401 window. Step 1 is what makes stickiness safe — once the probe fails on
   the callback path's 401, it cannot pass early, and no extra invalidation logic
   is needed. Until step 1 lands, stickiness remains an active defect.

5. **Keep `sweepTerminalJobs` as the backstop.**
   (`src/pipeline/encore-callback-poller.ts:901`.) It is what saved the reported
   run; the gate reduces reliance on it but should not replace it. #818's
   `callbackPathUnusableAt` path already leans on it deliberately.

This is an in-repo fix. No OSC change is required to unblock #814 — but the
underlying platform behaviour is a gap, and is logged as one (section 6).

---

## 6. OSC friction logged

Two distinct platform issues fall out of this. Both are logged, per CLAUDE.md
rule 6, in **this** repo at
[`docs/osc-feedback/incoming-callback-listener-ingress-auth-window-fresh-instance.md`](../osc-feedback/incoming-callback-listener-ingress-auth-window-fresh-instance.md)
— added by this change, alongside the 14 `incoming-*.md` logs already here. (The
earlier TLS-layer log for the same lifecycle band, `#457`'s
`incoming-callback-listener-tls-trust-race-first-job.md`, lives in
`eng-open-videocore-agents`; that repo keeps its own `docs/osc-feedback/`, and
whoever consolidates for submission should pick both up.)

What the log records:

- **The window.** A freshly-created `eyevinn-encore-callback-listener` instance's
  ingress starts answering on `/` ~13–18 s **before** `/encoreCallback` stops
  returning 401, so the origin returns 200 while the callback path is still
  auth-walled. The log states only that observable and explicitly declines to
  assert *why* the origin answers 200 (§2, "not determined") so the platform team
  is not sent after the wrong mechanism. Requested capability: a readiness signal
  that means "ingress routing *and* inbound authorisation are both live on the
  callback path", or ordering the authorisation policy before the hostname starts
  serving.
- **The contract gap.** The inbound authentication policy for per-instance
  ingresses (which paths are auth-walled, which are reachable unauthenticated,
  and from what point in the instance lifecycle) is **not represented anywhere in
  the catalog service record** (`availableServiceInstanceOptions` =
  `["name","RedisUrl","EncoreUrl","RedisQueue"]`, re-fetched live while addressing
  review), so it cannot be verified contract-first ahead of time — it can only be
  discovered empirically, as it was here.
- **One minor, as a footnote in the log.** `GET /mysubscriptions` on the catalog
  answers **500** (`FST_ERR_FAILED_ERROR_SERIALIZATION`) rather than 401 when the
  auth header is present but in the wrong form; the correct header is
  `x-pat-jwt: Bearer <PAT>` (`@osaas/client-core@0.24.0` `lib/context.js:24-31`).

---

## Fact ledger: confirmed vs. inferred

| Fact | Status |
|---|---|
| 401 is emitted by nginx, not the listener app | **Confirmed** — nginx HTML error page + app source has no auth |
| Listener app has no auth code or auth env var | **Confirmed** — `Eyevinn/encore-callback-listener@247ba37` `src/api.ts:53,56,65,69,76`, `src/encoreCallbackApi.ts:23-43`, `src/config.ts:17-31` |
| `/encoreCallback` is reachable unauthenticated in steady state | **Confirmed** — live probe, 4 warm instances (`POST` 200, `GET`/`HEAD` 404-from-Fastify) |
| A fresh instance 401s on `/encoreCallback` for ~13–18 s while the origin already returns 200 | **Confirmed** — 2/2 reproductions, instances created and destroyed live |
| Why the origin returns 200 during that window (allowlist hit vs. ingress placeholder) | **Not determined** — the application answers 404 on `/` once it is up, so the phase-2 200 is not the application; nothing observable from outside distinguishes the two readings. Both yield the same fix |
| `probeCallbackTrust` passes during that window, **including after #818** | **Confirmed** — `HEAD origin → 200` observed in both runs at the moment `/encoreCallback` was still 401; on `main`, 200 ∉ `CALLBACK_REJECTED_STATUSES` (`callback-trust-probe.ts:77`) and the target is still the origin (`:138,151`) |
| Encore's job payload has no callback-credential field | **Confirmed** — live `/v3/api-docs` from an Encore instance; `EncoreJobRequestBody` property list; `components` has only `schemas` |
| Catalog record documents no auth requirement or knob | **Confirmed** — live `/mysubscriptions` record |
| No in-repo regression | **Confirmed** — `git log -S "progressCallbackUri" -- src/encore-scaler/scaler-loop.ts` → single commit `7eb6217` (2026-07-07); the oldest repo-wide **call site**, `f128ae1` (2026-06-02, superseded `backend-api` client), also carried no credential — the three older `-S` hits are a request-schema field that is explicitly not forwarded, a comment and ADR prose |
| The `testsimon` tenant's instance failed for this same reason | **Inferred (high confidence)** — reproduced in tenant `oscaidev`; the reported symptom, path, status code and instance age all match phase 2. Not reproduced in `testsimon` itself, which this session cannot reach |
| A `HEAD`/`GET` on `/encoreCallback` also 401s during the window | **Inferred** — the timed runs probed `POST` only; §1c shows the ingress verdict is method-independent on every path tested. #814 should confirm directly |
| Exact mechanism *inside* the OSC ingress | **Not determined** — black box; observable only from outside. Does not change the fix direction |

---

## Contract sources cited

Live platform (fetched this session):

- `GET https://catalog.svc.prod.osaas.io/mysubscriptions` (`x-pat-jwt: Bearer <PAT>`,
  the header contract in `@osaas/client-core@0.24.0` `lib/context.js:24-31`) →
  `serviceId: "eyevinn-encore-callback-listener"`: `availableServiceInstanceOptions`
  = `["name","RedisUrl","EncoreUrl","RedisQueue"]`, `serviceInstanceOptions` (no
  auth/token/credential option), `serviceAssociations` (`RedisUrl → valkey-io-valkey`,
  `EncoreUrl → encore`), `apiUrl`, `repoUrl`. **Re-fetched 2026-09-25 while
  addressing review — unchanged.**
- `POST https://token.svc.prod.osaas.io/servicetoken` (`x-pat-jwt: Bearer <PAT>`,
  body `{"serviceId":"eyevinn-encore-callback-listener"}`) → `{ token }`, the SAT
  used below.
- `GET https://api-eyevinn-encore-callback-listener.auto.prod-se.osaas.io/encore-callback-listenerinstance` (`x-jwt: Bearer <SAT>`) → instance list + `url` per instance (6 instances on 2026-09-25).
- `GET <encore-instance>/v3/api-docs` → `components.schemas.EncoreJobRequestBody.properties.progressCallbackUri`; `components` keys = `["schemas"]` only (no `securitySchemes`); no top-level `security`.
- Live HTTP probes of listener ingresses, warm and freshly created (tables and
  timelines above). The §1b/§1c steady-state rows were re-run unauthenticated on
  **two** warm instances (`ovc`, `scalerqabeta0911mtwkc5fu`) on 2026-09-25 while
  addressing review — identical results; no `POST` was sent this round, to avoid
  enqueuing a synthetic callback.

Upstream service source:

- `Eyevinn/encore-callback-listener@247ba3721ad0bb578077f9b16a1bc7a7c0ab0640` — `src/api.ts:53,56,65,69,76`, `src/encoreCallbackApi.ts:23-43`, `src/config.ts:17-31`, `encore-api.yaml:341-345`.

This repo (line numbers against `main` incl. #818 / `29b669c`, merged into this
branch):

- `src/encore-scaler/scaler-loop.ts:44` — `DEFAULT_CALLBACK_TRUST_TIMEOUT_MS = 60_000`.
- `src/encore-scaler/scaler-loop.ts:252` — dispatch gated on `ensureCallbackTrust`.
- `src/encore-scaler/scaler-loop.ts:886-980` — `ensureCallbackTrust()`: sticky pass (`:887`), first-probe stamp (`:908-911`), probe (`:913`), bounded wait (`:928-931`), #818 `callback-unusable` degraded path (`:942-960`), quarantine (`:962-980`).
- `src/encore-scaler/scaler-loop.ts:995-997` — `progressCallbackUri` injection (no credential).
- `src/encore-scaler/scaler-loop.ts:998-1005` — dispatch `authorization: Bearer ${token}` (authenticates us → Encore only).
- `src/encore-scaler/callback-trust-probe.ts:138` — origin rewrite (unchanged by #818).
- `src/encore-scaler/callback-trust-probe.ts:77,158-165` — `CALLBACK_REJECTED_STATUSES` / `callback-unusable` (#818).
- `src/encore-scaler/callback-trust-probe.ts:151,169` — `HEAD` on the origin; every non-401/403 status → `trusted`.
- `src/pipeline/encore-callback-poller.ts:901` — `sweepTerminalJobs`, the completion backstop.
- `src/encore-scaler/instance-pool.ts:33-34` — `ENCORE_CALLBACK_LISTENER_SERVICE_ID`.
- `src/encore-scaler/instance-pool.ts:226-236` — paired listener creation (`name`, `RedisUrl`, `EncoreUrl`, `RedisQueue` — matching the catalog options exactly).
- `src/encore-scaler/instance-pool.ts:259` — `callbackListenerUrl: instanceUrl(callback)`.
- `src/encore-scaler/types.ts:151,159-173` — `callbackListenerUrl`, `callbackTrustReady`/`ConfirmedAt`/`FirstProbeAt`/`QuarantinedAt`.
- `node_modules/@osaas/client-core/lib/context.js:24,28,36-45`, `core.js:76-90` — the OSC API access contract used above.

Side note: #814 and several code comments cite
`docs/architecture/ADR-006-encore-autoscaler.md`. **That file does not exist** —
`docs/architecture/ADR-021-audit-log-retention.md:13-15` already records that
`ADR-006` is a known stale reference. The routing behaviour #814 attributes to
ADR-006 is nonetheless accurately described by the code cited above.
