// Scene/shot-detection pipeline step (issue #115).
//
// After an asset's payload lands in MinIO, an OSC scene-detection run analyses
// the stored object and the result — a list of scene/shot boundaries with cut
// timecodes — is written back onto the asset as `sceneMetadata` for use in the
// clip/trim workflows (the boundaries tell an editor where the natural cut
// points are). Detection is a METADATA-producing step (like technical-metadata
// extraction), NOT an asset-producing step (unlike clip): it only annotates the
// asset record.
//
// Detection is FIRE-AND-FORGET from the ingest/pipeline path exactly like
// technical metadata extraction (metadata-extractor.ts) and auto-subtitles
// (subtitle-generator.ts): it must never block the ingest response and must
// never throw into a detached caller, so `detectScenes` swallows every error and
// records it on the asset as `sceneDetectionError` (leaving `sceneMetadata`
// null). It never drives the lifecycle state machine.
//
// OSC wiring: detection runs on the eyevinn-function-scenes serverless "media
// function" (see services/stack.ts SCENE_DETECT_SERVICE_ID). As with the ffprobe
// and auto-subtitles paths we do NOT stream bytes through the API. We mint a
// short-lived presigned GET URL for the MinIO source object and hand that URL to
// the detector; the function reads it directly. The presigned URL is the only
// credential the function ever sees and it expires quickly, so a leaked URL has
// a small blast radius (mirrors the probe-URL / subtitle-URL / upload-URL TTL
// rationale).
//
// The OSC call itself is injected as a `SceneDetector` so it can be stubbed in
// tests and swapped without touching the orchestration logic, and — crucially —
// so the runtime wire shape stays isolated in exactly one place
// (osc-scene-detect.ts).
//
// Contract sources (runtime shape confirmed 2026-09-25, issue #797):
//   - eyevinn-function-scenes ("Scene Detect Media Function"), get-service-schema:
//     a serverless media function whose create-service-instance config requires
//     `name` (string) ONLY. get-service-schema exposes ONLY the provisioning
//     config, NOT the runtime endpoint's request/response wire shape.
//   - The runtime shape was instead confirmed from the upstream service source
//     `Eyevinn/function-scenes` @ 492a18f23e253194c27800563ea0c96bef187aef —
//     `api.json` (`#/model/request.medialocator`, `#/model/createJobResponse`,
//     `#/model/job.state`) and the `index.js` route table. It is an ASYNC JOB API
//     rooted at `/api/v1`, and it returns only keyframe image URIs — see
//     docs/investigations/797-function-scenes-runtime-contract.md.
//   - services/stack.ts SCENE_DETECT_SERVICE_ID.
//
// NOTE (#798): osc-scene-detect.ts now speaks that confirmed contract (POST
// /api/v1 + `medialocator`, then poll the returned status endpoint), so runs no
// longer 405. But the service still returns NO scene-boundary timecodes, so the
// `scenes`/`cuts` result modelled below cannot be populated from it. That makes
// this step a PARTIAL fix, not a completion of #798: a successful run cannot write
// scene boundaries, so it writes no `sceneMetadata` at all (see
// `boundariesUnavailable` below) rather than claiming `sceneCount: 0`. Making the
// step useful end to end needs `sceneMetadata` re-scoped (keyframe URIs, which is an
// openapi.json change and therefore a ux/architect call) or a different source for
// cut timecodes, so the types are left unchanged here.

import type { AssetRepository, SceneMetadata, SceneBoundary } from '../data/asset-repo.js';
import type { WorkspaceStorage } from '../data/storage.js';

// TTL for the presigned GET URL handed to the scene detector. Short by design:
// the detection reads the object once. Configurable via env.
export const DEFAULT_SCENE_URL_TTL_SECONDS = 30 * 60; // 30 minutes

export function sceneUrlTtlSeconds(): number {
  const raw = process.env['SCENE_URL_TTL_SECONDS'];
  if (!raw) return DEFAULT_SCENE_URL_TTL_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SCENE_URL_TTL_SECONDS;
}

// The raw result a `SceneDetector` returns for one detection run. A detector may
// report boundaries as either a list of structured cut points (`scenes`) or a bare
// list of cut timecodes in seconds (`cuts`); the orchestrator normalizes either into
// our SceneMetadata shape. Both stay optional so a detector can report only the
// style it has.
export type SceneDetectorResult = {
  // Structured scene/shot descriptors, when the function reports them directly.
  scenes?: Array<{
    startSeconds?: number;
    endSeconds?: number;
    // Some detectors report a single keyframe/representative timecode per shot
    // rather than a [start,end) window; keep it permissive.
    keyframeSeconds?: number;
  }>;
  // Bare cut points (scene-boundary timecodes) in seconds, when the function
  // reports only the transitions. The orchestrator derives [start,end) windows
  // from consecutive cuts.
  cuts?: number[];
  // Set when the run SUCCEEDED but the backing service structurally cannot report
  // cut timecodes, so "no boundaries" is a property of the service rather than of
  // the video. This is the case for the confirmed eyevinn-function-scenes contract
  // today (see file header + osc-scene-detect.ts). It exists so that outcome is
  // distinguishable from a genuine no-cut video: `detectScenes` declines to write a
  // zero-boundary `sceneMetadata` record in this case instead of asserting
  // `sceneCount: 0`. It is NOT a failure, so it never becomes `sceneDetectionError`.
  boundariesUnavailable?: { reason: string };
};

// Calls the OSC scene-detection function against a presigned source URL and
// returns its raw result. Injected so tests stub it and the OSC HTTP/job
// specifics stay in one place (osc-scene-detect.ts). Throws on a transport/
// function failure; the orchestrator turns that into a recorded error.
export type SceneDetector = (presignedUrl: string) => Promise<SceneDetectorResult>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// Normalize a raw detector result into our SceneMetadata shape. Handles both
// reporting styles (structured `scenes` or bare `cuts`); when both are present
// the structured `scenes` list wins. Every field is still defended — a detector is
// an external service, so malformed/partial entries are skipped rather than
// throwing.
//
// NOTE (#798): both branches below are currently UNREACHABLE from the only shipped
// detector. The confirmed eyevinn-function-scenes contract returns neither `scenes`
// nor `cuts` (it has no cut timecodes at all), so `makeOscSceneDetector` always
// reports `boundariesUnavailable` and `detectScenes` never reaches this function.
// They are kept — not dead code to delete — because they are the target shape for
// whichever source of cut timecodes the pending `sceneMetadata` re-scope picks
// (see the file header); do not read them as live code paths until then.
export function parseSceneResult(result: SceneDetectorResult, now: string): SceneMetadata {
  const boundaries: SceneBoundary[] = [];

  if (result.scenes && result.scenes.length > 0) {
    for (const s of result.scenes) {
      const boundary: SceneBoundary = {};
      if (isFiniteNumber(s.startSeconds)) boundary.startSeconds = s.startSeconds;
      if (isFiniteNumber(s.endSeconds)) boundary.endSeconds = s.endSeconds;
      if (isFiniteNumber(s.keyframeSeconds)) boundary.keyframeSeconds = s.keyframeSeconds;
      // Skip an entry that carried no usable timecode at all.
      if (
        boundary.startSeconds !== undefined ||
        boundary.endSeconds !== undefined ||
        boundary.keyframeSeconds !== undefined
      ) {
        boundaries.push(boundary);
      }
    }
  } else if (result.cuts && result.cuts.length > 0) {
    // Derive [start,end) windows from consecutive, ascending cut points. Each
    // cut is also surfaced as the window's keyframe (the frame at the cut).
    const cuts = result.cuts.filter(isFiniteNumber).slice().sort((a, b) => a - b);
    for (let i = 0; i < cuts.length; i++) {
      const startSeconds = cuts[i];
      const boundary: SceneBoundary = { startSeconds, keyframeSeconds: startSeconds };
      // The last cut has no following boundary, so it has no end.
      if (i + 1 < cuts.length) boundary.endSeconds = cuts[i + 1];
      boundaries.push(boundary);
    }
  }

  return {
    boundaries,
    sceneCount: boundaries.length,
    detectedAt: now
  };
}

export type DetectScenesParams = {
  assetId: string;
  objectKey: string;
};

export type DetectScenesDeps = {
  assets: AssetRepository;
  storage: WorkspaceStorage;
  detect: SceneDetector;
  // Injectable for tests; defaults to env-derived TTL.
  ttlSeconds?: number;
  // Test observability hook fired on a recorded failure.
  onError?: (err: unknown) => void;
  // Observability hook fired when the run succeeded but the detector reported that
  // boundaries are structurally unavailable, so nothing was written.
  onBoundariesUnavailable?: (reason: string) => void;
};

// Run one scene detection to completion. NEVER throws: on any failure it records
// `sceneDetectionError` on the asset and resolves, so it is safe to invoke
// detached with `void detectScenes(...)` from the ingest/pipeline path.
//
// On success: writes `sceneMetadata` (which clears any prior error).
// On failure: writes `sceneMetadata: null` + `sceneDetectionError`.
// When the detector reports `boundariesUnavailable` and produced no boundaries:
// writes NOTHING (see below).
export async function detectScenes(
  params: DetectScenesParams,
  deps: DetectScenesDeps
): Promise<void> {
  const { assetId, objectKey } = params;
  try {
    const ttl = deps.ttlSeconds ?? sceneUrlTtlSeconds();
    const presignedUrl = await deps.storage.presignedGet(objectKey, ttl);
    const result = await deps.detect(presignedUrl);
    const metadata = parseSceneResult(result, new Date().toISOString());

    // The detector succeeded but told us it structurally cannot report cut
    // timecodes (#798 — eyevinn-function-scenes returns keyframe images only).
    // Persisting `{ boundaries: [], sceneCount: 0 }` here would assert "this video
    // has no scene cuts", which a consumer cannot tell apart from a genuine
    // single-shot video and which would be wrong for EVERY input. So write nothing:
    // `sceneMetadata` stays absent, meaning "no scene metadata is available", which
    // IS distinguishable from a real zero-boundary result. It is not an error
    // either, so `sceneDetectionError` is deliberately left clear.
    if (result.boundariesUnavailable && metadata.boundaries.length === 0) {
      deps.onBoundariesUnavailable?.(result.boundariesUnavailable.reason);
      return;
    }

    // Detection annotates the asset only; it never drives the lifecycle state
    // machine (the ingest/transcode paths own status transitions).
    await deps.assets.update(assetId, { sceneMetadata: metadata });
  } catch (err) {
    deps.onError?.(err);
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort error recording. If even this write fails there is nothing more
    // we can do from a detached task; we still must not throw. Missing scene
    // metadata is not fatal and never changes the asset's lifecycle state.
    try {
      await deps.assets.update(assetId, {
        sceneMetadata: null,
        sceneDetectionError: message
      });
    } catch {
      // Swallow: the detached caller has no error channel.
    }
  }
}
