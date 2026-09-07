// Unit tests for the external-backend ingest source key parser (issue #548).
// The route-level behaviour (asset created, no byte-pull, probe fired against
// the external source) is covered by integration tests that need live services;
// here we lock the pure, security-relevant parsing: the object key derivation
// and the bucket-mismatch rejection that stops a caller redirecting a registered
// credential at an arbitrary bucket.

import { describe, it, expect } from 'vitest';
import { externalObjectKeyFromSourceUrl } from './assets.js';
import { SourceValidationError } from '../pipeline/source.js';

describe('externalObjectKeyFromSourceUrl — issue #548', () => {
  it('extracts the key from s3://<bucket>/<key> when the bucket matches', () => {
    expect(externalObjectKeyFromSourceUrl('s3://ext-bkt/path/to/a.mp4', 'ext-bkt')).toBe(
      'path/to/a.mp4'
    );
  });

  it('uses the registered bucket for s3:///<key> (empty authority)', () => {
    expect(externalObjectKeyFromSourceUrl('s3:///path/a.mp4', 'ext-bkt')).toBe('path/a.mp4');
  });

  it('accepts a bare key with no scheme', () => {
    expect(externalObjectKeyFromSourceUrl('path/a.mp4', 'ext-bkt')).toBe('path/a.mp4');
    expect(externalObjectKeyFromSourceUrl('/leading/slash.mp4', 'ext-bkt')).toBe(
      'leading/slash.mp4'
    );
  });

  it('rejects a bucket that does not match the registered backend bucket', () => {
    expect(() => externalObjectKeyFromSourceUrl('s3://other-bkt/a.mp4', 'ext-bkt')).toThrow(
      SourceValidationError
    );
  });

  it('rejects an empty object key', () => {
    expect(() => externalObjectKeyFromSourceUrl('s3://ext-bkt/', 'ext-bkt')).toThrow(
      SourceValidationError
    );
    expect(() => externalObjectKeyFromSourceUrl('   ', 'ext-bkt')).toThrow(SourceValidationError);
  });
});
