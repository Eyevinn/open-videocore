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
  // Frame rate, as a RATIONAL string ("30000/1001", "25/1") — ffprobe never
  // reports it as a number (issue #1066). `r_frame_rate` is the stream's base
  // rate and is preferred; `avg_frame_rate` is the average over the decoded
  // frames and is the fallback, because a stream with a variable rate can report
  // `r_frame_rate: "0/0"`.
  r_frame_rate?: string | number;
  avg_frame_rate?: string | number;
  // Stream-level metadata tags. The only one we consume is `timecode` — the
  // source's start timecode, carried on the video stream or on a companion
  // timecode track depending on the container.
  tags?: Record<string, string | number | undefined>;
};

export type FfprobeFormat = {
  format_name?: string;
  duration?: string | number;
  bit_rate?: string | number;
  // Container-level metadata tags. Some containers carry the start timecode here
  // instead of on a stream.
  tags?: Record<string, string | number | undefined>;
};

export type FfprobeResult = {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
};

// An external-backend source the probe job reads directly (issue #548): the
// ffmpeg-s3 job body carries the registered backend's endpoint + credential
// references and probes `s3://bucket/key` in place, instead of a presigned GET
// URL against OSC-managed storage. The two secret fields are `{{secrets.<name>}}`
// REFERENCES (never literals — issue #548 acceptance), resolved by OSC at job
// time. Shape verified against ffmpegS3CredentialMapping
// (external-storage-credentials.ts:155-180) and the ffmpeg-s3 job body
// (osc-thumbnail.ts:69-75 / osc-rewrap.ts:16-18).
export type ExternalProbeSource = {
  bucket: string;
  objectKey: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string; // `{{secrets.<name>}}` reference
  s3EndpointUrl?: string;
  awsRegion?: string;
  awsSessionToken?: string; // `{{secrets.<name>}}` reference
};

// Calls the OSC ffprobe runner and returns the parsed ffprobe JSON. Injected so
// tests stub it and the OSC specifics stay in one place (osc-ffprobe.ts). Throws
// on a runner/transport failure; the orchestrator turns that into a recorded
// error.
//
// Called two ways:
//   - default (OSC-managed) source: a presigned GET URL string;
//   - external-backend source (issue #548): an ExternalProbeSource, so the job
//     reads `s3://bucket/key` in place using the registered credentials.
export type ProbeRunner = (
  source: string | ExternalProbeSource
) => Promise<FfprobeResult>;

function toNumber(value: string | number | undefined): number {
  if (value === undefined || value === null) return 0;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

// Parse one ffprobe frame-rate field (issue #1066).
//
// ffprobe reports frame rate as a rational STRING — "25/1", "30000/1001" — so a
// plain Number() on it yields NaN for every non-integer rate. We divide and round
// to three decimals so 30000/1001 reads as 29.97 rather than 29.970029970029972,
// which is the precision a frame-stepping client needs and no more.
//
// Returns undefined (field stays absent) rather than 0 for anything unusable:
// a missing field, "N/A", a zero/absent denominator, or ffprobe's "0/0" for a
// stream with no meaningful rate. Reporting 0 fps would be a wrong answer a
// client cannot distinguish from a real one.
export function parseFrameRate(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? roundRate(value) : undefined;
  }
  const [numerator, denominator = '1'] = value.trim().split('/');
  const n = Number.parseFloat(numerator ?? '');
  const d = Number.parseFloat(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n <= 0) return undefined;
  return roundRate(n / d);
}

function roundRate(rate: number): number {
  return Math.round(rate * 1000) / 1000;
}

// The source's start timecode (issue #1066), e.g. "01:00:00:00". Where it lives
// depends on the container: on the video stream's tags, on the container's format
// tags, or on a companion timecode track with no video of its own. We take the
// first of those that carries a non-empty `timecode` tag and leave the field
// absent when none does — a source without a start timecode is normal.
export function parseStartTimecode(
  streams: FfprobeStream[],
  format: FfprobeFormat,
  video: FfprobeStream | undefined
): string | undefined {
  const candidates = [video?.tags?.['timecode'], format.tags?.['timecode']];
  for (const s of streams) {
    candidates.push(s.tags?.['timecode']);
  }
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const timecode = String(candidate).trim();
    if (timecode) return timecode;
  }
  return undefined;
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

  // Frame rate + start timecode (issue #1066), both OPTIONAL and both omitted
  // when the source does not carry them — an audio-only source has no video
  // stream to read a rate off, and most sources carry no start timecode.
  const frameRate =
    parseFrameRate(video?.r_frame_rate) ?? parseFrameRate(video?.avg_frame_rate);
  const startTimecode = parseStartTimecode(streams, format, video);

  return {
    codec: video?.codec_name ?? 'unknown',
    width: toNumber(video?.width),
    height: toNumber(video?.height),
    durationSeconds,
    bitrateBps,
    containerFormat: format.format_name ?? 'unknown',
    audioTracks,
    extractedAt: now,
    ...(frameRate !== undefined ? { frameRate } : {}),
    ...(startTimecode !== undefined ? { startTimecode } : {})
  };
}

export type ExtractParams = {
  assetId: string;
  objectKey: string;
  // When present (issue #548), the source bytes live in a registered external
  // backend, NOT OSC-managed storage. The extractor then hands the probe runner
  // this external source (job reads `s3://bucket/key` in place) instead of
  // minting a presigned GET URL against WorkspaceStorage. The credentials are
  // `{{secrets.<name>}}` references — never literals.
  externalSource?: ExternalProbeSource;
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
  const { assetId, objectKey, externalSource } = params;
  try {
    // External-backend source (issue #548): the probe job reads the object in
    // place from the registered external bucket; no presigned GET against
    // OSC-managed storage is minted. Otherwise the default path mints a
    // short-lived presigned GET URL for the OSC-managed object.
    let result: FfprobeResult;
    if (externalSource) {
      result = await deps.probe(externalSource);
    } else {
      const ttl = deps.ttlSeconds ?? probeUrlTtlSeconds();
      const presignedUrl = await deps.storage.presignedGet(objectKey, ttl);
      result = await deps.probe(presignedUrl);
    }
    const metadata = parseFfprobe(result, new Date().toISOString());
    // Re-drive recovery (issue #281): if the asset is wedged in `processing`
    // (typically because a prior extraction recorded `technicalMetadataError`
    // and never advanced), a successful extraction completes the lifecycle by
    // advancing `processing -> ready`. For any other status we annotate only and
    // never force a transition: `ready` stays `ready` (idempotent no-op) and an
    // asset still `uploading` is left for the ingest path to advance, so the
    // extractor never drives an illegal transition (e.g. uploading -> ready).
    // Writing a non-null `technicalMetadata` clears any prior
    // `technicalMetadataError` at the repository boundary (asset-repo.ts).
    const current = await deps.assets.get(assetId);
    const advance = current?.status === 'processing';
    await deps.assets.update(assetId, {
      technicalMetadata: metadata,
      ...(advance ? { status: 'ready' as const } : {})
    });
  } catch (err) {
    deps.onError?.(err);
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort error recording. If even this write fails there is nothing
    // more we can do from a detached task; we still must not throw. A missing
    // probe result is not fatal and never changes the asset's lifecycle state.
    try {
      await deps.assets.update(assetId, {
        technicalMetadata: null,
        technicalMetadataError: message
      });
    } catch {
      // Swallow: the detached caller has no error channel.
    }
  }
}
