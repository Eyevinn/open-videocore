// Storage-key validation helpers.
//
// Tenant isolation is structural (ADR-003 / issue #59): OSC provisions a
// separate set of backing resources per deploying tenant, so a deployed instance
// is single-tenant. There is therefore NO in-app workspace scoping — no
// per-workspace document-id prefix, object-key prefix, or cross-workspace
// ownership check. What remains is plain input hygiene on the context key.

export class WorkspaceAccessError extends Error {
  readonly statusCode = 403;
  constructor(message = 'access denied') {
    super(message);
    this.name = 'WorkspaceAccessError';
  }
}

const CONTEXT_ID_RE = /^[A-Za-z0-9._-]+$/;

export function assertValidWorkspaceId(contextId: string): void {
  if (!contextId || !CONTEXT_ID_RE.test(contextId)) {
    throw new WorkspaceAccessError('invalid context id');
  }
}

export function assertOwned(
  _callerContextId: string,
  _resourceContextId: string | undefined
): void {
  // Intentionally empty: structural isolation means there is nothing to guard.
}

export function namespacedId(_contextId: string, localId: string): string {
  return localId;
}

export function objectPrefix(_contextId: string): string {
  return '';
}
