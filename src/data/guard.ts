// Storage-key validation helpers.
//
// Tenant isolation is structural (ADR-018 decision 3 — the authoritative
// auth/tenancy ADR; the earlier "ADR-003" citation here was a stale doc gap that
// ADR-018 corrects, see ADR-018:48-62): OSC provisions a separate set of backing
// resources per deploying tenant, so a deployed instance is single-tenant. There
// is therefore NO in-app workspace scoping — no per-workspace document-id prefix,
// object-key prefix, or cross-workspace ownership check. What remains is plain
// input hygiene on the context key.
//
// Roles (ADR-018 decisions 1-4) layer ON TOP of this structural isolation and are
// enforced at the router-layer gate (src/auth/authorize.ts), not here: isolation
// answers "which workspace" (always this one); roles answer "which action within
// it". assertOwned below is the named resource-layer seam ADR-018 decision 2
// (seam 2) reserves for a FUTURE per-resource grant; for the fixed-role,
// no-cascade model (decisions 1 & 4) it stays intentionally empty.

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
  // Intentionally empty (ADR-018 decision 2, seam 2; decision 4): structural
  // isolation means there is nothing to guard, and the fixed-role model has no
  // per-resource grant to cascade from a collection to its member assets. This is
  // the single, already-wired insertion point a future ACL ADR would use.
}

export function namespacedId(_contextId: string, localId: string): string {
  return localId;
}

export function objectPrefix(_contextId: string): string {
  return '';
}
