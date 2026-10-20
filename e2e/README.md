# open-videocore e2e

The end-to-end suite and the runner that tests the beta image on OSC (eng-open-videocore-agents#76, #77, #78; design in that repo's `docs/architecture/ADR-007-e2e-gate.md` and `e2e-suite-v1.md`). Not part of the root `ci` run: the root `vitest.config.ts` excludes `e2e/`, and there are no new GitHub jobs.

## Layout

| Path | What |
|---|---|
| `suite/cases.mjs` | the 12 cases (health, auth-required, app-auth-required, auth-accepted, ingest-url, metadata, thumbnails, transcode, package, search, tags-roundtrip, delete) |
| `suite/run.mjs`, `suite/cli.mjs` | runs the cases in order; a failed chain case marks the rest `skipped`; deletes its asset on the way out. Status `infra-error` when every failure was a platform failure, `red` as soon as one failure is the image's own |
| `runner/cycle.mjs` | one runner cycle: read the commit from the `:latest` image label; skip if that commit already has a green or red result, create-or-restart the instance, wait for `/health` `build.commit` to equal `main`'s head, run the suite (once more if the first run ends `infra-error`), record. Statuses: `green`, `red`, `stale`, `infra-error` |
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

## Platform failures are not red (#1248)

`green` and `red` are final per commit: once a commit has one, `runCycle` skips it, and a red one blocks promotion
until someone deletes the record by hand. A platform hiccup must therefore not record red. `infra-error` is not
final, so the next cycle tries the same commit again.

- **In the `transcode` case.** Infrastructure:
  - a 502/503/504 on the transcode request or on a read of its job. On `POST /api/v1/assets/{id}/transcode`,
    openapi.json v1.5.0 documents **504** as `{error: "dependency_unreachable", dependency:
    "queue"|"encore"|"storage", endpoint, message}` — `dependency` is 504's alone — and **502** as the generic
    `{error, message}`; **503** is not documented, it is the ingress answering for the instance (an HTML page with no
    JSON at all). `GET /api/v1/jobs/{id}` documents only 200 and 404, so any of the three on a job read is the
    ingress too.
  - a job read that is never answered at all — a dropped connection (`TypeError: fetch failed`), a TLS failure, the
    `AbortError` from the 30 s per-request budget. A single blip does not end the wait: the read is retried on the
    next tick and only three unanswered reads **in a row** end it, as `infra-error` (`observed.readErrors`,
    `observed.lastReadError`). Any other error that breaks the wait itself is infrastructure whatever the job was
    last seen doing — a transport error is no evidence about the encode.
  - a timeout while the job reported `interrupted: true` or any `interruptionReason`. openapi.json v1.5.0
    `GET /api/v1/jobs/{id}` describes `interrupted` as "an infrastructure/topology event (not a media failure)" with
    the job "being auto-retried" and staying `running`, and `interruptionReason: interrupted_by_scaledown` as
    "RECOVERABLE and typically AUTO-RETRIED by the service". Such a job gets its own phase word, `interrupted`.
  - a timeout while the job never left `pending`/`queued` — nothing ever picked the job up.

  Still red: a job that reaches a terminal `failed` state, a **non-interrupted** job that ran and stopped
  progressing (reported as `stalled` or `running`), and a job that completes with no renditions. A deterministic
  encode failure (#1167) stays red.
- **What the timeout saw.** A transcode failure carries `observed` in the verdict — `jobStatus`, `progress`,
  `maxProgress`, `phase` (`queued`, `running`, `stalled`, `interrupted` or the terminal status), `polls`, and
  `attempts` / `interrupted` / `interruptionReason` / `readErrors` / `lastReadError` when there are any — and repeats
  it in the case `detail`, so the verdict says whether the job was queued, running, stalled or interrupted rather
  than only that 900 s went by. `observed` goes through the same credential masking as `detail`, because its
  `error`/`message` fields are copied from an upstream response body.
- **One retry.** When a suite run ends `infra-error` the cycle runs the whole suite once more (`opts.suiteRetries`,
  default 1) before recording anything. Only the last run is the verdict; `suiteAttempts` says how many runs it took
  and `retriedAfter` keeps the failure that was retried away.
- **Budgets.** `timeouts.transcodeMs` is **900 s**. Cold starts of 343 s and 382 s were measured on 2026-10-19
  because every run spawns a fresh encode instance, which left no room under the old 600 s. Every budget is
  overridable per instance: `E2E_TIMEOUT_TRANSCODE_MS`, `E2E_TIMEOUT_PACKAGE_MS`, `E2E_TIMEOUT_INGEST_MS`,
  `E2E_TIMEOUT_READY_MS`, `E2E_TIMEOUT_METADATA_MS`, `E2E_TIMEOUT_SEARCH_MS` (ms; a value that is set but is not a
  positive number is a configuration error, exit 2).
- **The alert** for `infra-error` says it is an infrastructure problem, that it is not a verdict on the code, and
  that the commit is retried on the next cycle. It never calls it red.

## What the first live runs taught us (2026-10-08)

- Instances created with `createInstance()` are on the **stable** channel (`channel: stable`, image `:stable`). A beta instance needs `POST <service apiUrl>?beta=true`; the runner now does that and removes a stable instance it finds.
- **Delete is soft.** `DELETE /api/v1/assets/{id}` sets `status: archived` (`force` only bypasses the delete lock); the asset still reads 200 as `archived` until the purge sweep tombstones it (then 410). The `delete` case accepts `archived`, 404 or 410, and the leftover sweep skips archived assets.
- **Transcode profile.** The first runnable profile in `GET /api/v1/profiles/` is `archive` (DNxHD video and 24-bit PCM audio in MXF). The packager rejects it (`Failed to detect the container type`, read from the packager's own log on 2026-10-09), and because the failed packager never calls back, the app shows no `packagingError` and no manifest URLs. The suite therefore uses a named profile, `program` by default (`E2E_TRANSCODE_PROFILE` overrides it), and fails clearly if the profile is not on the instance. On a package timeout it reports the package job's state.
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
- Encore reachability from the runner's tenant. Transcode now has a measured basis: 343 s and 382 s on 2026-10-19,
  both cold starts, hence the 900 s budget. The 600 s package budget is still a guess.

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
(optional `GITHUB_TOKEN`, `E2E_INSTANCE_NAME`, default `ovce2e`, `E2E_SLACK_BOT_TOKEN`, `E2E_SLACK_CHANNEL`, and the
`E2E_TIMEOUT_*_MS` budget overrides above).

**Slack alert.** With `E2E_SLACK_BOT_TOKEN` set (a bot token with `chat:write`, kept in the parameter store; the bot must be a member of the channel), to `E2E_SLACK_CHANNEL` (default `#internal-dev-mediaconvert`), the runner posts when a verdict is `green` or `red` (each is final, so once per commit), or the first time a commit ends `infra-error` (worded as an infrastructure problem that will be retried, not as red). `stale` is silent, and a skipped cycle never posts. A failed post is logged in the cycle output (`notifyError`) and does not change the exit code.

## Not built / not verified yet

- The job itself is not created and the bucket does not exist. Nothing has run in OSC.
- Unknown until the first run in the job pod: network access and `pip` there (the shim exits 70 with a clear
  message if the wheel can't be installed), and whether `workerCmd` runs from the repository root.
- The instance's ingest may refuse the raw.githubusercontent.com URL (SSRF rules); then host the clip in the
  runner's bucket instead.
- Everything under "Not verified, needs the first live run" above.
