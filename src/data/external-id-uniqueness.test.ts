// Env-mode resolution for per-namespace external-id uniqueness (issue #577).
//
// Contract under test (src/data/external-id-uniqueness.ts):
//   - externalIdUniquenessModeFromEnv(env) -> 'advisory' | 'enforced'
//     (external-id-uniqueness.ts:50-60): only the case-insensitive, trimmed
//     literal `enforced` enables enforcement; anything else (unset, empty,
//     whitespace, typo/unknown) resolves to the advisory default so a typo can
//     never silently enable a rejecting behaviour.
//   - DEFAULT_EXTERNAL_ID_UNIQUENESS_MODE === 'advisory'
//     (external-id-uniqueness.ts:44).
//   - EXTERNAL_ID_UNIQUENESS_ENV === 'EXTERNAL_ID_UNIQUENESS'
//     (external-id-uniqueness.ts:28).
//   - externalIdUniquenessEnforced(env) -> boolean (external-id-uniqueness.ts:63-67).
//
// The resolver takes an explicit `env` param (defaulting to process.env), so
// these tests pass a plain object rather than mutating process.env.

import { describe, it, expect } from 'vitest';

import {
  externalIdUniquenessModeFromEnv,
  externalIdUniquenessEnforced,
  DEFAULT_EXTERNAL_ID_UNIQUENESS_MODE,
  EXTERNAL_ID_UNIQUENESS_ENV
} from './external-id-uniqueness.js';

describe('externalIdUniquenessModeFromEnv (issue #577)', () => {
  it('resolves advisory (the default) when the var is unset', () => {
    expect(externalIdUniquenessModeFromEnv({})).toBe('advisory');
    expect(DEFAULT_EXTERNAL_ID_UNIQUENESS_MODE).toBe('advisory');
  });

  it('resolves advisory for an empty string', () => {
    expect(externalIdUniquenessModeFromEnv({ [EXTERNAL_ID_UNIQUENESS_ENV]: '' })).toBe('advisory');
  });

  it('resolves advisory for whitespace-only', () => {
    expect(externalIdUniquenessModeFromEnv({ [EXTERNAL_ID_UNIQUENESS_ENV]: '   ' })).toBe(
      'advisory'
    );
  });

  it('resolves advisory when the value is the literal `advisory`', () => {
    expect(externalIdUniquenessModeFromEnv({ [EXTERNAL_ID_UNIQUENESS_ENV]: 'ADVISORY' })).toBe(
      'advisory'
    );
    expect(externalIdUniquenessModeFromEnv({ [EXTERNAL_ID_UNIQUENESS_ENV]: 'advisory' })).toBe(
      'advisory'
    );
  });

  it('resolves enforced for `enforced` case-insensitively and with surrounding whitespace', () => {
    expect(externalIdUniquenessModeFromEnv({ [EXTERNAL_ID_UNIQUENESS_ENV]: 'enforced' })).toBe(
      'enforced'
    );
    expect(externalIdUniquenessModeFromEnv({ [EXTERNAL_ID_UNIQUENESS_ENV]: 'Enforced' })).toBe(
      'enforced'
    );
    expect(externalIdUniquenessModeFromEnv({ [EXTERNAL_ID_UNIQUENESS_ENV]: 'ENFORCED' })).toBe(
      'enforced'
    );
    expect(externalIdUniquenessModeFromEnv({ [EXTERNAL_ID_UNIQUENESS_ENV]: '  enforced  ' })).toBe(
      'enforced'
    );
  });

  it('resolves advisory (backward-compatible default) for a typo / unknown value', () => {
    // A typo must NEVER silently enable rejecting behaviour.
    expect(externalIdUniquenessModeFromEnv({ [EXTERNAL_ID_UNIQUENESS_ENV]: 'enforce' })).toBe(
      'advisory'
    );
    expect(externalIdUniquenessModeFromEnv({ [EXTERNAL_ID_UNIQUENESS_ENV]: 'strict' })).toBe(
      'advisory'
    );
    expect(externalIdUniquenessModeFromEnv({ [EXTERNAL_ID_UNIQUENESS_ENV]: 'true' })).toBe(
      'advisory'
    );
  });
});

describe('externalIdUniquenessEnforced predicate (issue #577)', () => {
  it('is true only for the enforced literal', () => {
    expect(externalIdUniquenessEnforced({ [EXTERNAL_ID_UNIQUENESS_ENV]: 'enforced' })).toBe(true);
    expect(externalIdUniquenessEnforced({ [EXTERNAL_ID_UNIQUENESS_ENV]: 'Enforced' })).toBe(true);
  });

  it('is false when unset, advisory, or an unknown value', () => {
    expect(externalIdUniquenessEnforced({})).toBe(false);
    expect(externalIdUniquenessEnforced({ [EXTERNAL_ID_UNIQUENESS_ENV]: 'advisory' })).toBe(false);
    expect(externalIdUniquenessEnforced({ [EXTERNAL_ID_UNIQUENESS_ENV]: 'enforce' })).toBe(false);
  });
});
