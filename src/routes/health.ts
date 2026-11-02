// Health / status route (issue #644).
//
// Registers the unauthenticated GET /health liveness+status endpoint. Extracted
// from main.ts so its response schema (including the ingest-availability block)
// is registered in one place and can be exercised in isolation via app.inject()
// without booting the full application (which requires an OSC context).
//
// The endpoint reports:
//   - status/service: basic liveness identity
//   - build:          build identity of the running image (issue #827)
//   - resolver:       aggregate degraded-resolution signal (issue #422)
//   - ingest:         per-method ingest availability (issue #644) so operators
//                     and integrators can verify configuration state — notably
//                     whether the opt-in watch-folder is actually active —
//                     programmatically, without reading server logs.
//
// Design call on `build` (issue #827 asked for this to be made explicitly
// rather than by omission): the FULL build string is served here, on the
// unauthenticated endpoint, not gated behind auth.
//
// Reasoning: the usual argument for gating a version is that it narrows what an
// attacker must guess. That argument does not apply to this project. The source
// is public and Apache-2.0 licensed, and every tag, commit SHA and diff is
// already readable by anyone; a commit identifier discloses nothing that is not
// already published. Against that near-zero disclosure sits a concrete
// operational cost: the people who most need the build identity — an operator
// checking a stack after a channel switch, a support engineer asking a customer
// what they are running, a liveness probe asserting the expected build — are
// exactly the callers least likely to hold a token. Gating it would reproduce
// the failure this issue reports, one step further along. If this project ever
// ships a closed-source build, revisit this: move the full string behind the
// auth gate and leave a coarse identifier here.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { BuildInfo } from '../build-info.js';
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

// Build identity of the running image (issue #827). Every field is always
// present so consumers can parse without conditionals; an absent value reads
// back as the literal "unknown" (version/commit/sourceDigest) or null
// (builtAt) rather than as a plausible-looking wrong value.
const buildInfoSchema = z.object({
  // `git describe --tags --always --dirty` at build time, e.g.
  // "v1.5.0-56-g92a13cc", or "unknown".
  version: z.string(),
  // Commit SHA the image was built from, or "unknown".
  commit: z.string(),
  // Digest of the source tree the image was built from (reproducible from a
  // checkout via scripts/source-digest.mjs), or "unknown".
  sourceDigest: z.string(),
  // ISO-8601 build timestamp, or null.
  builtAt: z.string().nullable(),
  // package.json version — the release line, not the build identity. This is
  // the value the OpenAPI document reports as info.version.
  packageVersion: z.string()
});

// Image-level feature signals (issue #1256 review). `authGateRegistered` is the
// only member today: it reports whether the running image actually wired the
// 401 presence gate (src/auth/middleware.ts registerAuth).
//
// Why this is on the unauthenticated endpoint, and why it exists at all: before
// the application accepted `x-jwt` (#1256), the e2e suite could tell an image
// WITH an auth gate from one without by sending `x-jwt` alone from behind the
// platform ingress and expecting the application's own 401. Now that the
// application accepts that header, every request that clears the ingress
// carries a token the application admits, so a gated and an un-gated image
// answer alike and the #711 regression became unobservable from outside. This
// flag restores an observable image-level signal, so the suite can assert the
// gate is present instead of inferring it from behaviour it can no longer
// provoke.
//
// It discloses nothing an attacker can use: a `false` reading is already
// trivially observable (send an anonymous request and get a 200), and the
// source is public, so the flag only tells an operator what the code already
// tells a reader. Same reasoning as `build` above.
const featuresSchema = z.object({
  // True when registerAuth wired `app.authenticate`, i.e. the 401 presence gate
  // every protected router attaches is live in this image (issue #711 guard).
  authGateRegistered: z.boolean()
});

export const healthResponseSchema = z.object({
  status: z.string(),
  service: z.string(),
  build: buildInfoSchema,
  features: featuresSchema,
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
  // Build identity of the running image. A plain value, not a closure: unlike
  // the resolver and ingest signals it is fixed for the lifetime of the
  // process — it is baked into the image at build time.
  buildInfo: BuildInfo;
  // Read the current aggregate resolver-health snapshot at request time.
  resolverSnapshot: () => ResolverHealthSnapshot;
  // Read the ingest-availability signals at request time. Evaluated per request
  // so the reported state always reflects current configuration.
  ingestSignals: () => IngestAvailabilitySignals;
  // Read whether the 401 presence gate is wired, at request time (issue #1256
  // review). Optional: when omitted it falls back to asking THIS plugin
  // instance whether `authenticate` is decorated.
  //
  // main.ts must pass it explicitly, because fastify decorators are copied into
  // a child context when the child is registered: main.ts registers this router
  // before it calls registerAuth, so the fallback would read false there even
  // though the gate is live. Passing `() => app.hasDecorator('authenticate')`
  // closes over the ROOT instance and is evaluated per request, after boot.
  authGateRegistered?: () => boolean;
};

export const healthRouter: FastifyPluginAsync<HealthRouterOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const authGateRegistered =
    opts.authGateRegistered ?? (() => fastify.hasDecorator('authenticate'));

  app.get(
    '/health',
    { schema: { response: { 200: healthResponseSchema } } },
    async () => ({
      status: 'ok',
      service: 'open-videocore-api',
      build: opts.buildInfo,
      features: { authGateRegistered: authGateRegistered() },
      resolver: opts.resolverSnapshot(),
      ingest: computeIngestAvailability(opts.ingestSignals())
    })
  );
};
