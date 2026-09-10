// Per-stack dependency reachability preflight (issue #617, parent #602).
//
// PROBLEM: an unreachable dependency in a provisioned stack (the Valkey queue,
// the MinIO/S3 storage endpoint, or Encore) was invisible until a request hung
// and the inbound socket was dropped (~50s) with no HTTP status, no body, and
// nothing logged for the caller. The only recovery operators found was
// delete-and-recreate. This module turns that silent hang into an up-front,
// actionable, per-dependency signal.
//
// It is surfaced two ways by its callers (this module owns neither route):
//   (a) a FAST preflight guard on the transcode path — routes/assets.ts races
//       the same bounded probes BEFORE enqueuing work, and rejects an unhealthy
//       stack with the existing named-dependency 504 (DependencyUnreachableError,
//       issue #616) rather than hanging.
//   (b) a read-only diagnostics endpoint — routes/provision.ts exposes
//       checkStackReachability over GET /api/v1/provision/:name/reachability so
//       an operator can see per-dependency reachable/unreachable + the checked
//       endpoint for a stack on demand.
//
// CONTRACT-FIRST — per-stack coordinate source + client shapes:
//   - The coordinates are read from the stored `StackConfig` (param-store.ts):
//       queue/Valkey -> config.redisUrl   (param-store.ts:63)
//       storage      -> config.minioEndpoint + config.sourceBucket
//                                           (param-store.ts:60,64)
//     This is the SAME per-stack record the resolver
//     (services/workspace-stack.ts buildConnectionsFromStack) and the scaler
//     (main.ts resolveStackRedisUrl / activateScaler, which builds the IORedis
//     client from config.redisUrl) read — NO process-global endpoints are
//     reintroduced (issue #617 scope bullet 3).
//   - The taxonomy, endpoint-sanitising, bounded-deadline race, and the
//     machine-readable named-dependency error are REUSED verbatim from the
//     fail-fast fix (encore-scaler/dependency-timeout.ts, issue #616):
//     StackDependency = 'queue' | 'encore' | 'storage', sanitizeEndpoint(),
//     withDependencyTimeout(), DependencyUnreachableError. This is exactly what
//     "composes with the fail-fast fix" (issue #617 acceptance) means — the
//     preflight produces the SAME error type the submit path already maps to 504.
//   - The probe client shapes mirror the injectable-seam + machine-readable
//     outcome pattern of services/external-backend-validation.ts and
//     services/profiles-reachability.ts (injected factory / FetchLike so the
//     check is unit-testable without live network I/O). Concretely:
//       * queue probe  -> ioredis `ping(): Promise<"PONG">`
//         (node_modules/ioredis/.../RedisCommander.d.ts:3545) — the lightest
//         round-trip that proves the Valkey server answers.
//       * storage probe -> minio `bucketExists(name): Promise<boolean>`
//         (node_modules/minio/.../client.d.ts:207) — the SAME authoritative
//         reachability call the transcode destination check already uses
//         (routes/assets.ts:1593).
//
// ENCORE: on this architecture the transcode submit path does NOT call an Encore
// HTTP endpoint directly — it ENQUEUES onto the stack's Valkey queue
// (encore-scaler/index.ts makeScalingEncoreClient.submit -> redis.lpush/hset);
// the auto-scaler (ADR-006) spawns/manages the actual Encore instances, so there
// is NO static per-stack Encore URL on the StackConfig to probe
// (workspace-stack.ts:207-210 leaves connections.encore unset for this reason).
// Reaching the queue IS therefore the reachability precondition for submitting a
// transcode to Encore. This module checks 'queue' and 'storage'; the 'encore'
// member of StackDependency stays reserved for a future direct-Encore probe and
// is not fabricated here (no coordinate exists to probe).
//
// SECRET HYGIENE: endpoints are run through sanitizeEndpoint() before they reach
// any result or log, stripping a `user:pass@` from the redis URL (issue #616).
// The MinIO secret is never part of minioEndpoint (param-store.ts only stores
// non-secret coordinates); the live storage credential is supplied to the probe
// client factory and never surfaced.

import type { Client as MinioClient } from 'minio';
import {
  DependencyUnreachableError,
  resolveDependencyTimeoutMs,
  sanitizeEndpoint,
  withDependencyTimeout,
  type StackDependency
} from '../encore-scaler/dependency-timeout.js';

// The live per-stack coordinates a preflight needs. Non-secret endpoints are
// taken from the StackConfig; the storage secret is carried only to build the
// probe client (mirrors ExternalBackendProbeTarget in
// external-backend-validation.ts — secret in, never out).
export type StackReachabilityCoordinates = {
  // Logical stack/workspace name, echoed into the error/result for context.
  stackName?: string;
  // Valkey/queue connection URL (StackConfig.redisUrl). When absent the queue
  // dependency is reported as not-configured rather than probed.
  redisUrl?: string;
  // MinIO/S3 endpoint URL (StackConfig.minioEndpoint) and the bucket the probe
  // HEADs to confirm reachability + authz (StackConfig.sourceBucket). When
  // either is absent the storage dependency is reported as not-configured.
  minioEndpoint?: string;
  bucket?: string;
};

// A minimal queue probe surface: the single lightest round-trip that proves the
// Valkey server answers. Structurally satisfied by an ioredis client
// (ping(): Promise<"PONG">). Narrowed to one method so a test double need not
// implement the whole client.
export interface QueueProbeClient {
  ping(): Promise<string>;
}

// A minimal storage probe surface: a bucket HEAD. Structurally satisfied by a
// minio Client (bucketExists(name): Promise<boolean>). Same authoritative
// reachability call the transcode destination check uses (routes/assets.ts).
export interface StorageProbeClient {
  bucketExists(bucketName: string): Promise<boolean>;
}

// Injectable probe clients so the preflight is unit-testable without live I/O
// (mirrors ProbeClientFactory / FetchLike elsewhere). Production wires the
// shared IORedis client (main.ts) and the per-stack MinioClient
// (workspace-stack.ts connections.storageClient).
export type StackReachabilityDeps = {
  queueClient?: QueueProbeClient;
  storageClient?: StorageProbeClient | MinioClient;
  // Bounded per-probe deadline. Defaults to the same env-tunable bound the
  // transcode submit path uses (resolveDependencyTimeoutMs, issue #616) so the
  // preflight never stalls nearer the ~50s socket-drop boundary than a submit.
  timeoutMs?: number;
};

// Per-dependency probe outcome. Discriminated on `reachable`. On failure it
// carries the machine-readable reason:
//   - 'unreachable'     the probe ran but the dependency did not answer
//                       (connect error or bounded-timeout deadline).
//   - 'not_configured'  no coordinate for this dependency is present on the
//                       stack record / no probe client was wired, so it could
//                       not be checked (distinct from a live failure).
export type DependencyReachability = {
  dependency: StackDependency;
  // The checked endpoint, credentials stripped (issue #617 acceptance: the
  // diagnostics endpoint returns the CHECKED endpoint). Undefined only when the
  // dependency was not configured.
  endpoint?: string;
  reachable: boolean;
  reason?: 'unreachable' | 'not_configured';
  // Why reachability failed, for diagnostics: a bounded-timeout deadline or an
  // underlying connect error. Present only when reason === 'unreachable'.
  failure?: 'timeout' | 'connect_error';
};

// The aggregate preflight result. `healthy` is true only when every CONFIGURED
// dependency answered; a not_configured dependency does NOT make the stack
// unhealthy (it simply could not be checked and is reported as such).
export type StackReachabilityResult = {
  stackName?: string;
  healthy: boolean;
  dependencies: DependencyReachability[];
};

// Probe one dependency under the bounded deadline, converting the #616
// DependencyUnreachableError (thrown by withDependencyTimeout on either a
// timeout or a connect error) into a per-dependency reachability record. Never
// throws: a failed probe is data, not an exception, so the diagnostics endpoint
// can report every dependency even when several are down.
async function probe(
  dependency: StackDependency,
  endpoint: string,
  stackName: string | undefined,
  timeoutMs: number,
  op: () => Promise<unknown>
): Promise<DependencyReachability> {
  try {
    await withDependencyTimeout(op, {
      dependency,
      endpoint,
      ...(stackName ? { stackName } : {}),
      operation: 'reachability preflight',
      timeoutMs
    });
    return { dependency, endpoint, reachable: true };
  } catch (err) {
    const failure =
      err instanceof DependencyUnreachableError ? err.reason : 'connect_error';
    return {
      dependency,
      endpoint,
      reachable: false,
      reason: 'unreachable',
      failure
    };
  }
}

// Run the per-dependency reachability preflight for a stack. Probes the
// CONFIGURED dependencies (queue, storage) concurrently under a bounded deadline
// and returns a per-dependency reachable/unreachable record plus an aggregate
// `healthy`. Never throws — a probe failure is reported as unreachable so a
// caller can render every dependency's state. The raw error detail stays
// internal; only the sanitised endpoint + machine-readable fields are returned.
export async function checkStackReachability(
  coords: StackReachabilityCoordinates,
  deps: StackReachabilityDeps
): Promise<StackReachabilityResult> {
  const timeoutMs = deps.timeoutMs ?? resolveDependencyTimeoutMs();
  // Each entry is either a live probe (a Promise) or an eagerly-resolved
  // not_configured record; Promise.resolve() below normalises both.
  const checks: (Promise<DependencyReachability> | DependencyReachability)[] = [];

  // Queue / Valkey.
  if (coords.redisUrl && deps.queueClient) {
    const endpoint = sanitizeEndpoint(coords.redisUrl);
    const queueClient = deps.queueClient;
    checks.push(
      probe('queue', endpoint, coords.stackName, timeoutMs, () => queueClient.ping())
    );
  } else {
    checks.push({ dependency: 'queue', reachable: false, reason: 'not_configured' });
  }

  // Storage.
  if (coords.minioEndpoint && coords.bucket && deps.storageClient) {
    const endpoint = sanitizeEndpoint(coords.minioEndpoint);
    const storageClient = deps.storageClient;
    const bucket = coords.bucket;
    checks.push(
      probe('storage', endpoint, coords.stackName, timeoutMs, () =>
        storageClient.bucketExists(bucket)
      )
    );
  } else {
    checks.push({ dependency: 'storage', reachable: false, reason: 'not_configured' });
  }

  const settled = await Promise.all(checks.map((c) => Promise.resolve(c)));

  // A not_configured dependency could not be checked and does NOT by itself mark
  // the stack unhealthy; only a CONFIGURED-but-unreachable dependency does.
  const healthy = settled.every(
    (d) => d.reachable || d.reason === 'not_configured'
  );

  return {
    ...(coords.stackName ? { stackName: coords.stackName } : {}),
    healthy,
    dependencies: settled
  };
}

// Find the first CONFIGURED dependency that was unreachable, as the #616
// DependencyUnreachableError the transcode path already maps to a 504. This is
// the "composes with the fail-fast fix" seam (issue #617): the preflight guard
// on the transcode path calls checkStackReachability, and if the stack is
// unhealthy, throws this so the SAME catch + 504 mapping (routes/assets.ts,
// routes/encore-compat.ts) names the dependency + endpoint to the caller.
// Returns undefined when every configured dependency is reachable.
export function firstUnreachable(
  result: StackReachabilityResult
): DependencyUnreachableError | undefined {
  const down = result.dependencies.find(
    (d) => !d.reachable && d.reason === 'unreachable'
  );
  if (!down) return undefined;
  return new DependencyUnreachableError({
    dependency: down.dependency,
    endpoint: down.endpoint ?? 'unknown',
    ...(result.stackName ? { stackName: result.stackName } : {}),
    operation: 'reachability preflight',
    reason: down.failure ?? 'connect_error'
  });
}
