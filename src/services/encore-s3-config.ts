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
// ORDERING INVARIANT — read this before wiring resolveEncoreS3Config onto a
// NEW call path.
//
// This resolver reads paramStore.loadStackConfig(STACK_CONFIG_NAMESPACE, …)
// DIRECTLY. It deliberately does NOT go through the #804 migration helpers
// (WorkspaceStackResolver.loadStackConfigWithMigration /
// listStackNamesWithMigration, src/services/workspace-stack.ts), which adopt a
// pre-#804 stack config written under a derived namespace and rewrite it under
// the constant.
//
// That is safe TODAY only because of an ordering invariant spanning three
// modules, not because of anything this module enforces:
//
//   1. main.ts resolves the stack's Valkey URL via resolveStackRedisUrl
//      (services/scaler-redis-url.ts), which goes through
//      WorkspaceStackResolver.resolveStackConfig() and therefore RUNS the
//      migration — rewriting any stale config under STACK_CONFIG_NAMESPACE.
//   2. Only if that resolves does main.ts call activateScaler(redisUrl), which
//      constructs the scaler registry that owns `resolveS3Config`.
//   3. resolveEncoreS3Config is reachable ONLY as that registry's
//      `resolveS3Config` callback, so by the time it runs, step 1 has already
//      migrated the key it reads.
//
// In other words: the scaler activation path migrates BEFORE this function is
// ever invoked, so a direct constant-namespace read cannot miss a config the
// migration would have found.
//
// If you call this from anywhere that is NOT downstream of scaler activation —
// a route handler, a CLI script, a sweep, a new background worker — that
// invariant no longer holds, and on a not-yet-migrated deployment this read
// will MISS and now THROW (fail-loud, below) instead of silently degrading.
// In that case, resolve through the migration helpers first, or take a
// resolver-backed read path rather than paramStore directly.
//
// Contract sources verified (per CLAUDE.md rule 7):
//   - ParamStore.loadStackConfig(workspaceId, name): Promise<StackConfig |
//     undefined> and .listStackNames(workspaceId): Promise<string[]>
//     (src/services/param-store.ts:108-125).
//   - StackConfig.minioEndpoint: string (src/services/param-store.ts:52-95).
//   - EncoreS3Config = { endpoint, accessKeyId, secretAccessKey, region? }
//     (src/encore-scaler/types.ts:24-29).
//   - StackConfig.objectStoreAccessKeyId?: string and
//     resolveObjectStoreCredential({ storedAccessKeyId, seed,
//     legacySecretAccessKey }): ObjectStoreCredential (issue #1094,
//     src/services/param-store.ts and src/services/object-store-credentials.ts).
//   - WorkspaceEncoreScalerRegistry option
//     `resolveS3Config?: (stackKey: string) => Promise<EncoreS3Config |
//     undefined>`, whose undefined result means "use the static s3Config"
//     (src/encore-scaler/workspace-registry.ts:88, :206-209, :328-330).

import { STACK_CONFIG_NAMESPACE } from './workspace-stack.js';
import { OBJECT_STORE_SERVICE_ID } from './stack.js';
import { resolveObjectStoreCredential } from './object-store-credentials.js';
import type { ParamStore, StackConfig } from './param-store.js';
import type { EncoreS3Config } from '../encore-scaler/types.js';

export type EncoreS3ConfigLogger = {
  error: (obj: unknown, msg?: string) => void;
};

export type ResolveEncoreS3ConfigDeps = {
  paramStore: ParamStore | undefined;
  // LEGACY, deployment-wide object-store secret for the spawned instances
  // (ENCORE_S3_SECRET_KEY / MINIO_SECRET_KEY / MINIO_ROOT_PASSWORD). Used for a
  // stack provisioned BEFORE #1094 — one whose stored config carries no
  // `objectStoreAccessKeyId` — and for the static env-var override. Absent
  // together with `objectStoreCredentialSeed` means there are no credentials to
  // hand Encore at all.
  secretAccessKey: string | undefined;
  // Seed for the PER-STACK object-store credential (issue #1094;
  // MINIO_ROOT_PASSWORD). When the resolved stack's config carries an
  // `objectStoreAccessKeyId`, the credential handed to the spawned transcoder is
  // derived from that id and this seed — so a transcoder spawned for stack A
  // gets a key that only opens stack A's object store. Optional: without it (or
  // for a not-yet-migrated stack) the legacy pair above is used, byte-identical
  // to the pre-#1094 behaviour.
  objectStoreCredentialSeed?: string | undefined;
  // True when a complete static ENCORE_S3_ENDPOINT + secret pair was configured
  // (local dev / ops override). That is an intentional, complete configuration,
  // so this resolver defers to it by returning undefined rather than throwing.
  //
  // NOTE (issue #991): this governs ONLY the "nothing resolved, so defer"
  // decisions below. It deliberately does NOT gate `resolveEndpoint` — see
  // mapEndpointForTranscoder for why. When a stack endpoint DOES resolve, that
  // stack endpoint is what the transcoder gets, and the static value is not in
  // play on this path at all.
  staticFallbackConfigured: boolean;
  log: EncoreS3ConfigLogger;
  // Optional hook (issue #991) mapping the stack's PUBLIC object-store endpoint
  // to the endpoint the SPAWNED TRANSCODER should use — in production the
  // in-cluster Service address, so a long single-connection read of a large
  // source never crosses the platform ingress (services/
  // internal-minio-endpoint.ts). Contract: it must never throw and must return
  // the input unchanged whenever no better endpoint is usable, so this resolver's
  // behaviour without the hook and with an unusable in-cluster path are
  // identical. Only the endpoint handed to the transcoder changes: the STORED
  // stack config and every client-facing URL stay public (presigned uploads,
  // playback/delivery, API responses), because those are built from
  // StackConfig.minioEndpoint by the stack resolver, which this hook is not
  // wired into.
  //
  // The second argument is the stack's object-store INSTANCE NAME, taken from
  // `StackConfig.services` below. The resolver uses it to ask the platform for
  // the in-cluster address via `getInternalEndpoint`
  // (@osaas/client-core lib/core.d.ts:130-148) instead of inferring one; it is
  // optional because an older stored config may not carry it.
  resolveEndpoint?: (publicEndpoint: string, instanceName?: string) => Promise<string>;
};

// Apply the optional endpoint hook (issue #991) to the PUBLIC endpoint read from
// the stack config, and fail soft in every other case.
//
// GATED ON PROVENANCE, NOT ON `staticFallbackConfigured`. This function is only
// ever reached with an endpoint that came from `StackConfig.minioEndpoint` —
// i.e. from the stack config — so the hook always applies here. A static
// `ENCORE_S3_ENDPOINT` value cannot reach this function at all: when a complete
// static pair is configured AND no stack endpoint resolves, this resolver
// returns `undefined` and the registry uses its own `s3Config` built from the
// env vars verbatim (workspace-registry.ts:206-209, main.ts `s3Config`). The
// operator override is therefore honoured by a DIFFERENT code path that this
// hook is not wired into.
//
// The earlier `|| staticFallbackConfigured` gate confused those two things. It
// did not protect the static value (which never passes through here), and it
// silently disabled the #991 fix for any operator who had left
// `ENCORE_S3_ENDPOINT` set while actually being served from a provisioned
// stack: they lost the ingress fix AND their static value went unused. Gating
// on where the endpoint came from — which is unconditional at this call site —
// is the correct rule.
//
// The hook is contracted never to throw, but if a caller ever wires one that
// does, a spawn must not fail because of an optimisation: the throw is logged
// and the PUBLIC endpoint is used, which is exactly the pre-#991 behaviour.
async function mapEndpointForTranscoder(
  publicEndpoint: string,
  resolveEndpoint:
    | ((publicEndpoint: string, instanceName?: string) => Promise<string>)
    | undefined,
  instanceName: string | undefined,
  log: EncoreS3ConfigLogger
): Promise<string> {
  if (!resolveEndpoint) return publicEndpoint;
  try {
    const mapped = await resolveEndpoint(publicEndpoint, instanceName);
    return mapped && mapped.length > 0 ? mapped : publicEndpoint;
  } catch (err) {
    log.error(
      { err, publicEndpoint },
      'encore-scaler: the in-cluster object-store endpoint resolver threw (it must not) — ' +
        'falling back to the public endpoint for this spawn'
    );
    return publicEndpoint;
  }
}

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
  const {
    paramStore,
    secretAccessKey,
    objectStoreCredentialSeed,
    staticFallbackConfigured,
    log,
    resolveEndpoint
  } = deps;

  if (!secretAccessKey && !objectStoreCredentialSeed) {
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
    // The object-store instance name, for the platform's `getInternalEndpoint`
    // lookup (issue #991). Read from the config already loaded above, so this
    // costs no extra parameter-store round trip. Absent on a stack config old
    // enough to carry no `services[]` entry for the object store, in which case
    // the resolver falls back to deriving the address from the public endpoint.
    const objectStoreInstanceName = config.services?.find(
      (s) => s.serviceId === OBJECT_STORE_SERVICE_ID
    )?.instanceName;

    // Resolve the CREDENTIAL alongside the endpoint, from the SAME stack config
    // (issue #1094). A stack that carries a per-stack access key id hands the
    // spawned transcoder that key and its derived secret; a stack provisioned
    // before #1094 falls back to the legacy deployment-wide `admin` + secret
    // pair, exactly as before. The secret is returned to the scaler (which puts
    // it in the Encore create body, instance-pool.ts:618-622) and is never
    // logged here — note that every log line in this module carries only the
    // endpoint, stack key and namespace.
    const credential = resolveObjectStoreCredential({
      storedAccessKeyId: config.objectStoreAccessKeyId,
      seed: objectStoreCredentialSeed,
      legacySecretAccessKey: secretAccessKey
    });

    return {
      endpoint: await mapEndpointForTranscoder(
        config.minioEndpoint,
        resolveEndpoint,
        objectStoreInstanceName,
        log
      ),
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey
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
