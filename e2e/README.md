# open-videocore e2e

The end-to-end suite and the runner that tests the beta image on OSC (eng-open-videocore-agents#76, #77, #78; design in that repo's `docs/architecture/ADR-007-e2e-gate.md` and `e2e-suite-v1.md`). Not part of the root `ci` run: the root `vitest.config.ts` excludes `e2e/`, and there are no new GitHub jobs.

## Layout

| Path | What |
|---|---|
| `suite/cases.mjs` | the 12 cases (health, auth-required, app-auth-required, auth-accepted, ingest-url, metadata, thumbnails, transcode, package, search, tags-roundtrip, delete) |
| `suite/run.mjs`, `suite/cli.mjs` | runs the cases in order; a failed chain case marks the rest `skipped`; deletes its asset on the way out |
| `runner/cycle.mjs` | one runner cycle: read the commit from the `:latest` image label; skip if that commit already has a green or red result, create-or-restart the instance, wait for `/health` `build.commit` to equal `main`'s head, run the suite, record. Statuses: `green`, `red`, `stale`, `infra-error` |
| `runner/stack.mjs` | makes sure the instance has a provisioned stack (`GET`/`POST /api/v1/provision/`): a fresh instance has no backing storage and ingest answers `500 object storage is not configured for this stack` |
| `runner/adapters.mjs` | the `:latest` image's digest and commit (registry label), OSC instance create/restart (beta channel), `/health` probe |
| `runner/store-s3.mjs`, `runner/store-file.mjs` | result store on an S3-compatible bucket (MinIO) or a directory; same keys (`results/by-commit/<sha>.json`, `results/latest.json`); the commit is validated (40 hex) before it becomes a key |
| `runner/wire.mjs`, `runner/cli.mjs` | environment to dependencies; one cycle; exit 0 only for green |
| `suite/sweep.mjs` | deletes `e2e-*` assets older than an hour that a crashed run left behind (runs before the cases) |
| `job/run_cycle.py` | the OSC My Job entrypoint: installs Node from the `nodejs-wheel-binaries` wheel if none is on PATH, `npm ci`, runs one cycle |
| `fixtures/clip.mp4` | 6 s, 640x360, H.264 + AAC, 372 KB, generated from ffmpeg test sources (no third-party content) |
| `test/` | `node:test`: the suite against `mock-server.mjs`, the cycle with fake adapters, the adapters with fake `fetch` and a fake OSC client |

## Run

```bash
cd e2e && npm install        # only @osaas/client-core, used by the runner
npm test                     # offline, no network
BASE_URL=... TOKEN=... SOURCE_URL=https://.../clip.mp4 [EXPECT_COMMIT=<sha>] npm run suite
GHCR_USER=... GHCR_TOKEN=... OSC_ACCESS_TOKEN=... E2E_INSTANCE_OSC_ACCESS_TOKEN=... \
  E2E_PARAMETER_STORE=... E2E_PARAMETER_STORE_API_KEY=... E2E_MINIO_ROOT_PASSWORD=... \
  E2E_COUCHDB_ADMIN_PASSWORD=... E2E_SOURCE_URL=... E2E_RESULTS_DIR=./out npm run cycle
```

## What the first live runs taught us (2026-10-08)

- Instances created with `createInstance()` are on the **stable** channel (`channel: stable`, image `:stable`). A beta instance needs `POST <service apiUrl>?beta=true`; the runner now does that and removes a stable instance it finds.
- Two layers authenticate a call. The platform ingress answers **every** anonymous request with nginx's 401, `/health` included, and wants `x-jwt: Bearer <service access token>`. The application then wants `Authorization: Bearer <non-empty>` (a presence check; `src/auth/middleware.ts`) and answers `401 missing access token` without it; the ingress does not translate one into the other (the platform's own `call-service-endpoint` hits the same 401 on `/api/v1/assets/`). The client sends both. `auth-required` (anonymous) proves the instance is not publicly open; `app-auth-required` (`x-jwt` only) reaches the application's own gate, the #711 regression guard.
- A fresh instance has **no backing storage**: ingest answers `500 "object storage is not configured for this stack"`. The runner provisions one stack (name `E2E_STACK_NAME`, default `e2e`) with `POST /api/v1/provision/`, which creates three OSC instances named after the stack: MinIO (storage), CouchDB (metadata) and Valkey (queue). Encore, its callback listener and the packager are not part of it; the auto-scaler and the first packaging step start them on demand. With no `X-Stack-Name` header the instance uses the first listed stack, so one stack is the default. A recreated instance (for example after a channel switch) needs provisioning again; the step is idempotent, and a failure is recorded as `infra-error`, not `red`.
- `restartInstance()` returns before the old pod is gone and `waitForInstanceReady()` sees the old pod as ready, so the first registry-based run finished in 4 s against what was probably the pre-restart pod. The adapter now waits for a `Server listening` log line newer than the restart request.
- The job platform appears to **re-run a job that exits non-zero** shortly afterwards (about 20 s later, repeatedly), despite documenting no retries. The runner therefore exits 0 for every recorded verdict and non-zero only when it itself breaks; the verdict is in the bucket.
- The platform builds the image without git metadata: on a live **beta** instance `/health` reports `build.commit`, `build.sourceDigest` and `version` as `unknown`, so nothing in `/health` identifies the build (the product's `scripts/source-digest.mjs` only works when its own Dockerfile does the build). Identity therefore comes from the registry: the image's label `io.osaas.repo.commit`, read before the restart and again when the instance is ready.

## What is and isn't verified

Verified: every path, field and enum in the suite against `openapi.json` v1.5.0; the `@osaas/client-core` 0.24.0 signatures the OSC adapter calls (`lib/core.d.ts`, `lib/context.d.ts`); the instance config options from the service schema of `eyevinn-open-videocore`. The suite's logic and the cycle's branches are tested offline.

**Not verified, needs the first live run:**
- The authenticated registry path (token exchange, index, manifest, config blob) has only been exercised against a fake; the first live run is its test. It needs `GHCR_USER` and a read-only `GHCR_TOKEN` (`read:packages`) in the job's parameter store.
- That the pod really pulled the image the label was read from. The double reading catches `:latest` moving during the restart; it cannot prove which image the pod pulled.
- That the commit of the checkout is the commit the `:latest` image was built from, which the promote workflow reads from the image label `io.osaas.repo.commit`.
- The mock server proves the suite's logic, not that the real service behaves as the contract says. No instance existed in the workspace to run against.
- Whether a new instance created this way lands on the beta image. The cycle guards it: if `/health` `build.commit` is not `main`'s head the result is `stale`, never green.
- The `instance.url` field name (documented in the client's `createInstance` example only).
- Encore reachability from the runner's tenant, and how long transcode and package take (the 600 s timeouts are a guess).

## Scheduling (OSC My Job)

My Jobs run Python (python-job-runner limits, from `get-runtime-limits`: 512 Mi, 6 h max, one run at a time,
no retry, no disk kept between runs, cron in UTC). `job/run_cycle.py` bridges to Node. Create it with:

- `sourceUrl`: `https://github.com/Eyevinn/open-videocore`
- `workerCmd`: `python e2e/job/run_cycle.py`
- `cronSchedule`: `*/15 * * * *`
- `configService`: a parameter store holding the variables below, **not** the one the agent tasks load

Variables: `GHCR_USER`, `GHCR_TOKEN` (read:packages), `OSC_ACCESS_TOKEN`, `E2E_INSTANCE_OSC_ACCESS_TOKEN`,
`E2E_PARAMETER_STORE`, `E2E_PARAMETER_STORE_API_KEY`, `E2E_MINIO_ROOT_PASSWORD`, `E2E_COUCHDB_ADMIN_PASSWORD`,
`E2E_S3_ENDPOINT`, `E2E_S3_BUCKET`, `E2E_S3_ACCESS_KEY`, `E2E_S3_SECRET_KEY`, and
`E2E_SOURCE_URL=https://raw.githubusercontent.com/Eyevinn/open-videocore/main/e2e/fixtures/clip.mp4`
(optional `GITHUB_TOKEN`, `E2E_INSTANCE_NAME`, default `ovce2e`).

## Not built / not verified yet

- The job itself is not created and the bucket does not exist. Nothing has run in OSC.
- Unknown until the first run in the job pod: network access and `pip` there (the shim exits 70 with a clear
  message if the wheel can't be installed), and whether `workerCmd` runs from the repository root.
- The instance's ingest may refuse the raw.githubusercontent.com URL (SSRF rules); then host the clip in the
  runner's bucket instead.
- Everything under "Not verified, needs the first live run" above.
