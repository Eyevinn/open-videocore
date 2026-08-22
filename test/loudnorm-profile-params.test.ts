// Loudness-normalisation target threading tests (issue #385).
//
// Proves the integrated-loudness target for the built-in loudnorm profile
// (loudnorm-ebu-r128) is settable at request time via `profileParams` and flows
// end-to-end onto the built Encore job payload's `profileParams`, so it reaches
// the ffmpeg `loudnorm I=` value inside the served profile YAML.
//
// The transcode request threads `profileParams` through the SAME path exercised
// by test/execute-profile-params.test.ts (#288): POST /:id/execute ->
// startPipelineExecution -> submitTranscode -> EncoreClient.submit(input) ->
// toEncorePayload(input). We assert BOTH that the fake Encore client receives the
// target as profileParams AND that toEncorePayload copies it verbatim into the
// job document's `profileParams` object. No live Encore instance is used (fake
// client), per the issue: audible/measured verification is DEFERRED to #386.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - src/pipeline/encore-client.ts:81-98 — toEncorePayload copies input.profileParams
//     verbatim into the payload's `profileParams` when present, omits it otherwise.
//   - src/services/builtin-profiles.ts — LOUDNORM_PROFILE_NAME / LOUDNORM_TARGET_PARAM /
//     LOUDNORM_FILTER (the `I=` value is `#{profileParams['targetI']?:-23}`).
//   - test/execute-profile-params.test.ts (#288) — the harness/fake-Encore pattern
//     this reuses for the end-to-end thread.

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
import { toEncorePayload, type EncoreClient, type EncoreSubmitInput } from '../src/pipeline/encore-client.js';
import {
  LOUDNORM_PROFILE_NAME,
  LOUDNORM_TARGET_PARAM
} from '../src/services/builtin-profiles.js';

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

async function makeSource(h: Harness, name = 'my-video'): Promise<string> {
  const asset = await h.assets.create({ name, objectKey: `ingest/${name}` });
  return asset.id;
}

describe('loudnorm target threads request -> Encore payload (issue #385)', () => {
  it('forwards a request-time targetI onto the built Encore job payload profileParams', async () => {
    const h = await buildApp();
    const sourceId = await makeSource(h);
    // A streaming target (-16 LUFS) supplied at request time, overriding the
    // profile's -23 LUFS default.
    const profileParams = { [LOUDNORM_TARGET_PARAM]: '-16' };

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${sourceId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', profile: LOUDNORM_PROFILE_NAME, profileParams }
    });

    expect(res.statusCode).toBe(202);
    // The transcode step reached Encore selecting the loudnorm profile, carrying
    // the target as profileParams verbatim.
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0].profile).toBe(LOUDNORM_PROFILE_NAME);
    expect(h.submitted[0].profileParams).toEqual({ [LOUDNORM_TARGET_PARAM]: '-16' });

    // And toEncorePayload copies it into the actual job document's profileParams,
    // which Encore evaluates as the SpEL value for the loudnorm `I=` target.
    const payload = toEncorePayload(h.submitted[0]);
    expect(payload.profile).toBe(LOUDNORM_PROFILE_NAME);
    expect(payload.profileParams).toEqual({ [LOUDNORM_TARGET_PARAM]: '-16' });
  });

  it('omits profileParams when no target is supplied (profile default -23 LUFS applies)', async () => {
    const h = await buildApp();
    const sourceId = await makeSource(h);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${sourceId}/execute`,
      headers: A,
      payload: { pipeline: 'abr-vod', profile: LOUDNORM_PROFILE_NAME }
    });

    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0].profileParams).toBeUndefined();
    // With no profileParams, the payload omits the key so Encore's `{}` default
    // stands and the profile's own SpEL default (-23 LUFS) is used.
    const payload = toEncorePayload(h.submitted[0]);
    expect(payload.profileParams).toBeUndefined();
  });
});
