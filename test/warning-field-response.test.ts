// A non-fatal `warning` field on the accepted transcode response when
// profileParams validation was SKIPPED (issue #394 — last of the #378 chain).
//
// When the profile YAML cannot be resolved (a custom profile not in the store,
// or a store outage), validateProfileParams SKIPS the key check and the request
// still succeeds permissively (issue #391). #394 surfaces that skip to the
// caller as a non-fatal `warning` object on the 202 response so a caller can SEE
// that validation did not run. When validation actually ran and passed, NO
// warning is present. Request acceptance and status code (202) are unchanged.
//
// Harness note (isolation): reuses the pattern from
// test/log-skipped-validation.test.ts. For the skipped case we use a profile
// that is not in the store so resolveProfileYaml() reports not-found. We keep a
// top-level `profile` (a name not in the store) so unrunnableProfileReason()
// runs against a reachable, empty store and returns no reason — the get() gap
// that #392 covers is avoided because the store is reachable.

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    requireAuth: vi.fn(async (token?: string) => token === 'token-a')
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryProfileRepository } from '../src/data/inmemory-profile-repo.js';
import type { ProfileRepository } from '../src/data/profile-repo.js';
import type { EncoreClient, EncoreSubmitInput } from '../src/pipeline/encore-client.js';

// A parametrized profile YAML (verbatim SpEL shapes from the Eyevinn
// encore-test-profiles set) so the genuine-pass case has a resolvable profile
// with a declared key set.
const X264_CRF_PARAMETRIZED_YAML = `name: x264-crf-parametrized
description: Program profile
encodes:
  - type: X264Encode
    params:
      crf: #{profileParams['crf']?:23}
      preset: #{profileParams['preset']?:"medium"}
`;

function fakeEncore(): { client: EncoreClient; submitted: EncoreSubmitInput[] } {
  const submitted: EncoreSubmitInput[] = [];
  const client: EncoreClient = {
    async submit(input) {
      submitted.push(input);
      return { encoreInternalId: 'encore-internal-1' };
    }
  };
  return { client, submitted };
}

async function buildApp(profiles: ProfileRepository): Promise<{
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  submitted: EncoreSubmitInput[];
}> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);

  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const { client, submitted } = fakeEncore();

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: jobs,
    encore: client,
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket',
    profileRepository: profiles
  });
  await app.ready();
  return { app, assets, submitted };
}

async function makeSource(assets: InMemoryAssetRepository): Promise<string> {
  const asset = await assets.create({ name: 'my-video', objectKey: 'ingest/my-video' });
  return asset.id;
}

describe('warning field on accepted transcode response when validation skipped (issue #394)', () => {
  it('(a) skipped validation (unresolvable profile) -> 202 WITH a warning naming the profile + unvalidated keys', async () => {
    // Store reachable, but the chosen profile is not in it -> not-found ->
    // validation skipped -> warning present.
    const profiles = new InMemoryProfileRepository();
    const { app, assets, submitted } = await buildApp(profiles);
    const id = await makeSource(assets);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { authorization: 'Bearer token-a' },
      // Deliberately unsorted keys so we can assert the reported set is sorted.
      payload: { profile: 'not-in-store', profileParams: { zeta: '1', alpha: '2' } }
    });

    // Acceptance + status unchanged.
    expect(res.statusCode).toBe(202);
    expect(submitted).toHaveLength(1);

    const body = res.json();
    expect(body.jobId).toBeDefined();
    expect(body.encoreJobId).toBeDefined();
    // The non-fatal warning is present and describes the skip.
    expect(body.warning).toBeDefined();
    expect(body.warning.code).toBe('profile_params_unvalidated');
    expect(body.warning.profile).toBe('not-in-store');
    expect(body.warning.unvalidatedKeys).toEqual(['alpha', 'zeta']);
    expect(body.warning.message).toContain('not-in-store');
    expect(body.warning.message).toMatch(/skipped/i);

    await app.close();
  });

  it('(b) genuine validated pass (resolvable profile declaring the keys) -> 202 with NO warning', async () => {
    const profiles = new InMemoryProfileRepository();
    await profiles.create({ name: 'x264-crf-parametrized', yaml: X264_CRF_PARAMETRIZED_YAML });
    const { app, assets, submitted } = await buildApp(profiles);
    const id = await makeSource(assets);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { authorization: 'Bearer token-a' },
      // A declared key -> genuine validated pass -> no warning.
      payload: { profile: 'x264-crf-parametrized', profileParams: { crf: '20' } }
    });

    expect(res.statusCode).toBe(202);
    expect(submitted).toHaveLength(1);

    const body = res.json();
    expect(body.jobId).toBeDefined();
    expect(body.encoreJobId).toBeDefined();
    expect(body.warning).toBeUndefined();

    await app.close();
  });
});
