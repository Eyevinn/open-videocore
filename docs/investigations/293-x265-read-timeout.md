# Investigation #293 — program-x265 1080p read-side timeout (Encore-config constraint)

**Type:** Read-path constraint record (no feature code). Depends on #291.
**Branch:** `issue-293/x265-read-timeout` (stacked on
`issue-291/encore-s3-tunables-investigation`).
**Date:** 2026-08-19
**Contract source:** OSC MCP `get-service-schema` serviceId `encore` and
`list-available-services` (category=media), both dated 2026-08-19, as recorded
verbatim in `docs/investigations/291-encore-s3-sdk-tunables.md` on this branch.

## Determination — no Encore-side read/socket-timeout tunable exists

There is **no Encore-side S3 read-timeout / socket-timeout / keep-alive
tunable** to set. Investigation #291 confirmed the Encore service schema exposes
**no S3 configuration surface at all** beyond `instanceNaming`: `get-service-schema`
for serviceId `encore` returned only an `instanceNaming` object, and
`list-available-services` lists `name` as the ONLY required config field. See
`docs/investigations/291-encore-s3-sdk-tunables.md` (Evidence sections 1 and 2,
verbatim JSON) for the authoritative schema evidence.

The four `s3*` values the pool passes at spawn — `s3Endpoint`, `s3AccessKeyId`,
`s3SecretAccessKey`, `s3Region` — are set on the instance body in
`src/encore-scaler/instance-pool.ts:163-168`. Per #291 these are runtime
instance-config args accepted by the running Encore instance, **not**
schema-exposed, introspectable tunables; and none of them is a read/socket
timeout. There is no `s3ReadTimeout`, `s3SocketTimeout`, or keep-alive key to
add, and inventing one would violate CLAUDE.md rule 7 (fetch/cite the contract;
never guess a field). The "if Encore exposes a read-timeout key" branch of #293
is therefore **closed**.

The S3 read client that severs mid-job lives **inside the Encore container**,
not in this app. The app has no lever over that client's socket-read timeout or
keep-alive behaviour, so there is no app-side code change that can extend the
read window. This record is docs-only by necessity.

## Reproduction (precise)

- **Profile:** `program-x265`.
- **Source:** 1080p source object, `23,105,157` bytes, stored intact
  (byte-for-byte) — it encodes fine through **five other profiles in the same
  session**, so the stored input is not corrupt.
- **Failure timing:** fails **consistently at 5–6 minutes**, observed at
  **340s and 366s**.
- **Failure signature (input-side, read stream):**
  - `corrupt input packet`
  - `Invalid NAL unit size`
  - `Stream ends prematurely`
  - `Error during demuxing: I/O error`
- **Control — not a duration ceiling:** `program-x265` on the **4K** source
  **succeeded at 896s** (~15 min), far past the 1080p failure window. Because a
  longer job on the same profile completed, the 1080p failure is not caused by
  total job duration.

### Interpretation

The stored object is provably intact (23,105,157 bytes, five other profiles
succeed on it) and a longer same-profile job (4K, 896s) completes. That rules
out bad input data and rules out a hard duration limit. What remains is a
**long-lived read connection severed at a consistent wall-clock point** (5–6 min
into the job). A read stream cut short mid-transfer at a repeatable wall-clock
elapsed time is the classic signature of an **ingress / idle-timeout on the read
side**, not a data problem and not a per-job duration cap.

## Mitigation routing (no Encore config change)

Because no Encore-side read/socket-timeout tunable exists (#291), mitigation is
routed off the Encore instance config entirely:

- **#294 — MinIO ingress idle/keep-alive timeout (read side).** A long-lived
  read connection terminated at a consistent 5–6 min wall-clock point is the
  classic **ingress idle-timeout** signature. The fix belongs on the
  MinIO-ingress path: raise/disable the read-side idle timeout (and/or tune
  keep-alive) so a long, slow, large-object GET is not reaped mid-transfer.
  Validation target: the read must survive past the previous 5–6 min (340s /
  366s) failure window.
- **#295 — retriable-encode mitigation.** Independently of the ingress fix, a
  transient read-side I/O error mid-job should be retriable so a single severed
  read does not fail the whole encode. This is the defence-in-depth backstop if
  an idle read is ever reaped despite ingress tuning.

## Acceptance mapping

- Acceptance for #293 is that `program-x265` on the 1080p source completes
  end-to-end across **two consecutive runs** with no input-side demux/read
  errors past the previous 5–6 min failure point.
- That end-to-end completion is delivered by the **#294** ingress-timeout fix
  (primary) with **#295** retry as backstop — **not** by any Encore
  instance-config key, because none exists (#291). Any config key set anywhere
  in the fix must be cited from a verified schema; on the Encore side there is
  no such key to cite.

## Cross-references

- Blocking investigation (schema absence, authoritative evidence):
  `docs/investigations/291-encore-s3-sdk-tunables.md` (this branch).
- Sibling write-path constraint record:
  `docs/investigations/292-archive-write-pool-timeout.md` (on the #292 branch;
  same pattern — routes to #294/#295).
- OSC friction log (agent-team repo `eng-open-videocore-agents`):
  `docs/osc-feedback/incoming-encore-s3-sdk-tunables-gap.md` — the read-side
  (#293) reproduction is captured there under "What this blocks".
