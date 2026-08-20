# Investigation #291 — Encore service S3 SDK tunables (confirmed absence)

**Type:** Blocking investigation (no feature code). Gates fix tickets #292 and #293.
**Branch:** `issue-291/encore-s3-tunables-investigation`
**Introspection date:** 2026-08-19
**Contract source:** OSC MCP `list-available-services` (category=media) and
`get-service-schema` for serviceId `encore`.

## Determination

**The Encore service on OSC exposes NO S3 SDK tunables.** There is no
`max-connections` (connection-pool size), no `acquire-timeout` (pool-acquire /
lease timeout), and no `read-timeout` (socket read timeout) key on the Encore
service schema. In fact the schema exposes **no S3 configuration surface at
all** beyond instance naming.

This is the "tunables do NOT exist" outcome. It is upstream feedback for the
Encore service and OSC, logged as a partial-capability gap (see the
osc-feedback entry referenced at the end of this document).

## Evidence

### 1. `list-available-services` (category=media) — Encore entry (2026-08-19)

- **Service:** SVT Encore
- **serviceId:** `encore`
- **Category:** media
- **Essential:** Yes
- **Required config:** `name` (ONLY `name`)

No S3 endpoint, credential, region, connection-pool, or timeout field appears
in the required config.

### 2. `get-service-schema` for serviceId `encore` (2026-08-19) — verbatim

```json
{"instanceNaming":{"pattern":"^[a-z0-9]+$","maxLength":20,"sanitization":"lowercase-alphanumeric-only","description":"Instance names are sanitized to lowercase alphanumeric only, then must be ≤20 characters. K8s DNS-1035 63-char limit on {tenant}-{serviceId}-{instanceName}."}}
```

The schema contains a single object, `instanceNaming`. There are **no**
`suggestions`/properties beyond instance naming — i.e. no S3
endpoint/credentials/region keys, and no S3 SDK connection-pool,
acquire-timeout, or read-timeout keys.

## Enumeration of S3-related config keys

| Candidate tunable            | Exposed on Encore schema? | Evidence |
|------------------------------|---------------------------|----------|
| S3 endpoint                  | No                        | schema has only `instanceNaming` |
| S3 access key id             | No                        | schema has only `instanceNaming` |
| S3 secret access key         | No                        | schema has only `instanceNaming` |
| S3 region                    | No                        | schema has only `instanceNaming` |
| S3 client max-connections    | No                        | schema has only `instanceNaming` |
| S3 client acquire-timeout    | No                        | schema has only `instanceNaming` |
| S3 client read/socket timeout| No                        | schema has only `instanceNaming` |

Result: **confirmed absence of every S3-related config key** on the Encore
service schema.

## Cross-reference to ADR-006 verified-fields

ADR-006 (the Encore auto-scaler record, referenced throughout the codebase —
e.g. `src/encore-scaler/instance-pool.ts`, `src/encore-scaler/scaler-loop.ts`,
`src/routes/provision.ts`) records `s3Endpoint`, `s3AccessKeyId`,
`s3SecretAccessKey`, and `s3Region` as the only verified fields the pool passes
to `createInstance(context, 'encore', sat, { name, ... })`.

`src/encore-scaler/instance-pool.ts:163-168` sets exactly those four values on
the instance body at spawn time. This investigation confirms those four values
are **runtime instance-config arguments accepted by the running Encore
instance, not schema-exposed tunables** — the `get-service-schema` response
above does not list them. No S3 SDK connection-pool or timeout key has ever
been part of ADR-006's verified set, and none exists to add: the schema
exposes no such surface.

## Consequence for the sibling fix tickets

Because the Encore service exposes no S3-client config surface at instance
creation:

- **#292 (write-path pool-acquire timeout — DNxHD 185 write, ~35s
  pool-acquire timeout):** cannot be fixed by passing an Encore config key.
  No `max-connections` / `acquire-timeout` tunable exists. Mitigation must come
  from the ingress side — the MinIO-ingress fix, **#294** — and from the
  retriable-encode mitigation, **#295**.

- **#293 (read-path read timeout — program x265 1080p read I/O error at
  ~5–6 min):** cannot be fixed by passing an Encore config key. No
  `read-timeout` / socket-read-timeout tunable exists. Mitigation must likewise
  rely on the MinIO-ingress fix **#294** and the retriable-encode mitigation
  **#295**.

Both fix tickets should be annotated that a code-level Encore tunable is **not
available**, forcing reliance on ingress-side (#294) and retry (#295)
mitigations rather than an Encore instance-config change.

## Acceptance

- Written enumeration of the Encore service's S3-related config keys: done
  (table above — confirmed absence of all).
- Sourced from `get-service-schema` (verbatim JSON above) and
  `list-available-services` (required config `name` only), dated 2026-08-19.
- osc-feedback entry filed for the confirmed absence:
  `docs/osc-feedback/incoming-encore-s3-sdk-tunables-gap.md`
  (in the agent-team repo `eng-open-videocore-agents`).
