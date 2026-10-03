// Per-stack object-store credentials (issue #1094, core fix from #1089).
//
// BEFORE: every provisioned stack's object store was created with the SAME
// process-global root credential — `RootUser: 'admin'` plus the single
// deployment-wide `MINIO_ROOT_PASSWORD` (routes/provision.ts, and the matching
// literals in services/workspace-stack.ts and services/encore-s3-config.ts).
// One leaked credential therefore opened EVERY tenant's object store, and the
// credential could not be rotated for one stack without breaking all of them.
//
// AFTER: each stack's object store is created with its OWN access key id and
// secret access key. The credential is DERIVED, not randomly generated and
// stored, for three reasons that matter on this platform:
//
//   1. OSC secrets are WRITE-ONLY. `saveSecret(serviceId, name, value, ctx)`
//      POSTs to `/mysecrets/<serviceId>` (@osaas/client-core
//      lib/core.js:355-369) and the SDK exposes NO read-back and NO delete
//      (lib/index.d.ts exports only `saveSecret`/`valueOrSecret` for secrets).
//      So a randomly generated secret could never be recovered by the API
//      process that must speak S3 directly (presigned uploads, bucket reads).
//   2. The parameter store must never hold a secret — storeStackConfig asserts
//      it (assertNoCredentials, services/param-store.ts) — so the secret cannot
//      be persisted alongside the endpoint either.
//   3. Provisioning is idempotent (#417): a retried provision ADOPTS the
//      existing object-store instance. A freshly randomised secret on each retry
//      would diverge from the credential the live instance was created with.
//      A derivation keyed on the stack is stable across retries by construction.
//
// Derivation (HMAC-SHA256, domain-separated):
//   accessKeyId     = 'ovc' + HMAC(seed, '<access-key-id ctx>/<stackName>')  (hex, 20 chars)
//   secretAccessKey = HMAC(seed, '<secret ctx>/<accessKeyId>')               (base64url, 40 chars)
//
// The accessKeyId is NON-SECRET (it is an identifier, like a username — the
// same classification the #212 external-credential mapping uses, see the
// `accessKeyId` comment in services/external-storage-credentials.ts:33) and is
// persisted as `StackConfig.objectStoreAccessKeyId`. The secret is derived from
// the accessKeyId, so the read path needs only the stored id + the seed and
// never the stack name — one fewer input to get wrong.
//
// SEED. The seed is the deployment's existing `MINIO_ROOT_PASSWORD`. That is
// deliberate and costs no new configuration or migration: the value is already
// required at provision time, already available to every path that needs a
// credential, and HMAC is one-way, so a stack's credential no longer reveals
// the seed and a credential leaked from stack A grants NOTHING on stack B. The
// seed is never used as a credential on a migrated stack. Rotating the seed
// invalidates the derived credentials of already-provisioned stacks — exactly
// as rotating MINIO_ROOT_PASSWORD already does today, since the live instances
// keep the password they were created with. No new operational constraint.
//
// NO SECRET IS LOGGED OR RETURNED. Every function here is pure and returns the
// credential to its caller; nothing in this module logs. Callers put the secret
// only into (a) `saveSecret`, (b) an OSC create-instance body as a
// `{{secrets.*}}` REFERENCE, or (c) an S3 client constructor.
//
// OUT OF SCOPE (deliberately, per the issue split): scoping a key to a single
// bucket (#1095) and migrating already-provisioned stacks / removing the legacy
// fallback (#1096). Until #1096 runs, a stack whose stored config carries no
// `objectStoreAccessKeyId` keeps using the legacy `admin` + seed credential,
// byte-identically to the pre-#1094 behaviour.

import { createHmac } from 'node:crypto';

// The legacy, process-global object-store root user every pre-#1094 stack was
// created with (`RootUser: 'admin'` in routes/provision.ts). Kept as the single
// source of truth for the compatible fallback so the literal stops being
// duplicated across workspace-stack.ts / encore-s3-config.ts / the packager
// create body. Removed by #1096 together with the fallback itself.
export const LEGACY_OBJECT_STORE_ACCESS_KEY_ID = 'admin';

// Domain-separation contexts. Changing either string changes every derived
// credential, so they are versioned (`/v1`) rather than edited in place.
const ACCESS_KEY_ID_CONTEXT = 'open-videocore/object-store/access-key-id/v1';
const SECRET_ACCESS_KEY_CONTEXT =
  'open-videocore/object-store/secret-access-key/v1';

// Access key ids are prefixed so an operator reading an object-store audit line
// can tell a per-stack key from the legacy root user at a glance.
export const OBJECT_STORE_ACCESS_KEY_ID_PREFIX = 'ovc';
// 20 chars, matching the conventional S3 access-key-id length, over the
// charset [a-z0-9] only (prefix + hex digest) so the value is safe for the
// object store's root-user field, for URL userinfo, and for shell export.
const ACCESS_KEY_ID_LENGTH = 20;
// 40 chars of base64url — conventional S3 secret length, URL-safe charset, and
// 240 bits of the HMAC retained.
const SECRET_ACCESS_KEY_LENGTH = 40;

export type ObjectStoreCredential = {
  // NON-SECRET identifier. Safe to persist in the parameter store.
  accessKeyId: string;
  // SECRET. Must only ever reach saveSecret, an S3 client, or a
  // {{secrets.*}}-referenced create-instance field. NEVER a log line, NEVER an
  // API response, NEVER the parameter store.
  secretAccessKey: string;
};

// Derive the stack's access key id. Stable for a given (seed, stackName) pair,
// so a retried/idempotent provision computes the same id the live instance was
// created with.
export function deriveObjectStoreAccessKeyId(
  seed: string,
  stackName: string
): string {
  const digest = createHmac('sha256', seed)
    .update(`${ACCESS_KEY_ID_CONTEXT}/${stackName}`)
    .digest('hex');
  return `${OBJECT_STORE_ACCESS_KEY_ID_PREFIX}${digest}`.slice(
    0,
    ACCESS_KEY_ID_LENGTH
  );
}

// Derive the secret access key for an access key id. Keyed on the ID (not the
// stack name) so any reader that has the stored, non-secret id can recompute
// the secret without knowing which stack it belongs to.
export function deriveObjectStoreSecretAccessKey(
  seed: string,
  accessKeyId: string
): string {
  return createHmac('sha256', seed)
    .update(`${SECRET_ACCESS_KEY_CONTEXT}/${accessKeyId}`)
    .digest('base64url')
    .slice(0, SECRET_ACCESS_KEY_LENGTH);
}

// The full per-stack credential for a stack name. Used at PROVISION time, where
// the stack name is authoritative and the id has not been stored yet.
export function deriveObjectStoreCredential(
  seed: string,
  stackName: string
): ObjectStoreCredential {
  const accessKeyId = deriveObjectStoreAccessKeyId(seed, stackName);
  return {
    accessKeyId,
    secretAccessKey: deriveObjectStoreSecretAccessKey(seed, accessKeyId)
  };
}

// Resolve the credential to use for an ALREADY-PROVISIONED stack, from its
// stored (non-secret) config plus the deployment seed. TOTAL: it always returns
// a credential, so no call site has to invent a degraded path.
//
//   - `storedAccessKeyId` present AND a seed available  -> the per-stack
//     credential (#1094). The stored id is used VERBATIM — it is the ground
//     truth of what the live instance was created with — and the secret is
//     re-derived from it.
//   - otherwise -> the LEGACY credential (`admin` + the deployment-wide
//     password), i.e. exactly the pre-#1094 values. This covers stacks
//     provisioned before #1094 (migrated by #1096) and deployments with no seed
//     configured, and keeps those paths byte-identical to today.
export function resolveObjectStoreCredential(args: {
  // StackConfig.objectStoreAccessKeyId for the resolved stack.
  storedAccessKeyId: string | undefined;
  // The derivation seed (MINIO_ROOT_PASSWORD). Empty/undefined disables the
  // per-stack path.
  seed: string | undefined;
  // The pre-#1094 deployment-wide object-store password, for the fallback.
  legacySecretAccessKey: string | undefined;
}): ObjectStoreCredential {
  const storedAccessKeyId = args.storedAccessKeyId?.trim();
  const seed = args.seed;
  if (storedAccessKeyId && storedAccessKeyId.length > 0 && seed && seed.length > 0) {
    return {
      accessKeyId: storedAccessKeyId,
      secretAccessKey: deriveObjectStoreSecretAccessKey(seed, storedAccessKeyId)
    };
  }
  return {
    accessKeyId: LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: args.legacySecretAccessKey ?? ''
  };
}

// Which credential a provision run must create the stack's object store with.
// `perStack` true means the derived credential is NEW to this stack and MUST be
// recorded as `StackConfig.objectStoreAccessKeyId` (including on the
// 'provisioning' marker and any 'failed' partial write, so a retry of the same
// stack resolves the same mode rather than flip-flopping to the fallback).
export type ObjectStoreCredentialPlan = {
  credential: ObjectStoreCredential;
  perStack: boolean;
};

// Decide the credential for one provision run. PURE, so the decision table is
// unit-testable without OSC or a parameter store.
//
// The safety rule is one-directional: NEVER hand a per-stack credential to an
// object-store instance that already exists and was not recorded as per-stack,
// because provisioning ADOPTS such an instance (#417, "already taken" ->
// getInstance) and adoption does NOT rewrite its root user — the API would then
// authenticate with a credential the live instance has never heard of. When in
// doubt, fall back: a stack that stays on the legacy credential is exactly as
// functional as it is today and is migrated by #1096.
export function planObjectStoreCredential(args: {
  stackName: string;
  // The derivation seed (MINIO_ROOT_PASSWORD).
  seed: string;
  // The pre-#1094 deployment-wide object-store password, for the fallback.
  legacySecretAccessKey: string;
  // `StackConfig.objectStoreAccessKeyId` of the stored config for this stack
  // name, if any was read during the idempotency pre-flight.
  storedAccessKeyId: string | undefined;
  // Whether a stored config exists at all for this stack name.
  storedConfigExists: boolean;
  // Whether the stack's object-store instance ALREADY exists in OSC. Pass
  // `true` when the existence probe could not answer: that is the conservative
  // answer (fallback), never the breaking one.
  objectStoreInstanceExists: boolean;
  // False when this deployment has no parameter store. Without one the
  // per-stack access key id cannot be persisted, so nothing could ever resolve
  // it again — the only correct choice is the fallback.
  paramStoreAvailable: boolean;
}): ObjectStoreCredentialPlan {
  const legacy: ObjectStoreCredentialPlan = {
    credential: {
      accessKeyId: LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
      secretAccessKey: args.legacySecretAccessKey
    },
    perStack: false
  };

  if (!args.paramStoreAvailable) return legacy;
  if (!args.seed || args.seed.length === 0) return legacy;

  const storedAccessKeyId = args.storedAccessKeyId?.trim();
  if (storedAccessKeyId && storedAccessKeyId.length > 0) {
    // A prior run already issued a per-stack credential for this stack. Reuse
    // that exact id (the instance was created with it) and re-derive its secret.
    return {
      credential: {
        accessKeyId: storedAccessKeyId,
        secretAccessKey: deriveObjectStoreSecretAccessKey(
          args.seed,
          storedAccessKeyId
        )
      },
      perStack: true
    };
  }

  // No per-stack id recorded. If the object store already exists it was created
  // with the legacy root user, and adopting it cannot change that: stay on the
  // fallback (#1096 migrates it). A stored config with no id is the same
  // situation — a pre-#1094 record.
  if (args.objectStoreInstanceExists || args.storedConfigExists) return legacy;

  return {
    credential: deriveObjectStoreCredential(args.seed, args.stackName),
    perStack: true
  };
}
