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

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WorkspaceAccessError } from '../data/guard.js';
import {
  WEBHOOK_EVENT_TYPES,
  type WebhookRepository
} from '../data/webhook-repo.js';

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

const registrationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  secret: z.string().optional(),
  createdAt: z.string()
});

const createBodySchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
  secret: z.string().min(1).max(256).optional()
});

type WebhooksRouterOptions = {
  repository: WebhookRepository;
};

export const webhooksRouter: FastifyPluginAsync<WebhooksRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository;
  const guarded = { onRequest: app.authenticate };

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof WorkspaceAccessError) {
      return reply.code(err.statusCode).send({ error: 'forbidden', message: err.message });
    }
    throw err;
  });

  app.post(
    '/',
    {
      ...guarded,
      schema: {
        body: createBodySchema,
        response: { 201: registrationSchema, 400: errorSchema }
      }
    },
    async (request, reply) => {
      const registration = await repo.create(request.workspaceId, request.body);
      return reply.code(201).send(registration);
    }
  );

  app.get(
    '/',
    {
      ...guarded,
      schema: {
        response: { 200: z.object({ webhooks: z.array(registrationSchema) }) }
      }
    },
    async (request, reply) => {
      const webhooks = await repo.list(request.workspaceId);
      return reply.code(200).send({ webhooks });
    }
  );

  app.delete(
    '/:id',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 204: z.null(), 404: errorSchema }
      }
    },
    async (request, reply) => {
      // Delete is idempotent and never leaks existence across workspaces: an
      // unknown / foreign id is a silent no-op that still answers 204.
      await repo.delete(request.workspaceId, request.params.id);
      return reply.code(204).send(null);
    }
  );
};
