// Request-scoped stack identity (issue #1058).
//
// The transcode CONTROL plane has been keyed by the request's `X-Stack-Name`
// since issue #615 (WorkspaceStackResolver.resolveStackName, consumed by
// src/routes/assets.ts transcodeContext). The DATA plane — asset/job documents
// and the object bytes themselves — was never threaded through: every
// `PerWorkspace*` repository called `resolver.resolve()` with NO name and the
// object-storage factory called `resolver.resolveCached()` with NO name, both of
// which key on `''` and resolve to the FIRST listed stack
// (workspace-stack.ts `resolve()`, no-stackName branch).
//
// On an installation with more than one provisioned stack those two halves
// address different object stores, and because every stack's source bucket
// carries the same literal name, the divergence surfaces only as a downstream
// `NoSuchKey` from the transcoder. Reproduced end to end on a two-stack install
// in issue #1058.
//
// This module carries the stack name the REQUEST named, in an AsyncLocalStorage
// store established by a single `onRequest` hook in src/main.ts, so every
// resolution made while serving that request — repositories, storage factory,
// and any work detached from the handler (the URL-pull worker, metadata
// extraction) — resolves the SAME stack the control plane routes to. Documents
// and bytes therefore move together.
//
// Outside a request (boot wiring, sweeps, watch-folder) the store is empty and
// `currentRequestStackName()` returns undefined, which preserves the previous
// default-stack behaviour byte-for-byte on those paths.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingHttpHeaders } from 'node:http';
import type { StorageFactory } from '../routes/asset-upload.js';
import type { WorkspaceConnections } from './workspace-stack.js';

export type RequestStackContext = {
  // The stack name the request named via `X-Stack-Name`, or undefined when the
  // request named none (then the workspace default / first listed stack).
  stackName?: string;
};

const stackContext = new AsyncLocalStorage<RequestStackContext>();

// Run `fn` with `stackName` as the ambient request stack. Everything awaited
// from inside `fn` — including work deliberately detached with `void` (the
// URL-pull worker, fire-and-forget metadata extraction) — inherits the store,
// because AsyncLocalStorage propagates along the async resource chain.
export function runWithRequestStack<T>(stackName: string | undefined, fn: () => T): T {
  return stackContext.run(stackName ? { stackName } : {}, fn);
}

// The stack name of the in-flight request, or undefined outside a request.
export function currentRequestStackName(): string | undefined {
  return stackContext.getStore()?.stackName;
}

// Minimal logger surface for the legacy-document fallback notice below. Declared
// structurally so a Fastify/pino logger satisfies it without this module
// depending on a logging library.
export type StackContextLogger = {
  debug(obj: unknown, msg?: string): void;
};

// Single spelling of the fallback notice (issue #1097), so every worker reports a
// legacy document the same way and the text can be grepped in one place.
export const PERSISTED_STACK_FALLBACK_MESSAGE =
  'no persisted stackName on the document — resolving the default (first-listed) stack';

// Re-enter the stack a PERSISTED document was created against (issue #1097).
//
// `runWithRequestStack` carries stack identity for the lifetime of a REQUEST.
// Work that outlives the request — the URL-pull worker, fire-and-forget metadata
// extraction — inherits that store only while the process lives; once the
// process restarts, the queue message or job record is picked up with an EMPTY
// store and every repository/storage resolution falls back to the first-listed
// stack. The durable identity is the `stackName` now persisted on the Job and
// Asset documents (src/data/job-repo.ts `Job.stackName`,
// src/data/asset-repo.ts `Asset.stackName`), and this is how a worker re-enters
// it.
//
// BACKWARD COMPATIBILITY: a document written before #1097 carries NO stackName.
// Such a document must keep behaving exactly as it does today, which means two
// things, both deliberate:
//   1. we do NOT call `runWithRequestStack(undefined, fn)` — that would CLEAR an
//      ambient stack the caller legitimately established (e.g. a pull detached
//      from a request on a named stack), turning a correct resolution into a
//      first-listed-stack one. We run `fn` in the caller's own context instead.
//   2. with no ambient context either (the restart case) resolution falls back
//      to the first-listed stack — `workspace-stack.ts resolve()`, no-stackName
//      branch — which IS today's behaviour for these paths.
// The fallback is reported through `onFallback` at DEBUG level by the caller, so
// an operator can see that a legacy document took the default resolution without
// adding noise to a normal run.
export function runWithPersistedStack<T>(
  stackName: string | undefined,
  fn: () => T,
  onFallback?: () => void
): T {
  if (stackName) {
    return runWithRequestStack(stackName, fn);
  }
  onFallback?.();
  return fn();
}

// Read the stack name off request headers. Single place the header name is
// spelled on the data-plane side, mirroring the control-plane read in
// src/routes/assets.ts (`request.headers['x-stack-name']`).
export function requestStackNameFromHeaders(
  headers: IncomingHttpHeaders
): string | undefined {
  const raw = headers['x-stack-name'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

// Minimal resolver surface this module needs. Declared structurally so tests can
// exercise the production factory against a stub resolver without constructing
// live CouchDB/MinIO clients.
export type CachedStackResolver = {
  resolveCached(stackName?: string): WorkspaceConnections | undefined;
};

// The synchronous, request-scoped object-storage factory wired into the asset
// routers (src/main.ts `storageFor`). Reads the connections the global
// preHandler already warmed for THIS request's stack — `resolveCached` is keyed
// identically to `resolve`, so the named entry is present — and builds the
// stack's WorkspaceStorage from them. Throws when the resolved stack has no
// object storage, exactly as before.
export function makeRequestScopedStorageFactory(
  resolver: CachedStackResolver
): StorageFactory {
  return () => {
    const stackName = currentRequestStackName();
    const conns = resolver.resolveCached(stackName);
    if (!conns?.storageFor) {
      throw new Error(
        stackName
          ? `object storage is not configured for stack "${stackName}"`
          : 'object storage is not configured for this stack'
      );
    }
    return conns.storageFor();
  };
}
