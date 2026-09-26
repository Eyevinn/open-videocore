# OSC friction — a fresh callback-listener instance's ingress answers on `/` before inbound authorisation is live on `/encoreCallback` (issue #812)

**Date:** 2026-09-25
**Surface:** backend-api (`src/encore-scaler`)
**Service:** `eyevinn-encore-callback-listener` (per-instance ingress), paired with `encore`
**Tenant/workspace observed in:** `oscaidev` (reported originally from `testsimon`)
**Related:** `Eyevinn/open-videocore#812` (diagnosis, `docs/findings/callback-401-812.md`),
`#811` (parent symptom), `#814` (paired fix), `#813`/`#818`, and the earlier
first-job freshness race `#457`/`#463`
(`docs/osc-feedback/incoming-callback-listener-tls-trust-race-first-job.md` in
`eng-open-videocore-agents`, which caught the same lifecycle band at the TLS layer)

## What we needed

The Encore auto-scaler creates one `eyevinn-encore-callback-listener` instance per
Encore instance and passes the listener's per-instance URL to Encore as
`progressCallbackUri` so Encore can POST progress/completion callbacks
(`src/encore-scaler/instance-pool.ts:226-236`, `src/encore-scaler/scaler-loop.ts:995-997`).
Before dispatching the first job to a fresh instance we need to know one thing:
**is `POST /encoreCallback` on that listener actually deliverable yet?**

## Friction

### 1. The callback path is auth-walled for ~13–18 s after the ingress starts answering

On a freshly created instance the per-instance ingress goes through three phases
(two timed reproductions, instances created and destroyed via the live OSC API;
full timelines in `docs/findings/callback-401-812.md` §2):

| Phase | `GET`/`HEAD` on the origin (`/`) | `POST /encoreCallback` |
|---|---|---|
| 1 — hostname not answering (0 → ~20–30 s) | no connection | no connection |
| 2 — **the problem window** (~13–18 s) | **200** | **401**, nginx HTML error page |
| 3 — steady state (from t+39 s / t+45 s) | 404 from the application | **200**, unauthenticated |

A job dispatched during phase 2 produces exactly the reported failure:

```
Sending progress callback failed
401 Unauthorized from POST https://<workspace>-<instance>.eyevinn-encore-callback-listener.auto.prod-se.osaas.io/encoreCallback
```

The 401 is an **nginx** error page, so it is the platform ingress, not the
service: the listener application has no auth plugin, no `onRequest`/`preHandler`
hook and no auth/secret environment variable at all (see "Contract sources"
below). In steady state the ingress passes `/` and `/encoreCallback` through
unauthenticated and 401s every other path — so there is no standing token
requirement on the callback path. The problem is purely that the hostname starts
serving **before** that unauthenticated allowance covers `/encoreCallback`.

**We deliberately do not assert *why* the origin answers 200 during phase 2.**
Two readings fit the data equally well — (a) `/` is on the unauthenticated
allowlist and `/encoreCallback` is added to it slightly later, or (b) the phase-2
200 on `/` is an ingress-level placeholder rather than the application (the
application answers 404 on `/` once it is genuinely up). Nothing observable from
outside the ingress distinguishes them, so the mechanism inside the ingress is
**not determined** here and the platform team should not be sent after a
specific one.

Why this bites harder than an ordinary startup race: the phase-2 divergence means
the origin is the *one* URL that looks healthy while the callback path is still
rejecting. Any readiness check aimed at the origin passes during the window. Ours
was (`src/encore-scaler/callback-trust-probe.ts:138`, added for the `#457` TLS
race), so the gate meant to prevent a premature first job actively licensed one.

### 2. The ingress's inbound authorisation policy is not in the catalog contract

Nothing in the service record describes which paths on a per-instance ingress are
reachable unauthenticated, which are auth-walled, or when that policy becomes
effective relative to the hostname starting to serve. Fetched live this session,
`availableServiceInstanceOptions` for `eyevinn-encore-callback-listener` is
exactly `["name", "RedisUrl", "EncoreUrl", "RedisQueue"]`, and
`serviceInstanceOptions` carries no auth-, token- or credential-shaped option.
So a consumer cannot verify this behaviour contract-first ahead of time — it can
only be discovered empirically, by shipping a job into the window and reading the
401, which is how we found it.

This compounds with the Encore side: `progressCallbackUri` is a bare string in
Encore's own OpenAPI contract with no companion credential field, and that
contract declares no `securitySchemes` and no top-level `security` at all. There
is therefore no supported way to attach a credential to the callback leg even if
the ingress did require one — the only available lever is *when* we dispatch.

## Requested capability

1. **A readiness signal that means "ingress routing *and* inbound authorisation
   are both live on the callback path"** — or, equivalently, apply the
   authorisation policy for a per-instance ingress *before* the hostname begins
   serving, so that "the hostname answers" implies "the allowlisted paths are
   allowlisted". Today the only trustworthy readiness probe is a request to the
   exact path we intend to use, which for a callback receiver means sending a
   synthetic `POST` to a production endpoint.
2. **Represent the per-instance ingress auth policy in the catalog service
   record** (which paths are reachable unauthenticated, and from what point in
   the instance lifecycle), so integrators can verify it from the contract
   instead of probing production.
3. Minor, encountered while gathering the above: `GET https://catalog.svc.prod.osaas.io/mysubscriptions`
   with a wrong-but-present auth header returns **HTTP 500**
   `FST_ERR_FAILED_ERROR_SERIALIZATION` ("Failed to serialize an error … Original
   error: Format is Authorization: Bearer [token]") instead of a 401 with that
   message. The correct header is `x-pat-jwt: Bearer <PAT>`
   (`@osaas/client-core@0.24.0` `lib/context.js:24-31`); the 500 makes an auth
   mistake look like a platform outage.

## Workaround in this repo — now implemented (`#814`, 2026-09-26)

`#814` was filed as "give Encore a credential to authenticate its progress
callback". That is **not implementable**, and re-verifying it live is what
selected the workaround below. Per the issue's own second direction bullet
("if the 401 originates from an OSC platform-level ingress policy Encore cannot
satisfy: this is an OSC capability gap … log it alongside a description of the
workaround/mitigation chosen here"), this section is that description.

**Why the credential framing has no landing zone** (both re-fetched live
2026-09-26, not inherited from the earlier session):

- Encore cannot carry one. `GET <encore-instance>/v3/api-docs` →
  `components.schemas.EncoreJobRequestBody.properties.progressCallbackUri` is
  `{"type":"string"}`, and the full property set contains no auth/token/
  credential/header/secret/bearer/apiKey field. `components` has only `schemas`
  (**no `securitySchemes`**), there is no top-level `security`, and
  `POST /encoreJobs` declares no header parameters.
- The listener cannot validate one. `availableServiceInstanceOptions` is still
  exactly `["name","RedisUrl","EncoreUrl","RedisQueue"]`.

**Mitigation shipped instead:** the readiness gate now probes the callback path
rather than the ingress origin. `probeCallbackTrust()` targets
`${callbackListenerUrl}/encoreCallback` — built by the shared
`buildCallbackUri()` helper that the dispatch-time `progressCallbackUri`
injection also uses, so the URL we grade and the URL Encore POSTs to cannot
drift. The existing `#813`/`#818` grading (401/403 → `callback-unusable`) then
fires during the window, holding the instance ineligible for its first job until
the window closes, and `sweepTerminalJobs`
(`src/pipeline/encore-callback-poller.ts`) stays as the completion backstop.

The mitigation is timing-only. It does not make the callback leg authenticated —
it cannot, per the two contracts above — so requested capabilities 1 and 2 below
still stand.

### Two facts confirmed for the first time while implementing this

Two throwaway instances (`diag814a`, `diag814b`) were created and destroyed
(both `DELETE` → 204; instance list re-read afterwards, no residue) on
2026-09-26, polling from creation:

1. **The ingress verdict during the window is method-independent.**
   `docs/findings/callback-401-812.md` could only *infer* this and asked `#814`
   to confirm it directly. Confirmed: in `diag814b`, `GET`, `HEAD` and `POST` on
   `/encoreCallback` all returned 401 together from t+29 s to t+43 s and all
   flipped together at t+44 s. A `HEAD` probe is therefore a faithful proxy for
   the `POST` Encore makes, without enqueuing a synthetic callback.
2. **The phase-2 `200` on `/` is not the application.** It is served while
   `/encoreCallback` is still 401 and disappears the moment the application
   comes up, at which point `/` flips to Fastify's 404 — in `diag814b`, `origin`
   went 200 → 404 at exactly the t+44 s tick that `POST /encoreCallback` went
   401 → 200. This narrows, but does not fully settle, the "not determined"
   question in §1 above: whatever answers `/` with a 200 during phase 2 stops
   doing so once the app is live, which is consistent with reading (b) (an
   ingress-level placeholder) and not with `/` being served by the application.
   The mechanism inside the ingress remains unobservable from outside.

Measured window, both runs (t = seconds from instance creation):

| | origin `/` 200 from | `/encoreCallback` 401 until | window length |
|---|---|---|---|
| `diag814a` | t+25 s | t+38–41 s | ~14 s |
| `diag814b` | t+30 s | t+43 s | ~14 s |

This reproduces the ~13–18 s window recorded in §1 from the `#812` session, on a
different day, so the behaviour is stable rather than a one-off.

## Contract sources verified (this session, live)

- `GET https://catalog.svc.prod.osaas.io/mysubscriptions` with
  `x-pat-jwt: Bearer <PAT>` → record `serviceId: "eyevinn-encore-callback-listener"`;
  `availableServiceInstanceOptions` = `["name","RedisUrl","EncoreUrl","RedisQueue"]`;
  `serviceAssociations` = `RedisUrl → valkey-io-valkey`, `EncoreUrl → encore`;
  `apiUrl`, `repoUrl: https://github.com/Eyevinn/encore-callback-listener`.
- `GET https://api-eyevinn-encore-callback-listener.auto.prod-se.osaas.io/encore-callback-listenerinstance`
  with `x-jwt: Bearer <SAT>` → 6 live instances with per-instance `url`.
- Unauthenticated read-only probes of two warm instances (`ovc`,
  `scalerqabeta0911mtwkc5fu`), re-run 2026-09-25: `GET /` → 404 JSON (Fastify),
  `GET /encoreCallback` → 404 JSON, `HEAD /encoreCallback` → 404,
  `GET /healthcheck` → 401 nginx HTML, `GET /docs` → 401, `GET /nope` → 401.
  Steady-state allowlist confirmed; no standing credential requirement on
  `/encoreCallback`.
- `Eyevinn/encore-callback-listener@247ba3721ad0bb578077f9b16a1bc7a7c0ab0640`:
  `src/api.ts:53,56,65,69,76` (five plugin registrations: `cors`, `swagger`,
  `swaggerUI`, `healthcheck`, `encoreCallbackApi` — no auth hook),
  `src/encoreCallbackApi.ts:23` (`fastify.post<{ Body: JobProgress }>` on
  `/encoreCallback`), `src/config.ts:17-31` (`readConfig()` reads only `HOST`,
  `PORT`, `REDIS_URL`, `REDIS_QUEUE`, `ENCORE_URL`).
- `Eyevinn/encore-callback-listener@247ba37` `encore-api.yaml:341-345` —
  `progressCallbackUri: {type: string, description: "An url to which the progress
  status callback should be directed", nullable: true}`; a repo-wide grep of that
  contract for `securitySchemes`, top-level `security`, `authorization`, `bearer`,
  `apiKey`, `token`, `secret`, `credential` returns **no matches**.
- Fresh-instance phase timings in §1 are from the two timed create/destroy runs
  recorded in `docs/findings/callback-401-812.md` §2 (2026-09-25 session). They
  were independently reproduced on 2026-09-26 for `#814` (runs `diag814a` /
  `diag814b`, tabulated above).

Additionally verified live 2026-09-26 while implementing `#814`:

- `GET https://catalog.svc.prod.osaas.io/mysubscriptions` (`x-pat-jwt: Bearer <PAT>`)
  → `eyevinn-encore-callback-listener`: `availableServiceInstanceOptions` =
  `["name","RedisUrl","EncoreUrl","RedisQueue"]`, unchanged; all four
  `serviceInstanceOptions` entries re-read, none auth/token/credential-shaped.
- `POST https://token.svc.prod.osaas.io/servicetoken` (`x-pat-jwt: Bearer <PAT>`,
  body `{"serviceId":"encore"}`) → `{ token }`, used as `x-jwt: Bearer <SAT>` below.
- `GET https://oscaidev-scalerqa2609160604mu3piiqh.encore.auto.prod-se.osaas.io/v3/api-docs`
  → HTTP 200, 22 949 bytes, `openapi: 3.1.0`, `info.title: "Encore OpenAPI"`.
  `components` keys = `["schemas"]` only; top-level `security` absent;
  `paths./encoreJobs.post.parameters` = none.
  `components.schemas.EncoreJobRequestBody.properties` =
  `baseName, completedDate, createdDate, debugOverlay, duration, externalId, id,
  inputs, logContext, message, output, outputFolder, priority, profile,
  profileParams, progress, progressCallbackUri, seekTo, segmentLength, speed,
  startedDate, status, thumbnailTime` — regex scan for
  `auth|token|credential|header|secret|bearer|apikey` over that property list
  returns **no matches**.
- Unauthenticated probes of three warm instances (`ovc`,
  `scalerqabeta0911mtwkc5fu`, `scalerqa2609160604mu3piiqh`): `HEAD /` → 404,
  `HEAD /encoreCallback` → 404, `GET /encoreCallback` → 404 with body
  `{"message":"Route GET:/encoreCallback not found","error":"Not Found","statusCode":404}`,
  `HEAD /healthcheck` → 401. Confirms a `HEAD` probe of `/encoreCallback` grades
  a healthy listener as `trusted` (404 ∉ the rejected-status set), i.e. the
  `#814` change does not regress the steady-state path.
- In-repo call sites re-read before editing: `src/encore-scaler/scaler-loop.ts`
  `dispatch()` (`progressCallbackUri` assignment) and `ensureCallbackTrust()`;
  `src/encore-scaler/callback-trust-probe.ts` `probeCallbackTrust()` /
  `CALLBACK_REJECTED_STATUSES`; `src/encore-scaler/instance-pool.ts:440-442`
  (listener created with exactly `RedisUrl` / `EncoreUrl` / `RedisQueue`, matching
  the catalog options).
