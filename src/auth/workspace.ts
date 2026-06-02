// Request authentication gate.
//
// open-videocore is gated behind the OSC platform auth wall (ADR-003): every
// inbound request reaches the process only after the platform has authenticated
// the caller. The auth wall is treated as a PURE GATE — open-videocore does not
// read a per-request workspace/tenant identifier, because tenant isolation is
// structural: OSC provisions a separate set of backing resources (CouchDB,
// PostgreSQL, MinIO, Encore) per deploying tenant, so a deployed instance IS the
// tenant's workspace. There is no shared backing store across tenants and thus
// no in-app workspace scoping to perform.
//
// Previously this module called the OSC `mysubscriptions` endpoint to resolve a
// token to a tenant id used as a per-request workspace scope. That resolution is
// REMOVED (ADR-003 / issue #59): there is no tenant to resolve and nothing to
// scope. We only require a bearer token to be present so a deployment
// accidentally exposed without the wall (or an off-OSC deployment behind an
// equivalent proxy) rejects anonymous traffic rather than serving it.

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

// The single, deployment-wide resource context. A deployed instance is one
// tenant's workspace (ADR-003), so all data lives in one context. This constant
// is the stable key handed to the backing-stack resolver and repositories; it is
// NOT a tenant identifier derived from the request.
export const DEPLOYMENT_CONTEXT = 'default';

// Gate an inbound request. Returns the fixed deployment context when a bearer
// token is present (the OSC auth wall has already authenticated it upstream);
// throws AuthError when no token is present so anonymous traffic is rejected.
//
// Retains the historical name `resolveWorkspaceId` for callers and test doubles,
// but it no longer resolves a tenant — it is a pure presence gate. The token is
// intentionally not inspected for identity.
export async function resolveWorkspaceId(token: string | undefined): Promise<string> {
  if (process.env['DEV_WORKSPACE_ID']) {
    return process.env['DEV_WORKSPACE_ID'] as string;
  }
  if (!token || token.trim().length === 0) {
    throw new AuthError('missing access token');
  }
  return DEPLOYMENT_CONTEXT;
}

// Test-only no-op retained for source compatibility (no resolution cache exists).
export function _clearWorkspaceCache(): void {
  // nothing to clear: no tenant resolution / cache exists.
}
