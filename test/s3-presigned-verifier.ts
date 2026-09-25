// An in-process, S3-compatible object store that really VERIFIES AWS Signature
// Version 4 presigned-GET query signatures (issue #803 review, finding 1).
//
// Why this exists: asserting that a route returned "a string with
// X-Amz-Signature in it" proves nothing about whether an object store would
// honour that URL. This server recomputes the signature independently — from
// the AWS SigV4 rules, using only node:crypto, with no help from the storage
// SDK that produced the URL — and serves bytes ONLY when the recomputed
// signature matches an unexpired, correctly scoped presigned request. That
// makes "a header-less browser GET of the issued URL returns 200 image/jpeg"
// and "the same object refuses an unsigned GET" runnable on every push,
// without a container runtime or a live stack.
//
// Contract sources verified before writing this (never guessed):
//   - AWS SigV4 "Authenticating Requests: Using Query Parameters" canonical
//     request / string-to-sign / signing-key derivation, as implemented by the
//     storage SDK this API signs with:
//       node_modules/minio/dist/esm/signing.mjs:33  getCanonicalRequest()
//         → [METHOD, canonicalURI, canonicalQuery, canonicalHeaders + '\n',
//            signedHeaders, hashedPayload].join('\n')
//       node_modules/minio/dist/esm/signing.mjs:147 getStringToSign()
//         → ['AWS4-HMAC-SHA256', makeDateLong(date), scope, sha256(canonical)]
//       node_modules/minio/dist/esm/signing.mjs:117 getSigningKey()
//         → HMAC chain over 'AWS4'+secret / yyyymmdd / region / s3 /
//           'aws4_request'
//       node_modules/minio/dist/esm/signing.mjs:234 presignSignatureV4()
//         → hashedPayload is the literal 'UNSIGNED-PAYLOAD'; the query carries
//           X-Amz-Algorithm, X-Amz-Credential, X-Amz-Date, X-Amz-Expires,
//           X-Amz-SignedHeaders, then X-Amz-Signature appended last
//       node_modules/minio/dist/esm/signing.mjs:112 ignoredHeaders
//         → signed headers are effectively just `host`
//       node_modules/minio/dist/esm/internal/client.mjs:305-308
//         → the signed `host` header includes the port when it is not the
//           protocol default (so a 127.0.0.1:<ephemeral> endpoint signs
//           '127.0.0.1:<port>', which is what fetch() then sends)
//       node_modules/minio/dist/esm/internal/client.mjs:295-300
//         → path-style addressing (`/<bucket>/<key>`) for non-virtual-host
//           endpoints such as an IP literal
//   - The error shapes below are the ones real OSC object storage returns.
//     Observed 2026-09-25 against a live OSC storage instance from outside the
//     cluster (agents repo,
//     docs/osc-feedback/incoming-presigned-get-thumbnails.md):
//       presigned anonymous GET → 200 image/jpeg
//       unsigned                → 403 AccessDenied
//       tampered signature      → 403 SignatureDoesNotMatch
//       expired                 → 403 AccessDenied

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

// One handled request, so a test can assert HOW the object was fetched (in
// particular: with no Authorization header at all, the way an <img> GET is).
export type ObjectStoreRequestLog = {
  method: string;
  path: string;
  hadAuthorizationHeader: boolean;
  status: number;
  code: string;
};

export type VerifyingObjectStore = {
  /** `http://127.0.0.1:<port>` — hand this to the storage client under test. */
  endpoint: string;
  port: number;
  accessKey: string;
  secretKey: string;
  region: string;
  /** Seed an object. The store is a fixture, so writes bypass the signer. */
  putObject(bucket: string, key: string, body: Buffer, contentType: string): void;
  /** Every request the server handled, oldest first. */
  requests: ObjectStoreRequestLog[];
  close(): Promise<void>;
};

type Refusal = { status: number; code: string; message: string };

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

// HMAC chain: kDate → kRegion → kService → kSigning (signing.mjs:117).
function signingKey(secretKey: string, dateStamp: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), 's3'), 'aws4_request');
}

// 'YYYYMMDDTHHMMSSZ' → Date. Deliberately strict: a malformed date is a
// refusal, not a lenient parse.
function parseAmzDate(value: string): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// Recompute the signature for an incoming presigned GET and decide whether to
// serve it. Returns undefined when the request is authorised.
function verifyPresignedRequest(
  req: IncomingMessage,
  url: URL,
  rawQuery: string,
  opts: { accessKey: string; secretKey: string; region: string; now: number }
): Refusal | undefined {
  const q = url.searchParams;
  const provided = q.get('X-Amz-Signature');
  if (!provided) {
    // A private bucket with no credentials and no signature: exactly what a
    // browser sends when the signature has been stripped.
    return { status: 403, code: 'AccessDenied', message: 'Access Denied.' };
  }
  if (q.get('X-Amz-Algorithm') !== ALGORITHM) {
    return {
      status: 403,
      code: 'AuthorizationQueryParametersError',
      message: 'X-Amz-Algorithm only supports "AWS4-HMAC-SHA256".'
    };
  }

  const credential = q.get('X-Amz-Credential') ?? '';
  const [credAccessKey, credDate, credRegion, credService, credTerminator] = credential.split('/');
  if (credAccessKey !== opts.accessKey) {
    return {
      status: 403,
      code: 'InvalidAccessKeyId',
      message: 'The Access Key Id you provided does not exist in our records.'
    };
  }
  if (credRegion !== opts.region || credService !== 's3' || credTerminator !== 'aws4_request') {
    return {
      status: 403,
      code: 'AuthorizationQueryParametersError',
      message: 'Credential scope is malformed.'
    };
  }

  const amzDate = q.get('X-Amz-Date') ?? '';
  const signedAt = parseAmzDate(amzDate);
  if (!signedAt || amzDate.slice(0, 8) !== credDate) {
    return {
      status: 403,
      code: 'AuthorizationQueryParametersError',
      message: 'X-Amz-Date is missing or does not match the credential scope.'
    };
  }

  const expires = Number(q.get('X-Amz-Expires'));
  if (!Number.isFinite(expires) || expires < 1) {
    return {
      status: 403,
      code: 'AuthorizationQueryParametersError',
      message: 'X-Amz-Expires must be a positive number of seconds.'
    };
  }
  if (opts.now > signedAt.getTime() + expires * 1000) {
    // The whole point of a short TTL: past the window the URL is inert even
    // though its signature is still arithmetically correct.
    return { status: 403, code: 'AccessDenied', message: 'Request has expired.' };
  }

  const signedHeaders = (q.get('X-Amz-SignedHeaders') ?? '').split(';').filter(Boolean);
  if (signedHeaders.length === 0) {
    return {
      status: 403,
      code: 'AuthorizationQueryParametersError',
      message: 'X-Amz-SignedHeaders is required.'
    };
  }
  const canonicalHeaders: string[] = [];
  for (const name of [...signedHeaders].sort()) {
    const value = req.headers[name];
    if (value === undefined) {
      return {
        status: 403,
        code: 'SignatureDoesNotMatch',
        message: `Signed header ${name} was not sent.`
      };
    }
    const flattened = Array.isArray(value) ? value.join(',') : value;
    canonicalHeaders.push(`${name}:${flattened.trim().replace(/\s+/g, ' ')}`);
  }

  // Canonical query string: every query parameter except the signature itself,
  // sorted, in the percent-encoded form it arrived in.
  const canonicalQuery = rawQuery
    .split('&')
    .filter((pair) => pair.length > 0 && !pair.startsWith('X-Amz-Signature='))
    .map((pair) => (pair.includes('=') ? pair : `${pair}=`))
    .sort()
    .join('&');

  const canonicalRequest = [
    req.method ?? 'GET',
    url.pathname,
    canonicalQuery,
    `${canonicalHeaders.join('\n')}\n`,
    [...signedHeaders].sort().join(';'),
    UNSIGNED_PAYLOAD
  ].join('\n');

  const scope = `${credDate}/${opts.region}/s3/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const expected = createHmac('sha256', signingKey(opts.secretKey, credDate, opts.region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  if (!constantTimeEquals(expected, provided.toLowerCase())) {
    return {
      status: 403,
      code: 'SignatureDoesNotMatch',
      message:
        'The request signature we calculated does not match the signature you provided.'
    };
  }
  return undefined;
}

function sendError(res: ServerResponse, refusal: Refusal, resource: string): void {
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Error><Code>${refusal.code}</Code><Message>${refusal.message}</Message>` +
    `<Resource>${resource}</Resource></Error>`;
  res.writeHead(refusal.status, {
    'content-type': 'application/xml',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * Start the signature-verifying object store on an ephemeral loopback port.
 * Path-style addressing only (`/<bucket>/<key>`), which is what the storage
 * client uses for an IP-literal endpoint.
 */
export async function startVerifyingObjectStore(opts?: {
  accessKey?: string;
  secretKey?: string;
  region?: string;
}): Promise<VerifyingObjectStore> {
  const accessKey = opts?.accessKey ?? 'test-access-key';
  const secretKey = opts?.secretKey ?? 'test-secret-key';
  const region = opts?.region ?? 'us-east-1';
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const requests: ObjectStoreRequestLog[] = [];

  const server: Server = createServer((req, res) => {
    const rawUrl = req.url ?? '/';
    const rawQuery = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
    const url = new URL(rawUrl, `http://${req.headers.host ?? '127.0.0.1'}`);
    const log: ObjectStoreRequestLog = {
      method: req.method ?? 'GET',
      path: url.pathname,
      hadAuthorizationHeader: req.headers.authorization !== undefined,
      status: 0,
      code: ''
    };
    requests.push(log);

    const finish = (refusal: Refusal | undefined, onOk: () => void): void => {
      if (refusal) {
        log.status = refusal.status;
        log.code = refusal.code;
        sendError(res, refusal, url.pathname);
        return;
      }
      onOk();
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      finish(
        { status: 405, code: 'MethodNotAllowed', message: 'Only GET/HEAD are served.' },
        () => undefined
      );
      return;
    }

    // Header-based (non-presigned) auth is out of scope for this fixture: the
    // only thing under test is the presigned query-string path a browser uses.
    const refusal = verifyPresignedRequest(req, url, rawQuery, {
      accessKey,
      secretKey,
      region,
      now: Date.now()
    });

    finish(refusal, () => {
      const [, bucket, ...rest] = url.pathname.split('/');
      const key = rest.map((segment) => decodeURIComponent(segment)).join('/');
      const stored = objects.get(`${bucket}/${key}`);
      if (!stored) {
        log.status = 404;
        log.code = 'NoSuchKey';
        sendError(
          res,
          { status: 404, code: 'NoSuchKey', message: 'The specified key does not exist.' },
          url.pathname
        );
        return;
      }
      log.status = 200;
      log.code = 'OK';
      res.writeHead(200, {
        'content-type': stored.contentType,
        'content-length': stored.body.length
      });
      res.end(req.method === 'HEAD' ? undefined : stored.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    port,
    accessKey,
    secretKey,
    region,
    putObject(bucket, key, body, contentType) {
      objects.set(`${bucket}/${key}`, { body, contentType });
    },
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
  };
}
