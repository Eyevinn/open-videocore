// Internal (in-cluster) MinIO endpoint for the Encore transcoders.
//
// Why: every Encore instance reads its source and writes its output through the
// `s3Endpoint` it is spawned with. That used to be the stack's PUBLIC MinIO
// ingress URL (`https://<tenant>-<name>.minio-minio.auto.<env>.osaas.io`), so one
// long, slow, single-connection GET (ffmpeg reading a presigned URL for a large
// source) crossed ingress-nginx and was severed mid-stream ("upstream
// prematurely closed connection while sending to client" -> ffmpeg "Stream ends
// prematurely" -> `io-retryable` retries exhausted; see
// docs/investigations/294-minio-ingress-longlived-connections.md). Encore and the
// MinIO instance run in the same cluster, so Encore can talk to the MinIO
// Service directly and skip the ingress entirely.
//
// Verified against the live Elastx (prod-se) cluster, 2026-09-29:
//   - a MinIO instance is a ClusterIP Service `<tenant>-<name>` in namespace
//     `minio-minio` (the serviceId), port `http` 8080 -> container port 8080
//     (the S3 API; Deployment env PORT=8080). Service port 80 is a dead
//     `proxy` port with nothing listening — do NOT use it.
//   - the public host is `<tenant>-<name>.minio-minio.auto.<env>.osaas.io`, i.e.
//     the first two DNS labels are exactly <service>.<namespace>.
//   - from a pod in the `encore` namespace, plain
//     `GET http://<svc>.minio-minio.svc.cluster.local:8080/minio/health/live`
//     returns 200; no NetworkPolicy blocks it.
//   - the public ingress serves ONLY the exact host (no bucket wildcard), so
//     Encore already uses path-style addressing, which is host-independent.
//
// Scope: ONLY the Encore hand-off uses this. Anything a browser/client receives
// (upload URLs, playback/asset URLs, API responses) is presigned/derived from
// the stack's public endpoint and MUST stay public — an in-cluster name is
// unresolvable outside the cluster and SigV4 signs the Host header.
//
// Safety: this is opt-out and FAILS SOFT. The internal name is only used after a
// live health probe from this process succeeds (proving DNS + connectivity from
// the cluster videocore shares with Encore). If the endpoint cannot be derived
// (unrecognised host shape, e.g. a bring-your-own MinIO), the probe fails, or
// the feature is switched off, the caller keeps the public endpoint and a
// warning is logged. It never throws.

import type { EncoreS3ConfigLogger } from './encore-s3-config.js';

// The serviceId / Kubernetes namespace every OSC MinIO instance lives in.
export const MINIO_SERVICE_NAMESPACE = 'minio-minio';

// The Service port that maps to the MinIO S3 API (see file header).
export const DEFAULT_MINIO_INTERNAL_PORT = 8080;

const HEALTH_PATH = '/minio/health/live';
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_POSITIVE_TTL_MS = 5 * 60_000;
const DEFAULT_NEGATIVE_TTL_MS = 30_000;

// Derive `http://<svc>.minio-minio.svc.cluster.local:<port>` from a stack's
// public MinIO endpoint. Returns undefined when the public URL is not an
// OSC-managed MinIO instance URL (host shape `<svc>.minio-minio.<domain...>`),
// so a bring-your-own or local-dev endpoint is never rewritten.
export function deriveInternalMinioEndpoint(
  publicEndpoint: string,
  port: number = DEFAULT_MINIO_INTERNAL_PORT
): string | undefined {
  let host: string;
  try {
    host = new URL(publicEndpoint).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const labels = host.split('.');
  // <svc>.minio-minio.<at least one more label>
  if (labels.length < 3) return undefined;
  const [service, namespace] = labels;
  if (namespace !== MINIO_SERVICE_NAMESPACE) return undefined;
  // DNS-1035 label: what a Kubernetes Service name can be.
  if (!service || !/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(service)) return undefined;
  return `http://${service}.${MINIO_SERVICE_NAMESPACE}.svc.cluster.local:${port}`;
}

export type InternalEndpointProbe = (internalEndpoint: string) => Promise<boolean>;

// Real probe: MinIO's unauthenticated liveness endpoint. Any thrown error
// (DNS failure, refused, timeout) is a negative result, never an exception.
export function makeHealthProbe(
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
  fetchFn: typeof fetch = fetch
): InternalEndpointProbe {
  return async (internalEndpoint) => {
    try {
      const res = await fetchFn(`${internalEndpoint}${HEALTH_PATH}`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs)
      });
      return res.status === 200;
    } catch {
      return false;
    }
  };
}

export type InternalEndpointResolverOptions = {
  // False when the operator opted out (ENCORE_S3_INTERNAL_ENDPOINT=off).
  enabled: boolean;
  port?: number;
  probe?: InternalEndpointProbe;
  log: Pick<EncoreS3ConfigLogger, 'error'> & { warn: (obj: unknown, msg?: string) => void };
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
};

// Maps a stack's public MinIO endpoint to the endpoint Encore should be spawned
// with. Always resolves; the result is either the internal URL (probe passed) or
// the input, unchanged.
export type EncoreEndpointResolver = (publicEndpoint: string) => Promise<string>;

export function makeInternalEndpointResolver(
  opts: InternalEndpointResolverOptions
): EncoreEndpointResolver {
  const port = opts.port ?? DEFAULT_MINIO_INTERNAL_PORT;
  const probe = opts.probe ?? makeHealthProbe();
  const positiveTtl = opts.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS;
  const negativeTtl = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const now = opts.now ?? Date.now;
  // Keyed by internal endpoint so one spawn burst does not probe per instance.
  const cache = new Map<string, { ok: boolean; expiresAt: number }>();

  return async (publicEndpoint) => {
    if (!opts.enabled) return publicEndpoint;

    const internal = deriveInternalMinioEndpoint(publicEndpoint, port);
    if (!internal) {
      opts.log.warn(
        { publicEndpoint },
        'encore-scaler: cannot derive an in-cluster MinIO endpoint from the stack endpoint; ' +
          'spawning Encore against the public endpoint (long transfers may be cut by the ingress)'
      );
      return publicEndpoint;
    }

    const cached = cache.get(internal);
    if (cached && cached.expiresAt > now()) {
      return cached.ok ? internal : publicEndpoint;
    }

    let ok = false;
    try {
      ok = await probe(internal);
    } catch {
      ok = false;
    }
    cache.set(internal, { ok, expiresAt: now() + (ok ? positiveTtl : negativeTtl) });
    if (!ok) {
      opts.log.warn(
        { internal, publicEndpoint },
        'encore-scaler: in-cluster MinIO endpoint failed its health probe; ' +
          'spawning Encore against the public endpoint (long transfers may be cut by the ingress)'
      );
      return publicEndpoint;
    }
    return internal;
  };
}
