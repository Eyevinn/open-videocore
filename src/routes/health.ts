// Health / status route (issue #644).
//
// Registers the unauthenticated GET /health liveness+status endpoint. Extracted
// from main.ts so its response schema (including the ingest-availability block)
// is registered in one place and can be exercised in isolation via app.inject()
// without booting the full application (which requires an OSC context).
//
// The endpoint reports:
//   - status/service: basic liveness identity
//   - resolver:       aggregate degraded-resolution signal (issue #422)
//   - ingest:         per-method ingest availability (issue #644) so operators
//                     and integrators can verify configuration state — notably
//                     whether the opt-in watch-folder is actually active —
//                     programmatically, without reading server logs.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ResolverHealthSnapshot } from '../services/resolver-health.js';
import {
  computeIngestAvailability,
  type IngestAvailabilitySignals
} from '../services/ingest-availability.js';

const ingestMethodSchema = z.object({
  available: z.boolean(),
  reason: z
    .enum(['no-storage-endpoint', 'not-enabled', 'missing-storage-endpoint'])
    .optional()
});

export const healthResponseSchema = z.object({
  status: z.string(),
  service: z.string(),
  resolver: z.object({
    degraded: z.boolean(),
    mode: z.enum(['none', 'no-storage', 'stale-last-known-good']),
    noStorageFallbackTotal: z.number(),
    staleFallbackTotal: z.number(),
    lastDegradedAt: z.number().nullable()
  }),
  ingest: z.object({
    directUpload: ingestMethodSchema,
    urlPull: ingestMethodSchema,
    watchFolder: ingestMethodSchema
  })
});

export type HealthRouterOptions = {
  // Read the current aggregate resolver-health snapshot at request time.
  resolverSnapshot: () => ResolverHealthSnapshot;
  // Read the ingest-availability signals at request time. Evaluated per request
  // so the reported state always reflects current configuration.
  ingestSignals: () => IngestAvailabilitySignals;
};

export const healthRouter: FastifyPluginAsync<HealthRouterOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/health',
    { schema: { response: { 200: healthResponseSchema } } },
    async () => ({
      status: 'ok',
      service: 'open-videocore-api',
      resolver: opts.resolverSnapshot(),
      ingest: computeIngestAvailability(opts.ingestSignals())
    })
  );
};
