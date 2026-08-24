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
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - src/data/profile-repo.ts — ProfileRepository.count/create/get signatures.
//   - src/routes/profiles.ts (pre-change) — the trivial `key: value` index
//     parser + FETCH_TIMEOUT_MS convention reused here.
//   - src/services/builtin-profiles.ts — BUILTIN_PROFILES [{ name, yaml }].

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
  skipped: boolean; // true when remote-index seeding was a no-op (profiles existed)
  // Count of built-in profiles newly created this run (issue #385). Built-ins are
  // always ensured, independent of the remote-index skip guard, so this can be
  // non-zero even when `skipped` is true.
  builtinSeeded: number;
};

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

  // Capture whether the store was empty BEFORE seeding built-ins — otherwise the
  // built-ins we add below would themselves trip the "profiles already exist"
  // skip guard on a genuinely fresh store and suppress the remote-index seed.
  const preExisting = force ? 0 : await repository.count();

  // Built-in profiles (issue #385) are ALWAYS ensured, independent of the
  // remote-index skip guard below, so they ship as part of the standard served
  // set even on a store that already holds profiles or when the remote index is
  // unreachable.
  const builtinSeeded = await ensureBuiltinProfiles(repository, log);

  if (!force && preExisting > 0) {
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
