// Auto-subtitle generation pipeline (issue #114).
//
// After an asset's payload lands in MinIO, an OSC Whisper transcription runs
// against the stored object and the result is attached to the asset as a
// SubtitleTrack (issue #18 track shape) via the existing subtitle-track object
// key convention: `subtitles/<assetId>/<trackId>.<format>`. Generation is
// FIRE-AND-FORGET from the ingest path exactly like technical metadata
// extraction (metadata-extractor.ts): it must never block the ingest response
// and must never throw into a detached caller, so `generateSubtitles` swallows
// every error and records it on the asset as `subtitlesError` (leaving the
// asset's existing subtitle tracks untouched on failure).
//
// OSC wiring: transcription runs on the eyevinn-auto-subtitles service
// ("Subtitle Generator", Whisper-based). Unlike eyevinn-ffmpeg-s3 (an ephemeral
// job runner via createJob/removeJob), auto-subtitles is a LONG-LIVED SERVICE
// instance we call over HTTP at its instance URL — see services/stack.ts
// AUTO_SUBTITLES_SERVICE_ID and the default runner in osc-auto-subtitles.ts.
//
// As with the ffprobe path we do NOT stream bytes through the API. We mint a
// short-lived presigned GET URL for the MinIO source object and hand that URL to
// the generator; the service reads it directly. The presigned URL is the only
// credential the service ever sees and it expires quickly, so a leaked URL has a
// small blast radius (mirrors the probe-URL / upload-URL TTL rationale).
//
// The OSC service call itself is injected as a `SubtitleGenerator` so it can be
// stubbed in tests and swapped without touching the orchestration logic, and so
// the un-contract-verified /transcribe/s3 wire shape stays isolated in exactly
// one place (osc-auto-subtitles.ts).
//
// Contract sources:
//   - eyevinn-auto-subtitles service (get-service-schema): Whisper-based
//     "Subtitle Generator"; create-service-instance config requires `name`
//     (^\w+$) and `openaikey`; optional awsAccessKeyId/awsSecretAccessKey/
//     awsRegion/s3Endpoint. Exposes a `/transcribe/s3` endpoint for S3 sources;
//     does NOT support config updates.
//   - SubtitleTrack shape (issue #18), src/data/asset-repo.ts:
//     { id, language, format: 'vtt'|'srt'|'ttml', objectKey?, label?, default? }

import { randomUUID } from 'node:crypto';
import type { AssetRepository, SubtitleFormat, SubtitleTrack } from '../data/asset-repo.js';
import type { WorkspaceStorage } from '../data/storage.js';

// TTL for the presigned GET URL handed to the subtitle generator. Short by
// design: the transcription reads the object once. Configurable via env.
export const DEFAULT_SUBTITLE_URL_TTL_SECONDS = 30 * 60; // 30 minutes

export function subtitleUrlTtlSeconds(): number {
  const raw = process.env['SUBTITLE_URL_TTL_SECONDS'];
  if (!raw) return DEFAULT_SUBTITLE_URL_TTL_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SUBTITLE_URL_TTL_SECONDS;
}

// Whisper output is typically WebVTT; default to 'vtt' unless overridden.
export const DEFAULT_SUBTITLE_FORMAT: SubtitleFormat = 'vtt';

// The result a `SubtitleGenerator` returns for one transcription.
//
// The generator MUST make the subtitle bytes available in one of two ways so
// the orchestrator can persist a SubtitleTrack whose objectKey resolves via the
// existing GET route:
//   - `written: true`  — the generator has already written the subtitle object
//     to `destinationKey` in the workspace bucket (e.g. the OSC service uploaded
//     directly to S3). The orchestrator only attaches the track.
//   - `content: <text>` — the generator returns the subtitle text/bytes and the
//     orchestrator uploads them to `destinationKey` before attaching the track.
// Exactly one of the two is expected; when both are present `written` wins.
export type SubtitleGeneratorResult = {
  // Whether the generator has already placed the object at destinationKey.
  written?: boolean;
  // Subtitle body to upload when the generator does not write it itself.
  content?: string;
  // Detected/declared language of the produced track (BCP-47, best-effort).
  language?: string;
  // Format actually produced, when it differs from the requested default.
  format?: SubtitleFormat;
};

// Parameters the orchestrator passes to the injected generator.
export type SubtitleGeneratorParams = {
  // Short-lived presigned GET URL of the source media in MinIO.
  presignedSourceUrl: string;
  // Workspace-local object key the subtitle file must end up at. The orchestrator
  // computes this from the asset id + track id so it matches the subtitle-track
  // GET route's convention exactly.
  destinationKey: string;
  // Requested subtitle format (default 'vtt').
  format: SubtitleFormat;
};

// Calls the OSC auto-subtitles service against a presigned source URL and either
// writes the subtitle object to destinationKey or returns its bytes. Injected so
// tests stub it and the OSC HTTP specifics stay in one place
// (osc-auto-subtitles.ts). Throws on a transport/service failure; the
// orchestrator turns that into a recorded error.
export type SubtitleGenerator = (params: SubtitleGeneratorParams) => Promise<SubtitleGeneratorResult>;

// Build the workspace-local object key for a generated subtitle track. Mirrors
// the POST /:id/subtitle-tracks route (routes/assets.ts) so the existing GET
// route resolves the file: `subtitles/<assetId>/<trackId>.<format>`.
export function subtitleObjectKey(assetId: string, trackId: string, format: SubtitleFormat): string {
  return `subtitles/${assetId}/${trackId}.${format}`;
}

export type GenerateSubtitlesParams = {
  assetId: string;
  objectKey: string;
  // BCP-47 language hint for the produced track when the generator does not
  // report one. Free-form, matching the SubtitleTrack.language field. Optional.
  language?: string;
  // Requested output format. Defaults to 'vtt' (typical Whisper output).
  format?: SubtitleFormat;
};

export type GenerateSubtitlesDeps = {
  assets: AssetRepository;
  storage: WorkspaceStorage;
  generate: SubtitleGenerator;
  // Injectable for tests; defaults to env-derived TTL.
  ttlSeconds?: number;
  // Test observability hook fired on a recorded failure.
  onError?: (err: unknown) => void;
};

// Run one subtitle generation to completion. NEVER throws: on any failure it
// records `subtitlesError` on the asset and resolves, so it is safe to invoke
// detached with `void generateSubtitles(...)` from the ingest path.
//
// On success: reads the asset, appends a SubtitleTrack whose objectKey is
// `subtitles/<assetId>/<trackId>.<format>`, and persists via assets.update
// (append-only; existing tracks are preserved). Clears any prior error.
// On failure: writes `subtitlesError` and leaves existing tracks untouched.
export async function generateSubtitles(
  params: GenerateSubtitlesParams,
  deps: GenerateSubtitlesDeps
): Promise<void> {
  const { assetId, objectKey } = params;
  const format = params.format ?? DEFAULT_SUBTITLE_FORMAT;
  try {
    const trackId = randomUUID();
    const destinationKey = subtitleObjectKey(assetId, trackId, format);
    const ttl = deps.ttlSeconds ?? subtitleUrlTtlSeconds();
    const presignedSourceUrl = await deps.storage.presignedGet(objectKey, ttl);

    const result = await deps.generate({ presignedSourceUrl, destinationKey, format });

    // Format the generator actually produced (falls back to the requested one).
    const producedFormat = result.format ?? format;
    // Recompute the key if the generator reported a different format so the key
    // extension stays consistent with the persisted track.
    const finalKey =
      producedFormat === format ? destinationKey : subtitleObjectKey(assetId, trackId, producedFormat);

    // When the generator returned bytes rather than writing the object itself,
    // upload them to the destination key via a presigned PUT so the GET route
    // resolves the file.
    if (!result.written) {
      if (result.content === undefined) {
        throw new Error('subtitle generator returned neither a written object nor content');
      }
      const putUrl = await deps.storage.presignedPut(finalKey, ttl);
      const res = await fetch(putUrl, {
        method: 'PUT',
        headers: { 'content-type': subtitleContentType(producedFormat) },
        body: result.content
      });
      if (!res.ok) {
        throw new Error(`subtitle upload failed: HTTP ${res.status}`);
      }
    }

    // Read → append → persist. Append-only so we never clobber tracks that were
    // added manually via the API. If the asset vanished between ingest and now
    // there is nothing to attach to; treat as a no-op success.
    const asset = await deps.assets.get(assetId);
    if (!asset) return;

    const track: SubtitleTrack = {
      id: trackId,
      language: result.language ?? params.language ?? 'und',
      format: producedFormat,
      objectKey: finalKey,
      label: 'Auto-generated'
    };
    const subtitleTracks = [...(asset.subtitleTracks ?? []), track];
    // Generation annotates the asset only; it never drives the lifecycle state
    // machine (the ingest/transcode paths own status transitions).
    await deps.assets.update(assetId, { subtitleTracks, subtitlesError: null });
  } catch (err) {
    deps.onError?.(err);
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort error recording. If even this write fails there is nothing more
    // we can do from a detached task; we still must not throw. A missing subtitle
    // track is not fatal and never changes the asset's lifecycle state.
    try {
      await deps.assets.update(assetId, { subtitlesError: message });
    } catch {
      // Swallow: the detached caller has no error channel.
    }
  }
}

// Map a subtitle format to a sensible Content-Type for the presigned PUT upload
// path. Kept local to this module; the OSC service's own upload (the `written`
// path) sets its own headers.
function subtitleContentType(format: SubtitleFormat): string {
  switch (format) {
    case 'vtt':
      return 'text/vtt';
    case 'srt':
      return 'application/x-subrip';
    case 'ttml':
      return 'application/ttml+xml';
    default:
      return 'text/plain';
  }
}
