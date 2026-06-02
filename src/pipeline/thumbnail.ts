// Thumbnail / poster-frame extraction pipeline (issue #7).
//
// Given a stored video object and a list of timecodes (seconds), extract one
// JPEG frame per timecode and store each under the asset's thumbnail prefix in
// MinIO as `<assetId>/thumb_<t>s.jpg`. The extracted object keys are returned
// and recorded on the asset document as `thumbnails: string[]`.
//
// OSC wiring (mirrors issue #6's ffprobe pipeline): a single ephemeral
// eyevinn-ffmpeg-s3 job seeks to each timecode and writes a frame. The service
// downloads an HTTPS source and uploads outputs back to S3, so we hand it a
// short-lived presigned GET URL for the source and a presigned PUT URL per
// frame. The actual OSC job dispatch is injected as a `FrameExtractor` so the
// orchestration/storage logic here stays testable and OSC specifics live in
// osc-thumbnail.ts.
//
// Unlike metadata extraction this is NOT fire-and-forget from a detached path:
// the route awaits it and reports success/failure to the caller. It is still
// idempotent — re-running for the same timecodes overwrites the same keys.

import type { AssetRepository } from '../data/asset-repo.js';
import type { WorkspaceStorage } from '../data/storage.js';

// TTL for the presigned source GET + frame PUT URLs handed to the runner. Short
// by design: the job reads the source and writes frames once, immediately.
export const DEFAULT_THUMBNAIL_URL_TTL_SECONDS = 10 * 60; // 10 minutes

export function thumbnailUrlTtlSeconds(): number {
  const raw = process.env['THUMBNAIL_URL_TTL_SECONDS'];
  if (!raw) return DEFAULT_THUMBNAIL_URL_TTL_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_THUMBNAIL_URL_TTL_SECONDS;
}

// One frame to extract: the source timecode (seconds) and the destination it
// must be written to, expressed both as a presigned PUT URL (for the runner to
// write to) and as the object key (for recording on the asset).
export type FrameTarget = {
  timecodeSeconds: number;
  // Object key recorded on the asset document.
  objectKey: string;
  // Presigned PUT URL the FrameExtractor writes the JPEG to.
  putUrl: string;
};

// Calls the OSC ffmpeg runner: seek to each frame's timecode in the source and
// upload the resulting JPEG to its presigned PUT URL. Injected so tests stub it
// and the OSC specifics stay in one place (osc-thumbnail.ts). Throws on a
// runner/transport failure; the orchestrator surfaces that to the caller.
export type FrameExtractor = (sourceUrl: string, frames: FrameTarget[]) => Promise<void>;

// Round a timecode to an integer second for the object key suffix so the same
// requested timecode always maps to the same key (idempotent re-runs).
export function frameKeySuffix(timecodeSeconds: number): string {
  return `${Math.max(0, Math.round(timecodeSeconds))}s`;
}

export function thumbnailObjectKey(assetId: string, timecodeSeconds: number): string {
  return `thumbnails/${assetId}/thumb_${frameKeySuffix(timecodeSeconds)}.jpg`;
}

export type ExtractThumbnailsParams = {
  workspaceId: string;
  assetId: string;
  objectKey: string;
  timecodes: number[];
};

export type ExtractThumbnailsDeps = {
  assets: AssetRepository;
  storage: WorkspaceStorage;
  extractor: FrameExtractor;
  // Injectable for tests; defaults to env-derived TTL.
  ttlSeconds?: number;
};

// Run one thumbnail extraction to completion and return the stored object keys.
// Deduplicates timecodes by their rounded key suffix so a caller cannot request
// the same frame twice. THROWS on failure (the route maps it to a 502) — but
// only after leaving any prior `thumbnails` on the asset untouched, so a failed
// run never erases an earlier successful one.
export async function extractThumbnails(
  params: ExtractThumbnailsParams,
  deps: ExtractThumbnailsDeps
): Promise<string[]> {
  const { workspaceId, assetId, objectKey, timecodes } = params;
  const ttl = deps.ttlSeconds ?? thumbnailUrlTtlSeconds();

  const seen = new Set<string>();
  const unique: number[] = [];
  for (const t of timecodes) {
    const suffix = frameKeySuffix(t);
    if (seen.has(suffix)) continue;
    seen.add(suffix);
    unique.push(t);
  }
  unique.sort((a, b) => a - b);

  const sourceUrl = await deps.storage.presignedGet(objectKey, ttl);

  // Object keys recorded on the asset. No workspace prefix: OSC provides
  // structural tenant isolation (ADR-003), so the deployment owns a single
  // bucket namespace.
  const keys = unique.map((t) => thumbnailObjectKey(assetId, t));

  // Each frame carries a presigned PUT URL the extractor writes the JPEG to.
  const frames: FrameTarget[] = await Promise.all(
    unique.map(async (timecodeSeconds, i) => ({
      timecodeSeconds,
      objectKey: keys[i],
      putUrl: await deps.storage.presignedPut(keys[i], ttl)
    }))
  );

  // One extraction call covers every requested frame.
  await deps.extractor(sourceUrl, frames);

  await deps.assets.update(workspaceId, assetId, { thumbnails: keys });
  return keys;
}
