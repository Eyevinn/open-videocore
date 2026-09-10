// Unit tests for the per-destination path template (issue #574).
//
// Covers the two contract halves this feature must guarantee:
//   - registration-time validation rejects unknown tokens / malformed braces
//     with InvalidPathTemplateError (the router maps it to a 400);
//   - job-time rendering substitutes the supported tokens, honours brace
//     escaping, and refuses a token with no value in the job context.

import { describe, it, expect } from 'vitest';
import {
  validatePathTemplate,
  renderPathTemplate,
  InvalidPathTemplateError,
  PATH_TEMPLATE_TOKENS
} from './destination-path-template.js';

// A fixed instant so the date tokens are deterministic: 2026-09-10 UTC.
const FIXED = new Date('2026-09-10T04:05:06.000Z');

describe('validatePathTemplate — registration-time token validation', () => {
  it('accepts every supported token', () => {
    for (const token of PATH_TEMPLATE_TOKENS) {
      expect(() => validatePathTemplate(`out/{${token}}/x`)).not.toThrow();
    }
  });

  it('accepts a template with only literals (no tokens)', () => {
    expect(() => validatePathTemplate('static/prefix/here')).not.toThrow();
  });

  it('accepts escaped literal braces', () => {
    expect(() => validatePathTemplate('a{{b}}c')).not.toThrow();
  });

  it('rejects an unknown token with a clear error naming the token', () => {
    let err: unknown;
    try {
      validatePathTemplate('out/{unknownToken}/x');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidPathTemplateError);
    expect((err as InvalidPathTemplateError).statusCode).toBe(400);
    expect((err as InvalidPathTemplateError).token).toBe('unknownToken');
    expect((err as InvalidPathTemplateError).message).toContain('{unknownToken}');
  });

  it('rejects an unterminated brace', () => {
    expect(() => validatePathTemplate('out/{date')).toThrow(InvalidPathTemplateError);
  });

  it('rejects an unescaped closing brace', () => {
    expect(() => validatePathTemplate('out/date}')).toThrow(InvalidPathTemplateError);
  });

  it('rejects an empty {} token', () => {
    expect(() => validatePathTemplate('out/{}/x')).toThrow(InvalidPathTemplateError);
  });
});

describe('renderPathTemplate — job-time substitution', () => {
  it('renders date and asset id tokens', () => {
    const out = renderPathTemplate('{date}/{assetId}', {
      assetId: 'asset-123',
      now: FIXED
    });
    expect(out).toBe('2026-09-10/asset-123');
  });

  it('renders year/month/day tokens zero-padded in UTC', () => {
    const out = renderPathTemplate('{year}/{month}/{day}', { now: FIXED });
    expect(out).toBe('2026/09/10');
  });

  it('renders escaped literal braces', () => {
    const out = renderPathTemplate('a{{b}}c/{assetId}', { assetId: 'x', now: FIXED });
    expect(out).toBe('a{b}c/x');
  });

  it('strips leading/trailing slashes and collapses duplicates', () => {
    const out = renderPathTemplate('/{date}//{assetId}/', {
      assetId: 'a',
      now: FIXED
    });
    expect(out).toBe('2026-09-10/a');
  });

  it('throws when a referenced token has no value in the context', () => {
    let err: unknown;
    try {
      renderPathTemplate('{assetId}/x', { now: FIXED });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidPathTemplateError);
    expect((err as InvalidPathTemplateError).statusCode).toBe(400);
    expect((err as InvalidPathTemplateError).token).toBe('assetId');
  });
});
