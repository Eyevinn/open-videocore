# Interaction spec: export-action states — in progress, success, failure, not-configured

**Issue:** #911 (broken out from #796, which itself sat behind the outcome-honesty fix in
#944). Feeds the implementation ticket that adds the export action to the web UI.
**Status:** design spec. No production code accompanies it — there is no export action in
`public/` yet (verified below), so there is nothing to retrofit.
**Audience:** whoever implements the export button/panel on asset detail, plus anyone
writing operator copy about export.

This pins **copy and visual treatment** for four states of one action: `POST
/api/v1/assets/{id}/export` (the "re-wrap" action — copies a source into a new container
format without re-encoding). It does not restate the contract, it cites it. Where the issue's
language ("zero destinations configured") does not match a condition the contract can
actually produce, the mismatch is named explicitly rather than designed around silently.

---

## 0. Contract grounding

Everything below was read from this tree on branch `issue-911/export-action-states`:
`openapi.json`, the route source, and the pipeline source. Nothing is taken from the issue
text.

| What | Exact symbol verified |
|---|---|
| Endpoint | `POST /api/v1/assets/{id}/export`. Handler `src/routes/assets.ts:4917-4993`. `openapi.json` → `paths["/api/v1/assets/{id}/export"].post` declares exactly `201, 400, 404, 409, 501, 502` |
| Request body | `exportBodySchema`, `src/routes/assets.ts:718-725`: `{ targetFormat: 'mp4'\|'mkv'\|'mov'\|'mxf'\|'ts'` (required) `, outputName?: string(1..256), asVersion?: boolean }`. **No destination field of any kind.** |
| 201 body | `assetSchema` (`src/routes/assets.ts:841`) — the new child asset. Relevant fields for this spec: `id`, `name`, `slug`, `status` (`'ready'` on a 201), `parentId` (= source asset id, `:878`), `objectKey` (`:884`, present directly on the response — no extra fetch needed to know where the output landed) |
| Default child name | `outputName`, else `<source name> [<format>]` — `src/pipeline/rewrap.ts:80`, `baseName` resolution `:116` |
| Output object key | `exports/<newAssetId>.<format>` — `rewrapObjectKey`, `src/pipeline/rewrap.ts:62-64` |
| **201 is falsifiable** | Three layers agree before it is sent: job-status allow-list (`SUCCESS_STATUSES`, `src/pipeline/osc-rewrap.ts:85`), object HEAD + non-empty check (`src/pipeline/rewrap.ts:173`), only then the `ready` transition. Documented contract note: `docs/findings/export-truthful-status-944.md` |
| 400 | Unsupported `targetFormat` — Zod enum at the edge; `UnsupportedFormatError` defensively in the pipeline (`src/pipeline/rewrap.ts:40-45`). Body: `errorSchema` (`error`, `message?`), `src/routes/assets.ts:533` |
| 404 | Unknown/foreign asset — `{ error: 'not_found' }`, `src/routes/assets.ts:4936-4938`. Existence not leaked |
| 409 | `{ error: 'no_object', message: 'asset has no stored source object to process' }` — `NO_SOURCE_OBJECT_ERROR` / `NO_SOURCE_OBJECT_MESSAGE`, `src/pipeline/source-object.ts:30-34`, sent by the shared `requireSourceObject` helper (`:96-104`), called at `src/routes/assets.ts:4940-4941` |
| **501** | `{ error: 'not_configured', message: 'export / re-wrap is not configured' }` — `src/routes/assets.ts:4942-4946`, fired when `!opts.rewrapRunner \|\| !storageFor` (deployment never wired a re-wrap runner or workspace storage). This is the **only** "nowhere for an export to go" condition this endpoint can produce — see §4 |
| 502 | `{ error: 'rewrap_failed', message: <single status-bearing sentence> }` — `src/routes/assets.ts:4989-4990`. The ffmpeg log is captured server-side only (`oscJobLog(err)`, logged at `warn`, `:4985-4988`) and is **never** in `message` — this is a deliberate security position (log is third-party output, can carry storage endpoints/bucket names), not an oversight. `message` is what the UI has to show; it is real, not generic ("Export failed") |
| Failed export leaves no file to serve | `rewrap()` sets `objectKey` only **after** the verification passes (`src/pipeline/rewrap.ts`, the `update` calls follow the `statObject` guard) — a `502` child is `status: 'failed'` with **no** `objectKey`, so it can never 200 a `/files` entry for bytes that don't exist |
| Synchronous, no polling | The route `await`s the runner (`src/routes/assets.ts:4961-4976`); there is no `processing`-then-poll contract for this action. The only "in progress" state is the one request in flight |
| Source unchanged | Export is a pure read of the source asset — never mutated |

### Named export destinations are a different contract — do not conflate them

The issue's acceptance criteria ask for a "zero destinations configured" state. The only
*destination-selection* feature in this codebase is named export destinations
(`GET/POST/DELETE /api/v1/export-destinations`, `src/routes/export-destinations.ts`), which
is consumed **exclusively** by `POST /:id/package` and `POST /:id/execute` via their optional
`destination` body field (`src/routes/assets.ts:4512-4518`, `:4639-4650`, resolved through
`resolveJobDestination`/`resolveDestinationBucket`, `:2078-2178`). `exportBodySchema` has no
`destination` field (§0 row 2) — **`POST /:id/export` never consults the export-destinations
registry and cannot be gated by it.** It always writes its output to the workspace's own
provisioned storage (`storageFor()`), full stop.

Two further facts close this off cleanly, so this isn't left as an open question:

- `StorageBackendRegistry.list()` **unconditionally prepends** the implicit OSC-managed
  default backend (`role: 'both'`) to every result — `src/services/storage-backend-registry.ts:691-694`,
  `defaultBackendView()` at `:138-144`. `'both'` passes the destinations view's own
  `isExportDestination` filter (`export-destinations.ts:174-176`). So **whenever the registry
  is configured, `GET /api/v1/export-destinations` can never return an empty list** — there
  is no reachable `200 { destinations: [] }`.
- The only way `GET /api/v1/export-destinations` reports "nothing" is its own `501
  not_configured` (`export-destinations.ts:236-239, 259, 283, 306, 330`) — the registry
  itself isn't wired (no param store / no OSC secret storage), independent of the export
  action's own `501`.

**Conclusion for this spec:** "zero destinations configured", read literally against the
named-destinations contract, cannot happen for the export action and would be a false state
to design for it couldn't be reached. Read as the issue and #796 actually mean it — *"this
deployment has nowhere to put an export"* — it maps exactly onto the export action's own
`501 not_configured` (§0 row "501"), which is the condition `docs/findings/export-truthful-status-944.md`
already names as "the #796 acceptance criterion about explaining rather than failing
opaquely." §4 designs that state under its real name. If a future ticket wires `/:id/export`
to accept a named `destination` the way `/:id/package` does, this document's §4 state needs a
second variant for "destinations registry configured but nothing registered" — which, per the
bullet above, currently cannot occur anyway because the default backend always fills that
slot.

### A UI cannot say *where* a file landed via `type: 'export'` — the enum member is unused

`assetFileSchema.type` (`GET /:id/files`, `src/routes/assets.ts:658-671`) declares
`z.enum(['source', 'rendition', 'export'])`, but the handler that builds the `files` array
(`:3968-3998`) only ever pushes `type: 'source'` (from `asset.objectKey`) or `type:
'rendition'`. No code path assigns `type: 'export'`. **An exported child asset's own stored
object is reported as `type: 'source'` through `/:id/files`, not `type: 'export'`.** This
spec therefore does not use `/:id/files` to identify the export at all — §2 reads
`objectKey`/`name`/`id` straight off the **201 response body**, which needs no further
request and is not subject to this gap. (Noted for the implementer so nobody later writes a
`.filter(f => f.type === 'export')` that silently matches nothing.)

### What already exists in `public/` to build on

No export UI exists yet — `grep -rn "rewrap\|/export\|targetFormat" public/*.js public/*.html`
returns nothing (the hits for the literal string `export` elsewhere in `public/*.js` are all
ES-module `export function`/`export const` statements, not this feature). The nearest sibling
action already wired — `POST /:id/thumbnails`, `public/app.js:3297-3329` — establishes the
pattern this spec reuses rather than inventing new primitives:

| Primitive | Where | Reused for |
|---|---|---|
| `showMsg(container, text, type)` → `<div class="msg msg-{info\|success\|error}">`, auto-dismiss after 6s | `public/app.js:956-963`, CSS `public/style.css:697-721` | In-progress (§1, `info`), success (§2, `success`), generic-shape failure (§3, `error`) |
| Disable + relabel the triggering button while a request is in flight | `public/app.js:3290-3293` (`extractBtn.disabled = false; extractBtn.textContent = prevLabel;` in a `finally`) | §1 |
| `err.status` / `err.body` / `err.message` surfaced by `apiFetch` (`message = body.message \|\| body.error \|\| 'HTTP ' + status`) | `public/app.js:273-312` | §3 reads `err.message`, which **is** the 502 `message` field verbatim per §0 |
| "Not configured for this stack" / disabled-with-reason convention (pipeline picker), rather than a generic failure | `public/app.js:2818-2824`, `notConfiguredText`/pill convention `:6900-7049` | §4 |
| A distinct, non-`.msg-error` terminal-state block for a condition a retry can't fix, with an uppercase label row | `renderPurgedUnrecoverable`, `public/app.js:1547-1589`; CSS `.msg-unrecoverable` `public/style.css:723-756` | Pattern reused (not the component itself — that one is 410-specific) for §4's distinct visual identity |
| `data-asset-id` link → `showAssetDetail(id, panel)`, monospace id convention | `public/app.js:3594` (`.job-asset-link.text-mono`), handler `:2340` | §2's "open the export" link |

---

## 1. Vocabulary

One noun, one verb, everywhere in this feature's copy.

| Use | Do not use |
|---|---|
| **Export** (the action and the noun for its output) | "Re-wrap", "Rewrap" — that is the pipeline's internal name (`rewrap.ts`, `osc-rewrap.ts`) and is not shown to a user. Keep it out of UI copy entirely |
| **container format** (what `targetFormat` picks) | "codec" — a rewrap is `-c copy`; no stream is re-encoded, so "codec" would claim something false |
| **source** (the asset being exported) | "original", "parent" — `parentId` names a different, more general relationship than this one action |
| the four states below: **in progress / exported / export failed / export not available** | "pending", "complete", "error", "disabled" alone — too generic for status text; fine as internal/CSS state names only |

---

## 2. State: export in progress

**Trigger:** the operator submits the export form (chosen `targetFormat`, optional
`outputName`). The request is in flight. There is no server-side `processing` status to poll
for this action (§0: synchronous) — this state exists purely client-side, for the one
request.

**Visual treatment:**
- Disable the submit control and every format/filename input for the duration of the
  request — there is nothing to interrupt (no job id, no cancel contract) and a second
  submit while one is in flight would create a second, unrelated child asset.
- Relabel the submit control to a busy state (reuse the `extractBtn`/`prevLabel` pattern,
  `public/app.js:3290-3293`): button text becomes **"Exporting…"**, restored to its prior
  label in a `finally` regardless of outcome.
- Post an `info` message via `showMsg`:

  > Exporting to **{FORMAT}**…

  `{FORMAT}` is the exact `targetFormat` value the operator picked (`mp4`/`mkv`/`mov`/`mxf`/`ts`),
  uppercased for the message only — never invent a longer format name the contract doesn't
  carry.

**Do not** show a progress bar or percentage — the contract exposes no job id, no poll
endpoint and no partial-progress signal for this action (§0). A determinate progress UI here
would be fabricating data the API doesn't have, which is exactly the "false success" failure
mode #944 fixed on the other end of this same request.

---

## 3. State: export succeeded (201)

**Trigger:** `201` with the new child asset body.

**Visual treatment:** replace the in-progress message with a `success` `showMsg` block. Copy:

> Exported to **{FORMAT}**. → [**{NAME}**](#)

- `{FORMAT}` — the submitted `targetFormat`, same rendering as §2.
- `{NAME}` — the response body's `name` field, verbatim (already resolved server-side to
  either the operator's `outputName` or the `<source name> [<format>]` default — §0). The
  link uses the existing `data-asset-id="{id}"` / `showAssetDetail` convention
  (`public/app.js:3594`,`:2340`) so activating it opens the new child asset's detail panel —
  reusing navigation already built for the exact same "jump to a just-created/related asset"
  need, not a new route.
- The link text is **not** a raw id. `public/app.js`'s existing link convention
  (`.job-asset-link.text-mono`) does show the id as link text for a *job* reference, where no
  human name exists; an export's child **does** have a name (`assetSchema.name` is always
  present, §0), so prefer it — follow `.text-mono`'s styling for the id separately, as a
  secondary line, not as the link text:

  > Exported to **MP4**. → [**clip-master [mp4]**](#)
  > `01JQ7K9…` (click to copy)

  reusing the click-to-copy id convention already cited in `docs/design/asset-version-chain.md`
  §2 ("the `id` as click-to-copy monospace text following the existing asset-id convention").

**"Where it landed" — be precise about what is actually knowable:**
The response's `objectKey` (`exports/{childId}.{format}`) is the storage key, not a byte
location a non-technical operator can act on, and per §0's "unused enum member" finding the
UI must **not** attempt to resolve a download URL by filtering `/:id/files` for `type:
'export'` — that will silently match nothing. If the implementation wants an immediate
download affordance, it must fetch `GET /:id/files` for the new child and use the entry whose
`objectKey` equals the one just returned (the handler always reports it as `type: 'source'`,
§0) — not a `type` filter. That is an optional enhancement; the minimum state this ticket
requires is satisfied by the name + link above, which needs no second request.

**Do not** say "export complete" without the destination name — #944's entire point is that
`201` is a verified claim about a specific object; the copy should let the operator see which
one.

---

## 4. State: export failed (502)

**Trigger:** the request resolves with HTTP `502`, body `{ error: 'rewrap_failed', message:
string }` (§0).

**Visual treatment:** replace the in-progress message with an `error` `showMsg` block. Copy:

> Export to **{FORMAT}** failed: {MESSAGE}

- `{MESSAGE}` is `err.message` as surfaced by `apiFetch` (`public/app.js:297`), which for a
  502 **is** the server's `message` field verbatim (§0) — never replace it with a generic
  "Something went wrong." The acceptance criterion ("surfaces the actual error returned by
  the verified `/export` contract") is met by printing this field, not by summarizing it.
- Do **not** attempt to show more than `message`. The ffmpeg log that would explain *why* is
  deliberately server-side only (§0) — there is no safe additional detail to fetch or display
  for this failure, and the UI must not imply there is one (no "see details" affordance that
  leads nowhere).
- The failed child asset itself (`status: 'failed'`, no `objectKey`, §0) is not linked to from
  this message — it is not a result the operator can act on (no file exists for it), so
  surfacing it would invite the exact "plausible-looking broken link" #786/#944 eliminated on
  the API side. If the asset list/detail view shows `failed` children generally, that is a
  separate, already-existing surface; this action's own failure message does not need to
  duplicate it.
- The action remains retryable — re-enable the submit control (§2's `finally`) with its
  original label and the operator's last-chosen format/name still filled in, since nothing
  about a `502` says the inputs were wrong (contrast §5/400, where they were).

**Other failure shapes this action also sends, briefly** (the ticket's acceptance criteria
single out 502 by name, but an implementer reusing this error path needs to know these don't
collide with it):

| Status | `error` | Shown via the same `error` `showMsg`, copy |
|---|---|---|
| `400` | Zod-enum rejection body | **"Unsupported export format."** — should not occur through the UI's own format picker (it would only enumerate `REWRAP_FORMATS`), so this is a defensive message, not a primary design target |
| `404` | `not_found` | **"This asset no longer exists."** — existence is deliberately not distinguished from "not yours" (§0); do not say "not found or access denied" or any phrasing that narrows which |
| `409` | `no_object` | **"{SOURCE NAME} has no stored file to export."** — `message` is the shared, generic sentence (§0) used by five other operations; prefer naming the asset over echoing `message` verbatim here, since the generic sentence reads oddly attached to a specific asset in a UI |

---

## 5. State: export not available on this deployment (501)

**Trigger:** `501`, body `{ error: 'not_configured', message: 'export / re-wrap is not
configured' }` (§0). Per §0's "named destinations are a different contract" analysis, this —
**not** an empty destinations list — is the real "nowhere to export to" condition this action
can produce, and the one the issue's "zero destinations configured" criterion maps onto.

**When to detect it:** ahead of the click, not after. The UI should probe this ahead of time
(e.g. once per asset-detail render, or once per session, depending on how the implementer
wires the surrounding panel) rather than only surfacing it as a failed submit — the whole
point of #796's "explain, don't fail opaquely" criterion is that an operator should see the
unavailable-and-why state **before** investing effort in picking a format and a name. If the
implementer chooses to detect it lazily on first submit instead, the per-request copy below
still applies unchanged — the only difference is timing, not wording.

**Visual treatment:** do not render the export action as a live form with a doomed submit
button. Follow the established "disabled, with reason" convention already used for optional
pipeline steps (`public/app.js:2818-2824`, `:7049` — "not configured for this stack" pill),
not a `.msg-error` block (this is not something that just happened and might work on retry —
it is the deployment's standing state) and not `.msg-unrecoverable` either (that component's
copy and `data-outcome="unrecoverable"` semantics are specific to a 410 tombstone, §0's
primitives table — reusing it verbatim here would borrow language about purging that doesn't
apply). Use a dedicated, disabled-looking block in the same position the active form would
occupy:

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
  (`public/app.js:1570`).

---

## 6. Summary table (for the implementer)

| State | Trigger | `showMsg` type / block | Inputs | Retry semantics |
|---|---|---|---|---|
| In progress | request in flight (client-side only, §0: no server poll state) | `info`, "Exporting to {FORMAT}…" | disabled | n/a |
| Exported | `201` | `success`, "Exported to {FORMAT}. → {NAME}" + id | re-enabled, cleared | n/a — action is done |
| Export failed | `502 rewrap_failed` | `error`, "Export to {FORMAT} failed: {message}" | re-enabled, **preserved** | retryable, same inputs likely to work later |
| Unsupported format / unknown asset / no source object | `400`/`404`/`409` | `error`, per-status copy (§4 table) | re-enabled (400: cleared format; 404/409: n/a, asset-level) | 400/409 need different operator input or asset state; 404 is not retryable |
| Export not available | `501 not_configured` | dedicated disabled block, `data-outcome="not-configured"` (§5) | not rendered | not retryable by the operator — deployment-level |

---

## 7. Contract gaps (do not design around them, design *for* them)

1. **No partial-progress signal.** The action is awaited end-to-end server-side with no job
   id exposed to the caller (§0). A UI cannot show elapsed time against a known duration or a
   cancel affordance; §2 is deliberately indeterminate.
2. **`type: 'export'` is a declared-but-unassigned enum member** on `assetFileSchema`
   (§0). Any future implementation that tries to identify an exported file by that type value
   will match nothing; match by `objectKey` instead, or treat this as a small follow-up to
   file against the API surface (same-repo note, not OSC friction — this is our own schema).
3. **Named export destinations cannot gate this action** and, per §0, cannot even report an
   empty list while configured — so there is no reachable API state matching "destinations
   configured but none registered" for this action to detect. §5 designs for the condition
   that actually exists.
4. **The 502 `message` is a single sentence, not structured.** There's no machine-readable
   failure reason field, so copy cannot branch on failure cause (e.g. "the source was
   corrupt" vs. "the container doesn't support this codec") — only the one sentence, verbatim.
