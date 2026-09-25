// Tests for build-identity resolution (issue #827).
//
// The failure being guarded against is a deployment answering confidently and
// wrongly about which build it is running. So these tests care as much about
// what is reported when a value is MISSING ("unknown", never a stand-in that
// looks like a real identifier) as about the happy path.

import { describe, it, expect } from 'vitest';
import { resolveBuildInfo, UNKNOWN } from './build-info.js';

describe('resolveBuildInfo (issue #827)', () => {
  it('reports the build identity injected by the image build', () => {
    expect(
      resolveBuildInfo(
        {
          BUILD_VERSION: 'v1.5.0-56-g92a13cc',
          BUILD_COMMIT: '92a13cc4f0e1b2a3',
          BUILD_SOURCE_DIGEST: '11cb8d5651d972cc',
          BUILT_AT: '2026-09-25T06:11:02Z'
        },
        '1.5.0'
      )
    ).toEqual({
      version: 'v1.5.0-56-g92a13cc',
      commit: '92a13cc4f0e1b2a3',
      sourceDigest: '11cb8d5651d972cc',
      builtAt: '2026-09-25T06:11:02Z',
      packageVersion: '1.5.0'
    });
  });

  it('reports "unknown" rather than the package version when no build identity was injected', () => {
    // This is the heart of the bug: falling back to the package version is what
    // made a rolling build claim to be the released build.
    const info = resolveBuildInfo({}, '1.5.0');
    expect(info.version).toBe(UNKNOWN);
    expect(info.commit).toBe(UNKNOWN);
    expect(info.sourceDigest).toBe(UNKNOWN);
    expect(info.builtAt).toBeNull();
    // The package version is still reported, but only under its own name.
    expect(info.packageVersion).toBe('1.5.0');
    expect(info.version).not.toBe(info.packageVersion);
  });

  it('treats empty and whitespace-only values as absent', () => {
    // `docker build --build-arg BUILD_VERSION=` and an unset-but-declared ENV
    // both yield an empty string, which is not an identifier.
    const info = resolveBuildInfo(
      {
        BUILD_VERSION: '',
        BUILD_COMMIT: '   ',
        BUILD_SOURCE_DIGEST: '\n',
        BUILT_AT: ''
      },
      '1.5.0'
    );
    expect(info.version).toBe(UNKNOWN);
    expect(info.commit).toBe(UNKNOWN);
    expect(info.sourceDigest).toBe(UNKNOWN);
    expect(info.builtAt).toBeNull();
  });

  it('trims surrounding whitespace so a value captured from a command substitution is clean', () => {
    const info = resolveBuildInfo(
      { BUILD_SOURCE_DIGEST: '11cb8d5651d972cc\n' },
      '1.5.0'
    );
    expect(info.sourceDigest).toBe('11cb8d5651d972cc');
  });

  it('keeps the dirty marker from git describe instead of discarding it', () => {
    // A build from an unclean tree must not be mistakable for a build from the
    // commit it is based on.
    const info = resolveBuildInfo(
      { BUILD_VERSION: 'v1.5.0-56-g92a13cc-dirty' },
      '1.5.0'
    );
    expect(info.version).toBe('v1.5.0-56-g92a13cc-dirty');
  });
});
