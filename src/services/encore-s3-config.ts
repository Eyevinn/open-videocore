// Resolve the object-store (MinIO) coordinates each spawned Encore instance is
// configured with, from the provisioned stack's own config.
//
// This is the seam issue #804's symptom surfaced at. The scaler passes the
// returned config into the Encore instance-create body as `s3Endpoint` /
// `s3AccessKeyId` / `s3SecretAccessKey` / `s3Region`
// (src/encore-scaler/instance-pool.ts:368-372), and those fields are set ONLY
// when a config is present. A transcode job's input is an `s3://<bucket>/<key>`
// URI (src/pipeline/transcode.ts:120) with no host in it, so an Encore instance
// spawned WITHOUT `s3Endpoint` resolves that URI against the public AWS S3
// endpoint instead of the stack's own object store and fails with a 404 that
// names nothing.
//
// Pre-#804, provision.ts wrote the stack config under a DERIVED namespace while
// this read used the constant, so on any deployment where those differed the
// read missed, this resolver returned undefined, and the miss was invisible
// until a transcode 404'd. Two things fix that:
//   1. the namespace is now the constant STACK_CONFIG_NAMESPACE on both sides
//      (issue #804), so the read key equals the write key by construction;
//   2. this resolver FAILS LOUD — it throws rather than returning undefined
//      when no endpoint is resolvable and there is no static env-var fallback,
//      so a config miss surfaces as a failed transcode submission that names
//      the cause instead of an unexplained 404 from the transcoder.
//
// Contract sources verified (per CLAUDE.md rule 7):
//   - ParamStore.loadStackConfig(workspaceId, name): Promise<StackConfig |
//     undefined> and .listStackNames(workspaceId): Promise<string[]>
//     (src/services/param-store.ts:108-125).
//   - StackConfig.minioEndpoint: string (src/services/param-store.ts:52-95).
//   - EncoreS3Config = { endpoint, accessKeyId, secretAccessKey, region? }
//     (src/encore-scaler/types.ts:24-29).
//   - WorkspaceEncoreScalerRegistry option
//     `resolveS3Config?: (stackKey: string) => Promise<EncoreS3Config |
//     undefined>`, whose undefined result means "use the static s3Config"
//     (src/encore-scaler/workspace-registry.ts:88, :206-209, :328-330).

import { STACK_CONFIG_NAMESPACE } from './workspace-stack.js';
import type { ParamStore, StackConfig } from './param-store.js';
import type { EncoreS3Config } from '../encore-scaler/types.js';

// MinIO root user. Always `admin` in OSC-provisioned stacks — the provision
// route creates the instance with that root user (src/routes/provision.ts) and
// the stack resolver builds its own S3 client with the same literal
// (src/services/workspace-stack.ts:249).
const MINIO_ROOT_USER = 'admin';

export type EncoreS3ConfigLogger = {
  error: (obj: unknown, msg?: string) => void;
};

export type ResolveEncoreS3ConfigDeps = {
  paramStore: ParamStore | undefined;
  // Object-store secret for the spawned instances. Absent means there are no
  // credentials to hand Encore at all.
  secretAccessKey: string | undefined;
  // True when a complete static ENCORE_S3_ENDPOINT + secret pair was configured
  // (local dev / ops override). That is an intentional, complete configuration,
  // so this resolver defers to it by returning undefined rather than throwing.
  staticFallbackConfigured: boolean;
  log: EncoreS3ConfigLogger;
};

// `stackKey` is the EFFECTIVE stack identity the transcode request resolved to
// (issue #615), so it IS the stack name: load its config by name directly. Only
// when that exact stack has no stored config (e.g. the fixed DEPLOYMENT_CONTEXT
// of a single-stack env-override deployment, which is not itself a stack name)
// do we fall back to the first provisioned stack — so a named stack is never
// mis-resolved to the first-provisioned one, while single-stack behaviour is
// unchanged.
export async function resolveEncoreS3Config(
  deps: ResolveEncoreS3ConfigDeps,
  stackKey: string
): Promise<EncoreS3Config | undefined> {
  const { paramStore, secretAccessKey, staticFallbackConfigured, log } = deps;

  if (!secretAccessKey) {
    if (staticFallbackConfigured) return undefined;
    throw new Error(
      'encore-scaler: cannot resolve object-store credentials for transcoding — none of ENCORE_S3_SECRET_KEY, MINIO_SECRET_KEY or MINIO_ROOT_PASSWORD is set. ' +
        'Spawning a transcoder without them would resolve s3:// inputs against the wrong endpoint and fail with a 404.'
    );
  }
  if (!paramStore) {
    if (staticFallbackConfigured) return undefined;
    throw new Error(
      'encore-scaler: cannot resolve the object-store endpoint for transcoding — the parameter store is not configured and no ENCORE_S3_ENDPOINT is set.'
    );
  }

  let config: StackConfig | undefined;
  try {
    config = await paramStore.loadStackConfig(STACK_CONFIG_NAMESPACE, stackKey);
    if (!config) {
      const names = await paramStore.listStackNames(STACK_CONFIG_NAMESPACE);
      if (names.length > 0) {
        config = await paramStore.loadStackConfig(STACK_CONFIG_NAMESPACE, names[0]!);
      }
    }
  } catch (err) {
    log.error(
      { err, stackKey, namespace: STACK_CONFIG_NAMESPACE },
      'encore-scaler: failed to read the stack config while resolving the object-store endpoint'
    );
    if (staticFallbackConfigured) return undefined;
    throw new Error(
      `encore-scaler: failed to read the stack config for "${stackKey}" while resolving the object-store endpoint: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (config?.minioEndpoint) {
    return {
      endpoint: config.minioEndpoint,
      accessKeyId: MINIO_ROOT_USER,
      secretAccessKey
    };
  }

  if (staticFallbackConfigured) return undefined;
  log.error(
    { stackKey, namespace: STACK_CONFIG_NAMESPACE },
    'encore-scaler: no object-store endpoint resolvable for this stack'
  );
  throw new Error(
    `encore-scaler: no object-store endpoint resolvable for stack "${stackKey}" under namespace "${STACK_CONFIG_NAMESPACE}" ` +
      '(no provisioned stack config, or the stored config carries no endpoint), and no ENCORE_S3_ENDPOINT fallback is set. ' +
      'Refusing to spawn a transcoder that would resolve s3:// inputs against the wrong endpoint.'
  );
}
