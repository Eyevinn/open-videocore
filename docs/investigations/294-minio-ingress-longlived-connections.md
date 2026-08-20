# 294 — Does the MinIO ingress terminate long-lived S3 connections?

**Date:** 2026-08-19
**Author:** surface-backend-api agent
**Type:** determination / investigation (no code fix — see conclusion)
**Related:** #291 (Encore S3 SDK tunables), #292 (write-path pool exhaustion),
#293 (read-path 5–6 min sever), #295 (retriable-encode mitigation)

## Question

Both reported failures point at connection *lifetime* on the Encore-to-MinIO S3
path, not at bad data or a per-file ceiling:

- **Write (#292):** a large sustained upload (DNxHD 185 archive) exhausts the S3
  client connection pool with an acquire timeout at ~35s.
- **Read (#293):** a long `program-x265` 1080p encode dies at a *consistent
  5–6 minute wall-clock point* (observed 340s / 366s) with input-side I/O
  signatures, while the same source encodes cleanly through other profiles and
  the 4K variant succeeds at 896s.

#291 already established there is **no Encore-side S3 tunable** to raise (the
Encore `get-service-schema` exposes only `name`). This ticket asks the
independent question: does the **MinIO ingress** in the provisioned stack
terminate / idle-time-out long-lived connections, and can the operator extend
that timeout?

## Where the Encore-to-MinIO S3 path comes from (app code)

The S3 endpoint Encore talks to is the OSC platform ingress hostname of the
provisioned MinIO instance — the app does not run its own proxy or set any
ingress/timeout tunable:

- The stack provisions MinIO as serviceId `minio-minio`
  (`src/services/stack.ts:33`, `STACK_SERVICES`).
- Provision passes **only** `RootUser` / `RootPassword` to MinIO — no ingress,
  keep-alive, or timeout config — then reads the endpoint back from the created
  instance: `const minioEndpoint = instanceUrl(minio);`
  (`src/routes/provision.ts:501-506`).
- That endpoint is the OSC-managed ingress URL, e.g.
  `https://<tenant>.minio-minio.auto.prod-se.osaas.io`
  (`src/encore-scaler/types.ts:24-29`, `EncoreS3Config.endpoint`).
- The endpoint/credentials are handed to each Encore instance verbatim at spawn
  time as `s3Endpoint` / `s3AccessKeyId` / `s3SecretAccessKey` / `s3Region`
  (`src/encore-scaler/instance-pool.ts:163-168`).

So every long-lived S3 GET/PUT from Encore transits the OSC-managed
`*.minio-minio.auto.prod-se.osaas.io` ingress. Any idle/keep-alive/read timeout
on that ingress is a property of the platform, not of this application.

## Live introspection of the MinIO service (cited contract, 2026-08-19)

OSC MCP introspection performed 2026-08-19 (authoritative contract source):

1. `list-available-services` (category=storage) — MinIO entry:
   serviceId **`minio-minio`**, Essential: Yes, **required config = `name`
   ONLY**.

2. `get-service-schema` for `minio-minio` returned **exactly**:

   ```json
   {"instanceNaming":{"pattern":"^[a-z0-9]+$","maxLength":20,"sanitization":"lowercase-alphanumeric-only","description":"Instance names are sanitized to lowercase alphanumeric only, then must be ≤20 characters. K8s DNS-1035 63-char limit on {tenant}-{serviceId}-{instanceName}."}}
   ```

The schema contains a single `instanceNaming` object and **no config
properties at all** beyond it. There is **no ingress, connection-timeout,
idle-timeout, keep-alive, or read-timeout key** exposed. The operator cannot
set a MinIO ingress timeout through the OSC service schema. (Note: the
`RootUser` / `RootPassword` args the provision path passes are accepted as
runtime instance-config, but are likewise not schema-exposed, and there is no
timeout field of any kind to pass.)

## Evidence that both failures share a connection-lifetime signature

- **#292 (write):** pool-*acquire* exhaustion on a large sustained upload — the
  client cannot lease a connection because in-flight long-lived connections are
  not completing/recycling within the window. Classic symptom of upstream
  connections being held/severed rather than of insufficient raw bandwidth.
- **#293 (read):** failure at a **consistent 5–6 minute wall-clock point**,
  independent of file, with `corrupt input packet` / `Invalid NAL unit size` /
  `Stream ends prematurely` / `Error during demuxing: I/O error`. The source
  object is byte-for-byte intact (23,105,157 bytes), encodes fine through five
  other profiles in the same session, and `program-x265` on the 4K source
  succeeds at 896s. A read stream severed at a fixed wall-clock point,
  regardless of content, is the **classic ingress idle/keep-alive-timeout
  signature** — a proxy/ingress cutting a connection that has exceeded its
  configured lifetime, surfacing to the reader as a truncated/corrupt stream.

The two signatures are the two faces of the same root cause: long-lived S3
connections through the MinIO ingress are not surviving for the duration a large
transcode read/write requires.

## Determination

- The MinIO ingress idle/keep-alive/read timeout is **NOT operator-configurable
  via the OSC `minio-minio` service schema** — the schema exposes only instance
  naming and `name`-only required config (cited verbatim above, 2026-08-19).
- The evidence is consistent with the **ingress terminating long-lived
  connections**: the read failure lands at a fixed ~5–6 min wall-clock point
  regardless of content, and the write failure is a pool-acquire exhaustion on a
  sustained upload — both connection-lifetime, not data or bandwidth, signatures.
- The operator therefore has **no exposed lever** on the MinIO service to extend
  the ingress connection lifetime. There is no app-side lever either: the app
  merely consumes the platform-issued ingress URL (`instanceUrl(minio)`); it
  does not front MinIO with its own proxy whose timeout it could raise.

## Routing / next action

- **No stack-side ingress timeout can be corrected** here, because none is
  exposed. This confirms the "not exposed / not configurable" branch of #294.
- Logged as an OSC/MinIO ingress capability gap in the agents repo:
  `docs/osc-feedback/incoming-minio-ingress-longlived-conn-gap.md`
  (severity: partial capability gap; ask: expose an ingress
  idle/keep-alive/read timeout on the `minio-minio` service).
- **Mitigation falls to #295 (retriable-encode):** since neither the Encore S3
  client (#291) nor the MinIO ingress (#294) can be tuned by the operator, the
  durable fix is application-side retry of encodes whose S3 connection is
  severed mid-stream. Cross-reference #291 / #292 / #293 for the full picture.

## Cited sources

- OSC MCP `get-service-schema` serviceId `minio-minio`, 2026-08-19 (verbatim
  JSON above).
- OSC MCP `list-available-services` category=storage, 2026-08-19 — MinIO
  required config = `name` only.
- App code: `src/services/stack.ts:33`, `src/routes/provision.ts:501-506`,
  `src/encore-scaler/types.ts:24-29`, `src/encore-scaler/instance-pool.ts:163-168`.
- Sibling investigations (customer repo, on their own branches):
  `docs/investigations/291-encore-s3-sdk-tunables.md`,
  `docs/investigations/292-archive-write-pool-timeout.md`,
  `docs/investigations/293-x265-read-timeout.md`.
