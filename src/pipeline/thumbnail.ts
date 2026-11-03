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
// issue #1303: behind `THUMBNAIL_MULTI_SIZE` (default OFF) each timecode also
// gets a 1280px-wide and a 360px-wide variant at `thumb_<t>s_1280.jpg` /
// `thumb_<t>s_360.jpg`, so a list view can fetch a few KB instead of a full
// 3840x2160 frame. The full-size key and `thumbnails[]` index meaning do NOT
// change; the variants that landed are recorded separately as `thumbnailSizes`.
// Each variant is verified with the same `statObject` check as the full frame,
// so a partial result records exactly what exists. With the flag off this file
// behaves exactly as it did before #1303.
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

// Multi-size extraction (issue #1303). OFF by default: with the flag unset the
// orchestrator builds exactly the same single-destination frames it always has,
// dispatches exactly the same jobs, and writes exactly the same patch — the
// scaled code paths below are not entered at all. Mirrors the
// `WATCH_FOLDER_ENABLED === 'true'` convention (src/pipeline/watch-folder.ts:69).
export function thumbnailMultiSizeEnabled(): boolean {
  return process.env['THUMBNAIL_MULTI_SIZE'] === 'true';
}

export type ThumbnailSizeVariant = 'small' | 'medium';

// The scaled variants extracted alongside the full frame when
// THUMBNAIL_MULTI_SIZE is on. `width` is the target width in pixels; height is
// always derived by ffmpeg (`scale=<width>:-2`, even-height constrained) so the
// source aspect ratio is preserved and no cropping happens. `quality` is the
// mjpeg encoder's `-q:v` (2 = best, 31 = worst): the scaled outputs get an
// EXPLICIT value because a list view wants a few KB, while the full frame's
// quality is deliberately left untouched (out of scope per #1303).
export const THUMBNAIL_SIZE_VARIANTS: ReadonlyArray<{
  variant: ThumbnailSizeVariant;
  width: number;
  quality: number;
}> = [
  { variant: 'medium', width: 1280, quality: 4 },
  { variant: 'small', width: 360, quality: 6 }
];

// One frame to extract: the source timecode (seconds) and the destination it
// must be written to, expressed both as a presigned PUT URL (for the runner to
// write to) and as the object key (for recording on the asset).
export type FrameTarget = {
  timecodeSeconds: number;
  // Object key recorded on the asset document.
  objectKey: string;
  // Presigned PUT URL the FrameExtractor writes the JPEG to.
  putUrl: string;
  // Scaled variants to derive from this frame (issue #1303). ABSENT entirely
  // when THUMBNAIL_MULTI_SIZE is off, so the flag-off frame objects handed to
  // the extractor are byte-identical to the pre-#1303 ones. An extractor that
  // does not understand the field simply writes the full frame as before, and
  // the orchestrator's storage verification then records no scaled sizes.
  scaled?: ScaledFrameTarget[];
};

// One scaled variant derived from a full frame (issue #1303).
export type ScaledFrameTarget = {
  variant: ThumbnailSizeVariant;
  // Target width in pixels; height derived as `scale=<width>:-2`.
  width: number;
  // mjpeg `-q:v` for this variant (explicit — see THUMBNAIL_SIZE_VARIANTS).
  quality: number;
  // Object key recorded on the asset document when the object is confirmed.
  objectKey: string;
};

// A scaled thumbnail that was CONFIRMED written to storage, recorded on the
// asset as `thumbnailSizes` (issue #1303). `fullObjectKey` is the entry in
// `thumbnails[]` this variant was derived from, so a client can map a thumbnail
// index to its smaller renditions without the index meaning changing.
export type ThumbnailSizeRecord = {
  fullObjectKey: string;
  variant: ThumbnailSizeVariant;
  width: number;
  objectKey: string;
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

// Key for a scaled variant of the frame at `timecodeSeconds` (issue #1303):
// the full-size key with a `_<width>` suffix before the extension, e.g.
// `thumbnails/<id>/thumb_30s_360.jpg`. The full-size key itself is UNCHANGED,
// so pre-#1303 assets and the flag-off path keep their exact key shape.
export function scaledThumbnailObjectKey(
  assetId: string,
  timecodeSeconds: number,
  width: number
): string {
  return `thumbnails/${assetId}/thumb_${frameKeySuffix(timecodeSeconds)}_${width}.jpg`;
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
  // Injectable for tests; defaults to the env flag (issue #1303). When false
  // (the default) NOTHING about this function's behaviour changes from #332.
  multiSize?: boolean;
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

  // Multi-size extraction (issue #1303). Resolved ONCE here so a single run is
  // internally consistent even if the env changes mid-flight.
  const multiSize = deps.multiSize ?? thumbnailMultiSizeEnabled();

  // Each frame carries its own destination: a distinct object key (also handed
  // as a presigned PUT URL for extractors that write over HTTP). Distinct keys
  // mean no frame overwrites another (issue #332).
  //
  // With THUMBNAIL_MULTI_SIZE on, each frame also carries its scaled variants,
  // each with its OWN distinct key — same no-overwrite property as #332, one
  // output object per extraction. With the flag off the `scaled` property is not
  // set at all (issue #1303).
  const frames: FrameTarget[] = await Promise.all(
    unique.map(async (timecodeSeconds, i) => ({
      timecodeSeconds,
      objectKey: keys[i],
      putUrl: await deps.storage.presignedPut(keys[i], ttl),
      ...(multiSize
        ? {
            scaled: THUMBNAIL_SIZE_VARIANTS.map((size) => ({
              variant: size.variant,
              width: size.width,
              quality: size.quality,
              objectKey: scaledThumbnailObjectKey(assetId, timecodeSeconds, size.width)
            }))
          }
        : {})
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

  // With the flag off this is the pre-#1303 patch, unchanged: `thumbnails` only.
  if (!multiSize) {
    await deps.assets.update(assetId, { thumbnails: storedKeys });
    return storedKeys;
  }

  // Multi-size (issue #1303): verify each scaled object the SAME way as the full
  // frames — `statObject` per key, record only what exists. A size whose job
  // failed (or whose extractor ignored `scaled` altogether) is simply absent, so
  // `thumbnailSizes` can never name an object a client would 404/500 on. Sizes
  // are only considered for frames whose FULL object landed: an entry is
  // meaningless without the `thumbnails[]` key it hangs off.
  const stored = new Set(storedKeys);
  const sizes: ThumbnailSizeRecord[] = [];
  for (const frame of frames) {
    if (!stored.has(frame.objectKey)) continue;
    for (const size of frame.scaled ?? []) {
      const stat = await deps.storage.statObject(size.objectKey);
      if (!stat) continue;
      sizes.push({
        fullObjectKey: frame.objectKey,
        variant: size.variant,
        width: size.width,
        objectKey: size.objectKey
      });
    }
  }

  // `thumbnails` is replaced wholesale by every run, so the size list is too —
  // an empty list is written as "no sizes landed" rather than left stale from a
  // previous run (the repo stores an empty list as absence).
  await deps.assets.update(assetId, { thumbnails: storedKeys, thumbnailSizes: sizes });
  return storedKeys;
}
