// Audit-log entry data model + append-only store (issue #563, parent #529).
//
// Backend-only: exercises the internal write primitive (`record`) and read-back
// primitives (`get`/`list`) directly against an in-test StackCouch fake. There
// is no HTTP surface in this sub-issue, so these are pure store/model tests.
//
// Contract grounding (verified before writing):
//   - CouchAuditRepository.record/get/list — src/data/audit-repo.ts.
//   - AuditEntrySchema / AUDIT_TARGET_TYPES — src/data/audit-repo.ts.
//   - PROVENANCE_ACTORS reused for actor.origin — src/data/asset-repo.ts:99-100.
//   - StackCouch put/get/find contract — src/data/couchdb.ts:29,39,66.
//   - FakeCouch shape mirrors test/asset-restore.test.ts:227-263.

import { describe, it, expect } from 'vitest';
import type { StoredDoc, StackCouch } from '../src/data/couchdb.js';
import {
  CouchAuditRepository,
  AuditEntrySchema,
  RecordAuditInputSchema,
  AUDIT_TARGET_TYPES,
  type AuditActor
} from '../src/data/audit-repo.js';

// Minimal StackCouch fake. Mirrors the asset-restore fake but implements find()
// with a resourceType selector so the audit partition read-back works.
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
    // CouchDB's default scan (no explicit `sort`) walks the primary `_id` index,
    // so results come back in ascending `_id` order. The fake reproduces that so
    // listOldestPage's skip/limit paging yields a globally consistent
    // oldest-first order across pages (audit `_id` == time-sortable ULID).
    const all = [...this.docs.values()]
      .filter((d) => rt === undefined || d.resourceType === rt)
      .map((d) => ({ ...d }))
      .sort((a, b) => a._id.localeCompare(b._id));
    const skip = opts.skip ?? 0;
    const limited = opts.limit === undefined ? all.slice(skip) : all.slice(skip, skip + opts.limit);
    return limited;
  }

  async count(): Promise<number> {
    return 0;
  }

  // Whole-document delete: read _rev then drop it entirely (mirrors
  // StackCouch.remove, src/data/couchdb.ts:87-93). Used by purgeEntry.
  async remove(localId: string): Promise<void> {
    this.docs.delete(localId);
  }

  // Test-only helper: how many documents are held, to assert appends don't
  // mutate/replace prior entries.
  rawSize(): number {
    return this.docs.size;
  }
}

const actor: AuditActor = { principalId: null, origin: 'system' };

function makeRepo() {
  const couch = new FakeCouch();
  const repo = new CouchAuditRepository(() => couch as unknown as StackCouch);
  return { couch, repo };
}

describe('audit entry model (issue #563)', () => {
  it('writes an entry and reads it back via the store read primitive', async () => {
    const { repo } = makeRepo();
    const written = await repo.record({
      actor,
      action: 'asset.created',
      targetType: 'asset',
      targetId: 'asset-123',
      detail: { name: 'Clip' }
    });

    expect(written.id).toBeTruthy();
    expect(written.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(written.actor).toEqual({ principalId: null, origin: 'system' });
    expect(written.targetType).toBe('asset');

    const readBack = await repo.get(written.id);
    expect(readBack).toEqual(written);
  });

  it('actor is forward-compatible: nullable principalId + reused origin enum', async () => {
    const { repo } = makeRepo();
    const entry = await repo.record({
      actor: { principalId: 'principal-abc', origin: 'user' },
      action: 'collection.updated',
      targetType: 'collection',
      targetId: 'collection-9'
    });
    // principalId can be null (placeholder) OR a real id (post-#525).
    expect(entry.actor.principalId).toBe('principal-abc');
    // origin only accepts the reused PROVENANCE_ACTORS values.
    expect(() =>
      RecordAuditInputSchema.parse({
        actor: { principalId: null, origin: 'robot' },
        action: 'x',
        targetType: 'asset',
        targetId: 'a'
      })
    ).toThrow();
  });

  it('append-only: each write is a new immutable document; prior entries are untouched', async () => {
    const { couch, repo } = makeRepo();
    const first = await repo.record({
      actor,
      action: 'job.started',
      targetType: 'job',
      targetId: 'job-1'
    });
    const second = await repo.record({
      actor,
      action: 'job.completed',
      targetType: 'job',
      targetId: 'job-1'
    });

    // Distinct documents, not an overwrite.
    expect(first.id).not.toBe(second.id);
    expect(couch.rawSize()).toBe(2);

    // The first entry is byte-for-byte unchanged after the second write.
    const firstReRead = await repo.get(first.id);
    expect(firstReRead).toEqual(first);

    const all = await repo.list();
    expect(all).toHaveLength(2);
  });

  it('exposes no update or delete path on the service', () => {
    const { repo } = makeRepo();
    // Only record/get/list are public. Absence of any mutate/delete/update
    // method is what enforces append-only at the API boundary.
    expect((repo as unknown as Record<string, unknown>)['update']).toBeUndefined();
    expect((repo as unknown as Record<string, unknown>)['delete']).toBeUndefined();
    expect((repo as unknown as Record<string, unknown>)['remove']).toBeUndefined();
    expect((repo as unknown as Record<string, unknown>)['mutate']).toBeUndefined();
  });

  it('schema validates required fields', () => {
    const good = {
      id: '01HTEST',
      at: '2026-09-04T00:00:00.000Z',
      actor,
      action: 'asset.created',
      targetType: 'asset' as const,
      targetId: 'asset-1'
    };
    const parsed = AuditEntrySchema.parse(good);
    expect(parsed.detail).toEqual({}); // defaults to an empty bag

    // Missing required action.
    expect(() => AuditEntrySchema.parse({ ...good, action: '' })).toThrow();
    // Missing required targetId.
    expect(() => AuditEntrySchema.parse({ ...good, targetId: '' })).toThrow();
  });

  it('rejects a bad targetType at write time', async () => {
    const { repo } = makeRepo();
    await expect(
      repo.record({
        actor,
        action: 'weird',
        // @ts-expect-error deliberately invalid targetType
        targetType: 'workspace',
        targetId: 'ws-1'
      })
    ).rejects.toThrow();
  });

  it('AUDIT_TARGET_TYPES is the closed asset|collection|job set', () => {
    expect(AUDIT_TARGET_TYPES).toEqual(['asset', 'collection', 'job']);
  });
});

describe('audit retention enumerate + whole-entry purge (issue #566)', () => {
  async function seed(repo: CouchAuditRepository, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const e = await repo.record({
        actor,
        action: `evt-${i}`,
        targetType: 'asset',
        targetId: `asset-${i}`,
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
      });
      ids.push(e.id);
    }
    return ids;
  }

  it('listOldestPage returns oldest-first (ascending id) and honours limit/offset', async () => {
    const { repo } = makeRepo();
    const ids = await seed(repo, 5);
    // ULIDs minted within the same millisecond are not guaranteed monotonic, so
    // compare against the LEXICOGRAPHICALLY ascending id order (what the store
    // orders by), not raw insertion order.
    const ascending = [...ids].sort((a, b) => a.localeCompare(b));

    const firstTwo = await repo.listOldestPage({ limit: 2, offset: 0 });
    expect(firstTwo.map((e) => e.id)).toEqual(ascending.slice(0, 2));

    const nextTwo = await repo.listOldestPage({ limit: 2, offset: 2 });
    expect(nextTwo.map((e) => e.id)).toEqual(ascending.slice(2, 4));

    // Ascending, i.e. the exact reverse of the newest-first read-back `list`.
    const newestFirst = (await repo.list()).map((e) => e.id);
    const oldestFirst = (await repo.listOldestPage({ limit: 10 })).map((e) => e.id);
    expect(oldestFirst).toEqual([...newestFirst].reverse());
  });

  it('purgeEntry removes the WHOLE entry (never an in-place edit) and returns true', async () => {
    const { couch, repo } = makeRepo();
    const [id0, id1] = await seed(repo, 2);

    expect(couch.rawSize()).toBe(2);
    // A survivor is byte-for-byte unchanged; purge is whole-entry, not a rewrite.
    const survivorBefore = await repo.get(id1);

    const removed = await repo.purgeEntry(id0);
    expect(removed).toBe(true);
    expect(await repo.get(id0)).toBeUndefined(); // gone entirely
    expect(couch.rawSize()).toBe(1);
    expect(await repo.get(id1)).toEqual(survivorBefore); // untouched
  });

  it('purgeEntry returns false when the entry does not exist / is not an audit doc', async () => {
    const { repo } = makeRepo();
    expect(await repo.purgeEntry('01HDOESNOTEXIST')).toBe(false);
  });
});
