import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  Context,
  createInstance,
  getInstance,
  removeInstance,
  saveSecret
} from '@osaas/client-core';
import {
  OPTIONAL_SERVICES,
  findOptionalService,
  type OptionalServiceDescriptor
} from '../services/optional-services.js';
import type { OperationStore } from '../services/operation-store.js';

// Per-optional-service provision / deprovision / status endpoints (issue #195).
//
// These mirror the whole-stack provision route's operation-store + 202-polling
// pattern (routes/provision.ts) but operate on ONE opt-in service instance
// (auto-subtitles, scene-detect) keyed by its registry `key`. The contract is
// generic (table-driven from OPTIONAL_SERVICES) so #187 and #188 consume the
// same endpoints.
//
// INSTANCE-NAME DISCOVERY (why status queries OSC, not a param store):
// This status endpoint reports the AUTO_SUBTITLES_INSTANCE_NAME /
// SCENE_DETECT_INSTANCE_NAME env vars as the deployment's declared config for
// the #187/#188 provision cards.
//   - The provision request supplies the instance `name`; we create the OSC
//     instance under it and RETURN that name.
//   - The status endpoint reports the env var and probes OSC (getInstance) for
//     the configured name to report whether the instance is live (`active`).
// NOTE (issue #217): the PIPELINE steps no longer activate from these env vars —
// the runtime derives activation from the ACTIVE stack record
// (StackConfig.autoSubtitlesInstanceName / sceneDetectInstanceName), so a
// freshly provisioned optional service is picked up on the next pipeline run
// with NO restart. This card's env-var view therefore reflects the deployment's
// declared intent, while actual step activation follows the provisioned stack.

type OptionalServicesRouterOptions = {
  osc: Context;
  // Reuses the SAME in-memory operation store the whole-stack provision route
  // uses so POST /:key/provision and DELETE /:key return 202 + operationId and
  // the caller polls GET /api/v1/provision/operations/:id (that router owns the
  // operations endpoints; both write to the shared store).
  operationStore: OperationStore;
};

// Per-service status. `state`:
//   not-configured — the instance-name env var is unset. The runtime has the
//                    pipeline step disabled. Degrades gracefully; never throws.
//   configured     — the env var is set but no live OSC instance was found under
//                    that name (provisioning pending, deprovisioned, or the name
//                    is stale).
//   active         — the env var is set AND a live OSC instance exists under it.
const statusSchema = z.object({
  key: z.string(),
  serviceId: z.string(),
  displayName: z.string(),
  instanceNameEnvVar: z.string(),
  state: z.enum(['not-configured', 'configured', 'active']),
  // Present only when the env var is set (configured/active).
  instanceName: z.string().optional(),
  // The live instance URL, present only when state === 'active'.
  url: z.string().optional()
});

type ServiceStatus = z.infer<typeof statusSchema>;

const acceptedSchema = z.object({
  operationId: z.string(),
  key: z.string(),
  name: z.string(),
  status: z.literal('pending')
});

const notFoundSchema = z.object({ error: z.string() });
const badRequestSchema = z.object({ error: z.string() });

// Provision request. `name` is required (OSC instance name, ^\w+$ per both
// service schemas). All descriptor config fields are accepted as optional
// strings here; the handler enforces each field's own `required` flag from the
// registry (openaikey is required for auto-subtitles). We keep the schema
// permissive (passthrough) so a descriptor can add fields without a schema edit;
// only registry-declared fields are read into the createInstance body.
const provisionBodySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(63)
      .regex(/^\w+$/, 'name must match ^\\w+$')
  })
  .passthrough();

// Probe OSC for the live instance named by the descriptor's env var. Never
// throws: a missing env var yields not-configured; any OSC lookup error is
// treated as "configured but not currently active" so a transient OSC outage
// degrades gracefully rather than failing the status card.
async function resolveStatus(
  osc: Context,
  descriptor: OptionalServiceDescriptor
): Promise<ServiceStatus> {
  const base: ServiceStatus = {
    key: descriptor.key,
    serviceId: descriptor.serviceId,
    displayName: descriptor.displayName,
    instanceNameEnvVar: descriptor.instanceNameEnvVar,
    state: 'not-configured'
  };

  const instanceName = process.env[descriptor.instanceNameEnvVar];
  if (!instanceName || instanceName.length === 0) {
    // Env var unset — the runtime has this optional step disabled. Clear
    // not-configured signal; do NOT probe OSC.
    return base;
  }

  try {
    const sat = await osc.getServiceAccessToken(descriptor.serviceId);
    const instance = (await getInstance(
      osc,
      descriptor.serviceId,
      instanceName,
      sat
    )) as { url?: string } | undefined;
    if (instance) {
      return {
        ...base,
        state: 'active',
        instanceName,
        ...(typeof instance.url === 'string' && instance.url.length > 0
          ? { url: instance.url }
          : {})
      };
    }
    // Configured (env var set) but no live instance under that name.
    return { ...base, state: 'configured', instanceName };
  } catch {
    // OSC lookup failed — the name is configured but we cannot confirm it is
    // live. Report configured rather than throwing so the card still renders.
    return { ...base, state: 'configured', instanceName };
  }
}

export const optionalServicesRouter: FastifyPluginAsync<
  OptionalServicesRouterOptions
> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { osc, operationStore: ops } = opts;

  // These are deployment-lifecycle operations (same posture as the whole-stack
  // provision routes): NOT caller-authenticated. The OSC SDK authenticates to
  // OSC with the deployment's own OSC_ACCESS_TOKEN.

  // GET /api/v1/optional-services — every optional service with its status.
  app.get(
    '/',
    { schema: { response: { 200: z.array(statusSchema) } } },
    async (_request, reply) => {
      const statuses = await Promise.all(
        OPTIONAL_SERVICES.map((d) => resolveStatus(osc, d))
      );
      return reply.code(200).send(statuses);
    }
  );

  // GET /api/v1/optional-services/:key — one optional service's status.
  //   200 status  |  404 unknown key
  app.get(
    '/:key',
    {
      schema: {
        params: z.object({ key: z.string() }),
        response: { 200: statusSchema, 404: notFoundSchema }
      }
    },
    async (request, reply) => {
      const descriptor = findOptionalService(request.params.key);
      if (!descriptor) {
        return reply
          .code(404)
          .send({ error: `unknown optional service "${request.params.key}"` });
      }
      return reply.code(200).send(await resolveStatus(osc, descriptor));
    }
  );

  // POST /api/v1/optional-services/:key/provision — create the instance.
  // Returns 202 + operationId; the provisioning runs in a background closure and
  // the caller polls GET /api/v1/provision/operations/:id (shared store).
  //   202 accepted | 400 missing required field | 404 unknown key
  app.post(
    '/:key/provision',
    {
      schema: {
        params: z.object({ key: z.string() }),
        body: provisionBodySchema,
        response: {
          202: acceptedSchema,
          400: badRequestSchema,
          404: notFoundSchema
        }
      }
    },
    async (request, reply) => {
      const descriptor = findOptionalService(request.params.key);
      if (!descriptor) {
        return reply
          .code(404)
          .send({ error: `unknown optional service "${request.params.key}"` });
      }

      const body = request.body as Record<string, unknown>;
      const name = body['name'] as string;

      // Enforce each descriptor field's own required flag (e.g. openaikey for
      // auto-subtitles). Reject BEFORE creating the operation so the caller gets
      // a synchronous 400 rather than a failed async operation.
      for (const field of descriptor.fields) {
        if (field.required) {
          const value = body[field.name];
          if (typeof value !== 'string' || value.length === 0) {
            return reply.code(400).send({
              error: `missing required field "${field.name}" for optional service "${descriptor.key}"`
            });
          }
        }
      }

      // Snapshot the field values BEFORE returning 202 so the background closure
      // does not read from the (by then possibly GC'd) request. Secret values
      // live only in this closure's memory until saveSecret writes them to OSC;
      // they are NEVER placed on the operation record or any response.
      const fieldValues = new Map<string, string>();
      for (const field of descriptor.fields) {
        const value = body[field.name];
        if (typeof value === 'string' && value.length > 0) {
          fieldValues.set(field.name, value);
        }
      }

      const op = ops.create('provision', name);
      reply
        .code(202)
        .send({ operationId: op.id, key: descriptor.key, name, status: 'pending' });

      setImmediate(async () => {
        try {
          ops.update(op.id, { status: 'running' });
          const sat = await osc.getServiceAccessToken(descriptor.serviceId);

          // Build the createInstance body. Secret fields are stored via
          // saveSecret and referenced as {{secrets.<name>}} — the literal value
          // never enters the body. Non-secret fields pass through verbatim.
          // Secret naming convention mirrors provision.ts: <instanceName>.<field>.
          const instanceBody: Record<string, unknown> = { name };
          for (const field of descriptor.fields) {
            const value = fieldValues.get(field.name);
            if (value === undefined) continue;
            if (field.secret) {
              const secretName = `${name}.${field.name}`;
              // saveSecret(serviceId, name, value, ctx) — arg order verified
              // from @osaas/client-core core.d.ts:154.
              await saveSecret(descriptor.serviceId, secretName, value, osc);
              instanceBody[field.name] = `{{secrets.${secretName}}}`;
            } else {
              instanceBody[field.name] = value;
            }
          }

          // createInstance(context, serviceId, token, body) — arg order verified
          // from @osaas/client-core core.d.ts:32.
          const instance = (await createInstance(
            osc,
            descriptor.serviceId,
            sat,
            instanceBody
          )) as { url?: string; name?: string };

          ops.update(op.id, {
            status: 'done',
            completedAt: Date.now(),
            // The result carries ONLY non-secret coordinates + the instance name
            // the operator must set into the env var. No secret ever appears here.
            result: {
              key: descriptor.key,
              serviceId: descriptor.serviceId,
              name,
              instanceNameEnvVar: descriptor.instanceNameEnvVar,
              ...(typeof instance.url === 'string' ? { url: instance.url } : {})
            }
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          app.log.error(
            { err, key: descriptor.key, name },
            'optional-service provisioning failed'
          );
          ops.update(op.id, {
            status: 'failed',
            completedAt: Date.now(),
            error: `provisioning ${descriptor.key} failed: ${message}`
          });
        }
      });
    }
  );

  // DELETE /api/v1/optional-services/:key — deprovision the instance.
  // The instance name is taken from the descriptor's env var (the same source
  // the runtime wired). Returns 202 + operationId; the caller polls the shared
  // operations endpoint.
  //   202 accepted | 400 env var unset (nothing to deprovision) | 404 unknown key
  app.delete(
    '/:key',
    {
      schema: {
        params: z.object({ key: z.string() }),
        response: {
          202: acceptedSchema,
          400: badRequestSchema,
          404: notFoundSchema
        }
      }
    },
    async (request, reply) => {
      const descriptor = findOptionalService(request.params.key);
      if (!descriptor) {
        return reply
          .code(404)
          .send({ error: `unknown optional service "${request.params.key}"` });
      }

      const name = process.env[descriptor.instanceNameEnvVar];
      if (!name || name.length === 0) {
        // Nothing to remove: no instance name configured. Degrade with a clear
        // signal instead of creating a doomed operation.
        return reply.code(400).send({
          error: `${descriptor.instanceNameEnvVar} is not set — no ${descriptor.key} instance to deprovision`
        });
      }

      const op = ops.create('deprovision', name);
      reply
        .code(202)
        .send({ operationId: op.id, key: descriptor.key, name, status: 'pending' });

      setImmediate(async () => {
        try {
          ops.update(op.id, { status: 'running' });
          const sat = await osc.getServiceAccessToken(descriptor.serviceId);

          // Probe first so a retry after a completed teardown reports not_found
          // rather than erroring (mirrors deprovision.ts:teardownService).
          const existing = await getInstance(osc, descriptor.serviceId, name, sat);
          if (!existing) {
            ops.update(op.id, {
              status: 'done',
              completedAt: Date.now(),
              result: { key: descriptor.key, name, status: 'not_found' }
            });
            return;
          }

          // removeInstance(context, serviceId, name, token) — arg order verified
          // from @osaas/client-core core.d.ts:46.
          await removeInstance(osc, descriptor.serviceId, name, sat);
          ops.update(op.id, {
            status: 'done',
            completedAt: Date.now(),
            result: { key: descriptor.key, name, status: 'removed' }
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          app.log.error(
            { err, key: descriptor.key, name },
            'optional-service deprovisioning failed'
          );
          ops.update(op.id, {
            status: 'failed',
            completedAt: Date.now(),
            error: `deprovisioning ${descriptor.key} failed: ${message}`
          });
        }
      });
    }
  );
};
