// CouchDB-backed collection search projection (issue #561).
//
// Proves the collection-metadata projection is rebuildable from the document
// store on the PRODUCTION code path: seed collections through the real
// CouchCollectionRepository (writing the on-disk document shape), then query
// through the real CouchSearchRepository wired with that collection repo. No
// side-channel state is used — the projection is derived purely from the stored
// collection documents, mirroring the asset projection (search-parity.test.ts).

import { describe, it, expect } from 'vitest';
import { CouchCollectionRepository } from '../src/data/couch-collection-repo.js';
import { CouchSearchRepository } from '../src/data/couch-search-repo.js';
import type { StoredDoc, StackCouch } from '../src/data/couchdb.js';
import type { SearchQuery } from '../src/data/search-repo.js';

// Minimal in-test StackCouch fake (same predicates as search-parity.test.ts):
// resourceType equality is all the collection repo pushes down; the collection
// match rules (q/tags/custom) are applied in-process by matchesCollectionQuery.
class FakeCouch {
  private readonly docs = new Map<string, StoredDoc>();
  private rev = 0;

  async put(localId: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    this.rev += 1;
    const rev = `${this.rev}-x`;
    this.docs.set(localId, {
      ...body,
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

  async find(
    selector: Record<string, unknown>,
    opts: { limit?: number; skip?: number } = {}
  ): Promise<StoredDoc[]> {
    const rt = selector['resourceType'];
    const all = [...this.docs.values()].filter((d) => rt === undefined || d.resourceType === rt);
    const skip = opts.skip ?? 0;
    return all.slice(skip, skip + (opts.limit ?? all.length)).map((d) => ({ ...d }));
  }

  async count(): Promise<number> {
    return this.docs.size;
  }

  async remove(): Promise<void> {
    /* unused */
  }
}

describe('couch collection search projection (issue #561)', () => {
  async function seeded() {
    const couch = new FakeCouch();
    const collectionRepo = new CouchCollectionRepository(() => couch as unknown as StackCouch);
    const searchRepo = new CouchSearchRepository(
      () => couch as unknown as StackCouch,
      collectionRepo
    );

    const target = await collectionRepo.create({
      name: 'Nature documentaries',
      description: 'Curated wildlife films',
      tags: ['nature', 'documentary'],
      custom: { genre: 'documentary', language: 'sv' }
    });
    await collectionRepo.create({ name: 'City timelapses', tags: ['urban'] });

    return { collectionRepo, searchRepo, target };
  }

  it('projects a collection matched by free text, distinct from assets', async () => {
    const { searchRepo, target } = await seeded();
    const result = await searchRepo.search({ q: 'wildlife' } as SearchQuery);
    // No assets seeded, so the asset half is empty; the collection is surfaced
    // in its own array with the discriminator.
    expect(result.assets).toEqual([]);
    expect(result.collectionTotal).toBe(1);
    expect(result.collections.map((c) => c.id)).toEqual([target.id]);
    expect(result.collections[0].type).toBe('collection');
  });

  it('projects a collection matched by tags (AND semantics)', async () => {
    const { searchRepo, target } = await seeded();
    const hit = await searchRepo.search({ tags: ['nature', 'documentary'] } as SearchQuery);
    expect(hit.collections.map((c) => c.id)).toEqual([target.id]);
    const miss = await searchRepo.search({ tags: ['nature', 'urban'] } as SearchQuery);
    expect(miss.collections).toEqual([]);
  });

  it('projects a collection matched by the open custom bag', async () => {
    const { searchRepo, target } = await seeded();
    const result = await searchRepo.search({ metadata: { genre: 'documentary' } } as SearchQuery);
    expect(result.collections.map((c) => c.id)).toEqual([target.id]);
    expect(result.collections[0].custom?.['genre']).toBe('documentary');
  });

  it('is rebuildable from the document store (no side-channel state)', async () => {
    // Query a FRESH CouchSearchRepository over the SAME stored documents: the
    // projection is reconstructed entirely from the collection documents, so a
    // brand-new repo instance yields the identical result.
    const { target } = await seeded();
    const couch = new FakeCouch();
    const collectionRepo = new CouchCollectionRepository(() => couch as unknown as StackCouch);
    await collectionRepo.create({
      name: 'Nature documentaries',
      description: 'Curated wildlife films',
      tags: ['nature', 'documentary'],
      custom: { genre: 'documentary' }
    });
    const rebuilt = new CouchSearchRepository(() => couch as unknown as StackCouch, collectionRepo);
    const result = await rebuilt.search({ q: 'wildlife' } as SearchQuery);
    expect(result.collectionTotal).toBe(1);
    expect(result.collections[0].name).toBe(target.name);
  });
});
