// Audit-log entry data model + append-only store (issue #563, parent #529).
//
// Backend-only persistence foundation for the audit/activity log surface. There
// is NO HTTP route, NO query endpoint, and NO instrumentation of mutation call
// sites in this cut — those are separate sub-issues. This module provides a
// single internal write primitive (`record`) other surfaces will call, plus a
// read-back primitive (`get`/`list`) used only by tests.
//
// Store choice (see docs/investigations/563-audit-log-store-decision.md):
// the existing per-tenant CouchDB store used as a dedicated append-only
// partition — documents carry `resourceType: 'audit-entry'`, following the same
// document-shape + connection pattern as CouchCollectionRepository
// (src/data/couch-collection-repo.ts:22-107) over StackCouch (src/data/couchdb.ts:22).
// The in-memory LogStore (src/services/log-store.ts:105) was rejected: it is
// process-local (not durable, src/services/log-store.ts:1-10,109) and models a
// free-text message/level/category stream, not an actor/action/target audit
// entry (src/services/log-store.ts:33-39).
//
// Append-only semantics follow ADR-005 "append the audit entry, never rewrite
// history" (src/data/couch-asset-repo.ts:362): every entry is a distinct
// immutable document minted with a fresh ULID id; this module exposes no update
// or delete path and never carries a `_rev` forward, so a written entry can
// never be overwritten by application code.

import { z } from 'zod';
import { ulid } from 'ulid';
import type { StoredDoc, StackCouch } from './couchdb.js';
// Reuse the pre-existing coarse origin enum (ADR-005, issue #53) — do NOT
// redefine it. PROVENANCE_ACTORS = ['user','system','ai'] as const at
// src/data/asset-repo.ts:99-100.
import { PROVENANCE_ACTORS } from './asset-repo.js';

// resourceType discriminator for the audit partition — mirrors the
// per-resource-type convention (e.g. 'collection' at
// src/data/couch-collection-repo.ts:20).
const RESOURCE_TYPE = 'audit-entry';

// What kind of resource an entry is about. A closed enum so a bad targetType is
// rejected at write time.
export const AUDIT_TARGET_TYPES = ['asset', 'collection', 'job'] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

// Actor, forward-compatible for the real principal identity that lands with
// #525. Today auth is a presence-only gate with no principal, so `principalId`
// is a nullable placeholder; `origin` is the pre-existing coarse enum reused
// from asset-repo. Once identity lands, `principalId` gets enriched without a
// schema break.
export const AuditActorSchema = z.object({
  // Placeholder principal id. Nullable until #525; never omitted.
  principalId: z.string().nullable(),
  // Coarse origin — reuses PROVENANCE_ACTORS (['user','system','ai']).
  origin: z.enum(PROVENANCE_ACTORS)
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

// A small structured detail bag. Free-form JSON-ish values keyed by string; kept
// deliberately loose so callers can attach context without a schema change.
export const AuditDetailSchema = z.record(z.string(), z.unknown());
export type AuditDetail = z.infer<typeof AuditDetailSchema>;

// A persisted audit entry. `id` is a ULID minted at write time (time-sortable,
// ADR-005 id design). `at` is an ISO-8601 instant.
export const AuditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actor: AuditActorSchema,
  action: z.string().min(1),
  targetType: z.enum(AUDIT_TARGET_TYPES),
  targetId: z.string().min(1),
  detail: AuditDetailSchema.default({})
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// Input accepted by record(). The store assigns `id` and defaults `at` to now;
// callers must not supply `id`. `detail` is optional and defaults to {}.
export const RecordAuditInputSchema = z.object({
  actor: AuditActorSchema,
  action: z.string().min(1),
  targetType: z.enum(AUDIT_TARGET_TYPES),
  targetId: z.string().min(1),
  detail: AuditDetailSchema.optional(),
  // Injectable timestamp for deterministic tests; defaults to now.
  at: z.string().optional()
});
export type RecordAuditInput = z.infer<typeof RecordAuditInputSchema>;

export type CouchFactory = () => StackCouch;

// Append-only audit store over a dedicated CouchDB partition.
//
// Deliberately exposes ONLY `record` (write) and `get`/`list` (read-back). No
// update, no delete, no _rev carry-forward — consistent with ADR-005 append,
// never rewrite.
export class CouchAuditRepository {
  constructor(private readonly couchFor: CouchFactory) {}

  // Write a single audit entry. Validates required fields and rejects a bad
  // targetType (via RecordAuditInputSchema.parse) BEFORE any write. Mints a
  // fresh ULID id, so every call produces a new immutable document — an existing
  // entry is never read-modified.
  async record(input: RecordAuditInput): Promise<AuditEntry> {
    const parsed = RecordAuditInputSchema.parse(input);
    const entry: AuditEntry = {
      id: ulid(),
      at: parsed.at ?? new Date().toISOString(),
      actor: parsed.actor,
      action: parsed.action,
      targetType: parsed.targetType,
      targetId: parsed.targetId,
      detail: parsed.detail ?? {}
    };
    const couch = this.couchFor();
    // put() with a brand-new id and NO _rev: a fresh document every time. There
    // is no read-modify-write here, so prior entries are untouched.
    await couch.put(entry.id, toDoc(entry));
    return entry;
  }

  // Read one entry back by id. Read-back primitive for tests/other surfaces; not
  // an HTTP surface.
  async get(id: string): Promise<AuditEntry | undefined> {
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    return fromDoc(doc);
  }

  // List entries in the audit partition, newest-first by ULID (time-sortable).
  // Read-back primitive only — the query/read HTTP surface is a separate
  // sub-issue and is intentionally NOT built here.
  async list(opts: { limit?: number } = {}): Promise<AuditEntry[]> {
    const couch = this.couchFor();
    const docs = await couch.find({ resourceType: RESOURCE_TYPE }, { limit: opts.limit ?? 1000 });
    return docs
      .filter((d) => d.resourceType === RESOURCE_TYPE)
      .map(fromDoc)
      .sort((a, b) => b.id.localeCompare(a.id));
  }
}

// Map an AuditEntry to its persisted document body. Mirrors the
// resourceType + localId + flat-body shape of CouchCollectionRepository.toDoc
// (src/data/couch-collection-repo.ts:98-107).
function toDoc(entry: AuditEntry): Record<string, unknown> {
  return {
    resourceType: RESOURCE_TYPE,
    localId: entry.id,
    at: entry.at,
    actor: entry.actor,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    detail: entry.detail
  };
}

function fromDoc(doc: StoredDoc): AuditEntry {
  return AuditEntrySchema.parse({
    id: String(doc['localId'] ?? stripPartition(doc._id)),
    at: String(doc['at'] ?? ''),
    actor: doc['actor'],
    action: String(doc['action'] ?? ''),
    targetType: doc['targetType'],
    targetId: String(doc['targetId'] ?? ''),
    detail: doc['detail'] ?? {}
  });
}

function stripPartition(id: string): string {
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}
