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
  databaseUrl: z.string(),
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
};

// Stored-config view returned by GET /:name. Mirrors StackConfig but is
// declared as a schema for response validation.
const storedConfigSchema = z.object({
  minioEndpoint: z.string(),
  couchdbUrl: z.string(),
  databaseUrl: z.string(),
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
// Encore, callback listener). NOT suitable for raw TCP database/cache
// connections (PostgreSQL, Valkey) — see databaseUrlFrom / redisUrlFrom.
function instanceUrl(instance: Instance): string {
  if (typeof instance.url === 'string' && instance.url.length > 0) {
    return instance.url;
  }
  throw new Error('instance did not return a usable url');
}

// Read a string field from an instance object if present and non-empty.
function instanceField(instance: Instance, key: string): string | undefined {
  const value = instance[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// PostgreSQL connection string. The birme-osc-postgresql instance exposes a
// ready-to-use connection URL on a service-specific field. Field name not yet
// confirmed against a live instance; we probe the known candidates and fall
// back to reconstructing from the supplied credentials + instance host.
// FLAGGED FOR SMOKE-TEST VERIFICATION: confirm the exact field name against a
// live birme-osc-postgresql instance and drop the fallback once known.
function databaseUrlFrom(
  instance: Instance,
  opts: { user: string; password: string; db: string }
): string {
  const candidates = [
    'PostgresUrl',
    'postgresUrl',
    'connectionUrl',
    'ConnectionUrl',
    'databaseUrl',
    'DatabaseUrl'
  ];
  for (const key of candidates) {
    const value = instanceField(instance, key);
    if (value) {
      return value;
    }
  }
  // Fallback: reconstruct from the HTTP service URL host. The .url field is the
  // HTTP service URL; we extract its host and assume the standard Postgres port.
  const httpUrl = instanceUrl(instance);
  const host = new URL(httpUrl).hostname;
  return `postgresql://${opts.user}:${encodeURIComponent(opts.password)}@${host}:5432/${opts.db}`;
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
  const { osc, paramStore } = opts;

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
  // from another) and write-once / never-read-back. PostgreSQL reuses the MinIO
  // root password as its DB password; Encore and the packager reuse it as their
  // S3 secret. Each consuming service still needs its own saveSecret call.
  const ROOTPASSWORD = 'rootpassword';
  const ADMINPASSWORD = 'adminpassword';
  const PGPASSWORD = 'pgpassword';

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
          200: responseSchema,
          500: errorSchema
        }
      }
    },
    async (request, reply) => {
      const { name } = request.body;

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
      // token, then mark it as provisioned.
      const provision = async (
        serviceId: string,
        body: Record<string, unknown>
      ): Promise<Instance> => {
        const sat = await osc.getServiceAccessToken(serviceId);
        const instance = await createInstance(osc, serviceId, sat, {
          name,
          ...body
        });
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

        // 3. PostgreSQL — relational store and full-text search index.
        currentService = 'birme-osc-postgresql';
        // PostgreSQL reuses the MinIO root password as its DB password, but the
        // secret is scoped to its own serviceId under a distinct purpose.
        const postgresPasswordRef = await secretRef(
          'birme-osc-postgresql',
          PGPASSWORD,
          minioRootPassword
        );
        const postgres = await provision('birme-osc-postgresql', {
          PostgresUser: 'openvideocore',
          PostgresPassword: postgresPasswordRef,
          PostgresDb: 'openvideocore'
        });
        await waitForInstanceReady('birme-osc-postgresql', name, osc);
        // The connection URL we hand back to the operator embeds the literal
        // password — it is a direct client connection string, not an OSC
        // service config field, so it cannot use a {{secrets.*}} reference.
        const databaseUrl = databaseUrlFrom(postgres, {
          user: 'openvideocore',
          password: minioRootPassword,
          db: 'openvideocore'
        });

        // 4. Valkey — queue / coordination backbone.
        currentService = 'valkey-io-valkey';
        await provision('valkey-io-valkey', {});
        await waitForInstanceReady('valkey-io-valkey', name, osc);
        const redisUrl = await redisUrlFrom(osc, 'valkey-io-valkey', name);

        // 5. Encore — transcoding engine. Uses MinIO as its S3 backend.
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

        // 6. Encore callback listener — bridges Encore completion to the queue.
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

        // 7. Encore packager — consumes the queue and produces streaming output.
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
            databaseUrl: stripCredentials(databaseUrl),
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

        return reply.code(200).send({
          name,
          minioEndpoint,
          couchdbUrl,
          databaseUrl,
          redisUrl,
          encoreUrl,
          encoreCallbackUrl
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.error(
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
              databaseUrl: '',
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
            request.log.error({ storeErr }, 'failed to persist partial stack config');
          }
        }
        return reply.code(500).send({
          error: `provisioning failed at ${currentService}: ${message}`,
          failedService: currentService,
          provisioned
        });
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
          200: teardownResponseSchema,
          404: teardownResponseSchema,
          502: teardownResponseSchema
        }
      }
    },
    async (request, reply) => {
      const { name } = request.params;

      // Without a parameter store there is no per-workspace ownership record to
      // consult, so fall back to the legacy hardcoded-list teardown. This keeps
      // store-less deployments working; ownership scoping (#29) requires the
      // store and is exercised on the path below.
      if (!paramStore) {
        const result = await deprovisionStack(osc, name);
        if (result.status === 'failed') {
          request.log.error({ result }, 'stack teardown reported failures');
          return reply.code(502).send(result);
        }
        if (result.status === 'not_found') {
          return reply.code(404).send(result);
        }
        return reply.code(200).send(result);
      }

      // Discovery: the stored config is namespaced by the deployment's own
      // workspace (tenant). A miss means the stack never existed under this
      // deployment, or was already deprovisioned.
      const workspaceId = await deriveWorkspaceId(osc);
      const config = await paramStore.loadStackConfig(workspaceId, name);
      if (!config) {
        // Idempotent: a retry after a successful teardown (entry already gone)
        // lands here. Report not_found rather than erroring.
        return reply.code(404).send({ name, status: 'not_found', services: [] });
      }

      // Teardown order and the instance set come from what was actually
      // provisioned (the stored services[]), not the static STACK_SERVICES list.
      const result = await deprovisionStackFromConfig(
        osc,
        name,
        config.services
      );

      if (result.status === 'failed') {
        request.log.error({ result }, 'stack teardown reported failures');
        // 502 Bad Gateway: the failure originates in a downstream OSC service.
        // The parameter-store entry is intentionally NOT removed so a retry can
        // re-read the services[] and finish the teardown.
        return reply.code(502).send(result);
      }

      // removed | partial | not_found — every instance is gone (or was already
      // gone). The stack is fully torn down, so remove the stored coordinates.
      // deleteStackConfig is idempotent, so a retry that re-finds a stale entry
      // still converges. A delete failure is logged but does not fail the call:
      // the OSC instances are already removed and a stale config entry is a
      // recoverable inconsistency, not a stranded stack.
      try {
        await paramStore.deleteStackConfig(workspaceId, name);
      } catch (err) {
        request.log.error(
          { err, name },
          'stack torn down but failed to remove parameter store entry'
        );
      }

      return reply.code(200).send(result);
    }
  );
};
