// MinIO S3 endpoint resolution for the Encore auto-scaler (issue #804).
//
// A spawned Encore instance is told where to resolve `s3://` input URIs via its
// `s3Endpoint` config key. The scaler has no static endpoint on OSC: the value
// only exists once a stack has been provisioned (POST /api/v1/provision writes
// it to the parameter store as StackConfig.minioEndpoint), so it is resolved
// per stack at loop-creation time.
//
// Before #804 that resolution read the LITERAL `default` parameter-store
// namespace (STACK_CONFIG_NAMESPACE) instead of the deployment's derived
// namespace. On any deployment whose namespace is a real tenant id it found
// nothing, returned undefined, and the registry fell back to the static
// s3Config built from ENCORE_S3_ENDPOINT — which is unset on OSC. spawnInstance
// then omits the whole s3 block (instance-pool.ts:164-169), Encore resolves the
// `s3://` input against AWS S3 rather than the stack's own MinIO, and the job
// dies with `ffprobe failed ... Server returned 404 Not Found`.
//
// This module is the single shipped implementation of that resolution, extracted
// out of main.ts's registry wiring so it can be executed directly by tests —
// the same precedent #782 set with src/services/scaler-redis-url.ts. Keeping it
// inline was how main.ts drifted away from the resolver in the first place.
//
// Two behaviours it owns:
//   1. The read is namespace-aware: it goes through
//      WorkspaceStackResolver.resolveStackConfig(), the SAME derived namespace
//      and #751/#733 legacy fallback every other consumer uses.
//   2. An unresolvable endpoint FAILS LOUDLY (throws) instead of degrading to an
//      unset env var, unless a static ENCORE_S3_ENDPOINT is configured — which
//      is a real, intentional local-dev/ops configuration and is honoured.
//
// Contract sources verified (CLAUDE.md rule 7):
//   - WorkspaceStackResolver.resolveStackConfig(stackName?):
//     Promise<StackConfig | undefined>, and resolveNamespace(): Promise<string>
//     — src/services/workspace-stack.ts:1490, :1150. resolveStackConfig THROWS on
//     a parameter-store read failure (documented at workspace-stack.ts:1487-1489),
//     which is why the call below is wrapped.
//   - StackConfig.minioEndpoint: string — src/services/param-store.ts:60.
//   - stackConfigKey(workspaceId, name) = `openvideocore/<ws>/<name>`
//     — src/services/param-store.ts:131-133.
//   - EncoreS3Config = { endpoint; accessKeyId; secretAccessKey; region? }
//     — src/encore-scaler/types.ts:24-29.
//   - spawnInstance maps s3Config.endpoint -> the Encore instance's `s3Endpoint`
//     config key — src/encore-scaler/instance-pool.ts:164-169.
//   - WorkspaceEncoreScalerConfig.resolveS3Config?: (stackKey: string) =>
//     Promise<EncoreS3Config | undefined> — src/encore-scaler/workspace-registry.ts:77.

import type { EncoreS3Config } from '../encore-scaler/types.js';
import type { StackConfig } from './param-store.js';
import type { StackConfigSource } from './scaler-redis-url.js';

// The capabilities this module needs from WorkspaceStackResolver. Declared
// structurally (rather than importing the class) so the scaler path depends on
// the resolver's read contract only, and tests can drive it with a stub.
// StackConfigSource (scaler-redis-url.ts:33-35) already carries
// resolveStackConfig; the namespace is needed for the diagnostic payload.
export type NamespacedStackConfigSource = StackConfigSource & {
  resolveNamespace(): Promise<string>;
};

// The subset of the Fastify/pino logger surface used below.
export type ScalerS3Logger = {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export type ResolveS3ConfigDeps = {
  // Namespace-aware parameter-store view. Undefined when no parameter store is
  // configured for this deployment (the resolver then has nothing to read).
  stackConfigSource: NamespacedStackConfigSource | undefined;
  // Static operator override (ENCORE_S3_ENDPOINT). When set together with a
  // secret key, an unresolved stack config is a warning rather than a failure:
  // the registry uses the static config instead.
  encoreS3Endpoint: string | undefined;
  // MinIO secret for the spawned instance (ENCORE_S3_SECRET_KEY /
  // MINIO_SECRET_KEY / MINIO_ROOT_PASSWORD). Never persisted to the parameter
  // store — StackConfig carries endpoints and bucket names only
  // (param-store.ts:49-51) — so it must come from the environment.
  encoreS3SecretKey: string | undefined;
  log: ScalerS3Logger;
};

// The MinIO root user is always `admin` in an OSC-provisioned stack, matching
// what provision.ts creates. Kept as a named constant so the value is not a bare
// literal in the returned credential shape.
const MINIO_ROOT_USER = 'admin';

// Build the per-stack S3 resolver wired into WorkspaceEncoreScalerRegistry as
// `resolveS3Config`. The returned function REJECTS when it cannot resolve an
// endpoint and no static fallback is configured — see the registry's contract
// note at workspace-registry.ts:77 for how each call site handles that.
export function createResolveS3Config(
  deps: ResolveS3ConfigDeps
): (stackKey: string) => Promise<EncoreS3Config | undefined> {
  const { stackConfigSource, encoreS3Endpoint, encoreS3SecretKey, log } = deps;

  return async (stackKey: string): Promise<EncoreS3Config | undefined> => {
    // A static ENCORE_S3_ENDPOINT (local dev / ops override) is a real,
    // intentional configuration: leave the registry to use it.
    const hasStaticFallback = Boolean(encoreS3Endpoint && encoreS3SecretKey);

    // Fail loudly rather than hand Encore a job it will resolve against AWS.
    const unresolvable = (
      reason: string,
      detail?: Record<string, unknown>
    ): undefined => {
      if (hasStaticFallback) {
        log.warn(
          { stackKey, reason, ...detail },
          'encore-scaler: could not resolve this stack\'s MinIO endpoint from the parameter store; falling back to the statically configured ENCORE_S3_ENDPOINT'
        );
        return undefined;
      }
      log.error(
        { stackKey, reason, ...detail },
        'encore-scaler: cannot resolve a MinIO S3 endpoint for this stack and no ENCORE_S3_ENDPOINT is configured; refusing to spawn an Encore instance that would resolve s3:// inputs against AWS'
      );
      throw new Error(
        `encore-scaler: unresolvable MinIO S3 endpoint for stack "${stackKey}": ${reason}. ` +
          'Without it a spawned Encore instance receives no s3Endpoint and resolves s3:// inputs against AWS S3 (404). ' +
          'Provision a stack for this deployment\'s namespace, or set ENCORE_S3_ENDPOINT/ENCORE_S3_SECRET_KEY explicitly.'
      );
    };

    if (!encoreS3SecretKey) {
      return unresolvable(
        'no MinIO secret is configured (ENCORE_S3_SECRET_KEY / MINIO_SECRET_KEY / MINIO_ROOT_PASSWORD are all unset)'
      );
    }
    if (!stackConfigSource) {
      return unresolvable('no parameter store is configured for this deployment');
    }

    let config: StackConfig | undefined;
    try {
      config = await stackConfigSource.resolveStackConfig(stackKey);
    } catch (err) {
      return unresolvable('the parameter-store read failed', {
        err: err instanceof Error ? { message: err.message } : String(err)
      });
    }

    if (!config) {
      return unresolvable(
        'no stack config is stored under this deployment\'s namespace',
        { namespace: await stackConfigSource.resolveNamespace() }
      );
    }
    if (!config.minioEndpoint) {
      return unresolvable('the resolved stack config carries no minioEndpoint');
    }

    return {
      endpoint: config.minioEndpoint,
      accessKeyId: MINIO_ROOT_USER,
      secretAccessKey: encoreS3SecretKey
    };
  };
}
