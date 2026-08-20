// Search-endpoint parity regression (issue #345).
//
// GET /api/v1/search/ and GET /api/v1/assets/search MUST return the same asset
// set for an equivalent query. Before the fix, the CouchDB-backed
// CouchSearchRepository (which powers /api/v1/search/) pushed structured filters
// down as top-level Mango selectors — `{ tags: { $all } }` and
// `{ technicalMetadata: { containerFormat } }` — but the persisted
// four-namespace document (ADR-005, asset-document.ts) stores those under
// `descriptive.tags` and `technical.container`. There is NO top-level mirror, so
// the selector matched zero documents and every `tags=` (and any query combined
// with one) returned EMPTY, while CouchAssetRepository.search() (which powers
// /api/v1/assets/search) fetched by `{ resourceType: 'asset' }` and filtered the
// RECONSTRUCTED asset in-process, so it matched correctly.
//
// This test wires both repositories over ONE FakeCouch (the same StackCouch fake
// used by asset-tombstone.test.ts) so they read identical stored documents, then
// asserts parity for a tag match and a free-text match. It reproduces the bug
// (would fail on the old buildSelector) and guards the fix.

import { describe, it, expect } from 'vitest';
import { CouchAssetRepository } from '../src/data/couch-asset-repo.js';
import { CouchSearchRepository } from '../src/data/couch-search-repo.js';
import type { StoredDoc, StackCouch } from '../src/data/couchdb.js';
import type { SearchQuery } from '../src/data/search-repo.js';

// Minimal in-test StackCouch fake. Implements the selector predicates the repos
// push down: `resourceType` equality, dotted-path traversal (structural.tams.*),
// and the `$eq` / `$all` / `$elemMatch` operators. It stores whatever body is
// put, faithfully reproducing the persisted document shape (descriptive.tags /
// technical.container), so a wrong-path selector matches nothing exactly as
// CouchDB would.
class FakeCouch {
  private readonly docs = new Map<string, StoredDoc>();
  private rev = 0;

  async put(localId: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    this.rev += 1;
    const rev = `${this.rev}-x`;
    this.docs.set(localId, {
      ...(body as Record<string, unknown>),
      _id: localId,
      _rev: rev,
      resourceType: String(body['resourceType'] ?? 'asset')
    } as StoredDoc);
    return { id: localId, rev };
  }

  async get(localId: string): Promise<StoredDoc | undefined> {
    const d = this.docs.get(localId);
    return d ? { ...d } : undefined;
  }

  private matches(doc: StoredDoc, selector: Record<string, unknown>): boolean {
    for (const [key, cond] of Object.entries(selector)) {
      const actual = key.includes('.')
        ? key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], doc)
        : (doc as Record<string, unknown>)[key];
      if (cond !== null && typeof cond === 'object') {
        const c = cond as Record<string, unknown>;
        if ('$ne' in c && actual === c['$ne']) return false;
        if ('$eq' in c && actual !== c['$eq']) return false;
        if ('$all' in c) {
          const want = c['$all'] as unknown[];
          const have = Array.isArray(actual) ? (actual as unknown[]) : [];
          if (!want.every((w) => have.includes(w))) return false;
        }
        if ('$elemMatch' in c) {
          const em = c['$elemMatch'] as Record<string, unknown>;
          const have = Array.isArray(actual) ? (actual as unknown[]) : [];
          if ('$eq' in em && !have.includes(em['$eq'])) return false;
        }
      } else if (actual !== cond) {
        return false;
      }
    }
    return true;
  }

  async find(
    selector: Record<string, unknown>,
    opts: { limit?: number; skip?: number } = {}
  ): Promise<StoredDoc[]> {
    const all = [...this.docs.values()].filter((d) => this.matches(d, selector));
    const skip = opts.skip ?? 0;
    return all.slice(skip, skip + (opts.limit ?? all.length)).map((d) => ({ ...d }));
  }

  async count(selector: Record<string, unknown>): Promise<number> {
    return [...this.docs.values()].filter((d) => this.matches(d, selector)).length;
  }

  async remove(): Promise<void> {
    /* unused */
  }
}

// Ids of the assets each endpoint resolves, order-independent, for set compare.
function idSet(assets: { id: string }[]): string[] {
  return assets.map((a) => a.id).sort();
}

describe('search endpoint parity (issue #345)', () => {
  async function seeded() {
    const couch = new FakeCouch();
    const assetRepo = new CouchAssetRepository(() => couch as unknown as StackCouch);
    const searchRepo = new CouchSearchRepository(() => couch as unknown as StackCouch);

    // Seed through the asset repository's own create() so the document is written
    // exactly as ingest writes it (descriptive.title / descriptive.tags), not a
    // hand-built shape. This is the canonical-store write the search projection
    // reads from.
    const target = await assetRepo.create({
      name: 'Portfolio smoke test',
      description: 'A calm reference clip',
      tags: ['vcdemo', 'reference']
    });
    await assetRepo.create({ name: 'City traffic', tags: ['urban'] });
    await assetRepo.create({ name: 'Untagged clip' });

    return { assetRepo, searchRepo, target };
  }

  it('GET /api/v1/search/?tags=<tag> returns the tagged asset (was empty)', async () => {
    const { searchRepo, target } = await seeded();
    const result = await searchRepo.search({ tags: ['vcdemo'] } as SearchQuery);
    expect(result.total).toBe(1);
    expect(result.assets.map((a) => a.id)).toEqual([target.id]);
  });

  it('GET /api/v1/search/?q=<term> matches descriptive fields (was empty)', async () => {
    const { searchRepo, target } = await seeded();
    const result = await searchRepo.search({ q: 'smoke' } as SearchQuery);
    expect(result.total).toBe(1);
    expect(result.assets.map((a) => a.id)).toEqual([target.id]);
  });

  it('tag query: /api/v1/search/ and /api/v1/assets/search resolve the same set', async () => {
    // /api/v1/assets/search has no tag param; its equivalent is a free-text
    // query. For the tag dimension we assert /api/v1/search/ now returns the
    // asset the tombstone-excluded asset repo also holds, i.e. the same asset the
    // assets endpoint returns when queried for that asset's title term.
    const { assetRepo, searchRepo, target } = await seeded();

    const viaSearch = await searchRepo.search({ tags: ['vcdemo'] } as SearchQuery);
    // The assets endpoint locates the same asset by a descriptive term; the two
    // paths must agree on the asset identity for that asset.
    const viaAssets = await assetRepo.search('Portfolio smoke');

    expect(idSet(viaSearch.assets)).toEqual([target.id]);
    expect(idSet(viaAssets)).toEqual([target.id]);
  });

  it('free-text query: both endpoints return the identical asset set', async () => {
    const { assetRepo, searchRepo } = await seeded();

    // /api/v1/search/ (CouchSearchRepository) vs /api/v1/assets/search
    // (CouchAssetRepository.search) for the SAME free-text term over the SAME
    // stored documents must return the same asset ids.
    const viaSearch = await searchRepo.search({ q: 'smoke' } as SearchQuery);
    const viaAssets = await assetRepo.search('smoke');

    expect(idSet(viaSearch.assets)).toEqual(idSet(viaAssets));
    expect(idSet(viaSearch.assets).length).toBe(1);
  });
});
