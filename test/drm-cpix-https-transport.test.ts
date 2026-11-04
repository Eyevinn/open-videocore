// `cpix` key provider — tests of the REAL `node:https` transport
// (`createHttpsCpixTransport()`), against a local TLS server.
//
// WHY THIS FILE EXISTS, SEPARATELY FROM test/drm-cpix-provider.test.ts. That
// suite injects a loopback `CpixHttpTransport` so it can exercise the policy
// ABOVE the transport seam (retries, status classification, error mapping, log
// redaction) over plain HTTP without a certificate. By construction it proves
// nothing about the transport itself, and three behaviours live ONLY there:
//
//   1. `authMode: 'mtls'` — the client certificate and key on the TLS
//      handshake. This is the stated reason the adapter uses `node:https`
//      instead of `fetch` (src/drm/cpix-provider.ts, "WHY NOT `fetch`"), so it
//      has to be shown on a real handshake, including the negative: a server
//      that demands a client certificate refuses the same transport when none
//      is configured.
//   2. The streaming size cap — `maxResponseBytes`, which stops reading and
//      sets `truncated: true`. Only the transport can produce `truncated`
//      (ADR-008 §10 "Bounded response size"; issue #1261: a body over 256 KiB
//      is rejected without calling the parser).
//   3. The `https:`-only guard inside the transport — unreachable through
//      `CpixProvider`, whose constructor already refuses a non-https
//      `keyServerUrl`, so it can only be shown by calling the transport
//      directly (ADR-008 §10 "Transport").
//
// The last four cases drive `CpixProvider.acquire()` with NO `transport`
// option, so the default wiring (`options.transport ?? createHttpsCpixTransport()`,
// src/drm/cpix-provider.ts) is what performs the request: a real TLS socket, a
// real client certificate, the real header set, and the real body cap feeding
// the size rejection.
//
// NO EXTERNAL ENDPOINT AND NO REAL CREDENTIAL. The server is `node:https`
// listening on 127.0.0.1 with an ephemeral port. Both certificates are
// generated into a temp directory at test time with the `openssl` CLI and
// deleted afterwards — nothing is committed, and no key material appears in
// this file. This is the same self-signed-certificate pattern already used by
// test/profiles-reachability.test.ts (issue #337).
//
// WHY `https.globalAgent.options.ca` IS SET. The transport calls
// `https.request` with no `agent` and no TLS trust options — correct for
// production, where the key server presents a publicly-trusted certificate —
// so the only way to let it verify a freshly generated self-signed server
// certificate is to add that certificate to the agent it already uses. TLS
// verification therefore stays ON (an unknown certificate would still fail);
// the test only teaches the default agent about this one server, and restores
// the original value afterwards.
//
// CONTRACT SOURCES (contract-first, CLAUDE.md rule 7):
//   - src/drm/cpix-provider.ts — `createHttpsCpixTransport`, `CpixHttpRequest`
//     (`url`, `headers`, `body`, `signal`, `clientCert`, `maxResponseBytes`),
//     `CpixHttpResponse` (`status`, `body`, `truncated`), `CpixProvider`,
//     `CpixProviderOptions`, and the env var constants `ENV_USERNAME` /
//     `ENV_PASSWORD` / `ENV_CLIENT_CERT` / `ENV_CLIENT_KEY`.
//   - src/drm/key-provider.ts — `KeyRequest` (`contentId`, `systems`, `scheme`,
//     `trackGroups`, `keyIds`), `ContentKey`, `DrmSignalling`.
//   - src/drm/key-provider-error.ts — `KeyProviderError.errorCode`.
//   - src/drm/cpix-response.ts — `NS_CPIX`, `NS_PSKC` for the response document
//     the local server answers with.
//   - docs/architecture/ADR-008-drm-protection.md §5.2 (the credential env var
//     table, "PEM, or a path"), §10 (transport, bounded response size), §13
//     (local stub, no live provider).
//
// NAMING (CLAUDE.md rule 1): no vendor, company or product name appears here; a
// DRM system is identified by its registered system id.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import {
  createServer as createHttpsServer,
  globalAgent,
  type Server as HttpsServer
} from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  CpixProvider,
  createHttpsCpixTransport,
  ENV_CLIENT_CERT,
  ENV_CLIENT_KEY,
  ENV_PASSWORD,
  ENV_USERNAME
} from '../src/drm/cpix-provider.js';
import { NS_CPIX, NS_PSKC } from '../src/drm/cpix-response.js';
import { KeyProviderError } from '../src/drm/key-provider-error.js';
import type { KeyRequest } from '../src/drm/key-provider.js';

const SYSTEM_ID_A = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const KID_HD = '8b3f2c9e-8fb0-4a9c-9c5e-3b4d6f708c92';
// Literal, non-secret key bytes for the local server's response document — the
// same stand-in the loopback suite uses. Never a real key.
const SERVER_KEY_BASE64 = Buffer.from('0123456789abcdef', 'utf8').toString('base64');
// Subject of the generated TLS client certificate. Asserting the server saw
// exactly this proves the `clientCert` of `CpixHttpRequest` reached the
// handshake rather than being dropped.
const CLIENT_CERT_CN = 'ovc-cpix-test-client';

const KEY_REQUEST: KeyRequest = {
  contentId: '01K9ZP4V7R8HTQ2B6WMNXE3C5D',
  systems: [SYSTEM_ID_A],
  scheme: 'cbcs',
  trackGroups: ['HD'],
  // Pinned so the local server can answer with the same kid.
  keyIds: { HD: KID_HD }
};

function validCpix(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cpix:CPIX contentId="${KEY_REQUEST.contentId}" version="2.3" xmlns:cpix="${NS_CPIX}" xmlns:pskc="${NS_PSKC}">
  <cpix:ContentKeyList>
    <cpix:ContentKey kid="${KID_HD}" commonEncryptionScheme="cbcs">
      <cpix:Data><pskc:Secret><pskc:PlainValue>${SERVER_KEY_BASE64}</pskc:PlainValue></pskc:Secret></cpix:Data>
    </cpix:ContentKey>
  </cpix:ContentKeyList>
  <cpix:DRMSystemList>
    <cpix:DRMSystem kid="${KID_HD}" systemId="${SYSTEM_ID_A}">
      <cpix:PSSH>${Buffer.from('pssh-box-bytes-a', 'utf8').toString('base64')}</cpix:PSSH>
    </cpix:DRMSystem>
  </cpix:DRMSystemList>
</cpix:CPIX>
`;
}

// ---------------------------------------------------------------------------
// Certificates (generated, never committed)
// ---------------------------------------------------------------------------

type Pems = {
  dir: string;
  serverKey: string;
  serverCert: string;
  clientKey: string;
  clientCert: string;
  clientKeyPath: string;
  clientCertPath: string;
};

let pems: Pems;
let originalAgentCa: unknown;

function generatePems(): Pems {
  const dir = mkdtempSync(join(tmpdir(), 'ovc-cpix-tls-'));
  const serverKeyPath = join(dir, 'server-key.pem');
  const serverCertPath = join(dir, 'server-cert.pem');
  const clientKeyPath = join(dir, 'client-key.pem');
  const clientCertPath = join(dir, 'client-cert.pem');

  // Server certificate. The transport connects by IP, so the address has to be
  // in a subjectAltName or hostname verification fails (which would make every
  // case below fail for the wrong reason).
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', serverKeyPath, '-out', serverCertPath,
      '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1'
    ],
    { stdio: 'ignore' }
  );
  // Client certificate for `authMode: 'mtls'`. Self-signed and handed to the
  // server as its own trust anchor, so the server validates this one
  // certificate and nothing else.
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', clientKeyPath, '-out', clientCertPath,
      '-days', '1', '-nodes', '-subj', `/CN=${CLIENT_CERT_CN}`
    ],
    { stdio: 'ignore' }
  );

  return {
    dir,
    serverKey: readFileSync(serverKeyPath, 'utf8'),
    serverCert: readFileSync(serverCertPath, 'utf8'),
    clientKey: readFileSync(clientKeyPath, 'utf8'),
    clientCert: readFileSync(clientCertPath, 'utf8'),
    clientKeyPath,
    clientCertPath
  };
}

beforeAll(() => {
  pems = generatePems();
  // See the file header: the transport passes no TLS trust options, so the
  // generated server certificate is added to the agent it already uses.
  originalAgentCa = globalAgent.options.ca;
  globalAgent.options.ca = [pems.serverCert];
}, 60_000);

afterAll(() => {
  globalAgent.options.ca = originalAgentCa as typeof globalAgent.options.ca;
  // Drop any socket opened with the test trust anchor.
  globalAgent.destroy();
  rmSync(pems.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The local TLS server (own code, no new dependency — ADR-008 §13)
// ---------------------------------------------------------------------------

type ServerRecord = {
  requests: {
    method: string | undefined;
    url: string | undefined;
    headers: IncomingMessage['headers'];
    body: string;
    // Subject CN of the certificate the peer presented, or undefined when it
    // presented none.
    peerCn: string | undefined;
  }[];
};

type LocalServer = { url: string; record: ServerRecord };

let openServers: (HttpsServer | HttpServer)[] = [];

afterEach(async () => {
  const servers = openServers.splice(0);
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function startTlsServer(
  handle: (res: ServerResponse, record: ServerRecord) => void,
  options: { requireClientCert?: boolean } = {}
): Promise<LocalServer> {
  const record: ServerRecord = { requests: [] };
  const server = createHttpsServer(
    {
      key: pems.serverKey,
      cert: pems.serverCert,
      ...(options.requireClientCert
        ? // Demand a client certificate and verify it against the generated
          // client certificate itself (ADR-008 §5.2 `authMode: mtls`).
          { requestCert: true, rejectUnauthorized: true, ca: [pems.clientCert] }
        : {})
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const peer = (req.socket as TLSSocket).getPeerCertificate?.();
        record.requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          peerCn:
            peer !== undefined && peer !== null && Object.keys(peer).length > 0
              ? peer.subject?.CN
              : undefined
        });
        handle(res, record);
      });
    }
  );
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return { url: `https://127.0.0.1:${address.port}/cpix`, record };
}

// Answers one valid CPIX document.
function respondCpix(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/xml');
  res.end(validCpix());
}

// Streams `totalBytes` of body in 1 KiB chunks without a content-length, which
// is what makes the cap a STREAMING one: the transport cannot know the size up
// front and has to stop mid-body.
function respondChunked(res: ServerResponse, totalBytes: number): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/xml');
  const chunk = 'A'.repeat(1024);
  let written = 0;
  while (written < totalBytes) {
    const remaining = totalBytes - written;
    res.write(remaining >= chunk.length ? chunk : 'A'.repeat(remaining));
    written += Math.min(chunk.length, remaining);
  }
  res.end();
}

function fiveSecondSignal(): AbortSignal {
  return AbortSignal.timeout(5_000);
}

// ---------------------------------------------------------------------------
// 1. mTLS — the reason the adapter uses `node:https` rather than `fetch`
// ---------------------------------------------------------------------------

describe('createHttpsCpixTransport mTLS client certificate (ADR-008 §5.2, issue #1261)', () => {
  it('presents the configured client certificate on the TLS handshake', async () => {
    const server = await startTlsServer((res) => respondCpix(res), { requireClientCert: true });
    const transport = createHttpsCpixTransport();

    const response = await transport({
      url: server.url,
      headers: { 'content-type': 'application/xml', accept: 'application/xml' },
      body: '<cpix:CPIX/>',
      signal: fiveSecondSignal(),
      clientCert: { cert: pems.clientCert, key: pems.clientKey },
      maxResponseBytes: 256 * 1024
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain('<cpix:CPIX');
    expect(response.truncated).toBeUndefined();

    // The handshake carried the certificate: the server validated it and
    // reports its subject.
    expect(server.record.requests).toHaveLength(1);
    expect(server.record.requests[0].peerCn).toBe(CLIENT_CERT_CN);
    // ...and the request itself is the POST the adapter promises, with the body
    // intact and a content-length the transport computed.
    expect(server.record.requests[0].method).toBe('POST');
    expect(server.record.requests[0].url).toBe('/cpix');
    expect(server.record.requests[0].body).toBe('<cpix:CPIX/>');
    expect(server.record.requests[0].headers['content-length']).toBe('12');
    expect(server.record.requests[0].headers['content-type']).toBe('application/xml');
    // `mtls` carries no Authorization header — the certificate IS the
    // credential.
    expect(server.record.requests[0].headers['authorization']).toBeUndefined();
  });

  it('is refused by a client-certificate-demanding server when no clientCert is configured', async () => {
    // The negative half: without this, "the certificate was sent" could also be
    // explained by a server that never checked.
    const server = await startTlsServer((res) => respondCpix(res), { requireClientCert: true });
    const transport = createHttpsCpixTransport();

    await expect(
      transport({
        url: server.url,
        headers: { 'content-type': 'application/xml' },
        body: '<cpix:CPIX/>',
        signal: fiveSecondSignal(),
        maxResponseBytes: 256 * 1024
      })
    ).rejects.toThrow();

    // The handshake failed, so no HTTP request was ever delivered.
    expect(server.record.requests).toHaveLength(0);
  });

  it('verifies the server certificate — an unknown TLS peer is rejected, not trusted', async () => {
    // TLS verification is still on: the server here is reached over a trust
    // anchor the agent does NOT know, so the transport must fail rather than
    // accept any certificate.
    const server = await startTlsServer((res) => respondCpix(res));
    const transport = createHttpsCpixTransport();
    const saved = globalAgent.options.ca;
    globalAgent.options.ca = [pems.clientCert]; // wrong anchor for this server
    globalAgent.destroy();
    try {
      await expect(
        transport({
          url: server.url,
          headers: {},
          body: '<cpix:CPIX/>',
          signal: fiveSecondSignal(),
          maxResponseBytes: 256 * 1024
        })
      ).rejects.toThrow();
      expect(server.record.requests).toHaveLength(0);
    } finally {
      globalAgent.options.ca = saved;
      globalAgent.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The streaming response cap — the only producer of `truncated`
// ---------------------------------------------------------------------------

describe('createHttpsCpixTransport response size cap (ADR-008 §10, issue #1261)', () => {
  it('stops reading and sets truncated=true when the peer sends more than maxResponseBytes', async () => {
    const cap = 2048;
    const server = await startTlsServer((res) => respondChunked(res, 64 * 1024));
    const transport = createHttpsCpixTransport();

    const response = await transport({
      url: server.url,
      headers: {},
      body: '<cpix:CPIX/>',
      signal: fiveSecondSignal(),
      maxResponseBytes: cap
    });

    expect(response.truncated).toBe(true);
    // The read was cut short: far less than the 64 KiB on the wire was
    // buffered, and never more than the cap.
    expect(Buffer.byteLength(response.body, 'utf8')).toBeLessThanOrEqual(cap);
    expect(Buffer.byteLength(response.body, 'utf8')).toBeLessThan(64 * 1024);
  });

  it('does not truncate a body that fits inside maxResponseBytes', async () => {
    // The boundary in the other direction, so the cap cannot pass by always
    // reporting truncation.
    const server = await startTlsServer((res) => respondChunked(res, 4096));
    const transport = createHttpsCpixTransport();

    const response = await transport({
      url: server.url,
      headers: {},
      body: '<cpix:CPIX/>',
      signal: fiveSecondSignal(),
      maxResponseBytes: 8192
    });

    expect(response.truncated).toBeUndefined();
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(response.body, 'utf8')).toBe(4096);
  });
});

// ---------------------------------------------------------------------------
// 3. The transport's own `https:` guard
// ---------------------------------------------------------------------------

describe('createHttpsCpixTransport https-only guard (ADR-008 §10 "Transport")', () => {
  it('rejects an http: url with drm_not_configured and sends nothing in the clear', async () => {
    // Reachable only by calling the transport directly: `CpixProvider`'s
    // constructor refuses a non-https `keyServerUrl` before one can be built.
    let received = 0;
    const plain = createHttpServer((_req, res) => {
      received += 1;
      res.statusCode = 200;
      res.end('should-never-be-requested');
    });
    openServers.push(plain);
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', () => resolve()));
    const { port } = plain.address() as AddressInfo;

    const transport = createHttpsCpixTransport();
    const error = await transport({
      url: `http://127.0.0.1:${port}/cpix`,
      headers: {},
      body: '<cpix:CPIX/>',
      signal: fiveSecondSignal(),
      maxResponseBytes: 256 * 1024
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KeyProviderError);
    expect((error as KeyProviderError).errorCode).toBe('drm_not_configured');
    // No key request left the process over cleartext HTTP.
    expect(received).toBe(0);
  });

  it('rejects a non-http scheme url as well', async () => {
    const transport = createHttpsCpixTransport();
    const error = await transport({
      url: 'ftp://127.0.0.1/cpix',
      headers: {},
      body: '<cpix:CPIX/>',
      signal: fiveSecondSignal(),
      maxResponseBytes: 256 * 1024
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KeyProviderError);
    expect((error as KeyProviderError).errorCode).toBe('drm_not_configured');
  });
});

// ---------------------------------------------------------------------------
// 4. End to end through CpixProvider with NO transport injected
// ---------------------------------------------------------------------------

describe('CpixProvider over its DEFAULT https transport (issue #1261)', () => {
  it('acquires keys over real TLS with authMode mtls and PEM FILE PATHS in the env', async () => {
    // ADR-008 §5.2: the mtls credential env vars hold "PEM, or a path". Paths
    // here, so the provider's default `readPem` reads them off disk.
    const server = await startTlsServer((res) => respondCpix(res), { requireClientCert: true });
    const provider = new CpixProvider({
      keyServerUrl: server.url,
      spekeVersion: '2.0',
      authMode: 'mtls',
      env: {
        [ENV_CLIENT_CERT]: pems.clientCertPath,
        [ENV_CLIENT_KEY]: pems.clientKeyPath
      },
      licenceUrls: { [SYSTEM_ID_A]: 'https://licence.invalid/acquire' }
      // NO `transport` — this is `createHttpsCpixTransport()` by default.
    });

    const { keys, signalling } = await provider.acquire(KEY_REQUEST, new AbortController().signal);

    expect(keys).toHaveLength(1);
    expect(keys[0].keyId).toBe(KID_HD);
    expect(Buffer.from(keys[0].key).toString('base64')).toBe(SERVER_KEY_BASE64);
    expect(signalling.pssh[SYSTEM_ID_A]).toBeDefined();
    expect(signalling.licenceUrls).toEqual({ [SYSTEM_ID_A]: 'https://licence.invalid/acquire' });
    // The default transport really did the handshake with the configured
    // certificate.
    expect(server.record.requests).toHaveLength(1);
    expect(server.record.requests[0].peerCn).toBe(CLIENT_CERT_CN);
    // The document the builder produced arrived as `application/xml`.
    expect(server.record.requests[0].headers['content-type']).toBe('application/xml');
    expect(server.record.requests[0].body).toContain('CPIX');
  });

  it('acquires keys over real TLS with authMode mtls and INLINE PEM text in the env', async () => {
    const server = await startTlsServer((res) => respondCpix(res), { requireClientCert: true });
    const provider = new CpixProvider({
      keyServerUrl: server.url,
      spekeVersion: '2.0',
      authMode: 'mtls',
      env: {
        [ENV_CLIENT_CERT]: pems.clientCert,
        [ENV_CLIENT_KEY]: pems.clientKey
      }
    });

    const { keys } = await provider.acquire(KEY_REQUEST, new AbortController().signal);

    expect(keys).toHaveLength(1);
    expect(server.record.requests[0].peerCn).toBe(CLIENT_CERT_CN);
  });

  it('sends Basic credentials over real TLS with authMode basic and presents no client certificate', async () => {
    const server = await startTlsServer((res) => respondCpix(res));
    const provider = new CpixProvider({
      keyServerUrl: server.url,
      spekeVersion: '2.0',
      authMode: 'basic',
      env: { [ENV_USERNAME]: 'local-user', [ENV_PASSWORD]: 'local-password' }
    });

    const { keys } = await provider.acquire(KEY_REQUEST, new AbortController().signal);

    expect(keys).toHaveLength(1);
    const expected = `Basic ${Buffer.from('local-user:local-password', 'utf8').toString('base64')}`;
    expect(server.record.requests[0].headers['authorization']).toBe(expected);
    expect(server.record.requests[0].peerCn).toBeUndefined();
  });

  it('rejects an oversized response with key_provider_invalid_response, via the transport truncation flag', async () => {
    // The producer side (transport sets `truncated`) wired to the consumer side
    // (the provider rejects without parsing) — issue #1261: a body over the cap
    // must be rejected without calling the parser. With a 2 KiB cap and 1 KiB
    // chunks the buffered body stops AT 2048 bytes, so the provider's own
    // byte-length re-check does not fire and `truncated` is what rejects this
    // response.
    const server = await startTlsServer((res) => respondChunked(res, 64 * 1024));
    const provider = new CpixProvider({
      keyServerUrl: server.url,
      spekeVersion: '2.0',
      authMode: 'basic',
      env: { [ENV_USERNAME]: 'local-user', [ENV_PASSWORD]: 'local-password' },
      maxResponseBytes: 2048,
      // The parser must never see this body; a throwing parser seam would be
      // the loudest possible failure if it did.
      parseDeps: {
        parseXml: () => {
          throw new Error('the parser must not be called for an oversized body');
        }
      }
    });

    const error = await provider
      .acquire(KEY_REQUEST, new AbortController().signal)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KeyProviderError);
    expect((error as KeyProviderError).errorCode).toBe('key_provider_invalid_response');
    expect((error as KeyProviderError).message).not.toContain('AAAA');
  });
});
