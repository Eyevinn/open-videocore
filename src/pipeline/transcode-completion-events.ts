// Transcode terminal-state webhook events (issue #829).
//
// THE CONTRACT FOR ANYONE ADDING A COMPLETION PATH: every production site that
// applies a transcode terminal state does so by calling `completeTranscode`
// (src/pipeline/transcode.ts — `export async function completeTranscode`). That
// call is the JOIN, and each one MUST be paired with a call to
// `dispatchTranscodeCompletionEvents` below, immediately behind it. A completion
// applied without that pairing is #829: the job and its asset change state, the
// API reports the change, and the subscriber is told nothing, silently.
//
// There are currently THREE such paths (an earlier revision of this header said
// two, and the one it omitted is exactly where the bug survived a first fix):
//   1. POST /api/v1/internal/encore-callback (src/routes/internal.ts) — Encore's
//      completion webhook, reachable only when the API is deployed publicly.
//   2. The Encore completion callback poller
//      (src/pipeline/encore-callback-poller.ts) — drains the callback listener's
//      Valkey sorted set AND independently sweeps Encore for terminal jobs whose
//      callback message never landed (the listener's fire-and-forget zAdd, and
//      failures Encore never calls back on). Success and failure.
//   3. `settleFailedTranscode` (src/pipeline/failed-transcode-reconciler.ts) —
//      FAILURE only, on two production routes neither of the above can observe:
//      the #273 stall sweep (a job whose Encore record was garbage-collected,
//      404 past the stall timeout, or an Encore-reported failure the sweep sees
//      first) and the scaler's #449 `onJobsDropped` settle (a job gone from an
//      instance's live QUEUED/IN_PROGRESS set). Both are invisible to path 2,
//      whose sweep can only reconcile jobs Encore still reports as terminal.
//
// Webhook dispatch originally lived only in path 1 — so on a deployment where
// completions arrive via path 2 or 3, subscribers to `transcode.complete`,
// `asset.ready`, `transcode.failed` and `asset.failed` silently received nothing
// (#829). This module owns the dispatch so all three paths emit byte-identical
// payloads from one place and none can drift or forget.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - Event-type vocabulary: WEBHOOK_EVENT_TYPES — src/data/webhook-repo.ts:28-36
//     ('asset.ready', 'asset.failed', 'transcode.complete', 'transcode.failed',
//     'package.complete', 'package.failed', ENCODE_COMPLETION_EVENT_TYPE). This
//     is the exact enum POST /api/v1/webhooks validates against
//     (createBodySchema.events — src/routes/webhooks.ts:40).
//   - WebhookDispatcher.dispatch({ type, payload }) — WebhookEvent,
//     src/services/webhook-dispatcher.ts:23-26, :67.
//   - CompleteTranscodeResult { applied, renditionCount, renditions } —
//     src/pipeline/transcode.ts:202-214.
//   - ENCODE_COMPLETION_EVENT_TYPE ('encode.completed') /
//     encodeCompletionEventSchema / encodeDurationMsFromAttempt /
//     resolutionTierForHeight — src/pipeline/encode-completion-event.ts:72,
//     :133, and the ADR-022 payload notes on buildEncodeCompletionEvent below.

import type { WebhookDispatcher } from '../services/webhook-dispatcher.js';
import type { CompleteTranscodeResult } from './transcode.js';
import {
  ENCODE_COMPLETION_EVENT_TYPE,
  encodeDurationMsFromAttempt,
  resolutionTierForHeight,
  type EncodeCompletionEvent
} from './encode-completion-event.js';

// The subset of Job (src/data/job-repo.ts) the terminal events are built from.
// Structural, so both callers can pass their own Job record unchanged.
export type CompletedTranscodeJob = {
  id: string;
  assetId: string;
  profile?: string;
  encodeAttemptLog?: { startedAt: string; endedAt?: string }[];
};

// Build the encode-completion event payload (issue #693, ADR-022) from the data
// in scope at the applied-success completion boundary. Grounded entirely in the
// #691 schema's contract notes (src/pipeline/encode-completion-event.ts):
//   - jobId          <- Job.id (job-repo.ts:85)
//   - assetId        <- Job.assetId (job-repo.ts:88)
//   - encodeDurationMs <- last EncodeAttempt endedAt-startedAt via
//     encodeDurationMsFromAttempt (ADR-012 D3, job-repo.ts:124). undefined when
//     no measurable attempt exists (no encodeAttemptLog / in-flight timing), in
//     which case we omit the event's optional fields tied to it and fall back to
//     0 for the REQUIRED encodeDurationMs — the schema requires a non-negative
//     integer, and 0 explicitly signals "no measured encode time" rather than a
//     misleading value.
//   - resolutionTier <- resolutionTierForHeight(producedVariant.height)
//   - codec/height/width/bitrateBps <- the produced variant Rendition
//     (asset-repo.ts:394-399), present only when Encore reported them.
//   - profile        <- Job.profile (job-repo.ts:111)
//   - renditionCount <- the recorded rendition count.
// The "produced variant" is the first recorded rendition (the ladder's primary
// rung); its dimensions drive the tier. All optional companions are omitted
// (not defaulted) when their source value is absent, per the schema's
// required/optional split.
export function buildEncodeCompletionEvent(
  job: CompletedTranscodeJob,
  renditions: { codec?: string; height?: number; width?: number; bitrateBps?: number }[],
  renditionCount: number
): EncodeCompletionEvent {
  const lastAttempt = job.encodeAttemptLog?.[job.encodeAttemptLog.length - 1];
  const encodeDurationMs = encodeDurationMsFromAttempt(lastAttempt);
  const variant = renditions[0];
  const height = variant && typeof variant.height === 'number' && variant.height > 0 ? variant.height : undefined;
  const width = variant && typeof variant.width === 'number' && variant.width > 0 ? variant.width : undefined;
  const bitrateBps =
    variant && typeof variant.bitrateBps === 'number' && variant.bitrateBps >= 0 ? variant.bitrateBps : undefined;

  const event: EncodeCompletionEvent = {
    eventType: ENCODE_COMPLETION_EVENT_TYPE,
    jobId: job.id,
    assetId: job.assetId,
    // encodeDurationMs is REQUIRED (schema: non-negative int). Fall back to 0
    // when no attempt timing is available (see note above).
    encodeDurationMs: encodeDurationMs ?? 0,
    resolutionTier: resolutionTierForHeight(height),
    occurredAt: new Date().toISOString(),
    renditionCount
  };
  if (variant?.codec) event.codec = variant.codec;
  if (height !== undefined) event.height = height;
  if (width !== undefined) event.width = width;
  if (bitrateBps !== undefined) event.bitrateBps = bitrateBps;
  if (job.profile) event.profile = job.profile;
  return event;
}

export type TranscodeCompletionEventInput = {
  // Absent on deployments with webhooks disabled — then this is a no-op.
  dispatcher?: WebhookDispatcher;
  job: CompletedTranscodeJob;
  // Terminal outcome as derived from Encore's status by the calling path.
  success: boolean;
  // Human-readable failure reason, used as the `error` field on the failure
  // events. Ignored on the success path.
  error?: string;
  // The value `completeTranscode` returned for THIS completion.
  result: Pick<CompleteTranscodeResult, 'applied' | 'renditionCount' | 'renditions'>;
};

// Notify subscribers that a transcode reached a terminal state (issue #13).
//
// Fire-and-forget by design: every dispatch is detached and the dispatcher
// swallows its own delivery errors (webhook-dispatcher.ts:67-76), so this never
// throws into — or slows down — the completion path that called it. Emitted ONLY
// when the completion actually applied (`result.applied`, i.e. not a duplicate /
// late no-op) so a redelivered Encore callback, or a sweep that re-observes an
// already-settled job, never double-fires events or double-meters the billing
// oriented encode-completion event.
//
// Success emits: transcode.complete, asset.ready, encode.completed.
// Failure emits: transcode.failed, asset.failed.
export function dispatchTranscodeCompletionEvents(input: TranscodeCompletionEventInput): void {
  const { dispatcher, job, success, error, result } = input;
  if (!dispatcher || !result.applied) return;

  const assetId = job.assetId;
  if (success) {
    void dispatcher.dispatch({
      type: 'transcode.complete',
      payload: { assetId, renditionCount: result.renditionCount }
    });
    // The source asset returns to `ready` once its renditions exist.
    void dispatcher.dispatch({
      type: 'asset.ready',
      payload: { assetId }
    });
    // Billing-oriented encode-completion event (issue #693, ADR-022). Emitted IN
    // ADDITION TO transcode.complete over the same outbound-webhook transport,
    // gated by the identical `result.applied` guard.
    void dispatcher.dispatch({
      type: ENCODE_COMPLETION_EVENT_TYPE,
      payload: buildEncodeCompletionEvent(job, result.renditions, result.renditionCount)
    });
  } else {
    void dispatcher.dispatch({
      type: 'transcode.failed',
      payload: { assetId, error }
    });
    void dispatcher.dispatch({
      type: 'asset.failed',
      payload: { assetId, error }
    });
  }
}
