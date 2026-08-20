// Per-profile profileParams key allowlist (issue #290).
//
// Builds on issue #287, which threads an optional flat `profileParams` string
// map from POST /:id/transcode verbatim into the Encore job document. Encore
// evaluates those values as SpEL expression properties INSIDE the named,
// operator-managed profile. This module adds a developer-experience guard: it
// rejects profileParams keys the CHOSEN profile does not actually declare, so a
// caller who mistypes a SpEL parameter name (e.g. `crfs` instead of `crf`) gets
// an actionable 4xx naming the accepted set, instead of a value that Encore
// silently ignores.
//
// This is NOT a security fix. Values already land as single ffmpeg tokens
// (there is no injection surface); this is optional hardening / DX only.
//
// CONTRACT SOURCE (CLAUDE.md rule 7, and issue #290's "contract-first"):
// The accepted key set per profile is DERIVED, not hardcoded. It is extracted
// from the SpEL `#{profileParams['<key>']...}` references in the profile YAML
// that the profile store holds and that GET /api/v1/profiles serves — the same
// operator-managed profile index Encore loads (src/routes/profiles.ts,
// src/services/profile-bootstrap.ts). The default index seeded on bootstrap is
// the Eyevinn Encore test profiles
// (https://raw.githubusercontent.com/Eyevinn/encore-test-profiles/refs/heads/main/profiles.yml,
// see ENCORE_PROFILES_URL in src/main.ts). Verified against the fetched YAML on
// 2026-08-19, the two parametrized profiles referenced by issue #290 declare:
//   - x264-crf-parametrized.yml:
//       #{profileParams['preset']?:"medium"}
//       #{profileParams['crf']?:23}
//       #{profileParams['height']?:1080}
//       #{profileParams['keyframes']?:'expr:not(mod(n,96))'}
//     -> { crf, preset, height, keyframes }
//   - program-kf.yml:
//       #{profileParams['keyframes']?:'expr:not(mod(n,96))'}
//     -> { keyframes }
//   - program.yml / program-x265.yml / archive.yml / x264-1080p-slow.yml: no
//     profileParams references -> declares no params (empty set).
// The SpEL grammar Encore uses is Spring Expression Language property indexing
// on the `profileParams` map, i.e. `profileParams['<key>']` (single OR double
// quotes), so the extractor below matches exactly that shape.

// Matches every `profileParams['key']` / `profileParams["key"]` reference in a
// profile YAML document (SpEL map indexing, as Encore evaluates it). The global
// flag lets us collect all keys; the key is captured from group 1 or 2.
const SPEL_PROFILE_PARAM_REF = /profileParams\[\s*(?:'([^']+)'|"([^"]+)")\s*\]/g;

// Extract the set of profileParams keys a profile YAML document declares (i.e.
// keys the profile actually references via SpEL). Returns an empty set when the
// profile references none.
export function declaredProfileParamKeys(profileYaml: string): Set<string> {
  const keys = new Set<string>();
  for (const match of profileYaml.matchAll(SPEL_PROFILE_PARAM_REF)) {
    const key = match[1] ?? match[2];
    if (key) keys.add(key);
  }
  return keys;
}

export type ProfileParamsValidation =
  | { ok: true }
  | {
      ok: false;
      // The keys the caller sent that the chosen profile does not declare.
      unknownKeys: string[];
      // The full accepted set for the chosen profile (sorted, may be empty).
      allowedKeys: string[];
      // Human-readable message naming the profile and its accepted set.
      message: string;
    };

// Validate a caller-supplied profileParams map against the keys the chosen
// profile actually declares.
//
// Graceful degradation (issue #290 acceptance + rules):
//   - `profileParams` absent or empty            -> always ok (any profile).
//   - `profileYaml` undefined (profile YAML not
//     resolvable — e.g. a custom profile, or the
//     profile store is unavailable)              -> PERMISSIVE: ok, no reject,
//     so custom / operator-added profiles are never falsely rejected. Callers
//     may log a note; we do not fail closed.
//   - profile declares NO params but caller sent
//     keys                                       -> reject: nothing is accepted.
//   - caller sent a key the profile does declare -> passes through unchanged.
//   - caller sent an unknown key                 -> reject naming the accepted
//     set.
export function validateProfileParams(input: {
  profileName: string;
  // The chosen profile's raw YAML, or undefined when it cannot be resolved.
  profileYaml: string | undefined;
  profileParams: Record<string, string> | undefined;
}): ProfileParamsValidation {
  const { profileName, profileYaml, profileParams } = input;

  const sentKeys = profileParams ? Object.keys(profileParams) : [];
  if (sentKeys.length === 0) {
    // Empty / absent map is always fine — profiles with no declared params
    // accept it, and so does everything else.
    return { ok: true };
  }

  if (profileYaml === undefined) {
    // Undeterminable profile (custom profile or profile store unreachable):
    // prefer permissive-with-note over hard-reject so a custom/operator profile
    // whose param set we cannot read is never falsely rejected.
    return { ok: true };
  }

  const allowed = declaredProfileParamKeys(profileYaml);
  const unknownKeys = sentKeys.filter((k) => !allowed.has(k));
  if (unknownKeys.length === 0) {
    return { ok: true };
  }

  const allowedKeys = [...allowed].sort((a, b) => a.localeCompare(b));
  const acceptedClause =
    allowedKeys.length > 0
      ? `accepted keys for profile '${profileName}': ${allowedKeys.join(', ')}`
      : `profile '${profileName}' accepts no profileParams`;
  const message = `unknown profileParams ${unknownKeys.length === 1 ? 'key' : 'keys'}: ${unknownKeys
    .sort((a, b) => a.localeCompare(b))
    .join(', ')} — ${acceptedClause}`;

  return { ok: false, unknownKeys, allowedKeys, message };
}
