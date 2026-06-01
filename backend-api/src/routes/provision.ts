import type { FastifyPluginAsync } from 'fastify';
import type {
  ZodTypeProvider
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  Context,
  createInstance,
  getPortsForInstance,
  waitForInstanceReady
} from '@osaas/client-core';
import { Client as MinioClient } from 'minio';

// Buckets created on the freshly provisioned MinIO instance. These names are
// referenced by Encore (input/source) and eyevinn-encore-packager
// (OutputFolder) downstream.
const SOURCE_BUCKET = 'openvideocore-source';
const PACKAGED_BUCKET = 'openvideocore-packaged';

const requestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]+$/, 'name must be lowercase alphanumeric'),
  adminPassword: z.string().min(8)
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

type ProvisionRouterOptions = {
  osc: Context;
};

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

// Valkey (Redis-compatible) connection string. Valkey is reached over a raw TCP
// port, not the HTTP .url field. OSC routes extra TCP ports via the ports API,
// so we resolve the externally routed port for this instance.
// FLAGGED FOR SMOKE-TEST VERIFICATION: confirm the routed port/host shape
// against a live valkey-io-valkey instance.
async function redisUrlFrom(
  osc: Context,
  serviceId: string,
  name: string
): Promise<string> {
  const sat = await osc.getServiceAccessToken(serviceId);
  const ports = await getPortsForInstance(osc, serviceId, name, sat);
  if (!ports || ports.length === 0) {
    throw new Error('valkey instance did not expose a routed TCP port');
  }
  const { externalIp, externalPort } = ports[0];
  return `redis://${externalIp}:${externalPort}`;
}

export const provisionRouter: FastifyPluginAsync<ProvisionRouterOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { osc } = opts;

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
      const { name, adminPassword } = request.body;

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
        const minio = await provision('minio-minio', {
          RootUser: 'admin',
          RootPassword: adminPassword
        });
        await waitForInstanceReady('minio-minio', name, osc);
        const minioEndpoint = instanceUrl(minio);

        // 1b. Create the source and packaged buckets on the live MinIO instance
        // before any downstream service references them. Done synchronously so
        // Encore (input) and the packager (OutputFolder) can rely on them.
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
          secretKey: adminPassword
        });
        for (const bucket of [SOURCE_BUCKET, PACKAGED_BUCKET]) {
          const exists = await minioClient.bucketExists(bucket);
          if (!exists) {
            await minioClient.makeBucket(bucket);
          }
        }

        // 2. CouchDB — document store for asset metadata.
        currentService = 'apache-couchdb';
        const couchdb = await provision('apache-couchdb', {
          AdminPassword: adminPassword
        });
        await waitForInstanceReady('apache-couchdb', name, osc);
        const couchdbUrl = instanceUrl(couchdb);

        // 3. PostgreSQL — relational store and full-text search index.
        currentService = 'birme-osc-postgresql';
        const postgres = await provision('birme-osc-postgresql', {
          PostgresUser: 'openvideocore',
          PostgresPassword: adminPassword,
          PostgresDb: 'openvideocore'
        });
        await waitForInstanceReady('birme-osc-postgresql', name, osc);
        const databaseUrl = databaseUrlFrom(postgres, {
          user: 'openvideocore',
          password: adminPassword,
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
        const encore = await provision('encore', {
          s3AccessKeyId: 'admin',
          s3SecretAccessKey: adminPassword,
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
        await provision('eyevinn-encore-packager', {
          RedisUrl: redisUrl,
          OutputFolder: `s3://${PACKAGED_BUCKET}`,
          PersonalAccessToken: pat,
          AwsAccessKeyId: 'admin',
          AwsSecretAccessKey: adminPassword,
          S3EndpointUrl: minioEndpoint
        });
        await waitForInstanceReady('eyevinn-encore-packager', name, osc);

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
        return reply.code(500).send({
          error: `provisioning failed at ${currentService}: ${message}`,
          failedService: currentService,
          provisioned
        });
      }
    }
  );
};
