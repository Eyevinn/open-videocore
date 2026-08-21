// Manifest child-reference rewriting tests (issue #340).
//
// Locks in that when packaged HLS/DASH manifests are served through the proxy
// delivery route, every child reference — variant playlists, the audio group,
// CMAF init + media segments, DASH BaseURL/SegmentTemplate — is rewritten to
// resolve back through the proxy prefix `.../assets/<id>/stream/...`, so no child
// request escapes to a bare object-store host or an unsigned URL (issue #333/#340
// acceptance criteria). Contract verified against:
//   - src/pipeline/manifest-rewrite.ts (rewriteManifest, rewrite* helpers)
//   - src/pipeline/packaging.ts outputPrefix / proxyStreamPrefix / packagedBucket

import { describe, it, expect } from 'vitest';
import {
  rewriteManifest,
  rewriteHlsManifest,
  rewriteDashManifest,
  rewriteReference,
  isManifestPath,
  type ManifestRewriteContext
} from '../src/pipeline/manifest-rewrite.js';

const ID = 'asset-1';
const ctx = (manifestRelativePath: string): ManifestRewriteContext => ({
  proxyBase: `/api/v1/assets/${ID}/stream`,
  manifestRelativePath,
  packagedPrefix: `packaged/${ID}`,
  packagedBucket: 'openvideocore-packaged'
});
const P = `/api/v1/assets/${ID}/stream`;

describe('isManifestPath', () => {
  it('recognises .m3u8 and .mpd (case-insensitive), rejects segments', () => {
    expect(isManifestPath('index.m3u8')).toBe(true);
    expect(isManifestPath('v/PLAYLIST.M3U8')).toBe(true);
    expect(isManifestPath('manifest.mpd')).toBe(true);
    expect(isManifestPath('v/seg-1.m4s')).toBe(false);
    expect(isManifestPath('v/seg-1.ts')).toBe(false);
    expect(isManifestPath('init.mp4')).toBe(false);
  });
});

describe('rewriteReference', () => {
  const c = ctx('index.m3u8');

  it('rewrites a reference relative to the manifest directory', () => {
    expect(rewriteReference('v/playlist.m3u8', c)).toBe(`${P}/v/playlist.m3u8`);
  });

  it('resolves a relative reference from a nested manifest into its directory', () => {
    expect(rewriteReference('seg-1.m4s', ctx('audio/audio.m3u8'))).toBe(
      `${P}/audio/seg-1.m4s`
    );
    expect(rewriteReference('../v/seg-1.m4s', ctx('audio/audio.m3u8'))).toBe(
      `${P}/v/seg-1.m4s`
    );
  });

  it('strips a bucket-absolute path back to the proxy prefix', () => {
    expect(
      rewriteReference(`/openvideocore-packaged/packaged/${ID}/v/pl.m3u8`, c)
    ).toBe(`${P}/v/pl.m3u8`);
  });

  it('strips a prefix-absolute path back to the proxy prefix', () => {
    expect(rewriteReference(`/packaged/${ID}/v/pl.m3u8`, c)).toBe(
      `${P}/v/pl.m3u8`
    );
  });

  it('rewrites a full object-store URL whose path contains the packaged prefix', () => {
    expect(
      rewriteReference(
        `https://minio.internal/openvideocore-packaged/packaged/${ID}/v/seg-2.m4s`,
        c
      )
    ).toBe(`${P}/v/seg-2.m4s`);
  });

  it('leaves an external URL not under the packaged prefix untouched', () => {
    const ext = 'https://cdn.example.com/captions/en.vtt';
    expect(rewriteReference(ext, c)).toBe(ext);
  });

  it('leaves fragment/query-only and empty references untouched', () => {
    expect(rewriteReference('#EXT', c)).toBe('#EXT');
    expect(rewriteReference('', c)).toBe('');
    expect(rewriteReference('   ', c)).toBe('   ');
  });
});

describe('rewriteHlsManifest — master with five variants + audio group', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",URI="audio/audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="aud"',
    'v0/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="aud"',
    'v1/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="aud"',
    'v2/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=4000000,AUDIO="aud"',
    'v3/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=8000000,AUDIO="aud"',
    'v4/playlist.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframe/pl.m3u8"',
    ''
  ].join('\n');

  it('rewrites all five variant URIs, the audio-group URI and the i-frame URI', () => {
    const out = rewriteHlsManifest(master, ctx('index.m3u8'));
    for (let v = 0; v < 5; v++) {
      expect(out).toContain(`${P}/v${v}/playlist.m3u8`);
    }
    expect(out).toContain(`URI="${P}/audio/audio.m3u8"`);
    expect(out).toContain(`URI="${P}/iframe/pl.m3u8"`);
    // No bare relative variant lines survive.
    expect(out).not.toMatch(/^v\d\/playlist\.m3u8$/m);
    // Non-URI tags are preserved verbatim.
    expect(out).toContain('#EXT-X-VERSION:7');
    expect(out).toContain('BANDWIDTH=8000000');
  });
});

describe('rewriteHlsManifest — variant playlist with init map + segments', () => {
  const variant = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:6.0,',
    'seg-00001.m4s',
    '#EXTINF:6.0,',
    'seg-00002.m4s',
    '#EXT-X-ENDLIST',
    ''
  ].join('\n');

  it('rewrites the EXT-X-MAP init URI and each segment relative to the variant dir', () => {
    const out = rewriteHlsManifest(variant, ctx('v0/playlist.m3u8'));
    expect(out).toContain(`#EXT-X-MAP:URI="${P}/v0/init.mp4"`);
    expect(out).toContain(`${P}/v0/seg-00001.m4s`);
    expect(out).toContain(`${P}/v0/seg-00002.m4s`);
    expect(out).toContain('#EXTINF:6.0,');
    expect(out).toContain('#EXT-X-ENDLIST');
  });

  it('preserves CRLF line endings', () => {
    const crlf = '#EXTM3U\r\n#EXT-X-MAP:URI="init.mp4"\r\nseg-1.m4s\r\n';
    const out = rewriteHlsManifest(crlf, ctx('v0/playlist.m3u8'));
    expect(out).toContain('\r\n');
    expect(out).toContain(`${P}/v0/seg-1.m4s\r\n`);
  });
});

describe('rewriteDashManifest', () => {
  it('rewrites BaseURL, SegmentTemplate media/initialization preserving $Number$', () => {
    const mpd = [
      '<?xml version="1.0"?>',
      '<MPD>',
      '  <Period>',
      '    <AdaptationSet>',
      '      <BaseURL>./</BaseURL>',
      '      <SegmentTemplate initialization="v0/init.mp4" media="v0/seg-$Number$.m4s"/>',
      '      <Representation id="0"/>',
      '    </AdaptationSet>',
      '  </Period>',
      '</MPD>'
    ].join('\n');
    const out = rewriteDashManifest(mpd, ctx('manifest.mpd'));
    expect(out).toContain(`initialization="${P}/v0/init.mp4"`);
    expect(out).toContain(`media="${P}/v0/seg-$Number$.m4s"`);
    // The template variable is preserved verbatim.
    expect(out).toContain('$Number$');
  });

  it('rewrites a bucket-absolute SegmentTemplate media path', () => {
    const mpd =
      `<MPD><SegmentTemplate media="/openvideocore-packaged/packaged/${ID}/v1/seg-$Number$.m4s"/></MPD>`;
    const out = rewriteDashManifest(mpd, ctx('manifest.mpd'));
    expect(out).toContain(`media="${P}/v1/seg-$Number$.m4s"`);
  });

  it('rewrites Initialization sourceURL', () => {
    const mpd =
      '<MPD><SegmentList><Initialization sourceURL="v0/init.mp4"/></SegmentList></MPD>';
    const out = rewriteDashManifest(mpd, ctx('manifest.mpd'));
    expect(out).toContain(`sourceURL="${P}/v0/init.mp4"`);
  });
});

describe('rewriteManifest dispatch', () => {
  it('routes .mpd to DASH and .m3u8 to HLS', () => {
    const hls = rewriteManifest('index.m3u8', 'v/pl.m3u8\n', ctx('index.m3u8'));
    expect(hls).toContain(`${P}/v/pl.m3u8`);
    const dash = rewriteManifest(
      'manifest.mpd',
      '<MPD><BaseURL>v0/</BaseURL></MPD>',
      ctx('manifest.mpd')
    );
    expect(dash).toContain(`<BaseURL>${P}/v0/</BaseURL>`);
  });
});
