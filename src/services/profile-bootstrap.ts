// Encore profile bootstrap (issue #84).
//
// Seeds the profile repository from the default Encore profile index on first
// startup (or on demand via POST /api/v1/profiles/bootstrap). The index is the
// flat `name: relative-url` map that Encore itself consumes; for each entry we
// fetch the referenced YAML file (resolved relative to the index URL) and store
// name + YAML content. Subsequent bootstraps are a no-op once profiles exist.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - src/data/profile-repo.ts — ProfileRepository.count/create/get signatures.
//   - src/routes/profiles.ts (pre-change) — the trivial `key: value` index
//     parser + FETCH_TIMEOUT_MS convention reused here.

import type { ProfileRepository } from '../data/profile-repo.js';

// Timeout for each upstream fetch so a slow/hung index host can't block startup.
const FETCH_TIMEOUT_MS = 5000;

export type BootstrapLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type BootstrapResult = {
  seeded: number;
  skipped: boolean; // true when profiles already existed and bootstrap was a no-op
};

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

  if (!force) {
    const existing = await repository.count();
    if (existing > 0) {
      return { seeded: 0, skipped: true };
    }
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

  log?.info({ seeded, indexUrl }, 'profile bootstrap complete');
  return { seeded, skipped: false };
}
