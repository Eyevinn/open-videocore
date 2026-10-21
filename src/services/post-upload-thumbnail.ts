// Post-ingest poster-frame trigger (issue #7, stack-correct per issue #1100).
//
// Shared by both object-storage ingest paths in src/main.ts (`onObjectStored`):
// the direct-upload routes and the watch-folder service. The work is
// deliberately DETACHED from the request — the uploader must not wait on an
// ffmpeg job — which is exactly what made the previous implementation wrong.
//
// What was wrong (issue #1100). The detached continuation read the resolver
// CACHE (`stackResolver.resolveCached(currentRequestStackName())`,
// services/workspace-stack.ts:1208) to get the originating stack's object-store
// coordinates. `resolveCached` returns `undefined` once the entry has aged past
// CACHE_TTL_MS (workspace-stack.ts:75, checked at :1211), and the call site then
// fell back to the process-wide boot-default bucket — so a thumbnail triggered
// after the TTL expired was written to the WRONG stack's bucket on a multi-stack
// install (and built from the wrong credentials).
//
// What this does instead. The stack NAME is captured synchronously, while the
// originating request's AsyncLocalStorage store is still on the stack, and the
// connections are then resolved with the full `resolve(stackName)`
// (workspace-stack.ts:906) from inside the continuation. `resolve` serves the
// same cache when it is warm and performs a REAL parameter-store resolution on a
// miss, so the stack identity no longer depends on cache timing. It never
// returns undefined: it falls back to the named stack's default/last-known-good
// internally rather than handing us nothing.
//
// FOLLOW-UP (noted on issue #1100, deliberately not built here): the stack name
// would be more robust read off the Job/Asset document than off the ambient
// request context — the ambient name is empty for non-request ingest (the
// watch-folder), where the workspace default is the correct answer anyway. No
// such stored-name plumbing exists today and adding persistence is out of scope
// for this fix.

import type { AssetRepository } from '../data/asset-repo.js';
import type { WorkspaceStorage } from '../data/storage.js';
import {
  resolveRunnerOption,
  runnerS3Config,
  RunnerFactoryUnresolvedError,
  type RunnerOption
} from '../pipeline/runner-option.js';
import { extractThumbnails, type FrameExtractor } from '../pipeline/thumbnail.js';
import { currentRequestStackName } from './request-stack-context.js';
import type { WorkspaceConnections } from './workspace-stack.js';

// The resolver surface this module needs, declared structurally so tests can
// drive the production trigger against a stub resolver instead of live
// CouchDB/MinIO clients (same approach as request-stack-context.ts).
// `resolve(stackName?)` -> Promise<WorkspaceConnections>, never undefined:
// src/services/workspace-stack.ts:906.
export type ThumbnailStackResolver = {
  resolve(stackName?: string): Promise<WorkspaceConnections>;
};

type Logger = {
  error?(...a: unknown[]): void;
};

export type PostUploadThumbnailDeps = {
  resolver: ThumbnailStackResolver;
  assets: AssetRepository;
  // The configured extractor, runner or factory (src/pipeline/runner-option.ts).
  extractor: RunnerOption<FrameExtractor>;
  // Boot-default source bucket. Only reached when the resolved stack exposes no
  // bucket at all — no longer reached merely because a cache entry expired.
  defaultSourceBucket: string;
  log?: Logger;
  // Injectable for tests; defaults to the real orchestrator
  // (src/pipeline/thumbnail.ts:102).
  extract?: typeof extractThumbnails;
};

// Frames extracted on ingest. One poster frame at t=1s, unchanged.
const INGEST_TIMECODES = [1];

export type PostUploadThumbnailTrigger = (
  assetId: string,
  objectKey: string,
  storage: WorkspaceStorage
) => void;

export function makePostUploadThumbnailTrigger(
  deps: PostUploadThumbnailDeps
): PostUploadThumbnailTrigger {
  const extract = deps.extract ?? extractThumbnails;
  return (assetId, objectKey, storage) => {
    // Captured SYNCHRONOUSLY, before anything is detached: this runs inside the
    // originating request's ALS store (services/request-stack-context.ts:51), so
    // the name is the stack the request named. Undefined off-request
    // (watch-folder, boot), which resolves the workspace default exactly as
    // before.
    const stackName = currentRequestStackName();
    void (async () => {
      try {
        // Real resolution, not a cache read (issue #1100).
        const conns = await deps.resolver.resolve(stackName);
        const bucket = conns.sourceBucket || deps.defaultSourceBucket;
        const extractor = resolveRunnerOption(
          deps.extractor,
          runnerS3Config(conns.s3Config, bucket),
          'thumbnailExtractor'
        );
        // Extraction failures are recorded on the asset document by the
        // orchestrator itself, so they are not re-logged here — unchanged.
        await extract(
          { assetId, objectKey, timecodes: INGEST_TIMECODES },
          { assets: deps.assets, storage, extractor }
        ).catch(() => {
          /* failures recorded on asset */
        });
      } catch (err) {
        // Detached work: nothing can be thrown at the uploader, so every
        // failure is LOGGED at error level rather than swallowed. The
        // unresolved-factory case keeps its own message so it stays
        // distinguishable from "no thumbnails configured" (issue #838).
        if (err instanceof RunnerFactoryUnresolvedError) {
          deps.log?.error?.(
            { err, assetId, stackName },
            'skipping post-upload thumbnail extraction: runner factory could not be resolved'
          );
        } else {
          deps.log?.error?.(
            { err, assetId, stackName },
            'skipping post-upload thumbnail extraction: stack resolution failed'
          );
        }
      }
    })();
  };
}
