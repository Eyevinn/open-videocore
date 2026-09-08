// Tests for the pure principal/role resolver (ADR-018, issue #553).
//
// Mirrors the repo's vitest style (see src/routes/logs.test.ts,
// src/routes/provision.deprovision.test.ts): describe/it/expect from vitest,
// asserting on plain return values. The resolver is pure (no I/O), so these
// tests need no Fastify app — they exercise resolvePrincipalRole directly.
//
// Scope check: this slice RESOLVES and OBSERVES only. These tests assert the
// resolver NEVER throws and that an unrecognised value yields an observable
// null-role sentinel (NOT a 403) — enforcement is deferred to #554.

import { describe, it, expect } from 'vitest';
import {
  resolvePrincipalRole,
  OPERATOR_PRINCIPAL,
  ROLE_HEADER,
  type ResolvedPrincipal
} from './principal.js';

describe('resolvePrincipalRole — absent header defaults to admin (ADR-018 decision 5)', () => {
  it('undefined header ⇒ admin, source "default", raw undefined', () => {
    const r = resolvePrincipalRole(undefined);
    expect(r.role).toBe('admin');
    expect(r.source).toBe('default');
    expect(r.rawHeaderValue).toBeUndefined();
    expect(r.principal).toBe(OPERATOR_PRINCIPAL);
  });

  it('empty string ⇒ admin, source "default"', () => {
    const r = resolvePrincipalRole('');
    expect(r.role).toBe('admin');
    expect(r.source).toBe('default');
  });

  it('whitespace-only string ⇒ admin, source "default"', () => {
    const r = resolvePrincipalRole('   ');
    expect(r.role).toBe('admin');
    expect(r.source).toBe('default');
  });
});

describe('resolvePrincipalRole — each recognised role', () => {
  it.each(['viewer', 'editor', 'admin'] as const)('%s ⇒ that role, source "header"', (role) => {
    const r = resolvePrincipalRole(role);
    expect(r.role).toBe(role);
    expect(r.source).toBe('header');
    expect(r.rawHeaderValue).toBe(role);
  });

  it('trims surrounding whitespace before matching', () => {
    const r = resolvePrincipalRole('  editor  ');
    expect(r.role).toBe('editor');
    expect(r.source).toBe('header');
    // Raw value is retained verbatim for observability.
    expect(r.rawHeaderValue).toBe('  editor  ');
  });

  it('is case-insensitive on the role value', () => {
    const r = resolvePrincipalRole('ADMIN');
    expect(r.role).toBe('admin');
    expect(r.source).toBe('header');
    expect(r.rawHeaderValue).toBe('ADMIN');
  });
});

describe('resolvePrincipalRole — unrecognised value is an observable sentinel, NOT a 403 (#554 defers enforcement)', () => {
  it('unknown role ⇒ role null, source "unrecognised", raw retained; does not throw', () => {
    let r: ResolvedPrincipal;
    expect(() => {
      r = resolvePrincipalRole('superuser');
    }).not.toThrow();
    r = resolvePrincipalRole('superuser');
    expect(r.role).toBeNull();
    expect(r.source).toBe('unrecognised');
    expect(r.rawHeaderValue).toBe('superuser');
    expect(r.principal).toBe(OPERATOR_PRINCIPAL);
  });

  it('a repeated header (array) ⇒ role null, source "unrecognised", raw array retained', () => {
    const r = resolvePrincipalRole(['viewer', 'admin']);
    expect(r.role).toBeNull();
    expect(r.source).toBe('unrecognised');
    expect(r.rawHeaderValue).toEqual(['viewer', 'admin']);
  });

  it('an empty array ⇒ role null, source "unrecognised" (still non-throwing)', () => {
    const r = resolvePrincipalRole([]);
    expect(r.role).toBeNull();
    expect(r.source).toBe('unrecognised');
  });
});

describe('resolvePrincipalRole — invariants', () => {
  it('always attaches the single frozen operator principal', () => {
    const inputs: (string | string[] | undefined)[] = [undefined, 'admin', 'nope', ['a', 'b']];
    for (const input of inputs) {
      const r = resolvePrincipalRole(input);
      expect(r.principal).toBe(OPERATOR_PRINCIPAL);
      expect(r.principal.kind).toBe('operator');
    }
    expect(Object.isFrozen(OPERATOR_PRINCIPAL)).toBe(true);
  });

  it('exposes the trusted header name in its lowercased (Fastify) form', () => {
    // Fastify lowercases header keys; the wiring reads request.headers[ROLE_HEADER].
    expect(ROLE_HEADER).toBe('x-ovc-role');
  });
});
