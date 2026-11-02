// Authentication middleware.
//
// Extracts the OSC access token from the Authorization header (falling back to
// the platform's `x-jwt` header, issue #1256) and gates the request on its
// presence. Tenant isolation is structural (ADR-018 decision 3 —
// the authoritative auth/tenancy ADR; the prior "ADR-003" citation was a stale
// doc gap ADR-018 corrects): a deployed instance is a single stack, so there is
// no per-request workspace to resolve — the hook only rejects anonymous traffic
// (401) before the handler runs. It sets `request.authenticated` so the
// connection-resolving preHandler can gate on it. The 401 presence gate here is
// DISTINCT from the 403 authorisation failure the role gate returns
// (src/auth/authorize.ts, ADR-018 decision 5).

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthError, requireAuth } from './workspace.js';

declare module 'fastify' {
  interface FastifyRequest {
    // Set by the auth preHandler. True on every authenticated route.
    authenticated: boolean;
  }
}

// Parse a single `Bearer <token>` header value. Returns undefined when the
// header is absent or is not in that form.
function parseBearer(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match ? match[1].trim() : undefined;
  return token && token.length > 0 ? token : undefined;
}

// Read the access token from `Authorization: Bearer <token>`, falling back to
// `x-jwt: Bearer <token>` when Authorization is absent or carries no token
// (issue #1256). The OSC platform ingress authenticates `x-jwt`, and OSC's own
// tooling tells callers to send the token in that header; a caller who follows
// that instruction used to clear the ingress and then be rejected by this gate
// with `401 missing access token`. Both headers now reach requireAuth
// unchanged, with Authorization keeping precedence. This does NOT weaken the
// gate: an absent or non-Bearer value in both headers still yields undefined,
// so anonymous and malformed-token traffic is still rejected 401 (the issue
// #711 regression guard).
function extractToken(request: FastifyRequest): string | undefined {
  return (
    parseBearer(request.headers['authorization']) ??
    parseBearer(request.headers['x-jwt'])
  );
}

// Register `request.authenticated` (default false) and an `authenticate`
// preHandler that all guarded routes attach. Call once at app setup.
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('authenticated', false);

  app.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const token = extractToken(request);
      try {
        request.authenticated = await requireAuth(token);
      } catch (err) {
        if (err instanceof AuthError) {
          request.log.warn({ reason: err.message }, 'authentication rejected');
          await reply
            .code(401)
            .header('WWW-Authenticate', 'Bearer')
            .send({ error: 'unauthorized', message: err.message });
          return;
        }
        throw err;
      }
    }
  );
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// Plugin-scoped 401 presence gate for protected routers (issue #711). Returns a
// preHandler that a workspace-scoped router attaches as its FIRST hook so an
// anonymous request is rejected 401 before any role/action decision runs.
//
// The gate resolves `app.authenticate` LAZILY at request time rather than
// capturing it at registration time, and no-ops when the `authenticate`
// decoration is absent. This keeps each router self-sufficient: the real app
// wires registerAuth (src/main.ts) so the gate is active, while unit tests that
// build a router in isolation to exercise ONLY the role gate — and never wire
// registerAuth nor send a bearer token — are unaffected (they neither expect nor
// receive a 401). The gate never reintroduces per-request workspace scoping: it
// only calls the pure presence gate requireAuth via app.authenticate.
export function authGate(app: FastifyInstance) {
  return async function presenceGate(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    if (!app.hasDecorator('authenticate')) {
      // registerAuth was not called on this instance; nothing to enforce.
      return;
    }
    await app.authenticate(request, reply);
  };
}
