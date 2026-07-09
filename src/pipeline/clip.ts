// Clip / trim pipeline (issue #17).
//
// Given a stored video object and a time window [startSeconds, endSeconds),
// extract that segment into a NEW child asset whose objectKey is
// `<workspaceId>/clips/<newAssetId>.mp4`. The clip inherits the source asset's
// workspaceId and points back to it via `parentId`.
//
// OSC wiring (mirrors the thumbnail pipeline, issue #7): a single ephemeral
// eyevinn-ffmpeg-s3 job seeks to the window and stream-copies it out. The
// service downloads an HTTPS source and uploads outputs back to S3, so we hand
// it a short-lived presigned GET URL for the source and a presigned PUT URL for
// the clip destination. The actual OSC job dispatch is injected as a
// `ClipRunner` (same narrow-interface pattern as `FrameExtractor`) so the
// orchestration/storage logic here stays testable and OSC specifics live in
// osc-clip.ts.
//
// The route AWAITS this (like thumbnails, unlike fire-and-forget metadata): the
// new child asset is created in `processing`, the job runs, and on success the
// child advances to `ready`. On runner failure the child is marked `failed` and
// the error is rethrown so the route can surface a 502.

import { resolveVersionLinkage, type AssetRepository, type Asset } from '../data/asset-repo.js';
import type { WorkspaceStorage } from '../data/storage.js';

// TTL for the presigned source GET + clip PUT URLs handed to the runner. Short
// by design: the job reads the source and writes the clip once, immediately.
export const DEFAULT_CLIP_URL_TTL_SECONDS = 10 * 60; // 10 minutes

export function clipUrlTtlSeconds(): number {
  const raw = process.env['CLIP_URL_TTL_SECONDS'];
  if (!raw) return DEFAULT_CLIP_URL_TTL_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLIP_URL_TTL_SECONDS;
}

// Calls the OSC ffmpeg runner: seek to [start, end) in the source and upload the
// resulting clip to its presigned PUT URL. Injected so tests stub it and the OSC
// specifics stay in one place (osc-clip.ts). Throws on a runner/transport
// failure; the orchestrator surfaces that to the caller.
export type ClipRunner = (
  sourceUrl: string,
  putUrl: string,
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

// Run one clip extraction to completion and return the new child asset.
//
// Flow: create the child asset (parentId = source) carrying its destination
// objectKey and advance it to `processing`; presign source GET + clip PUT;
// dispatch the ffmpeg job; on success advance the child to `ready`. THROWS on a
// runner failure after marking the child `failed`, so the route maps it to a
// 502 while the child record preserves the failure for inspection.
export async function clip(params: ClipParams, deps: ClipDeps): Promise<Asset> {
  const { sourceAssetId, objectKey, startSeconds, endSeconds, outputName, asVersion } = params;
  const ttl = deps.ttlSeconds ?? clipUrlTtlSeconds();

  // Version-chain linkage (issue #118). Opt-in only: when `asVersion` is set we
  // resolve the source's lineage and record the clip as a version of it,
  // backfilling the source's group when it had none. Default (asVersion absent)
  // leaves both fields undefined — today's disconnected-sibling behavior.
  let versionLinkage: { versionOfAssetId: string; versionGroupId: string } | undefined;
  if (asVersion) {
    const source = await deps.assets.get(sourceAssetId);
    if (source) {
      const resolved = resolveVersionLinkage(source);
      versionLinkage = {
        versionOfAssetId: resolved.versionOfAssetId,
        versionGroupId: resolved.versionGroupId
      };
      if (resolved.seedSourceGroup) {
        await deps.assets.update(source.id, { versionGroupId: resolved.versionGroupId });
      }
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
  await deps.assets.update(child.id, { objectKey: destKey, status: 'processing' });

  const sourceUrl = await deps.storage.presignedGet(objectKey, ttl);
  const putUrl = await deps.storage.presignedPut(destKey, ttl);

  try {
    await deps.runner(sourceUrl, putUrl, startSeconds, endSeconds);
  } catch (err) {
    await deps.assets.update(child.id, { status: 'failed' });
    throw err;
  }

  const ready = await deps.assets.update(child.id, { status: 'ready' });
  // `update` returns undefined only if the child vanished mid-flight; fall back
  // to the last known record so the caller always gets the new asset.
  return ready ?? child;
}
