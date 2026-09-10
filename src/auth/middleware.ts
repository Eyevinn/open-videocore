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

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthError, requireAuth } from './workspace.js';

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
