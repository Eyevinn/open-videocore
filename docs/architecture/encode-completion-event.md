# Encode-completion event payload schema

Issue: [#691](https://github.com/Eyevinn/open-videocore/issues/691) — *define the
encode-completion event payload schema (duration + codec/resolution tier)*.
Broken down from [#690](https://github.com/Eyevinn/open-videocore/issues/690).

Status: **Schema defined.** This document + `src/pipeline/encode-completion-event.ts`
(the Zod schema and inferred type) are the canonical contract for the
encode-completion event payload.

## Scope and non-goals

This issue is **schema definition only**. Explicitly out of scope:

- **Event emission** — wiring `completeTranscode` (or the callback poller /
  internal route) to actually build and publish this payload is
  [#693](https://github.com/Eyevinn/open-videocore/issues/693).
- **Transport** — whether the event is delivered by webhook, a message bus, or
  polling is [#692](https://github.com/Eyevinn/open-videocore/issues/692). No
  transport is decided here. **If** #692 introduces a new integration pattern
  (e.g. a durable bus this codebase does not yet use), that decision must be
  recorded in a new ADR under `docs/architecture/` at that time; this document
  deliberately does not pre-decide it.

## Why the event exists

The platform's plan-token deduction needs, at the moment a transcode job settles
successfully, the billable dimensions of the encode — how long the encode ran
(compute time), which codec was produced, and which resolution tier — keyed by
the job so a downstream consumer can attribute cost. The existing
`transcode.complete` webhook event (`src/routes/internal.ts:571`) carries only
`{ assetId, renditionCount }`, which is insufficient for billing. This event is a
richer, billing-oriented **superset**; it does not replace the lifecycle event.

## Contract grounding (CLAUDE.md rule 7)

Every field is grounded in data that already exists at transcode completion. No
field is invented. The verified sources, read in-branch:

| Value | Source symbol |
|-------|---------------|
| Completion boundary + available renditions | `completeTranscode(...)` success branch — `src/pipeline/transcode.ts:192`; `CallbackRendition` — `src/pipeline/transcode.ts:163` |
| Job id, asset id, profile, terminal time | `Job.id` / `Job.assetId` / `Job.profile` / `Job.updatedAt` — `src/data/job-repo.ts:84` |
| Encode duration (excl. retries) | `Job.encodeAttemptLog` (`EncodeAttempt.startedAt`/`endedAt`) — `src/data/job-repo.ts:43,124`; derivation rule — ADR-012 Decision 3 (`docs/architecture/ADR-012-encode-attempt-shape.md:131`) |
| Codec | `Rendition.codec?` — `src/data/asset-repo.ts:398`; fallback `TechnicalMetadata.codec` — `src/data/asset-repo.ts:307` |
| Height / width | `Rendition.height`/`Rendition.width` — `src/data/asset-repo.ts:394` |
| Output format | `EncoreOutput.format` — `src/pipeline/encode-presets.ts:29` |
| Bitrate | `Rendition.bitrateBps?` — `src/data/asset-repo.ts:399` |
| Timestamp convention | `new Date().toISOString()` (ISO-8601 UTC) — repo-wide, e.g. `src/pipeline/transcode.ts:559` |

There is **no** existing resolution-tier vocabulary in the repo (the only
`*-tier` concept is `STORAGE_TIERS`, `src/data/asset-repo.ts:123`, which is
unrelated to resolution). This schema introduces the resolution-tier enum,
mirroring the const-array-enum convention of `STORAGE_TIERS`.

## Event name

`encode.completed` (constant `ENCODE_COMPLETION_EVENT_TYPE`). A dotted
`<domain>.<pastTenseVerb>` string, consistent with the existing webhook event
vocabulary (`transcode.complete`, `package.complete`). Deliberately distinct from
`transcode.complete`.

## Payload fields

Field names, types, units, and the required/optional split are defined in
`src/pipeline/encode-completion-event.ts` as a Zod schema
(`encodeCompletionEventSchema`) with the inferred type `EncodeCompletionEvent`.

### Required

| Field | Type | Meaning |
|-------|------|---------|
| `eventType` | `"encode.completed"` (literal) | Discriminator a consumer routes on. |
| `jobId` | `string` (non-empty) | The local transcode `Job.id` — the correlation key for attribution. |
| `assetId` | `string` (non-empty) | The source asset the encode was produced for (`Job.assetId`). |
| `encodeDurationMs` | `integer >= 0` | **Encode compute time in MILLISECONDS**, excluding retries. See units below. |
| `resolutionTier` | enum `sd` \| `hd` \| `fhd` \| `uhd` \| `unknown` | Coarse resolution bucket of the produced variant. |
| `occurredAt` | ISO-8601 UTC `string` | The event's own timestamp (authoritative event time). |

### Optional (present when available at completion)

| Field | Type | Meaning |
|-------|------|---------|
| `codec` | `string` | Codec identifier of the produced rendition (e.g. `"h264"`, `"hevc"`); free string — no repo codec enum exists. |
| `height` | `integer > 0` | Pixel height of the produced variant (raw companion to `resolutionTier`). |
| `width` | `integer > 0` | Pixel width of the produced variant. |
| `outputFormat` | `string` | Container/segment format (e.g. `"mp4"`, `"fmp4"`). |
| `bitrateBps` | `integer >= 0` | Overall bitrate of the produced variant, **in bits per second**. |
| `profile` | `string` | The encode profile name used (`Job.profile`). |
| `renditionCount` | `integer >= 0` | Number of renditions this completion produced. |
| `completedAt` | ISO-8601 UTC `string` | The job's terminal-transition time (`Job.updatedAt` at `done`). |

## Units (part of the contract)

- **`encodeDurationMs` is MILLISECONDS, not seconds.** The `Ms` suffix names the
  unit in the field itself so it cannot be misread. It is the *excluding-retries*
  duration per ADR-012 Decision 3: the last (successful) encode attempt's
  `Date.parse(endedAt) - Date.parse(startedAt)`. Milliseconds were chosen because
  the source values are ISO-8601 timestamps whose delta is naturally an integer
  millisecond count — this imposes no lossy rounding to seconds on the emitter; a
  consumer can divide by 1000 for seconds.
- **`bitrateBps` is bits per second** (the `Bps` suffix names the unit).
- **Timestamps (`occurredAt`, `completedAt`) are ISO-8601 UTC strings**, the
  repo-wide `new Date().toISOString()` convention.

## Resolution-tier boundaries

Keyed off the produced variant's pixel `height` (`resolutionTierForHeight`):

| Tier | Height range | Examples |
|------|--------------|----------|
| `sd` | `height < 720` | 360p, 480p |
| `hd` | `720 <= height < 1080` | 720p |
| `fhd` | `1080 <= height < 2160` | 1080p, 1440p |
| `uhd` | `height >= 2160` | 2160p / 4K and above |
| `unknown` | missing / non-positive height | Encore returned no video stream dimensions (`Rendition.height` is `0`) |

`unknown` is an explicit bucket so a consumer never bills a real tier for a
completion whose resolution could not be measured.

## Helpers exported for #693

`src/pipeline/encode-completion-event.ts` also exports two pure helpers so the
emitter (#693) and any test compute the same values:

- `resolutionTierForHeight(height): ResolutionTier` — the tier boundary logic
  above.
- `encodeDurationMsFromAttempt(attempt): number | undefined` — the ADR-012 D3
  derivation from a settled-successful `EncodeAttempt` timing pair. Returns
  `undefined` (not a misleading `0`) when the timing pair is incomplete or
  unparseable, so #693 can decide how to handle an unmeasurable duration.

## Downstream

- #692 chooses the transport (and opens an ADR if it introduces a new pattern).
- #693 wires emission at the successful-completion boundary
  (`completeTranscode`, `src/pipeline/transcode.ts:192`) using this schema and
  these helpers.
- #694 builds on the above.
