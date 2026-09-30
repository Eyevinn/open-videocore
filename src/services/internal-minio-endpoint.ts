// In-cluster object-store endpoint for the transcoder hand-off (issue #991).
//
// WHY THIS EXISTS
//
// Every Encore instance the auto-scaler spawns reads its source and writes its
// output through the `s3Endpoint` it was created with
// (src/encore-scaler/instance-pool.ts:367-373). That value used to be the
// stack's PUBLIC object-store ingress URL, so a single long, slow HTTPS GET —
// ffmpeg reading a ~240 MB source through one presigned connection — crossed the
// platform ingress and was severed mid-stream:
//   ingress: "upstream prematurely closed connection while sending to client"
//   ffmpeg:  "Stream ends prematurely at ~15MB, should be ~240MB"
// The retry classifier calls that `io-retryable`
// (src/encore-scaler/retry-policy.ts), retries, and eventually gives up. The
// ingress read timeout was already determined to be non-configurable and the
// only mitigation found at the time was retry — see
// docs/investigations/294-minio-ingress-longlived-connections.md (issues #293 /
// #294). Neither of those took the ingress OUT of the data path. This module
// does: the transcoders and the object store run in the SAME cluster, so the
// transcoder can address the object store's in-cluster Service directly and the
// long transfer never touches the ingress.
//
// HOW THE IN-CLUSTER ADDRESS IS RESOLVED — platform SDK first, derivation second
//
// PRIMARY: the platform SDK. `@osaas/client-core` (0.24.0, already a dependency)
// exposes the in-cluster address of an instance as a first-class contract, so
// this module asks the platform rather than inferring:
//
//   export interface InternalEndpointInfo {
//     serviceDns: string;
//     ports: Array<{ name: string; port: number; protocol: string }>;
//     publicAccess: boolean;
//   }
//   export declare function getInternalEndpoint(
//     context: Context, serviceId: string, name: string, token: string
//   ): Promise<InternalEndpointInfo>;
//
//   — node_modules/@osaas/client-core/lib/core.d.ts:130-148, re-exported from
//     lib/index.d.ts:6. Token via
//     `Context.getServiceAccessToken(serviceId): Promise<string>`
//     (lib/context.d.ts:25).
//
// `serviceDns` is authoritative and is used as-is. The Service PORT is taken
// from `ports` WHEN THAT ARRAY IS NON-EMPTY; see the next paragraph for why a
// fallback is still required.
//
// The instance name the SDK call needs is already stored: the stack config
// carries `services: { serviceId, instanceName }[]`
// (src/services/param-store.ts), and the object-store serviceId is
// OBJECT_STORE_SERVICE_ID (src/services/stack.ts STACK_SERVICES). The caller
// (services/encore-s3-config.ts) reads it from the config it has already
// loaded, so this costs no extra parameter-store round trip.
//
// FALLBACK: derivation from the stored PUBLIC endpoint. Two distinct cases make
// this necessary, so it is kept rather than deleted:
//   1. PORT — verified live against prod-se on 2026-09-30, `getInternalEndpoint`
//      returns `ports: []` for a RUNNING object-store instance, e.g.
//        { serviceDns: '<tenant>-<instance>.minio-minio.svc.cluster.local',
//          ports: [], publicAccess: true }
//      so the platform does not currently expose the Service port for this
//      service. The port therefore falls back to DEFAULT_INTERNAL_PORT (8080),
//      overridable with ENCORE_S3_INTERNAL_PORT. Logged as OSC friction in
//      `docs/osc-feedback/incoming-issue991-minio-internal-port-not-exposed.md`.
//   2. HOST — the `internalEndpoint` link is resolved per instance and the SDK
//      THROWS when the instance or that link is absent (lib/core.js
//      getInstanceLink), and an instance may be missing from the stored
//      `services[]` on an older stack config. Any such failure falls back to
//      deriving the host from the public endpoint instead of giving up.
//
// The derivation itself, verified against the live prod-se cluster, read-only,
// 2026-09-29 (recorded in issue #991's "Verified" section):
//   - an object-store instance is a ClusterIP Service `<service>` in the
//     namespace named after its serviceId, `minio-minio`; Service port `http`
//     8080 -> container 8080 (the S3 API; the Deployment sets PORT=8080).
//     Service port 80 (`proxy`) has NOTHING behind it — it must not be used.
//   - the public host is `<service>.minio-minio.auto.<env>.osaas.io`, i.e. its
//     first two DNS labels are exactly `<service>.<namespace>`, and they match
//     the first two labels of the `serviceDns` the SDK returns. The in-cluster
//     name is therefore DERIVABLE from the stored public endpoint, with no new
//     stack-config field and no data migration:
//       http://<service>.minio-minio.svc.cluster.local:8080
//   - from a pod in the transcoder namespace, a plain
//     `GET http://<service>.minio-minio.svc.cluster.local:8080/minio/health/live`
//     returned 200 in 23 ms; the only NetworkPolicies in the cluster
//     (`elx-patches-deny-all`, `elx-jobs-netpol`) cover neither workload.
//   - the public ingress serves only the exact host (no bucket wildcard), so the
//     transcoder already addresses buckets path-style, which is host-independent.
//     Changing the endpoint consistently therefore keeps the signed host and the
//     fetched host equal: the transcoder presigns the bare `s3://bucket/key`
//     input (src/pipeline/transcode.ts:120-121) with the endpoint it was spawned
//     with, so nothing else has to change.
//
// This derivation is the same shape as the existing internal-DNS derivation for
// the queue (src/routes/provision.ts redisUrlFrom, which rewrites the instance
// host to `<instance>.<serviceId>.svc.cluster.local:6379`) — this one matches on
// the leading `<service>.<namespace>` labels instead of a fixed public suffix, so
// it works on every environment domain rather than only `.auto.prod.osaas.io`.
//
// EITHER WAY the candidate is PROBED before use (see SAFETY below), so a wrong
// port or a stale DNS name degrades to the public endpoint rather than to a
// broken transcode.
//
// SCOPE — what must stay PUBLIC
//
// Only the server-to-transcoder hand-off is rewritten. Anything a browser or an
// API client receives keeps the stack's public endpoint, because SigV4 signs the
// Host header and an in-cluster name does not resolve outside the cluster:
// presigned upload URLs (WorkspaceStorage.presignedPut / presignedUploadPart,
// src/data/storage.ts:124-205), playback/delivery/asset URLs, and every API
// response. Those are built from the storage client the stack resolver
// constructs from the STORED public `StackConfig.minioEndpoint`
// (src/services/workspace-stack.ts buildConnectionsFromStack) — a path this
// module is deliberately NOT wired into. The full sibling-path audit is
// docs/investigations/991-internal-object-store-endpoint-paths.md.
//
// SAFETY — opt-out, and FAIL SOFT
//
// CLAUDE.md warns that `svc.cluster.local` does not resolve cross-cluster, so
// this can never be assumed. It is therefore:
//   - OPT-OUT (ENCORE_S3_INTERNAL_ENDPOINT=off) — one env var returns the old
//     behaviour with no redeploy of anything else;
//   - PROBED — the in-cluster name is used only after a live health probe from
//     THIS process succeeds, proving DNS + connectivity from the cluster this API
//     shares with the transcoders;
//   - FAIL SOFT — a non-derivable host, a failed probe, or a probe that throws
//     all return the caller's public endpoint and log a warning. Nothing here
//     throws, and nothing here can fail startup.
//
// Known limit of the probe (honest, not hidden): it proves reachability from the
// API pod, not from the transcoder pod. Those are different namespaces in the
// same cluster and the cluster has no NetworkPolicy separating them (verified
// above), so API reachability is a sound proxy — but it IS a proxy. A live
// transcode of a comparable source is the operator verification step recorded in
// the audit doc.
//
// CONTRACT SOURCES VERIFIED (CLAUDE.md rule 7):
//   - `getInternalEndpoint(context: Context, serviceId: string, name: string,
//     token: string): Promise<InternalEndpointInfo>` and
//     `InternalEndpointInfo = { serviceDns: string; ports: Array<{ name: string;
//     port: number; protocol: string }>; publicAccess: boolean }` —
//     node_modules/@osaas/client-core/lib/core.d.ts:130-148 (package version
//     0.24.0), re-exported from lib/index.d.ts:6.
//   - `Context.getServiceAccessToken(serviceId: string): Promise<string>`
//     (@osaas/client-core lib/context.d.ts:25).
//   - `StackConfig.minioEndpoint: string` — the stored PUBLIC endpoint the
//     fallback derives from, and `StackConfig.services: { serviceId: string;
//     instanceName: string }[]` — where the caller finds the instance name for
//     the SDK call (src/services/param-store.ts:52-95).
//   - Object-store serviceId `OBJECT_STORE_SERVICE_ID = 'minio-minio'`
//     (src/services/stack.ts, the single source of truth STACK_SERVICES is
//     built from).
//   - `EncoreS3Config = { endpoint, accessKeyId, secretAccessKey, region? }`
//     (src/encore-scaler/types.ts:24-29) — `endpoint` is the field the spawn
//     body's `s3Endpoint` is taken from (src/encore-scaler/instance-pool.ts:369).
//   - `WorkspaceEncoreScalerConfig.resolveS3Config?: (stackKey: string) =>
//     Promise<EncoreS3Config | undefined>` (src/encore-scaler/
//     workspace-registry.ts:88), consumed at BOTH spawn paths
//     (workspace-registry.ts:206-209 getOrCreate, :346-351
//     resumeExistingWorkspaces) — so hooking the single
//     `resolveEncoreS3Config` seam covers both.
//   - Liveness path `/minio/health/live`: unauthenticated object-store liveness
//     probe, observed returning 200 on the live Service in the #991
//     verification. Unauthenticated on purpose — the probe carries no credential.
//   - Env-parse helper shape mirrors `resolveJobThroughputCap(env:
//     NodeJS.ProcessEnv = process.env)`
//     (src/encore-scaler/job-throughput-cap.ts:90-98), and the injectable
//     `FetchLike` probe seam mirrors `services/profiles-reachability.ts`.

import { getInternalEndpoint, type Context, type InternalEndpointInfo } from '@osaas/client-core';
import { OBJECT_STORE_SERVICE_ID } from './stack.js';

// Kubernetes namespace every provisioned object-store instance lives in, and
// the second DNS label of its public host. On the platform an instance's
// namespace is named after its serviceId, so this IS OBJECT_STORE_SERVICE_ID —
// re-exported under a name that says which role it plays here, from the single
// source of truth in services/stack.ts rather than a second literal.
export const OBJECT_STORE_NAMESPACE = OBJECT_STORE_SERVICE_ID;

// Service port that maps to the S3 API container port (see the header: port 80
// on the same Service is a dead `proxy` port — do not use it). Used when the
// platform does not report a port for the instance, which is the case today:
// `getInternalEndpoint` returns `ports: []` for a running object-store instance
// (verified live 2026-09-30, see the header).
export const DEFAULT_INTERNAL_PORT = 8080;

// Unauthenticated liveness path used by the probe.
export const INTERNAL_HEALTH_PATH = '/minio/health/live';

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

// How long a probe outcome is reused. A burst of spawns must not turn into a
// burst of probes, but a cluster that becomes reachable (or stops being
// reachable) should be noticed without redeploying. The negative TTL is short
// and the positive TTL is long because the steady state is "reachable".
//
// SCOPE OF RECOVERY, precisely: this cache is consulted on every call into the
// resolver, but the resolver is only CALLED when the scaler builds a workspace
// loop — `resolveS3Config` runs at loop-creation time and the resulting
// `EncoreS3Config` is then held by that loop (workspace-registry.ts). So a
// recovered cluster path is picked up by NEWLY CREATED loops (a new workspace,
// or any workspace whose loop is rebuilt) and after a restart; it does not
// retro-fit an endpoint into a loop that is already running with the public
// one. That is the intended trade-off — the fallback is correct, just slower —
// and it is why the negative TTL is kept short rather than made adaptive.
const DEFAULT_POSITIVE_TTL_MS = 5 * 60_000;
const DEFAULT_NEGATIVE_TTL_MS = 30_000;

// A DNS-1035 label: what a Kubernetes Service name is allowed to be. Used to
// refuse to fabricate an in-cluster name from a host label that could not be a
// Service name.
const DNS_1035_LABEL = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

const INTERNAL_SUFFIX = '.svc.cluster.local';

// Outcome of trying to derive an in-cluster endpoint from a public one.
//   derived          — a usable in-cluster URL (still has to pass the probe)
//   already-internal — the caller already holds an in-cluster address; leave it
//                      alone and do not warn (an operator may have pinned one)
//   not-derivable    — not a recognisable managed object-store host (local dev,
//                      a bring-your-own store, an IP, a malformed URL). `reason`
//                      is log/diagnostic text, never surfaced to a client.
export type InternalEndpointDerivation =
  | { kind: 'derived'; endpoint: string }
  | { kind: 'already-internal' }
  | { kind: 'not-derivable'; reason: string };

/**
 * Derive `http://<service>.minio-minio.svc.cluster.local:<port>` from a stack's
 * PUBLIC object-store endpoint. Pure and side-effect free — reachability is the
 * probe's job, not this function's.
 *
 * Only a host whose first two labels are `<service>.minio-minio` is rewritten,
 * so a bring-your-own or local-dev endpoint is never touched.
 */
export function deriveInternalEndpoint(
  publicEndpoint: string,
  port: number = DEFAULT_INTERNAL_PORT
): InternalEndpointDerivation {
  let hostname: string;
  try {
    hostname = new URL(publicEndpoint).hostname.toLowerCase();
  } catch {
    return { kind: 'not-derivable', reason: 'endpoint is not a parsable URL' };
  }
  if (hostname.endsWith(INTERNAL_SUFFIX)) {
    return { kind: 'already-internal' };
  }
  const labels = hostname.split('.');
  // `<service>.<namespace>.<at least one domain label>`: a two-label host is
  // never a public managed-instance host, and rewriting it would be a guess.
  if (labels.length < 3) {
    return {
      kind: 'not-derivable',
      reason: 'host has fewer than three DNS labels, so it is not a managed instance host'
    };
  }
  const service = labels[0] ?? '';
  const namespace = labels[1];
  if (namespace !== OBJECT_STORE_NAMESPACE) {
    return {
      kind: 'not-derivable',
      reason: `second host label is "${namespace}", not "${OBJECT_STORE_NAMESPACE}"`
    };
  }
  if (!DNS_1035_LABEL.test(service)) {
    return {
      kind: 'not-derivable',
      reason: 'first host label is not a valid Kubernetes Service name'
    };
  }
  return {
    kind: 'derived',
    endpoint: `http://${service}.${OBJECT_STORE_NAMESPACE}${INTERNAL_SUFFIX}:${port}`
  };
}

// ---------------------------------------------------------------------------
// PRIMARY SOURCE: the platform SDK's internal-endpoint contract.
// ---------------------------------------------------------------------------

// Ask the platform for one instance's in-cluster endpoint info. Resolves
// `undefined` rather than throwing when the instance, the `internalEndpoint`
// link, or the call itself is unavailable — the caller then falls back to
// deriving the host. The return type is the SDK's own `InternalEndpointInfo`
// (@osaas/client-core lib/core.d.ts:130-136), so this seam cannot drift from
// the contract without a type error.
export type InternalEndpointLookup = (
  instanceName: string
) => Promise<InternalEndpointInfo | undefined>;

// The subset of the SDK's `getInternalEndpoint` signature this module uses,
// named so tests can substitute it without constructing a real Context
// (@osaas/client-core lib/core.d.ts:148).
export type GetInternalEndpointFn = (
  context: Context,
  serviceId: string,
  name: string,
  token: string
) => Promise<InternalEndpointInfo>;

/**
 * Production lookup: mint a service access token for the object-store service
 * and call the SDK's `getInternalEndpoint`.
 *
 * Contract (verified, CLAUDE.md rule 7):
 *   - `Context.getServiceAccessToken(serviceId: string): Promise<string>`
 *     (@osaas/client-core lib/context.d.ts:25)
 *   - `getInternalEndpoint(context, serviceId, name, token):
 *     Promise<InternalEndpointInfo>` (lib/core.d.ts:148)
 *
 * Fail-soft by construction: the SDK throws when the instance or its
 * `internalEndpoint` link is missing (lib/core.js `getInstanceLink`), and this
 * turns every such failure into `undefined`.
 */
export function makeOscInternalEndpointLookup(opts: {
  oscContext: Context;
  serviceId?: string;
  getInternalEndpointImpl?: GetInternalEndpointFn;
  log?: InternalEndpointLogger;
}): InternalEndpointLookup {
  const serviceId = opts.serviceId ?? OBJECT_STORE_SERVICE_ID;
  const impl = opts.getInternalEndpointImpl ?? (getInternalEndpoint as GetInternalEndpointFn);
  return async (instanceName) => {
    try {
      const token = await opts.oscContext.getServiceAccessToken(serviceId);
      return await impl(opts.oscContext, serviceId, instanceName, token);
    } catch (err) {
      opts.log?.warn(
        { err, serviceId, instanceName },
        'encore-scaler: the platform internal-endpoint lookup failed — falling back to ' +
          'deriving the in-cluster address from the stack\'s public endpoint (issue #991)'
      );
      return undefined;
    }
  };
}

// Ports the platform may report that must NOT be treated as the S3 API. The
// object store's Service also exposes a `proxy` port with nothing behind it
// (verified on the live cluster, see the header), so picking it would produce a
// candidate that fails its probe and silently costs us the fix.
const NON_S3_PORT_NAMES = new Set(['proxy']);

/**
 * Choose the Service port for the S3 API from what the platform reported.
 *
 * `ports` is EMPTY for object-store instances today (verified live 2026-09-30 —
 * see the header and the OSC friction log), so `fallbackPort` is what is
 * actually used in production right now. The selection logic exists so that the
 * moment the platform does start reporting ports, they are preferred over the
 * hard-coded default with no further change here.
 *
 * Preference order: a port explicitly named `http`, then the first port not on
 * the known-dead list, then the first port, then `fallbackPort`.
 */
export function selectInternalPort(
  ports: InternalEndpointInfo['ports'] | undefined,
  fallbackPort: number
): number {
  if (!ports || ports.length === 0) return fallbackPort;
  const named = ports.find((p) => p.name === 'http');
  if (named) return named.port;
  const usable = ports.find((p) => !NON_S3_PORT_NAMES.has(p.name));
  return (usable ?? ports[0]!).port;
}

/**
 * Build the in-cluster URL from a platform `InternalEndpointInfo`. Returns
 * undefined when the platform reported no usable `serviceDns`, so the caller
 * falls back to derivation rather than fabricating `http://:8080`.
 */
export function internalEndpointFromInfo(
  info: InternalEndpointInfo | undefined,
  fallbackPort: number
): string | undefined {
  const dns = info?.serviceDns?.trim();
  if (!dns) return undefined;
  return `http://${dns}:${selectInternalPort(info?.ports, fallbackPort)}`;
}

// Injectable fetch seam so the probe is unit-testable without network I/O.
// Shape mirrors services/profiles-reachability.ts FetchLike; the global `fetch`
// satisfies it. The probe target is plain http inside the cluster, so there is
// no TLS handling here at all.
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; method?: string }
) => Promise<{ status: number }>;

// Returns true when the in-cluster endpoint answered its liveness probe. MUST
// NOT throw — every failure mode (DNS, refused, timeout, non-2xx) is `false`.
export type EndpointProbe = (internalEndpoint: string) => Promise<boolean>;

/**
 * The production probe: an unauthenticated, bounded GET of the object store's
 * liveness path. Every failure is a negative result rather than an exception, so
 * a caller can treat the probe as "is this usable?" with no error handling of
 * its own.
 */
export function makeInternalEndpointProbe(
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): EndpointProbe {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  return async (internalEndpoint) => {
    try {
      const res = await fetchImpl(`${internalEndpoint}${INTERNAL_HEALTH_PATH}`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs)
      });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  };
}

export type InternalEndpointLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

// Maps a stack's PUBLIC object-store endpoint to the endpoint a spawned
// transcoder should be given. ALWAYS resolves: the result is either the
// in-cluster URL (resolved AND probed healthy) or the input, unchanged.
//
// `instanceName` is the stack's object-store instance name, read by the caller
// from `StackConfig.services` (src/services/param-store.ts). It is OPTIONAL: it
// is what lets the resolver ask the platform via `getInternalEndpoint`, and
// without it the resolver falls back to deriving the host from the public
// endpoint — which is also what happens for a stack config old enough not to
// carry a `services[]` entry for the object store.
export type EncoreEndpointResolver = (
  publicEndpoint: string,
  instanceName?: string
) => Promise<string>;

export type InternalEndpointResolverOptions = {
  // False when the operator opted out (ENCORE_S3_INTERNAL_ENDPOINT=off). When
  // false the resolver is a pure pass-through and never probes and never calls
  // the platform.
  enabled: boolean;
  // PRIMARY source of the in-cluster address: the platform's own
  // `getInternalEndpoint` contract, wrapped by makeOscInternalEndpointLookup.
  // Optional so a deployment (or a test) with no OSC context still works —
  // absent means "derive only".
  lookup?: InternalEndpointLookup;
  // Service port for the S3 API, used when the platform reports no port for the
  // instance — which is the case for object-store today (`ports: []`). Typed
  // option, not read from the environment here: env vars are read only in the
  // entrypoint (src/main.ts).
  port?: number;
  // Injectable for tests; defaults to the live liveness probe above.
  probe?: EndpointProbe;
  probeTimeoutMs?: number;
  log: InternalEndpointLogger;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
};

// Where a candidate in-cluster endpoint came from. Carried into the logs so an
// operator can tell "the platform told us" from "we inferred it".
type CandidateSource = 'platform' | 'derived';

/**
 * Build the fail-soft resolver wired into `resolveEncoreS3Config`
 * (services/encore-s3-config.ts), which is the single seam both scaler spawn
 * paths take.
 *
 * Guarantees, in order of importance:
 *   1. it never throws and never rejects — a caller can always await it and use
 *      the result directly;
 *   2. when anything is unknown, unreachable, or switched off, it returns the
 *      public endpoint the caller passed in, i.e. exactly today's behaviour;
 *   3. it probes at most once per in-cluster endpoint per TTL window, so a
 *      scale-up burst does not become a probe burst.
 */
export function makeInternalEndpointResolver(
  opts: InternalEndpointResolverOptions
): EncoreEndpointResolver {
  const port = opts.port ?? DEFAULT_INTERNAL_PORT;
  const probe =
    opts.probe ??
    makeInternalEndpointProbe(
      opts.probeTimeoutMs === undefined ? {} : { timeoutMs: opts.probeTimeoutMs }
    );
  const positiveTtlMs = opts.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS;
  const negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const now = opts.now ?? Date.now;

  // Keyed by the derived in-cluster endpoint. Bounded by the number of
  // provisioned stacks, like the scaler's own per-stack caches.
  const cache = new Map<string, { healthy: boolean; expiresAt: number }>();
  // In-flight de-duplication: N concurrent spawns for one stack share one probe.
  const inFlight = new Map<string, Promise<boolean>>();

  const probeOnce = async (internalEndpoint: string): Promise<boolean> => {
    const cached = cache.get(internalEndpoint);
    if (cached && cached.expiresAt > now()) return cached.healthy;

    const existing = inFlight.get(internalEndpoint);
    if (existing) return existing;

    const pending = (async () => {
      let healthy = false;
      try {
        healthy = await probe(internalEndpoint);
      } catch {
        // The probe contract says it resolves false rather than throwing; this
        // guard means a custom probe that breaks that contract still fails soft.
        healthy = false;
      }
      cache.set(internalEndpoint, {
        healthy,
        expiresAt: now() + (healthy ? positiveTtlMs : negativeTtlMs)
      });
      return healthy;
    })();
    inFlight.set(internalEndpoint, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(internalEndpoint);
    }
  };

  // Cache of the PLATFORM lookup, keyed by instance name, so a scale-up burst
  // costs one `getInternalEndpoint` call rather than one per spawn. Holds the
  // built URL (or undefined when the platform could not answer) with the same
  // positive/negative TTLs as the probe.
  const lookupCache = new Map<string, { endpoint: string | undefined; expiresAt: number }>();
  const lookupInFlight = new Map<string, Promise<string | undefined>>();
  const lookup = opts.lookup;

  const lookupOnce = async (instanceName: string): Promise<string | undefined> => {
    const cached = lookupCache.get(instanceName);
    if (cached && cached.expiresAt > now()) return cached.endpoint;

    const existing = lookupInFlight.get(instanceName);
    if (existing) return existing;

    const pending = (async () => {
      let endpoint: string | undefined;
      try {
        // The lookup contract says it resolves undefined rather than throwing;
        // this guard means a custom lookup that breaks that contract still
        // fails soft to derivation.
        endpoint = internalEndpointFromInfo(await lookup?.(instanceName), port);
      } catch {
        endpoint = undefined;
      }
      lookupCache.set(instanceName, {
        endpoint,
        expiresAt: now() + (endpoint ? positiveTtlMs : negativeTtlMs)
      });
      return endpoint;
    })();
    lookupInFlight.set(instanceName, pending);
    try {
      return await pending;
    } finally {
      lookupInFlight.delete(instanceName);
    }
  };

  return async (publicEndpoint, instanceName) => {
    if (!opts.enabled) return publicEndpoint;

    // An endpoint that is ALREADY in-cluster is left alone — an operator may
    // have pinned one deliberately, and there is nothing to resolve.
    if (deriveInternalEndpoint(publicEndpoint, port).kind === 'already-internal') {
      return publicEndpoint;
    }

    // PRIMARY: ask the platform. `serviceDns` is authoritative; the port comes
    // from `ports` when the platform reports any, and otherwise falls back to
    // `port` (today's object-store reality — see the header).
    let candidate: string | undefined;
    let source: CandidateSource = 'platform';
    if (lookup && instanceName) {
      candidate = await lookupOnce(instanceName);
    }

    // FALLBACK: derive the host from the stored public endpoint. Reached when
    // there is no lookup wired, no instance name in the stack config, or the
    // platform could not answer for this instance.
    if (!candidate) {
      source = 'derived';
      const derivation = deriveInternalEndpoint(publicEndpoint, port);
      if (derivation.kind === 'not-derivable') {
        opts.log.warn(
          { publicEndpoint, instanceName, reason: derivation.reason },
          'encore-scaler: no in-cluster object-store endpoint could be resolved for this stack — ' +
            'the platform internal-endpoint lookup gave nothing usable and the public endpoint is ' +
            'not of a derivable shape. Spawning the transcoder against the public endpoint, where ' +
            'a long single-connection read of a large source can be cut by the ingress (issue #991)'
        );
        return publicEndpoint;
      }
      // `already-internal` is impossible here: it was handled above.
      candidate = derivation.kind === 'derived' ? derivation.endpoint : undefined;
      if (!candidate) return publicEndpoint;
    }

    const internalEndpoint = candidate;
    const wasHealthy = cache.get(internalEndpoint)?.healthy;
    const healthy = await probeOnce(internalEndpoint);
    if (!healthy) {
      opts.log.warn(
        { internalEndpoint, publicEndpoint, source },
        'encore-scaler: the in-cluster object-store endpoint failed its health probe — ' +
          'spawning the transcoder against the public endpoint instead (issue #991). ' +
          'Expected when this API and the transcoders are not in the same cluster.'
      );
      return publicEndpoint;
    }
    // Log the adoption on the first pass and on any unhealthy -> healthy flip,
    // so an operator can confirm from the logs that transcodes stopped crossing
    // the ingress, without a line per spawn. `source` says whether the address
    // came from the platform contract or from the fallback derivation.
    if (wasHealthy !== true) {
      opts.log.info(
        { internalEndpoint, source },
        'encore-scaler: using the in-cluster object-store endpoint for transcoder ' +
          'reads/writes (issue #991); client-facing URLs stay public'
      );
    }
    return internalEndpoint;
  };
}

// Typed settings the entrypoint resolves from the environment and passes in.
export type InternalEndpointSettings = {
  enabled: boolean;
  port: number;
  probeTimeoutMs: number;
};

// Values of ENCORE_S3_INTERNAL_ENDPOINT that mean "opt out".
const OPT_OUT_VALUES = new Set(['off', 'false', '0', 'no', 'disabled']);

/**
 * Resolve the in-cluster-endpoint settings from the environment (12-factor:
 * config via env, parsed in one place). Shape mirrors
 * `resolveJobThroughputCap(env)`.
 *
 *   ENCORE_S3_INTERNAL_ENDPOINT            off|false|0|no|disabled => opt out.
 *                                          Anything else (including unset) =>
 *                                          enabled, because the in-cluster path
 *                                          is only ever used after a live probe.
 *   ENCORE_S3_INTERNAL_PORT                Service port (default 8080).
 *   ENCORE_S3_INTERNAL_PROBE_TIMEOUT_MS    probe timeout (default 3000).
 *
 * Invalid values fall back to the default rather than failing startup: a typo in
 * an optional tuning knob must not take the API down.
 */
export function resolveInternalEndpointSettings(
  env: NodeJS.ProcessEnv = process.env
): InternalEndpointSettings {
  const rawEnabled = (env['ENCORE_S3_INTERNAL_ENDPOINT'] ?? '').trim().toLowerCase();
  const enabled = !OPT_OUT_VALUES.has(rawEnabled);

  const rawPort = Number.parseInt(env['ENCORE_S3_INTERNAL_PORT'] ?? '', 10);
  const port =
    Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65_536 ? rawPort : DEFAULT_INTERNAL_PORT;

  const rawTimeout = Number.parseInt(env['ENCORE_S3_INTERNAL_PROBE_TIMEOUT_MS'] ?? '', 10);
  const probeTimeoutMs =
    Number.isInteger(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_PROBE_TIMEOUT_MS;

  return { enabled, port, probeTimeoutMs };
}
