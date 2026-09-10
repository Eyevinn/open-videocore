// Encore profile bootstrap (issue #84).
//
// Seeds the profile repository from the default Encore profile index on first
// startup (or on demand via POST /api/v1/profiles/bootstrap). The index is the
// flat `name: relative-url` map that Encore itself consumes; for each entry we
// fetch the referenced YAML file (resolved relative to the index URL) and store
// name + YAML content. Subsequent bootstraps are a no-op once profiles exist.
//
// Built-in profiles (issue #385): some profiles are a capability of THIS API and
// must ship as part of the standard served set regardless of the remote index
// (e.g. the loudness-normalisation profile). They are seeded from
// src/services/builtin-profiles.ts on EVERY bootstrap run (including startup),
// so they are always present in GET /index.yml even when profiles already exist
// or the remote index is unreachable. An operator edit to a built-in profile is
// preserved: an existing profile of the same name is left untouched.
//
// Skip-guard fix (issue #662): the guard used to be `repository.count() > 0`,
// but built-ins are ensured on EVERY run BEFORE the guard, so after a first
// startup whose remote index fetch failed the store is non-empty (built-ins
// only) and the guard trips forever — the remote index is never retried. The
// guard now counts only NON-built-in profiles, which is what actually signals
// "the remote index (or an operator) has populated real profiles". With just
// built-ins present that count is 0, so the remote fetch is retried on the next
// startup. The skip path is also now logged.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - src/data/profile-repo.ts:33-44 — ProfileRepository.list/get/create/update
//     signatures; list() returns Profile[] each with a `name` field (:19-26).
//   - src/routes/profiles.ts (pre-change) — the trivial `key: value` index
//     parser + FETCH_TIMEOUT_MS convention reused here.
//   - src/services/builtin-profiles.ts:100-102 — BUILTIN_PROFILES [{ name, yaml }].

import type { ProfileRepository } from '../data/profile-repo.js';
import { BUILTIN_PROFILES } from './builtin-profiles.js';

// Timeout for each upstream fetch so a slow/hung index host can't block startup.
const FETCH_TIMEOUT_MS = 5000;

export type BootstrapLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type BootstrapResult = {
  seeded: number;
  // true when remote-index seeding was a no-op because non-built-in profiles
  // already exist (issue #662: a store holding ONLY built-ins does NOT skip, so
  // a previously-failed remote index is retried on the next startup).
  skipped: boolean;
  // Count of built-in profiles newly created this run (issue #385). Built-ins are
  // always ensured, independent of the remote-index skip guard, so this can be
  // non-zero even when `skipped` is true.
  builtinSeeded: number;
};

// Names of the profiles this API ships built-in. Used to exclude built-ins from
// the skip-guard count so seeding the built-ins themselves cannot trip the guard
// (issue #662). Built-in names are compared verbatim to stored profile names.
const BUILTIN_PROFILE_NAMES = new Set(BUILTIN_PROFILES.map((p) => p.name));

// Count profiles in the store that are NOT built-ins. This is the signal the
// remote index has ever been ingested (or an operator has added real profiles):
// a store that holds only built-ins returns 0 here, so the remote fetch is
// retried on the next startup. Uses ProfileRepository.list() (profile-repo.ts:35)
// rather than count() (:43) because count() cannot distinguish built-ins.
async function countNonBuiltinProfiles(repository: ProfileRepository): Promise<number> {
  const all = await repository.list();
  return all.filter((p) => !BUILTIN_PROFILE_NAMES.has(p.name)).length;
}

// Ensure every built-in profile (src/services/builtin-profiles.ts) exists in the
// store. An existing profile of the same name is left untouched so an operator's
// edit to a built-in is preserved. Returns the count newly created. Failures for
// one profile are logged and do not abort the others.
async function ensureBuiltinProfiles(
  repository: ProfileRepository,
  log?: BootstrapLogger
): Promise<number> {
  let created = 0;
  for (const profile of BUILTIN_PROFILES) {
    try {
      const already = await repository.get(profile.name);
      if (already) continue;
      await repository.create({ name: profile.name, yaml: profile.yaml });
      created += 1;
    } catch (err) {
      log?.warn({ err, profile: profile.name }, 'profile bootstrap: built-in seed failed');
    }
  }
  return created;
}

// Parse the flat Encore profile index: one `name: relative-url` per line. Nested
// / indented lines, comments and blanks are skipped (the index is a flat map).
export function parseProfileIndex(yaml: string): { name: string; ref: string }[] {
  const entries: { name: string; ref: string }[] = [];
  for (const rawLine of yaml.split(/\r?\n/)) {
    if (rawLine.length === 0 || /^\s/.test(rawLine)) continue;
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('---')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const ref = line.slice(colon + 1).trim();
    if (name.length > 0) entries.push({ name, ref });
  }
  return entries;
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`${url} responded ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

// Seed the repository from the remote index URL. When `force` is false and the
// repository already holds profiles, seeding is skipped. Each profile's YAML is
// fetched from the ref resolved relative to the index URL; a per-profile fetch
// failure is logged and that profile is skipped rather than aborting the run.
export async function bootstrapProfiles(opts: {
  repository: ProfileRepository;
  indexUrl: string;
  force?: boolean;
  log?: BootstrapLogger;
}): Promise<BootstrapResult> {
  const { repository, indexUrl, force = false, log } = opts;

  // Count NON-built-in profiles BEFORE seeding built-ins. This distinguishes a
  // store that has ever ingested the remote index (or had real profiles added by
  // an operator) from one that holds only the built-ins we seed ourselves. The
  // old guard used the total count and so tripped forever once the built-ins had
  // been seeded, never retrying a failed remote index (issue #662). Built-ins are
  // excluded here, so seeding them below cannot influence this count.
  const preExistingRemote = force ? 0 : await countNonBuiltinProfiles(repository);

  // Built-in profiles (issue #385) are ALWAYS ensured, independent of the
  // remote-index skip guard below, so they ship as part of the standard served
  // set even on a store that already holds profiles or when the remote index is
  // unreachable.
  const builtinSeeded = await ensureBuiltinProfiles(repository, log);

  if (!force && preExistingRemote > 0) {
    // Skip path is now logged (issue #662): the old code returned silently, so a
    // skipped seed was invisible in the startup log. State whether the remote
    // index has ever been ingested (non-built-in profiles present) so an operator
    // can tell a legitimate skip from a stuck one.
    log?.info(
      { nonBuiltinProfiles: preExistingRemote, remoteIndexIngested: true, indexUrl },
      'profile bootstrap: skipping remote index seed (non-built-in profiles already present)'
    );
    return { seeded: 0, skipped: true, builtinSeeded };
  }

  const indexBody = await fetchText(indexUrl);
  const entries = parseProfileIndex(indexBody).filter((e) => e.name !== 'none');

  let seeded = 0;
  for (const entry of entries) {
    try {
      const yaml = await fetchText(new URL(entry.ref, indexUrl).toString());
      const already = await repository.get(entry.name);
      if (already) {
        await repository.update(entry.name, yaml);
      } else {
        await repository.create({ name: entry.name, yaml });
      }
      seeded += 1;
    } catch (err) {
      log?.warn({ err, profile: entry.name, ref: entry.ref }, 'profile bootstrap: skipped one profile');
    }
  }

  log?.info({ seeded, builtinSeeded, indexUrl }, 'profile bootstrap complete');
  return { seeded, skipped: false, builtinSeeded };
}
