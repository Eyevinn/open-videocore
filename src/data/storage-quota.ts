// Operator-configured total storage cap (issue #579, governed by ADR-020).
//
// ADR-020 Decision 1: the quota is a PER-DEPLOYMENT single-tenant cost
// guardrail. One deployed instance IS the tenant (src/auth/workspace.ts:5-17,
// DEPLOYMENT_CONTEXT at workspace.ts:41). There is NO per-request
// tenant/workspace dimension: the counter is a single instance-wide total keyed
// by DEPLOYMENT_CONTEXT.
//
// ADR-020 Decision 2: the source of truth for "bytes consumed" is an
// APP-MAINTAINED running total (a single counter keyed by DEPLOYMENT_CONTEXT),
// updated transactionally on storage-changing events. The authoritative
// per-object size is `statObject().size` (src/data/storage.ts:92-95) /
// `administrative.storage.sizeBytes` (src/data/asset-document.ts:284). We do NOT
// compute the total by streaming listObjectsV2 on the write hot path; a batch
// listObjectsV2-sum reconciliation sweep (off the hot path) corrects drift and
// re-establishes the total after a crash.
//
// Enforcement point (issue #579 scope decision): admission is a two-phase
// reserve/commit against the running total so the race between concurrent
// in-flight uploads is safe:
//
//   1. RESERVE at ingest admission — before bytes are accepted we atomically add
//      an estimated size to `reservedBytes` IFF (consumed + reserved + estimate)
//      <= cap. A reservation that would exceed the cap is rejected with
//      QuotaExceededError (HTTP 409, reason `quota_exceeded`) and no bytes are
//      written. Because the reservation is atomic (CouchDB compare-and-set via
//      updateWithRetry, or a synchronous in-memory add), two concurrent ingests
//      cannot both pass a check that only one has headroom for.
//   2. COMMIT on upload completion — when the real object size is known
//      (statObject().size), we release the reservation and add the TRUE size to
//      `consumedBytes`. On failure/abort we release the reservation without
//      committing, so abandoned uploads never permanently consume headroom.
//
// When no cap is configured (STORAGE_CAP_BYTES unset / <= 0) the guard is a pure
// pass-through: reserve/commit/release are recorded for observability but NEVER
// reject, so behaviour is identical to pre-#579 (opt-in, acceptance criterion).

import { DEPLOYMENT_CONTEXT } from '../auth/workspace.js';
import { updateWithRetry, type StackCouch } from './couchdb.js';

// Raised when an ingest reservation would push the running total past the
// configured cap. The ingest routes map this to HTTP 409 with a machine-readable
// `quota_exceeded` reason code (issue #579 acceptance criterion). 409 (not 413)
// is deliberate: 413 already means "this single payload is too large"
// (SourceTooLargeError, src/data/storage.ts:12-18); 409 Conflict communicates
// "the deployment's aggregate storage state conflicts with accepting more bytes",
// which is the accurate semantic for a total-cap breach.
export class QuotaExceededError extends Error {
  readonly statusCode = 409;
  readonly reason = 'quota_exceeded' as const;
  readonly capBytes: number;
  readonly consumedBytes: number;
  readonly requestedBytes: number;
  constructor(args: { capBytes: number; consumedBytes: number; requestedBytes: number }) {
    super(
      `storage quota exceeded: cap is ${args.capBytes} bytes, ` +
        `${args.consumedBytes} already reserved/consumed, ` +
        `request of ${args.requestedBytes} bytes would exceed it`
    );
    this.name = 'QuotaExceededError';
    this.capBytes = args.capBytes;
    this.consumedBytes = args.consumedBytes;
    this.requestedBytes = args.requestedBytes;
  }
}

// The document id of the single deployment-wide counter. Keyed by
// DEPLOYMENT_CONTEXT per ADR-020 Decision 1 — NOT derived from the request.
export function quotaCounterId(context: string = DEPLOYMENT_CONTEXT): string {
  return `storage-quota:${context}`;
}

// Resolve the operator-configured total storage cap in bytes (12-factor: config
// via env). Unset, non-numeric, or <= 0 all resolve to `undefined` (NO cap),
// which keeps behaviour identical to pre-#579 deployments — the cap is strictly
// opt-in. Mirrors the env-read convention in src/data/storage.ts:27-37 and
// src/routes/retention.ts:33-43.
export function storageCapBytesFromEnv(): number | undefined {
  const raw = process.env['STORAGE_CAP_BYTES'];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

// The persisted counter shape. `consumedBytes` is committed storage;
// `reservedBytes` is in-flight admission headroom that has not yet committed.
export type QuotaCounter = {
  consumedBytes: number;
  reservedBytes: number;
};

// The counter store. Implementations MUST make each mutation atomic w.r.t.
// concurrent callers so the reserve check is race-safe (ADR-020 Decision 2:
// "updated transactionally"). `reserve` is the single admission primitive: it
// atomically adds `bytes` to reservedBytes IFF the post-add total fits under
// `cap`, else it returns `{ ok: false }` without mutating. A `cap` of undefined
// means no cap — the reservation always succeeds (pass-through).
export interface StorageQuotaStore {
  // Atomically try to reserve `bytes` of headroom. Returns the resulting counter
  // on success; returns `{ ok: false, counter }` (unchanged) when the cap would
  // be exceeded. With `cap === undefined` always succeeds.
  reserve(
    bytes: number,
    cap: number | undefined
  ): Promise<{ ok: true; counter: QuotaCounter } | { ok: false; counter: QuotaCounter }>;
  // Commit a previously-reserved amount: move `reservedBytes -= reserved` and
  // `consumedBytes += actual`. `actual` is the TRUE object size (statObject) and
  // may differ from the reserved estimate. Idempotency is the caller's concern.
  commit(args: { reserved: number; actual: number }): Promise<QuotaCounter>;
  // Release a reservation that will not commit (upload failed/aborted).
  release(bytes: number): Promise<QuotaCounter>;
  // Apply a committed delta directly WITHOUT a prior reservation. Used for
  // storage-changing events that do not flow through the ingest admission path
  // (packaged-output write, rendition write, retention/deletion — ADR-020
  // Decision 2). A negative delta (deletion) floors consumedBytes at 0.
  applyDelta(deltaBytes: number): Promise<QuotaCounter>;
  // Read the current counter (for reconciliation + the future usage surface #581).
  read(): Promise<QuotaCounter>;
  // Overwrite the committed total after a reconciliation sweep re-establishes
  // ground truth. Leaves reservedBytes untouched (in-flight uploads are still
  // pending). Used by the reconciliation path (ADR-020 Decision 2 recovery).
  reconcile(consumedBytes: number): Promise<QuotaCounter>;
}

function clampNonNegative(n: number): number {
  return n > 0 ? n : 0;
}

// In-memory counter. Node runs this module single-threaded, so a synchronous
// read-check-write inside one async tick is atomic w.r.t. other callers (no
// await between the check and the mutation). Used for bare local runs and tests.
export class InMemoryStorageQuotaStore implements StorageQuotaStore {
  private consumedBytes: number;
  private reservedBytes: number;

  constructor(init: Partial<QuotaCounter> = {}) {
    this.consumedBytes = clampNonNegative(init.consumedBytes ?? 0);
    this.reservedBytes = clampNonNegative(init.reservedBytes ?? 0);
  }

  async reserve(
    bytes: number,
    cap: number | undefined
  ): Promise<{ ok: true; counter: QuotaCounter } | { ok: false; counter: QuotaCounter }> {
    const requested = clampNonNegative(bytes);
    // No-cap or non-positive request: pass-through (still track the reservation
    // so commit/release stay balanced).
    if (cap === undefined) {
      this.reservedBytes += requested;
      return { ok: true, counter: this.snapshot() };
    }
    const projected = this.consumedBytes + this.reservedBytes + requested;
    if (projected > cap) {
      return { ok: false, counter: this.snapshot() };
    }
    this.reservedBytes += requested;
    return { ok: true, counter: this.snapshot() };
  }

  async commit(args: { reserved: number; actual: number }): Promise<QuotaCounter> {
    this.reservedBytes = clampNonNegative(this.reservedBytes - clampNonNegative(args.reserved));
    this.consumedBytes = clampNonNegative(this.consumedBytes + clampNonNegative(args.actual));
    return this.snapshot();
  }

  async release(bytes: number): Promise<QuotaCounter> {
    this.reservedBytes = clampNonNegative(this.reservedBytes - clampNonNegative(bytes));
    return this.snapshot();
  }

  async applyDelta(deltaBytes: number): Promise<QuotaCounter> {
    this.consumedBytes = clampNonNegative(this.consumedBytes + deltaBytes);
    return this.snapshot();
  }

  async read(): Promise<QuotaCounter> {
    return this.snapshot();
  }

  async reconcile(consumedBytes: number): Promise<QuotaCounter> {
    this.consumedBytes = clampNonNegative(consumedBytes);
    return this.snapshot();
  }

  private snapshot(): QuotaCounter {
    return { consumedBytes: this.consumedBytes, reservedBytes: this.reservedBytes };
  }
}

// CouchDB-backed counter. Atomicity across processes/requests comes from
// CouchDB's MVCC: every mutation is a read-modify-write guarded by the
// document's `_rev` via updateWithRetry (src/data/couchdb.ts:171-203), so two
// concurrent reservations that race are serialized — the loser retries against
// the winner's new total and re-evaluates the cap. This is the transactional
// guarantee ADR-020 Decision 2 requires for the reserve check.
export class CouchStorageQuotaStore implements StorageQuotaStore {
  private readonly couch: StackCouch;
  private readonly id: string;

  constructor(couch: StackCouch, context: string = DEPLOYMENT_CONTEXT) {
    this.couch = couch;
    this.id = quotaCounterId(context);
  }

  private counterFrom(doc: Record<string, unknown> | undefined): QuotaCounter {
    return {
      consumedBytes: clampNonNegative(Number(doc?.['consumedBytes'] ?? 0)),
      reservedBytes: clampNonNegative(Number(doc?.['reservedBytes'] ?? 0))
    };
  }

  // Ensure the counter document exists so updateWithRetry (which returns
  // undefined for a missing doc) has something to mutate.
  private async ensure(): Promise<QuotaCounter> {
    const existing = await this.couch.get(this.id);
    if (existing) return this.counterFrom(existing);
    try {
      await this.couch.put(this.id, {
        resourceType: 'storage-quota',
        consumedBytes: 0,
        reservedBytes: 0
      });
    } catch {
      // A racing creator won; fall through to read the value it wrote.
    }
    const now = await this.couch.get(this.id);
    return this.counterFrom(now);
  }

  private async mutate(
    apply: (current: QuotaCounter) => QuotaCounter | { reject: true; counter: QuotaCounter }
  ): Promise<{ ok: boolean; counter: QuotaCounter }> {
    await this.ensure();
    let outcome: { ok: boolean; counter: QuotaCounter } = {
      ok: true,
      counter: { consumedBytes: 0, reservedBytes: 0 }
    };
    await updateWithRetry(this.couch, this.id, (current) => {
      const cur = this.counterFrom(current);
      const next = apply(cur);
      if ('reject' in next) {
        outcome = { ok: false, counter: next.counter };
        // Write the document back unchanged (keeps the _rev fresh; no-op delta).
        return {
          resourceType: 'storage-quota',
          consumedBytes: cur.consumedBytes,
          reservedBytes: cur.reservedBytes
        };
      }
      outcome = { ok: true, counter: next };
      return {
        resourceType: 'storage-quota',
        consumedBytes: next.consumedBytes,
        reservedBytes: next.reservedBytes
      };
    });
    return outcome;
  }

  async reserve(
    bytes: number,
    cap: number | undefined
  ): Promise<{ ok: true; counter: QuotaCounter } | { ok: false; counter: QuotaCounter }> {
    const requested = clampNonNegative(bytes);
    const result = await this.mutate((cur) => {
      if (cap === undefined) {
        return { consumedBytes: cur.consumedBytes, reservedBytes: cur.reservedBytes + requested };
      }
      const projected = cur.consumedBytes + cur.reservedBytes + requested;
      if (projected > cap) {
        return { reject: true, counter: cur };
      }
      return { consumedBytes: cur.consumedBytes, reservedBytes: cur.reservedBytes + requested };
    });
    return result.ok
      ? { ok: true, counter: result.counter }
      : { ok: false, counter: result.counter };
  }

  async commit(args: { reserved: number; actual: number }): Promise<QuotaCounter> {
    const { counter } = await this.mutate((cur) => ({
      reservedBytes: clampNonNegative(cur.reservedBytes - clampNonNegative(args.reserved)),
      consumedBytes: clampNonNegative(cur.consumedBytes + clampNonNegative(args.actual))
    }));
    return counter;
  }

  async release(bytes: number): Promise<QuotaCounter> {
    const { counter } = await this.mutate((cur) => ({
      consumedBytes: cur.consumedBytes,
      reservedBytes: clampNonNegative(cur.reservedBytes - clampNonNegative(bytes))
    }));
    return counter;
  }

  async applyDelta(deltaBytes: number): Promise<QuotaCounter> {
    const { counter } = await this.mutate((cur) => ({
      consumedBytes: clampNonNegative(cur.consumedBytes + deltaBytes),
      reservedBytes: cur.reservedBytes
    }));
    return counter;
  }

  async read(): Promise<QuotaCounter> {
    return this.ensure();
  }

  async reconcile(consumedBytes: number): Promise<QuotaCounter> {
    const { counter } = await this.mutate((cur) => ({
      consumedBytes: clampNonNegative(consumedBytes),
      reservedBytes: cur.reservedBytes
    }));
    return counter;
  }
}

// -------------------------------------------------------------------------
// Admission guard — the single object the ingest routes call.
// -------------------------------------------------------------------------

// How we size an ingest BEFORE its bytes are known. For proxied/streamed paths a
// Content-Length / totalBytes hint is usually present; when absent we cannot
// reserve a concrete amount, so we reserve 0 (admit) and rely on the per-path
// byte cap (SourceTooLargeError) plus the COMMIT-time true size to keep the
// running total honest. This means a cap can be momentarily overshot by a single
// unsized upload, which the reconciliation sweep corrects — an accepted
// trade-off documented in the ADR security/operational note.
export type QuotaGuardDeps = {
  store: StorageQuotaStore;
  // Resolve the live cap per call so a future runtime-config PATCH (mirroring
  // retention.ts) can hot-swap it. Defaults to the env read.
  capBytes?: () => number | undefined;
};

export class StorageQuotaGuard {
  private readonly store: StorageQuotaStore;
  private readonly capBytes: () => number | undefined;

  constructor(deps: QuotaGuardDeps) {
    this.store = deps.store;
    this.capBytes = deps.capBytes ?? storageCapBytesFromEnv;
  }

  // Current cap (undefined = no cap configured).
  cap(): number | undefined {
    return this.capBytes();
  }

  // Reserve headroom for an incoming ingest of `estimatedBytes`. Throws
  // QuotaExceededError (→ 409 quota_exceeded) when the cap would be exceeded.
  // Returns a handle whose `.commit(actualBytes)` / `.release()` finalize it.
  async admit(estimatedBytes: number): Promise<QuotaReservation> {
    const cap = this.capBytes();
    const reserved = Math.max(0, Math.floor(estimatedBytes || 0));
    const result = await this.store.reserve(reserved, cap);
    if (!result.ok) {
      throw new QuotaExceededError({
        capBytes: cap ?? 0,
        consumedBytes: result.counter.consumedBytes + result.counter.reservedBytes,
        requestedBytes: reserved
      });
    }
    return new QuotaReservation(this.store, reserved);
  }

  // Record a committed storage delta outside the ingest admission path
  // (packaged-output write, rendition write, retention/deletion). Never rejects.
  async recordDelta(deltaBytes: number): Promise<void> {
    await this.store.applyDelta(deltaBytes);
  }
}

// A handle to a live reservation. Exactly one of commit/release should be called.
export class QuotaReservation {
  private settled = false;
  constructor(
    private readonly store: StorageQuotaStore,
    private readonly reserved: number
  ) {}

  // Convert the reservation into committed bytes using the TRUE object size.
  async commit(actualBytes: number): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    await this.store.commit({ reserved: this.reserved, actual: Math.max(0, Math.floor(actualBytes || 0)) });
  }

  // Release the reservation without committing (upload failed/aborted).
  async release(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    await this.store.release(this.reserved);
  }
}
