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
// PATH TEMPLATING (issue #574): a destination MAY additionally carry an optional
// `pathTemplate` that keys packaged output UNDER the destination bucket (rendered
// at job time — {date}/{assetId}/…, see services/destination-path-template.ts).
// It is validated at registration time here (unknown token / malformed brace ->
// 400 invalid_path_template) and applied by the SAME job-reference relocation
// path (StorageBackendRegistry.resolveDestinationBucket). It is purely additive:
// a destination with no template keeps the pre-#574 static-prefix behaviour.
//
// OUT OF SCOPE (per issue #572): this router does NOT touch the per-execution
// inline `destinationBucket` override (ADR-011) or ingest storage.
//
// REACHABILITY (ADR-018 D3): registration-time reachability validation is
// OPTIONAL and NOT required here; it is inherited from the injected registry's
// own `validate` config (issue #550) unchanged — this router adds no probe.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  BackendValidationError,
  BackendInUseError,
  DefaultBackendNotDeletableError,
  ImmutableDefaultBackendError,
  type RegisteredBackendView,
  type StorageBackendRole,
  type StorageBackendRegistry
} from '../services/storage-backend-registry.js';
import { InvalidPathTemplateError } from '../services/destination-path-template.js';
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
  // OPTIONAL per-destination path template (issue #574). Echoed back on the view
  // so an operator can confirm the keying rule captured for this destination.
  // Absent means the static-prefix behaviour (the bare `<bucket>/`) is used
  // unchanged. It is non-secret operator config, so it is safe to echo.
  pathTemplate: z.string().optional(),
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

// Registration-time 400 body. Covers BOTH the issue #574 path-template rejection
// (`error: 'invalid_path_template'`, optional offending `token`) AND the generic
// request-validation envelope fastify-type-provider-zod emits for a malformed
// body (e.g. an out-of-enum role), which carries a `statusCode`/`code`. Kept
// permissive (passthrough) so the 400 serializer never rejects a validation
// error it did not mint — a too-strict literal here would turn a 400 into a 500.
const pathTemplateErrorSchema = z
  .object({
    error: z.string(),
    message: z.string().optional(),
    token: z.string().optional()
  })
  .passthrough();

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
  publicBaseUrl: z.string().url().optional(),
  // OPTIONAL per-destination path template (issue #574). When supplied, packaged
  // output is keyed UNDER the destination bucket using this template, rendered at
  // job time. Supported tokens: {date} (UTC YYYY-MM-DD), {year}, {month}, {day}
  // (UTC, zero-padded), {assetId}. A literal brace is doubled: {{ -> { and }} ->
  // }. Any unknown token or malformed brace is REJECTED here at registration time
  // with a 400 (invalid_path_template). Omit the field to keep the static-prefix
  // behaviour unchanged. The token set + escaping are the single source of truth
  // in services/destination-path-template.ts (PATH_TEMPLATE_TOKENS).
  pathTemplate: z.string().min(1).max(1024).optional()
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
    // The OSC-managed default is not deletable (ADR-017 D3) -> 409. This surface
    // keeps its established 409 contract for the default: issue #679 folded the
    // default's immutability on the /storage/backends surface into a 403, but the
    // export-destinations contract (and its test) is unchanged here, so we map
    // BOTH the legacy DefaultBackendNotDeletableError and the new
    // ImmutableDefaultBackendError (which registry.remove now throws) to the same
    // 409 this surface has always returned.
    if (
      err instanceof DefaultBackendNotDeletableError ||
      err instanceof ImmutableDefaultBackendError
    ) {
      return reply.code(409).send({ error: 'conflict', message: err.message });
    }
    // The destination is still referenced by an asset or active job (issue #679)
    // -> 409 with a human-readable message + the non-secret reference ids. Only
    // fires when a reference checker is wired on the shared registry.
    if (err instanceof BackendInUseError) {
      return reply.code(409).send({ error: 'conflict', message: err.message });
    }
    // Issue #574: the registration carried a path template with an unknown token
    // or malformed brace. The destination was NOT registered. Surface a clear,
    // machine-readable 400 naming the offending token (never a secret — a path
    // template is non-secret operator config).
    if (err instanceof InvalidPathTemplateError) {
      return reply.code(400).send({
        error: 'invalid_path_template' as const,
        message: err.message,
        ...(err.token !== undefined ? { token: err.token } : {})
      });
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
        response: {
          201: destinationViewSchema,
          400: pathTemplateErrorSchema,
          422: validationErrorSchema,
          501: errorSchema
        }
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
