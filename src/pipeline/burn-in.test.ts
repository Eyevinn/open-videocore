// Unit tests for burn-in caption-source resolution + filter construction
// (issue #388, ADR-014). Pure functions, no ffmpeg / no Encore: they assert the
// wiring the route + pipeline consume.
//
// NOTE (deferred): ADR-014's acceptance line "verified by inspecting a decoded
// frame" cannot run here — the environment has NO ffmpeg binary and NO Encore
// instance provisioned. The visual burn-in proof is DEFERRED to a live smoke
// test (see the gated placeholder in burn-in.e2e.test.ts and
// docs/osc-feedback/incoming-burn-in-contract.md). These tests prove the
// deterministic wiring: the correct key is resolved, the correct filter string
// is built, ttml is rejected, and subtitleTrack resolves to the right objectKey.

import { describe, it, expect } from 'vitest';

import {
  resolveBurnInSource,
  buildSubtitlesFilter,
  inferFormatFromKey,
  checkBurnInObjectAvailable,
  BURN_IN_PROFILE_PARAM_KEY,
  BURN_IN_ACCEPTED_FORMATS
} from './burn-in.js';
import type { SubtitleTrack } from '../data/asset-repo.js';

describe('resolveBurnInSource — sidecarKey mode (ADR-014 D2.a)', () => {
  it('resolves an srt sidecar key verbatim to the concrete objectKey', () => {
    const r = resolveBurnInSource({ type: 'sidecarKey', objectKey: 'sidecars/a/cap.srt' }, undefined);
    expect(r).toEqual({ ok: true, objectKey: 'sidecars/a/cap.srt', format: 'srt' });
  });

  it('resolves a vtt sidecar key verbatim (case-insensitive extension)', () => {
    const r = resolveBurnInSource({ type: 'sidecarKey', objectKey: 'sidecars/a/cap.VTT' }, undefined);
    expect(r).toEqual({ ok: true, objectKey: 'sidecars/a/cap.VTT', format: 'vtt' });
  });

  it('rejects a ttml sidecar key at request time (unsupported_format)', () => {
    const r = resolveBurnInSource({ type: 'sidecarKey', objectKey: 'sidecars/a/cap.ttml' }, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unsupported_format');
      expect(r).toMatchObject({ format: 'ttml' });
      expect(r.message).toMatch(/srt\/vtt/);
    }
  });

  it('rejects a sidecar key with no/unknown extension (unsupported_format)', () => {
    const r = resolveBurnInSource({ type: 'sidecarKey', objectKey: 'sidecars/a/cap' }, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsupported_format');
  });
});

describe('resolveBurnInSource — subtitleTrack mode (ADR-014 D2.b)', () => {
  const tracks: SubtitleTrack[] = [
    { id: 'trk-vtt', language: 'en', format: 'vtt', objectKey: 'subtitles/asset-1/trk-vtt.vtt' },
    { id: 'trk-srt', language: 'sv', format: 'srt', objectKey: 'subtitles/asset-1/trk-srt.srt' },
    { id: 'trk-ttml', language: 'de', format: 'ttml', objectKey: 'subtitles/asset-1/trk-ttml.ttml' },
    { id: 'trk-pending', language: 'fr', format: 'vtt' } // no objectKey yet
  ];

  it('resolves to the referenced track objectKey (not any other track)', () => {
    const r = resolveBurnInSource({ type: 'subtitleTrack', trackId: 'trk-srt' }, tracks);
    expect(r).toEqual({ ok: true, objectKey: 'subtitles/asset-1/trk-srt.srt', format: 'srt' });
  });

  it('rejects a ttml track (unsupported_format) even though the track carries a key', () => {
    const r = resolveBurnInSource({ type: 'subtitleTrack', trackId: 'trk-ttml' }, tracks);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsupported_format');
  });

  it('rejects an unknown trackId (track_not_found)', () => {
    const r = resolveBurnInSource({ type: 'subtitleTrack', trackId: 'nope' }, tracks);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('track_not_found');
  });

  it('surfaces a distinct not_ready outcome when the track has no objectKey yet (#389 owns policy)', () => {
    const r = resolveBurnInSource({ type: 'subtitleTrack', trackId: 'trk-pending' }, tracks);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_ready');
  });

  it('treats an asset with no subtitle tracks as track_not_found', () => {
    const r = resolveBurnInSource({ type: 'subtitleTrack', trackId: 'trk-vtt' }, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('track_not_found');
  });
});

describe('buildSubtitlesFilter (ADR-014 D3)', () => {
  it('builds the bare subtitles= filter when no forceStyle is given', () => {
    expect(buildSubtitlesFilter('subtitles/a/cap.srt')).toBe('subtitles=subtitles/a/cap.srt');
  });

  it('appends force_style when supplied', () => {
    expect(buildSubtitlesFilter('cap.vtt', 'FontName=Sans,FontSize=24')).toBe(
      "subtitles=cap.vtt:force_style='FontName=Sans,FontSize=24'"
    );
  });

  it('omits force_style for an empty/whitespace value', () => {
    expect(buildSubtitlesFilter('cap.vtt', '   ')).toBe('subtitles=cap.vtt');
  });

  it('strips single quotes from forceStyle so it cannot break out of the quoting', () => {
    expect(buildSubtitlesFilter('cap.vtt', "FontName='X")).toBe("subtitles=cap.vtt:force_style='FontName=X'");
  });
});

describe('helpers + constants', () => {
  it('inferFormatFromKey lowercases the extension', () => {
    expect(inferFormatFromKey('a/b/c.SRT')).toBe('srt');
    expect(inferFormatFromKey('a/b/c')).toBe('');
  });

  it('accepts only srt and vtt (ADR-014 D4)', () => {
    expect([...BURN_IN_ACCEPTED_FORMATS].sort()).toEqual(['srt', 'vtt']);
  });

  it('threads through the subtitlesFilter profileParams key', () => {
    expect(BURN_IN_PROFILE_PARAM_KEY).toBe('subtitlesFilter');
  });
});

// Object-existence check that closes the fire-and-forget generation race
// (issue #389). A fake stat reader stands in for WorkspaceStorage.statObject
// (src/data/storage.ts:92-102): `undefined` == NotFound; a `{ size }` == present.
describe('checkBurnInObjectAvailable (issue #389 race close)', () => {
  const readerFor = (objects: Record<string, number>) => ({
    async statObject(key: string) {
      return Object.prototype.hasOwnProperty.call(objects, key)
        ? { size: objects[key]! }
        : undefined;
    }
  });

  it('returns available when the object exists and is non-empty', async () => {
    const r = await checkBurnInObjectAvailable('cap.vtt', readerFor({ 'cap.vtt': 100 }));
    expect(r.available).toBe(true);
  });

  it('returns absent when the object does not exist (stat undefined)', async () => {
    const r = await checkBurnInObjectAvailable('missing.vtt', readerFor({}));
    expect(r).toMatchObject({ available: false, reason: 'absent', objectKey: 'missing.vtt' });
    if (!r.available) expect(r.message).toContain('missing.vtt');
  });

  it('treats a zero-length object as not-available (empty)', async () => {
    const r = await checkBurnInObjectAvailable('empty.vtt', readerFor({ 'empty.vtt': 0 }));
    expect(r).toMatchObject({ available: false, reason: 'empty', objectKey: 'empty.vtt' });
    if (!r.available) expect(r.message).toContain('empty');
  });
});
