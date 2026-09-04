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

  async find(selector: Record<string, unknown>): Promise<StoredDoc[]> {
    const rt = selector['resourceType'];
    return [...this.docs.values()]
      .filter((d) => rt === undefined || d.resourceType === rt)
      .map((d) => ({ ...d }));
  }

  async count(): Promise<number> {
    return 0;
  }

  async remove(): Promise<void> {
    /* unused */
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
