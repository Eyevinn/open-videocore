// Post-upload poster frame must address the ORIGINATING stack's bucket even
// after the resolver cache has aged out (issue #1100).
//
// The trigger in src/main.ts `onObjectStored` used to read
// `stackResolver.resolveCached(currentRequestStackName())`
// (services/workspace-stack.ts:1208) from a detached continuation. That read
// returns undefined once the entry is past CACHE_TTL_MS (workspace-stack.ts:75,
// checked at :1211) and the call site then fell back to the process-wide
// boot-default bucket — the thumbnail landed in the wrong stack's bucket, built
// from no credentials at all. The trigger now captures the stack NAME
// synchronously and performs a real `resolve(stackName)`
// (workspace-stack.ts:906, returns Promise<WorkspaceConnections>, never
// undefined) inside the continuation.
//
// Contract sources verified against the tree under test (no guessing):
//   - WorkspaceStackResolver.resolveCached(stackName?): WorkspaceConnections |
//     undefined, undefined past TTL — src/services/workspace-stack.ts:1208-1213.
//   - WorkspaceStackResolver.resolve(stackName?): Promise<WorkspaceConnections>
//     — src/services/workspace-stack.ts:906; serves the cache when warm (:908),
//     otherwise re-reads the parameter store and re-caches (:1071).
//   - WorkspaceConnections.sourceBucket: string / .s3Config: { endpoint,
//     accessKey, secretKey } | undefined — src/services/workspace-stack.ts:150,
//     :152.
//   - runnerFactory / resolveRunnerOption / runnerS3Config / RunnerS3Config /
//     RunnerFactoryUnresolvedError — src/pipeline/runner-option.ts:51, :101,
//     :90, :32, :74.
//   - extractThumbnails(params, deps) with deps { assets, storage, extractor }
//     — src/pipeline/thumbnail.ts:102; FrameExtractor — :64.
//   - currentRequestStackName() / runWithRequestStack() —
//     src/services/request-stack-context.ts:51, :46.

import { describe, it, expect } from 'vitest';

import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import type { WorkspaceStorage } from '../src/data/storage.js';
import { runnerFactory, type RunnerS3Config } from '../src/pipeline/runner-option.js';
import type { extractThumbnails, FrameExtractor } from '../src/pipeline/thumbnail.js';
import { makePostUploadThumbnailTrigger } from '../src/services/post-upload-thumbnail.js';
import { runWithRequestStack } from '../src/services/request-stack-context.js';
import type { WorkspaceConnections } from '../src/services/workspace-stack.js';

// Distinct per stack so one assertion names the stack that was addressed. (On a
// real install every stack's bucket carries the same literal name, which is what
// made the #1058 family of bugs silent; distinct names here make the failure
// legible.)
const BUCKETS: Record<string, string> = {
  a: 'stack-a-source',
  b: 'stack-b-source'
};
// What the boot-time default is — the value the TTL-expired cache read used to
// demote to.
const BOOT_DEFAULT_BUCKET = 'boot-default-source';

function connectionsFor(stack: string, opts: { s3?: boolean } = {}): WorkspaceConnections {
  return {
    sourceBucket: BUCKETS[stack],
    packagedBucket: 'openvideocore-packaged',
    s3Config:
      opts.s3 === false
        ? undefined
        : { endpoint: `https://${stack}.minio-minio.example`, accessKey: 'admin', secretKey: 'x' },
    stackName: stack
  } as unknown as WorkspaceConnections;
}

type Harness = {
  trigger: ReturnType<typeof makePostUploadThumbnailTrigger>;
  // Every dispatch: the credentials the runner FACTORY was built from and the
  // orchestrator arguments it was handed.
  dispatched: Array<{
    s3: RunnerS3Config;
    assetId: string;
    objectKey: string;
    timecodes: number[];
    storage: unknown;
  }>;
  // Cache reads the trigger performed. Must stay empty: a cache-only read is
  // the defect.
  cachedReads: string[];
  resolvedNames: Array<string | undefined>;
  errors: Array<{ obj: unknown; msg: unknown }>;
  storage: WorkspaceStorage;
  expireResolverCache: () => void;
};

function buildHarness(
  names: string[],
  opts: { s3?: boolean; resolveFails?: boolean } = {}
): Harness {
  const dispatched: Harness['dispatched'] = [];
  const cachedReads: string[] = [];
  const resolvedNames: Array<string | undefined> = [];
  const errors: Harness['errors'] = [];
  let cacheCold = false;

  // Keyed exactly like WorkspaceStackResolver: a known name wins verbatim,
  // anything else falls back to the FIRST listed stack (workspace-stack.ts:954,
  // :980). `resolveCached` additionally goes cold past the TTL.
  const pick = (requested?: string): string =>
    requested && names.includes(requested) ? requested : names[0]!;
  const resolver = {
    resolve: async (stackName?: string): Promise<WorkspaceConnections> => {
      resolvedNames.push(stackName);
      if (opts.resolveFails) throw new Error('parameter store unreachable');
      return connectionsFor(pick(stackName), opts);
    },
    resolveCached: (stackName?: string): WorkspaceConnections | undefined => {
      cachedReads.push(stackName ?? '');
      return cacheCold ? undefined : connectionsFor(pick(stackName), opts);
    }
  };

  // Production injects a FACTORY (src/main.ts builds the ffmpeg-s3 runner from
  // the resolved stack's credentials), so this exercises resolveRunnerOption
  // rather than the plain-runner shortcut.
  let pendingS3: RunnerS3Config | undefined;
  const extractor = runnerFactory<FrameExtractor>((s3) => {
    pendingS3 = s3;
    return async () => {};
  });

  const storage = {} as WorkspaceStorage;

  const extract: typeof extractThumbnails = async (params, deps) => {
    // The extractor handed in IS the one the factory just built, so the
    // credentials captured above belong to this dispatch.
    void deps.extractor;
    dispatched.push({
      s3: pendingS3!,
      assetId: params.assetId,
      objectKey: params.objectKey,
      timecodes: params.timecodes,
      storage: deps.storage
    });
    return [];
  };

  const trigger = makePostUploadThumbnailTrigger({
    resolver,
    assets: new InMemoryAssetRepository(),
    extractor,
    defaultSourceBucket: BOOT_DEFAULT_BUCKET,
    log: {
      error: (obj: unknown, msg: unknown) => {
        errors.push({ obj, msg });
      }
    },
    extract
  });

  return {
    trigger,
    dispatched,
    cachedReads,
    resolvedNames,
    errors,
    storage,
    expireResolverCache: () => {
      cacheCold = true;
    }
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met in time');
}

describe('post-upload thumbnail resolves by name, not from the cache (issue #1100)', () => {
  it('writes to the originating stack bucket after the resolver cache TTL has expired', async () => {
    const h = buildHarness(['a', 'b']);
    // The cache is already cold when the detached continuation runs — exactly
    // the post-TTL state. Pre-fix the trigger read undefined here and fell back
    // to the boot default.
    h.expireResolverCache();

    runWithRequestStack('b', () => {
      h.trigger('asset-1', 'ingest/asset-1', h.storage);
    });

    await waitFor(() => h.dispatched.length > 0);
    expect(h.dispatched).toHaveLength(1);
    const run = h.dispatched[0]!;

    // Acceptance criterion: the originating stack's bucket, not the boot default.
    expect(run.s3.bucket).toBe(BUCKETS['b']);
    expect(run.s3.bucket).not.toBe(BOOT_DEFAULT_BUCKET);
    expect(run.s3.bucket).not.toBe(BUCKETS['a']);
    // ...and the credentials come from that same stack, not from nothing.
    expect(run.s3.endpoint).toBe('https://b.minio-minio.example');

    // It resolved by NAME, and it never took the cache-only path.
    expect(h.resolvedNames).toEqual(['b']);
    expect(h.cachedReads).toEqual([]);

    expect(run.assetId).toBe('asset-1');
    expect(run.objectKey).toBe('ingest/asset-1');
    expect(run.timecodes).toEqual([1]);
    // The already-resolved storage handle is passed straight through.
    expect(run.storage).toBe(h.storage);
    expect(h.errors).toEqual([]);
  });

  it('captures the request stack name synchronously, before the continuation detaches', async () => {
    const h = buildHarness(['a', 'b']);
    h.expireResolverCache();

    // The trigger returns inside the store; the resolve happens after it has
    // been torn down. Reading the ambient name late would yield the default.
    runWithRequestStack('b', () => {
      h.trigger('asset-2', 'ingest/asset-2', h.storage);
    });

    await waitFor(() => h.dispatched.length > 0);
    expect(h.resolvedNames).toEqual(['b']);
    expect(h.dispatched[0]!.s3.bucket).toBe(BUCKETS['b']);
  });

  it('resolves the workspace default off-request (watch-folder ingest), unchanged', async () => {
    const h = buildHarness(['a', 'b']);
    h.expireResolverCache();

    h.trigger('asset-3', 'drop/asset-3', h.storage);

    await waitFor(() => h.dispatched.length > 0);
    expect(h.resolvedNames).toEqual([undefined]);
    expect(h.dispatched[0]!.s3.bucket).toBe(BUCKETS['a']);
  });

  it('logs and skips when the stack resolves no credentials for the factory', async () => {
    const h = buildHarness(['a', 'b'], { s3: false });
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      runWithRequestStack('b', () => {
        h.trigger('asset-4', 'ingest/asset-4', h.storage);
      });

      await waitFor(() => h.errors.length > 0);
      expect(h.dispatched).toEqual([]);
      expect(h.errors[0]!.msg).toContain('runner factory could not be resolved');

      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('logs a resolve failure instead of raising an unhandled rejection', async () => {
    const h = buildHarness(['a', 'b'], { resolveFails: true });
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      runWithRequestStack('b', () => {
        h.trigger('asset-5', 'ingest/asset-5', h.storage);
      });

      await waitFor(() => h.errors.length > 0);
      expect(h.dispatched).toEqual([]);
      expect(h.errors[0]!.msg).toContain('stack resolution failed');

      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
