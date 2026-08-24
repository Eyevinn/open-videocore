# ADR-014: Caption-source-to-encode contract for burn-in (ordering model + request shape)

**Status:** PROPOSED 2026-08-22
**Date:** 2026-08-22
**Author agent:** claude-opus-4-8 (surface-backend-api)
**Issue:** #387 (decision spike for the burn-in parent issue)
**Consumed by:** #388 (implementation), #389 (generation/burn-in race)

---

## Context

The burn-in parent issue leaves a three-way fork open ("the choice is yours")
for how a burn-in transcode obtains its caption source. Nothing can be
implemented unambiguously until that fork is resolved and the request-side shape
is pinned field-by-field. This ADR resolves it.

The three candidate ordering models from the parent issue are:

1. **Wait-on-generation** — burn-in waits on the auto-generated subtitle track
   and fails/queues if it is not ready yet.
2. **Explicit sidecar** — burn-in accepts an explicitly supplied caption source
   in the request and does not depend on generation.
3. **Separate pipeline step** — burn-in is a distinct pipeline step that runs
   after generation completes.

The acceptance criterion "the caption source is explicit in the request" already
pushes toward model 2, which the parent issue also notes is the smallest and
closest to the reference behaviour. This ADR treats model 2 as the default and
justifies the deviation from 1 and 3.

## Verified constraints

### C1 — Encore `VideoEncode` exposes a `filters` list; the burn-in filter syntax itself is NOT documented by the doc

Source: WebFetch `eyevinn.github.io/encore-doc` (retrieved 2026-08-22).

- The `VideoEncode` type (Table 3) has a **`filters`** field, described verbatim
  as *"for adding extra FFmpeg Filters"*. (`AudioEncode`, Table 2, has an
  analogous `filters` field — the same field the sibling loudnorm work relied
  on.) So the injection point for a burn-in filter **exists and is confirmed**.
- **However**, that doc contains **no** mention of `subtitles=<file>`,
  `force_style`, `burn`, `.srt`, `.vtt`, or `.ass` (verified: all absent from the
  fetched page). The `subtitles=<file>:force_style='...'` string is the *generic
  FFmpeg libavfilter `subtitles` filter*, which a free-form `filters` string may
  carry — but the encore-doc gives **no worked example and no stability
  guarantee** for it, and does not state how the filter's `<file>` argument
  resolves against an S3-backed input.
- **Consequence:** the *field* is verified; the *exact burn-in filter string and
  its file-path resolution against Encore's execution environment* is an OPEN
  dependency that #388 MUST smoke-test against a live Encore instance before
  landing. Logged: `docs/osc-feedback/incoming-burn-in-contract.md` (item 1).

### C2 — Encore selects a profile by server-side name; the job payload has NO per-request `outputs` array

Source (this repo): `src/pipeline/encore-client.ts`.

- `toEncorePayload` (`src/pipeline/encore-client.ts:81-98`) builds the job
  document as `{ externalId, [progressCallbackUri], profile, [profileParams],
  outputFolder, baseName, inputs }`. There is a literal in-code note (line 96):
  *"NOTE: no `outputs` field — Encore profiles are server-side only."*
- The header comment (`src/pipeline/encore-client.ts:71-80`) records the smoke
  test: *"Encore's API schema has NO top-level `outputs` field. Profiles are
  server-side named configurations — the profile name string is the only way to
  select a ladder."*
- The only per-request levers are: the **`profile`** name string
  (`encore-client.ts:29-30, 87`) and the optional **`profileParams`** flat
  string map, which Encore evaluates as SpEL expression properties *within the
  named profile* (`encore-client.ts:31-39, 86-92`).

This is the same constraint the loudnorm chain (ADR-013) relied on and it
directly governs how per-rendition burn-in opt-in can be expressed (see
Decision D3).

### C3 — A generated subtitle sidecar's S3 object key is derived in-repo, deterministically

Source (this repo): `src/pipeline/subtitle-generator.ts` and
`src/data/asset-repo.ts`.

- The auto-subtitles orchestrator computes the destination object key as
  **`subtitles/<assetId>/<trackId>.<format>`** via `subtitleObjectKey(assetId,
  trackId, format)` (`src/pipeline/subtitle-generator.ts:101-103`), and persists
  a `SubtitleTrack` whose **`objectKey`** is exactly that key
  (`src/pipeline/subtitle-generator.ts:151-153, 178-184`). The same key
  convention is used by the manual `POST /:id/subtitle-tracks` route
  (referenced at `subtitle-generator.ts:98-100`).
- The `SubtitleTrack` shape (`src/data/asset-repo.ts:219-228`) is
  `{ id, language, format: SubtitleFormat, objectKey?, label?, default? }`, where
  `objectKey` is the *"Workspace-local MinIO object key of the subtitle file"*
  (`asset-repo.ts:223-225`). `SubtitleFormat` is
  `'vtt' | 'srt' | 'ttml'` (`src/data/asset-repo.ts:216-217`).
- **This in-repo `objectKey` is the authoritative S3 key** the burn-in filter
  reads — more authoritative than any external `/transcribe/s3` doc, because it
  is what THIS codebase actually persists. The auto-subtitles wire body our
  runner sends is `{ url, format, outputKey }`
  (`src/pipeline/osc-auto-subtitles.ts:59-69`); the `outputKey` there is the same
  `destinationKey` = `subtitles/<assetId>/<trackId>.<format>`. Note the runner
  itself flags this wire shape as NOT contract-verified
  (`osc-auto-subtitles.ts:11-25`) — but the *key we store* is not in doubt,
  because we compute it, not the service.

### C4 — Format asymmetry: generator emits srt/vtt; SubtitleTrack carries ttml too

Source (this repo + external): `src/data/asset-repo.ts:216-217`,
docs.osaas.io Subtitle-Generator.

- `SubtitleFormat` (issue #114 track shape) admits **`vtt`, `srt`, `ttml`**
  (`asset-repo.ts:216-217`); the default generated format is `vtt`
  (`src/pipeline/subtitle-generator.ts:54-55`).
- The auto-subtitles doc lists only **`srt`** and **`vtt`** as producible
  formats. So a `ttml` `SubtitleTrack` can exist in the asset (e.g. uploaded
  manually) even though generation never emits it.

## Decision

### D1 — Ordering model: **model 2, explicit sidecar source in the request** (default)

A burn-in transcode names its caption source **explicitly in the request**. It
does **not** implicitly wait on, or depend on the completion of, auto-generation.

**Why model 2 over 1 and 3:**

- **It is the smallest** and matches the acceptance criterion "the caption source
  is explicit in the request" directly: the caller states the source; the API
  resolves it to one concrete S3 key (D2) and injects one filter (D3). No queue,
  no cross-pipeline ordering state.
- **Model 1 (wait-on-generation)** couples burn-in to the fire-and-forget
  generation path, which by design *never blocks* and *swallows errors*
  (`src/pipeline/subtitle-generator.ts:6-11, 125-132`). Turning that into a
  blocking/queuing precondition would add an ordering state machine and a
  failure-propagation channel that generation deliberately does not have. That
  *ordering* concern is real, but it is the subject of the dedicated race
  sub-issue **#389** — not something model 2 must solve inline.
- **Model 3 (separate pipeline step)** adds a distinct post-generation pipeline
  stage with its own trigger, state, and callback wiring — more moving parts than
  the acceptance criterion needs. Its only advantage (automatic use of a freshly
  generated track) is recovered by model 2's "reference an existing track"
  addressing mode (D2.b) without a new pipeline stage.

**Relationship to #389:** model 2 makes the *source* explicit and unambiguous.
Whether a referenced-but-not-yet-generated track should fail fast, queue, or be
awaited is a *timing/race* decision that #389 owns and layers ON TOP of this
contract — it changes *when* the referenced key becomes readable, not *what* the
request names or *how* it resolves. This ADR guarantees #389 a stable target: a
single resolved S3 object key (D2).

### D2 — Request-side caption-source shape (field-by-field)

Burn-in is requested as an **optional `burnIn` object on the existing transcode
request**. Absent `burnIn` ⇒ no burn-in (purely additive; today's transcodes are
unchanged). When present, `burnIn` has exactly these fields:

```
burnIn: {
  // REQUIRED. The caption source, as a discriminated union on `type`.
  // Exactly one of the two source modes:
  source:
    | { type: "sidecarKey"; objectKey: string }   // (a) explicit sidecar
    | { type: "subtitleTrack"; trackId: string }   // (b) existing track ref

  // OPTIONAL. Free-form FFmpeg `force_style` string forwarded verbatim into the
  // subtitles filter (e.g. "FontName=Sans,FontSize=24"). Omitted ⇒ no
  // force_style segment. Callers are responsible for valid libass style syntax;
  // the API does not parse it (see D3 escaping note).
  forceStyle?: string
}
```

**Source mode (a) — `sidecarKey` (the primary, closest-to-reference mode):**

- **`objectKey`** (string, REQUIRED) — a **workspace-local MinIO object key**
  (NOT a full URI, NOT cross-bucket) that already holds the caption sidecar. This
  mirrors the exact convention `SubtitleTrack.objectKey` uses
  (`src/data/asset-repo.ts:223-225`) so validation, presigning, and reads reuse
  existing storage plumbing. The API validates that the key exists in the
  workspace bucket before submit; a missing key is a request-time validation
  error (never a silent no-caption encode).
- **Resolution:** `objectKey` **is** the concrete S3 object key the burn-in
  filter reads. No further lookup.
- The key's format is inferred from its extension and MUST be in the burn-in
  accepted set (D4). A full external/`s3://` URI is explicitly out of scope for
  v1 (keeps the source inside the private workspace bucket, matching the
  presign-based reads elsewhere); revisit only if a cross-bucket source is
  actually required.

**Source mode (b) — `subtitleTrack` (reference an existing generated/manual track):**

- **`trackId`** (string, REQUIRED) — the `id` of a `SubtitleTrack` already on the
  asset (`src/data/asset-repo.ts:219-228`).
- **Resolution:** the API looks up the asset's `subtitleTracks`, finds the track
  whose `id === trackId`, and reads its **`objectKey`**
  (`asset-repo.ts:225`) — which, for a generated track, is
  `subtitles/<assetId>/<trackId>.<format>` (C3,
  `src/pipeline/subtitle-generator.ts:101-103, 178-184`). That `objectKey`
  becomes the concrete S3 key the filter reads.
- If the track exists but its `objectKey` is still undefined (generation not yet
  complete, or a track created via presigned-PUT before upload —
  `asset-repo.ts:223-225`), the source is **not yet resolvable**. Model 2's
  contract is "resolve to a concrete key or reject"; the *policy* for the
  not-yet-ready case (reject vs. queue vs. wait) is delegated to **#389**. This
  ADR only requires that the resolution function surface a distinct
  "referenced-track-has-no-objectKey-yet" outcome so #389 can attach its policy.

**Both modes resolve to a single value:** a concrete workspace-local S3 object
key `K`. Everything downstream (D3) consumes only `K` (+ optional `forceStyle`),
so #388 and #389 share one narrow interface.

### D3 — Per-rendition opt-in maps to Encore: **inject the filter into the selected profile's `VideoEncode.filters` at submit time** (chosen), NOT a burn-in profile variant

Given C2 (no per-request `outputs`; profile chosen by name; only `profile` and
`profileParams` are per-request levers), there are two ways to express burn-in:

- **Option X — burn-in profile variants.** Register server-side profile names
  like `abr-1080p-burnin` alongside `abr-1080p`, and select the `-burnin` variant
  when burn-in is requested. **Rejected as default:** it doubles the server-side
  profile catalogue (every ladder × {plain, burn-in}); the caption *source key*
  is per-request and cannot be baked into a static profile name; and per-rendition
  selectivity (burn into 1080p but not 480p) would require yet more variants. A
  static named profile cannot carry the dynamic `K`.
- **Option Y — inject the `subtitles=` filter into the selected profile's
  `VideoEncode.filters` list at submit time (CHOSEN).** The resolved key `K` (D2)
  is turned into the FFmpeg filter string `subtitles=<staged path of K>[:force_style='<forceStyle>']`
  and added to the `filters` list of the target `VideoEncode`(s) in the job
  document, keeping the profile selected by name unchanged.

**Why Y, and how it fits C2:** C2 says there is no per-request `outputs` array —
but it does **not** say the job document is immutable. `profileParams`
(`encore-client.ts:31-39, 86-92`) already sets a precedent for per-request
mutation of the named profile's behaviour via SpEL. Two concrete sub-options for
carrying `K` into the profile, in order of preference, to be pinned by #388's
smoke test:

1. **Via `profileParams` (preferred if the profile is authored for it):** the
   server-side profile's `filters` uses a SpEL placeholder (e.g.
   `${subtitlesFilter}`), and we pass `profileParams: { subtitlesFilter:
   "subtitles=...:force_style='...'" }`. This uses the *existing, verified*
   per-request lever (C2) with **zero new payload fields**, and per-rendition
   selectivity is expressed by which `VideoEncode` entries reference the
   placeholder in the profile. This is the recommended target.
2. **Via a submit-time payload augmentation (fallback):** if profiles cannot be
   re-authored with a placeholder, `toEncorePayload`
   (`encore-client.ts:81-98`) is extended to accept an optional resolved
   `burnIn` and append the `subtitles=` filter into the returned job document's
   encode `filters` — an additive change behind the same `EncoreSubmitInput`
   surface, gated on `burnIn` being present.

**Per-rendition opt-in:** because the filter attaches to *individual*
`VideoEncode` entries (via placeholder membership in sub-option 1, or targeted
augmentation in sub-option 2), a request can burn captions into some renditions
and not others. The `burnIn` request object MAY therefore later carry an optional
rendition selector; v1 defaults to "all video encodes in the selected profile"
when unspecified. The exact placeholder name and whether sub-option 1 or 2 is
used is the **one** item #388 must confirm against a live Encore instance (C1),
because the encore-doc does not pin the `subtitles=` file-path resolution.

### D4 — Accepted burn-in formats: **`srt` and `vtt`; `ttml` NOT accepted for burn-in in v1**

- Burn-in accepts **`srt`** and **`vtt`** sources. These are what the sidecar
  generator can emit (C4, auto-subtitles doc) and what the FFmpeg `subtitles`
  filter reads natively.
- **`ttml` is rejected for burn-in in v1**, even though `SubtitleTrack` may carry
  it (`asset-repo.ts:216-217`). Rationale: the sidecar generator never emits
  ttml (C4), and burning ttml would require a format conversion step the FFmpeg
  `subtitles` filter does not do inline. A `subtitleTrack` reference (D2.b) whose
  track `format === 'ttml'` is a request-time validation error with a clear
  message ("burn-in supports srt/vtt; convert or supply an srt/vtt source"). If
  ttml burn-in is needed later, add an explicit ttml→(srt|vtt) conversion step —
  out of scope here.

## Consequences

- **#388 (implementation)** consumes exactly: the `burnIn` request object (D2),
  the source-resolution function that yields a single concrete key `K` (or a
  distinct "not-yet-ready"/"not-found"/"unsupported-format" outcome), the
  filter-injection mechanism (D3, defaulting to `profileParams` placeholder), and
  the srt/vtt format gate (D4). #388 **must** smoke-test the `subtitles=` filter
  string and its file-path resolution against a live Encore instance (C1) and
  record the confirmed form.
- **#389 (race)** layers timing policy onto D2.b's "referenced track has no
  `objectKey` yet" outcome (fail-fast vs. queue vs. wait). It changes *when* `K`
  is readable, not *what* is named or *how* it resolves — the D2 interface is its
  stable contract.
- **No change to existing transcodes:** `burnIn` is optional and additive; absent
  ⇒ today's behaviour, unchanged.
- **No new server-side output control is assumed:** the design lives entirely
  within the verified per-request levers (`profile` + `profileParams`,
  `encore-client.ts:29-39, 86-92`) and the `VideoEncode.filters` field
  (encore-doc). It does not assume a per-request `outputs` array (which does not
  exist, C2).
- **Source stays inside the private workspace bucket:** both D2 modes resolve to
  a workspace-local `objectKey`; no external/`s3://` source in v1.

## Open dependencies to verify at implementation time

1. **The `subtitles=` burn-in filter string + file-path resolution against
   Encore's execution environment** (C1) — the encore-doc confirms the `filters`
   field but NOT the subtitle-burn syntax or how `<file>` resolves for an
   S3-backed input. #388 MUST smoke-test. Logged:
   `docs/osc-feedback/incoming-burn-in-contract.md` (item 1).
2. **Whether server-side profiles can be re-authored with a `${subtitlesFilter}`
   SpEL placeholder** (D3 sub-option 1) or the payload-augmentation fallback
   (sub-option 2) is required — a provisioning/profile decision confirmed with
   surface-infra during #388.
3. **The `/transcribe/s3` body divergence** between the external doc
   (`{ url, language, format, bucket, key }`) and our runner
   (`{ url, format, outputKey }`, `osc-auto-subtitles.ts:59-69`) does NOT affect
   this ADR (we rely on the in-repo `objectKey` we compute, C3), but is logged for
   completeness (`incoming-burn-in-contract.md`, item 2).

## Contract sources

- **WebFetch `eyevinn.github.io/encore-doc`** (2026-08-22) — `VideoEncode.filters`
  = *"for adding extra FFmpeg Filters"* (Table 3); `AudioEncode.filters` (Table
  2). No mention of `subtitles=`, `force_style`, `burn`, `.srt`, `.vtt`, `.ass`
  anywhere on the page (all confirmed absent).
- `src/pipeline/encore-client.ts:71-98` — `toEncorePayload`: no `outputs` field
  (line 96), profile selected by name (lines 29-30, 87), `profileParams` the only
  other per-request lever (lines 31-39, 86-92).
- `src/pipeline/subtitle-generator.ts:101-103, 151-153, 178-184` — generated
  sidecar key `subtitles/<assetId>/<trackId>.<format>` persisted as
  `SubtitleTrack.objectKey`; default format `vtt` (lines 54-55); fire-and-forget,
  never-blocking generation (lines 6-11, 125-132).
- `src/data/asset-repo.ts:216-217` — `SubtitleFormat = 'vtt' | 'srt' | 'ttml'`;
  `:219-228` — `SubtitleTrack { id, language, format, objectKey?, label?,
  default? }`.
- `src/pipeline/osc-auto-subtitles.ts:11-25, 59-69` — `/transcribe/s3` wire shape
  NOT contract-verified; in-repo body `{ url, format, outputKey }`.
- **docs.osaas.io Subtitle-Generator** — formats listed: `srt`, `vtt` only; wire
  shape carries no stability guarantee.
- ADR-006 / ADR-013 — prior use of the same "profile by name, no per-request
  outputs" Encore constraint (C2) and the `AudioEncode.filters` precedent.
