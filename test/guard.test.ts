import { describe, it, expect } from 'vitest';
import {
  assertOwned,
  assertValidWorkspaceId,
  namespacedId,
  objectPrefix,
  WorkspaceAccessError
} from '../src/data/guard.js';

// ADR-003 / issue #59: in-app workspace scoping is removed (OSC provides
// structural tenant isolation — a deployed instance is one tenant's workspace).
describe('storage-key guard primitives (post issue #59)', () => {
  it('does not namespace ids — the local id is the document id', () => {
    expect(namespacedId('ctx', 'asset-9')).toBe('asset-9');
  });
  it('uses no object-key prefix', () => {
    expect(objectPrefix('ctx')).toBe('');
  });
  it('still validates a context id for input hygiene', () => {
    expect(() => assertValidWorkspaceId('')).toThrow(WorkspaceAccessError);
    expect(() => assertValidWorkspaceId('a/b')).toThrow(WorkspaceAccessError);
    expect(() => assertValidWorkspaceId('ok-id_1.2')).not.toThrow();
  });
  it('no longer rejects on ownership — single tenant per deployment', () => {
    expect(() => assertOwned('ctx', 'other')).not.toThrow();
    expect(() => assertOwned('ctx', undefined)).not.toThrow();
  });
});
