# open-videocore e2e

The end-to-end suite and the runner that tests the beta image on OSC (eng-open-videocore-agents#76, #77, #78; design in that repo's `docs/architecture/ADR-007-e2e-gate.md` and `e2e-suite-v1.md`). Not part of the root `ci` run: the root `vitest.config.ts` excludes `e2e/`, and there are no new GitHub jobs.

## Layout

| Path | What |
|---|---|
| `suite/cases.mjs` | the 11 cases (health, auth-required, auth-accepted, ingest-url, metadata, thumbnails, transcode, package, search, tags-roundtrip, delete) |
| `suite/run.mjs`, `suite/cli.mjs` | runs the cases in order; a failed chain case marks the rest `skipped`; deletes its asset on the way out |
| `runner/cycle.mjs` | one runner cycle: skip if this `:latest` digest is tested, create-or-restart the instance, wait for `/health` `build.commit` to equal `main`'s head, run the suite, record. Statuses: `green`, `red`, `stale`, `infra-error` |
| `runner/adapters.mjs` | GitHub head SHA, GHCR `:latest` digest, OSC instance create/restart, `/health` probe |
| `runner/store-s3.mjs`, `runner/store-file.mjs` | result store on an S3-compatible bucket (MinIO) or a directory; same keys (`results/by-digest/<digest>.json`, `results/latest.json`); digests are validated before they become a key |
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

## What is and isn't verified

Verified: every path, field and enum in the suite against `openapi.json` v1.5.0; the `@osaas/client-core` 0.24.0 signatures the OSC adapter calls (`lib/core.d.ts`, `lib/context.d.ts`); the instance config options from the service schema of `eyevinn-open-videocore`. The suite's logic and the cycle's branches are tested offline.

**Not verified, needs the first live run:**
- The mock server proves the suite's logic, not that the real service behaves as the contract says. No instance existed in the workspace to run against.
- Whether the service access token is accepted as the bearer on the instance (the contract says "OSC access token injected by the login wall").
- Whether a new instance created this way lands on the beta image. The cycle guards it: if `/health` `build.commit` is not `main`'s head the result is `stale`, never green.
- GHCR digest lookup with real credentials (the package is private; anonymous gets 401).
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
