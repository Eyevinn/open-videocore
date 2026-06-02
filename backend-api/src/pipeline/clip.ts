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

import type { AssetRepository, Asset } from '../data/asset-repo.js';
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
  workspaceId: string;
  sourceAssetId: string;
  objectKey: string;
  startSeconds: number;
  endSeconds: number;
  outputName?: string;
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
  const { workspaceId, sourceAssetId, objectKey, startSeconds, endSeconds, outputName } = params;
  const ttl = deps.ttlSeconds ?? clipUrlTtlSeconds();

  // Create the child asset first so its id seeds the destination object key.
  const child = await deps.assets.create(workspaceId, {
    name: outputName ?? `clip-${startSeconds}-${endSeconds}`,
    parentId: sourceAssetId
  });
  const destKey = clipObjectKey(child.id);
  await deps.assets.update(workspaceId, child.id, { objectKey: destKey, status: 'processing' });

  const sourceUrl = await deps.storage.presignedGet(objectKey, ttl);
  const putUrl = await deps.storage.presignedPut(destKey, ttl);

  try {
    await deps.runner(sourceUrl, putUrl, startSeconds, endSeconds);
  } catch (err) {
    await deps.assets.update(workspaceId, child.id, { status: 'failed' });
    throw err;
  }

  const ready = await deps.assets.update(workspaceId, child.id, { status: 'ready' });
  // `update` returns undefined only if the child vanished mid-flight; fall back
  // to the last known record so the caller always gets the new asset.
  return ready ?? child;
}
