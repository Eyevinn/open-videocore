// Additive, back-compat migration for TAMS addressing fields (issue #166,
// sub-task of the #116 TAMS bridge epic).
//
// Contract verified against:
//   - src/data/asset-document.ts: ASSET_SCHEMA_VERSION = 1;
//     AssetDocumentSchema.schemaVersion = z.literal(1);
//     structural.tams = TamsAddressingSchema.optional()
//     ({ flowIds?: uuid[], timerange? }); fromAssetDocument maps an absent
//     structural.tams to tamsFlowIds/tamsTimerange = undefined.
//   - src/data/couch-asset-repo.ts: fromDoc(...) parses with a FORCED
//     `schemaVersion: 1`; get() only reads (never calls couch.put), so reading
//     is non-mutating and cannot churn `_rev`.
//   - src/data/couchdb.ts: StoredDoc = { _id, _rev?, resourceType, [k]: unknown }.
//
// These tests prove the TAMS fields are additive-only and back-compat: a legacy
// document written before #165 (no structural.tams block) deserializes unchanged
// with the fields absent, and reading it does not mutate the stored document or
// bump its `_rev`.

import { describe, it, expect } from 'vitest';
import { CouchAssetRepository } from '../src/data/couch-asset-repo.js';
import type { StoredDoc, StackCouch } from '../src/data/couchdb.js';

// A minimal in-memory stand-in for StackCouch that records every mutating call.
// Only the methods the read path touches are exercised; the rest throw so an
// accidental write during a read is caught loudly.
class FakeCouch {
  putCalls = 0;
  private readonly byId = new Map<string, StoredDoc>();

  seed(doc: StoredDoc): void {
    this.byId.set(doc._id, doc);
  }

  async get(localId: string): Promise<StoredDoc | undefined> {
    return this.byId.get(localId);
  }

  async put(): Promise<{ id: string; rev: string }> {
    this.putCalls += 1;
    throw new Error('put() must not be called on a read path');
  }

  async find(): Promise<StoredDoc[]> {
    return [];
  }

  async count(): Promise<number> {
    return 0;
  }
}

// Build a legacy asset document body as it would have been persisted BEFORE the
// TAMS fields existed (#165): a valid v1 four-namespace document with NO
// structural.tams block and NO explicit schemaVersion in the stored body (the
// loader injects schemaVersion: 1).
function legacyStoredDoc(): StoredDoc {
  return {
    _id: '01HZ0000000000000000000000',
    _rev: '3-legacyrevtoken',
    resourceType: 'asset',
    localId: '01HZ0000000000000000000000',
    type: 'asset',
    state: 'ready',
    descriptive: { title: 'Legacy Clip', tags: [], custom: {} },
    technical: {},
    administrative: {
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
      source: { method: 'upload' },
      provenance: [],
      statusHistory: []
    },
    structural: { renditions: [], collections: [] }
  };
}

describe('TAMS addressing back-compat migration (issue #166)', () => {
  it('deserializes a legacy document (no structural.tams) with TAMS fields absent', async () => {
    const couch = new FakeCouch();
    couch.seed(legacyStoredDoc());
    const repo = new CouchAssetRepository(() => couch as unknown as StackCouch);

    const asset = await repo.get('01HZ0000000000000000000000');

    expect(asset).toBeDefined();
    // Additive default is ABSENT: the fields deserialize as undefined, not [] / ''.
    expect(asset!.tamsFlowIds).toBeUndefined();
    expect(asset!.tamsTimerange).toBeUndefined();
    // The rest of the legacy document is unaffected.
    expect(asset!.name).toBe('Legacy Clip');
    expect(asset!.status).toBe('ready');
  });

  it('reading a legacy document does not mutate it or churn its _rev (no write-back)', async () => {
    const couch = new FakeCouch();
    const stored = legacyStoredDoc();
    const before = JSON.parse(JSON.stringify(stored));
    couch.seed(stored);
    const repo = new CouchAssetRepository(() => couch as unknown as StackCouch);

    await repo.get('01HZ0000000000000000000000');

    // The read path never wrote: no put() call, so no _rev bump / rewrite.
    expect(couch.putCalls).toBe(0);
    // The stored document object is byte-for-byte unchanged, including _rev.
    expect(stored).toEqual(before);
    expect(stored._rev).toBe('3-legacyrevtoken');
  });

  it('still deserializes a document that DOES carry TAMS fields (forward-compat)', async () => {
    const couch = new FakeCouch();
    const doc = legacyStoredDoc();
    const flowId = '11111111-1111-4111-8111-111111111111';
    (doc['structural'] as Record<string, unknown>)['tams'] = {
      flowIds: [flowId],
      timerange: '[0:0_10:0)'
    };
    couch.seed(doc);
    const repo = new CouchAssetRepository(() => couch as unknown as StackCouch);

    const asset = await repo.get('01HZ0000000000000000000000');

    expect(asset!.tamsFlowIds).toEqual([flowId]);
    expect(asset!.tamsTimerange).toBe('[0:0_10:0)');
    expect(couch.putCalls).toBe(0);
  });
});
