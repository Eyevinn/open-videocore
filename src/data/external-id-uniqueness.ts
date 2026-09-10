// Per-namespace external-identifier uniqueness config (issue #577, ADR-019 /
// ADR-005).
//
// #575 modelled the `{ namespace, id }` external-identifier SET and #576 added
// the canonical-store lookup (`getByExternalId`). This module adds the
// OPERATOR-CONFIGURABLE toggle that decides whether attaching or changing an
// external id that already resolves to a DIFFERENT asset within the same
// `{ namespace }` is REJECTED (a machine-readable 409) or merely allowed
// (advisory-only). The conflict DETECTION itself is always performed against the
// canonical CouchDB store (`AssetRepository.getByExternalId`, a Mango
// `$elemMatch` push-down over `administrative.externalIdentifiers` in
// couch-asset-repo.ts) — NEVER the disposable PostgreSQL projection (ADR-005
// makes CouchDB canonical) — so this toggle only governs the RESPONSE to a
// detected conflict, not where the conflict is looked up.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Opt-in boolean env-flag convention (`process.env['X'] === 'literal'`,
//     disabled/advisory by default): src/pipeline/watch-folder.ts:58-62
//     (`watchFolderEnabled()` -> `process.env['WATCH_FOLDER_ENABLED'] === 'true'`).
//   - Env-var-as-named-constant + boot-read convention: src/routes/retention.ts:27-43
//     (`ARCHIVE_RETENTION_MS`, default preserves prior behaviour).
//   - Canonical-store conflict lookup seam: AssetRepository.getByExternalId
//     (src/data/asset-repo.ts:822) and its CouchDB `$elemMatch` push-down
//     (src/data/couch-asset-repo.ts:174-188).

// The operator-facing env var. Named as an exported constant so the boot read
// and any log line reference the exact same symbol (no drift).
export const EXTERNAL_ID_UNIQUENESS_ENV = 'EXTERNAL_ID_UNIQUENESS';

// The two enforcement modes:
//   - 'advisory' (DEFAULT): a duplicate `{ namespace, id }` is ALLOWED. This
//     preserves the pre-#577 behaviour exactly, so no deployment changes
//     semantics on upgrade. Round-trip resolution stays best-effort (first
//     match wins, as #576 already documents).
//   - 'enforced': attaching or changing an external id that already resolves to
//     a DIFFERENT asset in the same namespace is rejected with 409
//     `external_id_conflict`, naming the conflicting asset id.
export type ExternalIdUniquenessMode = 'advisory' | 'enforced';

// The documented default: ADVISORY. Uniqueness is opt-IN (an operator must set
// EXTERNAL_ID_UNIQUENESS=enforced), so existing deployments keep working
// unchanged, matching the opt-in convention used by WATCH_FOLDER_ENABLED and the
// ARCHIVE_RETENTION_MS "unset preserves today's behaviour" rule.
export const DEFAULT_EXTERNAL_ID_UNIQUENESS_MODE: ExternalIdUniquenessMode = 'advisory';

// Resolve the boot-time uniqueness mode (12-factor: config via env). Only the
// exact, case-insensitive literal `enforced` turns enforcement on; anything else
// (unset, empty, whitespace, or an unrecognised value) resolves to the advisory
// default so a typo can never silently enable a rejecting behaviour.
export function externalIdUniquenessModeFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ExternalIdUniquenessMode {
  const raw = env[EXTERNAL_ID_UNIQUENESS_ENV];
  if (typeof raw !== 'string') {
    return DEFAULT_EXTERNAL_ID_UNIQUENESS_MODE;
  }
  return raw.trim().toLowerCase() === 'enforced'
    ? 'enforced'
    : DEFAULT_EXTERNAL_ID_UNIQUENESS_MODE;
}

// Convenience predicate for the route layer.
export function externalIdUniquenessEnforced(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return externalIdUniquenessModeFromEnv(env) === 'enforced';
}
