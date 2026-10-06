// Object-store stack identity: construction logging + a submit-time assertion
// that the resolved credential belongs to the stack the request routes to
// (issue #1093, interim mitigation from #1089, spun out of #1058).
//
// WHY THIS EXISTS
//
// Issue #1058 already refuses a submit when the DOCUMENT plane and the transcode
// CONTROL plane resolved different stacks (routes/assets.ts stackRoutingMismatch,
// comparing WorkspaceConnections.stackName against
// WorkspaceStackResolver.resolveStackName). That compares the stack the asset
// documents came from — NOT the object-store credential/endpoint the bytes are
// actually read and written with.
//
// Those two can disagree on their own. `s3Config` is built in one place per
// resolution path (workspace-stack.ts buildConnectionsFromStack /
// buildEnvConnections), but it is then carried, cached, re-read from the cache
// (`resolveCached`) and handed to runner factories (pipeline/runner-option.ts
// runnerS3Config) independently of the stack name. Every provisioned stack's
// source bucket carries the SAME literal name (routes/provision.ts), so a
// credential pointing at the wrong instance does not fail as "wrong stack" — it
// fails far downstream as an indistinguishable `NoSuchKey` from the transcoder.
//
// So the credential carries its OWN stack identity, tagged where the credential
// is built, and the submit path asserts that identity against the routed stack.
// A mismatch is a fail-fast error naming the expected and actual stack ids,
// instead of a 404/NoSuchKey hours later.
//
// WHERE THE TWO ASSERTIONS LIVE — read this before adding a third.
//
//   PRIMARY (#1093 mitigation). services/encore-s3-config.ts
//   resolveEncoreS3Config resolves the credential the SPAWNED TRANSCODER is
//   actually created with, independently of request.connections. When the
//   direct read for the routed stack misses, it used to fall back silently to
//   the FIRST provisioned stack's config — that is the production-reachable
//   mis-route, and it is the one that ends as NoSuchKey. It now refuses with
//   ObjectStoreStackMismatchError (below), keeping the fallback only for the
//   documented single-provisioned-stack deployment whose key is the fixed
//   DEPLOYMENT_CONTEXT rather than a stack name.
//
//   DEFENCE IN DEPTH. routes/assets.ts compares
//   request.connections.s3Config.stackName against the routed stack via
//   objectStoreStackMismatch below. Today those two are equal by construction
//   at every producer in workspace-stack.ts (both are set from the same
//   `stackName` local), so this check cannot fire on any path that exists now.
//   It is kept because the credential is carried, cached, re-read from the
//   resolver cache and handed to runner factories separately from the
//   connections — a future path that rebuilds, copies or injects an s3Config
//   can break that equality, and this is the cheap guard that catches it at the
//   edge. Do NOT cite it as the #1093 mitigation.
//
// IDENTITY, NOT HOSTNAME. The comparison is always on the parameter-store stack
// name. Endpoint HOSTNAMES legitimately differ for one and the same stack — the
// transcoder reads over the in-cluster Service address while the API uses the
// public ingress (issue #991, services/internal-minio-endpoint.ts) — so a
// hostname comparison would reject correct routing.
//
// NEVER LOGS A SECRET. The input types here deliberately expose only
// `stackName` and `endpoint`; no function in this module reads, copies, spreads
// or returns a secret field, and the log payload is assembled field by field
// from those two values only. Pass `s3Config` in by all means: its `secretKey`
// is never touched. Do not "simplify" any of this to a spread.
//
// Contract sources verified (CLAUDE.md rule 7):
//   - WorkspaceConnections.s3Config:
//       { endpoint: string; accessKey: string; secretKey: string;
//         stackName: string | undefined } | undefined
//     and WorkspaceConnections.stackName: string | undefined
//     (src/services/workspace-stack.ts, the WorkspaceConnections type).
//   - WorkspaceStackResolver.resolveStackName(requestedStackName?):
//       Promise<string | undefined>  — the routed (control-plane) stack identity
//     (src/services/workspace-stack.ts).
//   - StackConfig.minioEndpoint: string (src/services/param-store.ts).
//   - EncoreS3Config = { endpoint, accessKeyId, secretAccessKey, region? }
//     (src/encore-scaler/types.ts).

// Minimal logger surface. Structurally satisfied by Fastify's logger, by
// StackResolverLogger (services/workspace-stack.ts) and by
// EncoreS3ConfigLogger (services/encore-s3-config.ts). `info` is OPTIONAL so an
// error-only logger — which every pre-#1093 caller of those seams wired — still
// satisfies it; the construction log then simply no-ops rather than forcing a
// signature change on every test stub.
export type ObjectStoreClientLogger = {
  info?: ((obj: unknown, msg?: string) => void) | undefined;
};

// Stable log event name, so an operator can grep one token across the API's
// per-stack client and the transcoder's config path.
export const OBJECT_STORE_CLIENT_EVENT = 'object-store-client';

// Where an object-store client/credential was constructed. One literal per
// construction site so a log line is attributable without a stack trace.
export type ObjectStoreClientSource =
  // Per-stack client built from a provisioned stack record
  // (workspace-stack.ts buildConnectionsFromStack).
  | 'stack-resolver'
  // Client built from the explicit env-var override (COUCHDB_URL / MINIO_URL),
  // which is not a stack record and therefore has no stack identity.
  | 'env-override'
  // Object-store config handed to a spawned transcoder
  // (services/encore-s3-config.ts).
  | 'transcoder-config';

// The identity of a constructed object-store client. `endpoint` may be a full
// URL; only its HOST is ever logged.
export type ObjectStoreClientIdentity = {
  source: ObjectStoreClientSource;
  // Parameter-store stack name the client was built for, or undefined on the
  // paths that are not stack records (env override, in-memory fallback).
  stackName?: string | undefined;
  endpoint?: string | undefined;
  // Only for 'transcoder-config': the stack the caller ASKED for, when it
  // differs from the stack whose config was actually used.
  requestedStackName?: string | undefined;
};

// Host (hostname[:port]) of an object-store endpoint, or undefined when the
// value is absent/unparseable. Host only: a full endpoint URL can carry a query
// or userinfo component, and neither belongs in a log line.
export function objectStoreEndpointHost(
  endpoint: string | undefined
): string | undefined {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return undefined;
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

// The log payload for one client construction. Built field by field from
// `stackName` and `endpoint` ONLY — see the no-secret note in the header.
export function objectStoreClientLogFields(identity: ObjectStoreClientIdentity): {
  event: typeof OBJECT_STORE_CLIENT_EVENT;
  source: ObjectStoreClientSource;
  stackName: string | undefined;
  endpointHost: string | undefined;
  requestedStackName?: string;
} {
  return {
    event: OBJECT_STORE_CLIENT_EVENT,
    source: identity.source,
    stackName: identity.stackName,
    endpointHost: objectStoreEndpointHost(identity.endpoint),
    ...(identity.requestedStackName !== undefined &&
    identity.requestedStackName !== identity.stackName
      ? { requestedStackName: identity.requestedStackName }
      : {})
  };
}

// Log the stack identity of a freshly constructed object-store client
// (issue #1093): stack id + endpoint HOST only, never the access key secret.
//
// Emitted at info so it is present in normal operation — the whole point is to
// be able to tell, from logs alone, which stack a client was pointed at when a
// read later fails.
export function logObjectStoreClient(
  log: ObjectStoreClientLogger | undefined,
  identity: ObjectStoreClientIdentity
): void {
  log?.info?.(
    objectStoreClientLogFields(identity),
    'constructed an object-store client'
  );
}

// The identity-bearing fields of a resolved object-store credential. Satisfied
// structurally by WorkspaceConnections.s3Config; its `secretKey` is accepted
// (unavoidably, it is part of that object) and never read.
export type ResolvedObjectStoreCredential = {
  stackName?: string | undefined;
  endpoint?: string | undefined;
};

// A credential/endpoint resolved for a stack OTHER than the one the request
// routes to. `expectedStack` is the routed stack, `actualStack` the stack the
// credential was built for.
export type ObjectStoreStackMismatch = {
  expectedStack: string;
  actualStack: string;
  // Host of the mis-routed endpoint, for the log line. Never the secret.
  actualEndpointHost: string | undefined;
};

// Assert that `credential` belongs to `routedStack`. Returns the mismatch when
// the two stack identities are both known and DIFFER, otherwise undefined.
//
// Returns undefined (i.e. allows the submit, behaviour unchanged) when either
// identity is unknown:
//   - no credential at all (a stack with no object storage — the existing
//     not-configured paths already answer 501);
//   - a credential with no stack identity: the env-var override and the
//     in-memory fallback are not stack records (workspace-stack.ts
//     buildEnvConnections / buildInMemoryConnections set stackName: undefined);
//   - no routed stack: no resolver wired (tests, single-stack env deployments)
//     or no stack provisioned at all, in which case assets.ts falls back to the
//     fixed DEPLOYMENT_CONTEXT, which is not a stack name.
// In all of those there is nothing to compare, and inventing a mismatch would
// break correctly-routed single-stack deployments.
export function objectStoreStackMismatch(
  credential: ResolvedObjectStoreCredential | undefined,
  routedStack: string | undefined
): ObjectStoreStackMismatch | undefined {
  const actualStack = credential?.stackName;
  if (!actualStack || !routedStack) return undefined;
  if (actualStack === routedStack) return undefined;
  return {
    expectedStack: routedStack,
    actualStack,
    actualEndpointHost: objectStoreEndpointHost(credential?.endpoint)
  };
}

// Client-facing explanation of a credential/stack mismatch. Names both stack
// ids — expected (routed) and actual (credential) — so the caller can see which
// stack to name consistently via `X-Stack-Name`.
export function objectStoreStackMismatchMessage(
  mismatch: ObjectStoreStackMismatch
): string {
  return (
    `the object-store credential and endpoint resolved for this request belong to stack ` +
    `"${mismatch.actualStack}", but the request routes to stack "${mismatch.expectedStack}". ` +
    'Every stack uses the same bucket name, so reading the source with the wrong credential ' +
    'would fail as a missing-object error that names nothing. Retry naming one stack ' +
    'consistently via X-Stack-Name.'
  );
}

// Thrown when the object-store credential a transcode would actually be spawned
// with belongs to a stack OTHER than the one the request routes to
// (services/encore-s3-config.ts). A distinct type, not a bare Error, so the
// submit path can answer the SAME `409 stack_routing_mismatch` the document
// split (#1058) answers instead of a generic 502 — one error code for every
// routing split, as documented on POST /assets/:id/transcode.
//
// Carries identity ONLY: two stack ids and an endpoint HOST. No credential
// field exists on this class, so an error serialised into a log or a response
// body cannot carry the secret.
export class ObjectStoreStackMismatchError extends Error {
  readonly expectedStack: string;
  readonly actualStack: string;
  readonly actualEndpointHost: string | undefined;

  constructor(mismatch: ObjectStoreStackMismatch, messagePrefix?: string) {
    super(
      (messagePrefix ? `${messagePrefix}: ` : '') +
        objectStoreStackMismatchMessage(mismatch)
    );
    this.name = 'ObjectStoreStackMismatchError';
    this.expectedStack = mismatch.expectedStack;
    this.actualStack = mismatch.actualStack;
    this.actualEndpointHost = mismatch.actualEndpointHost;
  }
}

export function isObjectStoreStackMismatchError(
  err: unknown
): err is ObjectStoreStackMismatchError {
  return err instanceof ObjectStoreStackMismatchError;
}
