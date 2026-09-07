// Authorisation matrix + enforcement helpers (ADR-018, issue #554).
//
// This is the ENFORCEMENT half of the authorisation model. Issue #553 resolved
// the caller's role off the trusted `X-OVC-Role` header and attached it to
// `request.principal` (src/auth/principal.ts) WITHOUT gating any route. This
// module supplies:
//   - `authorize(role, action, resourceType)`: the pure decision-1 matrix.
//   - `resourceAuthorizationPreHandler(resourceType)`: the router-layer
//     method→action gate (decision 2, seam 1) that returns a fail-closed 403
//     with a stable machine-readable reason code (decision 5).
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Static permission matrix + role set: ADR-018 decision 1
//     (docs/architecture/ADR-018-authorisation-model.md:107-117).
//   - authorize(role, action, resourceType) surface + method→action mapping +
//     router-layer seam: ADR-018 decision 2
//     (docs/architecture/ADR-018-authorisation-model.md:119-154).
//   - No collection→asset cascade (each resource authorised independently
//     against the caller's workspace role): ADR-018 decision 4
//     (docs/architecture/ADR-018-authorisation-model.md:174-198).
//   - Fail-closed 403 on unrecognised/absent-distinct role; 403 distinct from
//     the 401 presence gate: ADR-018 decision 5
//     (docs/architecture/ADR-018-authorisation-model.md:204-231).
//   - Principal shape consumed here: src/auth/principal.ts
//     (ResolvedPrincipal.role: PrincipalRole | null).

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrincipalRole } from './principal.js';

// The three actions ADR-018 decision 2 defines. The router-layer gate derives
// these from the HTTP method (decision 2, seam 1):
//   GET/HEAD → read, POST/PUT/PATCH → write, DELETE → delete.
export type Action = 'read' | 'write' | 'delete';

// The two resource types ADR-018 decision 2 scopes the matrix to. Per decision 4
// there is NO cascade: a collection and its member assets are authorised
// independently against the same workspace role, so `collection` and `asset`
// share the identical row in the matrix below — membership never widens or
// narrows access.
export type ResourceType = 'asset' | 'collection';

// The static permission matrix, transcribed verbatim from ADR-018 decision 1
// (docs/architecture/ADR-018-authorisation-model.md:109-113):
//
//   | Role   | read | write | delete |
//   | viewer |  ✓   |   ✗   |   ✗    |
//   | editor |  ✓   |   ✓   |   ✓    |
//   | admin  |  ✓   |   ✓   |   ✓    |
//
// The matrix is role×action only: `asset` and `collection` are identical (no
// cascade, decision 4), so resourceType does not index the table — it is carried
// through only for the reason code and for a future ACL evolution (decision 2,
// seam 2). No I/O, no store: a pure lookup.
const MATRIX: Record<PrincipalRole, Record<Action, boolean>> = {
  viewer: { read: true, write: false, delete: false },
  editor: { read: true, write: true, delete: true },
  admin: { read: true, write: true, delete: true }
};

// Pure authorisation decision (ADR-018 decision 2). Returns true iff the role is
// permitted the action. `role` is `PrincipalRole | null` because principal.ts
// resolves an unrecognised/absent-distinct header to a `null` role; a null role
// is NEVER authorised (fail closed, decision 5).
export function authorize(
  role: PrincipalRole | null,
  action: Action,
  _resourceType: ResourceType
): boolean {
  if (role === null) {
    // Unrecognised role (principal.ts source 'unrecognised'): fail closed.
    return false;
  }
  return MATRIX[role][action];
}

// Map an HTTP method to the decision-2 action. Returns undefined for methods the
// gate does not classify (e.g. OPTIONS) so the caller can let them pass — CORS
// preflight and the like are not asset/collection mutations.
export function methodToAction(method: string): Action | undefined {
  switch (method.toUpperCase()) {
    case 'GET':
    case 'HEAD':
      return 'read';
    case 'POST':
    case 'PUT':
    case 'PATCH':
      return 'write';
    case 'DELETE':
      return 'delete';
    default:
      return undefined;
  }
}

// Stable machine-readable reason code for an authorisation failure. DISTINCT
// from the presence gate: the presence gate returns 401 `{ error: 'unauthorized' }`
// (src/auth/middleware.ts:44), whereas an authorisation failure is 403 with the
// `error` code below. Callers/tests match on this constant, not on prose.
export const AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role' as const;

// Shape of the 403 body returned by the router-layer gate. `error` is the stable
// code; the other fields are observability (which role was seen, what action on
// what resource was denied, and — when the role was unrecognised — the raw
// header value the caller supplied).
export interface AuthorizationFailureBody {
  error: typeof AUTHZ_FORBIDDEN_ERROR;
  message: string;
  action: Action;
  resourceType: ResourceType;
  role: PrincipalRole | null;
}

// Router-layer method→action gate (ADR-018 decision 2, seam 1). Returns a
// Fastify preHandler that:
//   1. derives the action from the request method,
//   2. reads the already-resolved role off request.principal (issue #553),
//   3. calls authorize(role, action, resourceType),
//   4. on deny, sends a fail-closed 403 with AUTHZ_FORBIDDEN_ERROR and returns
//      the reply so the handler never runs.
//
// Registered plugin-scoped inside the assets and collections routers, so it runs
// only on those routers' routes (Fastify encapsulation) — mirroring how each
// router already attaches per-router error handlers. A null role (unrecognised
// header) is denied here exactly as decision 5 mandates: never silently
// downgraded.
export function resourceAuthorizationPreHandler(resourceType: ResourceType) {
  return async function authorizeRequest(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<FastifyReply | undefined> {
    const action = methodToAction(request.method);
    if (action === undefined) {
      // Unclassified method (e.g. OPTIONS): not an asset/collection mutation, so
      // the gate does not apply. Let it proceed.
      return undefined;
    }

    // request.principal is populated by the onRequest hook registered in
    // registerPrincipal (src/auth/principal.ts) before any preHandler runs. If
    // the decoration is absent (a deployment that has not wired the principal
    // resolver), that is the "no role resolved" case, which ADR-018 decision 5
    // maps to the single-operator default of admin (absent ⇒ admin, backwards
    // compatible). A PRESENT principal with `role: null` is the DISTINCT
    // unrecognised-header case, which authorize() fails closed on.
    const role: PrincipalRole | null = request.principal
      ? request.principal.role
      : 'admin';

    if (!authorize(role, action, resourceType)) {
      const body: AuthorizationFailureBody = {
        error: AUTHZ_FORBIDDEN_ERROR,
        message:
          role === null
            ? `role not recognised; ${action} on ${resourceType} denied`
            : `role '${role}' may not ${action} a ${resourceType}`,
        action,
        resourceType,
        role
      };
      request.log.warn(
        { role, action, resourceType, source: request.principal?.source },
        'authorisation denied'
      );
      return reply.code(403).send(body);
    }

    return undefined;
  };
}
