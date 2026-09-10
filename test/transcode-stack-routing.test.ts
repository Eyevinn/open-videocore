// Regression coverage for issue #615 at the route boundary.
//
// The transcode path must key the Encore auto-scaler's pool / Valkey queue /
// MinIO endpoint resolution by the EFFECTIVE stack the request names, not by a
// fixed process-global deployment context. The scaler partitions all of that by
// the encodeEncoreJobId contextId (the prefix of every EncoreSubmitInput
// externalId — see pipeline/transcode.ts + data/job-repo.ts encodeEncoreJobId),
// so asserting the submitted externalId is prefixed with the resolved stack name
// proves the request routes to the named stack.
//
// resolveStackContext stands in for main.ts's wiring
// (stackResolver.resolveStackName): given the request's X-Stack-Name it returns
// the effective stack identity. Here it maps the requested name to itself when
// "provisioned", proving both provisioning orders route to the SAME named stack.

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import type { EncoreClient, EncoreSubmitInput } from '../src/pipeline/encore-client.js';

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  submitted: EncoreSubmitInput[];
  resolveCalls: Array<string | undefined>;
};

// resolveStackContext keyed by a set of "provisioned" stack names, returning the
// requested name verbatim when it is provisioned. When the requested name is
// absent it returns the first provisioned stack (workspace default), mirroring
// WorkspaceStackResolver.resolveStackName. Records every requested name so the
// test can assert the header value was threaded through.
async function buildApp(provisioned: string[]): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const submitted: EncoreSubmitInput[] = [];
  const resolveCalls: Array<string | undefined> = [];

  const encore: EncoreClient = {
    async submit(input) {
      submitted.push(input);
      return { encoreInternalId: 'encore-internal-1' };
    }
  };

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: jobs,
    encore,
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket',
    resolveStackContext: async (requested?: string) => {
      resolveCalls.push(requested);
      if (requested && provisioned.includes(requested)) return requested;
      return provisioned.length > 0 ? provisioned[0] : undefined;
    }
  });
  await app.ready();
  return { app, assets, submitted, resolveCalls };
}

async function makeSource(assets: InMemoryAssetRepository, name = 'clip'): Promise<string> {
  const asset = await assets.create({ name, objectKey: `ingest/${name}` });
  await assets.update(asset.id, { status: 'processing' });
  await assets.update(asset.id, { status: 'ready' });
  return asset.id;
}

// The scaler partition key is the prefix of the externalId, before the '__'
// separator (data/job-repo.ts encodeEncoreJobId).
function contextOf(externalId: string): string {
  return externalId.slice(0, externalId.indexOf('__'));
}

describe('transcode routes to the named stack regardless of provision order (issue #615)', () => {
  it('keys the scaler context by the named stack when it was provisioned FIRST', async () => {
    const h = await buildApp(['healthy', 'unhealthy']);
    const id = await makeSource(h.assets);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { 'x-stack-name': 'healthy' },
      payload: {}
    });
    expect(res.statusCode).toBe(202);
    expect(h.resolveCalls).toContain('healthy');
    expect(h.submitted).toHaveLength(1);
    expect(contextOf(h.submitted[0].externalId)).toBe('healthy');
  });

  it('keys the scaler context by the named stack when it was provisioned SECOND', async () => {
    // Pre-#615 the first-provisioned 'unhealthy' stack would win regardless of
    // the header; the resolved context must still be 'healthy'.
    const h = await buildApp(['unhealthy', 'healthy']);
    const id = await makeSource(h.assets);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { 'x-stack-name': 'healthy' },
      payload: {}
    });
    expect(res.statusCode).toBe(202);
    expect(contextOf(h.submitted[0].externalId)).toBe('healthy');
  });

  it('falls back to the first provisioned stack for the workspace default (no header)', async () => {
    const h = await buildApp(['alpha', 'beta']);
    const id = await makeSource(h.assets);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      payload: {}
    });
    expect(res.statusCode).toBe(202);
    expect(h.resolveCalls).toContain(undefined);
    expect(contextOf(h.submitted[0].externalId)).toBe('alpha');
  });

  it('falls back to the fixed deployment context when no resolver is wired', async () => {
    // Without resolveStackContext (tests / env-override single-stack), the path
    // is byte-identical to pre-#615: the fixed DEPLOYMENT_CONTEXT ("default").
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const assets = new InMemoryAssetRepository();
    const submitted: EncoreSubmitInput[] = [];
    await app.register(assetsRouter, {
      prefix: '/api/v1/assets',
      repository: assets,
      jobRepository: new InMemoryJobRepository(),
      encore: {
        async submit(input) {
          submitted.push(input);
          return { encoreInternalId: 'x' };
        }
      },
      sourceBucket: 'src-bucket',
      outputBucket: 'out-bucket'
    });
    await app.ready();
    const id = await makeSource(assets);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { 'x-stack-name': 'ignored-without-resolver' },
      payload: {}
    });
    expect(res.statusCode).toBe(202);
    expect(contextOf(submitted[0].externalId)).toBe('default');
  });
});
