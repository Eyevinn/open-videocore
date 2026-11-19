// The structured packager failure `reason` -> errorDetail.code mapping
// (issue #1340, broken out of #1336). Additive to package-failure-detail.test.ts,
// which covers the message-text classification this builds on.
//
// CONTRACTS VERIFIED (no shapes guessed):
//   - `STEP_ERROR_CODES` / `StepErrorDetail` / `stepErrorDetailSchema` —
//     src/pipeline/step-error-detail.ts:74-82 (the tuple), :110-136 (the type),
//     :138+ (the response schema). Every code asserted below is a member of the
//     tuple; a code outside it would be dropped on read by `toStepErrorDetail`
//     (src/data/couch-pipeline-repo.ts:295), so each produced detail is parsed
//     with that schema here.
//   - The packager-side callback the `reason` will arrive on:
//     `CallbackListener.onPackageFail(message, err)` POSTs `{ message }` only —
//     Eyevinn/encore-packager@main src/callbackListener.ts:88-108, interface
//     `PackageListener` at src/packageListener.ts:3. `reason` is therefore
//     OPTIONAL on our side and the no-reason path must stay as it was.
//   - The API-side body it is added to: `packagerFailureSchema`,
//     src/routes/internal.ts:101.

import { describe, it, expect } from 'vitest';

import { STEP_ERROR_CODES, stepErrorDetailSchema } from './step-error-detail.js';
import {
  PACKAGE_ERROR_MESSAGES,
  PACKAGE_FAILURE_REASONS,
  buildPackageFailureErrorDetail,
  classifyPackageFailure,
  codeForPackageFailureReason,
  normalisePackageFailureReason
} from './package-failure-detail.js';

// A message that the text classifier places in the catch-all, so a test that
// asserts a sharper code can only be getting it from the `reason`.
const UNCLASSIFIABLE = 'packaging of job 7 failed: exit status 1';

describe('the known packager failure reasons (#1340)', () => {
  it('maps every known reason to a declared step error code', () => {
    for (const reason of PACKAGE_FAILURE_REASONS) {
      const code = codeForPackageFailureReason(reason);
      expect(STEP_ERROR_CODES).toContain(code);
    }
  });

  it('maps unsupported_media and invalid_credentials to the two actionable codes', () => {
    expect(codeForPackageFailureReason('unsupported_media')).toBe('packager_unsupported_media');
    expect(codeForPackageFailureReason('invalid_credentials')).toBe('packager_auth');
    expect(codeForPackageFailureReason('packaging_failed')).toBe('packager_failed');
  });

  it('does not claim the watchdog-only timeout code from a reason', () => {
    // `packager_timeout` means "no signal arrived at all", so no signal can
    // assert it: it stays reachable only from the stall sweep.
    for (const reason of PACKAGE_FAILURE_REASONS) {
      expect(codeForPackageFailureReason(reason)).not.toBe('packager_timeout');
    }
  });
});

describe('validating a received reason against the known set', () => {
  it('accepts each known token', () => {
    for (const reason of PACKAGE_FAILURE_REASONS) {
      expect(normalisePackageFailureReason(reason)).toBe(reason);
    }
  });

  it('accepts a known token with different case or surrounding whitespace', () => {
    expect(normalisePackageFailureReason('UNSUPPORTED_MEDIA')).toBe('unsupported_media');
    expect(normalisePackageFailureReason('  Invalid_Credentials \n')).toBe('invalid_credentials');
  });

  it('rejects anything outside the set, including a non-string', () => {
    for (const value of [
      'unsupported media',
      'PARSER_FAILURE',
      'packager_auth',
      '',
      'something-new',
      undefined,
      null,
      42,
      { reason: 'unsupported_media' }
    ]) {
      expect(normalisePackageFailureReason(value)).toBeUndefined();
    }
  });
});

describe('classifying with a reason present', () => {
  it('lets a specific reason decide the code regardless of the message text', () => {
    expect(classifyPackageFailure(UNCLASSIFIABLE, 'unsupported_media')).toBe(
      'packager_unsupported_media'
    );
    // The #1335 class: a rejected OSC token on the packager, which today never
    // reaches us at all and only surfaces at the 15-minute watchdog.
    expect(classifyPackageFailure(UNCLASSIFIABLE, 'invalid_credentials')).toBe('packager_auth');
  });

  it('wins over a message that would have classified differently', () => {
    expect(classifyPackageFailure('request failed with status 401', 'unsupported_media')).toBe(
      'packager_unsupported_media'
    );
    expect(classifyPackageFailure('Error: PARSER_FAILURE', 'invalid_credentials')).toBe(
      'packager_auth'
    );
  });

  it('lets the packager catch-all reason defer to a sharper message', () => {
    // `packaging_failed` asserts only "it failed" — the same thing the text
    // classifier's own default says — so matching the text can only sharpen it.
    expect(classifyPackageFailure('Error: 8 (PARSER_FAILURE)', 'packaging_failed')).toBe(
      'packager_unsupported_media'
    );
    expect(classifyPackageFailure(UNCLASSIFIABLE, 'packaging_failed')).toBe('packager_failed');
  });

  it('falls back to the message classification for an unknown reason', () => {
    expect(classifyPackageFailure('Error: 8 (PARSER_FAILURE)', 'brand_new_class')).toBe(
      'packager_unsupported_media'
    );
    expect(classifyPackageFailure(UNCLASSIFIABLE, 'brand_new_class')).toBe('packager_failed');
  });

  it('never copies the reason into the detail, and the detail still validates', () => {
    const detail = buildPackageFailureErrorDetail(UNCLASSIFIABLE, 'invalid_credentials');
    expect(detail.code).toBe('packager_auth');
    expect(Object.keys(detail).sort()).toEqual(['code', 'message']);
    expect(detail.message).toBe(PACKAGE_ERROR_MESSAGES.packager_auth);
    expect(detail.message).not.toContain('invalid_credentials');
    expect(stepErrorDetailSchema.safeParse(detail).success).toBe(true);
  });
});

describe('classifying with no reason is the pre-#1340 behaviour', () => {
  it('is identical whether the reason argument is omitted or undefined', () => {
    for (const text of [
      UNCLASSIFIABLE,
      'Error: 8 (PARSER_FAILURE): cannot parse media file',
      'request failed with status 401',
      'storage answered 403 for the input object',
      '',
      undefined
    ]) {
      expect(classifyPackageFailure(text, undefined)).toBe(classifyPackageFailure(text));
      expect(buildPackageFailureErrorDetail(text, undefined)).toEqual(
        buildPackageFailureErrorDetail(text)
      );
    }
  });

  it('still classifies from the message alone', () => {
    expect(classifyPackageFailure('Error: 8 (PARSER_FAILURE)')).toBe('packager_unsupported_media');
    expect(classifyPackageFailure('Unauthorized')).toBe('packager_auth');
    expect(classifyPackageFailure(UNCLASSIFIABLE)).toBe('packager_failed');
  });
});
