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

## Workaround in this repo

Probe the callback path itself rather than the ingress origin, and keep a
poll-based backstop for terminal job state
(`src/pipeline/encore-callback-poller.ts` `sweepTerminalJobs`) so a missed
callback degrades to slower completion rather than a stuck job. Tracked as `#814`.
No OSC change is required to unblock that fix — this log is about the platform
gap that makes the workaround necessary, not a blocker on it.

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
- Fresh-instance phase timings are from the two timed create/destroy runs recorded
  in `docs/findings/callback-401-812.md` §2 (2026-09-25 session); they were not
  re-run for this log.
