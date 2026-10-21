// Persisted `statusHistory[].reason` (issue #1085).
//
// Two different failures both land an asset on the same `uploading -> failed`
// pair — a client upload abandoned past the threshold, and a URL pull whose
// worker died — so the reason is the only thing in the history that says which
// one it was. That is only useful if it SURVIVES the document store: a reason
// that is written to the flat asset but dropped by the document projection
// would leave an operator reading a persisted asset exactly as blind as before.
// This suite pins the full persistence round-trip, including the JSON boundary.
//
// It also pins the back-compat half: an entry written WITHOUT a reason (every
// entry written before #1085, and every user-driven transition since) must come
// back with no `reason` key at all — not `reason: undefined`. An explicit
// undefined-valued key is a different document shape, and it would start
// showing up in equality checks, in `'reason' in entry` probes and in the
// serialized response.
//
// Contract sources (CLAUDE.md rule 7):
//   - `StatusTransition.reason?: string` (src/data/asset-repo.ts:123) and
//     `UpdateAssetInput.statusReason?: string` (src/data/asset-repo.ts:732).
//   - Persisted slot: `StatusTransitionSchema.reason` = `z.string().optional()`
//     inside `AssetDocumentSchema.administrative.statusHistory`
//     (src/data/asset-document.ts:143) — optional/additive, so no
//     schemaVersion bump is involved.
//   - Write side: `administrative.statusHistory: asset.statusHistory`
//     in `toAssetDocument()` (src/data/asset-document.ts:509).
//   - Read side: the conditional spread
//     `...(t.reason !== undefined ? { reason: t.reason } : {})` in
//     `fromAssetDocument()` (src/data/asset-document.ts:713-719).

import { describe, it, expect } from 'vitest';

import { InMemoryAssetRepository, type Asset } from './asset-repo.js';
import { toAssetDocument, fromAssetDocument, AssetDocumentSchema } from './asset-document.js';
import { INTERRUPTED_PULL_ASSET_REASON } from '../pipeline/interrupted-ingest-reconciler.js';

// The real persistence boundary: the document is serialized to JSON, stored,
// read back and re-validated. Going through JSON (rather than handing the
// in-memory object straight to the schema) is what actually proves an
// `undefined`-valued key would be caught — JSON.stringify drops it either way,
// so any `reason: undefined` the read side invents has to come from our code.
function persistAndRead(asset: Asset): Asset {
  const doc = toAssetDocument(asset);
  const stored = JSON.parse(JSON.stringify(doc)) as unknown;
  return fromAssetDocument(AssetDocumentSchema.parse(stored));
}

describe('statusHistory[].reason persistence (issue #1085)', () => {
  it('round-trips a settle reason through the asset document', async () => {
    const repo = new InMemoryAssetRepository();
    const created = await repo.create({ name: 'interrupted-pull' });
    const settled = await repo.update(created.id, {
      status: 'failed',
      statusReason: INTERRUPTED_PULL_ASSET_REASON
    });

    // The appended entry carries the reason on the flat asset first.
    const appended = settled?.statusHistory.at(-1);
    expect(appended).toMatchObject({ from: 'uploading', to: 'failed' });
    expect(appended?.reason).toBe(INTERRUPTED_PULL_ASSET_REASON);

    // ... and it is present in the persisted document, under the optional
    // member of StatusTransitionSchema.
    const doc = toAssetDocument(settled as Asset);
    expect(doc.administrative.statusHistory.at(-1)?.reason).toBe(INTERRUPTED_PULL_ASSET_REASON);

    // ... and it survives validation + the read projection unchanged.
    const back = persistAndRead(settled as Asset);
    expect(back.statusHistory.at(-1)).toEqual({
      at: appended?.at,
      from: 'uploading',
      to: 'failed',
      reason: INTERRUPTED_PULL_ASSET_REASON
    });
  });

  it('keeps the reason attached to its OWN entry, leaving earlier history alone', async () => {
    // A reason annotates one transition, not the asset. The creation entry that
    // precedes the settle must still read as a plain pre-#1085 entry.
    const repo = new InMemoryAssetRepository();
    const created = await repo.create({ name: 'mixed-history' });
    const settled = await repo.update(created.id, {
      status: 'failed',
      statusReason: INTERRUPTED_PULL_ASSET_REASON
    });

    const back = persistAndRead(settled as Asset);
    expect(back.statusHistory).toHaveLength(2);
    expect(back.statusHistory[0]).toEqual({
      at: back.statusHistory[0].at,
      from: null,
      to: 'uploading'
    });
    expect(back.statusHistory[1].reason).toBe(INTERRUPTED_PULL_ASSET_REASON);
  });

  it('round-trips a pre-#1085 entry with NO `reason` key at all (not `reason: undefined`)', async () => {
    // Every entry written before this issue simply lacks the field. Reading one
    // back must not materialize the key: `reason: undefined` is a different
    // document shape and would leak into equality checks, `in` probes and the
    // serialized HTTP response.
    const repo = new InMemoryAssetRepository();
    const created = await repo.create({ name: 'legacy' });
    // A user-driven transition, written with no statusReason — byte-identical
    // to history written before #1085.
    const moved = await repo.update(created.id, { status: 'processing' });

    const doc = toAssetDocument(moved as Asset);
    const validated = AssetDocumentSchema.parse(JSON.parse(JSON.stringify(doc)));
    for (const entry of validated.administrative.statusHistory) {
      expect(Object.prototype.hasOwnProperty.call(entry, 'reason')).toBe(false);
    }

    const back = fromAssetDocument(validated);
    expect(back.statusHistory).toHaveLength(2);
    for (const entry of back.statusHistory) {
      expect(Object.prototype.hasOwnProperty.call(entry, 'reason')).toBe(false);
      expect(Object.keys(entry).sort()).toEqual(['at', 'from', 'to']);
    }
    // JSON.stringify would hide an undefined-valued key, so assert on the keys
    // AND on the shape as a whole.
    expect(back.statusHistory[1]).toEqual({
      at: back.statusHistory[1].at,
      from: 'uploading',
      to: 'processing'
    });
  });
});
