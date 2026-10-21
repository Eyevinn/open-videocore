// An in-process, S3-compatible object store that implements the MULTIPART
// upload protocol the way a real object store does (issue #1088).
//
// Why this exists: every other storage test in this repo fakes
// `WorkspaceStorage` itself, so the multipart state machine inside the storage
// client — initiate / upload-part / list-parts / complete / abort, and in
// particular its RESUME path (`findUploadId` + `listParts`) — is never
// exercised. The #1088 defect lives entirely in that state machine: a write that
// fails part-way leaves the upload open, and the next write for the same key
// resumes it under part numbers that do not line up with the ones the server
// staged, so the assembled object can carry a duplicated or wrong-offset part.
// Proving that regression shut needs a server that really stages parts, really
// lists them back, and really enforces the ordering rules on completion.
//
// Scope: multipart semantics only. Request signatures are NOT verified here
// (test/s3-presigned-verifier.ts is the fixture that does verify AWS SigV4);
// this one accepts any credentials so the test it backs stays about part
// numbering. The 5 MiB minimum-part-size rule is likewise not enforced, since
// the client under test picks the part size.
//
// Contract sources verified before writing (per CLAUDE.md rule 7) — every wire
// shape below is taken from the storage client that will talk to it, not guessed:
//   - CreateMultipartUpload: POST /<bucket>/<key>?uploads, response parsed by
//     `parseInitiateMultipart` which requires
//     InitiateMultipartUploadResult/UploadId —
//     node_modules/minio/dist/esm/internal/client.mjs:1112-1122 and
//     node_modules/minio/dist/esm/internal/xml-parser.mjs:365-375.
//   - UploadPart: PUT /<bucket>/<key>?partNumber=<n>&uploadId=<id>, expects 200
//     and reads the part etag off the `etag` response header —
//     client.mjs:1480-1505 (the `options.query` built with qs.stringify, then
//     `response.headers.etag`).
//   - ListMultipartUploads: GET /<bucket>?uploads&delimiter=&max-uploads=1000
//     &prefix=<key>, response parsed by `parseListMultipart` which reads
//     ListMultipartUploadsResult/{IsTruncated,NextKeyMarker,Upload{Key,UploadId,
//     Initiated}} — client.mjs:1055-1095, xml-parser.mjs:434-471. `findUploadId`
//     keeps the upload with the LATEST `Initiated` for an exact key match —
//     client.mjs:1143-1171.
//   - ListParts: GET /<bucket>/<key>?uploadId=<id>[&part-number-marker=<n>],
//     response parsed by `parseListParts` which reads
//     ListPartsResult/{IsTruncated,NextPartNumberMarker,Part{PartNumber,ETag,
//     Size,LastModified}} and strips quotes off ETag — client.mjs:1261-1288,
//     xml-parser.mjs:286-317. The resume path compares that etag against the
//     md5 HEX of the chunk (client.mjs:1467-1479), so part etags here are md5
//     hex, exactly as S3 defines them.
//   - CompleteMultipartUpload: POST /<bucket>/<key>?uploadId=<id> with a
//     CompleteMultipartUpload/Part{PartNumber,ETag} body built by xml2js, and a
//     CompleteMultipartUploadResult/{Location,Bucket,Key,ETag} response —
//     client.mjs:1176-1232, xml-parser.mjs:409-432.
//   - AbortMultipartUpload: DELETE /<bucket>/<key>?uploadId=<id>, expects 204 —
//     client.mjs:1132-1142.
//   - Single-shot PutObject (bodies at or below the part size never reach the
//     multipart path): PUT /<bucket>/<key>, expects 200 + `etag` header —
//     client.mjs:1396-1404 (`uploadBuffer`).
//   - GetObject: GET /<bucket>/<key>, expects 200 + body — client.mjs
//     `getObject`/`getPartialObject`, used here only to read a committed object
//     back through the real client.
//   - Retry behaviour that shaped the failure injection below: the client
//     internally retries 408/429/499/500/502/503/504/520 once
//     (`retryHttpCodes` / `isHttpRetryable`,
//     node_modules/minio/dist/esm/internal/request.mjs:22-34, applied by
//     `requestWithRetry` at request.mjs:43-74), while a transport error is
//     re-thrown unretried (request.mjs:56-69) — so a fixture that wants a
//     SINGLE observable failure must break the connection rather than answer
//     with a 5xx.
//   - Part ordering on completion (the rule that makes the #1088 numbering bug
//     observable): S3 requires the part list to be in ascending part-number
//     order, and rejects a list that is not with InvalidPartOrder. Mirrored in
//     `completeUpload` below.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export type StagedPart = {
  partNumber: number;
  etag: string;
  body: Buffer;
  lastModified: Date;
};

export type LiveUpload = {
  uploadId: string;
  key: string;
  initiated: Date;
  parts: Map<number, StagedPart>;
};

// One handled request, so a test can assert HOW an object was written: how many
// uploads were initiated, whether an abort was issued between attempts, and
// which part numbers the client actually staged.
export type MultipartRequestLog = {
  op:
    | 'CreateMultipartUpload'
    | 'UploadPart'
    | 'ListMultipartUploads'
    | 'ListParts'
    | 'CompleteMultipartUpload'
    | 'AbortMultipartUpload'
    | 'PutObject'
    | 'GetObject'
    | 'GetBucketLocation'
    | 'Unsupported';
  key?: string;
  uploadId?: string;
  partNumber?: number;
  status: number;
};

export type MultipartObjectStore = {
  /** `http://127.0.0.1:<port>` — hand the host/port to the storage client. */
  endpoint: string;
  host: string;
  port: number;
  accessKey: string;
  secretKey: string;
  region: string;
  /** Committed objects, keyed by object key. */
  objects: Map<string, Buffer>;
  /** Multipart uploads that were initiated and never completed or aborted. */
  liveUploads(): LiveUpload[];
  requests: MultipartRequestLog[];
  close(): Promise<void>;
};

export type MultipartObjectStoreOptions = {
  bucket: string;
  /**
   * Called before each UploadPart is staged, with the 1-based count of
   * UploadPart requests the server has seen. Returning true makes the server
   * drop the connection after reading the body — the client surfaces that as a
   * socket error, which is NOT internally retried (request.mjs:56-69), so it
   * models a single mid-stream transfer failure.
   */
  failUploadPart?: (seq: number) => boolean;
};

function md5Hex(body: Buffer): string {
  return createHash('md5').update(body).digest('hex');
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

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendXml(
    res,
    status,
    `<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`
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

// Strip the quoting S3 clients may or may not round-trip on an etag.
function unquoteEtag(value: string): string {
  return value.trim().replace(/^"+|"+$/g, '').replace(/^&quot;|&quot;$/g, '');
}

// The CompleteMultipartUpload body, as built by the storage client's xml2js
// Builder (client.mjs:1194-1207): a CompleteMultipartUpload element with one
// Part child per etag, each carrying PartNumber and ETag.
function parseCompleteBody(xml: string): { partNumber: number; etag: string }[] {
  const parts: { partNumber: number; etag: string }[] = [];
  for (const match of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
    const block = match[1] ?? '';
    const partNumber = Number(/<PartNumber>\s*(\d+)\s*<\/PartNumber>/.exec(block)?.[1]);
    const etag = unquoteEtag(/<ETag>([\s\S]*?)<\/ETag>/.exec(block)?.[1] ?? '');
    if (Number.isFinite(partNumber)) {
      parts.push({ partNumber, etag });
    }
  }
  return parts;
}

/**
 * Start the multipart-capable object store on an ephemeral loopback port.
 * Path-style addressing only (`/<bucket>/<key>`), which is what the storage
 * client uses against an IP-literal endpoint.
 */
export async function startMultipartObjectStore(
  opts: MultipartObjectStoreOptions
): Promise<MultipartObjectStore> {
  const accessKey = 'test-access-key';
  const secretKey = 'test-secret-key';
  const region = 'us-east-1';
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, LiveUpload>();
  const requests: MultipartRequestLog[] = [];
  let uploadSeq = 0;
  let partSeq = 0;

  const log = (entry: MultipartRequestLog): MultipartRequestLog => {
    requests.push(entry);
    return entry;
  };

  function listUploadsXml(prefix: string): string {
    const matching = [...uploads.values()].filter((u) => u.key.startsWith(prefix));
    const entries = matching
      .map(
        (u) =>
          `<Upload><Key>${xmlEscape(u.key)}</Key><UploadId>${xmlEscape(u.uploadId)}</UploadId>` +
          `<StorageClass>STANDARD</StorageClass>` +
          `<Initiated>${u.initiated.toISOString()}</Initiated></Upload>`
      )
      .join('');
    return (
      `<ListMultipartUploadsResult><Bucket>${xmlEscape(opts.bucket)}</Bucket>` +
      `<KeyMarker></KeyMarker><UploadIdMarker></UploadIdMarker>` +
      `<MaxUploads>1000</MaxUploads><IsTruncated>false</IsTruncated>` +
      `${entries}</ListMultipartUploadsResult>`
    );
  }

  function listPartsXml(upload: LiveUpload): string {
    const entries = [...upload.parts.values()]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map(
        (p) =>
          `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>&quot;${p.etag}&quot;</ETag>` +
          `<Size>${p.body.length}</Size>` +
          `<LastModified>${p.lastModified.toISOString()}</LastModified></Part>`
      )
      .join('');
    return (
      `<ListPartsResult><Bucket>${xmlEscape(opts.bucket)}</Bucket>` +
      `<Key>${xmlEscape(upload.key)}</Key><UploadId>${xmlEscape(upload.uploadId)}</UploadId>` +
      `<IsTruncated>false</IsTruncated>${entries}</ListPartsResult>`
    );
  }

  // Assemble the object, enforcing the S3 completion rules that make a
  // mis-numbered resume observable instead of silent: the part list must be in
  // strictly ascending part-number order, and every part it names must exist
  // with the etag the client claims.
  function completeUpload(
    res: ServerResponse,
    upload: LiveUpload,
    requested: { partNumber: number; etag: string }[],
    entry: MultipartRequestLog
  ): void {
    if (requested.length === 0) {
      entry.status = 400;
      sendError(res, 400, 'InvalidRequest', 'You must specify at least one part');
      return;
    }
    for (let i = 1; i < requested.length; i++) {
      if (requested[i]!.partNumber <= requested[i - 1]!.partNumber) {
        entry.status = 400;
        sendError(
          res,
          400,
          'InvalidPartOrder',
          'The list of parts was not in ascending order. Parts must be ordered by part number.'
        );
        return;
      }
    }
    const bodies: Buffer[] = [];
    for (const want of requested) {
      const staged = upload.parts.get(want.partNumber);
      if (!staged || staged.etag !== want.etag) {
        entry.status = 400;
        sendError(
          res,
          400,
          'InvalidPart',
          'One or more of the specified parts could not be found, or the entity tag did not match.'
        );
        return;
      }
      bodies.push(staged.body);
    }
    const body = Buffer.concat(bodies);
    objects.set(upload.key, body);
    uploads.delete(upload.uploadId);
    entry.status = 200;
    sendXml(
      res,
      200,
      `<CompleteMultipartUploadResult><Location>http://127.0.0.1/${xmlEscape(opts.bucket)}/${xmlEscape(upload.key)}</Location>` +
        `<Bucket>${xmlEscape(opts.bucket)}</Bucket><Key>${xmlEscape(upload.key)}</Key>` +
        `<ETag>&quot;${md5Hex(body)}-${requested.length}&quot;</ETag></CompleteMultipartUploadResult>`
    );
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const rawUrl = req.url ?? '/';
      const url = new URL(rawUrl, `http://${req.headers.host ?? '127.0.0.1'}`);
      const [, bucket, ...rest] = url.pathname.split('/');
      const key = rest.map((segment) => decodeURIComponent(segment)).join('/');
      const q = url.searchParams;
      const uploadId = q.get('uploadId') ?? undefined;
      const method = req.method ?? 'GET';

      if (bucket !== opts.bucket) {
        log({ op: 'Unsupported', key, status: 404 });
        sendError(res, 404, 'NoSuchBucket', 'The specified bucket does not exist');
        return;
      }

      // GET /<bucket>?location — the client only asks when no region was
      // configured; answered so the fixture works either way.
      if (method === 'GET' && !key && q.has('location')) {
        log({ op: 'GetBucketLocation', status: 200 });
        sendXml(res, 200, `<LocationConstraint>${region}</LocationConstraint>`);
        return;
      }

      // GET /<bucket>?uploads — list in-progress multipart uploads.
      if (method === 'GET' && !key && q.has('uploads')) {
        const entry = log({ op: 'ListMultipartUploads', status: 200 });
        entry.status = 200;
        sendXml(res, 200, listUploadsXml(q.get('prefix') ?? ''));
        return;
      }

      if (!key) {
        log({ op: 'Unsupported', status: 501 });
        sendError(res, 501, 'NotImplemented', `${method} on the bucket is not implemented`);
        return;
      }

      // POST /<bucket>/<key>?uploads — initiate.
      if (method === 'POST' && q.has('uploads')) {
        await readBody(req);
        uploadSeq += 1;
        const id = `upload-${uploadSeq}`;
        uploads.set(id, { uploadId: id, key, initiated: new Date(), parts: new Map() });
        log({ op: 'CreateMultipartUpload', key, uploadId: id, status: 200 });
        sendXml(
          res,
          200,
          `<InitiateMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket>` +
            `<Key>${xmlEscape(key)}</Key><UploadId>${xmlEscape(id)}</UploadId>` +
            `</InitiateMultipartUploadResult>`
        );
        return;
      }

      // POST /<bucket>/<key>?uploadId=... — complete.
      if (method === 'POST' && uploadId) {
        const body = await readBody(req);
        const entry = log({ op: 'CompleteMultipartUpload', key, uploadId, status: 0 });
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) {
          entry.status = 404;
          sendError(res, 404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
          return;
        }
        completeUpload(res, upload, parseCompleteBody(body.toString('utf8')), entry);
        return;
      }

      // PUT /<bucket>/<key>?partNumber=N&uploadId=... — stage one part.
      if (method === 'PUT' && uploadId && q.has('partNumber')) {
        const partNumber = Number(q.get('partNumber'));
        const body = await readBody(req);
        partSeq += 1;
        const entry = log({ op: 'UploadPart', key, uploadId, partNumber, status: 0 });
        if (opts.failUploadPart?.(partSeq)) {
          // Drop the connection with the part NOT staged: the transfer fails
          // mid-stream and the upload stays open server-side, which is exactly
          // the orphan state #1088 is about.
          entry.status = 0;
          req.destroy();
          res.destroy();
          return;
        }
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) {
          entry.status = 404;
          sendError(res, 404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
          return;
        }
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
          entry.status = 400;
          sendError(res, 400, 'InvalidArgument', 'Part number must be an integer between 1 and 10000.');
          return;
        }
        const etag = md5Hex(body);
        upload.parts.set(partNumber, { partNumber, etag, body, lastModified: new Date() });
        entry.status = 200;
        res.writeHead(200, { etag: `"${etag}"`, 'content-length': 0 });
        res.end();
        return;
      }

      // GET /<bucket>/<key>?uploadId=... — list staged parts.
      if (method === 'GET' && uploadId) {
        const entry = log({ op: 'ListParts', key, uploadId, status: 0 });
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) {
          entry.status = 404;
          sendError(res, 404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
          return;
        }
        entry.status = 200;
        sendXml(res, 200, listPartsXml(upload));
        return;
      }

      // DELETE /<bucket>/<key>?uploadId=... — abort.
      if (method === 'DELETE' && uploadId) {
        const entry = log({ op: 'AbortMultipartUpload', key, uploadId, status: 0 });
        if (!uploads.has(uploadId)) {
          entry.status = 404;
          sendError(res, 404, 'NoSuchUpload', 'The specified multipart upload does not exist.');
          return;
        }
        uploads.delete(uploadId);
        entry.status = 204;
        res.writeHead(204, { 'content-length': 0 });
        res.end();
        return;
      }

      // PUT /<bucket>/<key> — single-shot write (bodies at or below the part
      // size never reach the multipart path).
      if (method === 'PUT') {
        const body = await readBody(req);
        objects.set(key, body);
        log({ op: 'PutObject', key, status: 200 });
        res.writeHead(200, { etag: `"${md5Hex(body)}"`, 'content-length': 0 });
        res.end();
        return;
      }

      // GET/HEAD /<bucket>/<key> — read a committed object back.
      if (method === 'GET' || method === 'HEAD') {
        const stored = objects.get(key);
        if (!stored) {
          log({ op: 'GetObject', key, status: 404 });
          sendError(res, 404, 'NoSuchKey', 'The specified key does not exist.');
          return;
        }
        log({ op: 'GetObject', key, status: 200 });
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': stored.length,
          etag: `"${md5Hex(stored)}"`
        });
        res.end(method === 'HEAD' ? undefined : stored);
        return;
      }

      log({ op: 'Unsupported', key, status: 501 });
      sendError(res, 501, 'NotImplemented', `${method} ${rawUrl} is not implemented`);
    })().catch(() => {
      // A fixture-side fault must surface as a storage error to the client, not
      // as an unhandled rejection that kills the test run.
      if (!res.headersSent) {
        sendError(res, 500, 'InternalError', 'fixture failure');
      } else {
        res.destroy();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    host: '127.0.0.1',
    port,
    accessKey,
    secretKey,
    region,
    objects,
    liveUploads: () => [...uploads.values()],
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}
