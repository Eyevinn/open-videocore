// The single error type every `KeyProvider` adapter fails with (ADR-008 §8 the
// `errorCode` enum, §10 "Logging and error redaction", §12 the failure table;
// issue #1261).
//
// CONTRACT SOURCES (contract-first, CLAUDE.md rule 7):
//   - src/types/drm.ts `DRM_ERROR_CODES` / `DrmErrorCode` (landed by #1259) —
//     the machine-readable failure classes persisted on `AssetDrm.errorCode`.
//     Imported, never redeclared, so the adapter cannot surface a code the
//     persisted model does not know.
//   - ADR-008 §10: "Provider error bodies are not echoed verbatim (they can
//     contain key material or credentials); they are mapped to the `errorCode`
//     enum of §8 with a truncated, scrubbed message."
//
// WHY A DEDICATED CLASS. A caller (the package step) has to decide retry,
// `drm.status` and the HTTP response from the FAILURE CLASS, not from a string.
// Carrying `errorCode` on the error means the classification is made once, at
// the boundary that observed the failure, and nothing downstream re-derives it
// by matching on prose.
//
// NO PROVIDER TEXT, EVER. `message` is written by THIS repository: every
// construction site passes a fixed, hand-written string. There is deliberately
// no `cause`-style member for a provider body, because an optional member that
// can hold a response body is an optional member that will eventually be
// logged. The provider's own bytes stop at the adapter.

import type { DrmErrorCode } from '../types/drm.js';

export class KeyProviderError extends Error {
  readonly errorCode: DrmErrorCode;
  // How many provider requests were made before giving up. Non-secret
  // diagnostics, safe to log (ADR-008 §10 permits method/host/status/latency/
  // contentId-class fields).
  readonly attempts: number | undefined;

  constructor(errorCode: DrmErrorCode, message: string, attempts?: number) {
    super(message);
    this.name = 'KeyProviderError';
    this.errorCode = errorCode;
    this.attempts = attempts;
  }
}

export function isKeyProviderError(value: unknown): value is KeyProviderError {
  return value instanceof KeyProviderError;
}
