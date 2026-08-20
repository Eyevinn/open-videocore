import { describe, it, expect, vi } from 'vitest';

import { updateWithRetry, isUpdateConflict, type StoredDoc, type StackCouch } from './couchdb.js';

// A nano-shaped CouchDB update conflict (issue #278). This mirrors the real
// RequestError nano throws from db.insert on a stale write:
//   { statusCode: 409, error: 'conflict', reason: 'Document update conflict.' }
// (verified against node_modules/nano/lib/nano.d.ts RequestError).
function conflictError(): Error {
  const err = new Error('Document update conflict.') as Error & {
    statusCode: number;
    error: string;
    reason: string;
    scope: string;
  };
  err.statusCode = 409;
  err.error = 'conflict';
  err.reason = 'Document update conflict.';
  err.scope = 'couch';
  return err;
}

// A StackCouch test double: only get() and put() are exercised by
// updateWithRetry, so the rest of the surface is left unimplemented.
function fakeCouch(
  get: (id: string) => Promise<StoredDoc | undefined>,
  put: (id: string, body: Record<string, unknown>) => Promise<{ id: string; rev: string }>
): StackCouch {
  return { get, put } as unknown as StackCouch;
}

const ID = 'asset-123';

function docAtRev(rev: string): StoredDoc {
  return { _id: ID, _rev: rev, resourceType: 'asset' };
}

// No real timers: sleep resolves instantly so retries do not slow the suite.
const noSleep = async (): Promise<void> => undefined;

describe('isUpdateConflict', () => {
  it('detects the nano 409 update conflict on statusCode, error id, and reason', () => {
    expect(isUpdateConflict(conflictError())).toBe(true);
    expect(isUpdateConflict({ statusCode: 409 })).toBe(true);
    expect(isUpdateConflict({ error: 'conflict' })).toBe(true);
    expect(isUpdateConflict({ reason: 'Document update conflict.' })).toBe(true);
  });

  it('does not treat other errors as conflicts', () => {
    expect(isUpdateConflict(new Error('boom'))).toBe(false);
    expect(isUpdateConflict({ statusCode: 404, error: 'not_found' })).toBe(false);
    expect(isUpdateConflict({ statusCode: 500 })).toBe(false);
    expect(isUpdateConflict(null)).toBe(false);
    expect(isUpdateConflict(undefined)).toBe(false);
  });
});

describe('updateWithRetry', () => {
  it('succeeds on the first try when there is no conflict', async () => {
    const get = vi.fn(async () => docAtRev('1-aaa'));
    const put = vi.fn(async (_id: string, _body: Record<string, unknown>) => ({ id: ID, rev: '2-bbb' }));
    const patchFn = vi.fn((current: StoredDoc) => ({ ...current, name: 'renamed' }));

    const res = await updateWithRetry(fakeCouch(get, put), ID, patchFn, { sleep: noSleep });

    expect(res).toEqual({ id: ID, rev: '2-bbb' });
    expect(get).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    // The freshly-read _rev is carried into the write.
    expect(put.mock.calls[0][1]).toMatchObject({ _rev: '1-aaa', name: 'renamed' });
  });

  it('succeeds after N conflicts by refetching _rev and re-applying the patch', async () => {
    // Two conflicts, then success on the third attempt. Each retry must read a
    // fresh document (advancing _rev) and re-run patchFn against it.
    const revs = ['1-aaa', '2-bbb', '3-ccc'];
    let getCall = 0;
    const get = vi.fn(async () => docAtRev(revs[getCall++]));
    const put = vi
      .fn<(id: string, body: Record<string, unknown>) => Promise<{ id: string; rev: string }>>()
      .mockRejectedValueOnce(conflictError())
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: ID, rev: '4-ddd' });
    const patchFn = vi.fn((current: StoredDoc) => ({ ...current, name: 'renamed' }));

    const res = await updateWithRetry(fakeCouch(get, put), ID, patchFn, {
      maxAttempts: 5,
      sleep: noSleep
    });

    expect(res).toEqual({ id: ID, rev: '4-ddd' });
    // Three read/apply/write cycles: two conflicting, one successful.
    expect(get).toHaveBeenCalledTimes(3);
    expect(patchFn).toHaveBeenCalledTimes(3);
    expect(put).toHaveBeenCalledTimes(3);
    // The final, winning write carried the latest _rev, not the stale one.
    expect(put.mock.calls[2][1]).toMatchObject({ _rev: '3-ccc' });
  });

  it('throws the conflict after exhausting max attempts', async () => {
    const get = vi.fn(async () => docAtRev('1-aaa'));
    const put = vi.fn(async () => {
      throw conflictError();
    });
    const patchFn = vi.fn((current: StoredDoc) => ({ ...current }));

    await expect(
      updateWithRetry(fakeCouch(get, put), ID, patchFn, { maxAttempts: 3, sleep: noSleep })
    ).rejects.toMatchObject({ statusCode: 409, error: 'conflict' });

    // Exactly maxAttempts write attempts, no more.
    expect(put).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('passes non-conflict errors straight through without retrying', async () => {
    const get = vi.fn(async () => docAtRev('1-aaa'));
    const notFound = Object.assign(new Error('missing'), { statusCode: 404, error: 'not_found' });
    const put = vi.fn(async () => {
      throw notFound;
    });
    const patchFn = vi.fn((current: StoredDoc) => ({ ...current }));

    await expect(
      updateWithRetry(fakeCouch(get, put), ID, patchFn, { maxAttempts: 5, sleep: noSleep })
    ).rejects.toBe(notFound);

    // No retry on a non-conflict error: a single write attempt.
    expect(put).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the document does not exist', async () => {
    const get = vi.fn(async () => undefined);
    const put = vi.fn();
    const patchFn = vi.fn();

    const res = await updateWithRetry(fakeCouch(get, put), ID, patchFn, { sleep: noSleep });

    expect(res).toBeUndefined();
    expect(put).not.toHaveBeenCalled();
    expect(patchFn).not.toHaveBeenCalled();
  });
});
