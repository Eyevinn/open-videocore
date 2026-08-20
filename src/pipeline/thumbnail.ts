// Thumbnail / poster-frame extraction pipeline (issue #7, #332).
//
// Given a stored video object and a list of timecodes (seconds), extract one
// JPEG frame per timecode and store each under the asset's thumbnail prefix in
// MinIO as `<assetId>/thumb_<t>s.jpg`. Each timecode is written to its OWN
// distinct object key; the keys of the images CONFIRMED written are returned and
// recorded on the asset document as `thumbnails: string[]`.
//
// OSC wiring (mirrors issue #6's ffprobe pipeline): an ephemeral
// eyevinn-ffmpeg-s3 job seeks to a timecode and writes a frame. The service
// downloads an HTTPS source and uploads outputs back to S3, so we hand it a
// short-lived presigned GET URL for the source and write each frame to its own
// `s3://bucket/<objectKey>`. The actual OSC job dispatch is injected as a
// `FrameExtractor` so the orchestration/storage logic here stays testable and
// OSC specifics live in osc-thumbnail.ts.
//
// issue #332: a request with several timecodes previously routed every frame
// through a single ffmpeg invocation (one `cmdLineArgs` string with multiple
// `-i`/output pairs). ffmpeg's multi-input/multi-output-file semantics meant
// only the LAST output object was actually written (last-write-wins), yet the
// asset document recorded ALL keys unconditionally — so reading any earlier
// thumbnail back 500'd on a NoSuchKey the client had no way to anticipate. The
// fix is twofold: (1) the extractor writes each timecode to its OWN key with an
// independent per-frame job so nothing overwrites, and (2) after extraction we
// VERIFY each object exists in storage and record ONLY the keys confirmed
// written — never a key for an image that was not stored.
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
// write the resulting JPEG to that frame's OWN distinct destination
// (`objectKey`). Each frame is an independent extraction, so one frame failing
// must not prevent the others from being written (issue #332 — no last-write-
// wins across frames). Injected so tests stub it and the OSC specifics stay in
// one place (osc-thumbnail.ts). A whole-batch runner/transport failure throws;
// the orchestrator verifies which frames actually landed regardless.
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

// Run one thumbnail extraction to completion and return the object keys of the
// images CONFIRMED written to storage. Deduplicates timecodes by their rounded
// key suffix so a caller cannot request the same frame twice.
//
// issue #332: each timecode is extracted to its OWN distinct key, and only keys
// verified to exist in storage after extraction are recorded on the asset. A key
// is NEVER recorded for an image that was not stored. If none of the requested
// frames landed, this THROWS (the route maps it to a 502) — but only after
// leaving any prior `thumbnails` on the asset untouched, so a failed run never
// erases an earlier successful one. A partial success records exactly the stored
// subset and returns it, so a client's follow-up read can never 500 on a
// NoSuchKey for a listed key.
export async function extractThumbnails(
  params: ExtractThumbnailsParams,
  deps: ExtractThumbnailsDeps
): Promise<string[]> {
  const { assetId, objectKey, timecodes } = params;
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

  // One distinct object key per requested frame. No workspace prefix: OSC
  // provides structural tenant isolation (ADR-003), so the deployment owns a
  // single bucket namespace.
  const keys = unique.map((t) => thumbnailObjectKey(assetId, t));

  // Each frame carries its own destination: a distinct object key (also handed
  // as a presigned PUT URL for extractors that write over HTTP). Distinct keys
  // mean no frame overwrites another (issue #332).
  const frames: FrameTarget[] = await Promise.all(
    unique.map(async (timecodeSeconds, i) => ({
      timecodeSeconds,
      objectKey: keys[i],
      putUrl: await deps.storage.presignedPut(keys[i], ttl)
    }))
  );

  // Dispatch extraction. The extractor writes each frame to its own key. A
  // whole-batch transport failure may throw; we still verify below so a partial
  // batch is not lost, and a total failure surfaces as "no keys stored".
  let extractionError: unknown;
  try {
    await deps.extractor(sourceUrl, frames);
  } catch (err) {
    extractionError = err;
  }

  // Record ONLY the keys whose objects actually exist in storage. `statObject`
  // returns undefined for a missing key, so an image that was never written is
  // never recorded on the asset — closing the gap where the document listed keys
  // that 500'd on read (issue #332).
  const storedKeys: string[] = [];
  for (const key of keys) {
    const stat = await deps.storage.statObject(key);
    if (stat) storedKeys.push(key);
  }

  // Nothing landed: surface a failure to the caller (route -> 502) and leave any
  // prior thumbnails on the asset untouched.
  if (storedKeys.length === 0) {
    if (extractionError instanceof Error) throw extractionError;
    if (extractionError !== undefined) throw new Error(String(extractionError));
    throw new Error('thumbnail extraction produced no stored images');
  }

  await deps.assets.update(assetId, { thumbnails: storedKeys });
  return storedKeys;
}
