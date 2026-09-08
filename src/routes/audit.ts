// Audit read surface (issue #565, parent #529).
//
// A read-only, queryable view over the append-only audit log (data model +
// store: issue #563, src/data/audit-repo.ts). This router NEVER writes or
// mutates an entry — the append-only invariant (ADR-005 "append the audit
// entry, never rewrite history") is preserved by construction: it depends only
// on the read-only `AuditRepository.query` surface.
//
//   GET /api/v1/audit — list audit entries newest-first, with filters + paging
//
// Filters (all optional, ANDed):
//   - targetType (+ targetId) : entries about a specific resource. `targetId`
//     is only meaningful with `targetType` (a target is the pair), so it is
//     rejected without it (400).
//   - origin / principalId    : coarse actor origin (PROVENANCE_ACTORS) and/or
//     exact principal id. `actor` in the issue maps to these two actor fields
//     (the persisted `AuditActor` shape, src/data/audit-repo.ts:48-54).
//   - action                  : exact action string.
//   - from / to               : inclusive ISO-8601 bounds on `at`.
//
// Pagination mirrors the asset list surface exactly (src/routes/assets.ts:
// 322-327,681-686): offset-based, `{ items, limit, offset, total }`, with
// `limit` in [1,200] and `offset` >= 0.
//
// Auth: behind the existing presence gate (ADR-003) via the `authenticate`
// preHandler, matching every other workspace-scoped router. Read-authorization
// (principal-aware access control) is deferred to #525.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AUDIT_MAX_LIMIT,
  AUDIT_TARGET_TYPES,
  PROVENANCE_ACTORS_FOR_AUDIT,
  type AuditRepository
} from '../data/audit-repo.js';

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

// Actor sub-shape, mirroring the persisted AuditActor (src/data/audit-repo.ts:
// 48-54): a nullable placeholder principal id (until #525) + coarse origin.
const auditActorSchema = z.object({
  principalId: z.string().nullable(),
  origin: z.enum(PROVENANCE_ACTORS_FOR_AUDIT)
});

// A single audit entry on the wire — the AuditEntry shape
// (src/data/audit-repo.ts:63-72).
const auditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actor: auditActorSchema,
  action: z.string(),
  targetType: z.enum(AUDIT_TARGET_TYPES),
  targetId: z.string(),
  detail: z.record(z.unknown())
});

// Offset pagination + filters. `limit`/`offset` coerced from the query string
// exactly like the asset list route (src/routes/assets.ts:322-327).
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(AUDIT_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  targetType: z.enum(AUDIT_TARGET_TYPES).optional(),
  targetId: z.string().min(1).optional(),
  origin: z.enum(PROVENANCE_ACTORS_FOR_AUDIT).optional(),
  principalId: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional()
});

// Page envelope mirroring the asset list surface (src/routes/assets.ts:681-686).
const listSchema = z.object({
  items: z.array(auditEntrySchema),
  limit: z.number(),
  offset: z.number(),
  total: z.number()
});

type AuditRouterOptions = {
  repository: AuditRepository;
};

export const auditRouter: FastifyPluginAsync<AuditRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository;

  app.get(
    '/',
    {
      schema: {
        querystring: listQuerySchema,
        response: { 200: listSchema, 400: errorSchema }
      }
    },
    async (request, reply) => {
      const q = request.query;
      // `targetId` only identifies a target alongside `targetType`; reject it on
      // its own (400) rather than silently ignore it.
      if (q.targetId !== undefined && q.targetType === undefined) {
        return reply.code(400).send({
          error: 'invalid_query',
          message: 'targetId requires targetType'
        });
      }
      const page = await repo.query({
        limit: q.limit,
        offset: q.offset,
        targetType: q.targetType,
        targetId: q.targetId,
        origin: q.origin,
        principalId: q.principalId,
        action: q.action,
        from: q.from,
        to: q.to
      });
      return reply.code(200).send(page);
    }
  );
};
