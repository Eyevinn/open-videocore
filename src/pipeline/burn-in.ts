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
  // A VALIDATED, allowlisted libass `force_style` override (issue #390). This is
  // NOT a free-form filter string — see BURN_IN_ALLOWED_STYLE_KEYS and
  // validateForceStyle. Omitted => no force_style segment (styling defaults to
  // whatever the sidecar carries).
  forceStyle?: string;
};

// --- force_style styling override: explicit, validated, allowlisted (issue #390)
//
// The reference implementation offers a `force_style` override on the FFmpeg
// `subtitles` filter (Encore's `filters` accepts `subtitles=<file>:force_style=
// '...'` — eyevinn.github.io/encore-doc, verified in ADR-014 C1). #388 shipped
// this as a free-form string forwarded VERBATIM into the filter. That is a
// filter-injection vector: a caller could embed `'`, `"`, `,`, `:`, `\`, `;`, or
// a newline to break out of `force_style='...'` and append arbitrary filtergraph
// content (e.g. `:force_style='x',subtitles=evil` chains a second filter). Issue
// #390's acceptance forbids accepting a free-form ffmpeg filter string.
//
// So we HARDEN it: `force_style` is now a comma-separated list of `Key=Value`
// directives where every KEY is in an allowlist of libass style fields
// (BURN_IN_ALLOWED_STYLE_KEYS) and every VALUE matches a strict safe charset
// (VALUE_CHARSET) that CANNOT contain any character able to escape the
// `force_style='...'` quoting or the surrounding filtergraph. Anything else is
// rejected up front (mapped to a 422 at the route). The allowlisted subset covers
// the common on-screen appearance controls (libass/ASS V4+ Style fields):
//   FontName    - font family name (letters/digits/space/hyphen only)
//   FontSize    - point size (digits)
//   PrimaryColour / OutlineColour / BackColour - ASS &HAABBGGRR / &HBBGGRR hex
//   Bold / Italic / Underline / StrikeOut      - 0 or 1 (or -1)
//   Outline / Shadow / Spacing                 - numeric
//   Alignment   - numpad 1..9 (libass "an" alignment)
//   MarginL / MarginR / MarginV                - numeric (positioning)
//   BorderStyle - 1 or 3
// Positioning is expressed through Alignment + MarginV (there is no free-form
// position escape). Callers who need cue-native positioning simply rely on the
// sidecar's own styling (vtt cue settings) and omit forceStyle.
export const BURN_IN_ALLOWED_STYLE_KEYS = [
  'FontName',
  'FontSize',
  'PrimaryColour',
  'SecondaryColour',
  'OutlineColour',
  'BackColour',
  'Bold',
  'Italic',
  'Underline',
  'StrikeOut',
  'Outline',
  'Shadow',
  'Spacing',
  'Alignment',
  'MarginL',
  'MarginR',
  'MarginV',
  'BorderStyle'
] as const;
export type BurnInStyleKey = (typeof BURN_IN_ALLOWED_STYLE_KEYS)[number];

const ALLOWED_STYLE_KEY_SET: ReadonlySet<string> = new Set(BURN_IN_ALLOWED_STYLE_KEYS);

// The ONLY characters a validated style VALUE may contain. Deliberately excludes
// every metacharacter that could break out of `force_style='...'` or the
// filtergraph: single/double quotes, comma (our own separator), colon, semicolon,
// backslash, brackets, whitespace other than a single interior space, and
// newlines. Allowed: letters, digits, the ASS colour prefix `&H`, `#`, `.`, `-`,
// `+`, `%`, and single spaces (for multi-word font names). No character here can
// terminate the quoted segment or introduce a new filter.
const VALUE_CHARSET = /^[A-Za-z0-9&#.+%-][A-Za-z0-9&#.+% -]*$/;

// The maximum length of the raw override string, enforced before parsing.
export const BURN_IN_FORCE_STYLE_MAX_LENGTH = 512;

// Discriminated result of validating a caller-supplied force_style override.
export type ForceStyleValidation =
  // A canonical, safe `Key=Value,Key=Value` string composed ONLY from allowlisted
  // keys and safe values. This is what buildSubtitlesFilter composes — never the
  // raw caller input.
  | { ok: true; canonical: string }
  // The override was rejected. `code` distinguishes the failure for a precise 422.
  | { ok: false; code: 'too_long' | 'empty_entry' | 'malformed_entry' | 'unknown_key' | 'unsafe_value'; message: string };

// Validate + canonicalise a caller-supplied `force_style` override into a safe
// filter fragment (issue #390). Returns a discriminated result so the route can
// map a rejection to a 422 with a specific message and never composes raw input
// into the filter. NEVER throws for a caller error.
//
// Rules:
//   - length-bounded (BURN_IN_FORCE_STYLE_MAX_LENGTH)
//   - comma-separated `Key=Value` entries (empty entries from leading/trailing/
//     double commas are rejected, not silently dropped)
//   - each KEY (trimmed) MUST be in BURN_IN_ALLOWED_STYLE_KEYS (case-sensitive,
//     matching libass field names)
//   - each VALUE (trimmed) MUST match VALUE_CHARSET — no escape/injection chars
// The canonical output re-joins the trimmed, validated `Key=Value` pairs with a
// single comma, so no caller whitespace or ordering artefact reaches the filter.
export function validateForceStyle(raw: string): ForceStyleValidation {
  if (raw.length > BURN_IN_FORCE_STYLE_MAX_LENGTH) {
    return {
      ok: false,
      code: 'too_long',
      message: `forceStyle exceeds the ${BURN_IN_FORCE_STYLE_MAX_LENGTH}-character limit`
    };
  }
  const entries = raw.split(',');
  const canonicalParts: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed === '') {
      return {
        ok: false,
        code: 'empty_entry',
        message: 'forceStyle contains an empty style entry (check for a leading, trailing, or doubled comma)'
      };
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0 || eq === trimmed.length - 1) {
      return {
        ok: false,
        code: 'malformed_entry',
        message: `forceStyle entry '${trimmed}' is not a 'Key=Value' pair`
      };
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!ALLOWED_STYLE_KEY_SET.has(key)) {
      return {
        ok: false,
        code: 'unknown_key',
        message: `forceStyle key '${key}' is not an accepted style directive; allowed keys: ${BURN_IN_ALLOWED_STYLE_KEYS.join(', ')}`
      };
    }
    if (!VALUE_CHARSET.test(value)) {
      return {
        ok: false,
        code: 'unsafe_value',
        message: `forceStyle value for '${key}' contains disallowed characters; values may only use letters, digits and the limited set '&#.+%- ' (no quotes, commas, colons, semicolons, backslashes or newlines)`
      };
    }
    canonicalParts.push(`${key}=${value}`);
  }
  return { ok: true, canonical: canonicalParts.join(',') };
}

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

// The minimal object-store surface the availability check needs: stat a
// workspace-local key and report its size (or `undefined` when the object is
// absent). This is EXACTLY the shape of `WorkspaceStorage.statObject`
// (src/data/storage.ts:92-102), which returns `{ size, etag } | undefined` —
// `undefined` for a NotFound object. We depend on the narrow method, not the
// whole class, so the check stays unit-testable with a fake and reuses the
// existing presence plumbing rather than adding a new object-store method.
export type SidecarStatReader = {
  statObject(objectKey: string): Promise<{ size: number } | undefined>;
};

// The outcome of the object-existence check that CLOSES the generation race
// (issue #389). `resolveBurnInSource` proves the request NAMES a concrete key;
// this proves the key's BYTES have actually landed in the workspace bucket —
// because subtitle generation is fire-and-forget, a resolved key (a `sidecarKey`
// the caller supplied, or a `subtitleTrack.objectKey` set before the generation
// callback landed) can point at an object that does not yet exist or is still
// zero-length. Either case would silently burn NO captions, so both fail here.
export type BurnInAvailability =
  // The object exists and is non-empty — safe to dispatch the burn-in encode.
  | { available: true }
  // The object does not exist at all (HEAD/stat returned not-found).
  | { available: false; reason: 'absent'; objectKey: string; message: string }
  // The object exists but is zero-length — an empty sidecar burns nothing, so
  // treat it as not-available (same clear error).
  | { available: false; reason: 'empty'; objectKey: string; message: string };

// Verify the resolved sidecar object ACTUALLY EXISTS (and is non-empty) in the
// workspace object store before a burn-in-opted transcode is dispatched. This is
// the enforcement issue #389 adds on top of ADR-014 D2's resolution: model 2
// (explicit source) makes the guarantee a CLEAR ERROR at submit time rather than
// an open-ended wait (ADR-014 D1 / issue #389). A HEAD/stat miss => `absent`; a
// zero-byte object => `empty`. Never let a burned rendition dispatch against a
// missing/empty sidecar.
export async function checkBurnInObjectAvailable(
  objectKey: string,
  storage: SidecarStatReader
): Promise<BurnInAvailability> {
  const stat = await storage.statObject(objectKey);
  if (!stat) {
    return {
      available: false,
      reason: 'absent',
      objectKey,
      message: `burn-in caption source '${objectKey}' does not exist in the workspace object store yet (subtitle generation is fire-and-forget; the sidecar has not landed) — retry once the sidecar is available`
    };
  }
  if (stat.size <= 0) {
    return {
      available: false,
      reason: 'empty',
      objectKey,
      message: `burn-in caption source '${objectKey}' exists but is empty (0 bytes) — an empty sidecar burns no captions; retry once the sidecar has content`
    };
  }
  return { available: true };
}

// Build the FFmpeg `subtitles=` filter string that burns the resolved key `K`
// into the picture (ADR-014 D3, hardened by issue #390). Shape:
//   subtitles=<K>
//   subtitles=<K>:force_style='<canonical style>'   (when a style is supplied)
// This is the value we thread through profileParams['subtitlesFilter'] into the
// selected profile's VideoEncode filters.
//
// SECURITY (issue #390): `forceStyle` here is the CANONICAL string produced by
// validateForceStyle — NOT raw caller input. The route validates + canonicalises
// the caller's override (rejecting anything with escape/injection characters with
// a 422) BEFORE calling this, so no free-form filter fragment can reach the
// composed filter. As a defence in depth this function re-validates: if a value
// that is not a clean validated canonical is passed, it is dropped rather than
// forwarded verbatim, so buildSubtitlesFilter can NEVER emit an unvalidated
// force_style segment. There is therefore no path by which a caller-supplied
// quote/comma/colon reaches the ffmpeg filtergraph.
//
// The exact `<file>`-path resolution of this string against Encore's S3-backed
// execution environment is the one item ADR-014 (C1 / open dependency 1) flags
// for a live smoke test — see the deferred decoded-frame check and
// docs/osc-feedback/incoming-burn-in-contract.md.
export function buildSubtitlesFilter(objectKey: string, forceStyle?: string): string {
  const base = `subtitles=${objectKey}`;
  if (forceStyle === undefined || forceStyle.trim() === '') {
    return base;
  }
  // Defence in depth: only compose a style segment if the supplied value is a
  // valid, allowlisted style. A caller that reaches this with anything else gets
  // NO force_style segment (never a verbatim passthrough of unsafe input).
  const validated = validateForceStyle(forceStyle);
  if (!validated.ok) {
    return base;
  }
  return `${base}:force_style='${validated.canonical}'`;
}
