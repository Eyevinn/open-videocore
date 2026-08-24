// Store-unreachable vs profile-not-found resolution tests (issue #392).
//
// Two layers:
//   1. Unit tests for the resolver (src/pipeline/resolve-profile-yaml.ts): a
//      profile that exists resolves to `found`, a reachable-but-absent profile
//      resolves to `not-found`, and a store whose get() THROWS resolves to
//      `store-unreachable` (the error captured, never rethrown).
//   2. HTTP tests that drive POST /api/v1/assets/:id/transcode with an injected
//      profileRepository, proving the request is STILL accepted (permissive) in
//      BOTH the not-found and store-unreachable cases — a store outage must not
//      turn a transcode submit into a 500.

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

import { resolveProfileYaml } from '../src/pipeline/resolve-profile-yaml.js';
import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryProfileRepository } from '../src/data/inmemory-profile-repo.js';
import type { Profile, ProfileRepository } from '../src/data/profile-repo.js';
import type { EncoreClient, EncoreSubmitInput } from '../src/pipeline/encore-client.js';

const CUSTOM_YAML = `name: my-custom
description: Custom profile
encodes:
  - type: X264Encode
    params:
      crf: #{profileParams['crf']?:23}
`;

// ---------------------------------------------------------------------------
// Unit: the resolver directly
// ---------------------------------------------------------------------------

describe('resolveProfileYaml (issue #392)', () => {
  it('resolves to found with the YAML when the profile exists', async () => {
    const profiles = new InMemoryProfileRepository();
    await profiles.create({ name: 'my-custom', yaml: CUSTOM_YAML });
    const r = await resolveProfileYaml(profiles, 'my-custom');
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.yaml).toBe(CUSTOM_YAML);
  });

  it('resolves to not-found when the store is reachable but has no such profile', async () => {
    const profiles = new InMemoryProfileRepository();
    const r = await resolveProfileYaml(profiles, 'nope');
    expect(r.status).toBe('not-found');
  });

  it('resolves to not-found when no repository is provided (nothing to resolve)', async () => {
    const r = await resolveProfileYaml(undefined, 'anything');
    expect(r.status).toBe('not-found');
  });

  it('resolves to store-unreachable, capturing the error, when get() throws', async () => {
    const boom = new Error('couch unreachable');
    const throwing: ProfileRepository = {
      get: vi.fn(async (_name: string): Promise<Profile | undefined> => {
        throw boom;
      }),
      create: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn()
    } as unknown as ProfileRepository;
    const r = await resolveProfileYaml(throwing, 'my-custom');
    expect(r.status).toBe('store-unreachable');
    if (r.status !== 'store-unreachable') return;
    expect(r.error).toBe(boom);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration: POST /api/v1/assets/:id/transcode stays permissive
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

describe('POST /:id/transcode store-unreachable vs not-found permissiveness (issue #392)', () => {
  it('accepts the request when the profile is resolvable-but-absent (not-found)', async () => {
    const { app, assets, submitted } = await buildApp(new InMemoryProfileRepository());
    const id = await makeSource(assets);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { authorization: 'Bearer token-a' },
      payload: { profile: 'not-in-store', profileParams: { anything: 'goes' } }
    });
    // Store reachable, profile absent -> permissive: still submitted.
    expect(res.statusCode).toBe(202);
    expect(submitted).toHaveLength(1);
    await app.close();
  });

  it('STILL accepts the request when the profile store throws (store-unreachable, not a 500)', async () => {
    const throwing: ProfileRepository = {
      get: vi.fn(async (_name: string): Promise<Profile | undefined> => {
        throw new Error('couch unreachable');
      }),
      create: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn()
    } as unknown as ProfileRepository;
    const { app, assets, submitted } = await buildApp(throwing);
    const id = await makeSource(assets);
    // We omit `profile` so this exercises exactly the #392 call site (the
    // profileParams profile-YAML read, which defaults the profile name to
    // 'program'). Omitting `profile` also short-circuits the SEPARATE, out-of-
    // scope unrunnable-profile check (unrunnableProfileReason returns early on an
    // undefined name without touching the store), so the store throw is observed
    // solely at the #392 resolver. A store outage there must NOT turn a
    // transcode submit into a 500; it degrades permissively (undefined YAML into
    // validateProfileParams) and submits.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { authorization: 'Bearer token-a' },
      payload: { profileParams: { crf: '20' } }
    });
    expect(res.statusCode).toBe(202);
    expect(submitted).toHaveLength(1);
    await app.close();
  });
});
