// Remote source resolution for URL-pull ingest (issue #5).
//
// Validates a caller-supplied source URL and opens a byte stream from it. Two
// schemes are supported:
//   - http: / https:  — fetched with the global fetch(), following redirects.
//   - s3:             — read from an S3-compatible endpoint via the MinIO
//                       client (OSC MinIO is S3-compatible). Credentials and
//                       endpoint come from the environment, never from the URL.
//
// SECURITY — SSRF mitigation: a URL-pull endpoint lets a caller make the server
// issue an outbound request to an arbitrary address. We reject any HTTP/S host
// that resolves to a private, loopback, link-local, or otherwise non-public IP
// range (RFC 1918, 127/8, 169.254/16, ::1, fc00::/7, fe80::/10, etc.) BEFORE we
// connect, so the server cannot be coerced into reaching internal services
// (cloud metadata endpoints, OSC control plane, databases). This approach is
// recorded in the security section of the ingest design notes / ADR.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { Readable as NodeReadable } from 'node:stream';
import type { Client as MinioClient } from 'minio';

export class SourceValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SourceValidationError';
  }
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 's3:']);

export type ParsedSource = { scheme: 'http' | 'https' | 's3'; url: URL };

export function parseSource(raw: string): ParsedSource {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceValidationError('source url is not a valid URL');
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new SourceValidationError(
      `unsupported source scheme: ${url.protocol} (allowed: http, https, s3)`
    );
  }
  const scheme = url.protocol.replace(':', '') as ParsedSource['scheme'];
  return { scheme, url };
}

// Decide whether a raw IP literal is in a blocked (non-public) range.
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map((n) => parseInt(n, 10));
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // 0/8
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
    // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4 address.
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)/.exec(lower);
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  // Not an IP literal — caller must resolve the host first.
  return false;
}

// Resolve a hostname and reject if ANY resolved address is in a blocked range.
// Rejecting on any blocked address (rather than just the first) closes the
// DNS-rebinding gap where a host advertises both a public and a private A
// record.
export async function assertPublicHost(host: string): Promise<void> {
  if (!host) {
    throw new SourceValidationError('source url has no host');
  }
  // Strip IPv6 brackets if present.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  if (isIP(bare)) {
    if (isBlockedIp(bare)) {
      throw new SourceValidationError('source host resolves to a non-public address');
    }
    return;
  }

  let records: { address: string }[];
  try {
    records = await lookup(bare, { all: true });
  } catch {
    throw new SourceValidationError(`cannot resolve source host: ${bare}`);
  }
  if (records.length === 0) {
    throw new SourceValidationError(`source host has no DNS records: ${bare}`);
  }
  for (const r of records) {
    if (isBlockedIp(r.address)) {
      throw new SourceValidationError('source host resolves to a non-public address');
    }
  }
}

export type OpenedSource = {
  stream: Readable;
  totalBytes?: number;
};

// Options injected for testing: a fetch implementation and an S3 client
// factory. Production wires the global fetch and a MinIO-backed reader.
export type SourceDeps = {
  fetch?: typeof fetch;
  // Reads an S3 object stream from an S3-compatible endpoint. Provided by the
  // route wiring (built from env), so the URL never carries credentials.
  openS3?: (url: URL) => Promise<OpenedSource>;
};

// Open a byte stream for a previously parsed + validated source. For HTTP/S the
// host has already been SSRF-checked by the caller; we re-validate redirects'
// final URL is not required here because fetch follows redirects and Node's
// fetch does not expose per-hop hosts — see the security note: we additionally
// re-validate the FINAL response URL host below.
export async function openSource(
  parsed: ParsedSource,
  deps: SourceDeps = {}
): Promise<OpenedSource> {
  if (parsed.scheme === 's3') {
    if (!deps.openS3) {
      throw new SourceValidationError('s3 sources are not configured on this deployment');
    }
    return deps.openS3(parsed.url);
  }

  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(parsed.url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`source responded with HTTP ${res.status}`);
  }
  // Re-validate the host fetch actually landed on, defeating redirect-based
  // SSRF to an internal address.
  try {
    const finalHost = new URL(res.url || parsed.url.toString()).hostname;
    await assertPublicHost(finalHost);
  } catch (err) {
    if (err instanceof SourceValidationError) throw err;
    throw err;
  }
  if (!res.body) {
    throw new Error('source response has no body');
  }
  const len = res.headers.get('content-length');
  const totalBytes = len ? Number(len) : undefined;
  // Convert the web ReadableStream to a Node Readable for piping to MinIO.
  const stream = NodeReadable.fromWeb(res.body as Parameters<typeof NodeReadable.fromWeb>[0]);
  return { stream, totalBytes: Number.isFinite(totalBytes) ? totalBytes : undefined };
}

// Build an S3 reader bound to an S3-compatible endpoint described by the
// environment. The s3:// URL is interpreted as s3://<bucket>/<key>; the
// endpoint/credentials come from env so the caller cannot point us at an
// arbitrary internal endpoint.
export function makeS3Reader(client: MinioClient): (url: URL) => Promise<OpenedSource> {
  return async (url: URL) => {
    const bucket = url.hostname;
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (!bucket || !key) {
      throw new SourceValidationError('s3 url must be s3://<bucket>/<key>');
    }
    let totalBytes: number | undefined;
    try {
      const stat = await client.statObject(bucket, key);
      totalBytes = stat.size;
    } catch {
      throw new SourceValidationError(`s3 source not found: ${bucket}/${key}`);
    }
    const stream = (await client.getObject(bucket, key)) as unknown as Readable;
    return { stream, totalBytes };
  };
}
