// Authentication middleware.
//
// Extracts the OSC access token from the Authorization header and gates the
// request on its presence. Tenant isolation is structural (ADR-018 decision 3 —
// the authoritative auth/tenancy ADR; the prior "ADR-003" citation was a stale
// doc gap ADR-018 corrects): a deployed instance is a single stack, so there is
// no per-request workspace to resolve — the hook only rejects anonymous traffic
// (401) before the handler runs. It sets `request.authenticated` so the
// connection-resolving preHandler can gate on it. The 401 presence gate here is
// DISTINCT from the 403 authorisation failure the role gate returns
// (src/auth/authorize.ts, ADR-018 decision 5).
//
// One OPT-IN exception exists (issue #767): a deployment may declare that its
// fronting auth layer marks already-authenticated browser requests with a named
// header, in which case the gate admits the UI's own same-origin /ui calls that
// carry that signal instead of 401-ing them. It is off unless configured — see
// src/auth/ui-presence-trust.ts for the trust model and why there is no default.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthError, requireAuth } from './workspace.js';
import { isTrustedUiPresenceRequest, type UiPresenceTrustConfig } from './ui-presence-trust.js';

declare module 'fastify' {
  interface FastifyRequest {
    // Set by the auth preHandler. True on every authenticated route.
    authenticated: boolean;
  }
}

function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers['authorization'];
  if (typeof header !== 'string') {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

// Options for the presence gate. Every field is optional and omitting the whole
// object must leave the gate byte-for-byte identical to its pre-#767 behaviour.
export interface AuthOptions {
  // Opt-in fronting-layer trust for the UI's own same-origin calls (issue #767,
  // src/auth/ui-presence-trust.ts). `null`/omitted — the DEFAULT — means the
  // deployment has not opted in: the gate looks at nothing but the bearer token,
  // so anonymous traffic from anywhere, /ui included, still gets 401 (#711).
  uiPresenceTrust?: UiPresenceTrustConfig | null;
}

// Register `request.authenticated` (default false) and an `authenticate`
// preHandler that all guarded routes attach. Call once at app setup.
export function registerAuth(app: FastifyInstance, opts: AuthOptions = {}): void {
  app.decorateRequest('authenticated', false);
  const uiPresenceTrust = opts.uiPresenceTrust ?? null;

  app.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const token = extractToken(request);

      // Opt-in fronting-layer trust (issue #767). Consulted ONLY when the request
      // carries no bearer token at all — i.e. only in the case that would
      // otherwise be a 401 — and only when the deployment has explicitly named a
      // trusted header, so an unset configuration cannot change any outcome. The
      // admitted request is a same-origin call from this instance's own /ui pages
      // bearing the operator-declared fronting-layer signal; every other
      // anonymous request falls through to the 401 below.
      if (token === undefined && uiPresenceTrust !== null) {
        if (isTrustedUiPresenceRequest(request.headers, uiPresenceTrust)) {
          request.authenticated = true;
          request.log.debug(
            { trustedHeader: uiPresenceTrust.headerName },
            'admitted same-origin /ui request on the trusted fronting-layer signal (issue #767)'
          );
          return;
        }
      }

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
