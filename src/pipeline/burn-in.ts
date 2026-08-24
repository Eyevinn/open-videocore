// Burn-in caption-source resolution + filter construction (issue #388).
//
// Implements the contract pinned by ADR-014
// (docs/architecture/ADR-014-burn-in-caption-source.md): a burn-in transcode
// names its caption source EXPLICITLY in the request (ordering model 2), the API
// resolves it to ONE concrete workspace-local S3 object key `K`, and injects a
// single FFmpeg `subtitles=` filter into the selected Encore profile's
// `VideoEncode.filters` list via the `profileParams` SpEL lever (D3, sub-option
// 1). This module owns only the resolution + filter-string construction; the
// route (src/routes/assets.ts) and the transcode pipeline
// (src/pipeline/transcode.ts) consume the results.
//
// Contract sources (CLAUDE.md rule 7):
//   - ADR-014 D2 (request shape), D3 (filter injection via profileParams SpEL),
//     D4 (srt/vtt only; ttml rejected at request time).
//   - SubtitleTrack shape { id, language, format, objectKey?, ... }:
//     src/data/asset-repo.ts:219-228. SubtitleFormat = 'vtt'|'srt'|'ttml':
//     src/data/asset-repo.ts:216-217.
//   - Generated sidecar key convention subtitles/<assetId>/<trackId>.<format>:
//     src/pipeline/subtitle-generator.ts:101-103 (subtitleObjectKey), persisted
//     as SubtitleTrack.objectKey at :178-184. The in-repo objectKey is the
//     authoritative S3 key the filter reads (ADR-014 C3).
//   - Encore per-request levers are `profile` (name) + `profileParams` (flat SpEL
//     string map); NO per-request `outputs` array:
//     src/pipeline/encore-client.ts:81-98. `VideoEncode.filters` is a list "for
//     adding extra FFmpeg Filters" (eyevinn.github.io/encore-doc, ADR-014 C1).

import type { SubtitleFormat, SubtitleTrack } from '../data/asset-repo.js';

// Formats the burn-in path accepts (ADR-014 D4). `ttml` is intentionally
// excluded: the sidecar generator never emits it and the FFmpeg `subtitles`
// filter does not convert it inline. A ttml source is a request-time error.
export const BURN_IN_ACCEPTED_FORMATS = ['srt', 'vtt'] as const;
export type BurnInFormat = (typeof BURN_IN_ACCEPTED_FORMATS)[number];

// The SpEL profileParams key the burn-in filter is threaded through (ADR-014 D3
// sub-option 1). A burn-in-capable server-side profile references this key in a
// `VideoEncode`'s `filters` list via `#{profileParams['subtitlesFilter']?:''}`
// (the same SpEL map-indexing precedent the parametrized profiles use for crf/
// preset/height/keyframes — src/pipeline/profile-params.ts:24-33). When the key
// is absent the profile's default (`''`, no extra filter) applies, so a profile
// that references it stays backward compatible for clean (non-burn-in) requests.
export const BURN_IN_PROFILE_PARAM_KEY = 'subtitlesFilter';

// The caption source, as a discriminated union on `type` (ADR-014 D2). Exactly
// one of the two source modes.
export type BurnInSource =
  // (a) explicit sidecar: `objectKey` IS the concrete workspace-local S3 key.
  | { type: 'sidecarKey'; objectKey: string }
  // (b) reference an existing SubtitleTrack by id; resolves to its objectKey.
  | { type: 'subtitleTrack'; trackId: string };

// The optional additive burn-in request object (ADR-014 D2). Absent => no
// burn-in (today's transcodes unchanged).
export type BurnInRequest = {
  source: BurnInSource;
  // Free-form FFmpeg `force_style` string forwarded verbatim into the subtitles
  // filter (e.g. "FontName=Sans,FontSize=24"). Omitted => no force_style segment.
  // The API does not parse it; callers own valid libass syntax (ADR-014 D2/D3).
  forceStyle?: string;
};

// Discriminated resolution outcome. Both success and every distinct failure mode
// are surfaced so callers (the route, and #389 for the not-ready case) can attach
// their own policy. ADR-014 D2 requires the resolver to surface a DISTINCT
// "referenced-track-has-no-objectKey-yet" outcome; #389 layers timing policy on
// top of `not_ready` — THIS issue only surfaces it.
export type BurnInResolution =
  // Resolved to a single concrete workspace-local S3 object key `K`.
  | { ok: true; objectKey: string; format: BurnInFormat }
  // sidecarKey/subtitleTrack format is not srt/vtt (e.g. ttml) — reject 4xx.
  | { ok: false; reason: 'unsupported_format'; format: string; message: string }
  // subtitleTrack referenced a trackId that is not on the asset — reject 4xx.
  | { ok: false; reason: 'track_not_found'; message: string }
  // subtitleTrack exists but has no objectKey yet (generation incomplete).
  // #389 owns the wait/queue/fail policy; here we only surface the outcome.
  | { ok: false; reason: 'not_ready'; message: string };

// Infer a SubtitleFormat from a workspace-local object key's file extension. Used
// for the sidecarKey mode, where the caller supplies a bare key (no track record
// to read `format` from). ADR-014 D2.a: "the key's format is inferred from its
// extension and MUST be in the burn-in accepted set (D4)."
export function inferFormatFromKey(objectKey: string): string {
  const dot = objectKey.lastIndexOf('.');
  const ext = dot >= 0 ? objectKey.slice(dot + 1).toLowerCase() : '';
  return ext;
}

function isAcceptedFormat(format: string): format is BurnInFormat {
  return (BURN_IN_ACCEPTED_FORMATS as readonly string[]).includes(format);
}

// Resolve a burn-in source to a single concrete workspace-local S3 object key
// `K`, applying the srt/vtt format gate (ADR-014 D4). Pure: the caller passes the
// asset's subtitle tracks in so this stays HTTP- and repo-free and trivially
// unit-testable.
//
//   - sidecarKey  -> objectKey verbatim; format inferred from its extension.
//   - subtitleTrack -> the matching track's objectKey; format from the track.
//
// Returns a discriminated `BurnInResolution` — never throws for a caller error.
export function resolveBurnInSource(
  source: BurnInSource,
  subtitleTracks: SubtitleTrack[] | undefined
): BurnInResolution {
  if (source.type === 'sidecarKey') {
    const format = inferFormatFromKey(source.objectKey);
    if (!isAcceptedFormat(format)) {
      return {
        ok: false,
        reason: 'unsupported_format',
        format: format || '(none)',
        message: `burn-in supports srt/vtt; sidecar key '${source.objectKey}' has an unsupported format '${format || '(none)'}' — convert or supply an srt/vtt source`
      };
    }
    // objectKey IS the concrete S3 key the filter reads (ADR-014 D2.a) — no
    // further lookup.
    return { ok: true, objectKey: source.objectKey, format };
  }

  // subtitleTrack mode: look the track up on the asset and read its objectKey.
  const track = (subtitleTracks ?? []).find((t) => t.id === source.trackId);
  if (!track) {
    return {
      ok: false,
      reason: 'track_not_found',
      message: `no subtitle track '${source.trackId}' on this asset`
    };
  }
  if (!isAcceptedFormat(track.format)) {
    return {
      ok: false,
      reason: 'unsupported_format',
      format: track.format,
      message: `burn-in supports srt/vtt; subtitle track '${source.trackId}' is '${track.format}' — convert or supply an srt/vtt source`
    };
  }
  if (!track.objectKey) {
    // The track exists but its file has not landed yet (generation not complete,
    // or a presigned-PUT track before upload — asset-repo.ts:223-225). ADR-014
    // D2.b: surface a distinct "not-yet-ready" outcome; #389 owns the policy.
    return {
      ok: false,
      reason: 'not_ready',
      message: `subtitle track '${source.trackId}' has no stored file yet (generation not complete)`
    };
  }
  return { ok: true, objectKey: track.objectKey, format: track.format };
}

// Escape a single-quoted libass `force_style` value so it cannot break out of
// the `force_style='...'` quoting in the FFmpeg filter string. Single quotes are
// the only metacharacter that terminates the quoted segment; we drop them (they
// are not valid inside a libass style token anyway). ADR-014 D3 notes the API
// does not parse the style, but the injection point must stay well-formed.
function sanitizeForceStyle(forceStyle: string): string {
  return forceStyle.replace(/'/g, '');
}

// Build the FFmpeg `subtitles=` filter string that burns the resolved key `K`
// into the picture (ADR-014 D3). Shape:
//   subtitles=<K>
//   subtitles=<K>:force_style='<forceStyle>'   (when forceStyle supplied)
// This is the value we thread through profileParams['subtitlesFilter'] into the
// selected profile's VideoEncode filters. The exact `<file>`-path resolution of
// this string against Encore's S3-backed execution environment is the one item
// ADR-014 (C1 / open dependency 1) flags for a live smoke test — see the
// deferred decoded-frame check and docs/osc-feedback/incoming-burn-in-contract.md.
export function buildSubtitlesFilter(objectKey: string, forceStyle?: string): string {
  const base = `subtitles=${objectKey}`;
  if (forceStyle && forceStyle.trim() !== '') {
    return `${base}:force_style='${sanitizeForceStyle(forceStyle)}'`;
  }
  return base;
}
