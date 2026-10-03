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
import {
  LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
  OBJECT_STORE_ACCESS_KEY_ID_PREFIX,
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
