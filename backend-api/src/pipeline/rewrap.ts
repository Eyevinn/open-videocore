// Export / re-wrap (remux) pipeline (issue #19).
//
// Given a stored video object, re-wrap (remux) it into a DIFFERENT container
// format WITHOUT re-encoding the elementary streams. ffmpeg's `-c copy` copies
// every stream verbatim; only the container changes. The output becomes a NEW
// child asset whose objectKey is `<workspaceId>/exports/<newAssetId>.<format>`.
// The output container is chosen purely by the destination key's file
// extension — ffmpeg infers the muxer from it.
//
// OSC wiring (mirrors issue #6 ffprobe / issue #7 thumbnails): a single
// ephemeral eyevinn-ffmpeg-s3 job downloads the presigned source GET URL, runs
// ffmpeg `-i <src> -c copy <dst>`, and uploads the output to the presigned PUT
// URL. The actual OSC job dispatch is injected as a `RewrapRunner` so the
// orchestration/storage logic here stays testable and OSC specifics live in
// osc-rewrap.ts.
//
// Like thumbnails (and unlike fire-and-forget metadata extraction) this is
// AWAITED by the route: the caller gets back the new child asset (or an error)
// synchronously. The new child asset is created `uploading`, advanced to
// `processing` while the job runs, and to `ready` once the output object lands.

import type { Asset, AssetRepository } from '../data/asset-repo.js';
import type { WorkspaceStorage } from '../data/storage.js';

// Container formats we support re-wrapping into. Each maps to a file extension
// ffmpeg recognises as a muxer. Validated with a Zod enum at the route boundary
// (see assets.ts) AND defensively here so the pipeline cannot be driven to an
// unsupported container by a non-HTTP caller.
export const REWRAP_FORMATS = ['mp4', 'mkv', 'mov', 'mxf', 'ts'] as const;
export type RewrapFormat = (typeof REWRAP_FORMATS)[number];

export function isRewrapFormat(value: string): value is RewrapFormat {
  return (REWRAP_FORMATS as readonly string[]).includes(value);
}

// Raised when an unsupported target container is requested -> 400. The route
// also guards with a Zod enum; this is defence in depth for direct callers.
export class UnsupportedFormatError extends Error {
  readonly statusCode = 400;
  constructor(format: string) {
    super(`unsupported target format: ${format}`);
    this.name = 'UnsupportedFormatError';
  }
}

// TTL for the presigned source GET + output PUT URLs handed to the runner.
// Short by design: the job reads the source and writes the output once,
// immediately. Mirrors thumbnailUrlTtlSeconds (issue #7).
export const DEFAULT_REWRAP_URL_TTL_SECONDS = 30 * 60; // 30 minutes

export function rewrapUrlTtlSeconds(): number {
  const raw = process.env['REWRAP_URL_TTL_SECONDS'];
  if (!raw) return DEFAULT_REWRAP_URL_TTL_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REWRAP_URL_TTL_SECONDS;
}

// Build the workspace-local destination object key for a re-wrapped output. The
// extension determines the output container, so it must be the target format.
export function rewrapObjectKey(workspaceId: string, newAssetId: string, format: RewrapFormat): string {
  return `${workspaceId}/exports/${newAssetId}.${format}`;
}

// Runs the OSC ffmpeg job: download the source GET URL, remux with `-c copy`,
// upload the result to the destination PUT URL. Injected so tests stub it and
// the OSC specifics stay in one place (osc-rewrap.ts). Throws on a
// runner/transport failure; the orchestrator surfaces that to the caller.
export type RewrapRunner = (sourceUrl: string, putUrl: string) => Promise<void>;

export type RewrapParams = {
  workspaceId: string;
  sourceAssetId: string;
  // The source asset's stored object key (workspace-local).
  objectKey: string;
  targetFormat: RewrapFormat;
  // Optional name for the child asset; defaults to `<source name> [<format>]`.
  outputName?: string;
};

export type RewrapDeps = {
  assets: AssetRepository;
  storage: WorkspaceStorage;
  runner: RewrapRunner;
  // Injectable for tests; defaults to env-derived TTL.
  ttlSeconds?: number;
};

// Run one export / re-wrap to completion and return the new child asset.
//
// Flow: create the child asset (parentId = source) -> advance to `processing`
// -> mint presigned source GET + output PUT URLs -> dispatch the ffmpeg `-c
// copy` job -> on success advance the child to `ready` with its objectKey set.
//
// On a runner failure the child asset is marked `failed` (so the partial export
// is observable) and the error is re-thrown for the route to map to a 502. The
// source asset is never mutated — an export is a pure read of the source.
export async function rewrap(params: RewrapParams, deps: RewrapDeps): Promise<Asset> {
  const { workspaceId, sourceAssetId, objectKey, targetFormat, outputName } = params;

  if (!isRewrapFormat(targetFormat)) {
    throw new UnsupportedFormatError(targetFormat);
  }

  const ttl = deps.ttlSeconds ?? rewrapUrlTtlSeconds();

  const source = await deps.assets.get(workspaceId, sourceAssetId);
  const baseName = source?.name ?? sourceAssetId;

  // Create the child asset first so its id determines the output object key.
  const child = await deps.assets.create(workspaceId, {
    name: outputName ?? `${baseName} [${targetFormat}]`,
    parentId: sourceAssetId
  });

  const outputKey = rewrapObjectKey(workspaceId, child.id, targetFormat);

  // uploading -> processing while the job runs.
  await deps.assets.update(workspaceId, child.id, { status: 'processing' });

  try {
    const sourceUrl = await deps.storage.presignedGet(objectKey, ttl);
    const putUrl = await deps.storage.presignedPut(outputKey, ttl);
    await deps.runner(sourceUrl, putUrl);
  } catch (err) {
    // Surface the partial export as a failed child asset, then re-throw.
    await deps.assets.update(workspaceId, child.id, { status: 'failed' });
    throw err;
  }

  // Output object has landed: record the key and advance to ready.
  await deps.assets.update(workspaceId, child.id, { objectKey: outputKey });
  const ready = await deps.assets.update(workspaceId, child.id, { status: 'ready' });
  // `update` returns the full asset; fall back to a re-read defensively.
  return ready ?? (await deps.assets.get(workspaceId, child.id))!;
}

// Service wrapper mirroring PackagingService — exposes rewrap as a method so the
// route can hold one injected dependency. Kept thin; all logic lives in rewrap().
export class RewrapService {
  constructor(private readonly runner: RewrapRunner) {}

  rewrap(
    params: RewrapParams,
    deps: Omit<RewrapDeps, 'runner'> & { runner?: RewrapRunner }
  ): Promise<Asset> {
    return rewrap(params, { ...deps, runner: deps.runner ?? this.runner });
  }
}
