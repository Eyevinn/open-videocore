// `cpix` key provider HTTPS transport — integration tests against a LOCAL CPIX
// stub (ADR-008 §12 the failure table, §10 logging/redaction, §13
// "Integration (no live provider): A local CPIX stub server exercising success,
// 401, 5xx, timeout and malformed-XML paths. The stub is own code (a Fastify
// route in the test tree), not a dependency."; issue #1261).
//
// NO EXTERNAL ENDPOINT AND NO CREDENTIAL IS REQUIRED OR USED. The stub is a
// Fastify app (already a runtime dependency) listening on 127.0.0.1 with an
// ephemeral port, and every credential below is a literal written in this file.
//
// WHY THE TRANSPORT SEAM IS INJECTED. `keyServerUrl` must be `https:` and that
// is enforced in the constructor (issue #1261), while a loopback stub has no
// TLS certificate — generating one would need a dependency the ADR does not
// admit (ADR-008 §11 adds exactly one dependency, the XML parser). So the
// provider is configured with its real `https:` URL and the test supplies a
// `CpixHttpTransport` that forwards the SAME method, headers, body and
// AbortSignal to the loopback stub. Real sockets, real HTTP statuses, real
// timeouts and real retries; only the TLS layer is absent. Everything the
// tests assert — retry counts, status classification, size cap, error codes,
// log fields — lives ABOVE that seam in src/drm/cpix-provider.ts.
//
// CONTRACT SOURCES: src/drm/key-provider.ts (`KeyProvider`, `KeyRequest`),
// src/drm/cpix-provider.ts (`CpixHttpTransport`, the env var names of
// ADR-008 §5.2), src/types/drm.ts (`DRM_ERROR_CODES`), and the CPIX/PSKC
// schemas cited in src/drm/cpix-response.ts for the stub's response document.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CpixProvider,
  ENV_CLIENT_CERT,
  ENV_CLIENT_KEY,
  ENV_PASSWORD,
  ENV_TOKEN,
  ENV_USERNAME,
  type CpixHttpRequest,
  type CpixHttpTransport,
  type CpixLogger
} from '../src/drm/cpix-provider.js';
import { MAX_CPIX_RESPONSE_BYTES, NS_CPIX, NS_PSKC } from '../src/drm/cpix-response.js';
import { KeyProviderError } from '../src/drm/key-provider-error.js';
import type { KeyRequest } from '../src/drm/key-provider.js';

const SYSTEM_ID_A = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const KID_HD = '8b3f2c9e-8fb0-4a9c-9c5e-3b4d6f708c92';

// The stub's key material. A literal in a test file, never a real key.
const STUB_KEY_BASE64 = Buffer.from('0123456789abcdef', 'utf8').toString('base64');
// What the stub puts in a 4xx/5xx body. The log-redaction test asserts this
// string reaches no log line and no error message (ADR-008 §10).
const PROVIDER_ERROR_BODY = 'PROVIDER-ERROR-BODY-WITH-credential-AND-key-material';

const KEY_REQUEST: KeyRequest = {
  contentId: '01K9ZP4V7R8HTQ2B6WMNXE3C5D',
  systems: [SYSTEM_ID_A],
  scheme: 'cbcs',
  trackGroups: ['HD'],
  // Pinned so the stub can answer with the same kid (ADR-008 §6
  // "Idempotency" is what makes this legal).
  keyIds: { HD: KID_HD }
};

function validCpix(kid = KID_HD): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cpix:CPIX contentId="${KEY_REQUEST.contentId}" version="2.3" xmlns:cpix="${NS_CPIX}" xmlns:pskc="${NS_PSKC}">
  <cpix:ContentKeyList>
    <cpix:ContentKey kid="${kid}" commonEncryptionScheme="cbcs">
      <cpix:Data><pskc:Secret><pskc:PlainValue>${STUB_KEY_BASE64}</pskc:PlainValue></pskc:Secret></cpix:Data>
    </cpix:ContentKey>
  </cpix:ContentKeyList>
  <cpix:DRMSystemList>
    <cpix:DRMSystem kid="${kid}" systemId="${SYSTEM_ID_A}">
      <cpix:PSSH>${Buffer.from('pssh-box-bytes-a', 'utf8').toString('base64')}</cpix:PSSH>
    </cpix:DRMSystem>
  </cpix:DRMSystemList>
</cpix:CPIX>
`;
}

// ---------------------------------------------------------------------------
// The local CPIX stub (own code, no new dependency — ADR-008 §13)
// ---------------------------------------------------------------------------

type StubRecord = {
  requests: { headers: Record<string, string | string[] | undefined>; body: string }[];
};

type Stub = {
  app: FastifyInstance;
  baseUrl: string;
  record: StubRecord;
  release: () => void;
};

// `mode` decides how the one route behaves, so a single stub covers the whole
// ADR-008 §12 failure table.
type StubMode = 'ok' | 'unauthorized' | 'server-error' | 'hang' | 'malformed' | 'oversized';

async function startStub(mode: StubMode): Promise<Stub> {
  const app = Fastify();
  const record: StubRecord = { requests: [] };
  // The provider posts `application/xml` (ADR-008 §6 step 4); Fastify has no
  // built-in parser for it, and without this the stub would answer 415 and the
  // test would be asserting the wrong thing.
  app.addContentTypeParser('application/xml', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  // Resolvers for the `hang` mode, so `app.close()` never waits on a request
  // this test deliberately left unanswered.
  const held: (() => void)[] = [];

  app.post('/cpix', async (request, reply) => {
    record.requests.push({ headers: request.headers, body: String(request.body ?? '') });
    switch (mode) {
      case 'ok':
        return reply.type('application/xml').send(validCpix());
      case 'unauthorized':
        return reply.code(401).type('text/plain').send(PROVIDER_ERROR_BODY);
      case 'server-error':
        return reply.code(503).type('text/plain').send(PROVIDER_ERROR_BODY);
      case 'malformed':
        // Well-formed prefix, truncated document — the shape a proxy or a
        // half-written response actually produces.
        return reply
          .type('application/xml')
          .send(validCpix().replace('</cpix:CPIX>', ''));
      case 'oversized':
        return reply
          .type('application/xml')
          .send(validCpix().replace(STUB_KEY_BASE64, 'A'.repeat(MAX_CPIX_RESPONSE_BYTES + 1)));
      case 'hang':
        // Never answers within the attempt budget.
        await new Promise<void>((resolve) => {
          held.push(resolve);
        });
        return reply.code(204).send();
    }
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('stub did not bind a port');
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    record,
    release: () => {
      for (const resolve of held.splice(0)) resolve();
    }
  };
}

// The seam described in the file header: forward the provider's request to the
// loopback stub unchanged.
function loopbackTransport(
  stub: Stub,
  seen: CpixHttpRequest[] = []
): { transport: CpixHttpTransport; seen: CpixHttpRequest[] } {
  const transport: CpixHttpTransport = async (req) => {
    seen.push(req);
    const res = await fetch(`${stub.baseUrl}/cpix`, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: req.signal
    });
    return { status: res.status, body: await res.text() };
  };
  return { transport, seen };
}

function recordingLogger(): { log: CpixLogger; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    log: {
      info: (obj, msg) => calls.push({ obj, msg }),
      warn: (obj, msg) => calls.push({ obj, msg })
    }
  };
}

const KEY_SERVER_URL = 'https://key-provider.invalid/cpix';

// Deterministic, instant retries: zero jitter and a no-op sleep, so a test
// asserting "three attempts" does not also wait out two real backoffs.
const FAST_RETRY = {
  backoffBaseMs: 1,
  random: () => 0,
  sleep: async (): Promise<void> => {}
};

let openStubs: Stub[] = [];

async function stubFor(mode: StubMode): Promise<Stub> {
  const stub = await startStub(mode);
  openStubs.push(stub);
  return stub;
}

afterEach(async () => {
  for (const stub of openStubs) {
    stub.release();
    await stub.app.close();
  }
  openStubs = [];
});

async function failureOf(promise: Promise<unknown>): Promise<KeyProviderError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(KeyProviderError);
  return error as KeyProviderError;
}

describe('cpix provider — construction (ADR-008 §10 "Transport")', () => {
  it('refuses a non-https key server url at construction, not at call time', () => {
    expect(
      () =>
        new CpixProvider({
          keyServerUrl: 'http://key-provider.invalid/cpix',
          spekeVersion: '2.0',
          authMode: 'bearer'
        })
    ).toThrow(KeyProviderError);
  });

  it('refuses a key server url that is not a url at all', () => {
    expect(
      () =>
        new CpixProvider({
          keyServerUrl: 'key-provider.invalid/cpix',
          spekeVersion: '2.0',
          authMode: 'bearer'
        })
    ).toThrow(KeyProviderError);
  });

  it('accepts an https key server url and reports the protocol as its kind', () => {
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'bearer'
    });

    expect(provider.kind).toBe('cpix');
    expect(provider.id).toBe('primary');
  });
});

describe('cpix provider — local CPIX stub (ADR-008 §13)', () => {
  it('200 valid CPIX: returns the keys, the signalling and the configured licence urls', async () => {
    const stub = await stubFor('ok');
    const { transport } = loopbackTransport(stub);
    const { log, calls } = recordingLogger();
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'basic',
      env: { [ENV_USERNAME]: 'stub-user', [ENV_PASSWORD]: 'stub-password' },
      licenceUrls: { [SYSTEM_ID_A]: 'https://licence.invalid/acquire' },
      certificateUrl: 'https://licence.invalid/app.cer',
      transport,
      log
    });

    const { keys, signalling } = await provider.acquire(KEY_REQUEST, new AbortController().signal);

    expect(keys).toHaveLength(1);
    expect(keys[0].keyId).toBe(KID_HD);
    expect(Buffer.from(keys[0].key).toString('base64')).toBe(STUB_KEY_BASE64);
    expect(signalling.pssh[SYSTEM_ID_A]).toBeDefined();
    // Licence/certificate URLs are configuration, not response data
    // (ADR-008 §5.2).
    expect(signalling.licenceUrls).toEqual({ [SYSTEM_ID_A]: 'https://licence.invalid/acquire' });
    expect(signalling.certificateUrl).toBe('https://licence.invalid/app.cer');
    // One request, one success log line.
    expect(stub.record.requests).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('posts the built CPIX document as application/xml with Basic credentials', async () => {
    const stub = await stubFor('ok');
    const { transport } = loopbackTransport(stub);
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'basic',
      env: { [ENV_USERNAME]: 'stub-user', [ENV_PASSWORD]: 'stub-password' },
      transport
    });

    await provider.acquire(KEY_REQUEST, new AbortController().signal);

    const received = stub.record.requests[0];
    expect(received.headers['content-type']).toContain('application/xml');
    // RFC 7617 `Basic` credentials built from the ADR-008 §5.2 env vars.
    expect(received.headers['authorization']).toBe(
      `Basic ${Buffer.from('stub-user:stub-password', 'utf8').toString('base64')}`
    );
    expect(received.body).toContain('<cpix:CPIX');
    expect(received.body).toContain(KID_HD);
  });

  it('sends a Bearer credential in bearer mode', async () => {
    const stub = await stubFor('ok');
    const { transport } = loopbackTransport(stub);
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'bearer',
      env: { [ENV_TOKEN]: 'stub-token' },
      transport
    });

    await provider.acquire(KEY_REQUEST, new AbortController().signal);

    expect(stub.record.requests[0].headers['authorization']).toBe('Bearer stub-token');
  });

  it('mtls mode sends no Authorization header and carries the client PEMs on the transport', async () => {
    const stub = await stubFor('ok');
    const { transport, seen } = loopbackTransport(stub);
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'mtls',
      env: {
        // Inline PEM form. The path form is covered below.
        [ENV_CLIENT_CERT]: '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----',
        [ENV_CLIENT_KEY]: '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----'
      },
      transport
    });

    await provider.acquire(KEY_REQUEST, new AbortController().signal);

    expect(stub.record.requests[0].headers['authorization']).toBeUndefined();
    expect(seen[0].clientCert?.cert).toContain('BEGIN CERTIFICATE');
    expect(seen[0].clientCert?.key).toContain('BEGIN PRIVATE KEY');
  });

  it('mtls mode reads a PEM given as a path', async () => {
    const stub = await stubFor('ok');
    const { transport, seen } = loopbackTransport(stub);
    const readPem = vi.fn(async (path: string) => `-----BEGIN X-----\nfrom:${path}\n-----END X-----`);
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'mtls',
      env: {
        [ENV_CLIENT_CERT]: '/run/secrets/client.crt',
        [ENV_CLIENT_KEY]: '/run/secrets/client.key'
      },
      readPem,
      transport
    });

    await provider.acquire(KEY_REQUEST, new AbortController().signal);

    expect(readPem).toHaveBeenCalledTimes(2);
    expect(seen[0].clientCert?.cert).toContain('/run/secrets/client.crt');
  });

  it('401: no retry, key_provider_rejected', async () => {
    const stub = await stubFor('unauthorized');
    const { transport } = loopbackTransport(stub);
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'bearer',
      env: { [ENV_TOKEN]: 'stub-token' },
      transport,
      ...FAST_RETRY
    });

    const error = await failureOf(provider.acquire(KEY_REQUEST, new AbortController().signal));

    expect(error.errorCode).toBe('key_provider_rejected');
    // ADR-008 §12: a 4xx is a credential/policy verdict — exactly one request.
    expect(stub.record.requests).toHaveLength(1);
    expect(error.message).not.toContain(PROVIDER_ERROR_BODY);
  });

  it('5xx: retried up to 3 attempts, then key_provider_unreachable', async () => {
    const stub = await stubFor('server-error');
    const { transport } = loopbackTransport(stub);
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'bearer',
      env: { [ENV_TOKEN]: 'stub-token' },
      transport,
      ...FAST_RETRY
    });

    const error = await failureOf(provider.acquire(KEY_REQUEST, new AbortController().signal));

    expect(error.errorCode).toBe('key_provider_unreachable');
    expect(stub.record.requests).toHaveLength(3);
    expect(error.attempts).toBe(3);
  });

  it('timeout: retried, then key_provider_unreachable', async () => {
    const stub = await stubFor('hang');
    const { transport } = loopbackTransport(stub);
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'bearer',
      env: { [ENV_TOKEN]: 'stub-token' },
      transport,
      // A short per-attempt bound inside a short whole-step deadline: the same
      // policy shape as ADR-008 §12's 60 s, scaled so the test is fast.
      attemptTimeoutMs: 50,
      deadlineMs: 2_000,
      ...FAST_RETRY
    });

    const error = await failureOf(provider.acquire(KEY_REQUEST, new AbortController().signal));

    expect(error.errorCode).toBe('key_provider_unreachable');
    expect(stub.record.requests).toHaveLength(3);
  });

  it('malformed XML: no retry, key_provider_invalid_response', async () => {
    const stub = await stubFor('malformed');
    const { transport } = loopbackTransport(stub);
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'bearer',
      env: { [ENV_TOKEN]: 'stub-token' },
      transport,
      ...FAST_RETRY
    });

    const error = await failureOf(provider.acquire(KEY_REQUEST, new AbortController().signal));

    expect(error.errorCode).toBe('key_provider_invalid_response');
    // ADR-008 §12: the same request would produce the same document.
    expect(stub.record.requests).toHaveLength(1);
  });

  it('a response larger than 256 KiB is rejected without the parser being called', async () => {
    const stub = await stubFor('oversized');
    const { transport } = loopbackTransport(stub);
    const parseXml = vi.fn(() => {
      throw new Error('the parser must not be reached');
    });
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'bearer',
      env: { [ENV_TOKEN]: 'stub-token' },
      transport,
      parseDeps: { parseXml },
      ...FAST_RETRY
    });

    const error = await failureOf(provider.acquire(KEY_REQUEST, new AbortController().signal));

    expect(error.errorCode).toBe('key_provider_invalid_response');
    expect(parseXml).not.toHaveBeenCalled();
    expect(stub.record.requests).toHaveLength(1);
  });

  it('a missing credential fails as drm_not_configured before any request is made', async () => {
    const stub = await stubFor('ok');
    const { transport } = loopbackTransport(stub);
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'basic',
      env: {},
      transport
    });

    const error = await failureOf(provider.acquire(KEY_REQUEST, new AbortController().signal));

    expect(error.errorCode).toBe('drm_not_configured');
    expect(stub.record.requests).toHaveLength(0);
  });

  it('an already-aborted caller signal makes no request', async () => {
    const stub = await stubFor('ok');
    const { transport } = loopbackTransport(stub);
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'bearer',
      env: { [ENV_TOKEN]: 'stub-token' },
      transport
    });
    const controller = new AbortController();
    controller.abort();

    await expect(provider.acquire(KEY_REQUEST, controller.signal)).rejects.toThrow();

    expect(stub.record.requests).toHaveLength(0);
  });
});

describe('cpix provider — logging and redaction (ADR-008 §10)', () => {
  it('logs method, host, status, latency, contentId only — no key, no body, no credential', async () => {
    const stub = await stubFor('ok');
    const { transport } = loopbackTransport(stub);
    const { log, calls } = recordingLogger();
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'basic',
      env: { [ENV_USERNAME]: 'stub-user', [ENV_PASSWORD]: 'stub-password' },
      transport,
      log
    });

    const { keys } = await provider.acquire(KEY_REQUEST, new AbortController().signal);

    const logged = JSON.stringify(calls);
    // The permitted field set (ADR-008 §10).
    expect(calls[0]).toMatchObject({
      obj: {
        method: 'POST',
        host: 'key-provider.invalid',
        status: 200,
        contentId: KEY_REQUEST.contentId,
        providerId: 'primary',
        attempt: 1
      }
    });
    // No key material, in any encoding.
    expect(logged).not.toContain(STUB_KEY_BASE64);
    expect(logged).not.toContain(Buffer.from(keys[0].key).toString('hex'));
    expect(logged).not.toContain(Buffer.from(keys[0].key).toString('utf8'));
    // No credential, in either form.
    expect(logged).not.toContain('stub-password');
    expect(logged).not.toContain(
      Buffer.from('stub-user:stub-password', 'utf8').toString('base64')
    );
    // No response body and no request document.
    expect(logged).not.toContain('PlainValue');
    expect(logged).not.toContain('<cpix:CPIX');
  });

  it('never logs or surfaces a provider error body on a 4xx', async () => {
    const stub = await stubFor('unauthorized');
    const { transport } = loopbackTransport(stub);
    const { log, calls } = recordingLogger();
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'bearer',
      env: { [ENV_TOKEN]: 'stub-token' },
      transport,
      log,
      ...FAST_RETRY
    });

    const error = await failureOf(provider.acquire(KEY_REQUEST, new AbortController().signal));

    const logged = JSON.stringify(calls);
    expect(logged).not.toContain(PROVIDER_ERROR_BODY);
    expect(logged).not.toContain('stub-token');
    // The errorCode IS logged — it is this repository's own enum (ADR-008 §8).
    expect(logged).toContain('key_provider_rejected');
    expect(error.message).not.toContain(PROVIDER_ERROR_BODY);
  });

  it('never logs a provider error body across the 5xx retry series', async () => {
    const stub = await stubFor('server-error');
    const { transport } = loopbackTransport(stub);
    const { log, calls } = recordingLogger();
    const provider = new CpixProvider({
      keyServerUrl: KEY_SERVER_URL,
      spekeVersion: '2.0',
      authMode: 'bearer',
      env: { [ENV_TOKEN]: 'stub-token' },
      transport,
      log,
      ...FAST_RETRY
    });

    await failureOf(provider.acquire(KEY_REQUEST, new AbortController().signal));

    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls)).not.toContain(PROVIDER_ERROR_BODY);
  });
});
