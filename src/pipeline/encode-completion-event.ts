// Encode-completion event payload schema (issue #691, broken down from #690).
//
// SCOPE: this module is the CANONICAL PAYLOAD SCHEMA for the encode-completion
// event ONLY. It deliberately does NOT emit the event (that is #693) and does
// NOT decide the transport — webhook / message bus / polling (that is #692). It
// defines the shape, field names, types, units, and required/optional split so
// #692/#693/#694 can build on one agreed contract. The transport decision, if
// it introduces a new integration pattern, will be recorded in a future ADR
// under docs/architecture/ (see docs/architecture/encode-completion-event.md).
//
// WHY THIS EXISTS: OSC Platform's plan-token deduction needs, at the moment a
// transcode job settles successfully, the billable dimensions of the encode —
// how long the encode ran (compute time), what codec was produced, and which
// resolution tier — keyed by the job so a downstream consumer can attribute the
// cost. This schema names exactly those fields and pins their units.
//
// ---------------------------------------------------------------------------
// Verified contract sources (CLAUDE.md rule 7 — every symbol read in-branch)
// ---------------------------------------------------------------------------
// Each field below is grounded in data that ALREADY EXISTS at encode/transcode
// completion. No field is invented; the mapping notes cite where each value is
// produced today.
//
//   - Completion boundary + available inputs:
//     `completeTranscode(params, deps)` — src/pipeline/transcode.ts:192. On the
//     SUCCESS branch it has `params.jobId` (local Job id), `params.sourceAssetId`,
//     and `params.renditions: CallbackRendition[]` (src/pipeline/transcode.ts:163)
//     each carrying `{ label, width, height, objectKey, codec?, bitrateBps? }`.
//     It marks the Job `done` (transcode.ts:256).
//   - Job identity + timing: `Job` — src/data/job-repo.ts:84. `Job.id` is the
//     stable local job identifier (job-repo.ts:85). `Job.encodeAttemptLog:
//     EncodeAttempt[]` (job-repo.ts:124) is the durable per-dispatch log; the
//     "encode duration excluding retries" is the LAST (successful) attempt's
//     `endedAt - startedAt` per ADR-012 Decision 3
//     (docs/architecture/ADR-012-encode-attempt-shape.md:131-147). `EncodeAttempt`
//     (job-repo.ts:43) has `startedAt`/`endedAt` as ISO-8601 strings, so the
//     duration is derived as a millisecond delta of two `Date.parse` reads.
//   - Codec identifier: `Rendition.codec?: string` — src/data/asset-repo.ts:398,
//     carried through from `CallbackRendition.codec?` (transcode.ts:169). Also
//     available on source `TechnicalMetadata.codec: string` (asset-repo.ts:307)
//     when the rendition codec is absent. String identifier (e.g. "h264",
//     "hevc"); no repo-wide codec enum exists, so it stays a free string here.
//   - Resolution tier: derived from `Rendition.height` (asset-repo.ts:395), the
//     height of the produced variant. There is NO existing resolution-tier
//     vocabulary in the repo (the only *-tier concept is STORAGE_TIERS,
//     asset-repo.ts:123, which is unrelated); this module introduces the tier
//     enum below, mirroring the const-array-enum convention of STORAGE_TIERS.
//   - Output format / container: `EncoreOutput.format` (src/pipeline/
//     encode-presets.ts:29, e.g. "mp4"/"fmp4") describes the intended container
//     of a produced rung. Optional here because it is a preset-descriptor field and is
//     not part of the CallbackRendition wire shape at completion.
//   - Existing lifecycle event precedent: the webhook `transcode.complete` event
//     currently carries only `{ assetId, renditionCount }`
//     (src/routes/internal.ts:571). THIS schema is the richer, billing-oriented
//     superset; it does not replace that event and does not wire delivery.
//
// Zod is the repo's contract-modelling tool (fastify-type-provider-zod), so this
// schema is a Zod object + an inferred TS type, matching the `jobSchema` /
// `encodeAttemptSchema` convention in src/routes/jobs.ts:41-46.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Event type / name
// ---------------------------------------------------------------------------

// The canonical event name. A dotted `<domain>.<pastTenseVerb>` string,
// consistent with the existing webhook event vocabulary ("transcode.complete",
// "package.complete", src/routes/internal.ts:571,339). Distinct from
// "transcode.complete" on purpose: that event is the lifecycle notification with
// a minimal payload; THIS event is the billing-oriented completion record.
export const ENCODE_COMPLETION_EVENT_TYPE = 'encode.completed' as const;
export type EncodeCompletionEventType = typeof ENCODE_COMPLETION_EVENT_TYPE;

// ---------------------------------------------------------------------------
// Resolution tier
// ---------------------------------------------------------------------------

// Resolution tiers, coarsest billable buckets keyed off the produced variant's
// pixel height. This is a NEW vocabulary (no existing resolution-tier enum in
// the repo — see the contract note above). Ordered smallest → largest so a
// consumer can compare tiers. `unknown` is the explicit bucket for a completion
// whose height could not be determined (e.g. Encore returned no videoStreams, so
// `Rendition.height` is 0 — see normaliseRenditions, src/routes/internal.ts:203).
//
// Const-array-enum convention mirrors STORAGE_TIERS (src/data/asset-repo.ts:123).
export const RESOLUTION_TIERS = ['sd', 'hd', 'fhd', 'uhd', 'unknown'] as const;
export type ResolutionTier = (typeof RESOLUTION_TIERS)[number];

// Tier boundaries by pixel height (the produced variant's `height`). Boundaries
// are the conventional broadcast/streaming breakpoints:
//   sd   : height <  720            (e.g. 360p, 480p)
//   hd   : 720  <= height < 1080    (e.g. 720p)
//   fhd  : 1080 <= height < 2160    (e.g. 1080p, 1440p)
//   uhd  : height >= 2160           (e.g. 2160p / 4K and above)
// A non-positive / missing height maps to `unknown` rather than silently `sd`,
// so a consumer never bills a real tier for a completion we could not measure.
export function resolutionTierForHeight(height: number | undefined): ResolutionTier {
  if (height === undefined || !Number.isFinite(height) || height <= 0) {
    return 'unknown';
  }
  if (height < 720) return 'sd';
  if (height < 1080) return 'hd';
  if (height < 2160) return 'fhd';
  return 'uhd';
}

// ---------------------------------------------------------------------------
// Payload schema
// ---------------------------------------------------------------------------

// The canonical encode-completion event payload.
//
// UNITS ARE PART OF THE CONTRACT:
//   - encodeDurationMs is MILLISECONDS (an integer), NOT seconds. It is the
//     "excluding retries" encode duration per ADR-012 Decision 3: the last
//     (successful) attempt's `endedAt - startedAt`. Chosen ms (not s) because
//     the source values are ISO-8601 timestamps whose delta is naturally an
//     integer millisecond count (Date.parse), so no lossy rounding to seconds
//     is imposed on the emitter; a consumer can divide by 1000 if it wants
//     seconds. The `Ms` suffix names the unit in the field itself so it can
//     never be misread.
//   - occurredAt / completedAt are ISO-8601 UTC strings (the repo-wide
//     timestamp convention — every `*At` field is `new Date().toISOString()`,
//     e.g. transcode.ts:559, job-repo.ts:389).
//
// REQUIRED vs OPTIONAL:
//   Required (always derivable at a SUCCESSFUL completion): eventType, jobId,
//   assetId, encodeDurationMs, resolutionTier, occurredAt.
//   Optional (best-effort companions that may be absent depending on what Encore
//   reported): codec, height, width, outputFormat, bitrateBps, profile,
//   renditionCount, completedAt.
export const encodeCompletionEventSchema = z.object({
  // Discriminator. Fixed literal so a consumer can route on it.
  eventType: z.literal(ENCODE_COMPLETION_EVENT_TYPE),

  // The local transcode Job id (Job.id, job-repo.ts:85) — the correlation key a
  // consumer uses to attribute the encode. REQUIRED.
  jobId: z.string().min(1),

  // The source asset the encode was produced for (Job.assetId, job-repo.ts:88).
  // REQUIRED — the asset is the natural billing subject alongside the job.
  assetId: z.string().min(1),

  // Encode compute time EXCLUDING retries, in MILLISECONDS (integer). Derived
  // from the last (successful) EncodeAttempt: Date.parse(endedAt) -
  // Date.parse(startedAt) (ADR-012 D3). REQUIRED — this is the primary billable
  // dimension. Non-negative.
  encodeDurationMs: z.number().int().nonnegative(),

  // Coarse resolution bucket of the produced variant (see RESOLUTION_TIERS).
  // REQUIRED — a plan-token model bills by tier; `unknown` is a valid, explicit
  // value when height could not be measured.
  resolutionTier: z.enum(RESOLUTION_TIERS),

  // When this completion occurred, ISO-8601 UTC. REQUIRED — the event's own
  // timestamp (distinct from completedAt, which is the job's terminal-transition
  // time; the two are usually equal but the event may be emitted slightly later
  // by #693). Consumers should treat occurredAt as the authoritative event time.
  occurredAt: z.string().datetime(),

  // --- Optional companions (present when available at completion) ---

  // Codec identifier of the produced rendition (Rendition.codec, asset-repo.ts:
  // 398) or, failing that, the source codec (TechnicalMetadata.codec,
  // asset-repo.ts:307). Free string (e.g. "h264", "hevc") — no repo codec enum
  // exists. OPTIONAL: Encore does not always report a per-rendition codec.
  codec: z.string().min(1).optional(),

  // Pixel height/width of the produced variant (Rendition.height/width,
  // asset-repo.ts:394-395). OPTIONAL raw companions to resolutionTier, retained
  // so a consumer can re-derive or audit the tier. Absent when Encore reported
  // no video stream dimensions.
  height: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),

  // Container/segment format of the output (EncoreOutput.format, encode-presets.
  // ts:29, e.g. "mp4"/"fmp4"). OPTIONAL — a preset-level descriptor not carried
  // on the CallbackRendition completion wire shape.
  outputFormat: z.string().min(1).optional(),

  // Overall bitrate of the produced variant in BITS PER SECOND (Rendition.
  // bitrateBps, asset-repo.ts:399 — the `Bps` suffix names the unit). OPTIONAL.
  bitrateBps: z.number().int().nonnegative().optional(),

  // The encode profile name used (Job.profile, job-repo.ts:111). OPTIONAL
  // context for a consumer that bills differently per profile.
  profile: z.string().min(1).optional(),

  // How many renditions this completion produced (mirrors the existing
  // transcode.complete payload's renditionCount, internal.ts:572). OPTIONAL.
  renditionCount: z.number().int().nonnegative().optional(),

  // The job's terminal-transition time, ISO-8601 UTC (Job.updatedAt at the
  // `done` transition, job-repo.ts:141). OPTIONAL — occurredAt is the required
  // event time; completedAt is retained for consumers that want the exact job
  // settle instant.
  completedAt: z.string().datetime().optional()
});

export type EncodeCompletionEvent = z.infer<typeof encodeCompletionEventSchema>;

// ---------------------------------------------------------------------------
// Duration derivation helper
// ---------------------------------------------------------------------------

// A minimal structural view of the two timestamps this module reads off the
// successful encode attempt. Kept local (not importing EncodeAttempt) so this
// schema module has no dependency on the job repo's mutable internals — it only
// needs the timing pair. `endedAt` may be absent on an attempt still in flight;
// callers pass the SETTLED-successful attempt (job-repo.ts EncodeAttempt:43,
// ADR-012 D3).
export type AttemptTiming = {
  startedAt: string;
  endedAt?: string;
};

// Derive encodeDurationMs (excluding retries) from the last successful encode
// attempt, per ADR-012 Decision 3. Returns a non-negative integer millisecond
// delta, or undefined when the timing pair is incomplete/unparseable so the
// emitter (#693) can decide how to handle a completion with no measurable
// duration (rather than emitting a misleading 0). Emission logic itself is out
// of scope for #691; this helper only pins the derivation so #693 and any test
// compute the same number.
export function encodeDurationMsFromAttempt(attempt: AttemptTiming | undefined): number | undefined {
  if (!attempt || !attempt.endedAt) return undefined;
  const start = Date.parse(attempt.startedAt);
  const end = Date.parse(attempt.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  const delta = end - start;
  if (delta < 0) return undefined;
  return Math.round(delta);
}
