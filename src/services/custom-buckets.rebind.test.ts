// Re-provision binding and the one-bucket-for-both-roles rejection (issue
// #1301, review findings 1 and 2).
//
// Two pure decisions are covered here, separate from the first-provision
// resolution in custom-buckets.test.ts:
//
//   - `bindStackBuckets` answers "which bucket does THIS run bind", given both
//     the request and the binding the stack already has. A role whose block was
//     omitted, or re-supplied identically, keeps the stored binding so a
//     zero-config re-provision (and the retry that resumes a partially failed
//     one) converges instead of being rejected by `bucketRebindRejections` for
//     a field the caller never sent.
//   - `identicalBucketRejections` refuses one bucket for both roles: the
//     packaged bucket is made anonymously readable at provision time, so a
//     shared bucket would publish the ingested source masters.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PACKAGED_BUCKET,
  DEFAULT_SOURCE_BUCKET,
  bindStackBuckets,
  bucketRebindRejections,
  identicalBucketRejections
} from './custom-buckets.js';

const CUSTOM_SOURCE = 'acme-media-ingest';
const CUSTOM_PACKAGED = 'acme-streaming-output';
const BOUND = { sourceBucket: CUSTOM_SOURCE, packagedBucket: CUSTOM_PACKAGED };

describe('bindStackBuckets against an existing binding (issue #1301)', () => {
  it('keeps the stored binding when the request omits the storage blocks', () => {
    for (const honourCustomBuckets of [true, false]) {
      expect(bindStackBuckets({}, BOUND, { honourCustomBuckets })).toEqual(BOUND);
    }
  });

  it('is NOT a rebind when the blocks are omitted — the zero-config call converges', () => {
    const bound = bindStackBuckets({}, BOUND, { honourCustomBuckets: true });
    expect(bucketRebindRejections(BOUND, bound)).toEqual([]);
  });

  it('is NOT a rebind when the identical buckets are re-supplied with the flag OFF', () => {
    const bound = bindStackBuckets(
      {
        sourceStorage: { bucket: CUSTOM_SOURCE },
        packagedStorage: { bucket: CUSTOM_PACKAGED }
      },
      BOUND,
      { honourCustomBuckets: false }
    );
    expect(bound).toEqual(BOUND);
    expect(bucketRebindRejections(BOUND, bound)).toEqual([]);
  });

  it('still returns a CHANGED bucket so the rebind guard rejects it, flag on or off', () => {
    for (const honourCustomBuckets of [true, false]) {
      const bound = bindStackBuckets(
        { sourceStorage: { bucket: 'acme-media-ingest-v2' } },
        BOUND,
        { honourCustomBuckets }
      );
      expect(bound.sourceBucket).toBe('acme-media-ingest-v2');
      // Unchanged for the role the caller left out.
      expect(bound.packagedBucket).toBe(CUSTOM_PACKAGED);
      const findings = bucketRebindRejections(BOUND, bound);
      expect(findings.map((f) => f.field)).toEqual(['sourceStorage.bucket']);
    }
  });

  it('honours the supplied bucket when nothing is bound yet (a first provision)', () => {
    expect(
      bindStackBuckets(
        { sourceStorage: { bucket: CUSTOM_SOURCE } },
        {},
        { honourCustomBuckets: true }
      )
    ).toEqual({
      sourceBucket: CUSTOM_SOURCE,
      packagedBucket: DEFAULT_PACKAGED_BUCKET
    });
  });

  it('returns the defaults when nothing is bound and the flag is OFF', () => {
    expect(
      bindStackBuckets(
        {
          sourceStorage: { bucket: CUSTOM_SOURCE },
          packagedStorage: { bucket: CUSTOM_PACKAGED }
        },
        {},
        { honourCustomBuckets: false }
      )
    ).toEqual({
      sourceBucket: DEFAULT_SOURCE_BUCKET,
      packagedBucket: DEFAULT_PACKAGED_BUCKET
    });
  });

  it('treats an empty stored binding as nothing bound (pre-#1301 config)', () => {
    expect(
      bindStackBuckets({}, { sourceBucket: '', packagedBucket: '' }, {
        honourCustomBuckets: true
      })
    ).toEqual({
      sourceBucket: DEFAULT_SOURCE_BUCKET,
      packagedBucket: DEFAULT_PACKAGED_BUCKET
    });
  });
});

describe('identicalBucketRejections (issue #1301, review finding 1)', () => {
  it('accepts two different buckets', () => {
    expect(identicalBucketRejections({}, BOUND)).toEqual([]);
  });

  it('rejects one bucket for both roles and explains the public-read exposure', () => {
    const findings = identicalBucketRejections(
      {
        sourceStorage: { bucket: 'acme-media' },
        packagedStorage: { bucket: 'acme-media' }
      },
      { sourceBucket: 'acme-media', packagedBucket: 'acme-media' }
    );
    expect(findings.map((f) => f.field)).toEqual([
      'sourceStorage.bucket',
      'packagedStorage.bucket'
    ]);
    expect(findings[0]?.message).toContain('acme-media');
    expect(findings[0]?.message).toMatch(/anonymously readable/i);
    expect(findings[0]?.message).toMatch(/world-readable/i);
  });

  it('names only the role the caller actually supplied', () => {
    // Only `sourceStorage` is sent, naming the bucket the OMITTED packaged role
    // defaults to — the collision is still real, but the message must not point
    // at a field the request never contained.
    const findings = identicalBucketRejections(
      { sourceStorage: { bucket: DEFAULT_PACKAGED_BUCKET } },
      {
        sourceBucket: DEFAULT_PACKAGED_BUCKET,
        packagedBucket: DEFAULT_PACKAGED_BUCKET
      }
    );
    expect(findings.map((f) => f.field)).toEqual(['sourceStorage.bucket']);
  });
});
