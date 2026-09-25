// Workspace-scoped webhook registration router (issue #13).
//
// Lets integrators register HTTP endpoints to receive event notifications when
// assets/jobs change status, instead of polling. Every route is behind
// `authenticate`, so each handler runs with a validated request.workspaceId and
// the webhook repo scopes every read/write to that workspace. A registration id
// from another workspace is treated as a miss (existence is not leaked).
//
//   POST   /api/v1/webhooks       — register { url, events, secret? }
//   GET    /api/v1/webhooks       — list this workspace's registrations
//   DELETE /api/v1/webhooks/:id   — remove a registration
//
// `url` must be a valid http(s) URL; `events` must be a non-empty array of
// known event-type strings. A `secret`, when provided, is used by the
// dispatcher to sign deliveries (X-Webhook-Signature) and is echoed back only
// in the immediate create response.
//
// That last restriction is enforced by two response shapes rather than one
// (issue #821). The list route previously reused the create response schema,
// which carried `secret`, so any caller who could list registrations could read
// every signing secret back in plaintext and forge deliveries. The list route
// now serialises through `listedRegistrationSchema`, which has no `secret` at
// all, and `toListedRegistration` drops the field before it ever reaches the
// serialiser. Callers that need to know whether signing is configured read the
// non-sensitive `hasSecret` boolean. There is deliberately no read-back path: a
// caller who loses a secret re-registers.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WorkspaceAccessError } from '../data/guard.js';
import {
  WEBHOOK_EVENT_TYPES,
  type WebhookRegistration,
  type WebhookRepository
} from '../data/webhook-repo.js';
import { authGate } from '../auth/middleware.js';

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

// Fields safe to return on every read of a registration. `hasSecret` reports
// whether signing is configured without disclosing the value (issue #821).
const registrationBaseSchema = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  hasSecret: z.boolean(),
  createdAt: z.string()
});

// 201 response only: the documented one-time echo of the submitted secret. The
// caller just supplied this value, so returning it discloses nothing new.
const createdRegistrationSchema = registrationBaseSchema.extend({
  secret: z.string().optional()
});

// 200 (list) response: no `secret` key exists on this schema, so the zod
// serialiser strips it even if a future caller forgets the mapper below.
const listedRegistrationSchema = registrationBaseSchema;

const createBodySchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
  secret: z.string().min(1).max(256).optional()
});

type WebhooksRouterOptions = {
  repository: WebhookRepository;
};

// Projection from the stored registration (WebhookRegistration in
// data/webhook-repo.ts:40-49, where `secret?: string` is persisted) to the
// read-safe API shape. Explicitly enumerating the fields — rather than
// spreading and deleting — means a secret-like field added to the stored
// record in future cannot leak through the list route by default.
function toListedRegistration(
  registration: WebhookRegistration
): z.infer<typeof listedRegistrationSchema> {
  return {
    id: registration.id,
    url: registration.url,
    events: registration.events,
    hasSecret: typeof registration.secret === 'string' && registration.secret.length > 0,
    createdAt: registration.createdAt
  };
}

// Create (201) response: the read-safe projection plus the one-time echo.
function toCreatedRegistration(
  registration: WebhookRegistration
): z.infer<typeof createdRegistrationSchema> {
  const listed = toListedRegistration(registration);
  return registration.secret ? { ...listed, secret: registration.secret } : listed;
}

export const webhooksRouter: FastifyPluginAsync<WebhooksRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository;

  // 401 presence gate (issue #711): reject anonymous requests to this
  // workspace-scoped router. Plugin-scoped so it does not affect public routers.
  // See src/routes/assets.ts for the full rationale.
  app.addHook('preHandler', authGate(app));

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof WorkspaceAccessError) {
      return reply.code(err.statusCode).send({ error: 'forbidden', message: err.message });
    }
    throw err;
  });

  app.post(
    '/',
    {
      
      schema: {
        body: createBodySchema,
        response: { 201: createdRegistrationSchema, 400: errorSchema }
      }
    },
    async (request, reply) => {
      const registration = await repo.create(request.body);
      return reply.code(201).send(toCreatedRegistration(registration));
    }
  );

  app.get(
    '/',
    {
      
      schema: {
        response: { 200: z.object({ webhooks: z.array(listedRegistrationSchema) }) }
      }
    },
    async (request, reply) => {
      const webhooks = await repo.list();
      // Project before sending: the stored records carry `secret`, and it must
      // not reach the response body (issue #821).
      return reply.code(200).send({ webhooks: webhooks.map(toListedRegistration) });
    }
  );

  app.delete(
    '/:id',
    {
      
      schema: {
        params: z.object({ id: z.string() }),
        response: { 204: z.null(), 404: errorSchema }
      }
    },
    async (request, reply) => {
      // Delete is idempotent and never leaks existence across workspaces: an
      // unknown / foreign id is a silent no-op that still answers 204.
      await repo.delete(request.params.id);
      return reply.code(204).send(null);
    }
  );
};
