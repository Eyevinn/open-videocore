// Operational logs listing router (issue #473).
//
// Exposes GET /api/v1/logs — a cursor/sequence-paged, append-only, time-ordered
// log stream. #371 rules out offset paging for this surface (offset counts drift
// as entries are appended to a high-volume append-only stream), so this endpoint
// is cursor-only: a bounded `limit` plus an opaque `cursor`, returning
// `{ items, nextCursor }`.
//
// The store behind it is DURABLE as of issue #996: records are persisted to the
// stack's CouchDB by CouchLogStore (src/data/couch-log-repo.ts) the way
// CouchAuditRepository persists audit entries, so the Logs tab still shows what
// happened before a restart. This router depends only on the `LogReader`
// interface (`list(opts) -> { items, nextCursor }` sync OR promised,
// src/services/log-store.ts), which both the durable store and the retained
// in-memory LogStore satisfy — the request/response contract below is unchanged.
//
// Behind the 401 presence gate (issue #995 review). This endpoint is NOT the
// aggregate-only surface it was when it shipped: the pipeline producer
// (src/services/pipeline-log.ts) now writes per-asset detail into the records it
// returns — asset ids, job ids, object keys, byte counts, profile names and raw
// error strings (which can carry internal source host names). That is the same
// class of data GET /api/v1/jobs returns, and that router gates anonymous
// callers, so this one does too: anonymous reads must not be a side channel
// around the gate on every other per-asset listing. See src/auth/middleware.ts
// (authGate) for why the in-process gate exists even behind the platform wall.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Route module shape (FastifyPluginAsync + withTypeProvider<ZodTypeProvider>,
//     zod `schema.querystring`/`schema.response`, `tags`): src/routes/retention.ts:58-92
//     and src/routes/jobs.ts:83-104.
//   - 401 presence gate wiring (`app.addHook('preHandler', authGate(app))` as the
//     router's first hook, `authGate` imported from '../auth/middleware.js'):
//     src/routes/jobs.ts:17 and :144; gate contract src/auth/middleware.ts:74-87.
//   - Sibling listing envelope for reference (offset variant, deliberately NOT
//     copied): src/routes/jobs.ts:91-99 (`{ items, total }`).
//   - `{ items, nextCursor }` cursor envelope + `{ limit, cursor }` request the
//     frontend table primitive sends: public/ops-ui-table.js:210-213, 262-268.
//   - Injected store pattern (OperationStore into provisionRouter):
//     src/main.ts:301-307; store contract: src/services/log-store.ts.
//   - Durable store + its read method: `CouchLogStore.list(opts):
//     Promise<ListLogsResult>` (src/data/couch-log-repo.ts), and the stack-
//     delegating `PerWorkspaceLogStore` main.ts injects
//     (src/data/per-workspace-repos.ts) — both narrowed here to `LogReader`
//     (src/services/log-store.ts).

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LOG_LEVELS, type LogReader } from '../services/log-store.js';
import { authGate } from '../auth/middleware.js';

// One log record as returned to callers. Mirrors LogRecord
// (src/services/log-store.ts). `level`/`category` are optional — present only
// when the underlying source classifies the entry.
const logRecordSchema = z.object({
  // Per-store display sequence number. NOT the pagination key: cursors encode
  // the record's internal monotonic id (`LogRecord.id`,
  // src/services/log-store.ts), which is unique across store instances, so
  // appends never shift an in-flight page and no record can be skipped at a page
  // boundary. The internal id is deliberately absent from this schema, so the
  // zod serializer strips it and the wire contract is unchanged.
  seq: z.number().int(),
  timestamp: z.string(),
  message: z.string(),
  level: z.enum(LOG_LEVELS).optional(),
  category: z.string().optional()
});

// Cursor-paged listing query. NO offset/page-number param by design (#371): the
// only forward-navigation control is the opaque `cursor`.
const listLogsQuerySchema = z.object({
  // Bounded page size. Matches the 1..200 clamp the store enforces.
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Opaque forward cursor from a prior page's `nextCursor`. Absent = first page.
  cursor: z.string().optional(),
  // Inclusive ISO-8601 time-range filter on the record timestamp.
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  // Free-text, case-insensitive substring filter on the message.
  q: z.string().optional(),
  // Sort order. 'desc' (newest-first) is the default; 'asc' reverses it.
  order: z.enum(['asc', 'desc']).default('desc')
});

const listLogsResponseSchema = z.object({
  items: z.array(logRecordSchema),
  // Opaque token for the next page, or null when this is the last page.
  nextCursor: z.string().nullable()
});

type LogsRouterOptions = {
  // Read surface only. `LogReader` is satisfied by the durable CouchLogStore
  // (promised `list`), the stack-delegating PerWorkspaceLogStore, and the
  // in-memory LogStore (synchronous `list`) — so unit tests that build this
  // router over a plain `new LogStore()` are unchanged.
  logStore: LogReader;
};

export const logsRouter: FastifyPluginAsync<LogsRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { logStore } = opts;

  // 401 presence gate (issue #711 pattern, applied here on the #995 review):
  // reject anonymous requests now that records carry per-asset identifiers.
  // Plugin-scoped, so no public router is affected. The gate resolves
  // `app.authenticate` lazily and no-ops when registerAuth was never called, so
  // unit tests that build this router in isolation are unchanged
  // (src/auth/middleware.ts:74-87).
  app.addHook('preHandler', authGate(app));

  app.get(
    '/',
    {
      schema: {
        tags: ['logs'],
        description:
          'List operational log records as a cursor-paged, newest-first stream. ' +
          'Pass `cursor` (from a prior response `nextCursor`) to page forward; a ' +
          'null `nextCursor` marks the last page. Filter server-side with ' +
          '`from`/`to` (ISO-8601 time range on `timestamp`) and `q` (case-' +
          'insensitive message substring). Set `order=asc` to reverse the default ' +
          'newest-first sort. This endpoint is cursor-only: there is no offset or ' +
          'page-number param, so newly appended entries never shift an in-flight ' +
          'page (#371, #473). Response header `x-log-window-degraded: true` means ' +
          'the durable store could not scan its whole retained window for this ' +
          'read and the page covers the newest records only; the body and 200 ' +
          'status are unchanged by this header (#996).',
        querystring: listLogsQuerySchema,
        response: { 200: listLogsResponseSchema }
      }
    },
    async (request, reply) => {
      const { limit, cursor, from, to, q, order } = request.query;
      // Awaited so a promised read (the durable CouchDB store) and a
      // synchronous one (in-memory) both serialise to the same body.
      const result = await logStore.list({ limit, cursor, from, to, q, order });
      // The durable store sets `degraded` when the log partition overshot its
      // bounded read window, so the page is the newest records rather than the
      // whole retained window (#996 review finding 2 — this used to be served as
      // an ordinary 200 with no hint at all). Surfaced as a RESPONSE HEADER, the
      // way the profiles router reports `x-profile-count`
      // (src/routes/profiles.ts:171): the body schema below is unchanged, and
      // the zod serializer strips the flag from the payload.
      if (result.degraded) {
        reply.header('x-log-window-degraded', 'true');
      }
      return result;
    }
  );
};
