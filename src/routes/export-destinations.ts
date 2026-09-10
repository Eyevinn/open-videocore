// Named export/delivery destinations (issue #572, parent #531/#524).
//
// DESIGN (ADR-018 D1, ratified via spike #571): a named export destination is
// NOT a distinct object with its own storage or its own secret vault. It is a
// registered storage backend (ADR-017 `StorageBackendConfig` / the #547
// StorageBackendRegistry) VIEWED IN THE OUTPUT ROLE. This router is therefore a
// thin VIEW over the SAME StorageBackendRegistry the /storage/backends surface
// uses: it reuses the same registration records and the same OSC-per-service
// credential store (ADR-018 D1, D2), introducing NO new data model and NO new
// secret store. Concretely:
//   - POST   /api/v1/export-destinations      — register an output-role backend
//   - GET    /api/v1/export-destinations      — list output-role backends (redacted)
//   - GET    /api/v1/export-destinations/:id  — resolve one by stable id (redacted)
//   - DELETE /api/v1/export-destinations/:id  — remove one by id
//
// OUTPUT ROLE: a destination is where bytes are DELIVERED/written, so it is
// registered and filtered on the packaged (write) role. The registry's
// StorageBackendRole is `source | packaged | both | archive`
// (storage-backend-registry.ts:67); the packaged role is the one the packager
// WRITE path consumes (ADR-018 C3/C4 `packagerCredentialMapping`). `both`
// additionally serves output and so also appears as a destination. `source` and
// `archive` are NOT delivery destinations and are filtered out of this view so
// the two surfaces stay conceptually distinct while sharing one store.
//
// CREDENTIALS: the raw secret is consumed by the registry's SecretStore
// (OSC per-service secrets via saveSecret) and is NEVER stored in the record,
// NEVER echoed on read — every response is the registry's redacted view
// (credentials.secretAccessKey === '***redacted***'). This is the ADR-018 D1
// credential rule, inherited unchanged from ADR-017.
//
// OUT OF SCOPE (per issue #572): wiring a destination into jobs (the optional
// reference-resolution extension of the per-execution destinationBucket, ADR-018
// D2) and per-destination path templating are separate #531 sub-issues. This
// router does NOT touch the per-execution inline `destinationBucket` override
// (ADR-011) or ingest storage.
//
// REACHABILITY (ADR-018 D3): registration-time reachability validation is
// OPTIONAL and NOT required here; it is inherited from the injected registry's
// own `validate` config (issue #550) unchanged — this router adds no probe.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  BackendValidationError,
  DefaultBackendNotDeletableError,
  type RegisteredBackendView,
  type StorageBackendRole,
  type StorageBackendRegistry
} from '../services/storage-backend-registry.js';
import { STACK_CONFIG_NAMESPACE } from '../services/workspace-stack.js';

export type ExportDestinationsRouterOptions = {
  // The SAME registry the /storage/backends surface uses (ADR-018 D1: reuse the
  // same registration records + credential store). When absent (no registry
  // wired, e.g. no param store / OSC secrets) every route responds 501, mirroring
  // the /storage/backends degradation (storage.ts:224-237).
  storageBackendRegistry?: StorageBackendRegistry;
};

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

// Registration-time validation failure (issue #550), surfaced unchanged from the
// injected registry. Same shape the /storage/backends surface returns
// (storage.ts:58-72). The secret is NEVER present.
const validationErrorSchema = z.object({
  error: z.literal('backend_validation_failed'),
  reason: z.enum([
    'unreachable',
    'unauthorized',
    'bucket_not_found',
    'forbidden_list',
    'forbidden_write',
    'forbidden_read',
    'probe_cleanup_failed',
    'unknown'
  ]),
  message: z.string(),
  code: z.string().optional()
});

// The redacted destination view. IDENTICAL in shape to the registry's
// RegisteredBackendView (storage.ts:137-155, backendViewSchema): a named export
// destination IS a registered backend (ADR-018 D1), so the surfaced shape is the
// same — secret always redacted, access key id echoed (non-secret).
const redactedMarker = z.literal('***redacted***');
const destinationViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['source', 'packaged', 'both', 'archive']),
  backend: z.literal('external'),
  bucket: z.string(),
  accessKeyId: z.string(),
  endpointUrl: z.string().optional(),
  region: z.string().optional(),
  // The static delivery prefix captured once (issue #572 scope: "a static
  // prefix"). The registry models the public origin as publicBaseUrl
  // (StorageBackendConfig.publicBaseUrl, param-store.ts:33-40); there is no
  // separate record field for a key prefix, so it is surfaced as part of the
  // backend coordinates unchanged — ADR-018 forbids changing the record shape.
  publicBaseUrl: z.string().optional(),
  hasSessionToken: z.boolean(),
  deletable: z.boolean(),
  createdAt: z.string(),
  credentials: z.object({
    accessKeyId: z.string(),
    secretAccessKey: redactedMarker,
    sessionToken: redactedMarker.optional()
  })
});

const destinationListSchema = z.object({
  destinations: z.array(destinationViewSchema)
});

// Register request. An export destination is an OUTPUT-role backend, so role is
// fixed to the two output-serving roles (packaged | both) rather than reusing the
// full registry enum — a caller cannot register a source/archive-only backend as
// a delivery destination through this surface. Every other field mirrors the
// registry's registerBackendSchema (storage.ts:116-129); the secret fields are
// validated here, NEVER echoed, and handed to the registry's OSC secret store.
const registerDestinationSchema = z.object({
  name: z.string().min(1).max(256),
  role: z.enum(['packaged', 'both']).default('packaged'),
  bucket: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  region: z.string().min(1).optional(),
  endpointUrl: z.string().url().optional(),
  sessionToken: z.string().min(1).optional(),
  publicBaseUrl: z.string().url().optional()
});

// A registered backend is an export/delivery DESTINATION when it serves the
// output (write) path — role 'packaged' or 'both'. 'source' and 'archive' are
// read/cold roles, not delivery destinations, so they are excluded from this
// view even though they live in the same registry.
function isExportDestination(role: StorageBackendRole): boolean {
  return role === 'packaged' || role === 'both';
}

export const exportDestinationsRouter: FastifyPluginAsync<
  ExportDestinationsRouterOptions
> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const registry = opts.storageBackendRegistry;

  // Deployment workspace (tenant) id under which backend records are namespaced.
  // Matches the /storage/backends surface (storage.ts:187) so both surfaces
  // address the SAME records for the SAME tenant (ADR-017 D2).
  const workspaceId = STACK_CONFIG_NAMESPACE;

  app.setErrorHandler((err, _request, reply) => {
    // The OSC-managed default is not deletable (ADR-017 D3) -> 409, same as
    // /storage/backends (storage.ts:191-193).
    if (err instanceof DefaultBackendNotDeletableError) {
      return reply.code(409).send({ error: 'conflict', message: err.message });
    }
    // Registration-time reachability / permission validation failed (issue
    // #550): the destination was NOT registered. Same 422 envelope the
    // /storage/backends surface uses; the secret is never present.
    if (err instanceof BackendValidationError) {
      return reply.code(422).send({
        error: 'backend_validation_failed' as const,
        reason: err.reason,
        message: err.message,
        ...(err.code ? { code: err.code } : {})
      });
    }
    throw err;
  });

  // Uniform 501 payload when no registry (and therefore no secret store) is
  // wired. Returned by each handler's own reply so the reply type stays precise.
  const notConfiguredPayload = {
    error: 'not_configured' as const,
    message: 'export destinations are not configured'
  };

  // Register a named export destination (an output-role external backend).
  //   201 — redacted destination view (secret never echoed)
  //   422 — registration-time reachability/permission validation failed (#550)
  //   501 — registry / OSC secret storage not configured
  app.post(
    '/',
    {
      schema: {
        body: registerDestinationSchema,
        response: { 201: destinationViewSchema, 422: validationErrorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      if (!registry) return reply.code(501).send(notConfiguredPayload);
      // Without a secret sink we cannot honour the ADR-018/ADR-017 credential
      // contract; refuse rather than silently drop the access key + secret
      // (mirrors storage.ts:232-237).
      if (!registry.canStoreSecrets) {
        return reply.code(501).send({
          error: 'not_configured',
          message: 'OSC secret storage is not configured; cannot store destination credentials'
        });
      }
      const view = await registry.register(workspaceId, request.body);
      return reply.code(201).send(view);
    }
  );

  // List every registered export destination (output-role backends), redacted.
  // The implicit OSC-managed default (role 'both') is an output destination and
  // so appears here too (via registry.list), marked non-deletable.
  //   200 — { destinations: [ ...redacted views ] }
  //   501 — registry not configured
  app.get(
    '/',
    { schema: { response: { 200: destinationListSchema, 501: errorSchema } } },
    async (_request, reply) => {
      if (!registry) return reply.code(501).send(notConfiguredPayload);
      const all = await registry.list(workspaceId);
      const destinations = all.filter((b: RegisteredBackendView) => isExportDestination(b.role));
      return reply.code(200).send({ destinations });
    }
  );

  // Resolve a single export destination by its stable id (issue #572 / ADR-018
  // D1: "resolvable by a stable id/name"). A non-output-role backend id (source /
  // archive) is NOT a destination and resolves to 404 through this surface, so a
  // caller cannot dereference a non-delivery backend as a destination.
  //   200 — redacted destination view
  //   404 — unknown id, or an id that is not an output-role destination
  //   501 — registry not configured
  app.get(
    '/:id',
    {
      schema: {
        params: z.object({ id: z.string().min(1).max(256) }),
        response: { 200: destinationViewSchema, 404: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      if (!registry) return reply.code(501).send(notConfiguredPayload);
      const view = await registry.get(workspaceId, request.params.id);
      if (!view || !isExportDestination(view.role)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(view);
    }
  );

  // Remove an export destination by id. The implicit OSC-managed default (id
  // 'default') is NOT deletable (ADR-017 D3) -> 409. Removing an unknown id is an
  // idempotent no-op that still answers 204 (mirrors /storage/backends).
  //   204 — removed (or already absent)
  //   409 — attempt to remove the OSC-managed default
  //   501 — registry not configured
  app.delete(
    '/:id',
    {
      schema: {
        params: z.object({ id: z.string().min(1).max(256) }),
        response: { 204: z.null(), 409: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      if (!registry) return reply.code(501).send(notConfiguredPayload);
      await registry.remove(workspaceId, request.params.id);
      return reply.code(204).send(null);
    }
  );
};
