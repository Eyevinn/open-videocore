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

// Re-export the coarse actor-origin enum values (PROVENANCE_ACTORS from
// asset-repo, ['user','system','ai']) under an audit-scoped name so the read
// route can build its actor-origin filter from the SAME source of truth the
// persisted `AuditActor.origin` uses — no re-declared enum. See
// src/data/asset-repo.ts:99-100.
export const PROVENANCE_ACTORS_FOR_AUDIT = PROVENANCE_ACTORS;

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

// Read-only query for the audit read surface (issue #565). All fields optional:
// an empty query returns every entry, newest-first. Filters are ANDed:
//   - targetType + targetId : entries about one specific resource. `targetId`
//     is only meaningful alongside `targetType` (a target is identified by the
//     pair), so it is accepted only when `targetType` is present.
//   - origin                : coarse actor origin (PROVENANCE_ACTORS).
//   - principalId           : exact actor principal id (nullable placeholder
//     until #525) — matches entries whose actor.principalId equals this value.
//   - action                : exact action string.
//   - from / to             : inclusive ISO-8601 bounds on `at`.
// `limit`/`offset` mirror the asset list surface's offset pagination
// (src/routes/assets.ts:322-327,681-686): `{ items, limit, offset, total }`.
export type AuditQuery = {
  targetType?: AuditTargetType;
  targetId?: string;
  origin?: AuditActor['origin'];
  principalId?: string;
  action?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

// A page of audit entries. Shape mirrors the asset list surface
// (`{ items, limit, offset, total }`, src/routes/assets.ts:681-686). `total` is
// the count of entries matching the filters BEFORE limit/offset are applied.
export type AuditQueryResult = {
  items: AuditEntry[];
  limit: number;
  offset: number;
  total: number;
};

// Default page size when the caller omits `limit`. Same default the asset list
// route effectively uses is per-route; here the audit surface picks 50.
export const AUDIT_DEFAULT_LIMIT = 50;
// Upper bound on a single page, mirroring the asset list cap
// (src/routes/assets.ts:323 `max(200)`).
export const AUDIT_MAX_LIMIT = 200;

// Pure, read-only filter+sort+paginate over already-materialised entries.
// Shared by both the Couch and in-memory repos so the two cannot drift. Never
// mutates its input. Sort is newest-first by ULID id (time-sortable, ADR-005),
// identical to `list()` above.
export function applyAuditQuery(all: readonly AuditEntry[], query: AuditQuery): AuditQueryResult {
  const filtered = all.filter((e) => {
    if (query.targetType !== undefined && e.targetType !== query.targetType) return false;
    if (query.targetId !== undefined && e.targetId !== query.targetId) return false;
    if (query.origin !== undefined && e.actor.origin !== query.origin) return false;
    if (query.principalId !== undefined && e.actor.principalId !== query.principalId) return false;
    if (query.action !== undefined && e.action !== query.action) return false;
    if (query.from !== undefined && e.at < query.from) return false;
    if (query.to !== undefined && e.at > query.to) return false;
    return true;
  });
  // Newest-first. Primary key is the event instant `at`; `id` (a time-sortable
  // ULID) is the stable tiebreak for entries sharing an `at`. In production the
  // two agree (the ULID is minted at record time); ordering on `at` first makes
  // "newest-first" mean the event time the caller filters on with from/to.
  filtered.sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)));
  const total = filtered.length;
  const offset = query.offset ?? 0;
  const limit = query.limit ?? AUDIT_DEFAULT_LIMIT;
  const items = filtered.slice(offset, offset + limit);
  return { items, limit, offset, total };
}

// Read-only audit query surface (issue #565). Both the Couch and in-memory
// stores implement this; the HTTP route depends only on the interface.
// Deliberately read-only: no write/update/delete — the append-only invariant
// (ADR-005) is preserved (this surface never mutates an entry).
export interface AuditRepository {
  query(query: AuditQuery): Promise<AuditQueryResult>;
}

// Retention surface consumed by the audit-retention purge sweep (issue #566).
// Kept SEPARATE from the read-only `AuditRepository` query surface so the read
// route's PerWorkspaceAuditRepository is not forced to expose a removal path:
// only the retention loop consumes this. Both concrete stores implement it
// (Couch for production, in-memory for the env-no-couch / dev / test path) so
// the sweep can drive whichever store the resolved stack surfaces. This is the
// structural superset of the sweep's injected `AuditRetentionStore`
// (src/pipeline/audit-retention-purge-sweep.ts).
export interface AuditRetentionRepository {
  // Oldest-first page of audit entries (ascending ULID / write order).
  listOldestPage(opts: { limit: number; offset?: number }): Promise<AuditEntry[]>;
  // Whole-entry expiry (never an in-place edit). True on a live removal.
  purgeEntry(id: string): Promise<boolean>;
}

// Append-only audit store over a dedicated CouchDB partition.
//
// Deliberately exposes ONLY `record` (write), `get`/`list` (read-back), and
// `query` (read-only query surface, issue #565). No update, no delete, no _rev
// carry-forward — consistent with ADR-005 append, never rewrite.
export class CouchAuditRepository implements AuditRepository, AuditRetentionRepository {
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

  // Enumerate one page of audit entries in oldest-first order (ascending ULID),
  // for the bounded retention sweep (issue #566). Retention purges the OLDEST
  // aged entries, so ascending order lets the sweep page from the tail forward
  // and stop as soon as it reaches entries inside the window. Mirrors the paged
  // `list({ status, limit, offset })` walk the archived-asset sweep drives
  // (listAllArchived, src/pipeline/archived-asset-purge-sweep.ts:195-215), but
  // over the audit partition via StackCouch.find (src/data/couchdb.ts:66) with a
  // skip/limit window. NOT the newest-first read-back `list` above — kept
  // separate so the read-back surface is untouched.
  async listOldestPage(opts: { limit: number; offset?: number }): Promise<AuditEntry[]> {
    const couch = this.couchFor();
    // CouchDB Mango `find` with no explicit `sort` scans the primary `_id`
    // index, so pages come back in ascending `_id` order; because every audit
    // `_id` is a time-sortable ULID (record(), above), that IS oldest-first, and
    // skip/limit paging is therefore globally consistent across pages. The
    // per-page sort below is a belt-and-braces normalisation of the returned
    // page and does not, on its own, guarantee cross-page order — the offset
    // walk depends on the store's ascending-`_id` scan.
    const docs = await couch.find(
      { resourceType: RESOURCE_TYPE },
      { limit: opts.limit, skip: opts.offset ?? 0 }
    );
    return docs
      .filter((d) => d.resourceType === RESOURCE_TYPE)
      .map(fromDoc)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  // Purge (expire) a single audit entry: WHOLE-ENTRY removal of its immutable
  // document, never an in-place edit. This is the ONLY removal path and exists
  // solely to enforce the retention window (issue #566) — it upholds
  // append-only-UNTIL-purge: an entry is either present verbatim or gone, never
  // rewritten. Delegates to StackCouch.remove (read _rev + destroy,
  // src/data/couchdb.ts:87-93). Returns true when a live audit entry was
  // removed, false when nothing matched (already gone / not an audit doc), so
  // the sweep can count purges exactly like the archived-asset sweep's `purge`
  // callback contract (purgeExpiredArchivedAssets, purgeOne step 5).
  async purgeEntry(id: string): Promise<boolean> {
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return false;
    }
    await couch.remove(id);
    return true;
  }

  // Read-only query surface for the audit read route (issue #565). Filters,
  // sorts newest-first, and paginates via `applyAuditQuery`. Pulls the audit
  // partition through `couch.find({ resourceType })` — the same read primitive
  // `list()` uses — with a bounded fetch cap, then filters/paginates in the
  // application layer so the wire contract does not leak the Mango selector.
  // Read-only: never writes, never mutates an entry (append-only, ADR-005).
  async query(query: AuditQuery): Promise<AuditQueryResult> {
    const couch = this.couchFor();
    const docs = await couch.find({ resourceType: RESOURCE_TYPE }, { limit: AUDIT_FETCH_CAP });
    const all = docs.filter((d) => d.resourceType === RESOURCE_TYPE).map(fromDoc);
    return applyAuditQuery(all, query);
  }
}

// Upper bound on how many entries the Couch query pulls before filtering. Kept
// generous but finite so a huge partition cannot produce an unbounded read; the
// `total` reported reflects entries within this cap. Consistent with the
// existing `list()` default fetch of 1000.
const AUDIT_FETCH_CAP = 10_000;

// In-memory audit store for local/dev and tests (mirrors the in-memory variants
// of the other repos, e.g. InMemoryCollectionRepository). Exposes `record` so
// tests can write entries directly (per #565 guidance — instrumentation #564 is
// not a build dependency) and the read-only `query` surface. Append-only: no
// update/delete path.
export class InMemoryAuditRepository implements AuditRepository, AuditRetentionRepository {
  private readonly entries: AuditEntry[] = [];

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
    this.entries.push(entry);
    return entry;
  }

  async query(query: AuditQuery): Promise<AuditQueryResult> {
    return applyAuditQuery(this.entries, query);
  }

  // Oldest-first page (ascending ULID / write order) for the retention sweep
  // (issue #566). Mirrors CouchAuditRepository.listOldestPage so the in-memory
  // env-no-couch / dev / test path drives the SAME sweep as production. Sorts a
  // copy — never mutates the backing array — then applies skip/limit.
  async listOldestPage(opts: { limit: number; offset?: number }): Promise<AuditEntry[]> {
    const oldestFirst = [...this.entries].sort((a, b) => a.id.localeCompare(b.id));
    const offset = opts.offset ?? 0;
    return oldestFirst.slice(offset, offset + opts.limit);
  }

  // Whole-entry expiry for the retention sweep (issue #566). Removes the single
  // matching entry outright (never an in-place edit), upholding
  // append-only-UNTIL-purge. Returns true when a live entry was removed, false
  // when nothing matched — matching CouchAuditRepository.purgeEntry's contract.
  async purgeEntry(id: string): Promise<boolean> {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) {
      return false;
    }
    this.entries.splice(idx, 1);
    return true;
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
