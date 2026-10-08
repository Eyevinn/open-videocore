// Per-stack watch-folder wiring (issue #1099).
//
// Watch-folder ingest (issue #16) watches ONE source bucket on ONE object-storage
// client. The wiring in main.ts used to build exactly one instance from
// `WorkspaceStackResolver.resolve()` called with NO stack name, which resolves
// the FIRST listed stack (services/workspace-stack.ts `resolve()`, no-stackName
// branch). On an installation with more than one provisioned stack that means:
//   - files dropped into stack B's source bucket are never noticed at all, and
//   - the asset documents the watcher does create are written with no stack
//     context, i.e. into the first-listed stack — the same control-plane /
//     data-plane split issue #1058 fixed for requests.
//
// This module reconciles ONE watch-folder instance PER provisioned stack:
// enumerate the stacks with `listStackNames()`, resolve each one by NAME, and
// hold the resulting watchers in a registry keyed by stack name. main.ts builds
// each instance with its ingest wrapped in `runWithRequestStack(name, ...)`
// (services/request-stack-context.ts), so the assets, jobs and bytes a drop
// produces all land in the stack whose bucket the file was dropped into.
//
// CONFIGURATION SHAPE (issue #1099 asks this explicitly). Watch-folder config is
// GLOBAL and stays global: `WATCH_FOLDER_ENABLED` and
// `WATCH_FOLDER_POLL_INTERVAL_SECONDS` (pipeline/watch-folder.ts) are
// deployment-wide, and `MINIO_URL` is a deployment-wide override that bypasses
// the parameter store for every stack (workspace-stack.ts
// `envOverrideConnectionsActive`). There is deliberately NO per-stack env var:
// stacks are created at RUNTIME by POST /api/v1/provision, so a boot-time env
// var cannot name them (12-factor config is static for the process lifetime).
// The per-stack SOURCE LOCATION is therefore not configuration at all — it is
// DERIVED from each stack's own provisioning record: `StackConfig.minioEndpoint`
// + `StackConfig.sourceBucket`, surfaced as `WorkspaceConnections.storageClient`
// and `.sourceBucket` by `buildConnectionsFromStack`. A newly provisioned stack
// gets a watcher with no config change and no restart; a global flag still
// turns the feature on or off for the whole deployment.
//
// Reconciliation is idempotent, so the same function serves boot and every
// subsequent onStackChange (provision / teardown).

import type { Client as MinioClient } from 'minio';
import type { WatchFolderLogger } from '../pipeline/watch-folder.js';

// Registry key for the resolver's DEFAULT (unnamed) resolution, matching
// `WorkspaceStackResolver.resolveCached`'s own `stackName ?? ""` cache key.
export const DEFAULT_STACK_KEY = '';

// Registry key for a stack name. `undefined` (no stack list available — no
// parameter store, or an env-override/bare-local run) keys the default slot.
export function stackRegistryKey(stackName?: string | undefined): string {
  return stackName ?? DEFAULT_STACK_KEY;
}

// The slice of WatchFolderService this module drives. Declared structurally so
// the reconciler is unit-testable without a MinIO client or a repository.
export type WatchFolderHandle = {
  currentBucket(): string;
  isRunning(): boolean;
  start(): void;
  stop(): void;
};

// The slice of WorkspaceConnections (services/workspace-stack.ts) this module
// reads: the stack's object-storage client and its source bucket.
export type StackStorageConnections = {
  storageClient: MinioClient | undefined;
  sourceBucket: string;
};

export type ReconcileWatchFoldersOptions<W extends WatchFolderHandle> = {
  // `WorkspaceStackResolver.listStackNames()` — every stack `resolve()` can
  // address. NOTE its contract: a parameter-store read failure is LOGGED and
  // reported as `[]`, not thrown (workspace-stack.ts:1186).
  listStackNames: () => Promise<string[]>;
  // `WorkspaceStackResolver.resolve(stackName)`. Called with an explicit name
  // per stack so the connections (and the resolver cache entry the ingest path
  // later reads synchronously) are keyed to THAT stack.
  resolveStack: (stackName?: string | undefined) => Promise<StackStorageConnections>;
  // Build a watcher for one stack. main.ts supplies the real WatchFolderService
  // with its ingest bound to this stack's request-stack context.
  createWatchFolder: (stack: {
    stackName?: string | undefined;
    client: MinioClient;
    bucket: string;
  }) => W;
  // Live registry of watchers, keyed by `stackRegistryKey`. Owned by the caller
  // (main.ts) and mutated in place so repeated reconciles are idempotent.
  registry: Map<string, W>;
  log: WatchFolderLogger;
};

export type ReconcileWatchFoldersResult<W extends WatchFolderHandle> = {
  // Registry keys that are live after this reconcile, in stack-list order.
  stackKeys: string[];
  // The watcher for the DEFAULT stack — the first listed stack, i.e. the one a
  // request with no `X-Stack-Name` resolves to. main.ts rebinds the single
  // `watchFolder` the admin + storage routers read to this one, which keeps
  // single-stack behaviour identical. Undefined when nothing changed or no
  // stack has object storage yet.
  defaultWatchFolder: W | undefined;
};

// Reconcile the watch-folder registry against the currently provisioned stacks.
// Never throws: every per-stack failure is logged and the remaining stacks are
// still wired, so one stack's parameter-store blip cannot leave the others
// without ingest.
export async function reconcileWatchFolders<W extends WatchFolderHandle>(
  opts: ReconcileWatchFoldersOptions<W>
): Promise<ReconcileWatchFoldersResult<W>> {
  const { registry, log } = opts;

  let names: string[];
  try {
    names = await opts.listStackNames();
  } catch (err) {
    // Defensive: the production resolver swallows its own read errors, but a
    // stub/other implementation may throw. Leave the registry untouched.
    log.warn({ err }, 'watch-folder: failed to list provisioned stacks');
    return { stackKeys: [...registry.keys()], defaultWatchFolder: undefined };
  }

  // An EMPTY list is AMBIGUOUS: `listStackNames()` reports a parameter-store
  // read failure as `[]` as well as genuinely having no stacks. If we already
  // hold watchers, keep them — stopping live ingest on a transient read failure
  // is strictly worse than briefly watching a stack that was just torn down
  // (the next provision/teardown fires onStackChange and reconciles again).
  if (names.length === 0 && registry.size > 0) {
    log.warn(
      { watchers: [...registry.keys()] },
      'watch-folder: stack list came back empty; keeping the existing watchers'
    );
    return { stackKeys: [...registry.keys()], defaultWatchFolder: undefined };
  }

  // With no stacks listed at all (no parameter store, env-override, or a bare
  // local run) fall back to ONE default-context watcher, which is exactly the
  // pre-#1099 single-instance behaviour. Mirrors the per-stack sweep in main.ts
  // (`stackNames.length > 0 ? stackNames : [undefined]`).
  const stacks: Array<string | undefined> = names.length > 0 ? names : [undefined];
  const liveKeys = stacks.map((name) => stackRegistryKey(name));

  // Drop watchers for stacks that are no longer provisioned (teardown). Their
  // object storage is gone, so polling it would only produce errors.
  for (const key of [...registry.keys()]) {
    if (liveKeys.includes(key)) continue;
    const stale = registry.get(key);
    stale?.stop();
    registry.delete(key);
    log.info(
      { stack: key === DEFAULT_STACK_KEY ? null : key },
      'watch-folder ingest stopped for a stack that is no longer provisioned'
    );
  }

  for (const stackName of stacks) {
    const key = stackRegistryKey(stackName);
    try {
      const conns = await opts.resolveStack(stackName);
      const client = conns.storageClient;
      if (!client) {
        // No object storage on this stack yet (not provisioned, or a partial /
        // invalid record). Nothing to watch; leave any prior instance be.
        continue;
      }
      const bucket = conns.sourceBucket;
      const existing = registry.get(key);
      // Already wired against this bucket and running: nothing to do. (A given
      // stack's storage endpoint is stack-invariant, so an unchanged bucket plus
      // a live service means the wiring still holds.)
      if (existing && existing.currentBucket() === bucket && existing.isRunning()) {
        continue;
      }
      // Rebuild against the freshly resolved client/bucket. Stop any stale prior
      // instance first so its notification listener + poll timer are detached.
      existing?.stop();
      const created = opts.createWatchFolder({
        ...(stackName !== undefined ? { stackName } : {}),
        client,
        bucket
      });
      registry.set(key, created);
      created.start();
      log.info(
        { bucket, stack: stackName ?? null, source: 'parameter-store' },
        'watch-folder ingest wired from provisioned stack storage'
      );
    } catch (err) {
      log.warn(
        { err, stack: stackName ?? null },
        'watch-folder: failed to wire from provisioned stack storage'
      );
    }
  }

  const defaultKey = liveKeys[0];
  return {
    stackKeys: liveKeys,
    defaultWatchFolder: defaultKey === undefined ? undefined : registry.get(defaultKey)
  };
}
