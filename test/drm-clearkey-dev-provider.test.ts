// `clearkey-dev` key provider — unit tests (ADR-008 §10 "Clear-key adapter",
// §13 "Unit", Q5; issue #1260).
//
// NO CREDENTIAL, NO NETWORK: this adapter has no provider coordinates at all,
// so nothing here reads an environment credential or constructs a key-server
// URL. `NODE_ENV` is the only environment variable touched, and it is restored
// after every test.

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTENT_KEY_BYTES,
  ClearKeyDevNotAllowedError,
  ClearKeyDevProvider
} from '../src/drm/clearkey-dev-provider.js';
import { CLEAR_KEY_SYSTEM_ID } from '../src/drm/key-provider.js';
import type { KeyRequest } from '../src/drm/key-provider.js';

const REQUEST: KeyRequest = {
  contentId: '01K9ZP4V7R8HTQ2B6WMNXE3C5D',
  systems: [CLEAR_KEY_SYSTEM_ID],
  scheme: 'cbcs',
  trackGroups: ['AUDIO', 'SD', 'HD']
};

const originalNodeEnv = process.env['NODE_ENV'];

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = originalNodeEnv;
});

describe('clearkey-dev refuses to start in production', () => {
  it('throws at CONSTRUCTION time when NODE_ENV=production', () => {
    process.env['NODE_ENV'] = 'production';
    // Startup-time, not call-time (ADR-008 §10/Q5): a production process must
    // not be able to hold a usable instance at all, so the failure has to
    // happen where the provider is built, not where a key is requested.
    expect(() => new ClearKeyDevProvider()).toThrow(ClearKeyDevNotAllowedError);
    expect(() => new ClearKeyDevProvider({ id: 'primary' })).toThrow(
      /development-only|NODE_ENV=production/
    );
  });

  it('constructs in every non-production environment', () => {
    for (const value of ['development', 'test', 'staging', '']) {
      process.env['NODE_ENV'] = value;
      expect(new ClearKeyDevProvider().kind).toBe('clearkey-dev');
    }
    delete process.env['NODE_ENV'];
    expect(new ClearKeyDevProvider().kind).toBe('clearkey-dev');
  });

  it('reports the protocol as its kind, never a vendor', () => {
    // CLAUDE.md rule 1 / ADR-008 D1: one adapter per protocol.
    expect(new ClearKeyDevProvider().kind).toBe('clearkey-dev');
    expect(new ClearKeyDevProvider().id).toBe('primary');
    expect(new ClearKeyDevProvider({ id: 'local' }).id).toBe('local');
  });
});

describe('clearkey-dev acquire()', () => {
  const provider = () => new ClearKeyDevProvider();

  it('returns one 16-byte key per requested track group', async () => {
    const { keys } = await provider().acquire(REQUEST, AbortSignal.timeout(1_000));
    expect(keys.map((k) => k.trackGroup)).toEqual(['AUDIO', 'SD', 'HD']);
    for (const key of keys) {
      expect(key.key).toBeInstanceOf(Uint8Array);
      expect(key.key.length).toBe(16);
      expect(key.key.length).toBe(CONTENT_KEY_BYTES);
      expect(key.keyId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    }
  });

  it('marks its signalling as development material', async () => {
    const { signalling } = await provider().acquire(REQUEST, AbortSignal.timeout(1_000));
    // The load-bearing assertion (ADR-008 §10): a development stream must never
    // be mistakable for protected content.
    expect(signalling.dev).toBe(true);
    expect(signalling.pssh).toEqual({});
    expect(signalling.licenceUrls).toEqual({});
    expect(signalling.certificateUrl).toBeUndefined();
  });

  it('maps a configured local licence endpoint onto its system ids', async () => {
    const custom = '11111111-2222-3333-4444-555555555555';
    const { signalling } = await new ClearKeyDevProvider({
      systemIds: [custom],
      licenceUrl: 'http://localhost:8080/clearkey'
    }).acquire(REQUEST, AbortSignal.timeout(1_000));
    expect(signalling.licenceUrls).toEqual({ [custom]: 'http://localhost:8080/clearkey' });
    expect(signalling.dev).toBe(true);
  });

  it('generates distinct keys per group and per call', async () => {
    const hex = (k: Uint8Array) => Buffer.from(k).toString('hex');
    const first = await provider().acquire(REQUEST, AbortSignal.timeout(1_000));
    const second = await provider().acquire(REQUEST, AbortSignal.timeout(1_000));
    const all = [...first.keys, ...second.keys].map((k) => hex(k.key));
    expect(new Set(all).size).toBe(all.length);
    const kids = [...first.keys, ...second.keys].map((k) => k.keyId);
    expect(new Set(kids).size).toBe(kids.length);
  });

  it('reuses pinned key ids so a re-package keeps the published manifest valid', async () => {
    const pinned = '6f1d0a7c-6d9e-4e7a-9a3c-1f2b4d5e6a70';
    const { keys } = await provider().acquire(
      { ...REQUEST, trackGroups: ['HD'], keyIds: { HD: pinned } },
      AbortSignal.timeout(1_000)
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]!.keyId).toBe(pinned);
  });

  it('honours an aborted signal like a remote adapter would', async () => {
    await expect(
      provider().acquire(REQUEST, AbortSignal.abort())
    ).rejects.toThrow();
  });

  it('leaks no key material through serialisation of the signalling', async () => {
    // ADR-008 D4/§10: `DrmSignalling` is the part that reaches a repository, a
    // log and an HTTP response, so it must carry no key bytes. (The repo-wide
    // `drm-no-key-leak` test over every serialisation boundary is its own
    // ticket; this is the adapter-local guarantee.)
    const { keys, signalling } = await provider().acquire(
      REQUEST,
      AbortSignal.timeout(1_000)
    );
    const serialised = JSON.stringify(signalling);
    expect(serialised).not.toContain('key');
    for (const key of keys) {
      expect(serialised).not.toContain(Buffer.from(key.key).toString('base64'));
      expect(serialised).not.toContain(Buffer.from(key.key).toString('hex'));
    }
  });
});
