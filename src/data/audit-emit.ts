// Best-effort audit emission helper (issue #564, parent #529).
//
// Instrumentation glue between the mutation call sites (assets/collections/jobs)
// and the append-only audit store's single write primitive
// `CouchAuditRepository.record()` (src/data/audit-repo.ts:101). This module owns
// exactly two concerns:
//
//   1. A NARROW structural interface (`AuditEmitter`) so call sites depend only
//      on `record()` — the one write method the store exposes — not the whole
//      repository. `CouchAuditRepository` satisfies it structurally, and tests
//      can pass a tiny fake.
//   2. A fire-and-forget wrapper (`emitAudit`) that guarantees a failed audit
//      write is LOGGED, never propagated (issue #564: emitting an audit entry
//      MUST NOT block or fail the primary operation).
//
// No HTTP surface, no query path — those are separate sub-issues. Callers pass a
// fully-populated `RecordAuditInput` (action/targetType/targetId/detail); this
// module never invents field values.

import type { RecordAuditInput } from './audit-repo.js';

// The single write capability a mutation call site needs. Structurally
// satisfied by CouchAuditRepository (its `record(input): Promise<AuditEntry>`),
// but deliberately narrowed to the write path so instrumentation cannot reach
// the read-back primitives. Optional at every call site: when no emitter is
// wired (e.g. an in-memory test that does not assert audit), emission is a
// no-op.
export interface AuditEmitter {
  record(input: RecordAuditInput): Promise<unknown>;
}

// A logger sink for failed audit writes. Matches the subset of the Fastify /
// pino logger surface used here so `request.log` / `app.log` can be passed
// directly without an adapter.
export interface AuditErrorLog {
  error(obj: unknown, msg?: string): void;
}

// The placeholder / origin actor used until #525 provides a real principal.
// `principalId` is null (no identity yet — the audit model reserves the field,
// src/data/audit-repo.ts:49-50) and `origin` is the coarse PROVENANCE_ACTORS
// value for the mutation source. Defaults to 'user' (an operator-driven API
// mutation); pipeline/callback paths pass 'system'.
export function originActor(
  origin: 'user' | 'system' | 'ai' = 'user'
): RecordAuditInput['actor'] {
  return { principalId: null, origin };
}

// Fire-and-forget audit emission. Emits exactly ONE entry via the emitter's
// `record()` and swallows any rejection, logging it instead of propagating, so
// no primary operation becomes newly failable (issue #564). Returns immediately;
// the write is detached. When `emitter` is undefined this is a no-op.
//
// Deliberately NOT awaited by callers: even a synchronous throw from `record()`
// (e.g. RecordAuditInputSchema.parse rejecting a bad targetType) is caught here
// via the promise chain, so a mis-populated entry can never surface as a request
// failure — it is logged for follow-up.
export function emitAudit(
  emitter: AuditEmitter | undefined,
  input: RecordAuditInput,
  log?: AuditErrorLog
): void {
  if (!emitter) {
    return;
  }
  void Promise.resolve()
    .then(() => emitter.record(input))
    .catch((err: unknown) => {
      log?.error(
        { err, action: input.action, targetType: input.targetType, targetId: input.targetId },
        'audit entry emission failed (non-fatal)'
      );
    });
}
