// TAMS addressing (de)serialization tests (issue #167, sub-task of the #116
// TAMS bridge epic). Covers round-trip, back-compat, validation, and optionality
// of the optional TAMS addressing fields added to the asset model in #165.
//
// These tests exercise the REAL serialization contract from src/data — they do
// not re-implement or mock the schema:
//   - src/data/asset-document.ts:
//       toAssetDocument / fromAssetDocument  (flat Asset <-> namespaced document)
//       AssetDocumentSchema                  (structural.tams: TamsAddressingSchema)
//       TamsAddressingSchema                 ({ flowIds?: uuid[], timerange? })
//       TamsFlowIdSchema                     (z.string().uuid())
//       TamsTimerangeSchema                  (ADR-008 TAI timerange grammar)
//   - src/data/asset-repo.ts:
//       InMemoryAssetRepository, Asset (flat domain fields tamsFlowIds / tamsTimerange)
//
// The migration read-path / _rev-churn concern is covered separately by the #166
// sibling (test/tams-migration.test.ts); this file is specifically the #167
// round-trip + back-compat + validation + optionality of (de)serialization.

import { describe, it, expect } from 'vitest';
import { InMemoryAssetRepository, type Asset } from '../src/data/asset-repo.js';
import {
  AssetDocumentSchema,
  TamsAddressingSchema,
  TamsFlowIdSchema,
  TamsTimerangeSchema,
  toAssetDocument,
  fromAssetDocument
} from '../src/data/asset-document.js';

// A syntactically valid TAMS flow UUID and TAI timerange (ADR-008 grammar).
const FLOW_ID = '123e4567-e89b-12d3-a456-426614174000';
const FLOW_ID_2 = '00000000-0000-4000-8000-000000000001';
const TIMERANGE = '[0:0_10:0)';

// Build a fresh asset via the real repository, then attach the TAMS addressing
// fields directly on the flat domain type (there is no dedicated repo route for
// them; the pipeline sets them). Returns the flat Asset carrying the fields.
async function assetWithTams(fields: {
  tamsFlowIds?: string[];
  tamsTimerange?: string;
}): Promise<Asset> {
  const repo = new InMemoryAssetRepository();
  const asset = await repo.create({ name: 'TAMS clip' });
  if (fields.tamsFlowIds !== undefined) asset.tamsFlowIds = fields.tamsFlowIds;
  if (fields.tamsTimerange !== undefined) asset.tamsTimerange = fields.tamsTimerange;
  return asset;
}

describe('TAMS addressing (de)serialization (issue #167)', () => {
  describe('round-trip through the document mappers', () => {
    it('an asset with flowIds + timerange serializes and deserializes to an equal value', async () => {
      const asset = await assetWithTams({
        tamsFlowIds: [FLOW_ID, FLOW_ID_2],
        tamsTimerange: TIMERANGE
      });

      // Serialize to the persisted document, validate the stored shape, then
      // deserialize back to the flat domain type.
      const parsed = AssetDocumentSchema.parse(toAssetDocument(asset));
      const back = fromAssetDocument(parsed);

      // The addressing fields survive the round-trip unchanged (equal value).
      expect(back.tamsFlowIds).toEqual([FLOW_ID, FLOW_ID_2]);
      expect(back.tamsTimerange).toBe(TIMERANGE);
    });

    it('persists the fields under the machine-owned structural namespace (ADR-005), not descriptive', async () => {
      const asset = await assetWithTams({ tamsFlowIds: [FLOW_ID], tamsTimerange: TIMERANGE });
      const doc = AssetDocumentSchema.parse(toAssetDocument(asset));
      expect(doc.structural.tams).toEqual({ flowIds: [FLOW_ID], timerange: TIMERANGE });
      expect('tams' in doc.descriptive).toBe(false);
    });

    it('round-trips a flowIds-only asset (timerange absent)', async () => {
      const asset = await assetWithTams({ tamsFlowIds: [FLOW_ID] });
      const back = fromAssetDocument(AssetDocumentSchema.parse(toAssetDocument(asset)));
      expect(back.tamsFlowIds).toEqual([FLOW_ID]);
      expect(back.tamsTimerange).toBeUndefined();
    });

    it('round-trips a timerange-only asset (flowIds absent)', async () => {
      const asset = await assetWithTams({ tamsTimerange: TIMERANGE });
      const back = fromAssetDocument(AssetDocumentSchema.parse(toAssetDocument(asset)));
      expect(back.tamsTimerange).toBe(TIMERANGE);
      expect(back.tamsFlowIds).toBeUndefined();
    });
  });

  describe('back-compat: a document lacking the fields deserializes cleanly', () => {
    it('a fixture document with no structural.tams parses and reads the fields as absent', () => {
      // Hand-built legacy fixture written before #165: structural has no `tams`
      // key at all. It must deserialize without error and the fields read absent.
      const legacyFixture = {
        _id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        type: 'asset' as const,
        schemaVersion: 1 as const,
        state: 'ready',
        descriptive: { title: 'Legacy clip', tags: [], custom: {} },
        technical: {},
        administrative: {
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          source: { method: 'upload' as const },
          provenance: [],
          statusHistory: []
        },
        structural: { renditions: [], collections: [] }
      };

      const parsed = AssetDocumentSchema.parse(legacyFixture);
      expect(parsed.structural.tams).toBeUndefined();

      const back = fromAssetDocument(parsed);
      expect(back.tamsFlowIds).toBeUndefined();
      expect(back.tamsTimerange).toBeUndefined();
    });

    it('an asset with no TAMS fields serializes without emitting a structural.tams block', async () => {
      // Back-compat on the WRITE path: a pre-#165-style asset must not gain a
      // `tams` key, so it round-trips with the field absent.
      const asset = await assetWithTams({});
      const doc = toAssetDocument(asset);
      expect('tams' in doc.structural).toBe(false);
      const back = fromAssetDocument(AssetDocumentSchema.parse(doc));
      expect(back.tamsFlowIds).toBeUndefined();
      expect(back.tamsTimerange).toBeUndefined();
    });
  });

  describe('validation: invalid flowId and malformed timerange are rejected', () => {
    it('rejects a non-UUID flow id', () => {
      expect(() => TamsFlowIdSchema.parse('not-a-uuid')).toThrow();
      expect(() => TamsAddressingSchema.parse({ flowIds: ['not-a-uuid'] })).toThrow();
    });

    it('rejects an addressing block whose array mixes a valid and an invalid flow id', () => {
      expect(() => TamsAddressingSchema.parse({ flowIds: [FLOW_ID, '12345'] })).toThrow();
    });

    it('rejects malformed timeranges that violate the ADR-008 TAI grammar', () => {
      for (const bad of ['garbage', '0-10', '[0:0_10:0', '[abc_def)', '10:0_5:0]x']) {
        expect(() => TamsTimerangeSchema.parse(bad)).toThrow();
        expect(() => TamsAddressingSchema.parse({ timerange: bad })).toThrow();
      }
    });

    it('accepts the documented ADR-008 timerange forms', () => {
      for (const good of ['[0:0_10:0)', '[_10:0)', '[5:0_)', '[_)', '_', '[0:0]']) {
        expect(() => TamsTimerangeSchema.parse(good)).not.toThrow();
      }
    });

    it('surfaces schema rejection through the full document validation', () => {
      // Corrupt the persisted document's addressing block and confirm the
      // AssetDocumentSchema (which embeds TamsAddressingSchema) rejects it.
      expect(() =>
        AssetDocumentSchema.parse({
          _id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          type: 'asset',
          schemaVersion: 1,
          state: 'ready',
          descriptive: { title: 'Bad', tags: [], custom: {} },
          technical: {},
          administrative: {
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            source: { method: 'upload' },
            provenance: [],
            statusHistory: []
          },
          structural: { renditions: [], collections: [], tams: { flowIds: ['nope'] } }
        })
      ).toThrow();
    });
  });

  describe('optionality: an asset with the fields omitted still validates', () => {
    it('an empty addressing block validates (both fields optional)', () => {
      expect(() => TamsAddressingSchema.parse({})).not.toThrow();
      expect(TamsAddressingSchema.parse({})).toEqual({});
    });

    it('a full asset document with the fields omitted validates', async () => {
      const asset = await assetWithTams({});
      // The whole document validates even though structural.tams is absent.
      expect(() => AssetDocumentSchema.parse(toAssetDocument(asset))).not.toThrow();
    });
  });
});
