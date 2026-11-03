// Custom source/packaged bucket resolution (issue #1301).
//
// These are the pure decisions behind honouring `sourceStorage.bucket` /
// `packagedStorage.bucket`: whether the flag is on, which bucket each role is
// bound to, the fail-loud finding set for the flag-off state (#1300), and the
// re-provision rebind rejection (acceptance criterion 3).

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PACKAGED_BUCKET,
  DEFAULT_SOURCE_BUCKET,
  bucketRebindRejections,
  honourCustomBucketsEnabled,
  resolveStackBuckets,
  validateCustomBucketSupport
} from './custom-buckets.js';

const CUSTOM_SOURCE = 'acme-media-ingest';
const CUSTOM_PACKAGED = 'acme-streaming-output';

describe('honourCustomBucketsEnabled (issue #1301)', () => {
  it('is OFF when the flag is unset — the default must not change behaviour', () => {
    expect(honourCustomBucketsEnabled({})).toBe(false);
  });

  it('is OFF for an empty or unrecognised value', () => {
    for (const raw of ['', ' ', '0', 'false', 'no', 'off', 'maybe']) {
      expect(honourCustomBucketsEnabled({ HONOUR_CUSTOM_BUCKETS: raw })).toBe(
        false
      );
    }
  });

  it('is ON for the explicit opt-in values, case and padding insensitive', () => {
    for (const raw of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(honourCustomBucketsEnabled({ HONOUR_CUSTOM_BUCKETS: raw })).toBe(
        true
      );
    }
  });
});

describe('resolveStackBuckets (issue #1301)', () => {
  it('returns the stack defaults when the flag is off, even with buckets supplied', () => {
    expect(
      resolveStackBuckets(
        {
          sourceStorage: { bucket: CUSTOM_SOURCE },
          packagedStorage: { bucket: CUSTOM_PACKAGED }
        },
        { honourCustomBuckets: false }
      )
    ).toEqual({
      sourceBucket: DEFAULT_SOURCE_BUCKET,
      packagedBucket: DEFAULT_PACKAGED_BUCKET
    });
  });

  it('binds each supplied bucket when the flag is on', () => {
    expect(
      resolveStackBuckets(
        {
          sourceStorage: { bucket: CUSTOM_SOURCE },
          packagedStorage: { bucket: CUSTOM_PACKAGED }
        },
        { honourCustomBuckets: true }
      )
    ).toEqual({
      sourceBucket: CUSTOM_SOURCE,
      packagedBucket: CUSTOM_PACKAGED
    });
  });

  it('keeps the default for an OMITTED role while honouring the supplied one', () => {
    expect(
      resolveStackBuckets(
        { packagedStorage: { bucket: CUSTOM_PACKAGED } },
        { honourCustomBuckets: true }
      )
    ).toEqual({
      sourceBucket: DEFAULT_SOURCE_BUCKET,
      packagedBucket: CUSTOM_PACKAGED
    });
  });

  it('falls back to the default for a blank bucket rather than addressing ""', () => {
    expect(
      resolveStackBuckets(
        { sourceStorage: { bucket: '   ' } },
        { honourCustomBuckets: true }
      ).sourceBucket
    ).toBe(DEFAULT_SOURCE_BUCKET);
  });

  it('returns the defaults for a zero-config request under either flag state', () => {
    for (const honourCustomBuckets of [false, true]) {
      expect(resolveStackBuckets({}, { honourCustomBuckets })).toEqual({
        sourceBucket: DEFAULT_SOURCE_BUCKET,
        packagedBucket: DEFAULT_PACKAGED_BUCKET
      });
    }
  });
});

describe('validateCustomBucketSupport (fail-loud finding set, issue #1300/#1301)', () => {
  it('flags each non-default bucket while the flag is off', () => {
    const findings = validateCustomBucketSupport(
      {
        sourceStorage: { bucket: CUSTOM_SOURCE },
        packagedStorage: { bucket: CUSTOM_PACKAGED }
      },
      { honourCustomBuckets: false }
    );
    expect(findings.map((f) => f.field).sort()).toEqual([
      'packagedStorage.bucket',
      'sourceStorage.bucket'
    ]);
    // The message must name the flag that enables honouring, so the operator
    // learns the way forward rather than only that it does not work.
    expect(findings[0]?.message).toContain('HONOUR_CUSTOM_BUCKETS');
  });

  it('does not flag a supplied bucket that already equals the default', () => {
    expect(
      validateCustomBucketSupport(
        {
          sourceStorage: { bucket: DEFAULT_SOURCE_BUCKET },
          packagedStorage: { bucket: DEFAULT_PACKAGED_BUCKET }
        },
        { honourCustomBuckets: false }
      )
    ).toEqual([]);
  });

  it('flags nothing once the flag is on — the buckets are honoured', () => {
    expect(
      validateCustomBucketSupport(
        {
          sourceStorage: { bucket: CUSTOM_SOURCE },
          packagedStorage: { bucket: CUSTOM_PACKAGED }
        },
        { honourCustomBuckets: true }
      )
    ).toEqual([]);
  });
});

describe('bucketRebindRejections (re-provision with a changed bucket, issue #1301)', () => {
  const bound = {
    sourceBucket: CUSTOM_SOURCE,
    packagedBucket: CUSTOM_PACKAGED
  };

  it('accepts a re-provision that names the SAME buckets (idempotent converge)', () => {
    expect(bucketRebindRejections(bound, bound)).toEqual([]);
  });

  it('rejects a changed source bucket and names both old and new', () => {
    const findings = bucketRebindRejections(bound, {
      ...bound,
      sourceBucket: 'acme-media-ingest-v2'
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.field).toBe('sourceStorage.bucket');
    expect(findings[0]?.message).toContain(CUSTOM_SOURCE);
    expect(findings[0]?.message).toContain('acme-media-ingest-v2');
    // The documented outcome: nothing is migrated.
    expect(findings[0]?.message).toMatch(/not migrated/i);
  });

  it('rejects a changed packaged bucket', () => {
    const findings = bucketRebindRejections(bound, {
      ...bound,
      packagedBucket: 'other-output'
    });
    expect(findings.map((f) => f.field)).toEqual(['packagedStorage.bucket']);
  });

  it('treats a case difference as a different bucket (S3 names are case-sensitive)', () => {
    const findings = bucketRebindRejections(
      { sourceBucket: 'acme-media', packagedBucket: CUSTOM_PACKAGED },
      { sourceBucket: 'ACME-MEDIA', packagedBucket: CUSTOM_PACKAGED }
    );
    expect(findings).toHaveLength(1);
  });

  it('never rejects a pre-#1301 config with no bound buckets recorded', () => {
    expect(bucketRebindRejections({}, bound)).toEqual([]);
  });

  it('is empty for a default-bucket stack re-provisioned with the flag off', () => {
    const defaults = {
      sourceBucket: DEFAULT_SOURCE_BUCKET,
      packagedBucket: DEFAULT_PACKAGED_BUCKET
    };
    expect(
      bucketRebindRejections(
        defaults,
        resolveStackBuckets(
          { sourceStorage: { bucket: CUSTOM_SOURCE } },
          { honourCustomBuckets: false }
        )
      )
    ).toEqual([]);
  });
});
