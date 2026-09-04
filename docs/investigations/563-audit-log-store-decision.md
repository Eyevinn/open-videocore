# Decision note — audit-log entry store (issue #563)

**Status:** accepted
**Scope:** backend-only persistence foundation for the audit/activity log surface
(parent #529). No HTTP surface, no query API, no call-site instrumentation.

## Decision

Back the audit log with the **existing CouchDB store as a dedicated append-only
partition** (documents carrying `resourceType: 'audit-entry'`), following the same
document-shape + connection pattern the asset/collection repositories use. **Reject**
reuse of the in-memory `LogStore` in `src/services/log-store.ts`.

## Candidates evaluated (contract-first)

### Candidate 2 — reuse `src/services/log-store.ts` (rejected)

Read in full. Verified signatures:

- `class LogStore` — `src/services/log-store.ts:105`.
- `append(input: AppendLogInput): LogRecord` — `src/services/log-store.ts:112`.
- `AppendLogInput = { message: string; level?: LogLevel; category?: string; timestamp?: string }`
  — `src/services/log-store.ts:43-48`.
- `LogRecord = { seq: number; timestamp: string; message: string; level?; category? }`
  — `src/services/log-store.ts:33-39`.
- Backing storage: `private readonly records: LogRecord[] = []` — `src/services/log-store.ts:109`.

Rejected for two independent reasons:

1. **Not durable.** The file header states plainly it is an *in-memory* store and
   "There is no persistent log store in the repo today" (`src/services/log-store.ts:1-10`);
   the records live in a process-local array (`:109`). An audit trail must survive
   process restarts, so an in-memory store is the wrong durability tier.
2. **Wrong schema.** `LogRecord` models a free-text operational stream
   (`message`/`level`/`category`, `:33-39`). It has no `actor`, `action`, `targetType`,
   or `targetId`. Bending the audit model onto `message`+`category` would lose the
   structured, queryable shape the parent surface (#529) needs and could not enforce a
   `targetType` enum.

### Candidate 1 — CouchDB append-only partition (accepted)

Verified contract:

- Per-tenant CouchDB connection: `class StackCouch` — `src/data/couchdb.ts:22`; obtained
  via a `CouchFactory = () => StackCouch` injected into repos
  (`src/data/couch-collection-repo.ts:22-25`).
- Write primitive: `StackCouch.put(localId, body)` — `src/data/couchdb.ts:29`.
- Read primitives: `StackCouch.get(localId)` — `src/data/couchdb.ts:39`;
  `StackCouch.find(selector, opts)` — `src/data/couchdb.ts:66`.
- Document-shape pattern (a `resourceType` discriminator + `localId` + flat body):
  `src/data/couch-collection-repo.ts:98-107`.
- Tenant isolation is structural — one CouchDB per tenant, no workspace partitioning
  (`src/data/couchdb.ts:1-7`).

Chosen because it is durable, per-tenant isolated, and lets us follow the existing
repository pattern exactly (new `resourceType`, one document per entry).

## Append-only semantics (ADR-005)

Aligned to the ADR-005 principle stated in code: "append the audit entry, never rewrite
history" — `src/data/couch-asset-repo.ts:362` (see also `src/data/asset-repo.ts:594,620`).
Each audit entry is a distinct immutable document minted with a fresh id. The service
exposes **only** a write primitive (`record`) plus a read-back primitive (`get`/`list`)
used by tests; it deliberately exposes **no** update or delete path, and never carries a
`_rev` forward, so an existing entry document can never be overwritten by application code.

## Actor field — forward-compatible cut

Real principal identity depends on #525; current auth is a presence-only gate with no
principal. For this cut `actor` is:

- `origin`: the pre-existing coarse enum `PROVENANCE_ACTORS` (`['user','system','ai']`)
  — imported from `src/data/asset-repo.ts:99-100`, NOT redefined.
- `principalId`: a nullable placeholder (`string | null`), to be enriched once #525 lands.

This keeps the enum single-sourced and lets identity be filled in later without a schema
break.
