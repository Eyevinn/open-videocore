// Execute-path profileParams threading tests (issue #288).
//
// POST /api/v1/assets/:id/execute must accept an optional flat
// `profileParams` string map and forward it into the SAME transcode submission
// path used by POST /:id/transcode, so SpEL-parametrised profiles
// (x264-crf-parametrized, program-kf) work from execute as well.
//
// The execute route body schema extended here is the inline `z.object({...})`
// on `app.post('/:id/execute', ...)` in src/routes/assets.ts, which now carries
// `profileParams: profileParamsSchema.optional()` (the same profileParamsSchema
// introduced for POST /:id/transcode in issue #287). It threads the value into
// startPipelineExecution's `encodeOpts.profileParams`, which submitTranscode
// passes to EncoreClient.submit verbatim.
//
// This harness uses the CURRENT single-arg repository signatures
// (create(input) / get(id)) so it is unaffected by the pre-existing
// two-arg workspace-scoping drift that 409s test/transcode.test.ts.

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = { 'token-a': 'workspace-a' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import type { EncoreClient, EncoreSubmitInput } from '../src/pipeline/encore-client.js';

const A = { authorization: 'Bearer token-a' };

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  submitted: EncoreSubmitInput[];
};

function fakeEncore(): { client: EncoreClient; submitted: EncoreSubmitInput[] } {
  const submitted: EncoreSubmitInput[] = [];
  const client = {
    submit: vi.fn(async (input: EncoreSubmitInput) => {
      submitted.push(input);
      return { encoreInternalId: 'encore-internal-1' };
    }),
    getJobStatus: vi.fn(),
    cancel: vi.fn()
  } as unknown as EncoreClient;
  return { client, submitted };
}

async function buildApp(): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();
  const { client, submitted } = fakeEncore();

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: jobs,
    pipelineRepository: pipelines,
    encore: client,
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket'
  });
  await app.ready();
  return { app, assets, submitted };
}

// A source asset carrying a stored object so the abr-vod pipeline's first step
// (transcode) is runnable.
async function makeSource(h: Harness, name = 'my-video'): Promise<string> {
  const asset = await h.assets.create({ name, objectKey: `ingest/${name}` });
  return asset.id;
}

describe('execute-path profileParams (issue #288)', () => {
  it('forwards supplied profileParams into the transcode submission verbatim', async () => {
    const h = await buildApp();
    const sourceId = await makeSource(h);
    const profileParams = { crf: '18', preset: 'slow', height: '720', keyframes: '48' };

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${sourceId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', profile: 'x264-crf-parametrized', profileParams }
    });

    expect(res.statusCode).toBe(202);
    // The transcode step reached Encore with the profile + profileParams verbatim.
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0].profile).toBe('x264-crf-parametrized');
    expect(h.submitted[0].profileParams).toEqual(profileParams);
  });

  it('leaves profileParams undefined when omitted (execute unchanged)', async () => {
    const h = await buildApp();
    const sourceId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${sourceId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', profile: 'program' }
    });

    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0].profileParams).toBeUndefined();
  });

  it('rejects non-string profileParams values (flat string map contract)', async () => {
    const h = await buildApp();
    const sourceId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${sourceId}/execute`,
      headers: A,
      // height is a number, not a string — violates Record<string,string>.
      payload: {
        pipeline: 'abr-vod',
        profile: 'x264-crf-parametrized',
        profileParams: { height: 720 }
      }
    });

    expect(res.statusCode).toBe(400);
    expect(h.submitted).toHaveLength(0);
  });
});
