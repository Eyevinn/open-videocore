# Moving a legacy stack to a per-stack object-store credential

Every stack provisioned since issue #1094 gets its **own** object-store access
key id and secret. A stack provisioned before that change shares one
deployment-wide credential with every other stack of the same vintage: the
object-store root user `admin` plus the value of `MINIO_ROOT_PASSWORD`.

This guide is for operators who need to answer three questions about a running
deployment:

- which of my stacks are still on the shared credential;
- how do I get one of them onto its own credential, and what does that cost me;
- what happens if I rotate `MINIO_ROOT_PASSWORD`.

There is no in-place migration. The object store's credential is the credential
the instance was **created** with, and the platform exposes no supported way to
change it on a live instance. The schema query and the maintainer confirmation
behind that statement are recorded in the engagement's OSC feedback log, in the
`eng-open-videocore-agents` repo, at
`docs/osc-feedback/incoming-shared-minio-root-credential-across-stacks.md`
(see its "Update 2026-10-14" section). The only move is to
re-provision the stack, which is destructive, which is why the rest of this
guide spends most of its length on the sequencing.

> **Status of section 2.** The procedure below is derived from the code paths it
> cites, line by line. The steps that can only be confirmed by destroying a real
> stack — what teardown leaves behind in the object store and document store,
> and an end-to-end asset move between two live stacks — are marked **pending
> live verification on a throwaway stack**. Nothing in this document is reported
> as an observed result unless it was observed.

---

## 1. Is this stack legacy?

### The field

A stack's object-store credential mode is recorded in exactly one place: the
optional `objectStoreAccessKeyId` field of the stored stack config.

- Contract: `StackConfig.objectStoreAccessKeyId?: string` —
  `src/services/param-store.ts:114` (the field comment above it states the
  back-compat rule: "a stack provisioned BEFORE #1094 carries no value here,
  and its absence is the signal to use the legacy process-global `admin` +
  deployment-password credential").
- The check that consumes it: `resolveObjectStoreCredential` —
  `src/services/object-store-credentials.ts:445`. Present id **and** a seed
  gives the per-stack credential; anything else returns
  `LEGACY_OBJECT_STORE_ACCESS_KEY_ID` (`'admin'`, same file line 155) plus the
  deployment-wide password.

So the exact check is:

> **A stack is legacy if, and only if, its stored config has no non-empty
> `objectStoreAccessKeyId`.**

A per-stack id is also recognisable by sight: it is 20 characters, lowercase
`[a-z0-9]` only, and begins with `ovc`
(`OBJECT_STORE_ACCESS_KEY_ID_PREFIX`, `src/services/object-store-credentials.ts:165`,
length at line 169). `admin` is the legacy root user.

### Where to read it

**Not** from the API. `GET /api/v1/provision/:name` responds under
`storedConfigSchema` (`src/routes/provision.ts:487`), which lists
`status`, `reason`, `minioEndpoint`, `couchdbUrl`, `redisUrl`, `sourceBucket`,
`packagedBucket`, the optional-service instance names, `options`, `storage` and
`services` — and **not** `objectStoreAccessKeyId`. The response goes through the
zod serializer (`app.setSerializerCompiler(serializerCompiler)`,
`src/main.ts:250`), which strips keys the schema does not declare, so the field
is absent from the response even though it is present in the stored record.
`openapi.json` contains no occurrence of `objectStoreAccessKeyId` either.

Read the stored record from the parameter store instead. The key is
`openvideocore/<namespace>/<stackName>` (`stackConfigKey`,
`src/services/param-store.ts:175-177`) and the namespace is the deployment-wide
constant `STACK_CONFIG_NAMESPACE = "default"`
(`src/services/workspace-stack.ts:621`) — so for a stack named `demo` the key is
`openvideocore/default/demo`.

The config service's contract, as recorded in `src/services/param-store.ts:393-402`
(`GET /api/v1/config/{key}` → `200 { key, value }` | `404 { reason }`; auth is
an OSC service access token as `Authorization: Bearer` plus `x-api-key`), and
keys containing `/` are percent-encoded into a single path segment
(`configUrl`, same file lines 434-436):

```sh
# PARAM_STORE_URL  — the config-service instance base URL
# PARAM_STORE_SAT  — OSC service access token for the config service
# PARAM_STORE_KEY  — the value of PARAMETER_STORE_API_KEY for that instance
STACK=demo
KEY=$(printf 'openvideocore/default/%s' "$STACK" | jq -sRr @uri)

curl -sS "$PARAM_STORE_URL/api/v1/config/$KEY" \
  -H "Authorization: Bearer $PARAM_STORE_SAT" \
  -H "x-api-key: $PARAM_STORE_KEY" \
| jq -r '.value' | jq '{
    stack: "'"$STACK"'",
    objectStoreAccessKeyId,
    legacy: ((.objectStoreAccessKeyId // "") == "")
  }'
```

`value` is the config blob as a JSON **string**, hence the second `jq`. A
`legacy: true` result means this stack's object store is still addressed as
`admin` + `MINIO_ROOT_PASSWORD`, shared with every other legacy stack in the
deployment.

To sweep the whole deployment, take the stack names from
`GET /api/v1/provision/` (`src/routes/provision.ts:2076`, returns
`listStackNames`) and run the read above for each. Note the listing is not
paginated by this client and one page is 100 keys
(`CONFIG_LIST_PAGE_LIMIT`, `src/services/param-store.ts:389`), so treat a full
page as possibly truncated. It also answers `200 []` rather than an error when
the parameter store is unavailable (`src/routes/provision.ts:2094-2099`), so an
empty sweep means "no answer" as often as it means "no stacks".

### The other signal

If the stack was provisioned by a build that already had #1094, the provision
run logs why it stayed legacy. A weak seed produces a per-stack ERROR line
("provisioning this stack WITHOUT a per-stack object-store credential",
`src/routes/provision.ts:1111-1125`); an adopted object store or an existing
stored record produces no line at all, because those are expected outcomes
rather than misconfiguration (`ObjectStoreCredentialPlan.downgradeReason`,
`src/services/object-store-credentials.ts:473-483`). Absence of a log line is
therefore not evidence of anything — the stored field is the ground truth.

---

## 2. The only available move: re-provision the stack

### Why there is nothing gentler

Three independent facts close off every in-place option:

1. The credential is the object-store instance's root user. The create body
   carries only `RootUser` + `RootPassword`
   (`src/routes/provision.ts:1301-1302`), and the platform reports
   `supportsUpdate: null` for that service with the maintainer confirming on
   2026-10-14 that changing a live instance's root user or password is not
   supported (OSC feedback entry linked above). Issue #1096 — migrate existing
   stacks and drop the fallback — is closed as blocked on that.
2. Provisioning **adopts** an object store that already exists rather than
   recreating it (#417), and adoption does not rewrite its root user. So the
   planner deliberately refuses to issue a per-stack credential whenever the
   instance already exists, or whenever a stored config already exists for the
   name: `planObjectStoreCredential` returns the legacy plan at
   `src/services/object-store-credentials.ts:555` for exactly that case, and the
   provision path feeds it an existence probe whose
   could-not-answer value is `true`, the non-breaking answer
   (`src/routes/provision.ts:1070-1084`).
3. The secret cannot be rewritten into the store from our side either: the
   platform's secrets API is write-only, which is why the credential is derived
   rather than generated (header of `src/services/object-store-credentials.ts`,
   reason 1, and `docs/osc-feedback/incoming-no-osc-secret-deletion-for-stack-teardown.md`).

Point 2 has a direct operational consequence, and it is the single easiest way
to get this migration wrong: **re-provisioning a name whose stored config or
object-store instance still exists leaves the stack legacy.** A `DELETE` that
reports `partial` or `failed` keeps the stored entry in place on purpose, marked
`delete_failed`, so a retry still knows what is left to remove
(`src/routes/provision.ts:2319-2350`, issue #1210). Re-provisioning on top of
that entry hits the fallback branch, silently, and you will have destroyed the
stack's data for nothing. Step 5 below is the guard against that.

### The procedure

Preconditions: you have confirmed the stack is legacy (section 1), the seed in
`MINIO_ROOT_PASSWORD` passes the strength floor (section 4 — otherwise the
re-provision cannot issue a per-stack credential at all), and you have a
maintenance window, because the stack is unavailable from step 4 to step 6.

1. **Freeze writes to the stack.** Stop ingest against it. There is no API-level
   read-only mode, so this is a change at your own ingress or client layer.

2. **Inventory what the stack holds.** For each asset, record the metadata and
   the file list:

   `GET /api/v1/assets/` answers an **object** — `{items, limit, offset, total}`
   (`listSchema`, `src/routes/assets.ts:1213-1218`) — not a bare array, so the id
   expression is `.items[].id`. Page explicitly (`limit` caps at 200,
   `listQuerySchema`, `src/routes/assets.ts:501`) and fail loudly on any error:
   an inventory that quietly comes up short is the worst way to arrive at step 4,
   which is irreversible.

   ```sh
   OLD=legacy-stack-name

   : > asset-ids.txt
   offset=0; total=0
   while :; do
     page=$(curl -fsS "$API/api/v1/assets/?limit=200&offset=$offset" \
       -H "X-Stack-Name: $OLD") || {
       echo "listing failed at offset $offset — do NOT continue to step 4" >&2; exit 1; }
     n=$(printf '%s' "$page" | jq '.items | length')
     total=$(printf '%s' "$page" | jq '.total')
     printf '%s' "$page" | jq -r '.items[].id' >> asset-ids.txt
     offset=$((offset + n))
     [ "$offset" -ge "$total" ] && break
     [ "$n" -eq 0 ] && {
       echo "no progress at offset $offset of $total — do NOT continue" >&2; exit 1; }
   done

   # The inventory must account for every asset before anything destructive runs.
   got=$(wc -l < asset-ids.txt)
   [ "$got" -eq "$total" ] || {
     echo "inventoried $got of $total assets — do NOT continue to step 4" >&2; exit 1; }
   echo "inventoried $got of $total assets"

   while read -r ID; do
     curl -fsS "$API/api/v1/assets/$ID"       -H "X-Stack-Name: $OLD" > "asset-$ID.json"
     curl -fsS "$API/api/v1/assets/$ID/files" -H "X-Stack-Name: $OLD" > "files-$ID.json"
   done < asset-ids.txt
   ```

   `X-Stack-Name` is the header that addresses a specific stack
   (`src/services/workspace-stack.ts:990`, `1044-1048`). `GET /assets/:id/files`
   returns `files[]` with `objectKey` and a `url` per file plus `fileGroups[]`
   with `manifestUrl` (response schema in `openapi.json`,
   `/api/v1/assets/{id}/files`).

3. **Copy the bytes out, while the old stack still exists.** The source objects
   live in the old stack's own buckets — `openvideocore-source` and
   `openvideocore-packaged` (`SOURCE_BUCKET` / `PACKAGED_BUCKET`,
   `src/routes/provision.ts:99-100`) on the old stack's object-store instance.
   Either download them to staging storage via the URLs from step 2, or copy
   them into storage that will outlive the stack. Do not skip this: step 4
   removes the instance those buckets live on.

4. **Tear the stack down.** `DELETE /api/v1/provision/:name` answers `202` with
   an operation id and runs the teardown in the background; poll
   `GET /api/v1/provision/operations/:id` for the terminal state
   (`src/routes/provision.ts:2300-2317`, and the route comment at `2280-2299`
   for the `removed` / `partial` / `not_found` / `failed` result semantics).

   ```sh
   OP=$(curl -fsS -X DELETE "$API/api/v1/provision/$OLD" | jq -r .operationId)

   while :; do
     st=$(curl -fsS "$API/api/v1/provision/operations/$OP" | jq -r .status) || exit 1
     case "$st" in done|failed) break ;; esac
     sleep 10
   done
   curl -fsS "$API/api/v1/provision/operations/$OP" | jq '{status, error, result}'
   ```

   A single read right after the `DELETE` almost always shows `pending`, which
   says nothing about the outcome; wait for `done` or `failed` before step 5.

   Teardown calls `removeInstance` for every service recorded in the stored
   config, in dependency-safe order — storage (`minio-minio`), database
   (`apache-couchdb`) and queue (`valkey-io-valkey`) are the core three
   (`STACK_SERVICES`, `src/services/stack.ts:51-55`; teardown in
   `src/services/deprovision.ts`). Removing the storage instance removes the
   buckets and their objects with it, and removing the database instance removes
   the stack's asset metadata; the stored config is deleted only on a clean
   teardown. **Pending live verification on a throwaway stack:** what the
   platform actually leaves behind after `removeInstance` on each of those three
   services — in particular whether any volume or snapshot survives the instance
   — has not been observed here and must not be assumed to be recoverable.

5. **Confirm the name is genuinely free before re-provisioning.** This is the
   guard for the fallback described above. Both of these must hold:

   Check the HTTP status explicitly and make the listing check fail closed. A
   bare `curl -sS … | jq 'index($n)'` is **not** safe here: `index()` over a
   non-array error body also yields `null` with exit 0, so an unreachable or
   erroring API would read exactly like "the name is free" — immediately before
   the step that destroys data.

   ```sh
   # (a) the stack record must be gone
   code=$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/provision/$OLD")
   [ "$code" = "404" ] || {
     echo "record still present (HTTP $code) — do NOT re-provision this name" >&2; exit 1; }

   # (b) the name must be absent from a listing that genuinely parsed as an array.
   #     -f so a 404/5xx fails the pipeline instead of flowing into jq.
   names=$(curl -fsS "$API/api/v1/provision/") || {
     echo "listing unavailable — cannot confirm the name is free" >&2; exit 1; }
   printf '%s' "$names" | jq -e 'type == "array"' > /dev/null || {
     echo "listing was not a JSON array — cannot confirm" >&2; exit 1; }
   printf '%s' "$names" | jq -e --arg n "$OLD" 'index($n) | not' > /dev/null || {
     echo "$OLD is still listed — do NOT re-provision this name" >&2; exit 1; }
   ```

   **An empty listing is not proof.** `GET /api/v1/provision/` deliberately
   answers `200 []` when the parameter store is unavailable, so the UI degrades
   instead of erroring (`src/routes/provision.ts:2094-2099`) — a store outage is
   indistinguishable from "no stacks exist", and it returns `501` when the store
   is not configured at all (`notConfiguredSchema`,
   `src/routes/provision.ts:2082`). If `names` comes back `[]`, corroborate
   against the parameter store directly with the section 1 read before you treat
   check (b) as passed.

   A `200` with `status: delete_failed`, or the name still present in the
   listing, means the teardown left something behind. Retry the `DELETE` (it is
   idempotent) until it reports clean. Do not proceed while either check fails:
   the re-provision will adopt what is left and stay on the shared credential.
   If you must move on, re-provision under a **different name** instead —
   the credential is minted fresh for a name that has no stored record.

6. **Re-provision.** `POST /api/v1/provision/` with the same name (now free) or a
   new one. The run mints a fresh credential generation
   (`newObjectStoreCredentialGeneration()`, passed at
   `src/routes/provision.ts:1099`), so a reused name gets a genuinely new
   credential rather than a replay of the retired one — the retired secret
   cannot be revoked, hence the nonce (`GENERATION` in the header of
   `src/services/object-store-credentials.ts`).

   This call is **asynchronous**: it answers `202` with
   `{operationId, name, status: "pending"}` (response schema for
   `POST /api/v1/provision/` in `openapi.json`) and provisions in the
   background. The stack is not usable when it returns, so poll the operation to
   a terminal state the same way step 4 does — do not read the stack's
   credential state (step 7) off a mid-flight provision.

   ```sh
   NEW=$OLD
   OP=$(curl -fsS -X POST "$API/api/v1/provision/" \
     -H 'content-type: application/json' \
     -d "{\"name\":\"$NEW\"}" | jq -r .operationId)

   while :; do
     st=$(curl -fsS "$API/api/v1/provision/operations/$OP" | jq -r .status) || exit 1
     case "$st" in done|failed) break ;; esac
     sleep 10
   done
   curl -fsS "$API/api/v1/provision/operations/$OP" | jq '{status, error, result}'
   ```

   `status` is one of `pending` / `running` / `done` / `failed` (response schema
   for `GET /api/v1/provision/operations/{id}` in `openapi.json`). Only `done`
   means the stack came up; on `failed`, read `error` and do not continue to
   step 7.

   Note the name constraint: lowercase alphanumeric, 1-63 characters
   (`requestSchema`, `src/routes/provision.ts:200-205`).

7. **Verify the new stack is not legacy.** Re-run the section 1 check. It must
   now report an `objectStoreAccessKeyId` beginning with `ovc`. If it still
   reports `legacy: true`, stop and read section 4 — the seed is the usual
   cause.

8. **Move the assets in.** For each asset from step 2, re-ingest its source from
   a URL the new stack can reach and then re-apply the metadata:

   ```sh
   curl -sS -X POST "$API/api/v1/assets/ingest-url" \
     -H "X-Stack-Name: $NEW" -H 'content-type: application/json' \
     -d '{"sourceUrl":"<staged source url>","title":"<title>","tags":[]}'
   ```

   `sourceUrl` is the only required field; `title`/`name`, `description`, `tags`
   and `sourceBackend` are optional (request schema for
   `POST /api/v1/assets/ingest-url` in `openapi.json`). Metadata that does not
   fit the ingest body goes back through `PUT /api/v1/assets/:id/metadata` and
   `PATCH /api/v1/assets/:id`.

   **Pending live verification on a throwaway stack:** this copy has not been
   run end to end here, so treat throughput, the staging-URL lifetime your
   object store grants, and the behaviour of very large sources as unmeasured.

9. **Re-create the derived outputs.** Renditions and packaged output are not
   carried by ingest. Re-run `POST /api/v1/assets/:id/transcode` and
   `POST /api/v1/assets/:id/package` (or `POST /api/v1/assets/:id/execute` for
   the full pipeline) on the new stack.

10. **Unfreeze**, and point clients at the new stack.

### What is lost if the assets do not move

Everything that exists only inside the stack's own two services. Concretely:

- **Source and packaged bytes.** They live in that stack's buckets on that
  stack's storage instance (step 3). Once step 4 removes the instance there is
  no path back to them through this API.
- **All asset metadata, and the identifiers that reference it.** The stack's
  document store holds it, and teardown removes that instance too. A re-ingest
  mints **new** asset ids, so every id you have published externally — in
  another system's database, in a bookmark, in a webhook consumer — stops
  resolving. If external ids matter to you, re-register them with
  `POST /api/v1/assets/:id/external-ids` after step 8; that is the only
  continuity mechanism the API offers across a re-provision.
- **Per-asset history and side records** — versions, comments, review state,
  execution history, thumbnails and locks. These are read and written through
  the stack's own stores, so they do not survive teardown and ingest does not
  restore them. **Pending live verification:** the exact per-collection residue
  after teardown has not been observed; the safe operating assumption is that
  nothing in the stack's document store survives.

The consequence worth planning around: this is a re-publish, not a move. Budget
for re-issuing asset ids downstream, not just for copying bytes.

---

## 3. What rotating `MINIO_ROOT_PASSWORD` does

`MINIO_ROOT_PASSWORD` has two jobs since #1094, and rotating it affects both.

- It is the **derivation seed** for every per-stack credential. The secret is
  never stored: it is recomputed on demand from the stored access key id plus
  the seed (`resolveObjectStoreCredential`,
  `src/services/object-store-credentials.ts:445-466`, keyed on
  `scrypt(seed)` via `deriveStretchedSeedKey` at line 247).
- It is the **legacy deployment-wide secret** for stacks that have no stored id
  (same function, fallback branch at line 462). The resolver is constructed with
  one value serving both roles: `minioPassword: process.env['MINIO_ROOT_PASSWORD'] ?? ''`
  (`src/main.ts:472`, documented at `src/services/workspace-stack.ts:910-914`).

A live object-store instance keeps the root credential it was created with. So
after a rotation:

- **Every already-provisioned stack with a per-stack credential breaks.** Its
  instance still expects the secret derived from the *old* seed, while the API
  re-derives from the new one and gets a different value.
- **Legacy stacks break in the same way**, for the simpler reason that the
  instance still holds the old password as `admin`'s password while the API now
  presents the new one. "Legacy stacks keep the password they were created with"
  is a statement about the *instance*, not about the API's configuration — it is
  not a form of immunity.

This is not new behaviour introduced by #1094: rotating this value already broke
access to existing stacks before per-stack credentials existed (the SEED note,
`src/services/object-store-credentials.ts:68-75`).

### What it looks like when it breaks

Object-store calls fail authorization. Expect presigned uploads, bucket reads
and delivery URL resolution to fail, and transcode jobs to fail every object
call — a 403 that reads like a missing object, which is the confusion
`src/services/encore-s3-config.ts:368-376` exists to pre-empt. A quick
confirmation per stack:
`GET /api/v1/provision/:name/reachability` (`src/routes/provision.ts:2217`)
probes the stack's storage with that stack's own resolved credential
(`src/main.ts:697-719`), so a rotation shows up as `unreachable` storage on
every stack at once.

### What recovers it

**Put the old value back.** Restoring the previous `MINIO_ROOT_PASSWORD` and
restarting restores access to every stack, legacy and per-stack alike, because
the derivation is a pure function of the seed and the stored id — nothing was
consumed or invalidated at rest. This is the only non-destructive recovery.

If the old value is genuinely gone, the surviving path is section 2's
re-provision, per affected stack, with the asset copy in step 3 impossible —
you no longer hold a credential that can read the old buckets. Treat
`MINIO_ROOT_PASSWORD` as a root secret with no recovery story: back it up before
you touch it.

One partial mitigation exists, and only for the transcoder path on legacy
stacks: the legacy secret handed to a spawned transcoder resolves
`ENCORE_S3_SECRET_KEY` then `MINIO_SECRET_KEY` then `MINIO_ROOT_PASSWORD`
(`src/main.ts:1423`), so pinning the old password in `MINIO_SECRET_KEY` keeps
transcoding working against legacy stacks. It does **not** help the API's own
clients, which read `MINIO_ROOT_PASSWORD` only, and it does not help per-stack
stacks at all, whose secret is always derived from the seed. Do not mistake it
for a rotation strategy.

---

## 4. The weak-seed fallback

A seed below the strength floor does not fail startup and does not fail a
provision. It silently keeps **new** stacks on the shared deployment-wide
credential — which is the pre-#1094 behaviour, so nothing breaks, and the
isolation you think you are getting is simply not there.

The floors, both of them enforced:

- `MINIMUM_OBJECT_STORE_SEED_LENGTH = 32` characters
- `MINIMUM_OBJECT_STORE_SEED_ENTROPY_BITS = 112` estimated bits

(`src/services/object-store-credentials.ts:284-285`. The estimate is the lower
of a character-class bound and a distinct-character bound, so a long but
repetitive value scores low on purpose — `assessObjectStoreCredentialSeed`,
same file lines 336-371.)

The gate applies **only at issue time**. `planObjectStoreCredential` treats a
weak seed exactly like an absent one (same file lines 572-584), while the read
path and the reuse branch still re-derive whatever a live instance was actually
created with — otherwise a strength change would lock the API out of working
stacks (lines 106-110 and 437-440).

### How to see it

Two log lines, and the stored field.

1. **At startup, once per deployment.** `src/routes/provision.ts:803-827` logs
   at **ERROR**: `MINIO_ROOT_PASSWORD is too weak to derive per-stack
   object-store credentials from (issue #1094): PER-STACK OBJECT-STORE
   CREDENTIALS ARE DISABLED ...`, with a structured payload carrying
   `reason`, `estimatedEntropyBits`, `minimumLength`, `minimumEntropyBits`,
   `acknowledged` and `perStackObjectStoreCredentials: 'disabled'`. If
   `ALLOW_SHARED_OBJECT_STORE_CREDENTIAL=true` is set (parsed case-insensitively
   from the literal `true`, lines 797-800) the same facts are logged at **WARN**
   instead — the state is deliberate rather than a surprise, but it is still the
   shared credential.
2. **Per provisioned stack.** `src/routes/provision.ts:1111-1125` logs at
   **ERROR**: `provisioning this stack WITHOUT a per-stack object-store
   credential; it will share the deployment-wide credential with every other
   stack (issue #1094)`, with the stack `name` and the seed-free
   `downgradeReason`. This is the line that tells you *which* stacks lost
   isolation. Note it stays at ERROR even when the shared credential is
   acknowledged; only the startup line is downgraded.

Neither line ever contains the seed or any part of it — only the assessment.

To check without reading logs: provision nothing, and instead look at the newest
stack's stored `objectStoreAccessKeyId` (section 1). A deployment whose recent
stacks all lack it, with no adoption in play, has a seed problem.

### How to fix it

1. Generate a replacement of at least 32 characters — generated, not chosen.
   `openssl rand -base64 32` is what the installation docs recommend
   (`README.md`, `MINIO_ROOT_PASSWORD` row), and it clears both floors with
   headroom.
2. Read section 3 first. Changing this value breaks access to every existing
   stack, and the only non-destructive undo is putting the old value back. In
   practice a seed replacement on a deployment that already has stacks is a
   re-provision of all of them — plan it as such, or accept that the new seed
   only improves stacks provisioned from now on while the old ones stay broken.
3. Restart the API so the startup assessment re-runs, and confirm the ERROR line
   is gone.
4. Provision one stack and confirm its stored config carries an `ovc…` access
   key id.
5. Leave `ALLOW_SHARED_OBJECT_STORE_CREDENTIAL` unset. It suppresses nothing
   except the severity of one startup line; setting it to quiet an alert
   converts a visible misconfiguration into an invisible one.

---

## Contract sources verified for this document

Read on `main` at commit `db2b846`:

| Claim | Source |
| --- | --- |
| legacy marker field | `src/services/param-store.ts:114` `StackConfig.objectStoreAccessKeyId?` |
| param-store key shape | `src/services/param-store.ts:175-177` `stackConfigKey`; `src/services/workspace-stack.ts:621` `STACK_CONFIG_NAMESPACE` |
| config-service HTTP contract | `src/services/param-store.ts:393-402`, `434-436` `configUrl` |
| field not exposed by the API | `src/routes/provision.ts:487` `storedConfigSchema`; `src/main.ts:250` serializer; `openapi.json` (0 occurrences) |
| legacy vs per-stack resolution | `src/services/object-store-credentials.ts:445-466` `resolveObjectStoreCredential`; `:155` `LEGACY_OBJECT_STORE_ACCESS_KEY_ID` |
| id prefix and length | `src/services/object-store-credentials.ts:165`, `:169` |
| issue-time decision table | `src/services/object-store-credentials.ts:495-595` `planObjectStoreCredential` |
| seed floors and assessment | `src/services/object-store-credentials.ts:284-285`, `336-371` |
| startup weak-seed report | `src/routes/provision.ts:797-827` |
| per-stack downgrade report | `src/routes/provision.ts:1111-1125` |
| fresh generation per issue | `src/routes/provision.ts:1099`; `src/services/object-store-credentials.ts:193-195` |
| object-store create body fields | `src/routes/provision.ts:1301-1302` `RootUser` / `RootPassword` |
| bucket names | `src/routes/provision.ts:99-100` |
| stack name constraint | `src/routes/provision.ts:200-205` `requestSchema` |
| teardown semantics and lifecycle marking | `src/routes/provision.ts:2280-2350`; `src/services/deprovision.ts`; `src/services/stack.ts:51-55` |
| seed used for resolver + reachability probe | `src/main.ts:472`, `697-719` |
| transcoder legacy secret fallback chain | `src/main.ts:1423`; `src/services/encore-s3-config.ts:345-376` (empty-secret guard at `:368`) |
| asset endpoints used in the procedure | `openapi.json`: `/api/v1/assets/`, `/api/v1/assets/{id}`, `/api/v1/assets/{id}/files`, `/api/v1/assets/ingest-url`, `/api/v1/assets/{id}/metadata`, `/api/v1/assets/{id}/external-ids` |
| asset list envelope (`{items, limit, offset, total}`) | `src/routes/assets.ts:1213-1218` `listSchema`; `:501` `listQuerySchema` (`limit` max 200); `openapi.json` `/api/v1/assets/` `get.responses.200` |
| provision list/create path (trailing slash) | `app.get('/')` at `src/routes/provision.ts:2076-2077` and `app.post('/')` at `:879-880`, under `prefix: '/api/v1/provision'` (`src/main.ts:601-602`); `openapi.json` documents `/api/v1/provision/` |
| provision list degraded/unconfigured responses | `src/routes/provision.ts:2094-2099` (`200 []` when the store is unavailable), `:2082` `notConfiguredSchema` (`501`) |
| async provision/teardown contract | `openapi.json`: `POST /api/v1/provision/` `202 {operationId, name, status: "pending"}`; `GET /api/v1/provision/operations/{id}` `status` ∈ `pending`/`running`/`done`/`failed` |
| no in-place credential change on the platform | OSC feedback entry `incoming-shared-minio-root-credential-across-stacks.md` (update 2026-10-14: service schema exposes only `name` / `RootUser` / `RootPassword`, `supportsUpdate: null`) |

Not verified here, and marked as such above: the live teardown residue, and an
end-to-end asset move between two live stacks. The request paths, response
shapes and status codes in this guide are each checked against the sources in
the table, and the shell snippets are syntax-checked, but the procedure as a
whole has **not** been run end to end against a live throwaway stack. Treat it
as reviewed against the contract, not as an observed run.
