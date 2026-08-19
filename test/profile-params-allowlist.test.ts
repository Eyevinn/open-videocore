// Per-profile profileParams key allowlist tests (issue #290).
//
// Two layers:
//   1. Unit tests for the extractor + validator (src/pipeline/profile-params.ts)
//      against the REAL SpEL shapes taken from the operator-managed Encore
//      profile index the profile store seeds from and GET /api/v1/profiles
//      serves (the Eyevinn encore-test-profiles set — see ENCORE_PROFILES_URL in
//      src/main.ts). The `x264-crf-parametrized` / `program-kf` / `program`
//      YAML snippets below are copied verbatim from those profile documents so
//      the accepted key set under test is derived from the actual profile
//      definitions, not a hardcoded guess.
//   2. An HTTP test that drives POST /api/v1/assets/:id/transcode with a wired
//      profile store, asserting an unknown key returns a descriptive 400 while a
//      valid key is accepted.

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

import {
  declaredProfileParamKeys,
  validateProfileParams
} from '../src/pipeline/profile-params.js';
import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryProfileRepository } from '../src/data/inmemory-profile-repo.js';
import type { EncoreClient, EncoreSubmitInput } from '../src/pipeline/encore-client.js';

// SpEL param references copied verbatim from the fetched profile YAML documents.
const X264_CRF_PARAMETRIZED_YAML = `name: x264-crf-parametrized
description: Program profile
scaling: bicubic
encodes:
  - type: X264Encode
    suffix: _x264_#{profileParams['preset']?:"medium"}_crf_#{profileParams['crf']?:23}
    twoPass: false
    height: #{profileParams['height']?:1080}
    params:
      crf: #{profileParams['crf']?:23}
      force_key_frames: #{profileParams['keyframes']?:'expr:not(mod(n,96))'}
      preset: #{profileParams['preset']?:"medium"}
`;

const PROGRAM_KF_YAML = `name: program
description: Program profile
encodes:
  - type: X264Encode
    params:
      force_key_frames: #{profileParams['keyframes']?:'expr:not(mod(n,96))'}
`;

// program.yml declares no profileParams at all.
const PROGRAM_YAML = `name: program
description: Program profile
encodes:
  - type: X264Encode
    params:
      force_key_frames: expr:not(mod(n,96))
`;

describe('declaredProfileParamKeys (issue #290)', () => {
  it('extracts the four SpEL params from x264-crf-parametrized', () => {
    const keys = declaredProfileParamKeys(X264_CRF_PARAMETRIZED_YAML);
    expect([...keys].sort()).toEqual(['crf', 'height', 'keyframes', 'preset']);
  });

  it('extracts only keyframes from program-kf', () => {
    const keys = declaredProfileParamKeys(PROGRAM_KF_YAML);
    expect([...keys]).toEqual(['keyframes']);
  });

  it('returns an empty set for a profile that declares no params', () => {
    expect(declaredProfileParamKeys(PROGRAM_YAML).size).toBe(0);
  });

  it('handles double-quoted SpEL keys too', () => {
    expect([...declaredProfileParamKeys(`suffix: #{profileParams["crf"]?:23}`)]).toEqual(['crf']);
  });
});

describe('validateProfileParams (issue #290)', () => {
  it('passes a known key through unchanged', () => {
    const r = validateProfileParams({
      profileName: 'x264-crf-parametrized',
      profileYaml: X264_CRF_PARAMETRIZED_YAML,
      profileParams: { crf: '20', preset: 'slow' }
    });
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown key with the accepted set named', () => {
    const r = validateProfileParams({
      profileName: 'x264-crf-parametrized',
      profileYaml: X264_CRF_PARAMETRIZED_YAML,
      profileParams: { crfs: '20' }
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.unknownKeys).toEqual(['crfs']);
    expect(r.allowedKeys).toEqual(['crf', 'height', 'keyframes', 'preset']);
    expect(r.message).toContain('crfs');
    expect(r.message).toContain('crf, height, keyframes, preset');
  });

  it('rejects any key for a profile that declares no params', () => {
    const r = validateProfileParams({
      profileName: 'program',
      profileYaml: PROGRAM_YAML,
      profileParams: { crf: '20' }
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('accepts no profileParams');
  });

  it('accepts an absent map for any profile', () => {
    expect(
      validateProfileParams({ profileName: 'program', profileYaml: PROGRAM_YAML, profileParams: undefined }).ok
    ).toBe(true);
  });

  it('accepts an empty map for any profile', () => {
    expect(
      validateProfileParams({ profileName: 'program', profileYaml: PROGRAM_YAML, profileParams: {} }).ok
    ).toBe(true);
  });

  it('is permissive when the profile YAML cannot be resolved (custom/unknown profile)', () => {
    const r = validateProfileParams({
      profileName: 'my-custom',
      profileYaml: undefined,
      profileParams: { anything: 'goes' }
    });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration: POST /api/v1/assets/:id/transcode
// ---------------------------------------------------------------------------

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

async function buildApp(): Promise<{
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  profiles: InMemoryProfileRepository;
  submitted: EncoreSubmitInput[];
}> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);

  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const profiles = new InMemoryProfileRepository();
  await profiles.create({ name: 'x264-crf-parametrized', yaml: X264_CRF_PARAMETRIZED_YAML });
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
  return { app, assets, profiles, submitted };
}

async function makeSource(assets: InMemoryAssetRepository): Promise<string> {
  const asset = await assets.create({ name: 'my-video', objectKey: 'ingest/my-video' });
  return asset.id;
}

describe('POST /:id/transcode profileParams key validation (issue #290)', () => {
  it('rejects an unknown profileParams key for the chosen profile with a descriptive 400', async () => {
    const { app, assets } = await buildApp();
    const id = await makeSource(assets);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { authorization: 'Bearer token-a' },
      payload: { profile: 'x264-crf-parametrized', profileParams: { crfs: '20' } }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_profile_params');
    expect(res.json().message).toContain('crfs');
    expect(res.json().message).toContain('crf, height, keyframes, preset');
    await app.close();
  });

  it('accepts a valid profileParams key and forwards it to Encore', async () => {
    const { app, assets, submitted } = await buildApp();
    const id = await makeSource(assets);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { authorization: 'Bearer token-a' },
      payload: { profile: 'x264-crf-parametrized', profileParams: { crf: '20', preset: 'slow' } }
    });
    expect(res.statusCode).toBe(202);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].profileParams).toEqual({ crf: '20', preset: 'slow' });
    await app.close();
  });

  it('is permissive for a profile not in the store (unknown/custom profile)', async () => {
    const { app, assets } = await buildApp();
    const id = await makeSource(assets);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { authorization: 'Bearer token-a' },
      payload: { profile: 'not-in-store', profileParams: { anything: 'goes' } }
    });
    // Not rejected on unknown keys — the profile YAML is unresolvable, so we
    // degrade permissively rather than falsely rejecting a custom profile.
    expect(res.statusCode).toBe(202);
    await app.close();
  });
});
