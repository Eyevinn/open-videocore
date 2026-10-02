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
