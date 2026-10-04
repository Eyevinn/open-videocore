// CouchDB job-repository concurrent-write safety (issue #451).
//
// Regression for: onEncodeDispatched silently fails to persist encodeAttemptLog
// while its sibling onDispatched (queued->running flip) succeeds in the SAME
// dispatch(). Root cause: appendEncodeAttempt / update did a raw
// couch.get -> couch.put carrying the just-read _rev. When the two writes race
// on the same document in one dispatch() (or a progress/reconcile write lands
// in between), CouchDB rejects the loser with a 409 `Document update conflict.`
// The scaler swallowed that error, so the dispatched job ended up with
// attempts:0 and no encodeAttemptLog field at all. The fix routes these
// read-modify-write methods through updateWithRetry, which refetches _rev and
// re-applies the (pure) patch on 409.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - CouchJobRepository(couchFor: () => StackCouch) with .create/.update/
//     .appendEncodeAttempt (src/data/couch-job-repo.ts).
//   - StackCouch.get(id) => Promise<StoredDoc | undefined>;
//     StackCouch.put(id, body) => Promise<{ id; rev }> (src/data/couchdb.ts).
//   - A nano 409 conflict is { statusCode: 409, error: 'conflict',
//     reason: 'Document update conflict.' } and updateWithRetry retries it
//     (src/data/couchdb.ts isUpdateConflict / updateWithRetry).
//   - Job.encodeAttempts?: number; Job.encodeAttemptLog?: EncodeAttempt[]
//     (src/data/job-repo.ts).

import { describe, it, expect } from 'vitest';

import { CouchJobRepository } from './couch-job-repo.js';
import type { StoredDoc, StackCouch } from './couchdb.js';

function conflictError(): Error {
  const err = new Error('Document update conflict.') as Error & {
    statusCode: number;
    error: string;
    reason: string;
  };
  err.statusCode = 409;
  err.error = 'conflict';
  err.reason = 'Document update conflict.';
  return err;
}

// A minimal in-memory StackCouch that models CouchDB optimistic concurrency:
// put() rejects with a 409 unless the body carries the document's CURRENT _rev,
// and bumps _rev on every accepted write. `injectRaceBeforeNextPut` lets a test
// simulate a concurrent writer bumping _rev between a caller's get and put,
// exactly reproducing the dispatch() race in issue #451.
function makeCouch(seed: StoredDoc): {
  couch: StackCouch;
  injectRaceBeforeNextPut: () => void;
  putAttempts: () => number;
} {
  let doc: StoredDoc = { ...seed };
  let revCounter = 1;
  let raceArmed = false;
  let putAttempts = 0;

  const bumpRev = (): string => {
    revCounter += 1;
    return `${revCounter}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const couch = {
    async get(id: string): Promise<StoredDoc | undefined> {
      if (id !== doc._id) return undefined;
      return { ...doc };
    },
    async put(id: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
      putAttempts += 1;
      // Simulate a concurrent writer that committed AFTER the caller read the
      // doc but BEFORE this put lands — the classic dispatch() sibling race.
      if (raceArmed) {
        raceArmed = false;
        doc = { ...doc, _rev: bumpRev() };
      }
      if (body['_rev'] !== doc._rev) {
        throw conflictError();
      }
      doc = { ...(body as StoredDoc), _id: id, _rev: bumpRev() };
      return { id, rev: doc._rev! };
    }
  } as unknown as StackCouch;

  return {
    couch,
    injectRaceBeforeNextPut: () => {
      raceArmed = true;
    },
    putAttempts: () => putAttempts
  };
}

const JOB_DOC: StoredDoc = {
  _id: 'job-abc123',
  _rev: '1-seed',
  resourceType: 'job',
  localId: 'job-abc123',
  type: 'transcode',
  status: 'queued',
  assetId: 'asset-1',
  sourceUrl: '',
  progress: 0,
  bytesTransferred: 0,
  attempts: 0,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z'
};

describe('CouchJobRepository concurrent-write safety (#451)', () => {
  it('appendEncodeAttempt survives a concurrent _rev bump instead of silently dropping', async () => {
    const { couch, injectRaceBeforeNextPut, putAttempts } = makeCouch(JOB_DOC);
    const repo = new CouchJobRepository(() => couch);

    // Reproduce the dispatch() race: a sibling write commits between this
    // method's get and put, so the first put hits a 409. Pre-fix this threw,
    // the scaler swallowed it, and the append was lost (attempts:0 / no log).
    injectRaceBeforeNextPut();
    const result = await repo.appendEncodeAttempt('job-abc123', { index: 1 });

    // The append must have landed durably, not been dropped.
    expect(result).toBeDefined();
    expect(result!.encodeAttempts).toBe(1);
    expect(result!.encodeAttemptLog).toHaveLength(1);
    expect(result!.encodeAttemptLog![0]).toMatchObject({ index: 1 });
    // It took a retry: one conflicting put + one winning put.
    expect(putAttempts()).toBe(2);

    // Read-back confirms it is persisted.
    const after = await repo.get('job-abc123');
    expect(after!.encodeAttemptLog).toHaveLength(1);
  });

  it('update (queued->running) survives a concurrent _rev bump', async () => {
    const { couch, injectRaceBeforeNextPut } = makeCouch(JOB_DOC);
    const repo = new CouchJobRepository(() => couch);

    injectRaceBeforeNextPut();
    const result = await repo.update('job-abc123', { status: 'running' });

    expect(result).toBeDefined();
    expect(result!.status).toBe('running');
  });

  it('the sibling writes in one dispatch() no longer clobber each other', async () => {
    // The two dispatch() callbacks run back-to-back against the same doc:
    // appendEncodeAttempt (encodeAttemptLog) THEN update (status). With the
    // retry wrapper both land; pre-fix the second read of a stale _rev could
    // 409 the append while the flip won.
    const { couch } = makeCouch(JOB_DOC);
    const repo = new CouchJobRepository(() => couch);

    await repo.appendEncodeAttempt('job-abc123', { index: 1 });
    await repo.update('job-abc123', { status: 'running' });

    const after = await repo.get('job-abc123');
    expect(after!.status).toBe('running');
    expect(after!.encodeAttempts).toBe(1);
    expect(after!.encodeAttemptLog).toHaveLength(1);
  });
});

// The drop-correction trace has to survive on the PRODUCTION backend, not just
// in memory (issue #1023): completeTranscode records `droppedThenRecovered` /
// `correctedDropError` on the job record so a corrected drop is traceable on
// every correction path, including the callback poller, which wires no audit
// emitter. That only holds if CouchJobRepository's document mapping carries the
// two fields in BOTH directions — toDoc (write) and fromDoc (read).
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - Job.droppedThenRecovered?: boolean; Job.correctedDropError?: string and
//     UpdateJobInput's matching members + UpdateJobInput.clearError
//     (src/data/job-repo.ts type Job / type UpdateJobInput / applyJobPatch).
//   - toDoc / fromDoc field lists (src/data/couch-job-repo.ts).
describe('CouchJobRepository drop-correction trace (#1023)', () => {
  const DROP_ERROR = 'dropped by Encore: gone from active set with no completion';

  it('round-trips the corrected-drop annotation through the document mapping', async () => {
    // A job settled `failed` by drop detection, as the conditional settle leaves it.
    const { couch } = makeCouch({
      ...JOB_DOC,
      status: 'failed',
      error: DROP_ERROR,
      droppedByScaler: true
    });
    const repo = new CouchJobRepository(() => couch);

    // Exactly the patch completeTranscode's success write issues when a genuine
    // SUCCESSFUL completion corrects a conditional drop.
    const corrected = await repo.update('job-abc123', {
      status: 'done',
      progress: 100,
      droppedByScaler: false,
      clearError: true,
      droppedThenRecovered: true,
      correctedDropError: DROP_ERROR
    });
    expect(corrected!.status).toBe('done');
    expect(corrected!.error).toBeUndefined();

    // Read back THROUGH the document mapping: a fresh fromDoc of what toDoc
    // persisted. Pre-fix both fields were absent from toDoc, so the trace was
    // written to the record in memory and then dropped on the way to disk.
    const after = await repo.get('job-abc123');
    expect(after!.droppedThenRecovered).toBe(true);
    expect(after!.correctedDropError).toBe(DROP_ERROR);
    // And the failure text really is gone from the persisted document.
    expect(after!.error).toBeUndefined();
  });

  it('leaves the annotation absent on a job that was never dropped', async () => {
    const { couch } = makeCouch(JOB_DOC);
    const repo = new CouchJobRepository(() => couch);

    await repo.update('job-abc123', { status: 'running' });
    await repo.update('job-abc123', { status: 'done', progress: 100, droppedByScaler: false, clearError: true });

    const after = await repo.get('job-abc123');
    expect(after!.droppedThenRecovered).toBeUndefined();
    expect(after!.correctedDropError).toBeUndefined();
  });
});
