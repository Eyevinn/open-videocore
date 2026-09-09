// Unit tests for the pure authorisation matrix + method mapping (ADR-018
// decisions 1, 2, 4, 5; issue #554).
//
// These exercise authorize() and methodToAction() directly — pure functions, no
// Fastify — verifying the decision table verbatim from ADR-018 decision 1
// (docs/architecture/ADR-018-authorisation-model.md:109-113). The router-layer
// 403 wiring is covered by test/permissions-enforcement.test.ts.

import { describe, it, expect } from 'vitest';
import {
  authorize,
  methodToAction,
  AUTHZ_FORBIDDEN_ERROR,
  type Action,
  type ResourceType
} from './authorize.js';
import type { PrincipalRole } from './principal.js';

const RESOURCES: ResourceType[] = ['asset', 'collection'];

// The ADR-018 decision-1 decision table, transcribed verbatim. Expected allow
// per (role, action). Both resource types share this table (no cascade,
// decision 4), asserted explicitly below.
const EXPECTED: Record<PrincipalRole, Record<Action, boolean>> = {
  viewer: { read: true, write: false, delete: false },
  editor: { read: true, write: true, delete: true },
  admin: { read: true, write: true, delete: true }
};

describe('authorize — full role×action×resourceType decision table (ADR-018 decision 1)', () => {
  const roles: PrincipalRole[] = ['viewer', 'editor', 'admin'];
  const actions: Action[] = ['read', 'write', 'delete'];
  for (const role of roles) {
    for (const action of actions) {
      for (const resource of RESOURCES) {
        const expected = EXPECTED[role][action];
        it(`${role} ${action} ${resource} ⇒ ${expected ? 'allow' : 'deny'}`, () => {
          expect(authorize(role, action, resource)).toBe(expected);
        });
      }
    }
  }
});

describe('authorize — no collection→asset cascade (ADR-018 decision 4)', () => {
  it('asset and collection resolve identically for every role×action', () => {
    const roles: PrincipalRole[] = ['viewer', 'editor', 'admin'];
    const actions: Action[] = ['read', 'write', 'delete'];
    for (const role of roles) {
      for (const action of actions) {
        expect(authorize(role, action, 'asset')).toBe(authorize(role, action, 'collection'));
      }
    }
  });
});

describe('authorize — null role is fail-closed (ADR-018 decision 5)', () => {
  const actions: Action[] = ['read', 'write', 'delete'];
  for (const action of actions) {
    for (const resource of RESOURCES) {
      it(`null role ${action} ${resource} ⇒ deny`, () => {
        expect(authorize(null, action, resource)).toBe(false);
      });
    }
  }
});

describe('methodToAction — HTTP method → action (ADR-018 decision 2)', () => {
  it.each([
    ['GET', 'read'],
    ['HEAD', 'read'],
    ['POST', 'write'],
    ['PUT', 'write'],
    ['PATCH', 'write'],
    ['DELETE', 'delete']
  ] as const)('%s ⇒ %s', (method, action) => {
    expect(methodToAction(method)).toBe(action);
  });

  it('is case-insensitive on the method', () => {
    expect(methodToAction('get')).toBe('read');
    expect(methodToAction('delete')).toBe('delete');
  });

  it('returns undefined for an unclassified method (e.g. OPTIONS)', () => {
    expect(methodToAction('OPTIONS')).toBeUndefined();
  });
});

describe('reason code is stable + distinct from the presence gate', () => {
  it('is the exported constant, not prose', () => {
    expect(AUTHZ_FORBIDDEN_ERROR).toBe('forbidden_insufficient_role');
    // Distinct from the 401 presence-gate error code ('unauthorized',
    // src/auth/middleware.ts:44).
    expect(AUTHZ_FORBIDDEN_ERROR).not.toBe('unauthorized');
  });
});
