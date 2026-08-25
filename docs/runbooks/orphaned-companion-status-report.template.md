# Orphaned-companion cleanup — status report (template)

> Copy this file per remediation run and fill it in. Procedure:
> `docs/runbooks/orphaned-companion-cleanup.md` (issue #418).

**Run date:** `<YYYY-MM-DD>`
**Operator:** `<name>`
**app-config-svc instance:** `<PARAMETER_STORE_INSTANCE_NAME or ovcconfig>`
**Namespace:** `default` (STACK_CONFIG_NAMESPACE)

---

## A. Deletion record (what was removed)

Only rows for confirmed orphans / deprovisioned partials. If nothing was
deleted, write "none".

| timestamp | stack name | serviceId | resource type | resource id / secret name | reason | operator |
| --- | --- | --- | --- | --- | --- | --- |
| | | | instance / secret | | orphan-only / failed-partial | |

Reminder — companion password secrets to check per orphan `<name>`:
- `<name>.rootpassword` scoped to `minio-minio`
- `<name>.adminpassword` scoped to `apache-couchdb`
- (`valkey-io-valkey` has NO password secret)

---

## B. Per-instance status report (all currently running instances)

One row per running companion instance (`minio-minio`, `apache-couchdb`,
`valkey-io-valkey`). `classification`: `healthy` | `stuck` | `orphan-only`.

| stack name | serviceId | live? | stored config status | in services[]? | classification | remediation taken | needs remediation after #413 fix? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | minio-minio | | ready/provisioning/failed/absent | | | | |
| | apache-couchdb | | | | | | |
| | valkey-io-valkey | | | | | | |

---

## C. Summary

- Orphan-only companions deleted: `<count>`
- Stale secrets deleted: `<count>`
- Stacks classified `stuck` (still need re-run after #413 code fix): `<list of names>`
- Stacks classified `healthy` (no action): `<list of names>`

## D. Friction / anomalies

Note anything the OSC platform made hard (e.g. no bulk secret-generation
listing, no server-side orphan detection). Log to
`/usercontent/docs/osc-feedback/incoming-<slug>.md` per project rules.
</content>
