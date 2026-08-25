# Runbook — clean up orphaned companion instances and re-verify tenant stacks

**Issue:** #418 (sub-issue of #413)
**Type:** operational / verification runbook (no code change)
**Audience:** a human operator with OSC platform access (MCP tools or the OSC
web console / CLI) and the deployment's `PARAMETER_STORE_API_KEY`.
**Author:** surface-backend-api agent

> This document is a *procedure*, not an automated script. Deleting live OSC
> service instances and secrets is irreversible and high blast radius. Every
> delete step below must be performed by a human operator who has confirmed the
> instance is a genuine orphan against the checklist in section 4.

---

## 1. Background — where the orphans come from (grounded in code)

An open-videocore "stack" is a set of OSC service instances that **all share the
same instance name** (the stack name). There is no separate per-instance state:
to enumerate a stack you combine the service list with the stack name.

- The stack's companion services are the single source of truth in
  `src/services/stack.ts:32-36` (`STACK_SERVICES`):
  - `minio-minio` (role `storage`) — the object store companion
  - `apache-couchdb` (role `database`) — the document store companion
  - `valkey-io-valkey` (role `queue`)
- Every companion is created with `{ name, ...body }` where `name` is the stack
  name (`src/routes/provision.ts:628`). The name is validated as lowercase
  alphanumeric, 1–63 chars (`src/routes/provision.ts:81-86`).
- Because the name is deterministic, OSC rejects a second instance of the same
  service+name with "already taken"; the provision helper then fetches the
  existing instance instead of creating a duplicate
  (`src/routes/provision.ts:632-635`).

**So what is actually orphaned?** Two distinct things, from two distinct
failure modes that predate the idempotency fix (#417) and the load-bearing
persistence fix (#416):

1. **Stale companion-password secret generations.** Each provision retry called
   `saveSecret` again for the companion passwords, minting a fresh secret
   generation every attempt. The pre-#417 comment documents this exactly:
   "Repeated or concurrent POST / calls for the SAME stack name ... was minting
   new companion-password secret generations each retry"
   (`src/routes/provision.ts:426-436`). The secret names are deterministic —
   `<stackName>.<purpose>` (`src/routes/provision.ts:580`) — so the *name* does
   not change, but the OSC secret store may hold multiple generations / stale
   values scoped to `minio-minio` and `apache-couchdb`.
2. **Companion instances not bound to a completed stack.** A provision that
   created the companions but never reached the final, load-bearing
   `StackConfig` persistence step (#416) leaves the companions live with **no
   `status: 'ready'` config to read them back**. See section 3 for the exact
   definition of "bound to a completed stack".

### Secret naming contract (for the stale-secret cleanup)

- Secret name = `` `${name}.${purpose}` `` (`src/routes/provision.ts:580`).
- Purposes minted during core provision (`src/routes/provision.ts:409-410`):
  - `rootpassword` — saved scoped to serviceId `minio-minio`
    (`src/routes/provision.ts:662-666`)
  - `adminpassword` — saved scoped to serviceId `apache-couchdb`
    (`src/routes/provision.ts:791-795`)
- Secrets are **per-service-scoped**: a secret saved for one serviceId cannot be
  referenced from another (`src/routes/provision.ts:404-408`). So the stale
  MinIO password lives under `minio-minio` and the stale CouchDB password lives
  under `apache-couchdb`. `valkey-io-valkey` is provisioned with an empty body
  (`src/routes/provision.ts:831`) and mints **no** companion password secret.

> Only `minio-minio` and `apache-couchdb` have companion password secrets to
> clean up. Do not look for a Valkey password secret — none is created.

---

## 2. What "completed / healthy" means, per the code

The provision flow's **final** step persists the fully-resolved `StackConfig`
with `status: 'ready'` and is explicitly load-bearing
(`src/routes/provision.ts:926-990`, `persistStackConfig`
`src/routes/provision.ts:339-372`). A stack is only usable once this write lands
— storage-dependent endpoints resolve only from this persisted config
(`src/routes/provision.ts:932-940`).

The lifecycle `status` field on the stored config
(`src/services/param-store.ts:52-59`) is the ground truth:

- `status: 'ready'` **or `status` absent** — completed / healthy. `isReadyStack`
  treats a legacy status-less config as ready
  (`src/services/param-store.ts:97-104`).
- `status: 'provisioning'` — a marker written **before** any companion is
  created (`src/routes/provision.ts:546-561`). A stack still showing this state
  never finished: either mid-flight, or **stuck** (the companions were created
  but the final `ready` write never replaced this marker).
- `status: 'failed'` — a partial-failure write recording whatever companions
  were provisioned so deprovision can clean up
  (`src/routes/provision.ts:1019-1044`). Still carries `services[]`.

> Note on the #416 stuck case: if provisioning failed **at the final
> persistence write itself**, the `'provisioning'` marker is what remains in the
> store while the companions are live. That is the "stuck at the StackConfig
> persistence step" state the issue asks you to identify — see the decision
> table in section 3.

### Where StackConfig is persisted (the key contract)

- Storage key: `` `openvideocore/${workspaceId}/${name}` ``
  (`stackConfigKey`, `src/services/param-store.ts:131-133`).
- `workspaceId` for this deployment is the constant `STACK_CONFIG_NAMESPACE =
  "default"` (`src/services/workspace-stack.ts:343`), returned by
  `deriveWorkspaceId` (`src/routes/provision.ts:319-321`). Provision and the
  resolver deliberately agree on this namespace.
- Backing store: the `eyevinn-app-config-svc` OSC service instance
  (`PARAM_STORE_SERVICE_ID`, `src/services/param-store.ts:585`), whose instance
  name defaults to `ovcconfig` (`src/services/param-store.ts:588`) or
  `PARAMETER_STORE_INSTANCE_NAME` if set.
- HTTP contract of that store (`src/services/param-store.ts:330-336`):
  - `GET  /api/v1/config/{key}`  → `200 { key, value }` | `404 { reason }`
  - `GET  /api/v1/config?limit=100` → `{ items: [{ key, value }], total }`
  - `DELETE /api/v1/config/{key}` → `200 { message }` | `404 { reason }`
  - Auth: `Authorization: Bearer <OSC SAT>` **and** `x-api-key: <ConfigApiKey>`.
  - The `{key}` path segment is `encodeURIComponent`-encoded so the
    slash-bearing namespace survives as one segment
    (`src/services/param-store.ts:360-363`).
- The stored `value` is a JSON string of the `StackConfig`
  (`src/services/param-store.ts:443`), so `value.status` and `value.services[]`
  are the fields you read to classify a stack.

---

## 3. Definition — "orphan" vs "healthy companion" vs "stuck"

For a companion instance named `<name>` of serviceId `<sid>` (one of
`minio-minio`, `apache-couchdb`, `valkey-io-valkey`), read the stored config at
key `openvideocore/default/<name>` and classify:

| Stored config at `openvideocore/default/<name>` | `services[]` lists `<sid>`? | Companion classification |
| --- | --- | --- |
| exists, `status` `ready` or absent | yes | **healthy** — belongs to a completed stack; DO NOT delete |
| exists, `status: 'provisioning'` | (services[] is `[]` in the marker) | **stuck** — companions live, final `ready` write never landed (#416). Needs the code fix + re-run, NOT deletion of a single companion. Record as `stuck`. |
| exists, `status: 'failed'` | yes | **failed partial** — deprovisionable via the API (see 5b). Record as `stuck`/failed. |
| **no config** (`GET` returns 404) | n/a | **orphan-only** — a companion left by a failed retry with nothing bound to it. Eligible for deletion. |

> **"Bound to a completed stack"** = there exists a stored config at
> `openvideocore/default/<name>` whose `status` is `ready` (or absent) AND whose
> `services[]` contains this companion's serviceId. Anything else is not bound
> to a completed stack.

**Only delete companions in the `orphan-only` row**, and only after confirming
no `ready` config anywhere references that name (section 4, step 4).

---

## 4. Enumeration + verification procedure

Perform these read-only steps first. Nothing here mutates state.

### Step 1 — list every stored stack config (the "known" stacks)

```
GET {app-config-svc-url}/api/v1/config?limit=100
Authorization: Bearer <SAT for eyevinn-app-config-svc>
x-api-key: <PARAMETER_STORE_API_KEY / ConfigApiKey>
```

Filter `items[].key` to those starting with `openvideocore/default/`
(this is exactly what `listStackNames` does, `src/services/param-store.ts:554-580`).
For each, parse `value` (JSON) and record `name`, `status`, and
`services[].serviceId`. This is your **expected companion set**.

> If you have OSC MCP access you can instead call the platform's
> `list-service-instances` for each of `minio-minio`, `apache-couchdb`,
> `valkey-io-valkey` to get the **actual** live companion instances, then
> reconcile against the expected set from the store. The store is the source of
> truth for "completed"; the platform instance list is the source of truth for
> "what is actually running".

### Step 2 — list actual live companion instances per service

For each companion serviceId (`minio-minio`, `apache-couchdb`,
`valkey-io-valkey`), enumerate its running instances via the OSC platform
(`list-service-instances` / console). Record every instance **name**.

### Step 3 — reconcile

Build the union of instance names seen in step 2. For each name, look up its
stored config (step 1) and classify per the section 3 table. An instance name
that appears in step 2 but has **no** stored config (404) is an `orphan-only`
candidate.

### Step 4 — confirm an orphan candidate before any delete

Before deleting a candidate companion `<sid>`/`<name>`:

1. Re-fetch `GET .../api/v1/config/openvideocore/default/<name>` and confirm a
   **404** (no bound config). If it returns `200` with `status: 'ready'`, STOP —
   it is healthy.
2. Confirm the same `<name>` is not the target of an in-flight provision
   (check `GET {api}/api/v1/provision/operations` for a `pending`/`running`
   operation with that `name`; operations are exposed at
   `src/routes/provision.ts:1331-1346`). If one is running, wait for it to
   settle rather than racing it.
3. Only then treat it as an orphan.

---

## 5. Remediation

### 5a. Delete an orphan-only companion instance (operator, OSC)

For each confirmed `orphan-only` companion, delete the **instance** via the OSC
platform. The API's own teardown uses `removeInstance(osc, serviceId, name,
sat)` (`src/services/deprovision.ts:69`) — the equivalent operator action is:

- OSC MCP: `remove-service-instance` with the serviceId (`minio-minio` /
  `apache-couchdb` / `valkey-io-valkey`) and the orphan instance name.
- OSC console: delete the named instance under that service.

Delete in consumer-before-producer order if multiple companions of the same
orphan name exist, mirroring `TEARDOWN_ORDER`
(`src/services/stack.ts:88-92`): queue → database → storage
(`valkey-io-valkey` → `apache-couchdb` → `minio-minio`).

### 5b. Delete the stale companion password secrets

Only `minio-minio` and `apache-couchdb` have companion password secrets
(section 1). For an orphan named `<name>`:

- Delete the secret named `<name>.rootpassword` scoped to serviceId
  `minio-minio`.
- Delete the secret named `<name>.adminpassword` scoped to serviceId
  `apache-couchdb`.

Use the OSC platform secret management (MCP / console) scoped to the exact
serviceId — secrets are per-service (`src/routes/provision.ts:404-408`), so a
secret must be removed under the same serviceId it was saved to. Do **not** look
for a `valkey-io-valkey` password secret; none is minted.

> If a companion belongs to a **healthy** stack, its `<name>.rootpassword` /
> `<name>.adminpassword` secrets are in active use — do NOT delete them.

### 5c. Preferred path for `failed`/`provisioning` configs — use the API

If a companion's stored config exists with `status: 'failed'` (it carries
`services[]`), prefer the idempotent DELETE route over hand-deleting instances:

```
DELETE {api}/api/v1/provision/<name>
```

It returns `202` with an `operationId`; poll
`GET {api}/api/v1/provision/operations/<id>` until `done`
(`src/routes/provision.ts:1163-1329`). This tears down exactly the recorded
`services[]` in dependency-safe order and then removes the store entry. It does
**not**, however, delete the stale password secrets (there is no secret-teardown
in `deprovisionStackFromConfig`, `src/services/deprovision.ts:208-235`) — do 5b
by hand afterwards.

> A bare `'provisioning'` marker has an empty `services[]`
> (`src/routes/provision.ts:546-561`), so DELETE will report `not_found` and
> leave the live companions untouched. For that state, either (a) apply the #413
> code fix and re-run the provision (idempotent — it converges), or (b) hand-
> delete the companions per 5a + 5b if the tenant is being abandoned.

### 5d. Clean up the store entry

After hand-deleting orphan instances that had a `failed`/`provisioning` config,
delete the stale store entry so it is not re-read:

```
DELETE {app-config-svc-url}/api/v1/config/openvideocore%2Fdefault%2F<name>
Authorization: Bearer <SAT>; x-api-key: <ConfigApiKey>
```

(`404` = already gone = success, `src/services/param-store.ts:548-549`.) An
`orphan-only` companion has no store entry, so skip this for those.

---

## 6. Records to produce

### 6a. Deletion record (what was removed)

For every deletion, append a row:

| timestamp | stack name | serviceId | resource type (instance / secret) | resource id / secret name | reason (orphan-only / failed-partial) | operator |
| --- | --- | --- | --- | --- | --- | --- |

### 6b. Per-instance status report (all currently running instances)

Produce one row per currently running companion instance. `classification`
comes from the section 3 table.

| stack name | serviceId | live instance? | stored config status (`ready`/`provisioning`/`failed`/absent) | in `services[]`? | classification (`healthy` / `stuck` / `orphan-only`) | remediation taken | still needs remediation after #413 code fix? |
| --- | --- | --- | --- | --- | --- | --- | --- |

Scope note from #418: there are the orphaned companions to remove **plus 4
other currently running instances to re-verify**. Fill one row per companion of
those 4 stacks and mark each `healthy` or `stuck`. Tenants marked `stuck`
(config still `provisioning`/`failed` while companions are live) are the ones
that still need remediation once the #413 code fix ships — record them so
operators know to re-run (idempotent) provision for those names afterward.

---

## 7. Safety checklist (before any delete)

- [ ] Confirmed the candidate's `openvideocore/default/<name>` config is 404
      (orphan-only) or `failed` — never `ready`/absent.
- [ ] Confirmed no `pending`/`running` provision operation targets `<name>`.
- [ ] Deleting instances consumer→producer (queue → database → storage).
- [ ] Password secrets deleted only for confirmed orphans, scoped to the exact
      serviceId (`minio-minio` → `.rootpassword`, `apache-couchdb` →
      `.adminpassword`).
- [ ] Every deletion appended to the deletion record (6a).
- [ ] Per-instance status report (6b) completed for all running instances.

---

## 8. Contract citations (single reference list)

- Companion service set: `src/services/stack.ts:32-36` (`STACK_SERVICES`).
- Teardown order: `src/services/stack.ts:88-92` (`TEARDOWN_ORDER`).
- Companion name = stack name, created via `{ name, ...body }`:
  `src/routes/provision.ts:628`; name rule `src/routes/provision.ts:81-86`.
- "already taken" → reuse existing (deterministic names):
  `src/routes/provision.ts:632-635`.
- Secret name = `<name>.<purpose>`: `src/routes/provision.ts:580`; purposes
  `src/routes/provision.ts:409-410`; per-service scoping
  `src/routes/provision.ts:404-408`; MinIO root secret save
  `src/routes/provision.ts:662-666`; CouchDB admin secret save
  `src/routes/provision.ts:791-795`; Valkey created with empty body (no secret)
  `src/routes/provision.ts:831`.
- Stale-secret-per-retry root cause: `src/routes/provision.ts:426-436`,
  `src/routes/provision.ts:493-495`.
- Final load-bearing `ready` persistence: `src/routes/provision.ts:926-990`;
  `persistStackConfig` `src/routes/provision.ts:339-372`.
- `'provisioning'` marker before companions: `src/routes/provision.ts:546-561`.
- `'failed'` partial write: `src/routes/provision.ts:1019-1044`.
- StackConfig shape + `status` field: `src/services/param-store.ts:52-95`;
  `isReadyStack` `src/services/param-store.ts:97-104`.
- Storage key + namespace: `stackConfigKey` `src/services/param-store.ts:131-133`;
  `STACK_CONFIG_NAMESPACE = "default"` `src/services/workspace-stack.ts:343`;
  `deriveWorkspaceId` `src/routes/provision.ts:319-321`.
- Param-store HTTP contract: `src/services/param-store.ts:330-363`,
  list `src/services/param-store.ts:554-580`, delete
  `src/services/param-store.ts:542-552`.
- Backing service id/name: `PARAM_STORE_SERVICE_ID`
  `src/services/param-store.ts:585`; default name `ovcconfig`
  `src/services/param-store.ts:588`.
- API deprovision route: `src/routes/provision.ts:1163-1329`;
  `deprovisionStackFromConfig` (no secret teardown)
  `src/services/deprovision.ts:208-235`; `removeInstance`
  `src/services/deprovision.ts:69`.
- Provision operations listing: `src/routes/provision.ts:1331-1346`.
</content>
