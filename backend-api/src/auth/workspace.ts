// Workspace identity resolution.
//
// open-videocore is gated behind the OSC login-wall (ADR-001, open question 2):
// every caller authenticates with an OSC access token. That token resolves to
// an OSC tenant, and the tenant id IS the workspace id. All resources are
// namespaced by this workspace id so that tenants sharing a single deployment
// never see each other's data.
//
// We resolve a token to its tenant by calling the OSC `mysubscriptions`
// endpoint with the token as the `x-pat-jwt` bearer. A token that OSC accepts
// and that maps to a tenant is, by definition, valid for this deployment. The
// resolution is cached briefly to avoid a round-trip to OSC on every request.

import { createFetch } from '@osaas/client-core';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

type Subscription = { serviceId: string; tenantId: string };

type CacheEntry = { workspaceId: string; expiresAt: number };

// Short TTL: a token that is revoked on OSC should stop working quickly, but we
// still want to avoid a network call on every single request in a burst.
const CACHE_TTL_MS = 60_000;
const RESOLVE_TIMEOUT_MS = 5_000;

const cache = new Map<string, CacheEntry>();

function environment(): string {
  return process.env['OSC_ENVIRONMENT'] ?? 'prod';
}

// Resolve an OSC access token to the workspace (tenant) id it belongs to.
// Throws AuthError if the token is missing, rejected by OSC, or not associated
// with a tenant. All external calls are timeout-bounded and error-handled per
// the project code standards.
export async function resolveWorkspaceId(token: string | undefined): Promise<string> {
  // Local dev bypass: set DEV_WORKSPACE_ID to skip OSC token validation.
  // Never set this in production — the OSC login wall provides the real token.
  const devWorkspace = process.env['DEV_WORKSPACE_ID'];
  if (devWorkspace) return devWorkspace;

  if (!token || token.trim().length === 0) {
    throw new AuthError('missing access token');
  }

  const cached = cache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.workspaceId;
  }

  const url = new URL(`https://catalog.svc.${environment()}.osaas.io/mysubscriptions`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

  let subscriptions: Subscription[];
  try {
    subscriptions = (await createFetch<Subscription[]>(url, {
      method: 'GET',
      headers: {
        'x-pat-jwt': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    })) as Subscription[];
  } catch (err) {
    // Any failure to validate the token against OSC is treated as an auth
    // failure, not a server error: we cannot establish who the caller is.
    const message = err instanceof Error ? err.message : String(err);
    throw new AuthError(`token validation failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }

  const tenantId = Array.isArray(subscriptions)
    ? subscriptions.find((s) => typeof s.tenantId === 'string' && s.tenantId.length > 0)
        ?.tenantId
    : undefined;

  if (!tenantId) {
    throw new AuthError('token is not associated with a workspace');
  }

  cache.set(token, { workspaceId: tenantId, expiresAt: Date.now() + CACHE_TTL_MS });
  return tenantId;
}

// Test-only: clear the resolution cache between cases.
export function _clearWorkspaceCache(): void {
  cache.clear();
}
