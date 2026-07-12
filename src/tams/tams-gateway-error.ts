// Shared error-handling contract for the read-only TAMS Gateway client
// (issue #164, sub-task of #151, epic #116).
//
// ---------------------------------------------------------------------------
// ERROR-HANDLING CONTRACT (authoritative — applies to EVERY read method)
// ---------------------------------------------------------------------------
//
// Every read method on TamsGatewayReadClient (tams-gateway-client.ts) surfaces
// non-success outcomes through ONE consistent mechanism: a thrown, typed
// `TamsGatewayError`. Read methods therefore always resolve to their pinned
// success response type OR reject with a `TamsGatewayError`; they never resolve
// to a partial / sentinel / null "soft failure" value. This keeps the success
// return type (e.g. ListFlowSegmentsResponse) clean and lets callers branch on
// a single `error.kind` discriminant rather than sniffing HTTP status codes or
// re-validating bodies themselves.
//
// The contract distinguishes four failure kinds via `TamsGatewayError.kind`:
//
//   'not-found'      HTTP 404. The addressed flow / source / segment page does
//                    not exist. Kept distinct from other 4xx so callers can
//                    treat "absent" differently from "rejected" without parsing
//                    the numeric status. `status` is 404.
//
//   'client-error'   Any other 4xx (400, 401, 403, 409, 422, ...). The request
//                    was rejected by the gateway / OSC auth-wall (bad params,
//                    unauthorized, read_only write attempt, etc). `status`
//                    carries the exact code.
//
//   'server-error'   Any 5xx. The gateway or a backing store (CouchDB / S3)
//                    failed. `status` carries the exact code. Also used for a
//                    non-standard / unexpected status the method cannot map.
//
//   'invalid-payload' The HTTP call succeeded (2xx) but the response body failed
//                    schema validation — malformed JSON, a missing required
//                    field, or a wrong-typed field. The body did not match the
//                    pinned response shape, so it is NOT handed back as if it
//                    were valid. `status` is the 2xx code that was returned;
//                    `validationIssues` carries the human-readable reasons.
//
// A 'not-found' is a first-class typed error rather than a `null` return so the
// mechanism is uniform across list and get methods; callers that want the
// "maybe absent" ergonomics can catch and map (see `isTamsNotFound`).
//
// Rationale for THROW over typed-return-union: the gateway read surface is used
// deep inside the indexing / lookup paths (#152-#154, #169) where the happy
// path dominates and a thrown typed error propagates cleanly to a single
// boundary handler without every intermediate caller having to thread an
// `{ ok, error }` union. A typed thrown error preserves both ergonomics
// (one success type) and type-safety (a discriminated `kind` + `instanceof`).

import type { ZodError } from 'zod';

// The discriminant for the four failure kinds the contract recognises.
export type TamsGatewayErrorKind =
  | 'not-found'
  | 'client-error'
  | 'server-error'
  | 'invalid-payload';

// Structured, typed error thrown by every TAMS Gateway read method on any
// non-success outcome. Callers branch on `.kind` (preferred) or `.status`.
export class TamsGatewayError extends Error {
  // The failure category (see the contract block above).
  readonly kind: TamsGatewayErrorKind;

  // The HTTP status observed. For 'invalid-payload' this is the 2xx status the
  // gateway returned before body validation failed. Undefined only if no HTTP
  // response was obtained (network/timeout mapped to 'server-error').
  readonly status?: number;

  // The read operation that failed, e.g. 'listFlowSegments'. Aids logging.
  readonly operation: string;

  // For 'invalid-payload': flat, human-readable schema-validation reasons, one
  // per failing field. Empty/undefined for the transport failure kinds.
  readonly validationIssues?: string[];

  constructor(args: {
    kind: TamsGatewayErrorKind;
    operation: string;
    message: string;
    status?: number;
    validationIssues?: string[];
    cause?: unknown;
  }) {
    super(args.message, args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = 'TamsGatewayError';
    this.kind = args.kind;
    this.operation = args.operation;
    this.status = args.status;
    this.validationIssues = args.validationIssues;
    // Restore prototype chain for reliable `instanceof` after transpilation.
    Object.setPrototypeOf(this, TamsGatewayError.prototype);
  }
}

// Type guard: is this a TamsGatewayError (across module/realm boundaries the
// `.name` fallback covers the rare transpilation edge where instanceof fails).
export function isTamsGatewayError(err: unknown): err is TamsGatewayError {
  return (
    err instanceof TamsGatewayError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: unknown }).name === 'TamsGatewayError')
  );
}

// Convenience guard for the common "treat absent as a branch" pattern.
export function isTamsNotFound(err: unknown): err is TamsGatewayError {
  return isTamsGatewayError(err) && err.kind === 'not-found';
}

// ---------------------------------------------------------------------------
// Shared enforcement helpers — the single place every read method routes its
// non-2xx and its body-validation outcomes through, so behaviour is identical
// across listFlows / getFlow / listSources / getSource / listFlowSegments.
// ---------------------------------------------------------------------------

// Map an HTTP status to a failure kind per the contract.
export function kindForStatus(status: number): TamsGatewayErrorKind {
  if (status === 404) return 'not-found';
  if (status >= 400 && status < 500) return 'client-error';
  // Everything else non-2xx (5xx and any unexpected code) is a server failure.
  return 'server-error';
}

// Build (and return) the typed error for a non-success HTTP status. The caller
// throws it; kept as a factory so tests can assert the shape without a network.
// `bodyText` is the (best-effort) response body used only to enrich the message.
export function tamsHttpError(args: {
  operation: string;
  status: number;
  bodyText?: string;
}): TamsGatewayError {
  const kind = kindForStatus(args.status);
  const suffix = args.bodyText ? ` ${args.bodyText}` : '';
  return new TamsGatewayError({
    kind,
    operation: args.operation,
    status: args.status,
    message: `TAMS gateway ${args.operation} failed: ${args.status}${suffix}`.trim()
  });
}

// Build the typed error for a body that failed schema validation on a 2xx
// response. Flattens a ZodError into per-field reasons for `validationIssues`.
export function tamsInvalidPayloadError(args: {
  operation: string;
  status: number;
  zodError: ZodError;
}): TamsGatewayError {
  const issues = args.zodError.issues.map((i) => {
    const path = i.path.length ? i.path.join('.') : '(root)';
    return `${path}: ${i.message}`;
  });
  return new TamsGatewayError({
    kind: 'invalid-payload',
    operation: args.operation,
    status: args.status,
    validationIssues: issues,
    message: `TAMS gateway ${args.operation} returned a malformed payload: ${issues.join('; ')}`,
    cause: args.zodError
  });
}
