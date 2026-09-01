// Unit tests for the spec/route parity comparison (issue #480).
//
// These exercise the pure set-difference logic that the CLI
// (scripts/check-spec-route-parity.ts) wraps around the real boot. They assert
// the acceptance criteria directly: the check FAILS with the SPECIFIC missing
// method+path pairs (not just a count) when a router's routes are absent from
// the spec, and PASSES once they are restored — modelling exactly the
// asset-upload regression (#478/#479) that motivated #480.

import { describe, it, expect } from 'vitest';
import {
  toCanonicalPath,
  routesToOperations,
  specToOperations,
  compareOperations,
  formatParityReport,
  type RegisteredRoute,
} from './spec-route-parity.js';

// The seven upload routes (src/routes/asset-upload.ts) under the
// /api/v1/assets prefix — the surface that silently dropped out of the spec.
const UPLOAD_ROUTES: RegisteredRoute[] = [
  { method: 'PUT', url: '/api/v1/assets/:id/upload' },
  { method: 'POST', url: '/api/v1/assets/:id/upload-url' },
  { method: 'POST', url: '/api/v1/assets/:id/multipart/initiate' },
  { method: 'GET', url: '/api/v1/assets/:id/multipart/:uploadId/part-url' },
  { method: 'POST', url: '/api/v1/assets/:id/multipart/:uploadId/complete' },
  { method: 'DELETE', url: '/api/v1/assets/:id/multipart/:uploadId' },
  { method: 'POST', url: '/api/v1/assets/:id/upload-complete' },
];

// A spec that documents every upload route, in OpenAPI {param} form.
function specWithUploads(): { paths: Record<string, Record<string, unknown>> } {
  const op = { responses: {} };
  return {
    paths: {
      '/api/v1/assets/{id}/upload': { put: op },
      '/api/v1/assets/{id}/upload-url': { post: op },
      '/api/v1/assets/{id}/multipart/initiate': { post: op },
      '/api/v1/assets/{id}/multipart/{uploadId}/part-url': { get: op },
      '/api/v1/assets/{id}/multipart/{uploadId}/complete': { post: op },
      '/api/v1/assets/{id}/multipart/{uploadId}': { delete: op },
      '/api/v1/assets/{id}/upload-complete': { post: op },
    },
  };
}

describe('toCanonicalPath', () => {
  it('rewrites fastify :params to openapi {params}', () => {
    expect(toCanonicalPath('/api/v1/assets/:id/multipart/:uploadId')).toBe(
      '/api/v1/assets/{id}/multipart/{uploadId}'
    );
  });

  it('strips a trailing slash but preserves root', () => {
    expect(toCanonicalPath('/api/v1/search/')).toBe('/api/v1/search');
    expect(toCanonicalPath('/')).toBe('/');
  });
});

describe('exclusions', () => {
  it('drops framework/util routes and auto HEAD/OPTIONS on the route side', () => {
    const ops = routesToOperations([
      { method: ['GET', 'HEAD'], url: '/health' },
      { method: 'GET', url: '/healthz' },
      { method: 'GET', url: '/api-docs/json' },
      { method: 'GET', url: '/ui/*' },
      { method: 'OPTIONS', url: '/api/v1/assets/:id' },
      { method: ['GET', 'HEAD'], url: '/api/v1/assets/:id' },
    ]);
    // Only the real GET on the asset route survives.
    expect([...ops]).toEqual(['GET /api/v1/assets/{id}']);
  });
});

describe('compareOperations', () => {
  it('passes when registered routes and spec match', () => {
    const registered = routesToOperations(UPLOAD_ROUTES);
    const spec = specToOperations(specWithUploads());
    const result = compareOperations(registered, spec);
    expect(result.ok).toBe(true);
    expect(result.missingFromSpec).toEqual([]);
    expect(result.extraInSpec).toEqual([]);
  });

  it('fails and lists the exact method+path pairs when the upload router is absent from the spec', () => {
    const registered = routesToOperations(UPLOAD_ROUTES);
    // Simulate the #478 regression: the spec omits every upload path.
    const spec = specToOperations({ paths: {} });
    const result = compareOperations(registered, spec);

    expect(result.ok).toBe(false);
    expect(result.missingFromSpec).toEqual([
      'DELETE /api/v1/assets/{id}/multipart/{uploadId}',
      'GET /api/v1/assets/{id}/multipart/{uploadId}/part-url',
      'POST /api/v1/assets/{id}/multipart/initiate',
      'POST /api/v1/assets/{id}/multipart/{uploadId}/complete',
      'POST /api/v1/assets/{id}/upload-complete',
      'POST /api/v1/assets/{id}/upload-url',
      'PUT /api/v1/assets/{id}/upload',
    ]);

    // The report names the pairs, not just a count.
    const report = formatParityReport(result);
    expect(report).toContain('PUT /api/v1/assets/{id}/upload');
    expect(report).toContain('7 registered route(s) MISSING from openapi.json');
  });

  it('flags spec operations with no registered route (stale spec)', () => {
    const registered = routesToOperations([
      { method: 'GET', url: '/api/v1/assets/:id' },
    ]);
    const spec = specToOperations({
      paths: {
        '/api/v1/assets/{id}': { get: {} },
        '/api/v1/gone': { post: {} },
      },
    });
    const result = compareOperations(registered, spec);
    expect(result.ok).toBe(false);
    expect(result.extraInSpec).toEqual(['POST /api/v1/gone']);
  });
});
