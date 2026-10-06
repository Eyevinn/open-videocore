# Interaction spec: export-action states — in progress, success, failure, not-available, no destinations

**Issue:** #911 (broken out from #796, which itself sat behind the outcome-honesty fix in
#944). Feeds the implementation ticket that adds the export action to the web UI.
**Status:** design spec. No production code accompanies it — there is no export action in
`public/` yet (verified below), so there is nothing to retrofit.
**Audience:** whoever implements the export button/panel on asset detail, plus anyone
writing operator copy about export.

This pins **copy and visual treatment** for five states. Four belong to one action — `POST
/api/v1/assets/{id}/export` (the "re-wrap" action — copies a source into a new container
format without re-encoding). The fifth, the issue's "zero destinations configured"
criterion, belongs to the sibling **delivery** action `POST /api/v1/assets/{id}/deliver`,
which is where a destination is actually chosen. This spec does not restate the contract, it
cites it — by **symbol name**, not line number, so a citation stays greppable as the files
move.

**Every cross-reference to a state uses the section's *name*, never its number.** State
numbers have already drifted once — a vocabulary section was inserted mid-review and silently
pointed every numeric reference at the wrong state. Refer to a state by its heading text, so
inserting a section can never make a reference wrong. The only numeric references left are to
the contract-grounding subsections `§0.1`–`§0.4` below, which exist solely to avoid repeating
long headings in table cells; if you insert a subsection there, renumber the refs or switch
them to names too.

---

## 0. Contract grounding

Everything below was read from this tree on branch `issue-911/export-action-states` after
merging `origin/main`: `openapi.json`, the route source, the pipeline source, the
storage-backend registry, and `public/`. Nothing is taken from the issue text. Every citation
names a symbol, selector, or `openapi.json` path you can grep for.

### 0.1 The export (re-wrap) action

| What | Exact symbol verified |
|---|---|
| Endpoint | `POST /api/v1/assets/{id}/export`. Handler: the `app.post('/:id/export', …)` registration in `src/routes/assets.ts`. `openapi.json` → `paths["/api/v1/assets/{id}/export"].post` declares exactly `201, 400, 404, 409, 501, 502` |
| Request body | `exportBodySchema`, `src/routes/assets.ts`: `{ targetFormat: 'mp4'\|'mkv'\|'mov'\|'mxf'\|'ts'` (required) `, outputName?: string(1..256), asVersion?: boolean }`. **No destination field of any kind** — confirmed against `openapi.json` → `paths["/api/v1/assets/{id}/export"].post.requestBody`, which has `additionalProperties: false`. See §0.2 for what this does and does not imply |
| 201 body | `assetSchema` (`src/routes/assets.ts`) — the new child asset. Relevant fields for this spec: `id`, `name`, `slug`, `status` (`'ready'` on a 201), `parentId` (= source asset id), `objectKey` (present directly on the response — no extra fetch needed to know where the output landed) |
| Default child name | `outputName`, else `<source name> [<format>]` — the `name:` property of the child-asset literal in `rewrap()`, `src/pipeline/rewrap.ts`, which reads `outputName ?? \`${baseName} [${targetFormat}]\``. `baseName` is the `const baseName = source?.name ?? sourceAssetId` binding in the same function (it is **not** the `isRewrapFormat` guard a few lines above it — grep the identifier, not a line) |
| Output object key | `exports/<newAssetId>.<format>` — `rewrapObjectKey`, `src/pipeline/rewrap.ts` |
| **201 is falsifiable** | Three layers agree before it is sent: job-status allow-list (`SUCCESS_STATUSES`, `src/pipeline/osc-rewrap.ts`), the `deps.storage.statObject(outputKey)` HEAD + non-empty check in `rewrap()` (`src/pipeline/rewrap.ts`), only then the `ready` transition. Documented contract note: `docs/findings/export-truthful-status-944.md` |
| 400 | Unsupported `targetFormat` — the Zod enum built from `REWRAP_FORMATS` at the edge; `UnsupportedFormatError` thrown defensively behind the `isRewrapFormat` guard in `rewrap()` (`src/pipeline/rewrap.ts`). Body: `errorSchema` (`error`, `message?`), `src/routes/assets.ts` |
| 404 | Unknown/foreign asset — `reply.code(404).send({ error: 'not_found' })` in the export handler. Existence is not leaked |
| 409 | `{ error: 'no_object', message: 'asset has no stored source object to process' }` — `NO_SOURCE_OBJECT_ERROR` / `NO_SOURCE_OBJECT_MESSAGE`, `src/pipeline/source-object.ts`, sent by the shared `requireSourceObject` helper, which the export handler calls before anything else |
| **501** | `{ error: 'not_configured', message: 'export / re-wrap is not configured' }` — the `if (!opts.rewrapRunner \|\| !storageFor)` guard in the export handler (deployment never wired a re-wrap runner or workspace storage). This is the only "nowhere for an export to go" condition **this endpoint** can produce — see § "Export is not available on this deployment" |
| 502 | `{ error: 'rewrap_failed', message: <single status-bearing sentence> }` — the `reply.code(502).send({ error: 'rewrap_failed', message })` in the export handler's catch. The ffmpeg log is captured server-side only (`oscJobLog(err)`, logged at `warn` in the same catch) and is **never** in `message` — a deliberate security position (the log is third-party output and can carry storage endpoints/bucket names), not an oversight. `message` is what the UI has to show; it is real, not generic ("Export failed") |
| Failed export leaves no file to serve | `rewrap()` sets `objectKey` only **after** verification passes (the `update` calls follow the `statObject` guard, `src/pipeline/rewrap.ts`) — a `502` child is `status: 'failed'` with **no** `objectKey`, so it can never 200 a `/files` entry for bytes that don't exist |
| Synchronous, no polling | The handler `await`s the resolved runner inline; there is no `processing`-then-poll contract for this action. The only "in progress" state is the one request in flight |
| Source unchanged | Export is a pure read of the source asset — never mutated |

### 0.2 The export-destinations registry — and why "zero destinations" IS reachable

`exportBodySchema` has no `destination` field, so **`POST /:id/export` never consults the
export-destinations registry and cannot be gated by it.** It always writes to the workspace's
own provisioned storage (`storageFor()`). That much is unchanged.

What *has* changed, and what an earlier draft of this spec got wrong: the registry is **no
longer** consumed only by `POST /:id/package` and `POST /:id/execute`. `main` now carries a
third consumer, and it makes the issue's "zero destinations configured" criterion a real,
reachable state.

| What | Exact symbol verified |
|---|---|
| Delivery endpoint | `POST /api/v1/assets/{id}/deliver` (issue #1131, merged in #1158). `openapi.json` → `paths["/api/v1/assets/{id}/deliver"].post`. Handler: the `app.post('/:id/deliver', …)` registration in `src/routes/assets.ts` |
| Destination is **required** | `deliverBodySchema`, `src/routes/assets.ts`. `openapi.json` → the same path's `requestBody.content["application/json"].schema` is `{ properties: { destination: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['destination'], additionalProperties: false }`. There is no implicit fallback: a delivery **cannot** be issued without naming a destination |
| Resolved through the same registry | `registry.resolveForOutput(STACK_CONFIG_NAMESPACE, ref)` in the deliver handler, then `resolveJobDestination` — the same resolver `/:id/package` and `/:id/execute` use |
| **The implicit default is refused** | `resolveForOutput` (`src/services/storage-backend-registry.ts`) opens with `if (idOrName === DEFAULT_BACKEND_ID) return undefined;` — **by design**, documented in the comment above it ("the implicit OSC-managed default resolves to undefined: it is NOT an external backend"). The deliver handler therefore checks `ref === DEFAULT_BACKEND_ID` first and answers `400 { error: 'bad_request', message: '"default" is the platform-managed default store the asset already lives in, not an export destination; name a destination registered via POST /api/v1/export-destinations' }` |
| `DEFAULT_BACKEND_ID` | `export const DEFAULT_BACKEND_ID = 'default' as const` — `src/services/storage-backend-registry.ts` |
| The registry list always contains that default | `StorageBackendRegistry.list()` returns `[defaultBackendView(), ...views]` — it **unconditionally prepends** the synthetic default (`defaultBackendView()`: `id: 'default'`, `name: 'OSC-managed default'`, `role: 'both'`, `deletable: false`), `src/services/storage-backend-registry.ts` |
| …and that default passes the destinations filter | `isExportDestination(role)` returns `role === 'packaged' \|\| role === 'both'` — `src/routes/export-destinations.ts`. The default's `role` is `'both'`, so it survives the filter in the `app.get('/', …)` handler of the same file |
| `GET /api/v1/export-destinations` | `openapi.json` → `paths["/api/v1/export-destinations/"].get` declares `200` (`{ destinations: [...] }`, each entry `{ id, name, role, backend, bucket, accessKeyId, hasSessionToken, deletable, createdAt, credentials, … }`) and `501`. The `501` body is `notConfiguredPayload` (`src/routes/export-destinations.ts`) = `{ error: 'not_configured', message: 'export destinations are not configured' }` — the registry itself isn't wired (no param store / no secret storage) |
| Non-output backends never reach a picker | The list is filtered by `isExportDestination`, so `role: 'source'` / `'archive'` backends are absent from `GET /api/v1/export-destinations` entirely. The deliver handler's own `422 { error: 'backend_role' }` for those roles is therefore unreachable from a picker built off this list — it exists for direct API callers |

**The correct conclusion.** Combine the two rows in bold:

- `GET /api/v1/export-destinations` can never return a literally empty `destinations` array
  while the registry is configured — `list()` always prepends the default.
- But the only entry in that array on a fresh deployment is the `default`, and `POST
  /:id/deliver` **refuses** `default` with a `400`.

So a deployment whose registry holds nothing but the default has **zero *usable* export
destinations**: every destination the API will show you is one the delivery endpoint will
reject. That is precisely issue #911's "zero destinations configured" acceptance criterion,
and it is the *default* condition of any deployment where no operator has yet called `POST
/api/v1/export-destinations`. It is reachable, it is common, and it must be designed for —
see § "No export destinations are configured".

The predicate a UI must evaluate is therefore **not** `destinations.length === 0`. It is:

```js
// Deliverable destinations = the list minus the implicit default, which
// POST /:id/deliver answers 400 for (resolveForOutput returns undefined for
// DEFAULT_BACKEND_ID by design — storage-backend-registry.ts).
const deliverable = destinations.filter(d => d.id !== 'default');
```

`deliverable.length === 0` is the no-destinations state. A picker must also **exclude** the
`default` entry from its options rather than merely warning about it — offering a choice the
endpoint answers `400` for is the same class of dishonesty #944 removed from the API side.

Two conditions that look alike and are not, and must not share copy:

| Condition | API shape | Who fixes it, and how |
|---|---|---|
| Registry not wired at all | `GET /api/v1/export-destinations` → `501 { error: 'not_configured', message: 'export destinations are not configured' }`; `POST /:id/deliver` → `501 { error: 'not_configured', message: 'storage-backend registry is not configured' }` (two different sentences for one condition — the UI should use its own copy, below, not echo either) | Whoever provisions the deployment — a service/param-store gap. Nothing an operator can do from this UI |
| Registry wired, nothing registered | `GET` → `200` with only the `default` entry; a delivery attempt would `400` | An operator, from this UI's own surface — `POST /api/v1/export-destinations` |

### 0.3 A UI cannot say *where* a file landed via `type: 'export'` — the enum member is unused

`assetFileSchema.type` (`GET /:id/files`, `src/routes/assets.ts`) declares
`z.enum(['source', 'rendition', 'export'])`, but the handler registered at
`app.get('/:id/files', …)` only ever pushes `type: 'source'` (from `asset.objectKey`) or
`type: 'rendition'`. Grepping `src/routes/assets.ts` for `type: 'export'` returns no
assignment — only the enum declaration. **An exported child asset's own stored object is
reported as `type: 'source'` through `/:id/files`, not `type: 'export'`.** This spec
therefore does not use `/:id/files` to identify the export at all — § "Export succeeded"
reads `objectKey`/`name`/`id` straight off the **201 response body**, which needs no further
request and is not subject to this gap. (Noted for the implementer so nobody later writes a
`.filter(f => f.type === 'export')` that silently matches nothing.)

### 0.4 What already exists in `public/` to build on

No export UI and no delivery UI exist yet — `grep -rn "rewrap\|targetFormat" public/*.js
public/*.html` and `grep -rn "export-destinations\|destination" public/*.js` both return
nothing (the hits for the literal string `export` elsewhere in `public/*.js` are all
ES-module `export function`/`export const` statements, not this feature). The nearest sibling
actions already wired — the `#btn-thumbnails` and `#btn-extract-meta` click handlers in
`public/app.js` — establish the pattern this spec reuses rather than inventing new
primitives:

| Primitive | Where (greppable symbol / selector) | Reused for |
|---|---|---|
| `showMsg(container, text, type)` → `<div class="msg msg-{info\|success\|error}">`, auto-dismiss after 6s | `function showMsg` in `public/app.js`; CSS rules `.msg`, `.msg-info`, `.msg-success`, `.msg-error` in `public/style.css` | § "Export in progress" (`info`), § "Export succeeded" (`success`), § "Export failed" (`error`) |
| Disable + relabel the triggering button while a request is in flight | the `#btn-extract-meta` handler in `public/app.js`: `var prevLabel = extractBtn.textContent; extractBtn.disabled = true; …` restored as `extractBtn.disabled = false; extractBtn.textContent = prevLabel;` in a `finally` | § "Export in progress" |
| `err.status` / `err.body` / `err.message` surfaced by `apiFetch` (`async function apiFetch` in `public/app.js`, whose error path assigns `msg = body.message \|\| body.error \|\| msg` over a `'HTTP ' + res.status` default) | `public/app.js` | § "Export failed" reads `err.message`, which **is** the 502 `message` field verbatim per §0.1 |
| "…is not configured for this stack" / disabled-with-reason convention (pipeline picker) rather than a generic failure | `function notConfiguredText` and `function optionalServiceNames` in `public/app.js` | § "Export is not available on this deployment", § "No export destinations are configured" |
| A distinct, non-`.msg-error` terminal-state block for a condition a retry can't fix, with an uppercase label row and a machine-readable outcome | `function renderPurgedUnrecoverable` in `public/app.js` (sets `className = 'msg msg-unrecoverable'`, `role="alert"`, `data-outcome="unrecoverable"`); CSS `.msg-unrecoverable` and its `.unrecoverable-label` / `.unrecoverable-body` / `.unrecoverable-detail` children in `public/style.css` | Pattern reused (not the component itself — that one is 410-specific) for the distinct visual identity of the two unavailable states |
| `data-asset-id` link → `showAssetDetail(id, panel)`, monospace id convention | the `.job-asset-link` anchor built in `renderJobDetailBody` (`public/app.js`), whose click handler calls `opts.onAssetLink(assetLink.dataset.assetId)`; the embedded caller supplies that `onAssetLink` as `switchTab('assets'); showAssetDetail(assetId, panel)` in `showJobDetail`. The id is rendered with `.text-mono` (`public/style.css`) — as the link text only when `job.assetName` is absent, otherwise as a separate `.job-asset-id-inline` span | § "Export succeeded"'s "open the export" link |

---

## 1. Vocabulary

One noun, one verb, everywhere in this feature's copy.

| Use | Do not use |
|---|---|
| **Export** (the action and the noun for its output) | "Re-wrap", "Rewrap" — that is the pipeline's internal name (`rewrap.ts`, `osc-rewrap.ts`) and is not shown to a user. Keep it out of UI copy entirely |
| **container format** (what `targetFormat` picks) | "codec" — a rewrap is `-c copy`; no stream is re-encoded, so "codec" would claim something false |
| **source** (the asset being exported) | "original", "parent" — `parentId` names a different, more general relationship than this one action |
| **destination** (a registered place a *delivery* writes to) | "export location", "target" — the contract's noun is `destination` (`deliverBodySchema`, `GET /api/v1/export-destinations`); any other word makes the API and the UI disagree |
| **deliver / delivery** (moving an existing object to a destination) | "export" for that action — export produces a new container; delivery moves bytes that already exist. Conflating them is why the "zero destinations" criterion was mis-analysed once already |
| the five states below: **in progress / exported / export failed / export not available / no destinations** | "pending", "complete", "error", "disabled" alone — too generic for status text; fine as internal/CSS state names only |

---

## 2. State: export in progress

**Trigger:** the operator submits the export form (chosen `targetFormat`, optional
`outputName`). The request is in flight. There is no server-side `processing` status to poll
for this action (§0.1: synchronous) — this state exists purely client-side, for the one
request.

**Visual treatment:**
- Disable the submit control and every format/filename input for the duration of the
  request — there is nothing to interrupt (no job id, no cancel contract) and a second
  submit while one is in flight would create a second, unrelated child asset.
- Relabel the submit control to a busy state (reuse the `extractBtn`/`prevLabel` pattern
  from the `#btn-extract-meta` handler, §0.4): button text becomes **"Exporting…"**,
  restored to its prior label in a `finally` regardless of outcome.
- Post an `info` message via `showMsg`:

  > Exporting to **{FORMAT}**…

  `{FORMAT}` is the exact `targetFormat` value the operator picked (`mp4`/`mkv`/`mov`/`mxf`/`ts`),
  uppercased for the message only — never invent a longer format name the contract doesn't
  carry.

**Do not** show a progress bar or percentage — the contract exposes no job id, no poll
endpoint and no partial-progress signal for this action (§0.1). A determinate progress UI
here would be fabricating data the API doesn't have, which is exactly the "false success"
failure mode #944 fixed on the other end of this same request.

---

## 3. State: export succeeded (201)

**Trigger:** `201` with the new child asset body.

**Visual treatment:** replace the in-progress message with a `success` `showMsg` block. Copy:

> Exported to **{FORMAT}**. → [**{NAME}**](#)

- `{FORMAT}` — the submitted `targetFormat`, same rendering as § "Export in progress".
- `{NAME}` — the response body's `name` field, verbatim (already resolved server-side to
  either the operator's `outputName` or the `<source name> [<format>]` default — §0.1). The
  link uses the existing `data-asset-id="{id}"` / `showAssetDetail` convention (the
  `.job-asset-link` + `onAssetLink` pattern, §0.4) so activating it opens the new child
  asset's detail panel — reusing navigation already built for the exact same "jump to a
  just-created/related asset" need, not a new route.
- The link text is **not** a raw id. `public/app.js`'s existing `.job-asset-link` convention
  only falls back to the id as link text when no human name exists (`job.assetName ||
  job.assetId`, §0.4); an export's child **does** have a name (`assetSchema.name` is always
  present, §0.1), so prefer it — and follow that handler's own
  name-present branch, which renders the id separately in a `.text-mono` span rather than as
  the link text:

  > Exported to **MP4**. → [**clip-master [mp4]**](#)
  > `01JQ7K9…` (click to copy)

  reusing the click-to-copy id convention already cited in `docs/design/asset-version-chain.md`
  ("the `id` as click-to-copy monospace text following the existing asset-id convention").

**"Where it landed" — be precise about what is actually knowable:**
The response's `objectKey` (`exports/{childId}.{format}`) is the storage key, not a byte
location a non-technical operator can act on, and per §0.3's "unused enum member" finding the
UI must **not** attempt to resolve a download URL by filtering `/:id/files` for `type:
'export'` — that will silently match nothing. If the implementation wants an immediate
download affordance, it must fetch `GET /:id/files` for the new child and use the entry whose
`objectKey` equals the one just returned (the handler always reports it as `type: 'source'`,
§0.3) — not a `type` filter. That is an optional enhancement; the minimum state this ticket
requires is satisfied by the name + link above, which needs no second request.

**Do not** say "export complete" without the output's name — #944's entire point is that
`201` is a verified claim about a specific object; the copy should let the operator see which
one.

---

## 4. State: export failed (502)

**Trigger:** the request resolves with HTTP `502`, body `{ error: 'rewrap_failed', message:
string }` (§0.1).

**Visual treatment:** replace the in-progress message with an `error` `showMsg` block. Copy:

> Export to **{FORMAT}** failed: {MESSAGE}

- `{MESSAGE}` is `err.message` as surfaced by `apiFetch` (`msg = body.message || body.error
  || msg`, §0.4), which for a 502 **is** the server's `message` field verbatim (§0.1) — never
  replace it with a generic "Something went wrong." The acceptance criterion ("surfaces the
  actual error returned by the verified `/export` contract") is met by printing this field,
  not by summarizing it.
- Do **not** attempt to show more than `message`. The ffmpeg log that would explain *why* is
  deliberately server-side only (§0.1) — there is no safe additional detail to fetch or
  display for this failure, and the UI must not imply there is one (no "see details"
  affordance that leads nowhere).
- The failed child asset itself (`status: 'failed'`, no `objectKey`, §0.1) is not linked to
  from this message — it is not a result the operator can act on (no file exists for it), so
  surfacing it would invite the exact "plausible-looking broken link" #786/#944 eliminated on
  the API side. If the asset list/detail view shows `failed` children generally, that is a
  separate, already-existing surface; this action's own failure message does not need to
  duplicate it.
- The action remains retryable — re-enable the submit control (the `finally` in § "Export in
  progress") with its original label and the operator's last-chosen format/name still filled
  in, since nothing about a `502` says the inputs were wrong (contrast the `400` row in the
  table immediately below, where they were).

**Other failure shapes this action also sends, briefly** (the ticket's acceptance criteria
single out 502 by name, but an implementer reusing this error path needs to know these don't
collide with it):

| Status | `error` | Shown via the same `error` `showMsg`, copy |
|---|---|---|
| `400` | Zod-enum rejection body | **"Unsupported export format."** — should not occur through the UI's own format picker (it would only enumerate `REWRAP_FORMATS`), so this is a defensive message, not a primary design target |
| `404` | `not_found` | **"This asset no longer exists."** — existence is deliberately not distinguished from "not yours" (§0.1); do not say "not found or access denied" or any phrasing that narrows which |
| `409` | `no_object` | **"{SOURCE NAME} has no stored file to export."** — `message` is the shared, generic sentence (§0.1) used by every other source-consuming operation; prefer naming the asset over echoing `message` verbatim here, since the generic sentence reads oddly attached to a specific asset in a UI |

---

## 5. State: export is not available on this deployment (501)

**Trigger:** `501` from `POST /:id/export`, body `{ error: 'not_configured', message: 'export
/ re-wrap is not configured' }` (§0.1). This is the export action's own
nowhere-to-run condition: the deployment wired neither a re-wrap runner nor workspace
storage. It is **not** the destinations state — that one is § "No export destinations are
configured", and the two have different remedies (§0.2's two-condition table).

**When to detect it:** ahead of the click, not after. The UI should probe this ahead of time
(e.g. once per asset-detail render, or once per session, depending on how the implementer
wires the surrounding panel) rather than only surfacing it as a failed submit — the whole
point of #796's "explain, don't fail opaquely" criterion is that an operator should see the
unavailable-and-why state **before** investing effort in picking a format and a name. If the
implementer chooses to detect it lazily on first submit instead, the per-request copy below
still applies unchanged — the only difference is timing, not wording.

**Visual treatment:** do not render the export action as a live form with a doomed submit
button. Follow the established "disabled, with reason" convention already used for optional
pipeline steps (`notConfiguredText`, §0.4), not a `.msg-error` block (this is not something
that just happened and might work on retry — it is the deployment's standing state) and not
`.msg-unrecoverable` either (that component's copy and `data-outcome="unrecoverable"`
semantics are specific to a 410 tombstone, §0.4 — reusing it verbatim here would borrow
language about purging that doesn't apply). Use a dedicated, disabled-looking block in the
same position the active form would occupy:

> **Export is not available on this deployment**
> This deployment has not configured an export service. Ask an operator to provision export
> before this action can be used here.

- Title line names the condition explicitly (per the acceptance criterion) — "Export is not
  available on this deployment", not "Error" or "Something went wrong."
- Body line explains *why* in terms an operator (this UI's actual audience, not an end
  viewer) can act on: provisioning is a deployment-level configuration gap, not something
  retried by clicking again. Do not say "try again later" — nothing about retrying changes
  this state; it changes only when an operator reconfigures the deployment.
- No format picker, no filename field, no submit button rendered in this state — graying out
  live inputs implies "temporarily disabled," which contradicts the box above it. This
  mirrors the version-chain spec's "observed state, not an operator choice" principle
  (`docs/design/asset-version-chain.md` §0 gap 1) applied to availability rather than to
  version selection.
- `data-outcome="not-configured"` on the block (new value, not `"unrecoverable"` — this is a
  deployment config state, not a permanent per-asset outcome), so a test or a future view can
  assert on it the same way `renderPurgedUnrecoverable` already does for its own outcome
  (§0.4).

---

## 6. State: no export destinations are configured

**Which action this belongs to.** The *delivery* action, `POST
/api/v1/assets/{id}/deliver` — the only endpoint on the asset-detail surface that requires an
operator to name a `destination` (§0.2). The export/re-wrap action has no destination field
and never reaches this state; an implementer must **not** add a destination picker to the
export form. This state is in this spec because it is issue #911's "zero destinations
configured" acceptance criterion, and because both actions live on the same panel, so their
unavailable states must not read as the same thing.

**Trigger.** `GET /api/v1/export-destinations` answers `200`, but every entry has `id ===
'default'` — i.e. `destinations.filter(d => d.id !== 'default').length === 0` (§0.2). The
registry is wired; nothing deliverable is registered in it. This is the standing condition of
any deployment where no one has yet called `POST /api/v1/export-destinations`.

**Why this is a real state and not a theoretical one** (correcting an earlier draft of this
document): the array is never literally empty, because `StorageBackendRegistry.list()`
unconditionally prepends `defaultBackendView()`. But the delivery endpoint answers `400
bad_request` for `destination: 'default'`, because `resolveForOutput` returns `undefined` for
`DEFAULT_BACKEND_ID` by design (§0.2). A list of exactly one unusable entry is zero usable
destinations.

**When to detect it:** on render of the delivery control, from the destinations fetch the
picker needs anyway. One request, no extra round trip: the same `GET
/api/v1/export-destinations` response that would populate the picker's options is what
reveals that there are none.

**Visual treatment:** render the same kind of dedicated, disabled-looking block as § "Export
is not available on this deployment" (shared shell, `.msg` metrics without `.msg-error`), in
the position the destination picker and Deliver button would occupy. Copy:

> **No export destinations are configured**
> Delivery copies this asset's file to a storage destination you have registered. This
> deployment has none yet — the platform-managed default store is where the file already
> lives, so it cannot be a delivery target.
> Register a destination with the role **"packaged"** or **"both"**, then come back.

- Title line names the condition in the issue's own terms, and in the contract's noun
  ("destinations", §1).
- The second line answers the first question a first-time operator has — *what is a
  destination for?* — before telling them they don't have one. One sentence, no jargon; it
  does not mention buckets, roles, endpoints, or credentials.
- The third line is the one piece of jargon that cannot be avoided, because it is a literal
  contract value: only `role: 'packaged'` or `'both'` backends are export destinations
  (`isExportDestination`, §0.2). Quote the values exactly as the API spells them so an
  operator can match them against the registration form.
- Do **not** say "try again later" and do **not** say "ask an operator to provision" — unlike
  the 501 state, this one is fixable *by the person reading it*, through this API's own
  registration endpoint (`POST /api/v1/export-destinations`). Point at the action, not at
  someone else.
- If the surrounding UI has (or later gains) a destinations-management view, the block's last
  line should be a link to it rather than prose naming the endpoint. Until that view exists,
  naming the capability ("register a destination") without a dead link is the honest option —
  no affordance that leads nowhere (same rule as § "Export failed"'s "no 'see details'").
- `data-outcome="no-destinations"` on the block — a third, distinct value, not
  `"not-configured"`: a test must be able to tell "this deployment cannot deliver at all"
  from "this deployment can deliver but nothing is registered", because the two have
  different remedies (§0.2).
- **No destination picker and no Deliver button rendered in this state.** An empty or
  default-only `<select>` next to a live button is the same dishonesty as a doomed submit.
- The `default` entry is excluded from the picker in *every* state, not just this one — it is
  always present in the list and always a `400` if submitted (§0.2). Filter it out at the
  point the options are built, so there is one filter and not one per state.

**The neighbouring 501.** If `GET /api/v1/export-destinations` answers `501 not_configured`
instead (registry not wired at all — §0.2), that is the *other* condition and takes the 501
copy pattern, with delivery's own subject:

> **Delivery is not available on this deployment**
> This deployment has no storage-backend registry configured, so export destinations cannot
> be registered or used. Ask an operator to provision one.

Use `data-outcome="not-configured"` for that one, matching § "Export is not available on this
deployment". The distinction is not cosmetic: one tells the reader to act, the other tells
them to escalate.

**Out of scope here.** The delivery action's own in-progress / delivered / failed states
(`200 delivered`, `409 source_missing`, `422 backend_role` /
`destination_unresolved`, `502 delivery_failed`, `504 delivery_timeout` — all in §0.2's
`openapi.json` citation) are a separate ticket. #911 asks only for the no-destinations state,
and that is what this section pins.

---

## 7. Summary table (for the implementer)

| State | Action | Trigger | `showMsg` type / block | Inputs | Retry semantics |
|---|---|---|---|---|---|
| In progress | export | request in flight (client-side only, §0.1: no server poll state) | `info`, "Exporting to {FORMAT}…" | disabled | n/a |
| Exported | export | `201` | `success`, "Exported to {FORMAT}. → {NAME}" + id | re-enabled, cleared | n/a — action is done |
| Export failed | export | `502 rewrap_failed` | `error`, "Export to {FORMAT} failed: {message}" | re-enabled, **preserved** | retryable, same inputs likely to work later |
| Unsupported format / unknown asset / no source object | export | `400`/`404`/`409` | `error`, per-status copy (§ "Export failed" table) | re-enabled (400: cleared format; 404/409: n/a, asset-level) | 400/409 need different operator input or asset state; 404 is not retryable |
| Export not available | export | `501 not_configured` | dedicated disabled block, `data-outcome="not-configured"` | not rendered | not retryable by the operator — deployment-level |
| No destinations | deliver | `GET /export-destinations` `200` with no entry whose `id !== 'default'` | dedicated disabled block, `data-outcome="no-destinations"` | picker + button not rendered | fixable by the reader — register a destination |
| Delivery not available | deliver | `GET /export-destinations` `501 not_configured` | dedicated disabled block, `data-outcome="not-configured"` | not rendered | not retryable by the operator — deployment-level |

---

## 8. Contract gaps (do not design around them, design *for* them)

1. **No partial-progress signal.** The export action is awaited end-to-end server-side with
   no job id exposed to the caller (§0.1). A UI cannot show elapsed time against a known
   duration or a cancel affordance; § "Export in progress" is deliberately indeterminate.
2. **`type: 'export'` is a declared-but-unassigned enum member** on `assetFileSchema`
   (§0.3). Any future implementation that tries to identify an exported file by that type
   value will match nothing; match by `objectKey` instead, or treat this as a small follow-up
   to file against the API surface (same-repo note, not OSC friction — this is our own
   schema).
3. **The destinations list includes an entry the delivery endpoint rejects.** `GET
   /api/v1/export-destinations` always contains the implicit `default` (role `'both'`, so it
   passes `isExportDestination`), while `POST /:id/deliver` answers `400` for it because
   `resolveForOutput` returns `undefined` for `DEFAULT_BACKEND_ID` by design (§0.2). Both
   halves are deliberate, but together they mean **no single response field tells a client
   whether a listed destination is deliverable** — every client must hard-code the
   `id !== 'default'` filter. Worth a follow-up on the API surface (a `deliverable: boolean`
   on the list view, or omitting the default from the destinations projection) so the rule
   lives in the contract instead of in each UI. Until then, § "No export destinations are
   configured" specifies the filter so at least this UI applies it once.
4. **The 502 `message` is a single sentence, not structured.** There's no machine-readable
   failure reason field, so copy cannot branch on failure cause (e.g. "the source was
   corrupt" vs. "the container doesn't support this codec") — only the one sentence, verbatim.
