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
// DERIVATION — verified against the live prod-se cluster, read-only, 2026-09-29
// (recorded in issue #991's "Verified" section):
//   - an object-store instance is a ClusterIP Service `<instance>` in the
//     namespace named after its serviceId, `minio-minio`; Service port `http`
//     8080 -> container 8080 (the S3 API; the Deployment sets PORT=8080).
//     Service port 80 (`proxy`) has NOTHING behind it — it must not be used.
//   - the public host is `<instance>.minio-minio.auto.<env>.osaas.io`, i.e. its
//     first two DNS labels are exactly `<service>.<namespace>`. The in-cluster
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
//   - `StackConfig.minioEndpoint: string` — the stored PUBLIC endpoint this
//     derives from (src/services/param-store.ts:52-95).
//   - `EncoreS3Config = { endpoint, accessKeyId, secretAccessKey, region? }`
//     (src/encore-scaler/types.ts:24-29) — `endpoint` is the field the spawn
//     body's `s3Endpoint` is taken from (src/encore-scaler/instance-pool.ts:369).
//   - `WorkspaceEncoreScalerConfig.resolveS3Config?: (stackKey: string) =>
//     Promise<EncoreS3Config | undefined>` (src/encore-scaler/
//     workspace-registry.ts:88), consumed at BOTH spawn paths
//     (workspace-registry.ts:206-209 getOrCreate, :346-351
//     resumeExistingWorkspaces) — so hooking the single
//     `resolveEncoreS3Config` seam covers both.
//   - Object-store serviceId / namespace `minio-minio`
//     (src/services/stack.ts STACK_SERVICES, quoted in
//     docs/investigations/294-minio-ingress-longlived-connections.md).
//   - Liveness path `/minio/health/live`: unauthenticated object-store liveness
//     probe, observed returning 200 on the live Service in the #991
//     verification. Unauthenticated on purpose — the probe carries no credential.
//   - Env-parse helper shape mirrors `resolveJobThroughputCap(env:
//     NodeJS.ProcessEnv = process.env)`
//     (src/encore-scaler/job-throughput-cap.ts:90-98), and the injectable
//     `FetchLike` probe seam mirrors `services/profiles-reachability.ts`.

// Kubernetes namespace (== the OSC serviceId) every provisioned object-store
// instance lives in, and the second DNS label of its public host.
export const OBJECT_STORE_NAMESPACE = 'minio-minio';

// Service port that maps to the S3 API container port (see the header: port 80
// on the same Service is a dead `proxy` port — do not use it).
export const DEFAULT_INTERNAL_PORT = 8080;

// Unauthenticated liveness path used by the probe.
export const INTERNAL_HEALTH_PATH = '/minio/health/live';

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

// How long a probe outcome is reused. A burst of spawns must not turn into a
// burst of probes, but a cluster that becomes reachable (or stops being
// reachable) has to be noticed without a restart. The negative TTL is short so
// recovery is fast; the positive TTL is long because the steady state is
// "reachable".
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
// in-cluster URL (derivable AND probed healthy) or the input, unchanged.
export type EncoreEndpointResolver = (publicEndpoint: string) => Promise<string>;

export type InternalEndpointResolverOptions = {
  // False when the operator opted out (ENCORE_S3_INTERNAL_ENDPOINT=off). When
  // false the resolver is a pure pass-through and never probes.
  enabled: boolean;
  // Service port for the S3 API. Typed option, not read from the environment
  // here: env vars are read only in the entrypoint (src/main.ts).
  port?: number;
  // Injectable for tests; defaults to the live liveness probe above.
  probe?: EndpointProbe;
  probeTimeoutMs?: number;
  log: InternalEndpointLogger;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
};

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

  return async (publicEndpoint) => {
    if (!opts.enabled) return publicEndpoint;

    const derivation = deriveInternalEndpoint(publicEndpoint, port);
    if (derivation.kind === 'already-internal') {
      return publicEndpoint;
    }
    if (derivation.kind === 'not-derivable') {
      opts.log.warn(
        { publicEndpoint, reason: derivation.reason },
        'encore-scaler: no in-cluster object-store endpoint could be derived for this stack — ' +
          'spawning the transcoder against the public endpoint, where a long single-connection ' +
          'read of a large source can be cut by the ingress (issue #991)'
      );
      return publicEndpoint;
    }

    const internalEndpoint = derivation.endpoint;
    const wasHealthy = cache.get(internalEndpoint)?.healthy;
    const healthy = await probeOnce(internalEndpoint);
    if (!healthy) {
      opts.log.warn(
        { internalEndpoint, publicEndpoint },
        'encore-scaler: the in-cluster object-store endpoint failed its health probe — ' +
          'spawning the transcoder against the public endpoint instead (issue #991). ' +
          'Expected when this API and the transcoders are not in the same cluster.'
      );
      return publicEndpoint;
    }
    // Log the adoption on the first pass and on any unhealthy -> healthy flip,
    // so an operator can confirm from the logs that transcodes stopped crossing
    // the ingress, without a line per spawn.
    if (wasHealthy !== true) {
      opts.log.info(
        { internalEndpoint },
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
