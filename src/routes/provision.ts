import type { FastifyPluginAsync } from 'fastify';
import type {
  ZodTypeProvider
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  Context,
  createInstance,
  getInstance,
  getPortsForInstance,
  listSubscriptions,
  saveSecret,
  waitForInstanceReady
} from '@osaas/client-core';
import { Client as MinioClient } from 'minio';
import {
  deprovisionStack,
  deprovisionStackFromConfig
} from '../services/deprovision.js';
import {
  type ParamStore,
  type StackConfig,
  stripCredentials
} from '../services/param-store.js';
import { STACK_SERVICES } from '../services/stack.js';
import type { OperationStore } from '../services/operation-store.js';

// Buckets created on the freshly provisioned MinIO instance. These names are
// referenced by Encore (input/source) and eyevinn-encore-packager
// (OutputFolder) downstream.
const SOURCE_BUCKET = 'openvideocore-source';
const PACKAGED_BUCKET = 'openvideocore-packaged';

// Sensitive credentials are supplied by the operator as environment variables
// (ADR-002, 12-factor config) — never in the request body. During provisioning
// each value is registered as a per-service OSC secret and referenced via
// {{secrets.<name>}}; the literal value never reaches a createInstance body.
const requestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]+$/, 'name must be lowercase alphanumeric')
});

const responseSchema = z.object({
  name: z.string(),
  minioEndpoint: z.string(),
  couchdbUrl: z.string(),
  redisUrl: z.string(),
  encoreUrl: z.string(),
  encoreCallbackUrl: z.string()
});

const provisionedEntrySchema = z.object({
  serviceId: z.string(),
  name: z.string()
});

const errorSchema = z.object({
  error: z.string(),
  failedService: z.string().optional(),
  provisioned: z.array(provisionedEntrySchema)
});

type ProvisionedEntry = z.infer<typeof provisionedEntrySchema>;

// Shared name validation for the :name path parameter on DELETE. Mirrors the
// rules used when the stack was provisioned.
const nameParamSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]+$/, 'name must be lowercase alphanumeric')
});

const serviceTeardownResultSchema = z.object({
  serviceId: z.string(),
  role: z.string(),
  status: z.enum(['removed', 'not_found', 'failed']),
  error: z.string().optional()
});

const teardownResponseSchema = z.object({
  name: z.string(),
  status: z.enum(['removed', 'not_found', 'partial', 'failed']),
  services: z.array(serviceTeardownResultSchema)
});

type ProvisionRouterOptions = {
  osc: Context;
  // OSC parameter store (issue #31). When provided, a successful provision
  // persists the stack's non-secret coordinates here and GET /:name reads them
  // back. When undefined the store is not configured: provision still succeeds
  // but skips persistence (logged), and GET /:name responds 501.
  paramStore?: ParamStore;
  // Invoked after a stack is provisioned or torn down so the caller can drop any
  // cached per-workspace connections for that workspace (see
  // WorkspaceStackResolver.invalidate). The workspaceId passed is the
  // deployment's own tenant (deriveWorkspaceId). Optional: when omitted no cache
  // invalidation is signalled.
  onStackChange?: (workspaceId: string) => void;
  // In-memory store for async provision/deprovision operations. POST / and
  // DELETE /:name return 202 immediately with an operationId; the caller polls
  // GET /operations/:id for completion.
  operationStore: OperationStore;
};

// Async operation view returned by GET /operations and GET /operations/:id.
const operationSchema = z.object({
  id: z.string(),
  type: z.enum(['provision', 'deprovision']),
  name: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  result: z.unknown().optional(),
  error: z.string().optional()
});

// 202 Accepted payload for POST / and DELETE /:name.
const acceptedSchema = z.object({
  operationId: z.string(),
  name: z.string(),
  status: z.literal('pending')
});

// Stored-config view returned by GET /:name. Mirrors StackConfig but is
// declared as a schema for response validation.
const storedConfigSchema = z.object({
  minioEndpoint: z.string(),
  couchdbUrl: z.string(),
  redisUrl: z.string(),
  encoreUrl: z.string(),
  encoreCallbackUrl: z.string(),
  sourceBucket: z.string(),
  packagedBucket: z.string(),
  services: z.array(
    z.object({ serviceId: z.string(), instanceName: z.string() })
  )
});

const notFoundSchema = z.object({ error: z.string() });
const notConfiguredSchema = z.object({ error: z.string() });

type Instance = { url?: string } & Record<string, unknown>;

// Resolve the public HTTP service URL from a freshly created instance object.
// Suitable for services accessed over HTTP (MinIO console/S3 endpoint, CouchDB,
// Encore, callback listener). NOT suitable for raw TCP cache
// connections (Valkey) — see redisUrlFrom.
function instanceUrl(instance: Instance): string {
  if (typeof instance.url === 'string' && instance.url.length > 0) {
    return instance.url;
  }
  throw new Error('instance did not return a usable url');
}

// Valkey (Redis-compatible) connection string.
// OSC Valkey instances use internal-only cluster DNS (publicAccess=false).
// The internal DNS follows the pattern:
//   oscaidev-<name>.valkey-io-valkey.svc.cluster.local:6379
// This is only reachable from within the OSC cluster — correct for
// open-videocore running as an OSC service.
async function redisUrlFrom(
  osc: Context,
  serviceId: string,
  name: string
): Promise<string> {
  const sat = await osc.getServiceAccessToken(serviceId);
  const ports = await getPortsForInstance(osc, serviceId, name, sat);
  if (ports && ports.length > 0) {
    // Public TCP endpoint available (non-default config)
    const { externalIp, externalPort } = ports[0];
    return `redis://${externalIp}:${externalPort}`;
  }
  // Internal-only: the instance URL is
  //   https://oscaidev-<name>.valkey-io-valkey.auto.prod.osaas.io
  // Strip to the cluster-DNS form:
  //   oscaidev-<name>.valkey-io-valkey.svc.cluster.local:6379
  const instance = await getInstance(osc, serviceId, name, sat);
  const instanceHostname = new URL(instance.url as string).hostname;
  const clusterHost = instanceHostname.replace(
    /\.auto\.prod\.osaas\.io$/,
    '.svc.cluster.local'
  );
  return `redis://${clusterHost}:6379`;
}

// Derive the deployment's own workspace (tenant) id from the OSC Context.
// These routes are not caller-authenticated: the middleware authenticates to
// OSC with its own OSC_ACCESS_TOKEN, so there is no per-caller bearer token to
// resolve a workspace from. The deployment's tenant IS the workspace used to
// scope the parameter store. All subscriptions for a single token belong to the
// same tenant, so the tenantId of any one of them is the deployment's workspace.
async function deriveWorkspaceId(osc: Context): Promise<string> {
  const subscriptions = await listSubscriptions(osc);
  const tenantId = subscriptions.find(
    (s) => typeof s.tenantId === 'string' && s.tenantId.length > 0
  )?.tenantId;
  if (!tenantId) {
    throw new Error('OSC context is not associated with a workspace (tenant)');
  }
  return tenantId;
}

export const provisionRouter: FastifyPluginAsync<ProvisionRouterOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { osc, paramStore, onStackChange, operationStore: ops } = opts;

  // Operator-supplied credentials (ADR-002). Read once at registration time so
  // a misconfigured deployment fails fast at startup rather than mid-provision.
  // These are the only places these literals live in process memory — they are
  // written to OSC as per-service secrets and never echoed in a response.
  const minioRootPassword = process.env['MINIO_ROOT_PASSWORD'];
  const couchdbAdminPassword = process.env['COUCHDB_ADMIN_PASSWORD'];
  if (!minioRootPassword) {
    throw new Error('MINIO_ROOT_PASSWORD environment variable is required');
  }
  if (!couchdbAdminPassword) {
    throw new Error('COUCHDB_ADMIN_PASSWORD environment variable is required');
  }

  // Secret naming convention (ADR-002): <stackName>.<purpose>. Secrets are
  // per-service-scoped (a secret saved for one serviceId cannot be referenced
  // from another) and write-once / never-read-back. Encore and the packager
  // reuse the MinIO root password as their S3 secret. Each consuming service
  // still needs its own saveSecret call.
  const ROOTPASSWORD = 'rootpassword';
  const ADMINPASSWORD = 'adminpassword';

  // Provision/deprovision/lookup are stack-lifecycle operations performed by
  // the deployment itself. They are NOT caller-authenticated: the OSC SDK
  // middleware authenticates to OSC using this deployment's own OSC_ACCESS_TOKEN
  // (ADR-002), and there is no per-caller token for these routes. Parameter
  // store scoping uses the deployment's own tenant id (deriveWorkspaceId).

  app.post(
    '/',
    {
      schema: {
        body: requestSchema,
        response: {
          202: acceptedSchema
        }
      }
    },
    async (request, reply) => {
      const { name } = request.body;

      // Create the async operation and return 202 immediately. The full
      // provisioning logic runs in the background closure below; the caller
      // polls GET /operations/:id for progress and the final stack coordinates.
      const op = ops.create('provision', name);
      reply.code(202).send({ operationId: op.id, name, status: 'pending' });

      setImmediate(async () => {
        ops.update(op.id, { status: 'running' });

      // secretRef registers a value as an OSC secret scoped to a specific
      // serviceId and returns the {{secrets.<name>}} reference to embed in the
      // createInstance body. Secrets are per-service: the same logical value
      // (e.g. the MinIO root password reused as Encore's S3 secret) must be
      // saved separately under each consuming serviceId.
      const secretRef = async (
        serviceId: string,
        purpose: string,
        value: string
      ): Promise<string> => {
        const secretName = `${name}.${purpose}`;
        await saveSecret(serviceId, secretName, value, osc);
        return `{{secrets.${secretName}}}`;
      };

      // Track what has been provisioned so a failure mid-stack can report
      // partial state to the operator for manual cleanup. Each entry carries
      // the serviceId and instance name needed for a removeInstance call.
      const provisioned: ProvisionedEntry[] = [];

      // Helper: provision one service with its own short-lived service access
      // token, then mark it as provisioned. Idempotent: if the named instance
      // already exists (OSC returns "Name is already taken") we fetch and
      // return the existing instance rather than failing.
      // Retries up to 3 times on transient 5xx OSC infrastructure errors
      // (ingress-nginx admission webhook timeouts under cluster load).
      const provision = async (
        serviceId: string,
        body: Record<string, unknown>,
        maxAttempts = 3
      ): Promise<Instance> => {
        const sat = await osc.getServiceAccessToken(serviceId);
        let instance: Instance | undefined;
        let lastErr: unknown;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            instance = await createInstance(osc, serviceId, sat, { name, ...body });
            break;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('already taken') || msg.includes('already exists')) {
              instance = (await getInstance(osc, serviceId, name, sat)) as Instance;
              break;
            }
            lastErr = err;
            const isTransient =
              msg.includes('500') ||
              msg.includes('502') ||
              msg.includes('503') ||
              msg.includes('ECONNRESET') ||
              msg.includes('context deadline exceeded');
            if (!isTransient || attempt === maxAttempts) throw err;
            await new Promise((r) => setTimeout(r, attempt * 5_000));
          }
        }
        if (!instance) throw lastErr;
        provisioned.push({ serviceId, name });
        return instance;
      };

      let currentService = '';
      try {
        // 1. MinIO — S3-compatible object storage.
        currentService = 'minio-minio';
        const minioRootPasswordRef = await secretRef(
          'minio-minio',
          ROOTPASSWORD,
          minioRootPassword
        );
        const minio = await provision('minio-minio', {
          RootUser: 'admin',
          RootPassword: minioRootPasswordRef
        });
        await waitForInstanceReady('minio-minio', name, osc);
        const minioEndpoint = instanceUrl(minio);

        // 1b. Create the source and packaged buckets on the live MinIO instance.
        // waitForInstanceReady passes when the container health check is green,
        // but the MinIO S3 API may still be initialising. Retry with backoff
        // until S3 is actually accepting connections.
        const minioUrl = new URL(minioEndpoint);
        const minioClient = new MinioClient({
          endPoint: minioUrl.hostname,
          port: minioUrl.port
            ? Number(minioUrl.port)
            : minioUrl.protocol === 'https:'
              ? 443
              : 80,
          useSSL: minioUrl.protocol === 'https:',
          accessKey: 'admin',
          // The admin S3 client connects with the real credential — OSC resolves
          // the {{secrets.*}} reference on its side, but our client speaks S3
          // directly to the live instance and needs the literal password.
          secretKey: minioRootPassword
        });
        const delay = (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms));
        for (const bucket of [SOURCE_BUCKET, PACKAGED_BUCKET]) {
          let attempts = 0;
          while (true) {
            try {
              const exists = await minioClient.bucketExists(bucket);
              if (!exists) {
                await minioClient.makeBucket(bucket);
              }
              break;
            } catch (err) {
              attempts++;
              if (attempts >= 20) throw err;
              await delay(5000);
            }
          }
        }

        // 2. CouchDB — document store for asset metadata.
        currentService = 'apache-couchdb';
        const couchdbAdminPasswordRef = await secretRef(
          'apache-couchdb',
          ADMINPASSWORD,
          couchdbAdminPassword
        );
        const couchdb = await provision('apache-couchdb', {
          AdminPassword: couchdbAdminPasswordRef
        });
        await waitForInstanceReady('apache-couchdb', name, osc);
        const couchdbUrl = instanceUrl(couchdb);

        // 3. Valkey — queue / coordination backbone.
        currentService = 'valkey-io-valkey';
        await provision('valkey-io-valkey', {});
        await waitForInstanceReady('valkey-io-valkey', name, osc);
        const redisUrl = await redisUrlFrom(osc, 'valkey-io-valkey', name);

        // 4. Encore — transcoding engine. Uses MinIO as its S3 backend.
        // Slowest service to become ready (Essential tier); wait before
        // configuring the callback listener with its URL.
        currentService = 'encore';
        // Encore's S3 secret is the MinIO root password, scoped to the encore
        // serviceId under the rootpassword purpose.
        const encoreS3SecretRef = await secretRef(
          'encore',
          ROOTPASSWORD,
          minioRootPassword
        );
        const encore = await provision('encore', {
          s3AccessKeyId: 'admin',
          s3SecretAccessKey: encoreS3SecretRef,
          s3Endpoint: minioEndpoint
        });
        await waitForInstanceReady('encore', name, osc);
        const encoreUrl = instanceUrl(encore);

        // 5. Encore callback listener — bridges Encore completion to the queue.
        currentService = 'eyevinn-encore-callback-listener';
        const callback = await provision('eyevinn-encore-callback-listener', {
          RedisUrl: redisUrl,
          EncoreUrl: encoreUrl
        });
        await waitForInstanceReady(
          'eyevinn-encore-callback-listener',
          name,
          osc
        );
        const encoreCallbackUrl = instanceUrl(callback);

        // 6. Encore packager — consumes the queue and produces streaming output.
        currentService = 'eyevinn-encore-packager';
        const pat = osc.getPersonalAccessToken();
        if (!pat) {
          throw new Error('OSC_ACCESS_TOKEN is not configured');
        }
        // The packager's AWS S3 secret is the MinIO root password, scoped to
        // the eyevinn-encore-packager serviceId under the rootpassword purpose.
        const packagerS3SecretRef = await secretRef(
          'eyevinn-encore-packager',
          ROOTPASSWORD,
          minioRootPassword
        );
        await provision('eyevinn-encore-packager', {
          RedisUrl: redisUrl,
          OutputFolder: `s3://${PACKAGED_BUCKET}`,
          PersonalAccessToken: pat,
          AwsAccessKeyId: 'admin',
          AwsSecretAccessKey: packagerS3SecretRef,
          S3EndpointUrl: minioEndpoint
        });
        // The packager is a background queue-consumer — it does not expose a
        // synchronous health endpoint. waitForInstanceReady is skipped; the
        // instance starts asynchronously and picks up jobs from the Valkey queue.

        // Persist the stack's non-secret connection coordinates to the OSC
        // parameter store (issue #31, ADR-002) so the API — and deprovision
        // (#29) — can rediscover this stack at runtime without the caller
        // re-supplying every endpoint. Credentials are stripped from any
        // URL-shaped value before storage; param-store.ts asserts none remain.
        //
        // Persistence failure is logged but does NOT fail the provision: the
        // stack is already live and the response below still hands the operator
        // every coordinate. The stored copy is a convenience cache, not the
        // source of truth, so a write error must not strand a healthy stack.
        if (paramStore) {
          const stackConfig: StackConfig = {
            minioEndpoint,
            couchdbUrl: stripCredentials(couchdbUrl),
            redisUrl,
            encoreUrl,
            encoreCallbackUrl,
            sourceBucket: SOURCE_BUCKET,
            packagedBucket: PACKAGED_BUCKET,
            services: STACK_SERVICES.map((s) => ({
              serviceId: s.serviceId,
              instanceName: name
            }))
          };
          try {
            const workspaceId = await deriveWorkspaceId(osc);
            await paramStore.storeStackConfig(workspaceId, name, stackConfig);
            // The new stack is now discoverable: drop any cached connections so
            // the next request resolves it immediately.
            onStackChange?.(workspaceId);
          } catch (err) {
            request.log.error(
              { err, name },
              'failed to persist stack config to parameter store'
            );
          }
        } else {
          request.log.warn(
            'parameter store not configured — stack coordinates not persisted'
          );
        }

          ops.update(op.id, {
            status: 'done',
            completedAt: Date.now(),
            result: {
              name,
              minioEndpoint,
              couchdbUrl,
              redisUrl,
              encoreUrl,
              encoreCallbackUrl
            }
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          app.log.error(
            { err, failedService: currentService, provisioned },
            'provisioning failed'
          );
          // Even on failure, persist whatever was provisioned so the deprovision
          // route can clean up via the API. Without this, partially-provisioned
          // stacks leave orphaned OSC instances that must be removed manually.
          if (paramStore && provisioned.length > 0) {
            try {
              const workspaceId = await deriveWorkspaceId(osc);
              await paramStore.storeStackConfig(workspaceId, name, {
                minioEndpoint: '',
                couchdbUrl: '',
                redisUrl: '',
                encoreUrl: '',
                encoreCallbackUrl: '',
                sourceBucket: SOURCE_BUCKET,
                packagedBucket: PACKAGED_BUCKET,
                services: provisioned.map((p) => ({
                  serviceId: p.serviceId,
                  instanceName: p.name
                }))
              });
            } catch (storeErr) {
              app.log.error({ storeErr }, 'failed to persist partial stack config');
            }
          }
          ops.update(op.id, {
            status: 'failed',
            completedAt: Date.now(),
            error: `provisioning failed at ${currentService}: ${message}`
          });
        }
      });
    }
  );

  // GET /api/v1/provision — list all stack names provisioned for this workspace.
  //   200  array of stack name strings
  //   501  parameter store not configured
  app.get(
    '/',
    {
      schema: {
        response: {
          200: z.array(z.string()),
          501: notConfiguredSchema
        }
      }
    },
    async (request, reply) => {
      if (!opts.paramStore) {
        return reply.code(501).send({ error: 'parameter store not configured (set PARAMETER_STORE_URL and PARAMETER_STORE_API_KEY)' });
      }
      try {
        const workspaceId = await deriveWorkspaceId(osc);
        const names = await opts.paramStore.listStackNames(workspaceId);
        return reply.send(names);
      } catch (err) {
        // Parameter store is temporarily unavailable — return an empty list
        // rather than an error so the UI degrades gracefully instead of
        // showing an error page. The issue is logged for operator visibility.
        request.log.warn({ err }, 'parameter store unavailable, returning empty stack list');
        return reply.send([]);
      }
    }
  );

  // GET /api/v1/provision/:name — return the stored connection coordinates for
  // a named stack, scoped to the caller's workspace (issue #31). The values are
  // those persisted by a prior successful POST (non-secret endpoints + bucket
  // names + the service list). Behaviour:
  //   - 200  stored coordinates returned
  //   - 404  no coordinates stored for this workspace + name
  //   - 501  parameter store not configured on this deployment
  app.get(
    '/:name',
    {
      schema: {
        params: nameParamSchema,
        response: {
          200: storedConfigSchema,
          404: notFoundSchema,
          501: notConfiguredSchema
        }
      }
    },
    async (request, reply) => {
      const { name } = request.params;

      if (!paramStore) {
        return reply.code(501).send({
          error:
            'parameter store not configured (set PARAMETER_STORE_URL and PARAMETER_STORE_API_KEY)'
        });
      }

      const workspaceId = await deriveWorkspaceId(osc);
      const config = await paramStore.loadStackConfig(workspaceId, name);
      if (!config) {
        return reply.code(404).send({ error: `no stored config for stack "${name}"` });
      }
      return reply.code(200).send(config);
    }
  );

  // DELETE /api/v1/provision/:name — tear down a named stack.
  //
  // Removes every OSC instance that makes up the stack in dependency-safe
  // order (consumers before producers). Behaviour:
  //   - 200 status=removed    every instance was removed this call
  //   - 200 status=partial    some removed, some already gone (no failures)
  //   - 404 status=not_found  no instances existed for this name
  //   - 502 status=failed     one or more instances failed to remove; the
  //                           call is safe to retry (idempotent)
  app.delete(
    '/:name',
    {
      schema: {
        params: nameParamSchema,
        response: {
          202: acceptedSchema
        }
      }
    },
    async (request, reply) => {
      const { name } = request.params;

      // Create the async operation and return 202 immediately. The teardown
      // runs in the background closure below; the caller polls GET
      // /operations/:id for the final teardown result.
      const op = ops.create('deprovision', name);
      reply.code(202).send({ operationId: op.id, name, status: 'pending' });

      setImmediate(async () => {
        try {
          ops.update(op.id, { status: 'running' });

          // Without a parameter store there is no per-workspace ownership record
          // to consult, so fall back to the legacy hardcoded-list teardown. This
          // keeps store-less deployments working; ownership scoping (#29)
          // requires the store and is exercised on the path below.
          if (!paramStore) {
            const result = await deprovisionStack(osc, name);
            if (result.status === 'failed') {
              app.log.error({ result }, 'stack teardown reported failures');
            }
            ops.update(op.id, { status: 'done', completedAt: Date.now(), result });
            return;
          }

          // Discovery: the stored config is namespaced by the deployment's own
          // workspace (tenant). A miss means the stack never existed under this
          // deployment, or was already deprovisioned.
          const workspaceId = await deriveWorkspaceId(osc);
          const config = await paramStore.loadStackConfig(workspaceId, name);
          if (!config) {
            // Idempotent: a retry after a successful teardown (entry already
            // gone) lands here. Report not_found rather than erroring.
            ops.update(op.id, {
              status: 'done',
              completedAt: Date.now(),
              result: { name, status: 'not_found', services: [] }
            });
            return;
          }

          // Teardown order and the instance set come from what was actually
          // provisioned (the stored services[]), not the static STACK_SERVICES.
          const result = await deprovisionStackFromConfig(
            osc,
            name,
            config.services
          );

          if (result.status === 'failed') {
            app.log.error({ result }, 'stack teardown reported failures');
            // The parameter-store entry is intentionally NOT removed so a retry
            // can re-read the services[] and finish the teardown.
            ops.update(op.id, { status: 'done', completedAt: Date.now(), result });
            return;
          }

          // removed | partial | not_found — every instance is gone (or was
          // already gone). The stack is fully torn down, so remove the stored
          // coordinates. deleteStackConfig is idempotent, so a retry that
          // re-finds a stale entry still converges. A delete failure is logged
          // but does not fail the call: the OSC instances are already removed
          // and a stale config entry is a recoverable inconsistency.
          try {
            await paramStore.deleteStackConfig(workspaceId, name);
          } catch (err) {
            app.log.error(
              { err, name },
              'stack torn down but failed to remove parameter store entry'
            );
          }

          // Drop cached connections for this workspace so the removed stack is
          // not served from cache after teardown.
          onStackChange?.(workspaceId);

          ops.update(op.id, { status: 'done', completedAt: Date.now(), result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          app.log.error({ err, name }, 'deprovisioning failed');
          ops.update(op.id, {
            status: 'failed',
            completedAt: Date.now(),
            error: `deprovisioning failed: ${message}`
          });
        }
      });
    }
  );

  // GET /api/v1/provision/operations — list all async provision/deprovision
  // operations, newest first. Unauthenticated (same as the other provision
  // routes).
  app.get(
    '/operations',
    {
      schema: {
        response: {
          200: z.array(operationSchema)
        }
      }
    },
    async (_request, reply) => {
      return reply.code(200).send(ops.list());
    }
  );

  // GET /api/v1/provision/operations/:id — fetch one operation by id. When
  // status === 'done', `result` holds the full stack coordinates (provision) or
  // the teardown result (deprovision). Unauthenticated.
  app.get(
    '/operations/:id',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: operationSchema,
          404: notFoundSchema
        }
      }
    },
    async (request, reply) => {
      const op = ops.get(request.params.id);
      if (!op) {
        return reply.code(404).send({ error: `no operation with id "${request.params.id}"` });
      }
      return reply.code(200).send(op);
    }
  );
};
