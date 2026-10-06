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
// secret access key, minted under a per-issue GENERATION nonce so that a
// re-provision of a torn-down stack name gets a genuinely new credential
// rather than a replay of the retired one (see GENERATION below). The
// credential is DERIVED, not randomly generated and stored in full, for three
// reasons that matter on this platform:
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
// Derivation (HMAC-SHA256, domain-separated, keyed on a STRETCHED seed):
//   key             = scrypt(seed, fixed salt, N=2^15, r=8)                 (32 bytes)
//   accessKeyId     = 'ovc' + HMAC(key, '<id ctx>/<stackName>[/g=<gen>]')   (hex, 20 chars)
//   secretAccessKey = HMAC(key, '<secret ctx>/<accessKeyId>')               (base64url, 40 chars)
// The stretching is what makes a leaked credential expensive — not merely
// inconvenient — to turn back into the seed; see "HOW STRONG THE CROSS-STACK
// ISOLATION ACTUALLY IS" below.
//
// GENERATION (issue #1094, review follow-up). The derivation above is a pure
// function of its inputs, so with only (seed, stackName) as inputs a stack name
// that is torn down and provisioned again would be handed back the IDENTICAL
// credential — and teardown cannot retire the old one, because the OSC secrets
// API is write-only (no delete, see reason 1 below). Anyone who held the old
// stack's secret would therefore hold the new stack's secret. The `generation`
// input closes that: it is a 64-bit random nonce minted ONCE, by the caller, at
// the moment a credential is ISSUED for a stack that has none
// (`newObjectStoreCredentialGeneration()` + provision's call to
// `planObjectStoreCredential`). Randomness lives in the CALLER so every
// function here stays pure and the decision table stays unit-testable.
//
// The generation never needs to be persisted: it only shapes the accessKeyId,
// and the accessKeyId IS persisted (`StackConfig.objectStoreAccessKeyId`) and
// is the ground truth of what the live instance was created with. Every read
// path re-derives the secret from the STORED id, so a retried/idempotent
// provision (#417) and every later read stay stable within a generation while
// a fresh issue starts a new one. `generation` omitted / empty means
// GENERATION ZERO — the pre-generation derivation, byte-identical to the
// credentials already issued by earlier builds of this module, so already-live
// stacks keep working.
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
// required at provision time and already available to every path that needs a
// credential. The seed is never used as a credential on a migrated stack.
// Rotating the seed invalidates the derived credentials of already-provisioned
// stacks — exactly as rotating MINIO_ROOT_PASSWORD already does today, since
// the live instances keep the password they were created with. No new
// operational constraint.
//
// HOW STRONG THE CROSS-STACK ISOLATION ACTUALLY IS (reviewed, and stated
// precisely rather than absolutely). HMAC is one-way, so a stack's credential
// does not *reveal* the seed algebraically. But the seed is an operator-chosen
// password, and the derived secret is handed out widely as a plaintext
// create-body / job-body field (encore-scaler/instance-pool.ts,
// pipeline/osc-thumbnail.ts). So anyone holding ONE leaked (id, secret) pair
// can mount an OFFLINE GUESSING attack on the seed — each candidate seed is
// confirmed by recomputing the secret for that (public, parameter-store-stored)
// id — and a recovered seed yields every other stack's secret plus the legacy
// `admin` + seed credential of every not-yet-migrated stack. The isolation
// property is therefore CONDITIONAL on the seed being expensive to guess, and
// two mechanisms below make that condition hold instead of assuming it:
//
//   1. KEY STRETCHING (deriveStretchedSeedKey). Every HMAC here is keyed on
//      scrypt(seed) rather than on the raw password, so a guess costs one
//      scrypt evaluation (N=2^15, r=8 — 32 MiB and, measured on a CI-class
//      box, ~120 ms) instead of one keyed HMAC (~2.8 us measured the same
//      way): a ~4.3e4 increase in the price of each guess, paid once per
//      process by us because the stretched key is memoised per seed.
//   2. A MINIMUM SEED STRENGTH (assessObjectStoreCredentialSeed). Stretching
//      only buys a constant factor, so a genuinely weak seed would still fall.
//      A seed that does not clear MINIMUM_OBJECT_STORE_SEED_ENTROPY_BITS is
//      NOT used to issue new per-stack credentials at all:
//      planObjectStoreCredential treats it like an absent seed and keeps the
//      stack on the legacy deployment-wide credential, which is exactly the
//      pre-#1094 behaviour — no worse than today, and it never hands out a
//      derived secret whose seed is cheap to recover. Provisioning logs the
//      downgrade so an operator can fix the deployment (routes/provision.ts).
//
// The strength gate deliberately does NOT apply to the READ path
// (resolveObjectStoreCredential) or to the reuse branch of
// planObjectStoreCredential: a live instance was created with the derived
// credential, so refusing to re-derive it would lock the API out of a working
// stack rather than improve anything. Enforcement belongs at ISSUE time only.
//
// Because of (1), the derived values are NOT byte-compatible with the
// pre-stretching derivation. No released build issues these credentials — the
// per-stack derivation lands with this change (#1094) and `main` has no
// `objectStoreAccessKeyId` producer — so there is nothing live to keep
// compatible. Verified before changing the derivation:
// `git grep -c objectStoreAccessKeyId origin/main -- src` -> 0 matches.
//
// WHAT "ROTATABLE PER STACK" MEANS HERE, PRECISELY. One stack's credential can
// be reissued without touching any other stack's: minting a new generation
// yields a new (id, secret) pair for that stack alone, and the pair a different
// stack resolves is unchanged because it is keyed on that stack's own stored
// id. What this module does NOT do is push the new pair onto a LIVE object
// store: the credential is the OSC instance's root user, and an adopted
// instance keeps the root user it was created with (see
// planObjectStoreCredential). So reissue takes effect for a stack that is
// (re-)created, which is why a reused stack name must not replay the retired
// credential — the generation nonce is what prevents that.
//
// NO SECRET IS LOGGED OR RETURNED. Every function here is pure and returns the
// credential to its caller; nothing in this module logs. Callers put the secret
// only into (a) `saveSecret`, (b) an OSC create-instance body as a
// `{{secrets.*}}` REFERENCE, or (c) an S3 client constructor.
//
// STILL OPEN (tracked, NOT claimed as done by this module):
//   - #1095, scoping a key to only this stack's source + packaged buckets. The
//     credential here is the object store's ROOT user, which is an admin
//     identity on its own instance, so it is confined to one stack's buckets
//     only in the sense that the instance holds nothing else. A genuinely
//     bucket-scoped, non-admin key needs a policy-bound object-store user,
//     which the object-store JS SDK cannot create — see
//     OBJECT_STORE_BUCKET_SCOPE_LIMITATION below.
//   - #1096, migrating already-provisioned stacks and REMOVING the legacy
//     fallback. Until that lands, a stack whose stored config carries no
//     `objectStoreAccessKeyId` keeps using the legacy `admin` + seed
//     credential, byte-identically to the pre-#1094 behaviour.

import { createHmac, randomBytes, scryptSync } from 'node:crypto';

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

// A credential GENERATION: the random, per-issue component that makes a newly
// issued credential unpredictable instead of a pure function of the stack name
// (see GENERATION in the header). 64 bits as 16 lowercase hex chars — enough
// that a reused stack name never collides with its own retired credential, and
// over a charset that is safe inside the HMAC message and in any log line (the
// generation is NOT secret; it only has to be unguessable-by-replay).
export type ObjectStoreCredentialGeneration = string;

// Generation ZERO: the pre-generation derivation. Reserved for credentials
// issued before the generation component existed, so they keep resolving.
// NEVER pass this when ISSUING a new credential — use
// newObjectStoreCredentialGeneration().
export const LEGACY_CREDENTIAL_GENERATION: ObjectStoreCredentialGeneration = '';

const CREDENTIAL_GENERATION_BYTES = 8;

// Mint a fresh generation. The ONLY impure function in this module; kept here,
// rather than inside the derivation, so the derivation stays a pure function of
// explicit inputs and the provision decision table stays testable.
export function newObjectStoreCredentialGeneration(): ObjectStoreCredentialGeneration {
  return randomBytes(CREDENTIAL_GENERATION_BYTES).toString('hex');
}

export type ObjectStoreCredential = {
  // NON-SECRET identifier. Safe to persist in the parameter store.
  accessKeyId: string;
  // SECRET. Must only ever reach saveSecret, an S3 client, or a
  // {{secrets.*}}-referenced create-instance field. NEVER a log line, NEVER an
  // API response, NEVER the parameter store.
  secretAccessKey: string;
};

// ---------------------------------------------------------------------------
// SEED HARDENING (issue #1094 review follow-up). See "HOW STRONG THE
// CROSS-STACK ISOLATION ACTUALLY IS" in the header for why both pieces exist.
// ---------------------------------------------------------------------------

// Key stretching parameters. scryptSync(password, salt, keylen, options) —
// contract verified against the installed typings,
// node_modules/@types/node/crypto.d.ts:2168-2173 `function scryptSync(password:
// BinaryLike, salt: BinaryLike, keylen: number, options?: ScryptOptions):
// NonSharedBuffer`, with ScryptOptions at :2082-2090 `{ cost?, blockSize?,
// parallelization?, N?, r?, p?, maxmem? }` (N/r/p are aliases of the first
// three). Cost 2^15 with blockSize 8 is the conventional interactive
// setting: ~32 MiB of memory and tens of milliseconds per evaluation, which is
// the per-guess cost an offline attacker now pays. `maxmem` is set explicitly
// because 128 * cost * blockSize is exactly Node's 32 MiB default limit and
// would otherwise throw.
const SEED_STRETCH_COST = 32768;
const SEED_STRETCH_BLOCK_SIZE = 8;
const SEED_STRETCH_PARALLELIZATION = 1;
const SEED_STRETCH_MAXMEM = 96 * 1024 * 1024;
const SEED_STRETCH_KEY_BYTES = 32;
// The stretch salt is a fixed domain-separation string, not a per-deployment
// value: there is nowhere to persist a random salt that every read path could
// recover (OSC secrets are write-only, and the parameter store must hold no
// credential material — see reasons 1 and 2 in the header). A public, constant
// salt is fine here: what it buys is domain separation from any other use of
// the same password, and the attack this defends against is a guessing attack
// against ONE deployment's seed, where the cost factor — not salt uniqueness —
// is what raises the price. Versioned, because changing it changes every
// derived credential.
const SEED_STRETCH_SALT = 'open-videocore/object-store/seed-stretch/v1';

// Memoised stretched keys. scrypt is deliberately expensive, and the read paths
// (workspace-stack.ts, encore-s3-config.ts, main.ts) re-derive a credential per
// resolved stack, so paying the cost once per (process, seed) keeps the
// derivation functions synchronous and cheap at the call sites while an
// attacker — who must try a NEW seed per guess — gets no reuse at all. Keyed by
// the seed itself; the map is process-local and holds no more entries than the
// deployment has seeds (one, in practice).
const stretchedSeedKeys = new Map<string, Buffer>();

function deriveStretchedSeedKey(seed: string): Buffer {
  const cached = stretchedSeedKeys.get(seed);
  if (cached) return cached;
  const key = scryptSync(seed, SEED_STRETCH_SALT, SEED_STRETCH_KEY_BYTES, {
    cost: SEED_STRETCH_COST,
    blockSize: SEED_STRETCH_BLOCK_SIZE,
    parallelization: SEED_STRETCH_PARALLELIZATION,
    maxmem: SEED_STRETCH_MAXMEM
  });
  stretchedSeedKeys.set(seed, key);
  return key;
}

// Minimum seed strength for ISSUING a per-stack credential. 24 characters is
// the floor on length; the entropy floor is what actually decides, and is
// estimated conservatively below. 112 bits is far beyond any feasible offline
// search even without the stretching above, and is comfortably met by any
// generated password that also clears the length floor (e.g. 32 random
// base64url characters, which the estimator below scores at ~155 bits —
// measured, not assumed) while rejecting
// the short human-chosen passwords this check exists to catch.
export const MINIMUM_OBJECT_STORE_SEED_LENGTH = 24;
export const MINIMUM_OBJECT_STORE_SEED_ENTROPY_BITS = 112;

export type ObjectStoreCredentialSeedAssessment = {
  // True when the seed may be used to ISSUE new per-stack credentials.
  acceptable: boolean;
  // Conservative lower-bound estimate, for the operator-facing log line. Never
  // contains any part of the seed.
  estimatedEntropyBits: number;
  // Why it was rejected, for the same log line. Absent when acceptable.
  reason?: string;
};

// Estimate a lower bound on the seed's entropy, and decide whether it is strong
// enough to issue credentials from. PURE and seed-value-free in its output, so
// the result is safe to log.
//
// The estimate is the smaller of two standard bounds, which together refuse
// both "short" and "long but repetitive":
//   - CHARACTER-CLASS bound: length * log2(pool), pool being the combined size
//     of the character classes present (26 lowercase + 26 uppercase + 10
//     digits + 33 printable others). This is the usual password-strength
//     estimate and assumes the attacker knows only the classes used.
//   - DISTINCT-CHARACTER bound: length * log2(distinct characters used). This
//     is what stops `aaaa...` (40 chars, 1 distinct -> 0 bits) from being
//     scored as a strong 26-symbol password, which the class bound alone would
//     do.
// Both are heuristics, not measurements — they cannot detect a dictionary word
// — which is why they sit in FRONT of the stretching rather than instead of it.
export function assessObjectStoreCredentialSeed(
  seed: string | undefined
): ObjectStoreCredentialSeedAssessment {
  if (!seed || seed.length === 0) {
    return { acceptable: false, estimatedEntropyBits: 0, reason: 'no seed' };
  }
  if (seed.length < MINIMUM_OBJECT_STORE_SEED_LENGTH) {
    return {
      acceptable: false,
      estimatedEntropyBits: 0,
      reason: `shorter than the ${MINIMUM_OBJECT_STORE_SEED_LENGTH}-character minimum`
    };
  }

  let pool = 0;
  if (/[a-z]/.test(seed)) pool += 26;
  if (/[A-Z]/.test(seed)) pool += 26;
  if (/[0-9]/.test(seed)) pool += 10;
  if (/[^A-Za-z0-9]/.test(seed)) pool += 33;
  const distinct = new Set(seed.split('')).size;

  const classBound = seed.length * Math.log2(pool);
  const distinctBound = seed.length * Math.log2(distinct);
  const estimatedEntropyBits = Math.floor(Math.min(classBound, distinctBound));

  if (estimatedEntropyBits < MINIMUM_OBJECT_STORE_SEED_ENTROPY_BITS) {
    return {
      acceptable: false,
      estimatedEntropyBits,
      reason:
        `estimated entropy below the ` +
        `${MINIMUM_OBJECT_STORE_SEED_ENTROPY_BITS}-bit minimum`
    };
  }
  return { acceptable: true, estimatedEntropyBits };
}

// Derive the stack's access key id. Stable for a given
// (seed, stackName, generation) triple, so a retried/idempotent provision
// within one generation computes the same id the live instance was created
// with, while a NEW generation yields a different id for the same stack name.
// `generation` defaults to generation zero (the pre-generation derivation) so
// credentials issued before the generation component still resolve.
export function deriveObjectStoreAccessKeyId(
  seed: string,
  stackName: string,
  generation: ObjectStoreCredentialGeneration = LEGACY_CREDENTIAL_GENERATION
): string {
  const message =
    generation.length > 0
      ? `${ACCESS_KEY_ID_CONTEXT}/${stackName}/g=${generation}`
      : `${ACCESS_KEY_ID_CONTEXT}/${stackName}`;
  const digest = createHmac('sha256', deriveStretchedSeedKey(seed))
    .update(message)
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
  return createHmac('sha256', deriveStretchedSeedKey(seed))
    .update(`${SECRET_ACCESS_KEY_CONTEXT}/${accessKeyId}`)
    .digest('base64url')
    .slice(0, SECRET_ACCESS_KEY_LENGTH);
}

// The full per-stack credential for a stack name and generation. Used at
// PROVISION time, where the stack name is authoritative and the id has not been
// stored yet. Pass a FRESH generation from
// newObjectStoreCredentialGeneration() when issuing; the default (generation
// zero) reproduces the pre-generation derivation and must only be used to
// resolve credentials issued before the generation component existed.
export function deriveObjectStoreCredential(
  seed: string,
  stackName: string,
  generation: ObjectStoreCredentialGeneration = LEGACY_CREDENTIAL_GENERATION
): ObjectStoreCredential {
  const accessKeyId = deriveObjectStoreAccessKeyId(seed, stackName, generation);
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
//     NOTE: deliberately NOT gated on the seed's strength
//     (assessObjectStoreCredentialSeed). The gate belongs at ISSUE time; here
//     the stored id proves a live instance was created with this derived
//     credential, so refusing to re-derive it would lock the API out of a
//     working stack instead of protecting anything.
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
  // The derivation seed (MINIO_ROOT_PASSWORD). A seed that is empty OR that
  // fails assessObjectStoreCredentialSeed yields the legacy fallback on the
  // ISSUE branch — see the gate at the end of this function.
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
  // The generation to mint a NEW credential under (see GENERATION in the
  // header). Supply `newObjectStoreCredentialGeneration()` from the provision
  // path so a reused stack name cannot be handed back a retired credential.
  // Only read on the ISSUE branch: a stack that already has a recorded access
  // key id keeps that id verbatim, whatever generation it was issued under.
  // Omitted/empty means generation zero, i.e. the pre-generation derivation.
  generation?: ObjectStoreCredentialGeneration;
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

  // ISSUE-TIME SEED STRENGTH GATE (review follow-up). Below the strength floor,
  // a derived secret would be a liability rather than an improvement: the
  // secret travels as a plaintext field to spawned transcoders and per-job
  // instances, and a weak seed makes one such leak enough to recover the seed
  // offline and with it every other stack's credential. So a weak seed is
  // treated exactly like an absent one — the stack keeps the legacy
  // deployment-wide credential, i.e. the pre-#1094 behaviour, which is no worse
  // than the deployment has today. Only the ISSUE branch is gated: the reuse
  // branch above must still re-derive the credential a live instance was
  // actually created with, whatever the seed's strength.
  if (!assessObjectStoreCredentialSeed(args.seed).acceptable) return legacy;

  // Issue a NEW credential, under the caller-supplied generation.
  return {
    credential: deriveObjectStoreCredential(
      args.seed,
      args.stackName,
      args.generation ?? LEGACY_CREDENTIAL_GENERATION
    ),
    perStack: true
  };
}

// WHY #1095 (bucket-scoped keys) CANNOT BE SATISFIED BY THIS MODULE ALONE.
// Verified against the contracts, not assumed:
//   - the only credential fields this repo's object-store create body carries
//     are `RootUser` + `RootPassword` (routes/provision.ts:1006-1007). NOTE:
//     this is the repo's usage, NOT the upstream OSC service schema, which
//     could not be fetched here — whether the service exposes any additional
//     user/policy field MUST be confirmed against the OSC service schema
//     before #1095 is designed. On the usage as it stands, the key a stack is
//     provisioned with is that instance's ROOT user.
//   - creating a non-root user restricted to `arn:aws:s3:::<source>/*` and
//     `arn:aws:s3:::<packaged>/*` therefore needs the object store's ADMIN API
//     (add-canned-policy + add-user / add-service-account). The object-store JS
//     client (`minio@^8`) exposes no admin surface: `makeRequestAsync` is its
//     only signed escape hatch (node_modules/minio/dist/main/internal/
//     client.d.ts:156, options type `RequestOption = Partial<IRequest> & ...`
//     with `path` from IRequest), and while that can reach an admin path, the
//     add-user and add-service-account bodies must be encrypted with the admin
//     secret, which the client does not implement.
//   - bucket POLICIES (the SDK's setBucketPolicy, already used for the public
//     packaged-read policy in routes/provision.ts) cannot substitute: they bind
//     a principal, and a root/admin identity is not constrained by them.
// So #1095 needs either an OSC object-store option for a scoped user, or an
// admin-API-capable client. Logged as OSC friction; the constant below exists
// so call sites can reference the limitation instead of restating it.
export const OBJECT_STORE_BUCKET_SCOPE_LIMITATION =
  'per-stack object-store keys are the instance root user: the create body ' +
  'carries only RootUser/RootPassword and the object-store client exposes no ' +
  'admin API, so a bucket-scoped non-admin user cannot be created at ' +
  'provision time (#1095)';
