// Request authentication gate.
//
// open-videocore is gated behind the OSC platform auth wall (ADR-018 decision 3 —
// the authoritative auth/tenancy ADR; the prior "ADR-003" citation was a stale
// doc gap ADR-018 corrects, see ADR-018:48-62): every inbound request reaches the
// process only after the platform has authenticated the caller. The auth wall is
// treated as a PURE GATE — open-videocore does not read a per-request
// workspace/tenant identifier, because tenant isolation is structural: OSC
// provisions a separate set of backing resources (CouchDB, PostgreSQL, MinIO,
// Encore) per deploying tenant, so a deployed instance IS the tenant's workspace.
// There is no shared backing store across tenants and thus no in-app workspace
// scoping to perform. Roles (ADR-018 decisions 1-4) layer on top of this gate and
// are enforced at the router-layer gate (src/auth/authorize.ts), not here.
//
// Previously this module called the OSC `mysubscriptions` endpoint to resolve a
// token to a tenant id used as a per-request workspace scope. That resolution is
// REMOVED (ADR-018 decision 3 / issue #59): there is no tenant to resolve and
// nothing to scope. We only require a bearer token to be present so a deployment
// accidentally exposed without the wall (or an off-OSC deployment behind an
// equivalent proxy) rejects anonymous traffic rather than serving it.
//
// SECURITY BOUNDARY: requireAuth() is a pure presence gate — it passes ANY
// non-empty bearer string without inspecting it. It therefore provides NO
// protection against a missing, bypassed, or misconfigured auth wall: an
// attacker who reaches the process directly can send any placeholder token and
// pass. It is NOT a fallback or safety net for a wall-bypass scenario, and NOT a
// substitute for the wall on an off-OSC deployment. The sole security boundary
// for inbound authentication is the OSC auth wall (or, off-OSC, an equivalent
// upstream proxy that authenticates the caller before the request reaches this
// process). The authoritative auth-isolation decision is recorded in issue #59.
// The presence check exists only to reject accidental anonymous traffic in the
// normal behind-the-wall case, not to authenticate anyone.

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

// The single, deployment-wide resource context. A deployed instance is one
// stack (ADR-018 decision 3), so all data lives in one context. This constant is the stable
// token embedded in encoreJobIds (for the auto-scaler's Valkey pool keying) and
// the stack resolver's cache key; it is NOT a tenant/workspace identifier derived
// from the request.
export const DEPLOYMENT_CONTEXT = 'default';

// Gate an inbound request: resolve to true when a bearer token is present (the
// OSC auth wall has already authenticated it upstream); throw AuthError when no
// token is present so anonymous traffic is rejected. It is a pure presence gate —
// the token is intentionally not inspected for identity, and nothing is scoped.
export async function requireAuth(token: string | undefined): Promise<boolean> {
  if (!token || token.trim().length === 0) {
    throw new AuthError('missing access token');
  }
  return true;
}
