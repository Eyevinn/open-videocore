// resolvePublicManifestUrl resolution tests (issues #200 + #320).
//
// #200 introduced read-time normalisation of stored manifest URLs against the
// configured public origin (PACKAGED_PUBLIC_BASE_URL). #320 is the regression it
// caused: an UNSET origin (the default, zero-config MinIO-backed state) combined
// with a RELATIVE stored URL used to throw PublicManifestBaseUrlError -> the
// delivery route returned 501. These tests pin the corrected precedence:
//   - origin unset + relative stored -> returned verbatim (pre-#200 behaviour)
//   - origin unset + absolute stored -> returned verbatim
//   - origin SET-but-invalid + relative stored -> still throws (explicit misconfig)
//   - origin SET + valid -> rewriting/joining logic unchanged

import { describe, it, expect } from 'vitest';
import {
  resolvePublicManifestUrl,
  PublicManifestBaseUrlError
} from '../src/pipeline/packaging.js';

describe('resolvePublicManifestUrl (issues #200/#320)', () => {
  describe('PACKAGED_PUBLIC_BASE_URL unset (publicOrigin undefined)', () => {
    // REGRESSION TEST for #320: fails against pre-fix code (which threw), passes
    // after the fix (returns the stored relative value unchanged).
    it('returns a relative stored URL verbatim (no throw)', () => {
      expect(
        resolvePublicManifestUrl('/openvideocore-packaged/packaged/x/index.m3u8', undefined)
      ).toBe('/openvideocore-packaged/packaged/x/index.m3u8');
    });

    it('returns a bare relative path (no leading slash) verbatim', () => {
      expect(resolvePublicManifestUrl('packaged/x/index.m3u8', undefined)).toBe(
        'packaged/x/index.m3u8'
      );
    });

    it('returns an already-absolute stored URL as-is', () => {
      expect(
        resolvePublicManifestUrl('https://cdn.example/packaged/x/index.m3u8', undefined)
      ).toBe('https://cdn.example/packaged/x/index.m3u8');
    });
  });

  describe('PACKAGED_PUBLIC_BASE_URL set but not an absolute URL (misconfig)', () => {
    it('throws for a relative stored URL', () => {
      expect(() =>
        resolvePublicManifestUrl('/packaged/x/index.m3u8', 'not-a-url')
      ).toThrow(PublicManifestBaseUrlError);
    });

    it('still returns an already-absolute stored URL as-is', () => {
      expect(
        resolvePublicManifestUrl('https://cdn.example/packaged/x/index.m3u8', 'not-a-url')
      ).toBe('https://cdn.example/packaged/x/index.m3u8');
    });
  });

  describe('PACKAGED_PUBLIC_BASE_URL set and valid', () => {
    it('joins a relative stored path onto the public origin', () => {
      expect(
        resolvePublicManifestUrl('/packaged/x/index.m3u8', 'https://cdn.example')
      ).toBe('https://cdn.example/packaged/x/index.m3u8');
    });

    it('leaves an already-public (same-host) absolute URL untouched', () => {
      expect(
        resolvePublicManifestUrl(
          'https://cdn.example/packaged/x/index.m3u8',
          'https://cdn.example'
        )
      ).toBe('https://cdn.example/packaged/x/index.m3u8');
    });

    it('rewrites the scheme + host of an internal-host absolute URL, preserving path', () => {
      expect(
        resolvePublicManifestUrl(
          'http://minio.internal/packaged/x/index.m3u8',
          'https://cdn.example'
        )
      ).toBe('https://cdn.example/packaged/x/index.m3u8');
    });
  });
});
