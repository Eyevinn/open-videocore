# ADR-019: External-identifier data model and namespace placement for assets

**Status:** PROPOSED 2026-09-07
**Date:** 2026-09-07
**Author agent:** claude-opus-4-8 (surface-backend-api)
**Issue:** #575 (data-model + placement decision; blocks lookup #576 and uniqueness #577)

---

## Context

Assets carry only an internal ULID `_id` minted in the repo layer (the ADR-005
aggregate model, described in `src/data/asset-document.ts` header lines 1-23).
A developer can stash an upstream id in `descriptive.custom`
(`src/data/asset-document.ts` `descriptive.custom`, a
`z.record(z.unknown()).default({})` field), but there is no dedicated, typed
external-identifier field and no namespace to distinguish which upstream system
of record a stashed id belongs to.

Before any lookup (#576) or uniqueness (#577) code lands, the SHAPE and the
namespace PLACEMENT of asset external identifiers must be pinned so those
follow-on issues, and the OpenAPI contract, stay stable. This ADR decides both.
It does NOT introduce lookup or uniqueness logic.

## Verified contract sources (CLAUDE.md rule 7)

Every symbol below was read on this branch before citing:

- ADR-005 four-namespace provenance rules — `src/data/asset-document.ts` header
  lines 5-11: `descriptive` = user / editorial; `technical` = machine (ffprobe);
  `administrative` = system (timestamps, source method, storage refs,
  provenance); `structural` = pipeline. "writers of different provenance never
  share a field."
- There is **no ADR-005 file** in `docs/architecture/`; its facts are grounded
  in the live model code, exactly as recorded in `ADR-009-tams-bridge.md`
  lines 95-101. This ADR therefore records the decision as a new ADR (not an
  addendum to a non-existent file) and points back at that live model.
- The persisted aggregate root — `AssetDocumentSchema` in
  `src/data/asset-document.ts`, with `schemaVersion: z.literal(ASSET_SCHEMA_VERSION)`
  (`ASSET_SCHEMA_VERSION = 1`).
- The precedent for an OPTIONAL, additive namespaced field with NO schemaVersion
  bump — the TAMS addressing block (`TamsAddressingSchema`,
  `structural.tams`, `src/data/asset-document.ts`), and its flat-type twin
  `tamsFlowIds` / `tamsTimerange` in `src/data/asset-repo.ts` (`Asset` type).
  Both are attached in `toAssetDocument` only when present and mapped back to
  `undefined` when absent in `fromAssetDocument`, so pre-existing documents stay
  valid. This ADR follows that exact pattern.
- The public contract is NOT affected: neither `tamsFlowIds` nor the new field
  appear in the committed `openapi.json` (the persisted document schema is
  internal, distinct from the wire schemas in `src/routes/*`). Regenerating
  `openapi.json` after this change produces a byte-identical file.

## Decision

### 1. Data model: a SET of `{ namespace, id }`, not a scalar

External identifiers are modelled as an **array** of
`{ namespace: string, id: string }` entries, not a single scalar. An asset is
frequently a projection of records held in more than one upstream system (e.g.
an ingest catalogue AND a rights registry), so it must be correlatable with
each independently. `namespace` labels the owning system of record; `id` is the
opaque foreign-key value in that system (systems vary — UUIDs, numeric ids,
slugs — so it stays a string). Both are `.min(1)` so an entry always names its
system and carries a value.

Runtime shape (`ExternalIdentifierSchema`, `src/data/asset-document.ts`):

```
{ namespace: z.string().min(1), id: z.string().min(1) }
```

Uniqueness of `(namespace, id)` and reverse lookup are intentionally NOT modelled
here — they are #577 and #576 respectively.

### 2. Placement: `administrative`, not `descriptive`

External identifiers are placed under the **`administrative`** namespace, as
`administrative.externalIdentifiers`.

Rationale, tested against the ADR-005 writer-provenance rules
(`asset-document.ts` header lines 5-11):

- They are **system-owned mapping data / foreign keys**, written by ingest and
  synchronisation machinery, not editorial content authored by a user. That is
  the definition of the `administrative` namespace ("system: … storage refs,
  provenance"), which already holds `source`, `storage`, and `provenance` — all
  system-of-record linkage, the same class of data.
- Placing them under `descriptive` would violate the rule that "writers of
  different provenance never share a field": `descriptive` is the user/editorial
  namespace, and a user editing a title must not co-own a field that ingest
  machinery also writes.
- This mirrors the identical reasoning ADR-009 applied to TAMS addressing
  (machine/pipeline-derived, so `structural`, never `descriptive`): the
  namespace follows the WRITER'S provenance. For a cross-system foreign key the
  writer is the system, so `administrative` is correct.

### 3. Versioning: optional + additive, no schemaVersion bump

The field is OPTIONAL (`z.array(ExternalIdentifierSchema).optional()`). Documents
written before #575 have the field absent and still deserialize unchanged, so
`ASSET_SCHEMA_VERSION` stays `1` and no migration is forced — following the same
no-bump precedent as `reviewState`, `sceneDetection`, `tams`, and
`packagedOutput` in the same file. When (and only when) an asset carries at
least one entry, `toAssetDocument` attaches the block; `fromAssetDocument` maps
an absent/empty collection back to `undefined`, keeping the flat domain `Asset`
clean for pre-#575 assets.

## Consequences

- `#576` (lookup) can build an index over `administrative.externalIdentifiers`
  and `#577` (uniqueness) can enforce a `(namespace, id)` constraint, both
  against a stable, typed shape.
- The public OpenAPI contract is unchanged (verified: regenerated
  `openapi.json` is byte-identical), so no client migration is needed.
- Existing assets without external ids remain valid (optional field, no forced
  migration), satisfying the issue's acceptance criteria.
