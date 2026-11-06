// isRouteNotFoundError: a 404 about a MISSING ROUTE is not a 404 about a
// missing resource (issue #1211).
//
// CONTRACT SOURCES (per CLAUDE.md rule 7):
//   - @osaas/client-core 0.24.0 lib/fetch.js `defaultErrorFactory` — a non-ok
//     JSON response becomes `FetchError { message: res.message ?? res.reason ??
//     JSON.stringify(res), httpCode: response.status }`; the outer catch of
//     `createFetch` re-wraps a transport failure as `FetchError { message }`
//     with NO httpCode.
//   - Fastify's default not-found handler, which every OSC service instance API
//     is served behind, answers `{"message":"Route <METHOD>:<path> not found",
//     "error":"Not Found","statusCode":404}` — observed verbatim as
//     `Route GET:/minioinstance not found` against the object store's own API
//     (`https://api-minio-minio.auto.prod-se.osaas.io/minioinstance`, ADR-026 C5)
//     and reported on #1166.
//
// Duck-typed `httpCode` rather than `instanceof FetchError`, matching the rest
// of this module, so an error that crossed a module boundary still classifies.

import { describe, it, expect } from 'vitest';
import { isRouteNotFoundError } from './osc-error.js';

function fetchError(message: string, httpCode?: number): Error {
  return Object.assign(new Error(message), { httpCode });
}

describe('isRouteNotFoundError', () => {
  it('matches the object-store collection read that has no route', () => {
    expect(
      isRouteNotFoundError(
        fetchError('Route GET:/minioinstance not found', 404)
      )
    ).toBe(true);
  });

  it('matches any method and any path shape', () => {
    expect(
      isRouteNotFoundError(
        fetchError('Route DELETE:/minioinstance/mystack not found', 404)
      )
    ).toBe(true);
    expect(
      isRouteNotFoundError(
        fetchError('Route POST:/encoreinstance?x=1 not found', 404)
      )
    ).toBe(true);
  });

  it('does NOT match a 404 about a missing resource', () => {
    expect(isRouteNotFoundError(fetchError('instance not found', 404))).toBe(
      false
    );
    expect(isRouteNotFoundError(fetchError('Not Found', 404))).toBe(false);
  });

  it('does NOT match when the status is not 404', () => {
    expect(
      isRouteNotFoundError(
        fetchError('Route GET:/minioinstance not found', 500)
      )
    ).toBe(false);
    // A transport failure carries no httpCode at all.
    expect(
      isRouteNotFoundError(fetchError('Route GET:/minioinstance not found'))
    ).toBe(false);
  });

  it('tolerates non-error inputs', () => {
    expect(isRouteNotFoundError(undefined)).toBe(false);
    expect(isRouteNotFoundError('Route GET:/x not found')).toBe(false);
    expect(isRouteNotFoundError({ httpCode: 404 })).toBe(false);
  });
});
