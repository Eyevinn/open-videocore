# 991 — Which object-store endpoint each path uses, and why

**Date:** 2026-09-30
**Author:** surface-backend-api agent
**Type:** change record + sibling-path audit (accompanies the #991 fix)
**Related:** #293, #294 (`docs/investigations/294-minio-ingress-longlived-connections.md`), #295, #804

## What changed

Spawned transcoders are now given the **in-cluster** object-store Service
address instead of the stack's public ingress URL, so a long single-connection
read of a large source never crosses the ingress that was severing it
(`upstream prematurely closed connection while sending to client` → ffmpeg
`Stream ends prematurely` → `io-retryable` retries exhausted; see the #294
investigation, which established the ingress timeout is not configurable and
left retry as the only mitigation).

Derivation, from the **stored public endpoint** — no new stack-config field, no
data migration:

```
https://<instance>.minio-minio.auto.<env>.osaas.io
      -> http://<instance>.minio-minio.svc.cluster.local:8080
```

Implementation: `src/services/internal-minio-endpoint.ts`
(`deriveInternalEndpoint`, `makeInternalEndpointProbe`,
`makeInternalEndpointResolver`, `resolveInternalEndpointSettings`), wired into
the single endpoint seam `resolveEncoreS3Config`
(`src/services/encore-s3-config.ts`) from `activateScaler` in `src/main.ts`.

It is **opt-out**, **probe-gated**, and **fails soft**: the in-cluster name is
used only after a live liveness probe from this API's own pod succeeds; a
non-derivable host, a failed probe, or a probe that throws all return the public
endpoint with a logged warning. Nothing on this path can throw or fail startup —
which is what makes it safe given CLAUDE.md's warning that `svc.cluster.local`
does not resolve cross-cluster.

Configuration (all optional, read only in `src/main.ts`):

| Env var | Default | Meaning |
|---|---|---|
| `ENCORE_S3_INTERNAL_ENDPOINT` | on | `off`/`false`/`0`/`no`/`disabled` opts out entirely |
| `ENCORE_S3_INTERNAL_PORT` | `8080` | Service port for the S3 API |
| `ENCORE_S3_INTERNAL_PROBE_TIMEOUT_MS` | `3000` | liveness probe timeout |

## Sibling-path audit

Every path that carries an object-store endpoint, and what it does now.

| Path | Code | Endpoint | Decision |
|---|---|---|---|
| Transcoder spawn — lazy (per request) | `workspace-registry.ts:206-209` (`getOrCreate`) → `resolveS3Config` | **internal** (probe-gated) | **Updated.** This is the path the failing transcodes took. |
| Transcoder spawn — restart resume | `workspace-registry.ts:346-351` (`resumeExistingWorkspaces`) → `resolveS3Config` | **internal** (probe-gated) | **Updated.** Same seam, so it was covered by construction rather than by a second edit. |
| Transcoder **output writes** | `src/pipeline/transcode.ts:121` builds a bare `s3://<packagedBucket>/…` output URI; the transcoder resolves it against the endpoint it was spawned with (`instance-pool.ts:369`) | **internal** | **Updated** — implicitly and unavoidably: reads and writes share one endpoint. Path-style addressing (the public ingress serves only the exact host, no bucket wildcard) means the signed host and the fetched host stay equal as long as the endpoint is changed consistently, which it is. |
| Static operator override | `ENCORE_S3_ENDPOINT` → registry `s3Config` | **verbatim** | **Deliberately untouched.** `mapEndpointForTranscoder` skips the hook when a complete static endpoint + secret pair is configured: an explicitly pinned endpoint must never be silently substituted. |
| Presigned upload URLs | `WorkspaceStorage.presignedPut` / `presignedUploadPart` (`src/data/storage.ts:124-205`) | **public** | **Must stay public.** Handed to a browser; SigV4 signs the Host header and an in-cluster name does not resolve outside the cluster. Built from the storage client the resolver constructs from the stored public `StackConfig.minioEndpoint` — a path this change is not wired into. Asserted by test (`internal-minio-endpoint.test.ts`, "client-facing URLs stay public"). |
| Playback / delivery / asset URLs, API responses | `src/pipeline/packaging.ts` public manifest URL, delivery routes, `src/routes/assets.ts` | **public** | **Must stay public.** Same reason. |
| Ephemeral ffmpeg job runners: thumbnail, re-wrap, clip | `src/main.ts` `runnerFactory(...)` → `s3Endpoint: s3.endpoint` from `request.connections.s3Config` | **public** | **Intentionally left public.** Reachability from the job-runner namespace to the in-cluster Service was **not verified** by #991, and these jobs are short seeks / stream copies (plus a metadata probe over a presigned GET), not the multi-minute single-connection whole-source read that #294/#991 is about. Revisit when a runner-side probe exists; the derivation helper is already reusable. |
| Packager | `src/services/packager-provisioning.ts` `buildPackagerCreateBody` → `S3EndpointUrl`, from `main.ts` `ensurePackaging` coords | **public** | **Intentionally left public.** Fixed in the create body at provision time, so unlike the transcoder there is no per-spawn seam to flip — changing it for a running packager means re-provisioning it. #991 left both "can `S3EndpointUrl` change without re-provisioning" and "can the packager namespace reach the in-cluster address" unverified, so this is not changed on an assumption. |
| Stored stack config | `StackConfig.minioEndpoint` (`src/services/param-store.ts:52`) | **public** | **Unchanged by design.** The internal endpoint is derived at spawn time, so nothing is persisted and no migration is needed. Asserted by test. |

## Still to verify (operator step — cannot be done in code review)

1. **A real transcode of a comparable source (~240 MB) against the internal
   endpoint**, on dev or prod-se. Until that runs, #991 is not "fixed". What is
   inferred rather than proven: that the transcoder's S3 client accepts a plain
   `http`, non-443 `svc.cluster.local` endpoint (curl-level reachability *is*
   proven; transcoder-side behaviour is not), and that its path-style addressing
   is host-independent (inferred from the ingress config, not from transcoder
   source). If it rejects the endpoint, set `ENCORE_S3_INTERNAL_ENDPOINT=off` —
   that alone restores the previous behaviour, with no other change.
2. **Probe scope.** The liveness probe runs from this API's pod, not from a
   transcoder pod — different namespaces in the same cluster, with no
   NetworkPolicy separating them (verified in #991). It is a sound proxy signal,
   but it *is* a proxy.
3. **Dev (non-prod-se) Service port** was not checked. If it differs, set
   `ENCORE_S3_INTERNAL_PORT`; if the probe fails there the deployment simply
   keeps using the public endpoint and logs a warning.

## Operator step for already-provisioned stacks

No data migration: the stored config keeps the public URL and the internal
address is derived per spawn.

Transcoder instances that are **already running** keep the endpoint they were
spawned with. After this is deployed and the API restarted, they have to be
removed (or left to idle-reap, `ENCORE_IDLE_TIMEOUT_MS`, default 5 minutes) so
the scaler respawns them against the internal endpoint. Confirm the change took
effect from the API log line:

```
encore-scaler: using the in-cluster object-store endpoint for transcoder reads/writes
```

A warning instead of that line names which fallback was taken (not derivable, or
probe failed) and the transcodes keep working exactly as they did before.
