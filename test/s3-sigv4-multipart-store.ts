// An in-process, S3-compatible object store that VERIFIES AWS Signature
// Version 4 on the MULTIPART upload protocol (issue #1342).
//
// Why this exists. Two fixtures already cover one half each and neither can
// answer "would the object store this stack was provisioned with accept the
// request our multipart-init handler signs?":
//   - test/s3-multipart-store.ts implements the multipart state machine but
//     "accepts any credentials" (see its header), so a wrong credential passes.
//   - test/s3-presigned-verifier.ts really recomputes SigV4, but only for a
//     presigned GET query signature, and serves GET/HEAD only.
// The failure in #1342 is a CREDENTIAL failure on a request our process signs
// itself (`CreateMultipartUpload` is a header-signed POST, not a presigned
// URL), so proving it shut needs both halves at once: a server that runs the
// multipart protocol AND refuses every request whose SigV4 does not verify
// against the credential the store was created with.
//
// Contract sources verified before writing (per CLAUDE.md rule 7) — the signing
// rules are taken from the client this API signs with, never guessed:
//   - Header auth: `Authorization: AWS4-HMAC-SHA256 Credential=<ak>/<scope>,
//     SignedHeaders=<h;h>, Signature=<hex>` built by `signV4(request, accessKey,
//     secretKey, region, date, sha256sum)` —
//     node_modules/minio/dist/esm/signing.mjs:169-199.
//   - Canonical request = [METHOD, path-before-?, sorted raw query (each pair
//     without '=' gets one appended), canonicalHeaders + '\n', signedHeaders,
//     hashedPayload].join('\n'), header values space-collapsed with
//     `.replace(/ +/g, ' ')` — signing.mjs:33-63.
//   - Signed headers are every request header except
//     authorization/content-length/content-type/user-agent, sorted —
//     signing.mjs:112-114.
//   - String to sign = ['AWS4-HMAC-SHA256', makeDateLong(date), scope,
//     sha256(canonicalRequest)] and the signing key is the
//     HMAC chain over 'AWS4'+secret / yyyymmdd / region / s3 / 'aws4_request' —
//     signing.mjs:117-148.
//   - `x-amz-date` and `x-amz-content-sha256` are set on every non-anonymous
//     request, and over HTTP the payload hash is the real sha256 of the body
//     (`enableSHA256 = !anonymous && !useSSL`) —
//     node_modules/minio/dist/esm/internal/client.mjs:158, :496-503.
//   - `host` is signed WITH the port whenever it is not the protocol default —
//     client.mjs:305-308. Path-style addressing (`/<bucket>/<key>`) is the
//     default (`pathStyle = true`) — client.mjs:127-131, :279-300.
//   - Presigned part URLs: hashedPayload is the literal 'UNSIGNED-PAYLOAD', the
//     signature is the last query parameter, and the signed header set is
//     effectively just `host` — signing.mjs:234 `presignSignatureV4`.
//   - Multipart wire shapes (initiate/part/list/complete/abort) and the XML the
//     client parses back are the ones test/s3-multipart-store.ts documents
//     line-by-line against client.mjs/xml-parser.mjs; this fixture answers the
//     same shapes.
//   - Refusal shapes are the ones real OSC object storage returns, recorded in
//     test/s3-presigned-verifier.ts: 403 SignatureDoesNotMatch for a signature
//     that does not recompute, 403 InvalidAccessKeyId for an unknown key id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export type SigV4RequestLog = {
  op:
    | 'CreateMultipartUpload'
    | 'UploadPart'
    | 'CompleteMultipartUpload'
    | 'AbortMultipartUpload'
    | 'ListMultipartUploads'
    | 'ListParts'
    | 'PutObject'
    | 'GetObject'
    | 'GetBucketLocation'
    | 'Unsupported';
  key?: string;
  uploadId?: string;
  partNumber?: number;
  /** The access key id the request presented, or undefined when unsigned. */
  accessKeyId?: string;
  /** 'header' for Authorization-signed, 'query' for a presigned URL. */
  authStyle?: 'header' | 'query' | 'none';
  status: number;
  code: string;
};

export type SigV4MultipartStore = {
  /** `http://127.0.0.1:<port>` — hand this to the storage client under test. */
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
  bucket: string;
  /** Committed objects, keyed by object key. */
  objects: Map<string, Buffer>;
  requests: SigV4RequestLog[];
  close(): Promise<void>;
};

type Refusal = { status: number; code: string; message: string };

type StagedPart = { partNumber: number; etag: string; body: Buffer; lastModified: Date };
type LiveUpload = { uploadId: string; key: string; initiated: Date; parts: Map<number, StagedPart> };

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function md5Hex(body: Buffer): string {
  return createHash('md5').update(body).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

// kDate -> kRegion -> kService -> kSigning (signing.mjs:117-131).
function signingKey(secretKey: string, dateStamp: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), 's3'), 'aws4_request');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// Sorted raw query string, with the signature parameter removed for the
// presigned case. Mirrors signing.mjs:56-58 (sort the raw pairs, append '=' to
// a bare flag such as `uploads`).
function canonicalQuery(rawQuery: string, dropSignature: boolean): string {
  return rawQuery
    .split('&')
    .filter((pair) => pair.length > 0 && !(dropSignature && pair.startsWith('X-Amz-Signature=')))
    .map((pair) => (pair.includes('=') ? pair : `${pair}=`))
    .sort()
    .join('&');
}

function parseAmzDate(value: string): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return undefined;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

type Creds = { accessKey: string; secretKey: string; region: string };

// Recompute the Authorization-header signature for a request our own process
// signed (CreateMultipartUpload, CompleteMultipartUpload, AbortMultipartUpload,
// PutObject, GetBucketLocation, ...). Returns undefined when it verifies.
function verifyHeaderAuth(
  req: IncomingMessage,
  pathname: string,
  rawQuery: string,
  body: Buffer,
  creds: Creds,
  log: SigV4RequestLog
): Refusal | undefined {
  const authorization = req.headers.authorization ?? '';
  log.authStyle = 'header';
  const parsed =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\S+?),\s*SignedHeaders=(\S+?),\s*Signature=([0-9a-f]+)$/.exec(
      authorization
    );
  if (!parsed) {
    return {
      status: 403,
      code: 'AccessDenied',
      message: 'Access Denied: no usable AWS4-HMAC-SHA256 Authorization header.'
    };
  }
  const [, credAccessKey, credScope, signedHeaderList, provided] = parsed;
  log.accessKeyId = credAccessKey;
  if (credAccessKey !== creds.accessKey) {
    // What a store created with a DIFFERENT root user answers: the key id is
    // not one it knows at all.
    return {
      status: 403,
      code: 'InvalidAccessKeyId',
      message: 'The Access Key Id you provided does not exist in our records.'
    };
  }
  const [credDate, credRegion, credService, credTerminator] = (credScope ?? '').split('/');
  if (credRegion !== creds.region || credService !== 's3' || credTerminator !== 'aws4_request') {
    return { status: 403, code: 'AuthorizationHeaderMalformed', message: 'Credential scope is malformed.' };
  }

  const amzDate = (req.headers['x-amz-date'] as string | undefined) ?? '';
  if (!parseAmzDate(amzDate) || amzDate.slice(0, 8) !== credDate) {
    return {
      status: 403,
      code: 'AuthorizationHeaderMalformed',
      message: 'x-amz-date is missing or does not match the credential scope.'
    };
  }

  // The payload hash the client signed. Over HTTP it is the real sha256 of the
  // body, so recomputing it also checks the body arrived intact.
  const hashedPayload = (req.headers['x-amz-content-sha256'] as string | undefined) ?? '';
  if (hashedPayload !== UNSIGNED_PAYLOAD && hashedPayload !== sha256Hex(body)) {
    return {
      status: 400,
      code: 'XAmzContentSHA256Mismatch',
      message: 'The provided x-amz-content-sha256 header does not match what was computed.'
    };
  }

  const signedHeaders = (signedHeaderList ?? '').split(';').filter(Boolean);
  const canonicalHeaders: string[] = [];
  for (const name of signedHeaders) {
    const value = req.headers[name];
    if (value === undefined) {
      return {
        status: 403,
        code: 'SignatureDoesNotMatch',
        message: `Signed header ${name} was not sent.`
      };
    }
    const flattened = Array.isArray(value) ? value.join(',') : value;
    canonicalHeaders.push(`${name}:${flattened.replace(/ +/g, ' ')}`);
  }

  const canonicalRequest = [
    req.method ?? 'GET',
    pathname,
    canonicalQuery(rawQuery, false),
    `${canonicalHeaders.join('\n')}\n`,
    signedHeaders.join(';'),
    hashedPayload
  ].join('\n');
  const stringToSign = [
    ALGORITHM,
    amzDate,
    `${credDate}/${creds.region}/s3/aws4_request`,
    sha256Hex(canonicalRequest)
  ].join('\n');
  const expected = createHmac('sha256', signingKey(creds.secretKey, credDate!, creds.region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  if (!constantTimeEquals(expected, (provided ?? '').toLowerCase())) {
    return {
      status: 403,
      code: 'SignatureDoesNotMatch',
      message: 'The request signature we calculated does not match the signature you provided.'
    };
  }
  return undefined;
}

// Recompute a presigned (query-string) signature — the part-upload URLs the
// multipart flow hands to the client.
function verifyQueryAuth(
  req: IncomingMessage,
  pathname: string,
  rawQuery: string,
  url: URL,
  creds: Creds,
  now: number,
  log: SigV4RequestLog
): Refusal | undefined {
  const q = url.searchParams;
  log.authStyle = 'query';
  const provided = q.get('X-Amz-Signature') ?? '';
  if (q.get('X-Amz-Algorithm') !== ALGORITHM) {
    return {
      status: 403,
      code: 'AuthorizationQueryParametersError',
      message: 'X-Amz-Algorithm only supports "AWS4-HMAC-SHA256".'
    };
  }
  const credential = q.get('X-Amz-Credential') ?? '';
  const [credAccessKey, credDate, credRegion, credService, credTerminator] = credential.split('/');
  log.accessKeyId = credAccessKey;
  if (credAccessKey !== creds.accessKey) {
    return {
      status: 403,
      code: 'InvalidAccessKeyId',
      message: 'The Access Key Id you provided does not exist in our records.'
    };
  }
  if (credRegion !== creds.region || credService !== 's3' || credTerminator !== 'aws4_request') {
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
  if (now > signedAt.getTime() + expires * 1000) {
    return { status: 403, code: 'AccessDenied', message: 'Request has expired.' };
  }

  const signedHeaders = (q.get('X-Amz-SignedHeaders') ?? '').split(';').filter(Boolean);
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

  const canonicalRequest = [
    req.method ?? 'GET',
    pathname,
    canonicalQuery(rawQuery, true),
    `${canonicalHeaders.join('\n')}\n`,
    [...signedHeaders].sort().join(';'),
    UNSIGNED_PAYLOAD
  ].join('\n');
  const stringToSign = [
    ALGORITHM,
    amzDate,
    `${credDate}/${creds.region}/s3/aws4_request`,
    sha256Hex(canonicalRequest)
  ].join('\n');
  const expected = createHmac('sha256', signingKey(creds.secretKey, credDate!, creds.region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  if (!constantTimeEquals(expected, provided.toLowerCase())) {
    return {
      status: 403,
      code: 'SignatureDoesNotMatch',
      message: 'The request signature we calculated does not match the signature you provided.'
    };
  }
  return undefined;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendXml(res: ServerResponse, status: number, body: string): void {
  const payload = `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
  res.writeHead(status, {
    'content-type': 'application/xml',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendError(res: ServerResponse, refusal: Refusal): void {
  sendXml(
    res,
    refusal.status,
    `<Error><Code>${refusal.code}</Code><Message>${xmlEscape(refusal.message)}</Message></Error>`
  );
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function unquoteEtag(value: string): string {
  return value.trim().replace(/^"+|"+$/g, '').replace(/^&quot;|&quot;$/g, '');
}

// The CompleteMultipartUpload body the client builds (client.mjs:1194-1207).
function parseCompleteBody(xml: string): { partNumber: number; etag: string }[] {
  const parts: { partNumber: number; etag: string }[] = [];
  for (const match of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
    const block = match[1] ?? '';
    const partNumber = Number(/<PartNumber>\s*(\d+)\s*<\/PartNumber>/.exec(block)?.[1]);
    const etag = unquoteEtag(/<ETag>([\s\S]*?)<\/ETag>/.exec(block)?.[1] ?? '');
    if (Number.isFinite(partNumber)) parts.push({ partNumber, etag });
  }
  return parts;
}

/**
 * Start a signature-verifying, multipart-capable object store on an ephemeral
 * loopback port. Every request must carry a SigV4 signature that recomputes
 * against `accessKey`/`secretKey` — i.e. the credential the store was
 * "created with" — or it is refused exactly as the real store refuses it.
 */
export async function startSigV4MultipartStore(opts: {
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}): Promise<SigV4MultipartStore> {
  const creds: Creds = {
    accessKey: opts.accessKey,
    secretKey: opts.secretKey,
    region: opts.region ?? 'us-east-1'
  };
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, LiveUpload>();
  const requests: SigV4RequestLog[] = [];
  let uploadSeq = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const rawUrl = req.url ?? '/';
      const rawQuery = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
      const url = new URL(rawUrl, `http://${req.headers.host ?? '127.0.0.1'}`);
      const pathname = rawUrl.includes('?') ? rawUrl.slice(0, rawUrl.indexOf('?')) : rawUrl;
      const [, bucket, ...rest] = url.pathname.split('/');
      const key = rest.map((segment) => decodeURIComponent(segment)).join('/');
      const q = url.searchParams;
      const uploadId = q.get('uploadId') ?? undefined;
      const method = req.method ?? 'GET';
      const body = await readBody(req);

      const log: SigV4RequestLog = { op: 'Unsupported', status: 0, code: '', authStyle: 'none' };
      if (key) log.key = key;
      if (uploadId) log.uploadId = uploadId;
      requests.push(log);

      // AUTHENTICATE FIRST — a wrong credential must never reach the state
      // machine, which is exactly how the real store behaves.
      const refusal = q.has('X-Amz-Signature')
        ? verifyQueryAuth(req, pathname, rawQuery, url, creds, Date.now(), log)
        : verifyHeaderAuth(req, pathname, rawQuery, body, creds, log);
      if (refusal) {
        log.status = refusal.status;
        log.code = refusal.code;
        sendError(res, refusal);
        return;
      }

      if (bucket !== opts.bucket) {
        log.status = 404;
        log.code = 'NoSuchBucket';
        sendError(res, { status: 404, code: 'NoSuchBucket', message: 'The specified bucket does not exist' });
        return;
      }

      const ok = (op: SigV4RequestLog['op'], status: number): void => {
        log.op = op;
        log.status = status;
        log.code = 'OK';
      };

      // GET /<bucket>?location — region lookup (no region configured).
      if (method === 'GET' && !key && q.has('location')) {
        ok('GetBucketLocation', 200);
        sendXml(res, 200, `<LocationConstraint>${creds.region}</LocationConstraint>`);
        return;
      }

      // GET /<bucket>?uploads — list in-progress multipart uploads.
      if (method === 'GET' && !key && q.has('uploads')) {
        const prefix = q.get('prefix') ?? '';
        const entries = [...uploads.values()]
          .filter((u) => u.key.startsWith(prefix))
          .map(
            (u) =>
              `<Upload><Key>${xmlEscape(u.key)}</Key><UploadId>${xmlEscape(u.uploadId)}</UploadId>` +
              `<StorageClass>STANDARD</StorageClass>` +
              `<Initiated>${u.initiated.toISOString()}</Initiated></Upload>`
          )
          .join('');
        ok('ListMultipartUploads', 200);
        sendXml(
          res,
          200,
          `<ListMultipartUploadsResult><Bucket>${xmlEscape(opts.bucket)}</Bucket>` +
            `<KeyMarker></KeyMarker><UploadIdMarker></UploadIdMarker><MaxUploads>1000</MaxUploads>` +
            `<IsTruncated>false</IsTruncated>${entries}</ListMultipartUploadsResult>`
        );
        return;
      }

      // POST /<bucket>/<key>?uploads — CreateMultipartUpload (multipart init).
      if (method === 'POST' && key && q.has('uploads')) {
        uploadSeq += 1;
        const id = `upload-${uploadSeq}`;
        uploads.set(id, { uploadId: id, key, initiated: new Date(), parts: new Map() });
        log.uploadId = id;
        ok('CreateMultipartUpload', 200);
        sendXml(
          res,
          200,
          `<InitiateMultipartUploadResult><Bucket>${xmlEscape(opts.bucket)}</Bucket>` +
            `<Key>${xmlEscape(key)}</Key><UploadId>${xmlEscape(id)}</UploadId>` +
            `</InitiateMultipartUploadResult>`
        );
        return;
      }

      // PUT /<bucket>/<key>?partNumber=N&uploadId=... — stage one part.
      if (method === 'PUT' && key && uploadId && q.has('partNumber')) {
        const partNumber = Number(q.get('partNumber'));
        log.partNumber = partNumber;
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) {
          log.op = 'UploadPart';
          log.status = 404;
          log.code = 'NoSuchUpload';
          sendError(res, { status: 404, code: 'NoSuchUpload', message: 'The specified multipart upload does not exist.' });
          return;
        }
        const etag = md5Hex(body);
        upload.parts.set(partNumber, { partNumber, etag, body, lastModified: new Date() });
        ok('UploadPart', 200);
        res.writeHead(200, { etag: `"${etag}"`, 'content-length': 0 });
        res.end();
        return;
      }

      // POST /<bucket>/<key>?uploadId=... — CompleteMultipartUpload.
      if (method === 'POST' && key && uploadId) {
        log.op = 'CompleteMultipartUpload';
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) {
          log.status = 404;
          log.code = 'NoSuchUpload';
          sendError(res, { status: 404, code: 'NoSuchUpload', message: 'The specified multipart upload does not exist.' });
          return;
        }
        const requested = parseCompleteBody(body.toString('utf8'));
        if (requested.length === 0) {
          log.status = 400;
          log.code = 'InvalidRequest';
          sendError(res, { status: 400, code: 'InvalidRequest', message: 'You must specify at least one part' });
          return;
        }
        for (let i = 1; i < requested.length; i++) {
          if (requested[i]!.partNumber <= requested[i - 1]!.partNumber) {
            log.status = 400;
            log.code = 'InvalidPartOrder';
            sendError(res, {
              status: 400,
              code: 'InvalidPartOrder',
              message: 'The list of parts was not in ascending order.'
            });
            return;
          }
        }
        const bodies: Buffer[] = [];
        for (const want of requested) {
          const staged = upload.parts.get(want.partNumber);
          if (!staged || staged.etag !== want.etag) {
            log.status = 400;
            log.code = 'InvalidPart';
            sendError(res, {
              status: 400,
              code: 'InvalidPart',
              message: 'One or more of the specified parts could not be found, or the entity tag did not match.'
            });
            return;
          }
          bodies.push(staged.body);
        }
        const assembled = Buffer.concat(bodies);
        objects.set(key, assembled);
        uploads.delete(uploadId);
        ok('CompleteMultipartUpload', 200);
        sendXml(
          res,
          200,
          `<CompleteMultipartUploadResult><Location>http://127.0.0.1/${xmlEscape(opts.bucket)}/${xmlEscape(key)}</Location>` +
            `<Bucket>${xmlEscape(opts.bucket)}</Bucket><Key>${xmlEscape(key)}</Key>` +
            `<ETag>&quot;${md5Hex(assembled)}-${requested.length}&quot;</ETag></CompleteMultipartUploadResult>`
        );
        return;
      }

      // DELETE /<bucket>/<key>?uploadId=... — abort.
      if (method === 'DELETE' && key && uploadId) {
        if (!uploads.delete(uploadId)) {
          log.op = 'AbortMultipartUpload';
          log.status = 404;
          log.code = 'NoSuchUpload';
          sendError(res, { status: 404, code: 'NoSuchUpload', message: 'The specified multipart upload does not exist.' });
          return;
        }
        ok('AbortMultipartUpload', 204);
        res.writeHead(204, { 'content-length': 0 });
        res.end();
        return;
      }

      // GET /<bucket>/<key>?uploadId=... — list staged parts.
      if (method === 'GET' && key && uploadId) {
        const upload = uploads.get(uploadId);
        if (!upload) {
          log.op = 'ListParts';
          log.status = 404;
          log.code = 'NoSuchUpload';
          sendError(res, { status: 404, code: 'NoSuchUpload', message: 'The specified multipart upload does not exist.' });
          return;
        }
        const entries = [...upload.parts.values()]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map(
            (p) =>
              `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>&quot;${p.etag}&quot;</ETag>` +
              `<Size>${p.body.length}</Size><LastModified>${p.lastModified.toISOString()}</LastModified></Part>`
          )
          .join('');
        ok('ListParts', 200);
        sendXml(
          res,
          200,
          `<ListPartsResult><Bucket>${xmlEscape(opts.bucket)}</Bucket><Key>${xmlEscape(upload.key)}</Key>` +
            `<UploadId>${xmlEscape(upload.uploadId)}</UploadId><IsTruncated>false</IsTruncated>` +
            `${entries}</ListPartsResult>`
        );
        return;
      }

      // PUT /<bucket>/<key> — single-shot write.
      if (method === 'PUT' && key) {
        objects.set(key, body);
        ok('PutObject', 200);
        res.writeHead(200, { etag: `"${md5Hex(body)}"`, 'content-length': 0 });
        res.end();
        return;
      }

      // GET/HEAD /<bucket>/<key> — read a committed object back.
      if ((method === 'GET' || method === 'HEAD') && key) {
        const stored = objects.get(key);
        if (!stored) {
          log.op = 'GetObject';
          log.status = 404;
          log.code = 'NoSuchKey';
          sendError(res, { status: 404, code: 'NoSuchKey', message: 'The specified key does not exist.' });
          return;
        }
        ok('GetObject', 200);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': stored.length,
          etag: `"${md5Hex(stored)}"`
        });
        res.end(method === 'HEAD' ? undefined : stored);
        return;
      }

      log.status = 501;
      log.code = 'NotImplemented';
      sendError(res, { status: 501, code: 'NotImplemented', message: `${method} ${rawUrl} is not implemented` });
    })().catch(() => {
      if (!res.headersSent) {
        sendError(res, { status: 500, code: 'InternalError', message: 'fixture failure' });
      } else {
        res.destroy();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    accessKey: creds.accessKey,
    secretKey: creds.secretKey,
    region: creds.region,
    bucket: opts.bucket,
    objects,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}
