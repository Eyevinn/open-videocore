# Investigation #292 — archive (DNxHD 185) write-path S3 pool-acquire timeout (documented constraint)

**Type:** Fix ticket on the "no Encore tunable exists" path (no feature code).
**Branch:** `issue-292/archive-write-pool-timeout` (stacked on
`issue-291/encore-s3-tunables-investigation`).
**Date:** 2026-08-19
**Gated by:** #291 (Encore S3 SDK tunables — confirmed absence).
**Routes to:** #294 (MinIO-ingress fix), #295 (retriable-encode mitigation).

## Summary

The `archive` profile (DNxHD 185 Mbps MXF) fails reproducibly on the **write
path** with an S3 connection-pool-acquire timeout. Per investigation #291, the
OSC Encore service exposes **no S3 SDK tunables** — no `max-connections`, no
`acquire-timeout`, no `read-timeout`, and no S3 configuration surface at all
beyond `instanceNaming`. Therefore this failure **cannot** be fixed by passing
an Encore instance-config key. Mitigation is routed to the ingress side (#294)
and to retriable encode (#295).

## Reproduction

- **Profile:** `archive` — DNxHD 185 Mbps, MXF container.
- **Source:** ≥60s of source; ~60s produces ~1.4 GB of output.
- **Failure:** deterministic at ~35s, on both attempts, at the ~1.4 GB output
  size. The failure sits on the **write path**, not in encoding.
- **Error (verbatim class):** `SdkClientException: Unable to execute HTTP
  request: Acquire operation took longer than the configured maximum time...
  request cannot get a connection from the pool within the specified maximum
  time.`

Interpretation: a large, sustained multipart upload of the ~1.4 GB DNxHD 185
output saturates the S3 client's connection pool inside the Encore container.
When the pool is exhausted, the next part upload cannot lease a connection
within the client's configured acquire timeout and the SDK throws. Because the
output size is deterministic, the exhaustion point (~35s) is deterministic too.

## Why this cannot be fixed in Encore config

The obvious remedy — raise the S3 client's `max-connections` and/or
`acquire-timeout` on the Encore instance — requires a schema-exposed Encore
config key. **No such key exists.** Evidence (dated 2026-08-19), from
`docs/investigations/291-encore-s3-sdk-tunables.md`:

- `get-service-schema` for serviceId `encore` returned **only** an
  `instanceNaming` object — no S3 endpoint, credential, region, connection-pool,
  or timeout properties.
- `list-available-services` (category=media) lists **`name` as the only
  required config** for the Encore entry.

The failing S3 client lives **inside the Encore container**, not in this
application. The auto-scaler's only lever at spawn time is the instance body it
passes to `createInstance(context, 'encore', sat, body)`. The verified fields it
sets are, in `src/encore-scaler/instance-pool.ts`:

- line 163 — `const instanceBody: Record<string, string> = { name };`
- line 165 — `instanceBody['s3Endpoint'] = config.s3Config.endpoint;`
- line 166 — `instanceBody['s3AccessKeyId'] = config.s3Config.accessKeyId;`
- line 167 — `instanceBody['s3SecretAccessKey'] = config.s3Config.secretAccessKey;`
- line 168 — `instanceBody['s3Region'] = config.s3Config.region ?? 'us-east-1';`

These four `s3*` values are runtime instance-config args accepted by the running
Encore instance; they are **not** schema-exposed tunables (per #291) and there
is **no** `s3MaxConnections` / `s3AcquireTimeout` (or equivalent) key to add
alongside them. Inventing such a key and passing it to `createInstance` would
violate CLAUDE.md rule 7 (fetch/verify the contract) and #291 proved the schema
would not accept it. **No app-side lever exists for the in-container S3 client
pool**, so this ticket makes no code change.

## Mitigation routing

Because no Encore-side tunable exists, the write-path timeout must be addressed
outside Encore config:

- **#294 — MinIO ingress.** A large sustained multipart upload exhausting the
  client connection pool points at ingress connection lifetime / keep-alive /
  concurrency limits between the Encore instance and the object store. Tuning
  ingress connection lifetime and concurrency for long, high-bitrate multipart
  uploads is the primary mitigation for the acquire-timeout.

- **#295 — retriable encode.** Even with ingress tuning, a transient transport
  blip mid-upload should not cost the entire ~60s+ job. A retriable-encode
  mitigation lets the job survive a single acquire-timeout / connection blip
  instead of failing outright at ~35s.

## Acceptance (per ticket)

Acceptance for #292 — the `archive` (DNxHD 185) profile completing end-to-end on
an OSC-provisioned stack for ≥60s of source across two consecutive runs without
the pool-acquire timeout — is achievable only through the #294 (ingress) and
#295 (retry) mitigations, **not** through an Encore instance-config change. Any
config field set as part of that work must be cited from a verified schema; per
#291 the Encore schema currently exposes none for S3.

## References

- `docs/investigations/291-encore-s3-sdk-tunables.md` — confirmed absence of all
  S3-related Encore config keys (verbatim `get-service-schema` output).
- `docs/osc-feedback/incoming-encore-s3-sdk-tunables-gap.md` (agent-team repo
  `eng-open-videocore-agents`) — OSC friction entry for the tunables gap;
  the #292 write-path reproduction is recorded there (section "What this
  blocks", item 1). This doc cross-references that entry rather than duplicating
  it.
- `src/encore-scaler/instance-pool.ts:163-168` — the verified `s3*` instance
  body fields (the only S3-related levers the scaler has, none of which control
  the client connection pool).
