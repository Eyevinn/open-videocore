// `cpix` key provider — CPIX 2.3 / SPEKE over HTTPS (ADR-008 D1, §5.2, §6,
// §10, §11, §12; issue #1261).
//
// One adapter per PROTOCOL, never per vendor (ADR-008 D1). This file is the
// transport half of that adapter: it builds the request document with the
// already-landed builder (#1260), POSTs it over HTTPS with the configured auth
// mode, applies the retry/deadline policy of ADR-008 §12, hands the body to the
// size-capped parser (cpix-response.ts) and returns the port's shape.
//
// CONTRACT SOURCES (contract-first, CLAUDE.md rule 7):
//   - src/drm/key-provider.ts — `KeyProvider`, `KeyRequest`, `ContentKey`,
//     `DrmSignalling`, `DrmSystemId` (ADR-008 §5.1, landed by #1260). The
//     interface this class implements, imported and not restated.
//   - src/drm/cpix-request.ts — `buildCpixRequest`, `CpixRequestOptions`,
//     `SpekeVersion`, `CpixExtensionNamespace`, `VideoPixelBounds` (#1260).
//   - src/types/drm.ts — `DrmErrorCode` via `KeyProviderError` (ADR-008 §8).
//   - ADR-008 §5.2 — the configuration model (`keyServerUrl`, `spekeVersion`,
//     `authMode`, `licenceUrls`, `certificateUrl`, `providerId`) and the EXACT
//     credential env var names:
//       `DRM_KEY_PROVIDER_USERNAME` / `DRM_KEY_PROVIDER_PASSWORD`  (basic)
//       `DRM_KEY_PROVIDER_TOKEN`                                   (bearer)
//       `DRM_KEY_PROVIDER_CLIENT_CERT` / `DRM_KEY_PROVIDER_CLIENT_KEY` (mtls,
//       "PEM, or a path").
//   - ADR-008 §12 — the failure table this file implements verbatim: 5xx /
//     unreachable / timeout => up to 3 attempts, exponential backoff with
//     jitter, whole-step deadline 60 s, then `key_provider_unreachable`; 4xx =>
//     NO retry, `key_provider_rejected`; malformed CPIX => no retry,
//     `key_provider_invalid_response`.
//   - ADR-008 §10 — `keyServerUrl` must be `https:`; the adapter logs method,
//     host, status, latency and `contentId` ONLY; provider error bodies are
//     never echoed; credentials never reach the parameter store, a response or
//     a log line.
//   - Node 22 APIs used: `https.request(options)` accepting `cert`/`key`/
//     `signal` and `AbortSignal.any()` / `AbortSignal.timeout()` (the repo's
//     own precedent for bounded external calls is
//     src/encore-scaler/callback-trust-probe.ts:294 and
//     src/services/webhook-dispatcher.ts:109).
//
// NAMING (CLAUDE.md rule 1): the adapter is named after the PROTOCOL, and a DRM
// system is identified by its registered system id. No vendor, company or
// product name appears in this file.
//
// NO KEY MATERIAL ANYWHERE BUT THE RETURN VALUE (ADR-008 D4/§10): the response
// body is held in a local for the duration of the parse, the parsed keys are
// returned to the caller, and nothing in between is logged, stored or attached
// to an error.

import { request as httpsRequest } from 'node:https';

import type { DrmSystemId } from '../types/drm.js';
import {
  buildCpixRequest,
  type CpixExtensionNamespace,
  type SpekeVersion,
  type VideoPixelBounds
} from './cpix-request.js';
import {
  MAX_CPIX_RESPONSE_BYTES,
  cpixResponseByteLength,
  parseCpixResponse,
  type CpixResponseParseDeps
} from './cpix-response.js';
import { KeyProviderError } from './key-provider-error.js';
import type {
  ContentKey,
  DrmSignalling,
  KeyProvider,
  KeyRequest,
  TrackTypeGroup
} from './key-provider.js';

// Auth modes of ADR-008 §5.2 `authMode`.
export const CPIX_AUTH_MODES = ['basic', 'bearer', 'mtls'] as const;
export type CpixAuthMode = (typeof CPIX_AUTH_MODES)[number];

// Credential env var names, verbatim from ADR-008 §5.2. Exported so the config
// surface (`GET /api/v1/drm/config` reporting `credentials: configured |
// missing`, §9) and any operator doc read the same constants instead of
// retyping the strings.
export const ENV_USERNAME = 'DRM_KEY_PROVIDER_USERNAME';
export const ENV_PASSWORD = 'DRM_KEY_PROVIDER_PASSWORD';
export const ENV_TOKEN = 'DRM_KEY_PROVIDER_TOKEN';
export const ENV_CLIENT_CERT = 'DRM_KEY_PROVIDER_CLIENT_CERT';
export const ENV_CLIENT_KEY = 'DRM_KEY_PROVIDER_CLIENT_KEY';

// ADR-008 §12: "Up to 3 attempts, exponential backoff with jitter, whole-step
// deadline 60 s".
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_DEADLINE_MS = 60_000;
// First backoff; attempt n waits BASE * 2^(n-1) with jitter. 500ms/1s keeps all
// three attempts well inside the 60 s whole-step budget.
export const DEFAULT_BACKOFF_BASE_MS = 500;

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

// One POST of one CPIX document. A function, not a class, so a test can supply
// a loopback implementation (the Fastify CPIX stub) without a TLS certificate,
// while production uses `createHttpsCpixTransport()` below. The retry policy,
// the size cap and the error mapping all live ABOVE this seam, so a test
// transport cannot accidentally reimplement them.
export type CpixHttpRequest = {
  url: string;
  // Header NAMES only in this record's keys; values may be credentials, so
  // nothing ever logs this object.
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  // `authMode: 'mtls'` client credentials, already resolved to PEM text.
  clientCert?: { cert: string; key: string };
  // Stop reading once the body exceeds this (the transport sets `truncated`).
  maxResponseBytes: number;
};

export type CpixHttpResponse = {
  status: number;
  body: string;
  // True when the peer sent more than `maxResponseBytes` and the read was cut
  // short. The caller rejects without parsing either way; this only records
  // that the body on the wire was even bigger than what is in `body`.
  truncated?: boolean;
};

export type CpixHttpTransport = (req: CpixHttpRequest) => Promise<CpixHttpResponse>;

// Production transport: `node:https`.
//
// WHY NOT `fetch`. The `mtls` auth mode needs a client certificate and private
// key on the TLS handshake. Node's global `fetch` has no option for that (it
// would need an injected undici dispatcher, i.e. a new runtime dependency —
// ADR-008 §11 adds exactly ONE dependency and it is the XML parser), while
// `https.request` takes `cert`/`key` directly. One transport for all three auth
// modes is also one place where the `https:` scheme, the body cap and the abort
// signal are enforced.
export function createHttpsCpixTransport(): CpixHttpTransport {
  return (req) =>
    new Promise<CpixHttpResponse>((resolve, reject) => {
      const url = new URL(req.url);
      if (url.protocol !== 'https:') {
        // Defence in depth: `CpixProvider`'s constructor already rejected a
        // non-https URL (ADR-008 §10 "Transport"). Nothing may send a key
        // request in the clear.
        reject(new KeyProviderError('drm_not_configured', 'key server url must use https'));
        return;
      }
      const body = Buffer.from(req.body, 'utf8');
      const clientRequest = httpsRequest(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port === '' ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: { ...req.headers, 'content-length': String(body.byteLength) },
          signal: req.signal,
          ...(req.clientCert ? { cert: req.clientCert.cert, key: req.clientCert.key } : {})
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          res.on('data', (chunk: Buffer) => {
            if (truncated) return;
            size += chunk.byteLength;
            if (size > req.maxResponseBytes) {
              // Stop buffering an unbounded body from a network peer
              // (ADR-008 §10 "Bounded response size").
              truncated = true;
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              ...(truncated ? { truncated: true } : {})
            })
          );
          res.on('close', () => {
            if (truncated) {
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
                truncated: true
              });
            }
          });
          res.on('error', reject);
        }
      );
      clientRequest.on('error', reject);
      clientRequest.end(body);
    });
}

// ---------------------------------------------------------------------------
// Logging surface
// ---------------------------------------------------------------------------

// Minimal logger (compatible with Fastify's), injected — the same pattern as
// `DispatcherLogger` (src/services/webhook-dispatcher.ts:28).
//
// WHAT MAY BE LOGGED (ADR-008 §10): method, host, HTTP status, latency,
// `contentId`, attempt number, `providerId` and an `errorCode`. NOTHING ELSE.
// Every call site below passes exactly `CpixLogFields`, so there is no code
// path that can hand this logger a response body, a credential or a key.
export type CpixLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type CpixLogFields = {
  method: 'POST';
  host: string;
  status?: number;
  latencyMs: number;
  contentId: string;
  attempt: number;
  providerId: string;
  errorCode?: string;
};

const noopLogger: CpixLogger = { info: () => {}, warn: () => {} };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type CpixProviderOptions = {
  // ADR-008 §5.2 `providerId`.
  id?: string;
  // ADR-008 §5.2 `keyServerUrl`. MUST be `https:` — enforced in the
  // constructor, not at call time (issue #1261 constraint).
  keyServerUrl: string;
  spekeVersion: SpekeVersion;
  authMode: CpixAuthMode;
  // ADR-008 §5.2 — configuration, not response data (no CPIX element carries
  // them). Overlaid onto the parsed signalling.
  licenceUrls?: Record<DrmSystemId, string>;
  certificateUrl?: string;
  // Forwarded verbatim to `buildCpixRequest` (#1260).
  extensionNamespace?: CpixExtensionNamespace;
  videoPixelBounds?: Partial<Record<TrackTypeGroup, VideoPixelBounds>>;
  newKeyId?: () => string;
  // Injected seams. Production leaves all of them unset.
  transport?: CpixHttpTransport;
  // Credential source. Defaults to `process.env`, read at CALL time so an
  // operator's rotated credential is picked up without a restart (the same
  // call-time convention as `drmEnabled()`, src/types/drm.ts).
  env?: NodeJS.ProcessEnv;
  // Resolves a PEM from an env value that is a FILE PATH (ADR-008 §5.2 "PEM,
  // or a path"). Injected so a test never needs a certificate on disk.
  readPem?: (path: string) => Promise<string>;
  log?: CpixLogger;
  maxAttempts?: number;
  deadlineMs?: number;
  // Per-attempt bound. Unset = the whole remaining deadline, which is the
  // ADR-008 §12 wording ("whole-step deadline 60 s").
  attemptTimeoutMs?: number;
  backoffBaseMs?: number;
  maxResponseBytes?: number;
  // Jitter source and the sleep, injected so retry timing is deterministic in
  // tests and no test has to wait out a real backoff.
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  // Parser seam, forwarded to `parseCpixResponse` (see
  // `CpixResponseParseDeps`).
  parseDeps?: CpixResponseParseDeps;
};

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    // A backoff must not outlive the whole-step deadline.
    signal.addEventListener('abort', done, { once: true });
  });
}

// Read a PEM credential that may be given inline or as a path (ADR-008 §5.2).
// A value containing a PEM armour line is used as-is; anything else is treated
// as a path. The value itself is NEVER logged, and a read failure reports only
// WHICH env var failed, never its content.
async function resolvePem(
  value: string,
  envName: string,
  readPem: (path: string) => Promise<string>
): Promise<string> {
  if (value.includes('-----BEGIN')) return value;
  try {
    return await readPem(value);
  } catch {
    throw new KeyProviderError(
      'drm_not_configured',
      `could not read the PEM referenced by ${envName}`
    );
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class CpixProvider implements KeyProvider {
  readonly id: string;
  readonly kind = 'cpix' as const;

  private readonly keyServerUrl: string;
  private readonly host: string;
  private readonly spekeVersion: SpekeVersion;
  private readonly authMode: CpixAuthMode;
  private readonly licenceUrls: Record<DrmSystemId, string>;
  private readonly certificateUrl: string | undefined;
  private readonly extensionNamespace: CpixExtensionNamespace | undefined;
  private readonly videoPixelBounds:
    | Partial<Record<TrackTypeGroup, VideoPixelBounds>>
    | undefined;
  private readonly newKeyId: (() => string) | undefined;
  private readonly transport: CpixHttpTransport;
  private readonly env: NodeJS.ProcessEnv;
  private readonly readPem: (path: string) => Promise<string>;
  private readonly log: CpixLogger;
  private readonly maxAttempts: number;
  private readonly deadlineMs: number;
  private readonly attemptTimeoutMs: number | undefined;
  private readonly backoffBaseMs: number;
  private readonly maxResponseBytes: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly parseDeps: CpixResponseParseDeps;

  constructor(options: CpixProviderOptions) {
    // CONSTRUCTION-TIME scheme check (issue #1261 constraint; ADR-008 §10
    // "Transport": "`keyServerUrl` must be `https:`; an `http:` URL is rejected
    // at config write time").
    //
    // WHY NOT AT CALL TIME: the provider is built when the stack's DRM
    // configuration is resolved, so refusing here turns a misconfigured stack
    // into an immediate, visible failure instead of a per-asset one discovered
    // after a key has already been requested in the clear. It also makes it
    // impossible to hold an instance of this class that CAN send a cleartext
    // key request — the same reasoning as `ClearKeyDevProvider`'s
    // production refusal (clearkey-dev-provider.ts).
    let parsed: URL;
    try {
      parsed = new URL(options.keyServerUrl);
    } catch {
      throw new KeyProviderError('drm_not_configured', 'key server url is not a valid url');
    }
    if (parsed.protocol !== 'https:') {
      throw new KeyProviderError('drm_not_configured', 'key server url must use https');
    }
    if (!CPIX_AUTH_MODES.includes(options.authMode)) {
      throw new KeyProviderError('drm_not_configured', 'unknown key provider auth mode');
    }

    this.id = options.id ?? 'primary';
    this.keyServerUrl = options.keyServerUrl;
    // HOST ONLY — this is the single value that ever reaches a log line, so it
    // is captured without the path, query or any userinfo (ADR-008 §10).
    this.host = parsed.host;
    this.spekeVersion = options.spekeVersion;
    this.authMode = options.authMode;
    this.licenceUrls = { ...(options.licenceUrls ?? {}) };
    this.certificateUrl = options.certificateUrl;
    this.extensionNamespace = options.extensionNamespace;
    this.videoPixelBounds = options.videoPixelBounds;
    this.newKeyId = options.newKeyId;
    this.transport = options.transport ?? createHttpsCpixTransport();
    this.env = options.env ?? process.env;
    this.readPem =
      options.readPem ??
      (async (path) => {
        const { readFile } = await import('node:fs/promises');
        return readFile(path, 'utf8');
      });
    this.log = options.log ?? noopLogger;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.attemptTimeoutMs = options.attemptTimeoutMs;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_CPIX_RESPONSE_BYTES;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.parseDeps = options.parseDeps ?? {};
  }

  // ADR-008 §6 steps 3-5: build the request, POST it, parse the response.
  async acquire(
    req: KeyRequest,
    signal: AbortSignal
  ): Promise<{ keys: ContentKey[]; signalling: DrmSignalling }> {
    // Same already-aborted behaviour as every other adapter
    // (clearkey-dev-provider.ts), so callers behave identically across them.
    signal.throwIfAborted();

    const { document, keyIds } = buildCpixRequest(req, {
      spekeVersion: this.spekeVersion,
      ...(this.extensionNamespace ? { extensionNamespace: this.extensionNamespace } : {}),
      ...(this.videoPixelBounds ? { videoPixelBounds: this.videoPixelBounds } : {}),
      ...(this.newKeyId ? { newKeyId: this.newKeyId } : {})
    });

    const headers = await this.authHeaders();
    const clientCert = await this.clientCert();

    // Whole-step deadline (ADR-008 §12), combined with the caller's signal:
    // whichever fires first ends the step. `AbortSignal.any` keeps the two
    // reasons distinct for the caller while giving the transport one signal.
    const deadline = AbortSignal.timeout(this.deadlineMs);
    const stepSignal = AbortSignal.any([signal, deadline]);
    const startedAt = this.now();

    let lastRetryable: KeyProviderError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (stepSignal.aborted) break;

      const attemptStartedAt = this.now();
      const remainingMs = this.deadlineMs - (attemptStartedAt - startedAt);
      if (remainingMs <= 0) break;
      const attemptBudgetMs =
        this.attemptTimeoutMs === undefined
          ? remainingMs
          : Math.min(this.attemptTimeoutMs, remainingMs);
      const attemptSignal = AbortSignal.any([stepSignal, AbortSignal.timeout(attemptBudgetMs)]);

      let response: CpixHttpResponse;
      try {
        response = await this.transport({
          url: this.keyServerUrl,
          headers,
          body: document,
          signal: attemptSignal,
          maxResponseBytes: this.maxResponseBytes,
          ...(clientCert ? { clientCert } : {})
        });
      } catch {
        // NETWORK failure or timeout — the transport's error object can carry
        // the peer's socket detail, so it is dropped entirely rather than
        // wrapped (ADR-008 §10). Retryable (ADR-008 §12).
        const latencyMs = this.now() - attemptStartedAt;
        this.logFailure({
          method: 'POST',
          host: this.host,
          latencyMs,
          contentId: req.contentId,
          attempt,
          providerId: this.id,
          errorCode: 'key_provider_unreachable'
        });
        lastRetryable = new KeyProviderError(
          'key_provider_unreachable',
          'key provider request failed or timed out',
          attempt
        );
        await this.backoff(attempt, stepSignal, startedAt);
        continue;
      }

      const latencyMs = this.now() - attemptStartedAt;
      const fields: CpixLogFields = {
        method: 'POST',
        host: this.host,
        status: response.status,
        latencyMs,
        contentId: req.contentId,
        attempt,
        providerId: this.id
      };

      // 5xx (and an absent/0 status from a severed response) — retryable.
      if (response.status >= 500 || response.status === 0) {
        this.logFailure({ ...fields, errorCode: 'key_provider_unreachable' });
        lastRetryable = new KeyProviderError(
          'key_provider_unreachable',
          'key provider returned a server error',
          attempt
        );
        await this.backoff(attempt, stepSignal, startedAt);
        continue;
      }

      // 4xx — a credential or policy verdict. NO RETRY (ADR-008 §12): retrying
      // a rejected credential only multiplies the rejection. The provider's
      // error body is in `response.body` and is discarded unread.
      if (response.status >= 400) {
        this.logFailure({ ...fields, errorCode: 'key_provider_rejected' });
        throw new KeyProviderError(
          'key_provider_rejected',
          `key provider rejected the key request with status ${response.status}`,
          attempt
        );
      }

      // 3xx — not followed. A redirect could move a key request to another
      // origin (or to `http:`), and the contract is a single POST to the
      // configured endpoint (ADR-008 §6 step 4). Treated as a provider
      // verdict, not a transport blip, so it is not retried.
      if (response.status >= 300) {
        this.logFailure({ ...fields, errorCode: 'key_provider_rejected' });
        throw new KeyProviderError(
          'key_provider_rejected',
          `key provider answered with an unexpected redirect status ${response.status}`,
          attempt
        );
      }

      // SIZE CAP BEFORE THE PARSER (ADR-008 §10/§11 item 4; issue #1261: "A
      // CPIX response body larger than 256 KiB must be rejected without
      // calling the parser"). Checked here as well as inside
      // `parseCpixResponse`, because `truncated` is only known to the
      // transport.
      if (response.truncated || cpixResponseByteLength(response.body) > this.maxResponseBytes) {
        this.logFailure({ ...fields, errorCode: 'key_provider_invalid_response' });
        throw new KeyProviderError(
          'key_provider_invalid_response',
          'key provider response exceeds the maximum accepted size',
          attempt
        );
      }

      // Parse failures are NOT retried (ADR-008 §12 "Malformed/unparseable
      // CPIX | parser | No retry"): the same request would produce the same
      // document.
      let parsed: { keys: ContentKey[]; signalling: DrmSignalling };
      try {
        parsed = await parseCpixResponse(response.body, { keyIds }, this.parseDeps);
      } catch (error) {
        this.logFailure({ ...fields, errorCode: 'key_provider_invalid_response' });
        // `parseCpixResponse` only ever throws `KeyProviderError` with a
        // message written in this repository, so it is re-thrown as-is; any
        // other error is replaced rather than surfaced.
        if (error instanceof KeyProviderError) throw error;
        throw new KeyProviderError(
          'key_provider_invalid_response',
          'key provider returned an unusable CPIX response',
          attempt
        );
      }

      this.log.info(fields, 'drm key request succeeded');
      return { keys: parsed.keys, signalling: this.overlayConfiguredSignalling(parsed.signalling) };
    }

    // Attempts exhausted, or the whole-step deadline / caller signal ended the
    // step before one could complete (ADR-008 §12 => `key_provider_unreachable`).
    throw (
      lastRetryable ??
      new KeyProviderError(
        'key_provider_unreachable',
        'key provider request did not complete within the deadline',
        this.maxAttempts
      )
    );
  }

  // Licence URLs, the certificate URL and (for completeness) nothing else come
  // from CONFIGURATION, not from the response (ADR-008 §5.2; no CPIX element
  // carries them — cpix.xsd has none).
  private overlayConfiguredSignalling(signalling: DrmSignalling): DrmSignalling {
    const merged: DrmSignalling = {
      ...signalling,
      licenceUrls: { ...this.licenceUrls }
    };
    if (this.certificateUrl !== undefined) merged.certificateUrl = this.certificateUrl;
    return merged;
  }

  // Exponential backoff with EQUAL JITTER (ADR-008 §12). `base * 2^(n-1)` is
  // the nominal delay; half of it is fixed and half is random, so three
  // concurrent packaging steps that all hit the same 5xx do not retry in
  // lockstep. Clamped to the remaining whole-step budget — a backoff must never
  // be the reason the deadline is missed.
  private async backoff(attempt: number, signal: AbortSignal, startedAt: number): Promise<void> {
    if (attempt >= this.maxAttempts) return;
    const nominal = this.backoffBaseMs * 2 ** (attempt - 1);
    const jittered = nominal / 2 + this.random() * (nominal / 2);
    const remaining = this.deadlineMs - (this.now() - startedAt);
    await this.sleep(Math.max(0, Math.min(jittered, remaining)), signal);
  }

  // Auth headers per ADR-008 §5.2 `authMode`. Credentials are read from the
  // environment at CALL time and never stored on the instance, never logged and
  // never attached to an error.
  private async authHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      // ADR-008 §6 step 4: "POST to keyServerUrl (Content-Type:
      // application/xml, auth per authMode, TLS required)".
      'content-type': 'application/xml',
      accept: 'application/xml'
    };
    if (this.authMode === 'basic') {
      const username = this.env[ENV_USERNAME];
      const password = this.env[ENV_PASSWORD];
      if (!username || !password) {
        throw new KeyProviderError(
          'drm_not_configured',
          `key provider auth mode basic requires ${ENV_USERNAME} and ${ENV_PASSWORD}`
        );
      }
      // RFC 7617 `Basic` credentials: base64 of `user:password`.
      const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
      headers['authorization'] = `Basic ${encoded}`;
    } else if (this.authMode === 'bearer') {
      const token = this.env[ENV_TOKEN];
      if (!token) {
        throw new KeyProviderError(
          'drm_not_configured',
          `key provider auth mode bearer requires ${ENV_TOKEN}`
        );
      }
      headers['authorization'] = `Bearer ${token}`;
    }
    // `mtls` carries no Authorization header: the credential is the TLS client
    // certificate (see `clientCert`).
    return headers;
  }

  private async clientCert(): Promise<{ cert: string; key: string } | undefined> {
    if (this.authMode !== 'mtls') return undefined;
    const certValue = this.env[ENV_CLIENT_CERT];
    const keyValue = this.env[ENV_CLIENT_KEY];
    if (!certValue || !keyValue) {
      throw new KeyProviderError(
        'drm_not_configured',
        `key provider auth mode mtls requires ${ENV_CLIENT_CERT} and ${ENV_CLIENT_KEY}`
      );
    }
    return {
      cert: await resolvePem(certValue, ENV_CLIENT_CERT, this.readPem),
      key: await resolvePem(keyValue, ENV_CLIENT_KEY, this.readPem)
    };
  }

  // The ONLY failure log call. One place, one field set — so "no body, no
  // credential, no key in a log line" is a property of this file rather than of
  // every call site remembering it (ADR-008 §10).
  private logFailure(fields: CpixLogFields): void {
    this.log.warn(fields, 'drm key request failed');
  }
}
