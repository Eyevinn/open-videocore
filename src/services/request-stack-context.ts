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
  // The ROUTING name: the stack name the request named via `X-Stack-Name`, or
  // undefined when the request named none (then the workspace default / first
  // listed stack). On the HTTP path this is a client-supplied value that has
  // only been syntax-checked (`requestStackNameFromHeaders`) — `resolve()`
  // deliberately tolerates a name with no stored config and falls back to the
  // workspace default, so a stale UI selection cannot break routing
  // (workspace-stack.ts `resolveStackName`).
  stackName?: string;
  // The PERSISTABLE name: the stack identity the resolver actually built this
  // request's connections from (`WorkspaceConnections.stackName`,
  // services/workspace-stack.ts:188 — "the parameter-store stack name, i.e. the
  // same identity resolveStackName() returns"). Only this is ever written into a
  // document (issue #1097 review, BLOCKING 2): it is by construction a
  // provisioned stack name or undefined, never a raw client string, so a
  // persisted stackName can never disagree with where the document was written.
  //
  // Undefined when nothing has confirmed an identity yet (before the resolver
  // preHandler runs) or on the paths that are not stack records (env override,
  // in-memory) — which persists nothing and keeps the documented legacy
  // behaviour.
  documentStackName?: string;
};

const stackContext = new AsyncLocalStorage<RequestStackContext>();

// Run `fn` with `stackName` as the ambient stack, for an INTERNAL caller whose
// name is already a resolved stack identity — a boot/sweep name read from
// `resolver.listStackNames()` (src/main.ts), a name decoded off a queue message,
// or a `stackName` read back off a Job/Asset document (`runWithPersistedStack`
// below). Such a name is trusted for persistence as well as routing, so both
// fields are set.
//
// Everything awaited from inside `fn` — including work deliberately detached
// with `void` (the URL-pull worker, fire-and-forget metadata extraction) —
// inherits the store, because AsyncLocalStorage propagates along the async
// resource chain.
export function runWithRequestStack<T>(stackName: string | undefined, fn: () => T): T {
  return stackContext.run(
    stackName ? { stackName, documentStackName: stackName } : {},
    fn
  );
}

// Run `fn` with the name an untrusted HTTP caller REQUESTED (the `X-Stack-Name`
// header). The name routes, but is NOT persistable until the resolver confirms
// it names a provisioned stack — `adoptResolvedStackName` does that, from the
// connections the resolver returns. Issue #1097 review, BLOCKING 2: without this
// split, any client could write an arbitrary string into a stored document, a
// parameter-store lookup key, and the resolver's per-name cache with one header.
export function runWithRequestedStack<T>(
  requestedStackName: string | undefined,
  fn: () => T
): T {
  return stackContext.run(requestedStackName ? { stackName: requestedStackName } : {}, fn);
}

// Record the stack identity the resolver actually built this request's
// connections from, making it the value documents created later in the request
// are stamped with. Called once per request, from the resolver preHandler that
// already awaits `resolve()` (src/main.ts), so confirming the identity costs no
// extra parameter-store read.
//
// Deliberately does NOT touch `stackName`: the routing name is what `resolve()`
// and `resolveCached()` are keyed on for this request (workspace-stack.ts:986),
// and rewriting it mid-request would move later lookups to a different cache key
// than the one the preHandler warmed.
export function adoptResolvedStackName(resolvedStackName: string | undefined): void {
  const store = stackContext.getStore();
  if (!store) return;
  store.documentStackName = resolvedStackName;
}

// The ROUTING stack name of the in-flight request, or undefined outside a
// request. Use for resolution (repositories, storage factory, re-entry).
export function currentRequestStackName(): string | undefined {
  return stackContext.getStore()?.stackName;
}

// The stack name that may be PERSISTED on a document created right now, or
// undefined when no provisioned identity has been confirmed. Use for every
// write of `Job.stackName` / `Asset.stackName` — never `currentRequestStackName`,
// which on the HTTP path is a raw client header.
export function currentDocumentStackName(): string | undefined {
  return stackContext.getStore()?.documentStackName;
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

// The shape a provisioned stack name can take: lowercase alphanumeric plus
// internal hyphens, 1-63 characters. Matches what the names this routes to
// actually are — a parameter-store key under STACK_CONFIG_NAMESPACE and a DNS
// label for the provisioned instances — so no legitimate stack name is rejected.
const STACK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Read the stack name off request headers. Single place the header name is
// spelled on the data-plane side, mirroring the control-plane read in
// src/routes/assets.ts (`request.headers['x-stack-name']`).
//
// The header is CLIENT-SUPPLIED and is used as a parameter-store lookup key and
// as a key in the resolver's per-name cache (`workspace-stack.ts:986`), so it is
// validated here, at the boundary, before it can reach either (issue #1097
// review, BLOCKING 2). A value that cannot name a stack is dropped rather than
// rejected with a 4xx: `resolve()` already treats an unroutable name as "use the
// workspace default" (a stale UI selection must not break routing,
// workspace-stack.ts:1167), and returning undefined here produces exactly that
// outcome — same behaviour, without the unvalidated string travelling onward.
//
// A repeated header (`string[]`) is also dropped: there is no single stack the
// request named, and picking one would be a guess.
export function requestStackNameFromHeaders(
  headers: IncomingHttpHeaders
): string | undefined {
  const raw = headers['x-stack-name'];
  if (typeof raw !== 'string') return undefined;
  const normalised = raw.trim().toLowerCase();
  return STACK_NAME_PATTERN.test(normalised) ? normalised : undefined;
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
