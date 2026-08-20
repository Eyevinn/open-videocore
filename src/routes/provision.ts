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
  saveSecret,
  waitForInstanceReady
} from '@osaas/client-core';
import { Client as MinioClient } from 'minio';
import nano from 'nano';
import {
  deprovisionStack,
  deprovisionStackFromConfig
} from '../services/deprovision.js';
import {
  type ParamStore,
  type StackConfig,
  type StorageBackendConfig,
  stripCredentials
} from '../services/param-store.js';
import { STACK_CONFIG_NAMESPACE } from '../services/workspace-stack.js';
import {
  AUTO_SUBTITLES_SERVICE_ID,
  SCENE_DETECT_SERVICE_ID,
  STACK_SERVICES
} from '../services/stack.js';
import {
  packagerOscApiFromContext,
  teardownOnDemandPackager
} from '../services/packager-provisioning.js';
import {
  EXTERNAL_STORAGE_SERVICE_IDS,
  type ExternalStorageCredentials,
  type ServiceCredentialMapping,
  encoreCredentialMapping,
  ffmpegS3CredentialMapping
} from '../services/external-storage-credentials.js';
import type { OperationStore } from '../services/operation-store.js';
import type { WorkspaceEncoreScalerRegistry } from '../encore-scaler/workspace-registry.js';

// Buckets created on the freshly provisioned MinIO instance. These names are
// referenced by Encore (input/source) and, downstream, by the on-demand Encore
// packager (OutputFolder) when packaging is first executed (epic #226).
const SOURCE_BUCKET = 'openvideocore-source';
const PACKAGED_BUCKET = 'openvideocore-packaged';

// Sensitive credentials are supplied by the operator as environment variables
// (ADR-002, 12-factor config) — never in the request body. During provisioning
// each value is registered as a per-service OSC secret and referenced via
// {{secrets.<name>}}; the literal value never reaches a createInstance body.
// Optional external S3-compatible storage block (issue #211). When supplied for
// a role (source or packaged), the stack uses this operator-provided bucket
// instead of the per-stack MinIO default. `secretAccessKey`/`sessionToken` are
// secrets: they are validated here but NEVER echoed in a response and NEVER
// written to the parameter store (only the non-secret coordinates are). Actual
// credential injection into services is the follow-up sub-issue (#212).
const externalStorageSchema = z.object({
  bucket: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  region: z.string().min(1).optional(),
  endpointUrl: z.string().url().optional(),
  sessionToken: z.string().min(1).optional(),
  // OPTIONAL public origin fronting the bucket (e.g. a CDN origin) for operators
  // who serve the packaged/source objects through a public host rather than the
  // raw object-store endpoint (issue #213). NON-SECRET: a plain origin URL, it
  // OVERRIDES the derived endpointUrl-based host when delivery URLs are emitted.
  // When unset, delivery URLs are derived from endpointUrl/region + bucket.
  publicBaseUrl: z.string().url().optional()
});

type ExternalStorage = z.infer<typeof externalStorageSchema>;

const requestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]+$/, 'name must be lowercase alphanumeric'),
  // Optional external source bucket. Omit for the zero-config MinIO default.
  sourceStorage: externalStorageSchema.optional(),
  // Optional external packaged-output bucket. Omit for the MinIO default.
  packagedStorage: externalStorageSchema.optional(),
  // Optional pipeline services the operator opts into at provision time (issue
  // #216). Both flags default false: when opted out nothing is created (zero
  // cost). When opted in, the corresponding OSC instance is provisioned AFTER
  // the core stack is up and its name recorded in the stored StackConfig.
  options: z
    .object({
      autoSubtitles: z.boolean().default(false),
      sceneDetect: z.boolean().default(false)
    })
    .optional()
});

const responseSchema = z.object({
  name: z.string(),
  minioEndpoint: z.string(),
  couchdbUrl: z.string(),
  redisUrl: z.string()
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
  // Late-bound accessor for the scaler registry. The registry is created lazily
  // in main.ts *after* this router registers (only once a stack exists), so it
  // cannot be passed by value at registration time. This getter reads the
  // outer module-level binding, resolving the ordering: it returns the current
  // registry when one is active and undefined otherwise. Mirrors the deferred
  // onStackChange precedent. The DELETE route uses it to reach
  // WorkspaceEncoreScalerRegistry.teardown(workspaceId) (#122; teardown call
  // itself is #123). Optional: when omitted the router has no registry to reach.
  getScalerRegistry?: () => WorkspaceEncoreScalerRegistry | undefined;
  // In-memory store for async provision/deprovision operations. POST / and
  // DELETE /:name return 202 immediately with an operationId; the caller polls
  // GET /operations/:id for completion.
  operationStore: OperationStore;
  // Public base URL (e.g. https://api.example.com) used to build callback URLs
  // for OSC services. Optional: when omitted, callback URLs are left unset and
  // services that need them (eyevinn-encore-packager) fall back to their
  // defaults or operate without callbacks.
  publicBaseUrl?: string;
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

// Non-secret storage backend metadata for one role, mirrors
// StorageBackendConfig in param-store.ts. NO secret fields (issue #211).
const storageBackendSchema = z.object({
  backend: z.enum(['minio', 'external']),
  bucket: z.string(),
  endpointUrl: z.string().optional(),
  region: z.string().optional(),
  // Optional public/CDN origin fronting the bucket (issue #213). Absent for
  // configs written before this field existed, and for the minio backend.
  publicBaseUrl: z.string().optional()
});

// Stored-config view returned by GET /:name. Mirrors StackConfig but is
// declared as a schema for response validation.
const storedConfigSchema = z.object({
  status: z.enum(['provisioning', 'ready', 'failed']).optional(),
  minioEndpoint: z.string(),
  couchdbUrl: z.string(),
  redisUrl: z.string(),
  sourceBucket: z.string(),
  packagedBucket: z.string(),
  // Optional pipeline service instance names (issue #215). Optional/back-compat:
  // stored configs written before these fields existed omit them and still
  // validate. Mirrors StackConfig.autoSubtitlesInstanceName/sceneDetectInstanceName.
  autoSubtitlesInstanceName: z.string().optional(),
  sceneDetectInstanceName: z.string().optional(),
  // Derived, read-only optional-service activation summary (issue #218). Surfaces
  // which opt-in services a stack has activated as plain booleans so a consumer
  // does not have to know that activation is signalled by the presence of the
  // *InstanceName fields above. ADDITIVE + back-compat: this is NOT part of the
  // stored StackConfig — the GET handler adds it ONLY when at least one optional
  // service is active, so a config with no optional services serialises exactly
  // as it was stored (existing GET /:name equality contract is preserved).
  options: z
    .object({ autoSubtitles: z.boolean(), sceneDetect: z.boolean() })
    .optional(),
  // Optional per-role storage backend metadata (issue #211). Absent for configs
  // written before this field existed (both roles then default to MinIO).
  storage: z
    .object({ source: storageBackendSchema, packaged: storageBackendSchema })
    .optional(),
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
// The deployment context key used to namespace stacks in the parameter store.
// Must match STACK_CONFIG_NAMESPACE in workspace-stack.ts so provision and
// resolver agree on where configs are stored and found.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function deriveWorkspaceId(_osc: Context): Promise<string> {
  return STACK_CONFIG_NAMESPACE;
}

export const provisionRouter: FastifyPluginAsync<ProvisionRouterOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { osc, paramStore, onStackChange, getScalerRegistry, operationStore: ops, publicBaseUrl } =
    opts;

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

  // OpenAI API key for eyevinn-auto-subtitles' Whisper transcription (issue
  // #216). Unlike the passwords above this is NOT required at startup: it is
  // only needed when a request opts into autoSubtitles. Read here (ADR-002,
  // 12-factor) so the literal lives in one place; when opted in it is
  // registered as a per-service OSC secret via secretRef and referenced as
  // {{secrets.*}} in the create body — never a plaintext param, never logged.
  // Empty/absent is enforced per-request with a fail-fast error when opted in.
  const openaiApiKey = process.env['OPENAI_API_KEY'];

  // Secret naming convention (ADR-002): <stackName>.<purpose>. Secrets are
  // per-service-scoped (a secret saved for one serviceId cannot be referenced
  // from another) and write-once / never-read-back. Each consuming service
  // still needs its own saveSecret call. (The packager's own secrets are minted
  // by the on-demand ensure step now, not here — epic #226 / issue #243.)
  const ROOTPASSWORD = 'rootpassword';
  const ADMINPASSWORD = 'adminpassword';
  // Secret purpose for the OpenAI key handed to eyevinn-auto-subtitles (#216).
  const OPENAIKEY = 'openaikey';
  // Role-qualified secret purpose for external-storage SOURCE credentials (#212).
  // The credential-mapping layer appends the field-specific suffix (e.g.
  // `.awssecretaccesskey`) so the source secrets never collide when saved under
  // the same serviceId. (The PACKAGED-role secrets are minted by the on-demand
  // packager ensure step now, not here — epic #226 / issue #243.)
  const EXT_SOURCE = 'extsource';

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
      const { name, sourceStorage, packagedStorage, options } = request.body;
      // Which optional pipeline services this request opted into (#216). Absent
      // `options` (or absent flags) means opted out — nothing extra is created.
      const wantAutoSubtitles = options?.autoSubtitles ?? false;
      const wantSceneDetect = options?.sceneDetect ?? false;

      // Build the NON-SECRET storage backend metadata (issue #211) for each
      // role from the validated request. When a block is omitted the role uses
      // the per-stack MinIO default (zero-config). Only bucket/endpointUrl/region
      // are captured here; accessKeyId/secretAccessKey/sessionToken are secrets
      // and are deliberately NOT read into this object — they never reach the
      // param store or the response. Credential wiring into services is #212.
      const storageBackendFor = (
        block: ExternalStorage | undefined,
        defaultBucket: string
      ): StorageBackendConfig =>
        block
          ? {
              backend: 'external',
              bucket: block.bucket,
              ...(block.endpointUrl ? { endpointUrl: block.endpointUrl } : {}),
              ...(block.region ? { region: block.region } : {}),
              // Optional public/CDN origin fronting the bucket (issue #213).
              // NON-SECRET: a plain origin URL. When present it overrides the
              // endpointUrl-derived host for emitted delivery/manifest URLs.
              ...(block.publicBaseUrl ? { publicBaseUrl: block.publicBaseUrl } : {})
            }
          : { backend: 'minio', bucket: defaultBucket };

      const storageMetadata = {
        source: storageBackendFor(sourceStorage, SOURCE_BUCKET),
        packaged: storageBackendFor(packagedStorage, PACKAGED_BUCKET)
      };

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

      // applyCredentialMapping realises a per-service ServiceCredentialMapping
      // (#212) against a concrete serviceId: it saves every secret value as an
      // OSC secret scoped to that serviceId (via secretRef) and merges the
      // resulting {{secrets.*}} references with the mapping's non-secret config
      // fields. The literal secret value never leaves saveSecret — only the
      // reference is placed in the returned config object. The result is spread
      // straight into a createInstance / createJob body.
      const applyCredentialMapping = async (
        serviceId: string,
        mapping: ServiceCredentialMapping
      ): Promise<Record<string, string>> => {
        const fields: Record<string, string> = { ...mapping.configFields };
        for (const secret of mapping.secrets) {
          fields[secret.field] = await secretRef(
            serviceId,
            secret.purpose,
            secret.value
          );
        }
        return fields;
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

      // Names of the optional pipeline instances actually created for this
      // stack (#216). Populated below only when opted in; folded into the
      // stored StackConfig so the resolver/pipeline can find them by name.
      let autoSubtitlesInstanceName: string | undefined;
      let sceneDetectInstanceName: string | undefined;

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

        // 1c. Set CORS on both buckets so browsers can PUT presigned URLs
        // directly from the ops UI without cross-origin errors.
        // MinIO supports the S3 PutBucketCors API; we call it via the MinIO
        // client's makeRequestAsync (which handles AWS Signature V4 signing)
        // because the minio JS SDK does not expose a setBucketCors helper.
        const corsXml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<CORSConfiguration>',
          '<CORSRule>',
          '<AllowedOrigin>*</AllowedOrigin>',
          '<AllowedMethod>GET</AllowedMethod>',
          '<AllowedMethod>PUT</AllowedMethod>',
          '<AllowedMethod>HEAD</AllowedMethod>',
          '<AllowedHeader>*</AllowedHeader>',
          '<ExposeHeader>ETag</ExposeHeader>',
          '<MaxAgeSeconds>3600</MaxAgeSeconds>',
          '</CORSRule>',
          '</CORSConfiguration>'
        ].join('');
        const corsPayload = Buffer.from(corsXml, 'utf-8');
        for (const bucket of [SOURCE_BUCKET, PACKAGED_BUCKET]) {
          let attempts = 0;
          while (true) {
            try {
              await (minioClient as unknown as { makeRequestAsync(opts: object, payload: Buffer, codes: number[]): Promise<unknown> })
                .makeRequestAsync(
                  { method: 'PUT', bucketName: bucket, query: 'cors', headers: { 'content-type': 'application/xml' } },
                  corsPayload,
                  [200]
                );
              break;
            } catch {
              attempts++;
              if (attempts >= 5) break; // CORS is best-effort — don't block provision
              await delay(3000);
            }
          }
        }

        // 1d. Apply an anonymous (public) read-only bucket policy to the
        // PACKAGED bucket ONLY (issue #199) so HLS/DASH players can GET
        // manifests/segments without a bearer token. The SOURCE bucket MUST
        // stay private, so this loop deliberately targets PACKAGED_BUCKET
        // alone (unlike the bucket/CORS loops above, which iterate both).
        //
        // Policy: allow only s3:GetObject for principal '*' on the packaged
        // object prefix (arn:aws:s3:::<packaged>/*). No ListBucket, no write —
        // objects are readable by exact key but the bucket is not browsable.
        // setBucketPolicy(bucketName, policyJSON) is idempotent (it overwrites
        // any existing policy), so re-provision converges. Best-effort with the
        // same retry/backoff shape as the CORS loop: a policy failure must not
        // fail a re-provision of an otherwise-healthy stack.
        const packagedPolicy = JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${PACKAGED_BUCKET}/*`]
            }
          ]
        });
        {
          let attempts = 0;
          while (true) {
            try {
              await minioClient.setBucketPolicy(PACKAGED_BUCKET, packagedPolicy);
              break;
            } catch {
              attempts++;
              if (attempts >= 5) break; // best-effort — don't block provision
              await delay(3000);
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

        // 2b. Create the required CouchDB databases. waitForInstanceReady
        // passes when the container is healthy but the HTTP API may still be
        // starting up — retry with backoff the same way we do for MinIO.
        const couchAdminUrl = couchdbUrl
          .replace(/\/$/, '')
          .replace(/^(https?:\/\/)/, `$1admin:${couchdbAdminPassword}@`);
        const couchServer = nano(couchAdminUrl);
        const couchDbs = process.env['COUCHDB_ASSETS_DB']
          ? [process.env['COUCHDB_ASSETS_DB']]
          : ['assets', 'jobs', 'collections', 'webhooks'];
        for (const db of couchDbs) {
          let attempts = 0;
          while (true) {
            try {
              await couchServer.db.create(db);
              break;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              // Ignore "already exists" — idempotent re-provision.
              if (msg.includes('already exists') || msg.includes('file_exists')) break;
              attempts++;
              if (attempts >= 20) throw err;
              await delay(5000);
            }
          }
        }

        // 3. Valkey — queue / coordination backbone.
        currentService = 'valkey-io-valkey';
        await provision('valkey-io-valkey', {});
        await waitForInstanceReady('valkey-io-valkey', name, osc);
        const redisUrl = await redisUrlFrom(osc, 'valkey-io-valkey', name);

        // Encore and its paired callback listener are NOT provisioned here: the
        // auto-scaler spawns each Encore instance together with a dedicated
        // callback listener bound to that exact instance (ADR-006).
        //
        // The Encore packager is ALSO not provisioned here anymore (epic #226 /
        // issue #243). It is provisioned LAZILY on the first pipeline execution
        // that includes a packaging step (issue #244) and torn down on stack
        // deprovision (issue #246). A freshly provisioned stack therefore creates
        // no packager instance and mints no packager secrets/tokens until
        // packaging is actually used. The shared Valkey queue (created above) is
        // the wiring the on-demand packager consumes.

        // 5. Optional pipeline services (issue #216). The core stack is now up.
        // Each is created ONLY when the request opted in — opted-out means zero
        // cost (nothing is provisioned). Both flow through the same provision()
        // helper (so they land in provisioned[] and are covered by the
        // partial-failure cleanup below) and waitForInstanceReady, and their
        // instance names are recorded into the StackConfig persisted below.

        // 5a. eyevinn-auto-subtitles ("Subtitle Generator") — Whisper transcription.
        // Contract (get-service-schema, verified 2026-07-13): create config
        // requires `name` (^\w+$) AND `openaikey` (OpenAI key for Whisper).
        // No update-service-instance support. The key comes from the operator's
        // OPENAI_API_KEY env var, registered as a per-service OSC secret scoped
        // to AUTO_SUBTITLES_SERVICE_ID and referenced as {{secrets.*}} — never a
        // plaintext param, never logged. Opted in without the key is a fail-fast
        // configuration error surfaced on the operation, not a silent skip.
        if (wantAutoSubtitles) {
          currentService = AUTO_SUBTITLES_SERVICE_ID;
          if (!openaiApiKey) {
            throw new Error(
              'autoSubtitles was requested but OPENAI_API_KEY is not set on ' +
                'this deployment; set OPENAI_API_KEY (the OpenAI API key used by ' +
                'eyevinn-auto-subtitles for Whisper) and retry the provision'
            );
          }
          const openaiKeyRef = await secretRef(
            AUTO_SUBTITLES_SERVICE_ID,
            OPENAIKEY,
            openaiApiKey
          );
          await provision(AUTO_SUBTITLES_SERVICE_ID, {
            openaikey: openaiKeyRef
          });
          await waitForInstanceReady(AUTO_SUBTITLES_SERVICE_ID, name, osc);
          autoSubtitlesInstanceName = name;
        }

        // 5b. eyevinn-function-scenes ("Scene Detect Media Function").
        // Contract (get-service-schema, verified 2026-07-13): create config
        // requires ONLY `name` — no external key dependency.
        if (wantSceneDetect) {
          currentService = SCENE_DETECT_SERVICE_ID;
          await provision(SCENE_DETECT_SERVICE_ID, {});
          await waitForInstanceReady(SCENE_DETECT_SERVICE_ID, name, osc);
          sceneDetectInstanceName = name;
        }

        // Source-reading services (#212). Encore (transcode job input) and
        // eyevinn-ffmpeg-s3 (probe/thumbnail/remux) read from the SOURCE bucket.
        // Both are created in a DIFFERENT lifecycle than this provision flow:
        //   - encore instances are spawned on demand by the auto-scaler
        //     (encore-scaler/instance-pool.ts:150 spawnInstance, ADR-006), and
        //   - eyevinn-ffmpeg-s3 runs as a per-job ephemeral instance created via
        //     createJob at request time (pipeline/osc-ffprobe.ts,
        //     osc-thumbnail.ts, osc-rewrap.ts).
        // Neither is created here, so we cannot pass their create bodies from
        // this closure. What provisioning DOES own is the secret store: when the
        // operator supplied an external source bucket we pre-register the source
        // credentials as OSC secrets scoped to each of those serviceIds, so the
        // runtime create/job paths can reference them via {{secrets.*}} without
        // ever handling a plaintext value. The literal secret only reaches
        // saveSecret; it is never persisted to the param store or logged. The
        // non-secret coordinates (bucket/endpoint/region) are persisted in
        // `storageMetadata` below and consumed by the runtime paths.
        if (sourceStorage) {
          const sourceCreds = sourceStorage as ExternalStorageCredentials;
          // Save (but do not use here) the encore + ffmpeg-s3 source secrets so
          // the reference names are established under each serviceId. applyCredentialMapping
          // performs the saveSecret calls; the returned references are consumed
          // by the scaler / per-job paths (they resolve the same secret name).
          await applyCredentialMapping(
            EXTERNAL_STORAGE_SERVICE_IDS.encore,
            encoreCredentialMapping(sourceCreds, EXT_SOURCE)
          );
          await applyCredentialMapping(
            EXTERNAL_STORAGE_SERVICE_IDS.ffmpegS3,
            ffmpegS3CredentialMapping(sourceCreds, EXT_SOURCE)
          );
        }

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
            status: 'ready',
            minioEndpoint,
            couchdbUrl: stripCredentials(couchdbUrl),
            redisUrl,
            sourceBucket: SOURCE_BUCKET,
            packagedBucket: PACKAGED_BUCKET,
            // Optional pipeline instance names (issue #215 fields, populated by
            // #216). Present only when the request opted in and the instance was
            // created; omitted otherwise so opted-out stacks carry no field.
            ...(autoSubtitlesInstanceName
              ? { autoSubtitlesInstanceName }
              : {}),
            ...(sceneDetectInstanceName ? { sceneDetectInstanceName } : {}),
            // Non-secret storage backend metadata (issue #211). Secrets are
            // never included — only bucket/endpointUrl/region + backend type.
            storage: storageMetadata,
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
              redisUrl
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
                // Mark the partial write as failed (issue #106) so the resolver
                // never treats this never-completed stack as live. The empty
                // coordinates are still recorded, but the deprovision route
                // reads services[] regardless of status to clean up.
                status: 'failed',
                minioEndpoint: '',
                couchdbUrl: '',
                redisUrl: '',
                sourceBucket: SOURCE_BUCKET,
                packagedBucket: PACKAGED_BUCKET,
                // Preserve the requested storage backend metadata on the partial
                // write so deprovision/downstream can still resolve it (#211).
                storage: storageMetadata,
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
        return reply.code(501).send({ error: 'parameter store not configured (set PARAMETER_STORE_INSTANCE_NAME and PARAMETER_STORE_API_KEY)' });
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
            'parameter store not configured (set PARAMETER_STORE_INSTANCE_NAME and PARAMETER_STORE_API_KEY)'
        });
      }

      const workspaceId = await deriveWorkspaceId(osc);
      const config = await paramStore.loadStackConfig(workspaceId, name);
      if (!config) {
        return reply.code(404).send({ error: `no stored config for stack "${name}"` });
      }
      // Surface which optional opt-in services are active (issue #218) as a
      // derived boolean summary. Only attach `options` when at least one is
      // active so a stack with no optional services serialises exactly as stored
      // (preserves the GET /:name response-equality contract). The raw
      // *InstanceName fields are already passed through verbatim above.
      const autoSubtitles = Boolean(config.autoSubtitlesInstanceName);
      const sceneDetect = Boolean(config.sceneDetectInstanceName);
      const withOptions =
        autoSubtitles || sceneDetect
          ? { ...config, options: { autoSubtitles, sceneDetect } }
          : config;
      return reply.code(200).send(withOptions);
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
            // Tear down any on-demand packager first (consumer before the queue
            // it consumes), reconciling via introspection (issue #246). Safe
            // whether or not packaging ever ran: not_found when no packager
            // exists. A failure is logged but does not abort the static teardown.
            const packagerTeardown = await teardownOnDemandPackager(
              packagerOscApiFromContext(osc),
              name
            );
            if (packagerTeardown.status === 'failed') {
              app.log.error(
                { packagerTeardown, name },
                'on-demand packager teardown failed; continuing static teardown'
              );
            }
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

          // Stop the per-workspace Encore scaler and destroy every pooled
          // Encore/callback-listener instance *before* removing the static
          // services below (#123, sub-task of #107). teardown() is a clean
          // no-op when the scaler was never active for this workspace
          // (workspace-registry.ts:138), so this is safe when the registry is
          // absent or the pool is empty. Guard failures the same way the
          // parameter-store cleanup below does: a teardown error is logged but
          // must not abort the static-service deprovision that follows.
          const scalerRegistry = getScalerRegistry?.();
          if (scalerRegistry) {
            try {
              await scalerRegistry.teardown(workspaceId);
            } catch (err) {
              app.log.error(
                { err, name, workspaceId },
                'scaler teardown failed before static-service deprovision; continuing'
              );
            }
          }

          // Tear down any on-demand packager for this stack (epic #226 / issue
          // #246). The packager is provisioned lazily and is NOT recorded in
          // config.services[], so deprovisionStackFromConfig below never removes
          // it — we reconcile against OSC ground truth here (the packager shares
          // the stack name). It runs BEFORE the queue teardown below so the
          // consumer is removed before the Valkey it consumes (consumer-before-
          // producer, mirroring TEARDOWN_ORDER). Safe whether or not packaging
          // ever ran: not_found when no packager exists. A failure is logged but
          // must not abort the static-service teardown that follows (same policy
          // as the scaler teardown above).
          const packagerTeardown = await teardownOnDemandPackager(
            packagerOscApiFromContext(osc),
            name
          );
          if (packagerTeardown.status === 'failed') {
            app.log.error(
              { packagerTeardown, name, workspaceId },
              'on-demand packager teardown failed; continuing static teardown'
            );
          }

          // Teardown order and the instance set come from what was actually
          // provisioned (the stored services[]), not the static STACK_SERVICES.
          // Optional opt-in services (issue #218) recorded on the config are
          // torn down too: their instance names are passed alongside services[]
          // and deprovisionStackFromConfig merges (and dedupes) them so a stack
          // that activated auto-subtitles or scene-detect is fully removed.
          const result = await deprovisionStackFromConfig(
            osc,
            name,
            config.services,
            {
              ...(config.autoSubtitlesInstanceName
                ? { autoSubtitlesInstanceName: config.autoSubtitlesInstanceName }
                : {}),
              ...(config.sceneDetectInstanceName
                ? { sceneDetectInstanceName: config.sceneDetectInstanceName }
                : {})
            }
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
