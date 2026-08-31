// Operational logs listing router (issue #473).
//
// Exposes GET /api/v1/logs — a cursor/sequence-paged, append-only, time-ordered
// log stream. #371 rules out offset paging for this surface (offset counts drift
// as entries are appended to a high-volume append-only stream), so this endpoint
// is cursor-only: a bounded `limit` plus an opaque `cursor`, returning
// `{ items, nextCursor }`. There is no persistent log store in the repo, so the
// endpoint is backed by the in-memory LogStore (src/services/log-store.ts),
// modelled on the OperationStore that backs GET /api/v1/provision/operations.
//
// Not behind `authenticate`: like the provision operations listing and the
// admin/scaler status endpoints, this reports aggregate operational state, not
// workspace-scoped data.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Route module shape (FastifyPluginAsync + withTypeProvider<ZodTypeProvider>,
//     zod `schema.querystring`/`schema.response`, `tags`): src/routes/retention.ts:58-92
//     and src/routes/jobs.ts:83-104.
//   - Sibling listing envelope for reference (offset variant, deliberately NOT
//     copied): src/routes/jobs.ts:91-99 (`{ items, total }`).
//   - `{ items, nextCursor }` cursor envelope + `{ limit, cursor }` request the
//     frontend table primitive sends: public/ops-ui-table.js:210-213, 262-268.
//   - Injected in-memory store pattern (OperationStore into provisionRouter):
//     src/main.ts:301-307; store contract: src/services/log-store.ts.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LOG_LEVELS, type LogStore } from '../services/log-store.js';

// One log record as returned to callers. Mirrors LogRecord
// (src/services/log-store.ts). `level`/`category` are optional — present only
// when the underlying source classifies the entry.
const logRecordSchema = z.object({
  // Monotonic, gap-free sequence number. The stable pagination key: cursors
  // encode a `seq` boundary, so appends never shift an in-flight page.
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
  logStore: LogStore;
};

export const logsRouter: FastifyPluginAsync<LogsRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { logStore } = opts;

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
          'newest-first sort. This endpoint is cursor/sequence-only: there is no ' +
          'offset or page-number param, so newly appended entries never shift an ' +
          'in-flight page (#371, #473).',
        querystring: listLogsQuerySchema,
        response: { 200: listLogsResponseSchema }
      }
    },
    async (request) => {
      const { limit, cursor, from, to, q, order } = request.query;
      return logStore.list({ limit, cursor, from, to, q, order });
    }
  );
};
