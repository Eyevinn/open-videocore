// Per-stack object-store credentials — derivation, resolution and the
// provision-time decision table (issue #1094, core fix from #1089).
//
// Acceptance criteria covered here:
//   - two provisioned stacks get DIFFERENT credentials (both id and secret);
//   - a credential issued for stack A is not the credential stack B's object
//     store accepts (the pre-condition for the 403 in the live acceptance
//     check — stack A's key is simply not stack B's root user);
//   - no secret value is derivable from what is persisted alone: the stored
//     access key id is useless without the deployment seed;
//   - the credential is STABLE for a stack, so the idempotent provision path
//     (#417) cannot mint a second generation on a retry;
//   - the compatible fallback for stacks provisioned before #1094 is EXACTLY
//     the legacy pair (`admin` + the deployment-wide password), so #1096 is
//     still the issue that migrates them.

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
  MAXIMUM_ESTIMATED_ENTROPY_AT_MINIMUM_SEED_LENGTH,
  MINIMUM_OBJECT_STORE_SEED_ENTROPY_BITS,
  MINIMUM_OBJECT_STORE_SEED_LENGTH,
  OBJECT_STORE_ACCESS_KEY_ID_PREFIX,
  assessObjectStoreCredentialSeed,
  deriveObjectStoreAccessKeyId,
  deriveObjectStoreCredential,
  deriveObjectStoreSecretAccessKey,
  planObjectStoreCredential,
  resolveObjectStoreCredential
} from './object-store-credentials.js';

const SEED = 'deployment-wide-object-store-password';
const OTHER_SEED = 'a-rotated-deployment-wide-password';

describe('per-stack object-store credential derivation (issue #1094)', () => {
  it('gives two stacks different access key ids AND different secrets', () => {
    const a = deriveObjectStoreCredential(SEED, 'stack-a');
    const b = deriveObjectStoreCredential(SEED, 'stack-b');

    expect(a.accessKeyId).not.toBe(b.accessKeyId);
    expect(a.secretAccessKey).not.toBe(b.secretAccessKey);
    // And neither is the process-global pair the stacks used to share.
    expect(a.accessKeyId).not.toBe(LEGACY_OBJECT_STORE_ACCESS_KEY_ID);
    expect(b.accessKeyId).not.toBe(LEGACY_OBJECT_STORE_ACCESS_KEY_ID);
    expect(a.secretAccessKey).not.toBe(SEED);
    expect(b.secretAccessKey).not.toBe(SEED);
  });

  it('is stable for a stack, so an idempotent re-provision reuses the same credential', () => {
    const first = deriveObjectStoreCredential(SEED, 'stack-a');
    const second = deriveObjectStoreCredential(SEED, 'stack-a');
    expect(second).toEqual(first);
  });

  it('produces an access key id over a safe charset and the conventional length', () => {
    const { accessKeyId } = deriveObjectStoreCredential(SEED, 'stack-a');
    expect(accessKeyId).toMatch(/^[a-z0-9]{20}$/);
    expect(accessKeyId.startsWith(OBJECT_STORE_ACCESS_KEY_ID_PREFIX)).toBe(true);
  });

  it('produces a 40-char URL-safe secret', () => {
    const { secretAccessKey } = deriveObjectStoreCredential(SEED, 'stack-a');
    expect(secretAccessKey).toMatch(/^[A-Za-z0-9_-]{40}$/);
  });

  it('does not let a stack-A credential open stack B: the derived secret is keyed to the id', () => {
    const a = deriveObjectStoreCredential(SEED, 'stack-a');
    const b = deriveObjectStoreCredential(SEED, 'stack-b');

    // Stack B's object store only accepts B's id+secret pair. Presenting A's
    // id, or A's secret under B's id, yields a credential B cannot match —
    // which is what makes the live cross-stack call a 403 rather than a 200.
    expect(deriveObjectStoreSecretAccessKey(SEED, b.accessKeyId)).toBe(
      b.secretAccessKey
    );
    expect(deriveObjectStoreSecretAccessKey(SEED, a.accessKeyId)).not.toBe(
      b.secretAccessKey
    );
  });

  it('cannot be reconstructed from the persisted (non-secret) id alone', () => {
    const accessKeyId = deriveObjectStoreAccessKeyId(SEED, 'stack-a');
    // The id is all that is ever persisted. Without the right seed it yields a
    // different secret, so a parameter-store leak discloses no credential.
    expect(deriveObjectStoreSecretAccessKey(OTHER_SEED, accessKeyId)).not.toBe(
      deriveObjectStoreSecretAccessKey(SEED, accessKeyId)
    );
  });
});

describe('resolveObjectStoreCredential (read path, issue #1094)', () => {
  it('re-derives the per-stack secret from the stored id', () => {
    const issued = deriveObjectStoreCredential(SEED, 'stack-a');
    const resolved = resolveObjectStoreCredential({
      storedAccessKeyId: issued.accessKeyId,
      seed: SEED,
      legacySecretAccessKey: SEED
    });
    expect(resolved).toEqual(issued);
  });

  it('resolves two stacks to different credentials from their own stored ids', () => {
    const a = deriveObjectStoreCredential(SEED, 'stack-a');
    const b = deriveObjectStoreCredential(SEED, 'stack-b');
    const resolvedA = resolveObjectStoreCredential({
      storedAccessKeyId: a.accessKeyId,
      seed: SEED,
      legacySecretAccessKey: SEED
    });
    const resolvedB = resolveObjectStoreCredential({
      storedAccessKeyId: b.accessKeyId,
      seed: SEED,
      legacySecretAccessKey: SEED
    });
    expect(resolvedA.accessKeyId).not.toBe(resolvedB.accessKeyId);
    expect(resolvedA.secretAccessKey).not.toBe(resolvedB.secretAccessKey);
  });

  it('falls back to the EXACT legacy pair for a stack provisioned before #1094', () => {
    expect(
      resolveObjectStoreCredential({
        storedAccessKeyId: undefined,
        seed: SEED,
        legacySecretAccessKey: 'legacy-password'
      })
    ).toEqual({
      accessKeyId: LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
      secretAccessKey: 'legacy-password'
    });
  });

  it('falls back when no seed is configured, and treats a blank stored id as absent', () => {
    expect(
      resolveObjectStoreCredential({
        storedAccessKeyId: 'ovc0123456789abcdef',
        seed: undefined,
        legacySecretAccessKey: 'legacy-password'
      }).accessKeyId
    ).toBe(LEGACY_OBJECT_STORE_ACCESS_KEY_ID);

    expect(
      resolveObjectStoreCredential({
        storedAccessKeyId: '   ',
        seed: SEED,
        legacySecretAccessKey: 'legacy-password'
      }).accessKeyId
    ).toBe(LEGACY_OBJECT_STORE_ACCESS_KEY_ID);
  });
});

describe('planObjectStoreCredential (provision-time decision, issue #1094)', () => {
  const base = {
    stackName: 'stack-a',
    seed: SEED,
    legacySecretAccessKey: 'legacy-password',
    storedAccessKeyId: undefined as string | undefined,
    storedConfigExists: false,
    objectStoreInstanceExists: false,
    paramStoreAvailable: true
  };

  it('issues a NEW per-stack credential for a stack being provisioned for the first time', () => {
    const plan = planObjectStoreCredential(base);
    expect(plan.perStack).toBe(true);
    expect(plan.credential).toEqual(deriveObjectStoreCredential(SEED, 'stack-a'));
  });

  it('reuses the recorded id (and re-derives its secret) on a retried provision', () => {
    const issued = deriveObjectStoreCredential(SEED, 'stack-a');
    const plan = planObjectStoreCredential({
      ...base,
      storedAccessKeyId: issued.accessKeyId,
      storedConfigExists: true,
      // Even though the instance already exists — it was created with this id.
      objectStoreInstanceExists: true
    });
    expect(plan.perStack).toBe(true);
    expect(plan.credential).toEqual(issued);
  });

  it('keeps the legacy credential for an already-live object store with no recorded id', () => {
    // An adopted instance (#417 "already taken") keeps the root user it was
    // created with, so issuing a per-stack credential here would lock the API
    // out of a working stack. #1096 migrates it.
    const plan = planObjectStoreCredential({
      ...base,
      objectStoreInstanceExists: true
    });
    expect(plan).toEqual({
      credential: {
        accessKeyId: LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
        secretAccessKey: 'legacy-password'
      },
      perStack: false
    });
  });

  it('keeps the legacy credential for a pre-#1094 stored config', () => {
    const plan = planObjectStoreCredential({ ...base, storedConfigExists: true });
    expect(plan.perStack).toBe(false);
    expect(plan.credential.accessKeyId).toBe(LEGACY_OBJECT_STORE_ACCESS_KEY_ID);
  });

  it('keeps the legacy credential when there is no parameter store to record the id in', () => {
    const plan = planObjectStoreCredential({
      ...base,
      paramStoreAvailable: false
    });
    expect(plan.perStack).toBe(false);
    expect(plan.credential.accessKeyId).toBe(LEGACY_OBJECT_STORE_ACCESS_KEY_ID);
  });

  it('keeps the legacy credential when no seed is configured', () => {
    const plan = planObjectStoreCredential({ ...base, seed: '' });
    expect(plan.perStack).toBe(false);
    expect(plan.credential.accessKeyId).toBe(LEGACY_OBJECT_STORE_ACCESS_KEY_ID);
  });
});

// ---------------------------------------------------------------------------
// ISSUE-TIME SEED STRENGTH GATE (issue #1094 review).
//
// The gate shipped as 24 characters / 112 bits, a pair no seed of the
// documented length could satisfy (24 * log2(24) = 110 bits is the ceiling),
// so every new stack silently fell back to the shared deployment-wide
// credential and #1089 stayed unfixed. These cases pin the estimator, the
// mutual satisfiability of the two floors, and the fallback branch.
// ---------------------------------------------------------------------------

// A seed of exactly the documented minimum length, generated the way the docs
// say to generate one (`openssl rand -base64 32` shape, trimmed to the floor).
const DOCUMENTED_MINIMUM_SEED = randomBytes(64)
  .toString('base64url')
  .slice(0, MINIMUM_OBJECT_STORE_SEED_LENGTH);

describe('assessObjectStoreCredentialSeed (issue #1094 review)', () => {
  it('keeps the length and entropy floors mutually satisfiable', () => {
    // The regression this test exists for: the floors must be reachable
    // TOGETHER. The estimate is bounded by length * log2(distinct), so no seed
    // of the minimum length can exceed length * log2(length) bits.
    expect(MAXIMUM_ESTIMATED_ENTROPY_AT_MINIMUM_SEED_LENGTH).toBeGreaterThanOrEqual(
      MINIMUM_OBJECT_STORE_SEED_ENTROPY_BITS
    );
  });

  it('accepts a generated seed of exactly the documented minimum length', () => {
    // Follow README.md / public/docs/installation.html to the letter and the
    // gate MUST pass — otherwise the docs lead operators into the fallback.
    const assessment = assessObjectStoreCredentialSeed(DOCUMENTED_MINIMUM_SEED);
    expect(assessment).toEqual({
      acceptable: true,
      estimatedEntropyBits: assessment.estimatedEntropyBits
    });
    expect(assessment.estimatedEntropyBits).toBeGreaterThanOrEqual(
      MINIMUM_OBJECT_STORE_SEED_ENTROPY_BITS
    );
  });

  it('accepts a randomly generated seed at the documented length every time', () => {
    // Not a flake-by-design gate: a random base64url seed of the documented
    // length has headroom over the entropy floor, not a coin flip at it.
    for (let i = 0; i < 200; i++) {
      const seed = randomBytes(64)
        .toString('base64url')
        .slice(0, MINIMUM_OBJECT_STORE_SEED_LENGTH);
      expect(assessObjectStoreCredentialSeed(seed).acceptable).toBe(true);
    }
  });

  it('rejects an absent, empty or too-short seed with a seed-free reason', () => {
    expect(assessObjectStoreCredentialSeed(undefined)).toEqual({
      acceptable: false,
      estimatedEntropyBits: 0,
      reason: 'no seed'
    });
    expect(assessObjectStoreCredentialSeed('').acceptable).toBe(false);

    const short = DOCUMENTED_MINIMUM_SEED.slice(
      0,
      MINIMUM_OBJECT_STORE_SEED_LENGTH - 1
    );
    const assessment = assessObjectStoreCredentialSeed(short);
    expect(assessment.acceptable).toBe(false);
    expect(assessment.reason).toContain(
      `${MINIMUM_OBJECT_STORE_SEED_LENGTH}-character minimum`
    );
    // Nothing the assessment reports may echo the seed itself — it is logged.
    expect(JSON.stringify(assessment)).not.toContain(short);
  });

  it('rejects a long but repetitive seed on the distinct-character bound', () => {
    // 'aaaa...' clears the length floor and the class bound alone would score
    // it as a strong 26-symbol password; the distinct bound is what refuses it.
    const repetitive = 'a'.repeat(MINIMUM_OBJECT_STORE_SEED_LENGTH * 4);
    const assessment = assessObjectStoreCredentialSeed(repetitive);
    expect(assessment.acceptable).toBe(false);
    expect(assessment.estimatedEntropyBits).toBe(0);
    expect(assessment.reason).toContain(
      `${MINIMUM_OBJECT_STORE_SEED_ENTROPY_BITS}-bit minimum`
    );
  });

  it('is monotone around the entropy floor for same-alphabet seeds', () => {
    // Two distinct hex characters: log2(2) = 1 bit per char, so the boundary is
    // exactly the entropy floor in characters. One below rejects, one at it (if
    // it also clears the length floor) accepts on entropy.
    const pattern = (length: number): string => {
      let out = '';
      for (let i = 0; i < length; i++) out += i % 2 === 0 ? '0' : '1';
      return out;
    };
    const below = assessObjectStoreCredentialSeed(
      pattern(MINIMUM_OBJECT_STORE_SEED_ENTROPY_BITS - 1)
    );
    expect(below.acceptable).toBe(false);
    expect(below.estimatedEntropyBits).toBe(
      MINIMUM_OBJECT_STORE_SEED_ENTROPY_BITS - 1
    );

    const at = assessObjectStoreCredentialSeed(
      pattern(MINIMUM_OBJECT_STORE_SEED_ENTROPY_BITS)
    );
    expect(at.acceptable).toBe(true);
    expect(at.estimatedEntropyBits).toBe(
      MINIMUM_OBJECT_STORE_SEED_ENTROPY_BITS
    );
  });
});

describe('weak-seed fallback in planObjectStoreCredential (issue #1094 review)', () => {
  const base = {
    stackName: 'stack-a',
    legacySecretAccessKey: 'legacy-password',
    storedAccessKeyId: undefined as string | undefined,
    storedConfigExists: false,
    objectStoreInstanceExists: false,
    paramStoreAvailable: true
  };
  // Clears the length floor by a wide margin, fails the entropy floor.
  const WEAK_SEED = 'ab'.repeat(MINIMUM_OBJECT_STORE_SEED_LENGTH);

  it('issues a per-stack credential for a seed that meets the documented guidance', () => {
    const plan = planObjectStoreCredential({
      ...base,
      seed: DOCUMENTED_MINIMUM_SEED
    });
    expect(plan.perStack).toBe(true);
    expect(plan.downgradeReason).toBeUndefined();
    expect(plan.credential.accessKeyId).not.toBe(
      LEGACY_OBJECT_STORE_ACCESS_KEY_ID
    );
  });

  it('falls back to the shared credential for a weak seed, with a reason', () => {
    const plan = planObjectStoreCredential({ ...base, seed: WEAK_SEED });
    expect(plan.perStack).toBe(false);
    expect(plan.credential).toEqual({
      accessKeyId: LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
      secretAccessKey: 'legacy-password'
    });
    // The downgrade must be reportable — this is what makes it loud rather
    // than a silent disabling of per-stack isolation.
    expect(plan.downgradeReason).toBeTruthy();
    expect(plan.downgradeReason).toContain(
      String(MINIMUM_OBJECT_STORE_SEED_LENGTH)
    );
    // ... and must never carry the seed, since it is logged.
    expect(plan.downgradeReason).not.toContain(WEAK_SEED);
  });

  it('marks ONLY the weak-seed downgrade, not the expected fallbacks', () => {
    // An adopted instance and a pre-#1094 stored config are correct outcomes,
    // not misconfiguration, so they carry no downgradeReason to shout about.
    for (const args of [
      { objectStoreInstanceExists: true },
      { storedConfigExists: true },
      { paramStoreAvailable: false },
      { seed: '' }
    ]) {
      const plan = planObjectStoreCredential({
        ...base,
        seed: DOCUMENTED_MINIMUM_SEED,
        ...args
      });
      expect(plan.perStack).toBe(false);
      expect(plan.downgradeReason).toBeUndefined();
    }
  });

  it('still re-derives an already-issued credential under a weak seed', () => {
    // The gate is ISSUE-time only. A live instance was created with a derived
    // id; refusing to re-derive its secret would lock the API out of a working
    // stack instead of protecting anything.
    const issued = deriveObjectStoreCredential(WEAK_SEED, 'stack-a', 'gen01');
    const plan = planObjectStoreCredential({
      ...base,
      seed: WEAK_SEED,
      storedAccessKeyId: issued.accessKeyId,
      storedConfigExists: true,
      objectStoreInstanceExists: true
    });
    expect(plan.perStack).toBe(true);
    expect(plan.credential).toEqual(issued);
    expect(plan.downgradeReason).toBeUndefined();
  });

  it('leaves the READ path ungated, so a weak-seed stack stays readable', () => {
    const issued = deriveObjectStoreCredential(WEAK_SEED, 'stack-a', 'gen01');
    expect(
      resolveObjectStoreCredential({
        storedAccessKeyId: issued.accessKeyId,
        seed: WEAK_SEED,
        legacySecretAccessKey: 'legacy-password'
      })
    ).toEqual(issued);
  });
});
