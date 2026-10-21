# ADR-023: Lazy provisioning of the optional OSC service instances (scene detection, subtitles)

**Status:** PROPOSED 2026-09-24
**Date:** 2026-09-24
**Author agent:** surface-infra
**Issue:** #791 — *evaluate lazy provisioning of optional OSC service instances
(scene detection, subtitles) on first use*. Broken out from #781; sibling of
#789 / PR #805 (the `skipped` step status + reason field that #781 shipped as the
minimal fix).

This ADR is a **decision record only**. It changes no product code. Its scope is
exactly #791's acceptance criteria: decide, per service, whether lazy (on-demand)
provisioning is possible **today**, and — where it is — hand a
surface-data-pipeline/surface-infra implementation issue a design it can build
from without re-deriving anything.

---

## Summary of the decision

| Service | Lazy on first use? | Decision |
|---|---|---|
| `eyevinn-function-scenes` (scene detection) | **Yes — feasible today** | Implement lazy provisioning. Its create config requires only `name`, which a deployment already knows (the stack name). It is the same shape as the already-lazily-provisioned `eyevinn-encore-packager`, so the existing pattern is reused rather than invented. Design in [§4](#4-design-for-scene-detection-ready-for-an-implementation-issue). |
| `eyevinn-auto-subtitles` (subtitles) | **No — not fully lazy today** | Keep **explicit** operator provisioning as the primary path. Its create config additionally requires `openaikey`, an operator-supplied secret that is not available at arbitrary first-use time — on its own sufficient to rule out unconditional lazy provisioning. Compounding it, whether a wrongly-keyed instance can be repaired in place is **unknown**: the catalog does not report update support at schema-query time (§2.3), so the design must tolerate delete + recreate being the only repair. A narrow, strictly-guarded lazy path is *permitted* but is lower value and explicitly deferred. Rationale in [§5](#5-decision-for-subtitles-explicit-provisioning-stays-the-primary-path). |

The `skipped` step status from #789 / PR #805 is therefore **not** a stopgap for
either service. For scene detection it remains the correct terminal state for the
cases lazy provisioning cannot fix (no parameter store, unresolvable stack
coordinates, no object storage, provisioning still in flight past the deadline).
For subtitles it remains the correct terminal state whenever no key is
configured. This answers #791's third bullet directly.

---

## 1. Context — what happens today

Both optional services are provisioned **eagerly**, at stack-provisioning time,
inside the stack-provision operation:

- **Step 5a — `eyevinn-auto-subtitles`**, `src/routes/provision.ts:1089-1116`.
  Gated on `wantAutoSubtitles` (`src/routes/provision.ts:667`, from the request's
  `options.autoSubtitles`). Requires `OPENAI_API_KEY` on the deployment
  (`src/routes/provision.ts:597`) and **fails the whole provision fast** when the
  request opts in without it (`src/routes/provision.ts:1099-1105`). The key is
  registered as a per-service OSC secret via `secretRef`
  (`src/routes/provision.ts:790-800`) and referenced as `{{secrets.*}}`
  (`src/routes/provision.ts:1106-1113`). On success it records
  `autoSubtitlesInstanceName = name` (`src/routes/provision.ts:1115`), where
  `name` is the **stack name**.
- **Step 5b — `eyevinn-function-scenes`**, `src/routes/provision.ts:1118-1126`.
  Gated on `wantSceneDetect` (`src/routes/provision.ts:668`). Create body is
  `{ name }` and nothing else (`src/routes/provision.ts:1123`, via the shared
  `provision()` helper at `src/routes/provision.ts:841-880` which always spreads
  `{ name, ...body }`). Records `sceneDetectInstanceName = name`
  (`src/routes/provision.ts:1125`).

Both instance names are persisted into the stack record
(`src/routes/provision.ts:1187-1190`; fields declared at
`src/services/param-store.ts:71-72`).

**Runtime activation reads the stack record, not env vars** (issue #217). The
per-workspace resolver builds the step implementations at resolve time from
`config.autoSubtitlesInstanceName` / `config.sceneDetectInstanceName`
(`src/services/workspace-stack.ts:219-233`) using the builders wired at
`src/main.ts:377-392`, and exposes them on `request.connections`. When the record
carries no instance name the step implementation is `undefined` and the step
skips: `src/routes/assets.ts:1730-1755` (`triggerSceneDetect`) returns
`{ started: false, reason: SCENE_DETECT_UNCONFIGURED_REASON }`
(`src/routes/assets.ts:993-995`), and the execute loop settles the step as
`skipped` with that `skipReason` (`src/routes/assets.ts:2153-2173`).

So today an operator who did not opt in at provision time gets a permanently
`skipped` scene-detect step until they re-provision the stack or hand-edit
configuration. That is the friction #781/#791 is aimed at.

---

## 2. Verified contract sources (CLAUDE.md rule 7)

### 2.1 How the live contract was fetched (re-verified 2026-09-25)

**Every catalog fact in §2.2 and §2.3 is grounded in a live `get-service-schema`
query run while revising this ADR**, not in memory and not solely in repo
comments.

The first draft of this ADR claimed the OSC MCP was unreachable. **That was
wrong, and the error was local, not OSC's.** The authoring session had
`ToolSearch` disabled (*"No such tool available: ToolSearch. ToolSearch is
disabled for this session"*), and the draft reasoned from "the tool-discovery
mechanism is disabled" to "the contract is unreachable" without trying the MCP
endpoint itself. The endpoint was up the whole time.

Method that does work from an automated agent context, and that a future
implementer should reuse:

- `POST $OSC_MCP_URL` (`https://mcp.osaas.io/mcp`) with
  `Authorization: Bearer $OSC_ACCESS_TOKEN` — both are already present in the
  execution environment — and `Accept: application/json, text/event-stream`.
- `initialize` → `serverInfo: { name: 'osc-remote-mcp', version: '8.10.0' }`.
- Read-only catalog calls are dispatched through the `osc_call_tool` envelope
  (`{ name, args }`; `name` required), per its live `tools/list` inputSchema.
- `get-service-schema` inputSchema (live): `serviceId` **and** `verbosity`
  (`'concise' | 'detailed'`) are **both required**.

`node_modules/@osaas` ships only `client-core` and no generated per-service
schema, so the offline route genuinely does not exist — but that is irrelevant
when the MCP endpoint is reachable, which it is.

The live output agrees with the repo's 2026-07-12/13 comments on every field
name, type and requirement. Where it does **not** agree is update support — see
§2.3, which the first draft got wrong.

### 2.2 `eyevinn-function-scenes` — create config requires `name` ONLY

**Live `get-service-schema` (2026-09-25), verbatim:**

> Configuration schema for **Scene Detect Media Function**
> (`eyevinn-function-scenes`):
> **Configuration Options:**
> - **name** (string, required) — Name of mediafunction

That is the **entire** option list: one required field, no optional fields, no
`Service Dependencies` block, no secret. The live response also carries
`**Update Support:** Not confirmed at schema-query time.` and the platform-wide
instance-naming constraints reproduced in §2.3a.

Corroborating repo verifications (2026-07-12/13), which the live query confirms:

- `src/services/optional-services.ts:25-26` — *"get-service-schema for
  `eyevinn-function-scenes` (fetched by orchestrator 2026-07-12): required `name`
  ONLY. No secret."*
- `src/services/optional-services.ts:85-93` — the registry entry declares
  `fields: []`, i.e. **zero** request-supplied config fields beyond `name`.
- `src/routes/provision.ts:1118-1120` — *"Contract (get-service-schema, verified
  2026-07-13): create config requires ONLY `name` — no external key dependency."*
- `src/pipeline/scene-detector.ts:32-37` and
  `src/pipeline/osc-scene-detect.ts:11-29` — both restate the same create-config
  fact **and** record a separate, important caveat: `get-service-schema` exposes
  only the *provisioning* config, **not** the runtime endpoint's request/response
  wire shape. That un-verified wire shape is deliberately isolated in
  `src/pipeline/osc-scene-detect.ts` behind the injected `SceneDetector`
  interface.
- serviceId constant: `src/services/stack.ts:93`
  (`SCENE_DETECT_SERVICE_ID = 'eyevinn-function-scenes'`).

Consequence for this ADR: the create body for scene detection is a function of
**only the stack name**, which every code path that could trigger a lazy
provision already has. Nothing must be asked of, or held on behalf of, the
operator. The un-verified *runtime* wire shape is orthogonal — it is already
shipped and already isolated; lazy provisioning does not touch it.

### 2.3 `eyevinn-auto-subtitles` — create config requires `name` AND `openaikey`; update support is UNKNOWN

**Live `get-service-schema` (2026-09-25), verbatim:**

> Configuration schema for **Subtitle Generator** (`eyevinn-auto-subtitles`):
> **Configuration Options:**
> - **name** (string, required) — Name of auto-subtitles. Pattern: `^\w+$`
> - **openaikey** (string, required) — *"Your OpenAI API key required to access
>   OpenAI Whisper service for audio transcription and subtitle generation"*
> - **awsAccessKeyId** (string, optional)
> - **awsSecretAccessKey** (string, optional)
> - **awsRegion** (string, optional)
> - **s3Endpoint** (string, optional)
>
> **Service Dependencies:** Parameter **s3Endpoint** requires a **minio-minio**
> instance (protocol: http, routing: INTERNAL)

This confirms the required-field set and the `minio-minio` auto-wiring.

**Correction — `supportsUpdate` is not a catalog field.** An earlier draft of
this ADR asserted that the service *"reports `supportsUpdate: false`"*. **It does
not, and no such field exists anywhere in the OSC catalog.** What the live
response actually returns — identically for `eyevinn-auto-subtitles`,
`eyevinn-function-scenes` and `eyevinn-encore-packager` — is:

> **Update Support:** Not confirmed at schema-query time. If you need to change
> configuration after creation, attempt `update-service-instance` — if the
> service does not support updates, a clear error will be returned with
> delete-and-recreate instructions.

The `get-service-schema` tool description states the rule explicitly: *"The
response includes an Update Support indicator when confirmed; absence means
update support is unknown at schema-query time (runtime attempt will confirm)."*

So the accurate statement is: **this repo's 2026-07-12 verification recorded no
config-update support, and the live schema query confirms nothing either way.**
Determining it for certain requires attempting `update-service-instance` against
a real instance. This ADR therefore treats "cannot patch `openaikey` in place" as
an **unverified worst case that the design must tolerate**, not as an established
catalog fact — which is the same conservative posture, correctly attributed.

**This correction does not change the decision.** Requiring `openaikey` — an
operator-supplied secret unavailable at arbitrary first-use time — is on its own
sufficient to rule out unconditional lazy provisioning (§3 item 2, §5).

### 2.3a Platform-wide instance-name constraints (live, both services)

The live response for **every** service queried carries:

> - pattern: `^[a-z0-9]+$` (lowercase alphanumeric only, other characters are
>   stripped)
> - maxLength: **20** (post-sanitization)
> - Names are sanitized to lowercase and stripped of non-alphanumerics before the
>   length check.
> - Underlying reason: K8s DNS-1035 63-char limit on
>   `{tenant}-{serviceId}-{instanceName}`.

This matters to §4.1, where "instance name == stack name" is load-bearing. See
§4.1 for the consequence and §4.7 for the acceptance criterion.

Corroborating repo verifications (2026-07-12/13):

- `src/services/optional-services.ts:21-24` — *"get-service-schema for
  `eyevinn-auto-subtitles` (fetched by orchestrator 2026-07-12): required `name`
  (`^\w+$`) and `openaikey` (SECRET); optional awsAccessKeyId /
  awsSecretAccessKey (SECRET) / awsRegion / s3Endpoint. **No config update
  support (delete + create to change config).**"*
- `src/services/optional-services.ts:67-84` — the registry entry declares
  `openaikey` as `{ secret: true, required: true }`, with `awsAccessKeyId`,
  `awsSecretAccessKey` (also secret), `awsRegion`, `s3Endpoint` as optional
  pass-throughs.
- `src/routes/provision.ts:1089-1096` — *"Contract (get-service-schema, verified
  2026-07-13): create config requires `name` (`^\w+$`) AND `openaikey` (OpenAI
  key for Whisper). **No update-service-instance support.**"*
- serviceId constant: `src/services/stack.ts` (`AUTO_SUBTITLES_SERVICE_ID`,
  imported at `src/services/optional-services.ts:28-31`).

The repo comments at `:129-130` and `provision.ts:1089-1096` assert *"No config
update support"* / *"No update-service-instance support"*. These are legitimate
prior observations from 2026-07-12/13, but they are **not** reproducible from
`get-service-schema` — see the correction above. Treat them as an unverified
worst case, and re-check by attempting `update-service-instance` if a future
design needs to depend on the answer.

### 2.4 The existing lazy-provisioning pattern (the precedent to reuse)

**`eyevinn-encore-packager` — `src/services/packager-provisioning.ts`.** This is
the canonical on-demand provisioning path in this codebase (epic #226, issues
#243-#246, #335, #245):

- `src/services/packager-provisioning.ts:222-318` — `ensurePackagerProvisioned()`.
  Sequence: `getServiceAccessToken` → **ground-truth `getInstance` existence
  check** (`:236-239`, returns `{ status: 'exists' }` and makes the call
  idempotent) → save secrets → `createInstance` → **tolerate
  `"already taken"` / `"already exists"` as success** (`:270-283`) →
  `waitForInstanceReady` when `waitForReady` (`:286-301`) → optional
  `recordInInventory(instanceName)` hook (`:186-208`, `:304-318`) → return
  `{ status: 'created' | 'exists', instanceName }`.
- `src/services/packager-provisioning.ts:354-392` —
  `PackagerEnsureSingleFlight`: an in-process, **per-stack** single-flight so N
  concurrent first executions collapse onto one ensure run. The in-flight promise
  clears on settle (success *or* failure) so a failed ensure does not wedge the
  stack.
- `src/services/packager-provisioning.ts:415-435` —
  `teardownOnDemandPackager()`: because a lazily-provisioned instance is not
  guaranteed to be in `StackConfig.services[]`, teardown reconciles against OSC
  **ground truth** (`getInstance(serviceId, stackName)` → `removeInstance`),
  returning `removed | not_found | failed`. This is the anti-orphan safety net.
- Call site: `src/main.ts:1382-1505`. It resolves stack coordinates from the
  parameter store (`listStackNames` / `loadStackConfig` under
  `STACK_CONFIG_NAMESPACE`, `src/main.ts:1411-1425`), **fails loudly** when they
  are unresolvable (`:1436-1447`, issue #335 — it used to no-op silently), runs
  the ensure under the single-flight guard, and supplies a `recordInInventory`
  closure that read-modify-writes `StackConfig.services[]` and calls
  `paramStore.storeStackConfig(...)` (`:1470-1502`).
- Consumption: the `package` step awaits `opts.ensurePackaging()` **before**
  enqueueing (`src/routes/assets.ts:2226-2240`), and the direct package route
  does the same, mapping an ensure failure to a 502
  (`src/routes/assets.ts:3916-3928`). `ensurePackaging?: () => Promise<void>` is
  declared at `src/routes/assets.ts:943`.

**`eyevinn-encore` (transcode) — `src/encore-scaler/instance-pool.ts:150`
(`spawnInstance`), ADR-006.** The second lazy precedent: Encore instances are
spawned on demand by the auto-scaler, never by the provision route
(`src/routes/provision.ts:1063-1072`). It bounds its readiness-adjacent wait
explicitly with `ENCORE_CALLBACK_TRUST_TIMEOUT_MS`
(`src/main.ts:793`, default 60s), which is the precedent for the deadline in
[§4.5](#45-timeout-and-back-pressure).

### 2.5 The explicit operator provisioning surface that already exists

- `POST /api/v1/optional-services/:key/provision` —
  `src/routes/optional-services.ts:194-305`. Validates each descriptor field's
  `required` flag synchronously (400 on a missing `openaikey`,
  `:218-229`), snapshots values, returns **202 + operationId**, then in a
  background task saves each `secret: true` field via `saveSecret` under
  `<instanceName>.<field>` and embeds `{{secrets.<name>}}` in the create body
  (`:253-270`) before `createInstance` (`:272-278`).
- `DELETE /api/v1/optional-services/:key` — `src/routes/optional-services.ts:316`.
- Ops UI wiring: `public/app.js:4341-4344` documents the exact endpoints for
  subtitles (`POST .../auto-subtitles/provision {name,openaikey,...}`), and
  `public/app.js:4019-4064` the scene-detect equivalents.

### 2.6 Teardown already dedupes, which makes double-recording safe

`deprovisionStackFromConfig(osc, name, stored, optional)` —
`src/services/deprovision.ts:208-213` — merges the optional instance-name fields
(`OptionalStackInstances`, `:156-159`; mapped to `StoredService` entries at
`:167-191`) into `services[]` and **dedupes by `serviceId`+`instanceName`**
(`:214-219`), *"so an optional instance that was ALSO recorded in `stored` (a
\#216 provision that pushed it onto `services[]`) is torn down exactly once"*.
The stack DELETE route passes both optional fields at
`src/routes/provision.ts:1734-1745`.

This is load-bearing for [§4.6](#46-where-the-derived-instance-name-is-persisted):
a lazy path can safely write the instance to **both** `sceneDetectInstanceName`
and `services[]` without risking a double teardown.

---

## 3. Decision

1. **Scene detection (`eyevinn-function-scenes`): lazy provisioning is feasible
   today and SHOULD be implemented.** The create config requires only `name`
   (§2.2), which is exactly the shape of the already-lazily-provisioned packager
   (§2.4). There is no secret, so the `PackagerSecrets` half of the existing
   pattern drops out entirely and the ensure step is strictly *simpler* than the
   one already in production. Design: §4.

2. **Subtitles (`eyevinn-auto-subtitles`): NOT fully lazy-provisionable on first
   use.** One sufficient blocker, plus one unresolved risk (§2.3):
   - **Blocker (verified live, 2026-09-25):** the create config requires
     `openaikey`, an **operator-supplied secret**. A first-use trigger has no way
     to obtain it unless the operator already stored it out of band, so lazy
     provisioning cannot be unconditional. This alone settles the decision.
   - **Unresolved risk (not a verified fact):** whether a wrongly-keyed instance
     can be repaired in place is **unknown** — the catalog reports *"Update
     Support: Not confirmed at schema-query time"* for every service, and this
     repo's 2026-07-12 note records no config-update support. If that note is
     right, speculative lazy creation has a **worse** failure mode than skipping:
     it leaves a billable, unusable instance that only an explicit deprovision
     can clear. Because the downside is unbounded and unverified, the design
     assumes the worst case rather than betting on update support existing.

   Decision: keep explicit provisioning via
   `POST /api/v1/optional-services/auto-subtitles/provision` (§2.5) as the
   primary, supported path. Detail and the permitted narrow lazy variant: §5.

3. **The `skipped` status + reason (#789 / PR #805) is durable, not a stopgap**,
   for the residual cases in both services. See §6.

---

## 4. Design for scene detection (ready for an implementation issue)

This section is the hand-off. It is deliberately written against real symbols and
line numbers so an implementer does not have to re-derive the wiring.

### 4.1 New module, modelled 1:1 on the packager

Add `src/services/scene-detect-provisioning.ts` exporting
`ensureSceneDetectProvisioned()`, a direct analogue of
`ensurePackagerProvisioned` (`src/services/packager-provisioning.ts:222-318`)
with the secret handling removed:

- Narrow injected OSC surface (`getServiceAccessToken`, `getInstance`,
  `createInstance`, `waitForInstanceReady`, `removeInstance`) declared as an
  interface exactly like `PackagerOscApi`
  (`src/services/packager-provisioning.ts:125-147`) plus the
  `...FromContext(osc)` adapter (`:150-165`), so it is unit-testable with no live
  OSC.
- **Create body: `{ name: stackName }` and nothing else.** Per §2.2. No
  `saveSecret` call, no `{{secrets.*}}` reference, no `buildCreateBody` inputs
  beyond the stack name.
- Sequence and error tolerances copied verbatim from the packager: ground-truth
  `getInstance` first (return `exists`), `createInstance`, treat
  `"already taken"`/`"already exists"` as `exists`, then `waitForInstanceReady`,
  then `recordInInventory`, then return
  `{ status: 'created' | 'exists', instanceName }`.
- Per-phase structured logging (`attempt` / `ready` / `failure`) via the same
  optional logger interface (`src/services/packager-provisioning.ts:180-184`).
  Issue #335 exists precisely because a silent no-provision is undebuggable.

**Instance name MUST be the stack name.** Eager provisioning already establishes
this invariant (`src/routes/provision.ts:1123-1125` — the `provision()` helper
spreads `{ name, ... }` where `name` is the stack name, and
`sceneDetectInstanceName = name`), and the packager ensure step depends on the
same invariant for its ground-truth check
(`src/services/packager-provisioning.ts:215-219`). Keeping it means
`getInstance(SCENE_DETECT_SERVICE_ID, stackName)` is a complete existence check,
OSC's own name uniqueness makes more than one instance per stack impossible by
construction, and the existing teardown path (§2.6) keeps working unchanged.

**Caveat — the 20-character platform limit (pre-existing, must be handled here).**
Per §2.3a, OSC sanitizes instance names to `^[a-z0-9]+$` and enforces
`maxLength: 20` **post-sanitization**. Stack names are validated at
`src/routes/provision.ts:158-162` as `.max(63).regex(/^[a-z0-9]+$/)`. The charset
agrees; **the length does not.** A stack name of 21–63 characters is therefore
truncated by OSC, which breaks the invariant above in a specific and silent way:

- `getInstance(SCENE_DETECT_SERVICE_ID, stackName)` probes the **un**truncated
  name, so the ground-truth existence check **misses** an instance that does
  exist under the truncated name;
- the `"already taken"`/`"already exists"` tolerance (§2.4) partly masks this —
  the duplicate create is swallowed — but the persisted
  `sceneDetectInstanceName` then does not match the real instance, so runtime
  activation and teardown both address a name OSC does not have.

This is **pre-existing in the eager path** (`provision.ts:1123-1125` has the same
mismatch) and is not introduced by lazy provisioning. But since this section
promises an implementer they need not re-derive the wiring, the implementation
MUST apply the same derivation OSC does — sanitize to `^[a-z0-9]+$`, lowercase,
then truncate to 20 — in **one shared helper** used by the create call, the
`getInstance` probe, the persisted `sceneDetectInstanceName`, and teardown. Do
not sanitize at only one of those four sites; that is exactly the drift described
above. Whether to additionally tighten the stack-name validator to `.max(20)` is
a separate, breaking-change decision and is out of scope here.

### 4.2 Reuse the single-flight guard

Concurrent first executions for one stack must produce exactly one instance.
Recommended: **extract** the existing `PackagerEnsureSingleFlight`
(`src/services/packager-provisioning.ts:354-392`) into a generic
`EnsureSingleFlight<T>` keyed on a caller-supplied string
(`${serviceId}:${stackName}`) and have both the packager and scene detection use
it. Copying the class is acceptable but duplicates the clear-on-settle subtlety
(`:381-389`) that stops a failed ensure wedging a stack.

The two-layer safety property must be preserved as documented at
`src/services/packager-provisioning.ts:320-352`: the in-process lock does not
survive a restart, but because every run reconciles against the live OSC
instance, a restart mid-provision self-heals instead of orphaning or duplicating.

### 4.3 Trigger point

The trigger is **the first scene-detect pipeline step executed for a stack whose
record lacks `sceneDetectInstanceName`**.

Concretely, mirror `ensurePackaging`:

- Declare `ensureSceneDetect?: () => Promise<SceneDetector | undefined>` on the
  asset-router options next to `ensurePackaging?: () => Promise<void>`
  (`src/routes/assets.ts:943`).
- Wire the closure in `src/main.ts`, in the same activation block that wires
  `ensurePackaging` (`src/main.ts:1382-1505`) — that is the one place where
  `paramStore`, `oscContext` and `optionalStepBuilders` (`src/main.ts:377-392`)
  are all in scope.
- Consume it inside the `scene-detect` branch of the execute loop
  (`src/routes/assets.ts:2153-2173`), before `triggerSceneDetect`.

Two differences from the packager that the implementer must handle:

1. **The step is currently synchronous.** `triggerSceneDetect`
   (`src/routes/assets.ts:1730`) returns `OptionalStepOutcome`
   (`src/routes/assets.ts:982`) *synchronously* and the loop settles the step
   immediately. It has exactly one call site (`src/routes/assets.ts:2159`), so
   making it `async` and awaiting it is a contained change.
2. **Provisioning is not enough — the detector must be rebuilt.**
   `request.connections.sceneDetector` was built at *resolve* time from
   `config.sceneDetectInstanceName` (`src/services/workspace-stack.ts:230-233`),
   which is absent on first use, so it is `undefined` and stays `undefined` for
   this request no matter what the ensure step does. The ensure closure must
   therefore **return a usable `SceneDetector`**, constructed via the same
   builder the resolver uses — `optionalStepBuilders.sceneDetector(instanceName)`
   (`src/main.ts:386-391`) — rather than the caller relying on the stale resolved
   connections. Returning the built detector (not just a name) keeps the
   un-contract-verified runtime wire shape isolated in
   `src/pipeline/osc-scene-detect.ts` exactly as
   `src/pipeline/osc-scene-detect.ts:11-29` requires.

Resolution order inside the closure (cheap path first):

1. No `paramStore` → return `undefined` (structurally unconfigurable; the step
   skips with the existing reason). Note this diverges from the packager, which
   throws here (`src/main.ts:1404-1409`) — see §4.4.
2. Resolve the stack name + config exactly as the packager closure does
   (`listStackNames` / `loadStackConfig` under `STACK_CONFIG_NAMESPACE`,
   `src/services/workspace-stack.ts:378`; `src/main.ts:1411-1425`).
3. If `cfg.sceneDetectInstanceName` is set → build and return the detector with
   **no OSC call at all**. This is the steady state after the first use, and it
   is what makes the lazy path cost one provision per stack, ever.
4. Otherwise → run `ensureSceneDetectProvisioned` under the single-flight guard
   with the bounded deadline from §4.5, persist per §4.6, invalidate the
   per-workspace resolver cache (the same invalidation provision/teardown already
   performs, `src/main.ts:760-763`) so later requests take path 3 without
   re-probing, and return the built detector.

### 4.4 Failure handling — this is where scene detection MUST diverge from the packager

The packager's ensure failure **fails the step**: it throws, the execute loop's
`catch` marks the step `failed` and responds 502
(`src/routes/assets.ts:2242-2250`), and the direct route returns
`packager_provisioning_failed` (`src/routes/assets.ts:3920-3928`). That is right
for packaging, because the packaged output *is* the deliverable and a job dropped
on an unconsumed queue hangs invisibly (issue #335).

**Scene detection must not adopt that.** It is an optional, fire-and-forget,
metadata-annotating step whose documented contract is that it never throws into
the caller and never drives the lifecycle state machine
(`src/pipeline/scene-detector.ts:11-16`; `src/routes/assets.ts:2154-2157`). A
provisioning failure must therefore settle the step as **`skipped` with a reason
naming the provisioning failure**, and record that reason on the asset — not fail
the pipeline run.

This needs **no API contract change**: `stepStatusSchema` already includes
`skipped` (`src/routes/assets.ts:1005`), `skipReason` is already
`z.string().optional()` (`src/routes/assets.ts:1012`), and
`recordOptionalStepSkip` (`src/routes/assets.ts:1768`) already writes the reason
onto the asset as `sceneDetectionError`. The lazy path is a pure strict
improvement over #789's behaviour: the first execution either provisions and
runs, or reports `skipped` with a *provisioning-failure* reason instead of
`skipped` with a *"not configured"* reason.

Recommended reason taxonomy (all `skipped`, all recorded on the asset):

| Cause | Reason |
|---|---|
| No parameter store / unresolvable stack coordinates | new reason naming the missing coordinates, modelled on the packager's messages at `src/main.ts:1405-1447` |
| No object storage | existing `SCENE_DETECT_NO_STORAGE_REASON` (`src/routes/assets.ts:996`) |
| `createInstance` / readiness errored | new reason carrying the OSC error message |
| Deadline hit while still provisioning | new "provisioning in progress, retry" reason (§4.5) |
| Lazy provisioning disabled by the operator | existing `SCENE_DETECT_UNCONFIGURED_REASON` (`src/routes/assets.ts:993-995`) |

The ensure closure should never throw into the execute loop; it returns
`undefined` plus a reason. Keeping the throw-free boundary is what preserves the
#789 guarantee that a `full` pipeline run still reports overall completion when
an optional step skips (`src/routes/assets.ts:2253-2258`).

### 4.5 Timeout and back-pressure

This is the sharpest constraint, and the reason the design cannot be a
copy-paste of the packager.

**`waitForInstanceReady` has no deadline.** It is the `@osaas/client-core`
function, and every call site in this repo passes only
`(serviceId, name, ctx)` — `src/main.ts:321`,
`src/services/packager-provisioning.ts:157-158` and `:288`,
`src/routes/provision.ts:903`, `:1031`, `:1119`, `:1124`,
`src/encore-scaler/instance-pool.ts:199` and `:250`. There is no timeout
parameter to pass. A `package` step absorbs an unbounded wait because it is
already asynchronous and callback-advanced (`src/routes/assets.ts:2238-2240`
settles it as `running` and breaks). A `scene-detect` step settles **inside** the
`POST /:id/execute` request, so an unbounded wait would hold that request open
for a cold start of unknown length.

Required design:

- **Bound the ensure in an explicit race** against a configurable deadline —
  `SCENE_DETECT_PROVISION_TIMEOUT_MS`, suggested default `120000`. Precedent for
  a hand-rolled bounded wait around OSC readiness is
  `ENCORE_CALLBACK_TRUST_TIMEOUT_MS` (`src/main.ts:793`, default 60s, quarantines
  an instance on timeout rather than dispatching to it).
- **On timeout, do NOT cancel the provisioning and do NOT remove the instance.**
  The instance keeps coming up; the next execution's ground-truth `getInstance`
  check (§4.1) adopts it and returns `exists`. Settle *this* execution's step as
  `skipped` with the "provisioning in progress" reason. First use becomes
  *eventually consistent* rather than slow — which is the right trade for an
  optional metadata step.
- **The single-flight guard *is* the back-pressure** (§4.2): N concurrent first
  executions for a stack produce one `createInstance`; the losers await the same
  bounded promise and each independently honour the deadline. There is no
  unbounded fan-out of OSC create calls, and the one-instance-per-stack naming
  invariant (§4.1) caps the blast radius at one instance per stack regardless of
  request volume.
- **12-factor knobs** (both new env vars, per the project's env-var-only
  configuration rule): `SCENE_DETECT_PROVISION_TIMEOUT_MS` and a kill switch
  `SCENE_DETECT_LAZY_PROVISION` (recommended default enabled, with `false`
  restoring today's skip-only behaviour). These sit alongside the existing
  non-activation runner knobs `SCENE_DETECT_PATH` (`src/main.ts:390`) and
  `SCENE_URL_TTL_SECONDS` (`src/pipeline/scene-detector.ts:46-54`).

### 4.6 Where the derived instance name is persisted

On a successful ensure, write **both** fields on the stack record, via a
read-modify-write against `paramStore.loadStackConfig` /
`paramStore.storeStackConfig` under `STACK_CONFIG_NAMESPACE`, mirroring the
packager's `recordInInventory` closure (`src/main.ts:1470-1502`):

1. **`StackConfig.sceneDetectInstanceName`** (`src/services/param-store.ts:72`) —
   set to the stack name. This is the field that:
   - activates the step on every subsequent run
     (`src/services/workspace-stack.ts:230-233`), so the second execution needs
     no OSC call;
   - drives `options.sceneDetect` on `GET /stacks/:name`
     (`src/routes/provision.ts:1495-1499`);
   - is passed to teardown (`src/routes/provision.ts:1742-1744` →
     `src/services/deprovision.ts:181-189`).
2. **`StackConfig.services[]`** (`src/services/param-store.ts:94`) — append
   `{ serviceId: SCENE_DETECT_SERVICE_ID, instanceName }`, idempotently (skip if
   already present), exactly as the packager does. This is the inventory
   `computeStackReadiness` and the stored-config teardown read.

Writing both is safe: `deprovisionStackFromConfig` dedupes by
`serviceId`+`instanceName` (§2.6, `src/services/deprovision.ts:214-219`), so the
instance is enumerated — and removed — exactly once.

**Persist-failure handling.** An instance that exists in OSC but is recorded
nowhere is a **cost-leaking orphan**: whole-stack teardown enumerates
`services[]` plus the two optional instance-name fields
(`src/routes/provision.ts:1734-1745`) and would never see it. So:

- Log the persist failure as an error with the stack name and serviceId (the
  packager rethrows here, `src/main.ts:1477-1484` /
  `src/services/packager-provisioning.ts:304-318`).
- Still run the detection for this execution — the instance exists and the work
  is legitimate.
- **Add a ground-truth teardown probe** so an unrecorded instance can never leak:
  a `teardownOnDemandSceneDetect(osc, stackName)` modelled on
  `teardownOnDemandPackager` (`src/services/packager-provisioning.ts:415-435`) —
  `getInstance(SCENE_DETECT_SERVICE_ID, stackName)`, `removeInstance` if present,
  return `removed | not_found | failed` — called from the stack DELETE path
  alongside the existing packager teardown (`src/routes/provision.ts:1695-1724`).
  This probe is **not optional**; it is what makes the design safe against a
  partial persist, and it is idempotent for stacks that never used scene
  detection (they get `not_found`).

### 4.7 Acceptance criteria the implementation issue should carry

1. Executing a `scene-detect` step against a stack with no
   `sceneDetectInstanceName` provisions `eyevinn-function-scenes` with body
   `{ name: <stackName> }`, waits for readiness within the deadline, and runs the
   detection; the step settles `done`.
2. `StackConfig.sceneDetectInstanceName` and `StackConfig.services[]` both carry
   the instance afterwards; `GET /stacks/:name` reports
   `options.sceneDetect: true`.
3. A second execution provisions nothing (zero `createInstance` calls) and still
   runs the detection.
4. N concurrent first executions for one stack produce exactly one
   `createInstance` (single-flight test against an injected counting fake, as
   `PackagerEnsureSingleFlight` was designed for).
5. A `createInstance` failure settles the step `skipped` with a
   provisioning-failure `skipReason`, records it on the asset as
   `sceneDetectionError`, and **does not** fail the pipeline execution or return
   5xx.
6. Exceeding `SCENE_DETECT_PROVISION_TIMEOUT_MS` settles the step `skipped` with
   the in-progress reason and leaves the instance in place; a later execution
   adopts it (`status: 'exists'`).
7. `SCENE_DETECT_LAZY_PROVISION=false` restores today's behaviour exactly.
8. Stack teardown removes a lazily-provisioned instance in **both** cases: when
   it was persisted, and when the persist failed (ground-truth probe, §4.6).
9. No change to `openapi.json` step/status schemas (they already carry `skipped`
   and `skipReason`).
10. **A stack whose name exceeds the 20-character OSC limit (§2.3a, §4.1) still
    round-trips.** With a stack name of 21+ characters: the create call, the
    `getInstance` existence probe, the persisted `sceneDetectInstanceName` and
    teardown all use the **same** sanitized-and-truncated name; a second
    execution resolves `status: 'exists'` and issues **zero** `createInstance`
    calls; and teardown removes the instance OSC actually holds. A test at the
    boundary (exactly 20) and just over it (21) is the cheapest way to pin this.

---

## 5. Decision for subtitles: explicit provisioning stays the primary path

**`eyevinn-auto-subtitles` is not lazily provisionable on first use today.** Per
§2.3 its create config requires `openaikey`, an operator-supplied secret — which
is sufficient on its own. Whether an existing instance's config can be updated in
place is **unknown** (the catalog does not confirm update support at
schema-query time), so the design below assumes it cannot.

The durable behaviour:

1. **Primary path — explicit operator provisioning.** Keep
   `POST /api/v1/optional-services/auto-subtitles/provision {name, openaikey,
   ...}` (`src/routes/optional-services.ts:194-305`, surfaced in the ops UI at
   `public/app.js:4341-4344`) as the supported way to enable subtitles after
   stack provisioning, alongside the existing opt-in at provision time
   (`src/routes/provision.ts:1089-1116`). The operator has to produce a key out
   of band regardless, so an explicit call costs them essentially nothing that a
   lazy path would save.
2. **When no key is configured, skip — never speculatively provision.** The
   existing `SUBTITLES_UNCONFIGURED_REASON`
   (`src/routes/assets.ts:990-992`) settling the step as `skipped` is the correct
   terminal state, not a stopgap. Creating a keyless or wrongly-keyed instance is
   strictly worse than skipping: if config update is unsupported (§2.3 — assumed,
   not confirmed) it can only be repaired by delete + recreate, leaving a
   billable, unusable instance the operator must notice and clean up.
3. **Permitted but deferred — a narrow lazy path guarded on a pre-stored key.**
   If a future issue wants first-use provisioning for subtitles, it is
   *acceptable* only under all of these conditions:
   - **Guard strictly on a key that is already available** from the exact source
     eager provisioning already uses: `process.env['OPENAI_API_KEY']`
     (`src/routes/provision.ts:597`). Absent ⇒ do not attempt; skip with the
     existing reason. This is the same fail-fast posture as
     `src/routes/provision.ts:1099-1105`, downgraded from "fail the provision" to
     "skip the optional step".
   - **Reuse the established secret handling**: `saveSecret` under
     `<stackName>.openaikey` and a `{{secrets.*}}` reference in the create body
     (`src/routes/provision.ts:790-800`, `:1106-1113`;
     `src/routes/optional-services.ts:258-270`). The literal key must never enter
     the create body, a log line, an operation record, or a response.
   - **Because in-place config update cannot be relied on (§2.3), an existing
     instance must be ADOPTED as-is, never recreated to apply a changed key.**
     Before building on this, confirm the answer by attempting
     `update-service-instance` once against a throwaway instance; if update turns
     out to be supported, this constraint can be relaxed. Reuse the packager's
     `exists` semantics (`src/services/packager-provisioning.ts:236-239`). Key
     rotation stays an explicit operator action —
     `DELETE /api/v1/optional-services/auto-subtitles`
     (`src/routes/optional-services.ts:316`) then
     `POST .../auto-subtitles/provision` — and should be documented as such.
   - Everything from §4.2 (single-flight), §4.4 (skip, never fail the run), §4.5
     (bounded deadline) and §4.6 (persist to `autoSubtitlesInstanceName` +
     `services[]`, plus a ground-truth teardown probe) applies unchanged.

   Recommendation: do **not** bundle this with the scene-detect work. Scene
   detection is secret-free and independently valuable; the subtitles variant
   adds secret handling and a rotation caveat for marginal operator convenience.

### 5.1 Related gap found while grounding this ADR (out of #791's scope)

`POST /api/v1/optional-services/:key/provision` creates the instance but **never
writes `sceneDetectInstanceName` / `autoSubtitlesInstanceName` into the stack
record**. It returns `instanceNameEnvVar` for the operator to set by hand
(`src/routes/optional-services.ts:286-294`; `DELETE` likewise reads the instance
name from that env var, `src/routes/optional-services.ts:316-320`). But runtime
activation comes from the **stack record**, not the env var — stated explicitly at
`src/services/optional-services.ts:9-13` (*"the RUNTIME pipeline no longer
activates these steps from the env vars — activation is derived from the ACTIVE
stack record"*) and implemented at `src/services/workspace-stack.ts:219-233`.

So provisioning either optional service through the ops UI does **not** activate
its pipeline step without a manual env-var edit and an API restart, and the
instance is also absent from the stack record that teardown enumerates (§2.6) —
an orphan risk on deprovision.

This ADR does not fix that (it is not #791's deliverable), but it records two
things for a follow-on issue: the explicit provisioning endpoint **should** also
persist the instance name into `StackConfig` (and `services[]`), and the lazy
path designed in §4.6 **must not** replicate the omission.

---

## 6. Consequences

**What this ADR changes now:** nothing in the product. It is a decision record.

**What follows from it:**

- One implementation issue for scene detection, scoped by §4 and its acceptance
  criteria in §4.7, owned by surface-data-pipeline (trigger point, step
  semantics) with surface-infra on the ensure/teardown module. Net effect for
  operators: enabling scene detection stops requiring a re-provision or a
  restart, and an opted-out stack still pays nothing until the step is actually
  used.
- No lazy-provisioning issue for subtitles. If one is opened later it inherits
  the constraints in §5 item 3.
- A follow-on issue for the §5.1 record-persistence gap in the explicit
  optional-services provisioning endpoint.
- Recommended refactor: extract `EnsureSingleFlight` from
  `src/services/packager-provisioning.ts:354-392` so the second consumer does not
  duplicate it.

**Cost and lifecycle.** Lazy scene detection provisions at most one instance per
stack, named after the stack, adopted on every subsequent run. A stack that never
runs a scene-detect step creates nothing — the same zero-cost property the
on-demand packager already gives packaging
(`src/routes/provision.ts:1063-1072`). Teardown is covered twice (persisted
record *and* ground-truth probe, §4.6) so the new lifecycle cannot leak a
billable instance.

**The `skipped` status stays.** #789 / PR #805 is confirmed as durable behaviour,
not a stopgap, for: subtitles without a key; scene detection with no parameter
store, unresolvable stack coordinates, or no object storage; a provisioning
failure; a provisioning deadline overrun; and lazy provisioning switched off.
This is the explicit answer to #791's third bullet.

**Residual risk.** The *runtime* wire shape of `eyevinn-function-scenes` is still
not contract-verified (`src/pipeline/osc-scene-detect.ts:11-29`). Lazy
provisioning makes the step reachable for more deployments, which raises the
chance of hitting that unverified shape. It does not make the shape any less
correct or any harder to fix — it is still isolated in one module behind one
injected interface — but the implementation issue should note it, and the
detector's existing error path already records a failure on the asset as
`sceneDetectionError` rather than failing the run
(`src/pipeline/scene-detector.ts:11-16`).

---

## 7. Acceptance mapping (issue #791)

| Acceptance criterion | Where it is met |
|---|---|
| "A documented decision (ADR note or OSC feedback log) on whether lazy provisioning is possible for these two services today." | This ADR, §3 (with the decision table at the top). Supporting friction logged in `docs/osc-feedback/incoming-issue791-lazy-provision-optional-services.md`. |
| "If feasible, a design ready for a `surface-data-pipeline`/`surface-infra` implementation issue." | §4, including trigger point (§4.3), failure handling (§4.4), timeout/back-pressure (§4.5), persistence (§4.6) and acceptance criteria (§4.7). |
| "Introspect the live OSC catalog … confirm whether an on-demand provisioning path exists with the same shape used for the existing lazily-provisioned services." | §2.2-§2.4. Done against the **live** catalog: `get-service-schema` was run for `eyevinn-function-scenes`, `eyevinn-auto-subtitles` and `eyevinn-encore-packager` on 2026-09-25 (method in §2.1), and the in-repo 2026-07-12/13 verifications corroborate it on every field. Scene detection matches the packager's shape; subtitles does not. |
| "If not feasible today, log the gap to `docs/osc-feedback/` and confirm the minimal fix (skipped status + reason field) is the durable behaviour rather than a stopgap." | §5 and §6 ("The `skipped` status stays"), plus the feedback log. |

---

## 8. Contract sources verified

Every line reference below was read in this branch before being cited.

**Catalog / service contracts — PRIMARY (live `get-service-schema`, 2026-09-25):**
- `eyevinn-function-scenes` — required `name` only; no optional fields, no
  dependencies, no secret (§2.2).
- `eyevinn-auto-subtitles` — required `name` (`^\w+$`) + `openaikey`; optional
  `awsAccessKeyId` / `awsSecretAccessKey` / `awsRegion` / `s3Endpoint`;
  `s3Endpoint` requires a `minio-minio` instance (§2.3).
- Both, plus `eyevinn-encore-packager` — *"Update Support: Not confirmed at
  schema-query time"*; instance names `^[a-z0-9]+$`, `maxLength: 20`
  post-sanitization (§2.3, §2.3a).
- Fetched via `POST $OSC_MCP_URL` → `osc_call_tool` → `get-service-schema`
  (`serviceId` + `verbosity` both required); server `osc-remote-mcp` 8.10.0.

**Catalog / service contracts — CORROBORATING (in-repo, 2026-07-12/13):**
- `src/services/optional-services.ts:20-26` — both services' create configs.
- `src/services/optional-services.ts:66-94` — the field registry
  (`openaikey` required+secret; scene detection `fields: []`).
- `src/routes/provision.ts:1089-1096` — auto-subtitles: `name` + `openaikey`;
  also asserts "no update support", which the live schema does **not** confirm
  either way (§2.3).
- `src/routes/provision.ts:1118-1120` — function-scenes: `name` only.
- `src/pipeline/scene-detector.ts:32-37`, `src/pipeline/osc-scene-detect.ts:11-29`
  — same create config, plus the runtime wire shape is NOT exposed by
  `get-service-schema`.
- `src/services/stack.ts:93` — `SCENE_DETECT_SERVICE_ID`.
- Issue #791 thread, OSC verification 2026-09-24 — `s3Endpoint` auto-wiring to
  `minio-minio` for auto-subtitles (confirmed live 2026-09-25). The same thread's
  `supportsUpdate: false` reading is **superseded** — see §2.3.

**Current eager provisioning:**
- `src/routes/provision.ts:667-668` (opt-in flags), `:597` (`OPENAI_API_KEY`),
  `:790-800` (`secretRef`), `:841-880` (`provision()` helper),
  `:1082-1088` (why the packager is not provisioned here), `:1089-1116` (step 5a),
  `:1118-1126` (step 5b), `:1187-1190` (persisting the instance names),
  `:1495-1499` (`options.*` on GET), `:1695-1724` (packager teardown),
  `:1734-1745` (optional-service teardown).
- `src/services/param-store.ts:71-72`, `:94` — `StackConfig` fields.

**Existing lazy-provisioning pattern:**
- `src/services/packager-provisioning.ts:125-165` (injected OSC surface +
  adapter), `:186-208` (`EnsurePackagerDeps`, `recordInInventory`), `:222-318`
  (`ensurePackagerProvisioned`), `:320-392` (`PackagerEnsureSingleFlight` and its
  two-layer safety rationale), `:415-435` (`teardownOnDemandPackager`).
- `src/main.ts:1382-1505` — the ensure call site, stack-coordinate resolution,
  fail-loud behaviour, inventory recording.
- `src/routes/assets.ts:943` (`ensurePackaging` option), `:2226-2240` (awaited in
  the `package` step), `:3916-3928` (direct route, 502 on failure).
- `src/encore-scaler/instance-pool.ts:150` (`spawnInstance`, ADR-006) and
  `src/main.ts:793` (`ENCORE_CALLBACK_TRUST_TIMEOUT_MS`) — the bounded-wait
  precedent.

**Runtime activation and step semantics:**
- `src/services/workspace-stack.ts:219-233` (activation from the stack record),
  `:378` (`STACK_CONFIG_NAMESPACE`).
- `src/main.ts:377-392` (`optionalStepBuilders`), `:760-770` (activation
  rationale).
- `src/routes/assets.ts:975-1013` (`OptionalStepOutcome`, skip reasons,
  `stepStatusSchema`, `skipReason`), `:1696-1755` (`triggerSubtitles` /
  `triggerSceneDetect`), `:1768` (`recordOptionalStepSkip`), `:2132-2173` (the
  subtitles/scene-detect branches), `:2242-2258` (failure + all-done handling).
- `src/pipeline/scene-detector.ts:11-16`, `:46-54` (fire-and-forget contract,
  `SCENE_URL_TTL_SECONDS`).

**Explicit provisioning surface:**
- `src/routes/optional-services.ts:194-305` (provision), `:286-294`
  (`instanceNameEnvVar` in the result), `:316-320` (deprovision from the env var).
- `public/app.js:4019-4064`, `:4341-4344` (ops UI endpoints).

**Teardown:**
- `src/services/deprovision.ts:150-191` (`OptionalStackInstances`,
  `optionalStoredServices`), `:208-219` (`deprovisionStackFromConfig` and the
  `serviceId`+`instanceName` dedupe).

**`waitForInstanceReady` has no deadline parameter** — every call site passes
only `(serviceId, name, ctx)`: `src/main.ts:321`,
`src/services/packager-provisioning.ts:157-158`, `:288`,
`src/routes/provision.ts:903`, `:1031`, `:1119`, `:1124`,
`src/encore-scaler/instance-pool.ts:199`, `:250`.
