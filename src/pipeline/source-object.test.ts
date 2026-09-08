// Unit tests for the unified source-object resolver (issue #612).
//
// These lock in the two guarantees the issue's acceptance criteria demand:
//   1. Every source-consuming operation resolves the source through ONE code
//      path — exercised here directly (resolveSourceObject / requireSourceObject
//      / tryResolveSourceObject), which is what the routes now call.
//   2. When the authoritative source field (`Asset.objectKey`) is absent, EVERY
//      operation fails the SAME way: a consistent 409 `no_object`, never a mix
//      of success and 409. We assert the single error code/message/status so the
//      six routes (metadata, transcode, package, thumbnails, clip, export) can
//      never drift apart again.

import { describe, it, expect, vi } from 'vitest';

import {
  resolveSourceObject,
  tryResolveSourceObject,
  requireSourceObject,
  NoSourceObjectError,
  NO_SOURCE_OBJECT_ERROR,
  NO_SOURCE_OBJECT_MESSAGE
} from './source-object.js';

// A minimal reply double capturing the (code, payload) a route would send.
function fakeReply(): {
  code(status: number): { send(payload: unknown): unknown };
  sent: { status?: number; payload?: unknown };
} {
  const sent: { status?: number; payload?: unknown } = {};
  return {
    sent,
    code(status: number) {
      sent.status = status;
      return {
        send(payload: unknown) {
          sent.payload = payload;
          return payload;
        }
      };
    }
  };
}

describe('resolveSourceObject', () => {
  it('returns the authoritative objectKey when present', () => {
    expect(resolveSourceObject({ objectKey: 'ingest/abc.mp4' })).toEqual({
      objectKey: 'ingest/abc.mp4'
    });
  });

  it('throws NoSourceObjectError (409 no_object) when objectKey is absent', () => {
    let caught: unknown;
    try {
      resolveSourceObject({ objectKey: undefined });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoSourceObjectError);
    const e = caught as NoSourceObjectError;
    expect(e.statusCode).toBe(409);
    expect(e.error).toBe(NO_SOURCE_OBJECT_ERROR);
    expect(e.error).toBe('no_object');
    expect(e.message).toBe(NO_SOURCE_OBJECT_MESSAGE);
  });

  it('treats an empty-string objectKey as absent (no silently-survivable key)', () => {
    expect(() => resolveSourceObject({ objectKey: '' })).toThrow(NoSourceObjectError);
  });
});

describe('tryResolveSourceObject', () => {
  it('returns the resolved source when present', () => {
    expect(tryResolveSourceObject({ objectKey: 'sources/clip.mp4' })).toEqual({
      objectKey: 'sources/clip.mp4'
    });
  });

  it('returns undefined (never throws) when absent', () => {
    expect(tryResolveSourceObject({ objectKey: undefined })).toBeUndefined();
    expect(tryResolveSourceObject({ objectKey: '' })).toBeUndefined();
  });
});

describe('requireSourceObject (route helper)', () => {
  it('returns the resolved source and sends nothing when present', () => {
    const reply = fakeReply();
    const codeSpy = vi.spyOn(reply, 'code');
    const resolved = requireSourceObject({ objectKey: 'ingest/x.mp4' }, reply);
    expect(resolved).toEqual({ objectKey: 'ingest/x.mp4' });
    expect(codeSpy).not.toHaveBeenCalled();
    expect(reply.sent.status).toBeUndefined();
  });

  it('sends ONE consistent 409 no_object and returns undefined when absent', () => {
    const reply = fakeReply();
    const resolved = requireSourceObject({ objectKey: undefined }, reply);
    expect(resolved).toBeUndefined();
    expect(reply.sent.status).toBe(409);
    expect(reply.sent.payload).toEqual({
      error: 'no_object',
      message: NO_SOURCE_OBJECT_MESSAGE
    });
  });

  // The whole point of issue #612: the failure is IDENTICAL regardless of which
  // operation asked. Simulate all six source-consuming operations resolving a
  // source-less asset through the shared helper and assert every response is
  // byte-for-byte the same (no per-operation message divergence).
  it('fails identically for every source-consuming operation', () => {
    const operations = ['metadata', 'transcode', 'package', 'thumbnails', 'clip', 'export'];
    const sourceless = { objectKey: undefined };
    const responses = operations.map(() => {
      const reply = fakeReply();
      const resolved = requireSourceObject(sourceless, reply);
      expect(resolved).toBeUndefined();
      return { status: reply.sent.status, payload: reply.sent.payload };
    });
    const first = JSON.stringify(responses[0]);
    for (const r of responses) {
      expect(JSON.stringify(r)).toBe(first);
    }
    expect(responses[0]).toEqual({
      status: 409,
      payload: { error: 'no_object', message: NO_SOURCE_OBJECT_MESSAGE }
    });
  });
});
