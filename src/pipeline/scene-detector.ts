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
// so the un-contract-verified runtime wire shape stays isolated in exactly one
// place (osc-scene-detect.ts).
//
// Contract sources:
//   - eyevinn-function-scenes ("Scene Detect Media Function"), get-service-schema:
//     a serverless media function whose create-service-instance config requires
//     `name` (string) ONLY. get-service-schema exposes ONLY the provisioning
//     config, NOT the runtime endpoint's request/response wire shape — so that
//     runtime shape is deliberately NOT modelled here and is isolated behind this
//     injected interface (see osc-scene-detect.ts header).
//   - services/stack.ts SCENE_DETECT_SERVICE_ID.

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

// The raw result a `SceneDetector` returns for one detection run. Kept permissive
// (every field optional) because the runtime wire shape of eyevinn-function-scenes
// is NOT contract-verified (see file header): the parser below defends every
// field. A detector may report boundaries as either a list of structured cut
// points (`scenes`) or a bare list of cut timecodes in seconds (`cuts`); the
// orchestrator normalizes either into our SceneMetadata shape.
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
// the structured `scenes` list wins. Defends every field because the wire shape
// is unverified — malformed/partial entries are skipped rather than throwing.
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
};

// Run one scene detection to completion. NEVER throws: on any failure it records
// `sceneDetectionError` on the asset and resolves, so it is safe to invoke
// detached with `void detectScenes(...)` from the ingest/pipeline path.
//
// On success: writes `sceneMetadata` (which clears any prior error).
// On failure: writes `sceneMetadata: null` + `sceneDetectionError`.
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
