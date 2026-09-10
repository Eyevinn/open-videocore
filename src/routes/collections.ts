// Workspace-scoped collections router (issue #11).
//
// A collection is a named, workspace-scoped group of asset ids — a lightweight
// way to organise assets into ad-hoc sets without changing the assets
// themselves. Every route is behind `authenticate`, so each handler runs with a
// validated request.workspaceId and the collection repo scopes every read/write
// to that workspace. A collection id from another workspace is treated as a
// miss (existence is not leaked).
//
//   POST   /api/v1/collections                       — create { name }
//   GET    /api/v1/collections                       — list this workspace's collections
//   GET    /api/v1/collections/:id                   — get one, with resolved asset list
//   PATCH  /api/v1/collections/:id                   — partial update of descriptive metadata (#560)
//   DELETE /api/v1/collections/:id                   — delete a collection
//   PUT    /api/v1/collections/:id/assets/:assetId   — add an asset to a collection
//   DELETE /api/v1/collections/:id/assets/:assetId   — remove an asset from a collection
//
// Membership stores asset ids only; the GET /:id route resolves them to live
// assets at read time, silently dropping any id that no longer resolves in the
// workspace (e.g. a hard-deleted asset). Adding an asset id that does not refer
// to a live asset is rejected with 422 so callers cannot build dangling sets.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WorkspaceAccessError } from '../data/guard.js';
import { resourceAuthorizationPreHandler } from '../auth/authorize.js';
import {
  CollectionDeleteProtectedError,
  CollectionNotFoundError,
  type CollectionRepository
} from '../data/collection-repo.js';
import type { Asset, AssetRepository } from '../data/asset-repo.js';
import { emitAudit, originActor, type AuditEmitter } from '../data/audit-emit.js';

// Shared error envelope. `reason` is OPTIONAL and machine-readable: cap-breach
// 400s (issue #562) set it to the specific limit hit, while the framework's own
// zod request-validation 400 (no `reason`) still serializes against this schema.
// Kept permissive on purpose — narrowing it to a cap-only shape would make the
// validation-error body fail response serialization (FST_ERR_FAILED_ERROR_SERIALIZATION).
const errorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  reason: z.string().optional()
});

// Explicit delete-lock (ADR-020 decision 3, issue #568). Field names/types
// mirror ADR-020 exactly: locked, reason?, lockedAt, lockedBy?.
const deleteLockSchema = z.object({
  locked: z.boolean(),
  reason: z.string().optional(),
  lockedAt: z.string(),
  lockedBy: z.string().optional()
});

// Shared blocked-delete envelope (ADR-020 decision 1, issue #568). EXTENDS the
// existing `{ error, message? }` shape with the required `reason` enum and
// `blockedBy` object. For the explicit-lock case reason is `delete_protected`
// and both id arrays are empty.
const deleteBlockedSchema = z.object({
  error: z.literal('delete_blocked'),
  message: z.string().optional(),
  reason: z.enum(['referenced_by_job', 'member_of_collection', 'delete_protected']),
  blockedBy: z.object({
    jobIds: z.array(z.string()),
    collectionIds: z.array(z.string())
  })
});

// Descriptive metadata (issue #559), mirroring the asset `descriptive`
// namespace (ADR-005 typed-core + open-`custom`, see asset-document.ts) at a
// smaller scale. All three are OPTIONAL so a collection created without them is
// serialised exactly as before (fields absent):
//   - description: free-form editorial string.
//   - tags:        first-class string labels (z.array(z.string())).
//   - custom:      open key/value bag (z.record(z.unknown())), matching the
//                  asset descriptive `custom` shape.
const collectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  assetIds: z.array(z.string()),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  custom: z.record(z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Explicit delete-lock (ADR-020 decision 3, issue #568). Absent = unlocked.
  deleteLock: deleteLockSchema.optional()
});

// GET /:id returns the collection plus the resolved live assets. Assets are
// loosely typed here (passthrough) — the assets router owns the canonical asset
// schema; collections only need to surface them.
const collectionWithAssetsSchema = collectionSchema.extend({
  assets: z.array(z.record(z.unknown()))
});

// Descriptive-metadata caps (issue #562). The `custom` bag is an open key/value
// structure; without bounds a caller can inflate a single collection document
// unbounded, the ADR-005 concern that open metadata bags must be bounded at the
// API layer. The per-field caps are aligned with the EXISTING asset-side caps so
// collection and asset metadata behave consistently:
//   - description: max 2048 chars   (asset createSchema.description, assets.ts:303)
//   - tags:        max 128 entries, each 1..128 chars
//                  (asset tagSchema/tagsSchema, assets.ts:294-295)
//   - custom:      the asset `metadata`/`custom` bag carries NO serialized cap
//                  today (assets.ts:290 `z.record(z.unknown())`), so there is no
//                  asset-side number to mirror. This issue introduces the bound
//                  the ADR-005 concern calls for: a serialized-size ceiling on the
//                  `custom` bag, chosen generous enough for real descriptive use
//                  while bounding document growth.
export const COLLECTION_DESCRIPTION_MAX_LENGTH = 2048;
export const COLLECTION_TAGS_MAX_COUNT = 128;
export const COLLECTION_TAG_MAX_LENGTH = 128;
export const COLLECTION_CUSTOM_MAX_SERIALIZED_BYTES = 16 * 1024; // 16 KiB

// Machine-readable reasons for a cap breach (issue #562). Each is returned in the
// 400 body's `reason` field so a client can branch on the specific limit hit
// rather than parse a human message.
export type CollectionMetadataCapReason =
  | 'description_too_long'
  | 'too_many_tags'
  | 'tag_too_long'
  | 'custom_too_large';

export type CollectionMetadataCapViolation = {
  reason: CollectionMetadataCapReason;
  message: string;
};

// Shared cap check, run against the SAME fields on both the create and update
// paths so the two cannot drift (create and update accept identical descriptive
// fields). Returns the first violation, or undefined when within every cap. Only
// present fields are checked: an absent field on PATCH leaves the stored value
// untouched and is not re-validated here.
export function checkCollectionMetadataCaps(input: {
  description?: string;
  tags?: string[];
  custom?: Record<string, unknown>;
}): CollectionMetadataCapViolation | undefined {
  if (
    input.description !== undefined &&
    input.description.length > COLLECTION_DESCRIPTION_MAX_LENGTH
  ) {
    return {
      reason: 'description_too_long',
      message: `description exceeds the maximum length of ${COLLECTION_DESCRIPTION_MAX_LENGTH} characters`
    };
  }
  if (input.tags !== undefined) {
    if (input.tags.length > COLLECTION_TAGS_MAX_COUNT) {
      return {
        reason: 'too_many_tags',
        message: `tags exceeds the maximum of ${COLLECTION_TAGS_MAX_COUNT} entries`
      };
    }
    for (const tag of input.tags) {
      if (tag.length > COLLECTION_TAG_MAX_LENGTH) {
        return {
          reason: 'tag_too_long',
          message: `a tag exceeds the maximum length of ${COLLECTION_TAG_MAX_LENGTH} characters`
        };
      }
    }
  }
  if (input.custom !== undefined) {
    // Bound the bag by its serialized size (UTF-8 bytes), which is what actually
    // grows the stored document — a single huge value or thousands of small keys
    // both inflate it. Measuring the serialized form catches both.
    const serializedBytes = Buffer.byteLength(JSON.stringify(input.custom), 'utf8');
    if (serializedBytes > COLLECTION_CUSTOM_MAX_SERIALIZED_BYTES) {
      return {
        reason: 'custom_too_large',
        message: `custom exceeds the maximum serialized size of ${COLLECTION_CUSTOM_MAX_SERIALIZED_BYTES} bytes`
      };
    }
  }
  return undefined;
}

const createBodySchema = z.object({
  name: z.string().min(1).max(256),
  // Optional descriptive metadata accepted at create time (issue #559). Mirrors
  // the asset `descriptive` namespace (typed-core + open-`custom`, ADR-005);
  // all optional so `POST /collections { name }` is unchanged. Size/length caps
  // are enforced in-handler via checkCollectionMetadataCaps (issue #562) so the
  // 400 carries a machine-readable `reason`.
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  custom: z.record(z.unknown()).optional()
});

// PATCH /:id body (issue #560): a PARTIAL update of a collection's descriptive
// metadata. Only description/tags/custom are editable here; every present key is
// applied wholesale, an absent key leaves the current value untouched, and an
// explicit empty value (`''`/`[]`/`{}`) clears the field. Membership (`assetIds`)
// is deliberately NOT accepted — it stays on PUT/DELETE /:id/assets/:assetId —
// and neither `name` nor `deleteLock` is editable through this path. `.strict()`
// rejects any unknown key (including `assetIds`) with a 400 so callers cannot
// smuggle a membership mutation through the metadata endpoint.
const updateBodySchema = z
  .object({
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    custom: z.record(z.unknown()).optional()
  })
  .strict();

type CollectionsRouterOptions = {
  repository: CollectionRepository;
  // Asset repository, used to (a) validate an asset exists before adding it to a
  // collection and (b) resolve the membership list to live assets on GET /:id.
  assetRepository: AssetRepository;
  // Best-effort audit emission (issue #564). Wired to the append-only audit
  // store's `record()` write primitive. When absent, mutations proceed
  // un-audited (no-op). Emission is fire-and-forget: a failed audit write is
  // logged, never propagated — no route becomes newly failable.
  audit?: AuditEmitter;
};

export const collectionsRouter: FastifyPluginAsync<CollectionsRouterOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository;
  const assets = opts.assetRepository;
  // Best-effort audit emitter (issue #564). Undefined => mutations run un-audited.
  const audit = opts.audit;

  // Router-layer method→action authorisation gate (ADR-018 decision 2, seam 1;
  // issue #554). Registered plugin-scoped so it runs on EVERY collection route
  // (Fastify encapsulation) before the handler: it derives the action from the
  // HTTP method and calls authorize(role, 'collection'). Per ADR-018 decision 4
  // there is NO collection→asset cascade — a collection is authorised as a
  // 'collection' resource against the same workspace role that authorises assets;
  // membership never widens or narrows access. Denials are a fail-closed 403 with
  // the stable AUTHZ_FORBIDDEN_ERROR reason code, distinct from the 401 presence
  // gate (decision 5).
  app.addHook('preHandler', resourceAuthorizationPreHandler('collection'));

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof WorkspaceAccessError) {
      return reply.code(err.statusCode).send({ error: 'forbidden', message: err.message });
    }
    if (err instanceof CollectionNotFoundError) {
      return reply.code(404).send({ error: 'not_found', message: err.message });
    }
    // Explicit delete-lock (ADR-020 decision 1, issue #568): the shared
    // `delete_blocked` envelope, reason `delete_protected`, empty blockedBy.
    if (err instanceof CollectionDeleteProtectedError) {
      return reply.code(409).send({
        error: 'delete_blocked',
        message: err.message,
        reason: 'delete_protected',
        blockedBy: { jobIds: [], collectionIds: [] }
      });
    }
    throw err;
  });

  app.post(
    '/',
    {
      
      schema: {
        body: createBodySchema,
        response: { 201: collectionSchema, 400: errorSchema }
      }
    },
    async (request, reply) => {
      // Enforce descriptive-metadata caps before persisting (issue #562) so an
      // oversized document is rejected rather than stored.
      const violation = checkCollectionMetadataCaps(request.body);
      if (violation) {
        return reply.code(400).send({ error: 'metadata_cap_exceeded', ...violation });
      }
      const collection = await repo.create(request.body);
      // Audit: collection created (issue #564). One entry, targetId = new id.
      emitAudit(
        audit,
        {
          actor: originActor('user'),
          action: 'collection.created',
          targetType: 'collection',
          targetId: collection.id,
          detail: { name: collection.name }
        },
        request.log
      );
      return reply.code(201).send(collection);
    }
  );

  app.get(
    '/',
    {
      
      schema: { response: { 200: z.object({ collections: z.array(collectionSchema) }) } }
    },
    async (request, reply) => {
      const collections = await repo.list();
      return reply.code(200).send({ collections });
    }
  );

  app.get(
    '/:id',
    {
      
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: collectionWithAssetsSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const collection = await repo.get(request.params.id);
      if (!collection) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // Resolve membership to live assets, dropping ids that no longer resolve.
      const resolved = await Promise.all(
        collection.assetIds.map((assetId) => assets.get(assetId))
      );
      const liveAssets = resolved.filter((a): a is Asset => a !== undefined);
      return reply.code(200).send({ ...collection, assets: liveAssets });
    }
  );

  // Partial update of a collection's descriptive metadata (issue #560). PATCH
  // (not PUT) so callers send only the fields they intend to change; the body is
  // `.strict()` so membership (`assetIds`), `name`, and `deleteLock` are all
  // rejected (400) — membership stays on PUT/DELETE /:id/assets/:assetId. The
  // CouchDB backend routes this through the `_rev` merge-retry wrapper
  // (updateWithRetry, ADR-005 / issue #278), the same concurrency model the asset
  // editorial write uses, so a racing membership add re-bases rather than
  // clobbers.
  //   200 — updated collection returned
  //   404 — unknown/foreign collection (repo throws CollectionNotFoundError)
  app.patch(
    '/:id',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: updateBodySchema,
        response: { 200: collectionSchema, 400: errorSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      // Enforce the SAME descriptive-metadata caps on the update path (issue
      // #562) so a PATCH cannot grow a document past a bound the create path
      // refuses. Only present fields are checked (an absent field is untouched).
      const violation = checkCollectionMetadataCaps(request.body);
      if (violation) {
        return reply.code(400).send({ error: 'metadata_cap_exceeded', ...violation });
      }
      // repo.update throws CollectionNotFoundError (-> 404) for an unknown id.
      const collection = await repo.update(request.params.id, request.body);
      return reply.code(200).send(collection);
    }
  );

  app.delete(
    '/:id',
    {

      schema: {
        params: z.object({ id: z.string() }),
        response: { 204: z.null(), 404: errorSchema, 409: deleteBlockedSchema }
      }
    },
    async (request, reply) => {
      // Explicit delete-lock (ADR-020 decisions 1 & 2, issue #568). A locked
      // collection is a HARD block: this guard is unconditional and runs BEFORE
      // the delete, so `?force=true` cannot bypass it (force is never consulted
      // here). Cleared only via DELETE /:id/lock. A locked collection therefore
      // resolves (not a silent miss), so the 409 is authoritative.
      const existing = await repo.get(request.params.id);
      if (existing?.deleteLock?.locked) {
        throw new CollectionDeleteProtectedError(request.params.id);
      }
      // Delete is idempotent and never leaks existence across workspaces: an
      // unknown / foreign id is a silent no-op that still answers 204.
      await repo.delete(request.params.id);
      // Audit: collection deleted (issue #564). Emitted ONLY when a collection
      // actually existed (resolved above), so an idempotent no-op on an unknown
      // / foreign id produces no entry — exactly one entry per real deletion.
      if (existing) {
        emitAudit(
          audit,
          {
            actor: originActor('user'),
            action: 'collection.deleted',
            targetType: 'collection',
            targetId: existing.id,
            detail: { name: existing.name }
          },
          request.log
        );
      }
      return reply.code(204).send(null);
    }
  );

  // Explicit delete-lock set/clear (ADR-020 decision 3, issue #568). A DEDICATED
  // system write path for the top-level `deleteLock` flag, chosen as a
  // `/:id/lock` sub-resource with PUT (set) / DELETE (clear) — consistent with
  // the collections router's existing PUT/DELETE `/:id/assets/:assetId`
  // sub-resource convention and the asset router's `/:id/lock`. Kept separate
  // from create/addAsset/removeAsset so the lock is never set through a general
  // collection mutation. The lock's `lockedAt`/`lockedBy` are the traceable
  // administrative record of the change (collections carry no provenance array —
  // ADR-020 pins the lock's own fields as that record for collections).
  //   200 — lock set, collection returned (deleteLock present + locked)
  //   404 — unknown/foreign collection
  app.put(
    '/:id/lock',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z
          .object({
            reason: z.string().max(1024).optional(),
            lockedBy: z.string().max(256).optional()
          })
          .default({}),
        response: { 200: collectionSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      // setDeleteLock throws CollectionNotFoundError (-> 404) for an unknown id.
      const collection = await repo.setDeleteLock(request.params.id, {
        locked: true,
        reason: request.body.reason,
        lockedBy: request.body.lockedBy
      });
      return reply.code(200).send(collection);
    }
  );

  // Clear the explicit delete-lock (ADR-020 decision 3, issue #568). The only
  // way to lift protection — `?force=true` on DELETE /:id does NOT (decision 2).
  //   200 — lock cleared, collection returned (deleteLock absent)
  //   404 — unknown/foreign collection
  app.delete(
    '/:id/lock',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: collectionSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const collection = await repo.setDeleteLock(request.params.id, { locked: false });
      return reply.code(200).send(collection);
    }
  );

  app.put(
    '/:id/assets/:assetId',
    {
      
      schema: {
        params: z.object({ id: z.string(), assetId: z.string() }),
        response: { 200: collectionSchema, 404: errorSchema, 422: errorSchema }
      }
    },
    async (request, reply) => {
      // Reject membership for an asset that does not exist in this workspace so
      // collections never accumulate dangling ids. A foreign asset id resolves
      // to a miss here (existence not leaked) -> 422.
      const asset = await assets.get(request.params.assetId);
      if (!asset) {
        return reply.code(422).send({
          error: 'asset_not_found',
          message: `asset not found: ${request.params.assetId}`
        });
      }
      // mutate throws CollectionNotFoundError (-> 404) for an unknown collection.
      const collection = await repo.addAsset(request.params.id,
        request.params.assetId
      );
      // Audit: collection membership add (issue #564). One entry; a 422 (asset
      // missing) or 404 (unknown collection) never reaches here.
      emitAudit(
        audit,
        {
          actor: originActor('user'),
          action: 'collection.member_added',
          targetType: 'collection',
          targetId: collection.id,
          detail: { assetId: request.params.assetId }
        },
        request.log
      );
      return reply.code(200).send(collection);
    }
  );

  app.delete(
    '/:id/assets/:assetId',
    {
      
      schema: {
        params: z.object({ id: z.string(), assetId: z.string() }),
        response: { 200: collectionSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      // Removing an absent asset id is a no-op (still 200). An unknown
      // collection id throws CollectionNotFoundError (-> 404).
      const collection = await repo.removeAsset(request.params.id,
        request.params.assetId
      );
      // Audit: collection membership remove (issue #564). One entry; a 404
      // (unknown collection) never reaches here. Removing an absent asset id is a
      // 200 no-op on the primary op and still records the operator's intent.
      emitAudit(
        audit,
        {
          actor: originActor('user'),
          action: 'collection.member_removed',
          targetType: 'collection',
          targetId: collection.id,
          detail: { assetId: request.params.assetId }
        },
        request.log
      );
      return reply.code(200).send(collection);
    }
  );
};
