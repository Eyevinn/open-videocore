// Technical metadata extraction pipeline (issue #6).
//
// After an asset's payload lands in MinIO, an ephemeral ffprobe job runs
// against the stored object and the result is written back onto the asset
// document. Extraction is FIRE-AND-FORGET from the ingest path: it must never
// block the ingest response and must never throw into a detached caller, so
// `extractTechnicalMetadata` swallows every error and records it on the asset
// as `technicalMetadataError` (leaving `technicalMetadata: null`).
//
// OSC wiring: the probe runs on eyevinn-ffmpeg-s3, an ephemeral ffprobe runner
// (see services/stack.ts FFPROBE_SERVICE_ID). We do NOT stream bytes through
// the API. Instead we mint a short-lived presigned GET URL for the MinIO object
// and hand that URL to the service; ffprobe reads it directly. The presigned
// URL is the only credential the service ever sees and it expires quickly, so a
// leaked URL has a small blast radius (mirrors the upload-URL TTL rationale).
//
// The OSC service call itself is injected as a `ProbeRunner` so it can be
// stubbed in tests and swapped without touching the parsing/orchestration
// logic. The default runner lives in osc-ffprobe.ts.

import type { AssetRepository, AudioTrack, TechnicalMetadata } from '../data/asset-repo.js';
import type { WorkspaceStorage } from '../data/storage.js';

// TTL for the presigned GET URL handed to the ffprobe runner. Short by design:
// the probe job reads the object once, immediately. Configurable via env.
export const DEFAULT_PROBE_URL_TTL_SECONDS = 10 * 60; // 10 minutes

export function probeUrlTtlSeconds(): number {
  const raw = process.env['PROBE_URL_TTL_SECONDS'];
  if (!raw) return DEFAULT_PROBE_URL_TTL_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROBE_URL_TTL_SECONDS;
}

// The subset of ffprobe's `-show_format -show_streams` JSON we consume. Kept
// permissive (all fields optional) because ffprobe output varies by container
// and codec; the parser defends every field.
export type FfprobeStream = {
  index?: number;
  codec_type?: string; // 'video' | 'audio' | 'subtitle' | ...
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: string | number;
  bit_rate?: string | number;
  duration?: string | number;
};

export type FfprobeFormat = {
  format_name?: string;
  duration?: string | number;
  bit_rate?: string | number;
};

export type FfprobeResult = {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
};

// Calls the OSC ffprobe runner against a presigned source URL and returns the
// parsed ffprobe JSON. Injected so tests stub it and the OSC specifics stay in
// one place (osc-ffprobe.ts). Throws on a runner/transport failure; the
// orchestrator turns that into a recorded error.
export type ProbeRunner = (presignedUrl: string) => Promise<FfprobeResult>;

function toNumber(value: string | number | undefined): number {
  if (value === undefined || value === null) return 0;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

// Map raw ffprobe output onto our TechnicalMetadata shape. Picks the first
// video stream for the primary codec/resolution; collects every audio stream
// into `audioTracks`. Falls back to format-level duration/bitrate when the
// video stream omits them (common for some containers).
export function parseFfprobe(result: FfprobeResult, now: string): TechnicalMetadata {
  const streams = result.streams ?? [];
  const format = result.format ?? {};

  const video = streams.find((s) => s.codec_type === 'video');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');

  const audioTracks: AudioTrack[] = audioStreams.map((s, i) => ({
    index: s.index ?? i,
    codec: s.codec_name ?? 'unknown',
    channels: toNumber(s.channels),
    sampleRateHz: toNumber(s.sample_rate)
  }));

  const durationSeconds = toNumber(video?.duration ?? format.duration);
  const bitrateBps = toNumber(format.bit_rate ?? video?.bit_rate);

  return {
    codec: video?.codec_name ?? 'unknown',
    width: toNumber(video?.width),
    height: toNumber(video?.height),
    durationSeconds,
    bitrateBps,
    containerFormat: format.format_name ?? 'unknown',
    audioTracks,
    extractedAt: now
  };
}

export type ExtractParams = {
  workspaceId: string;
  assetId: string;
  objectKey: string;
};

export type ExtractDeps = {
  assets: AssetRepository;
  storage: WorkspaceStorage;
  probe: ProbeRunner;
  // Injectable for tests; defaults to env-derived TTL.
  ttlSeconds?: number;
  // Test observability hook fired on a recorded failure.
  onError?: (err: unknown) => void;
};

// Run one extraction to completion. NEVER throws: on any failure it records
// `technicalMetadataError` on the asset and resolves, so it is safe to invoke
// detached with `void extractTechnicalMetadata(...)` from the ingest path.
//
// On success: writes `technicalMetadata` (which clears any prior error).
// On failure: writes `technicalMetadata: null` + `technicalMetadataError`.
export async function extractTechnicalMetadata(
  params: ExtractParams,
  deps: ExtractDeps
): Promise<void> {
  const { workspaceId, assetId, objectKey } = params;
  try {
    const ttl = deps.ttlSeconds ?? probeUrlTtlSeconds();
    const presignedUrl = await deps.storage.presignedGet(objectKey, ttl);
    const result = await deps.probe(presignedUrl);
    const metadata = parseFfprobe(result, new Date().toISOString());
    await deps.assets.update(workspaceId, assetId, { technicalMetadata: metadata });
  } catch (err) {
    deps.onError?.(err);
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort error recording. If even this write fails there is nothing
    // more we can do from a detached task; we still must not throw.
    try {
      await deps.assets.update(workspaceId, assetId, {
        technicalMetadata: null,
        technicalMetadataError: message
      });
    } catch {
      // Swallow: the detached caller has no error channel.
    }
  }
}
