// Clip / trim pipeline (issue #17).
//
// Given a stored video object and a time window [startSeconds, endSeconds),
// extract that segment into a NEW child asset whose objectKey is
// `<workspaceId>/clips/<newAssetId>.mp4`. The clip inherits the source asset's
// workspaceId and points back to it via `parentId`.
//
// OSC wiring (mirrors the export / re-wrap pipeline, issue #19/#316): a single
// ephemeral eyevinn-ffmpeg-s3 job seeks to the window and stream-copies it out.
// The service downloads an HTTPS source and writes its output to S3 natively, so
// we hand it a short-lived presigned GET URL for the source and the destination
// OBJECT KEY — never a presigned PUT URL, which ffmpeg cannot mux an MP4 to
// (issue #786; same failure already fixed for thumbnails in #92 and re-wrap in
// #316). The actual OSC job dispatch is injected as a `ClipRunner` (same
// narrow-interface pattern as `FrameExtractor`) so the orchestration/storage
// logic here stays testable and OSC specifics live in osc-clip.ts.
//
// The route AWAITS this (like thumbnails, unlike fire-and-forget metadata): the
// new child asset is created in `processing`, the job runs, the written object
// is VERIFIED to exist and be non-empty, and only then does the child get its
// objectKey and advance to `ready`. On runner failure — or when the runner
// reports success but no object landed — the child is marked `failed` and the
// error is rethrown so the route can surface a 502.

import {
  resolveVersionLinkage,
  type AssetRepository,
  type Asset,
  type TechnicalMetadata
} from '../data/asset-repo.js';
import type { WorkspaceStorage } from '../data/storage.js';

// TTL for the presigned source GET URL handed to the runner. Short by design:
// the job reads the source once, immediately. The clip OUTPUT is written
// natively to `s3://bucket/key` by the runner, so no PUT URL is minted.
export const DEFAULT_CLIP_URL_TTL_SECONDS = 10 * 60; // 10 minutes

export function clipUrlTtlSeconds(): number {
  const raw = process.env['CLIP_URL_TTL_SECONDS'];
  if (!raw) return DEFAULT_CLIP_URL_TTL_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLIP_URL_TTL_SECONDS;
}

// Calls the OSC ffmpeg runner: seek to [start, end) in the source and write the
// resulting clip to `s3://<bucket>/<outputKey>`. The runner receives the
// destination OBJECT KEY (not a presigned PUT URL — ffmpeg cannot write an MP4
// to an HTTPS PUT endpoint, issue #786) and builds the S3 URI from the bucket
// baked into it at construction. Injected so tests stub it and the OSC specifics
// stay in one place (osc-clip.ts). Throws on a runner/transport failure or a
// non-success job status; the orchestrator surfaces that to the caller. A
// resolved runner is NOT proof the object was written — see the verification in
// clip() below.
export type ClipRunner = (
  sourceUrl: string,
  outputKey: string,
  startSeconds: number,
  endSeconds: number
) => Promise<void>;

// Workspace-local object key for a produced clip. Mirrors thumbnailObjectKey.
export function clipObjectKey(assetId: string): string {
  return `clips/${assetId}.mp4`;
}

export type ClipParams = {
  sourceAssetId: string;
  objectKey: string;
  startSeconds: number;
  endSeconds: number;
  outputName?: string;
  // Version-chain linkage (issue #118). When true, the clip output is recorded
  // as a VERSION of the source asset (versionOfAssetId + shared versionGroupId)
  // in addition to being a parentId child. When false/undefined the behavior is
  // UNCHANGED — a plain parentId child with no version linkage — so existing
  // callers keep today's disconnected-sibling semantics.
  asVersion?: boolean;
};

export type ClipDeps = {
  assets: AssetRepository;
  storage: WorkspaceStorage;
  runner: ClipRunner;
  // Injectable for tests; defaults to env-derived TTL.
  ttlSeconds?: number;
};

// Technical metadata for a produced clip (issue #786: the child asset must
// report the duration of the requested range, not the source's duration and not
// nothing at all).
//
// `-c copy` stream-copies the source's elementary streams, so codec, resolution
// and audio layout are inherited verbatim from the source's probed metadata when
// it has any; unknown values use the same placeholders the ffprobe parser emits
// (`'unknown'` / 0 — see metadata-extractor.ts:parseFfprobe). The container is
// always MP4 because clipObjectKey writes a `.mp4` key. `durationSeconds` is the
// REQUESTED window; a stream copy snaps the cut to the nearest keyframe, so a
// later ffprobe extraction may refine it by a fraction of a second. The bitrate
// is computed from the object's measured size over that window rather than
// inherited, so it describes the clip and not the source.
export function clipTechnicalMetadata(
  source: Asset | undefined,
  startSeconds: number,
  endSeconds: number,
  sizeBytes: number,
  now: string
): TechnicalMetadata {
  const durationSeconds = Math.max(0, endSeconds - startSeconds);
  const probed = source?.technicalMetadata ?? undefined;
  return {
    codec: probed?.codec ?? 'unknown',
    width: probed?.width ?? 0,
    height: probed?.height ?? 0,
    durationSeconds,
    bitrateBps: durationSeconds > 0 ? Math.round((sizeBytes * 8) / durationSeconds) : 0,
    containerFormat: 'mp4',
    audioTracks: probed?.audioTracks ?? [],
    extractedAt: now
  };
}

// Run one clip extraction to completion and return the new child asset.
//
// Flow: create the child asset (parentId = source) and advance it to
// `processing`; presign the source GET URL; dispatch the ffmpeg job (which
// writes natively to `s3://bucket/<destKey>`); VERIFY the written object exists
// and is non-empty; record the objectKey plus the clip's duration and advance
// the child to `ready`.
//
// THROWS on a runner failure — OR when the runner resolves but no object landed
// (issue #786: eyevinn-ffmpeg-s3 can report a terminal status the poller does not
// classify as a failure while ffmpeg wrote nothing) — after marking the child
// `failed`. The route maps that to a 502 and the child record preserves the
// failure for inspection; it never reaches `ready` and never carries an
// objectKey for an object that would answer NoSuchKey.
export async function clip(params: ClipParams, deps: ClipDeps): Promise<Asset> {
  const { sourceAssetId, objectKey, startSeconds, endSeconds, outputName, asVersion } = params;
  const ttl = deps.ttlSeconds ?? clipUrlTtlSeconds();

  const source = await deps.assets.get(sourceAssetId);

  // Version-chain linkage (issue #118). Opt-in only: when `asVersion` is set we
  // resolve the source's lineage and record the clip as a version of it,
  // backfilling the source's group when it had none. Default (asVersion absent)
  // leaves both fields undefined — today's disconnected-sibling behavior.
  let versionLinkage: { versionOfAssetId: string; versionGroupId: string } | undefined;
  if (asVersion && source) {
    const resolved = resolveVersionLinkage(source);
    versionLinkage = {
      versionOfAssetId: resolved.versionOfAssetId,
      versionGroupId: resolved.versionGroupId
    };
    if (resolved.seedSourceGroup) {
      await deps.assets.update(source.id, { versionGroupId: resolved.versionGroupId });
    }
  }

  // Create the child asset first so its id seeds the destination object key.
  const child = await deps.assets.create({
    name: outputName ?? `clip-${startSeconds}-${endSeconds}`,
    parentId: sourceAssetId,
    versionOfAssetId: versionLinkage?.versionOfAssetId,
    versionGroupId: versionLinkage?.versionGroupId
  });
  const destKey = clipObjectKey(child.id);
  // The objectKey is recorded only AFTER the object is verified present, so a
  // failed clip never leaves a key pointing at nothing.
  await deps.assets.update(child.id, { status: 'processing' });

  let sizeBytes: number;
  try {
    const sourceUrl = await deps.storage.presignedGet(objectKey, ttl);
    // The runner writes the clip natively to s3://bucket/destKey; it needs the
    // destination object key, not a presigned PUT URL (issue #786).
    await deps.runner(sourceUrl, destKey, startSeconds, endSeconds);

    // The job reporting success is NOT proof that an object was written
    // (issue #786). Confirm the object exists and carries bytes before flipping
    // the child to `ready`; otherwise we would hand back a `ready` asset whose
    // delivery/files URLs answer NoSuchKey.
    const stat = await deps.storage.statObject(destKey);
    if (!stat) {
      throw new Error(
        `clip output object "${destKey}" not found in storage after the job reported success`
      );
    }
    if (stat.size <= 0) {
      throw new Error(
        `clip output object "${destKey}" is empty (0 bytes) after the job reported success`
      );
    }
    sizeBytes = stat.size;
  } catch (err) {
    await deps.assets.update(child.id, { status: 'failed' });
    throw err;
  }

  // Object verified present: record its key and the clip's own technical
  // metadata (duration of the requested range), then advance to ready.
  await deps.assets.update(child.id, {
    objectKey: destKey,
    technicalMetadata: clipTechnicalMetadata(
      source,
      startSeconds,
      endSeconds,
      sizeBytes,
      new Date().toISOString()
    )
  });
  const ready = await deps.assets.update(child.id, { status: 'ready' });
  // `update` returns undefined only if the child vanished mid-flight; fall back
  // to a re-read, then to the last known record, so the caller always gets the
  // new asset.
  return ready ?? (await deps.assets.get(child.id)) ?? child;
}
