// Encore profile management tests (issue #84).
//
// Exercises the profiles router + bootstrap against the in-memory repository,
// which mirrors the CouchDB backend's naming semantics, so the rules under test
// are backend-agnostic by construction. The whole router is unauthenticated by
// design (public index.yml must be reachable by Encore without a token), so no
// auth wiring is needed here.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { profilesRouter } from '../src/routes/profiles.js';
import { InMemoryProfileRepository } from '../src/data/inmemory-profile-repo.js';
import { parseProfileIndex, bootstrapProfiles } from '../src/services/profile-bootstrap.js';
import {
  LOUDNORM_PROFILE_NAME,
  LOUDNORM_TARGET_PARAM,
  LOUDNORM_DEFAULT_TARGET_LUFS,
  LOUDNORM_FILTER
} from '../src/services/builtin-profiles.js';
import { isProfileRunnable } from '../src/services/profile-runnability.js';
import { declaredProfileParamKeys } from '../src/pipeline/profile-params.js';

const BOOTSTRAP_URL = 'https://example.test/profiles.yml';

async function buildApp(repo: InMemoryProfileRepository): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(profilesRouter, {
    prefix: '/api/v1/profiles',
    repository: repo,
    bootstrapIndexUrl: BOOTSTRAP_URL
  });
  await app.ready();
  return app;
}

describe('profiles CRUD router (issue #84)', () => {
  let repo: InMemoryProfileRepository;
  let app: FastifyInstance;

  beforeEach(async () => {
    repo = new InMemoryProfileRepository();
    app = await buildApp(repo);
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates, lists, gets, updates and deletes a profile', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { name: 'program', yaml: 'name: program\n' }
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({ name: 'program', yaml: 'name: program\n' });

    const list = await app.inject({ method: 'GET', url: '/api/v1/profiles' });
    expect(list.statusCode).toBe(200);
    expect(list.json().profiles).toEqual(['program']);
    expect(list.json().items).toHaveLength(1);

    const get = await app.inject({ method: 'GET', url: '/api/v1/profiles/program' });
    expect(get.statusCode).toBe(200);
    expect(get.json().yaml).toBe('name: program\n');

    const update = await app.inject({
      method: 'PUT',
      url: '/api/v1/profiles/program',
      payload: { yaml: 'name: program\nupdated: true\n' }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().yaml).toContain('updated: true');

    const del = await app.inject({ method: 'DELETE', url: '/api/v1/profiles/program' });
    expect(del.statusCode).toBe(204);

    const gone = await app.inject({ method: 'GET', url: '/api/v1/profiles/program' });
    expect(gone.statusCode).toBe(404);
  });

  it('rejects a duplicate name with 409', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/profiles', payload: { name: 'a', yaml: 'x: 1\n' } });
    const dup = await app.inject({ method: 'POST', url: '/api/v1/profiles', payload: { name: 'a', yaml: 'y: 2\n' } });
    expect(dup.statusCode).toBe(409);
  });

  it('rejects an invalid profile name with 400', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { name: 'bad name/../etc', yaml: 'x: 1\n' }
    });
    expect(bad.statusCode).toBe(400);
  });

  it('DELETE of an unknown profile is idempotent (204)', async () => {
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/profiles/nope' });
    expect(del.statusCode).toBe(204);
  });

  it('PUT of an unknown profile is 404', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/v1/profiles/nope', payload: { yaml: 'x: 1\n' } });
    expect(put.statusCode).toBe(404);
  });

  it('serves a valid Encore-format index.yml with per-profile refs', async () => {
    await repo.create({ name: 'program', yaml: 'a: 1\n' });
    await repo.create({ name: 'archive', yaml: 'b: 2\n' });

    const index = await app.inject({ method: 'GET', url: '/api/v1/profiles/index.yml' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/yaml');
    // Sorted, each name mapped to its per-profile yaml document.
    expect(index.body).toBe('archive: archive/yaml\nprogram: program/yaml\n');
  });

  it('serves per-profile raw YAML', async () => {
    await repo.create({ name: 'program', yaml: 'name: program\nfoo: bar\n' });
    const yaml = await app.inject({ method: 'GET', url: '/api/v1/profiles/program/yaml' });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.headers['content-type']).toContain('text/yaml');
    expect(yaml.body).toBe('name: program\nfoo: bar\n');
  });
});

// A minimal but representative GPU-only (NVENC/CUDA) profile YAML, matching the
// seeded program-nvenc-h265 / nvenc-test shape (Eyevinn/encore-test-profiles):
// every video encode uses `codec: hevc_nvenc` plus CUDA-only scale filters.
const NVENC_YAML = [
  'name: nvenc-test',
  'scaling: bicubic',
  'filterSettings:',
  '  scaleFilter: scale_cuda',
  'encodes:',
  '  - type: VideoEncode',
  '    codec: hevc_nvenc',
  '    format: mp4',
  '    height: 1080',
  ''
].join('\n');

// A normal CPU (x264) profile, runnable on OSC's CPU-only Encore instances.
const CPU_YAML = 'name: program\nencodes:\n  - type: X264Encode\n    height: 1080\n';

describe('GPU-only profiles are not offered as runnable (issue #286)', () => {
  let repo: InMemoryProfileRepository;
  let app: FastifyInstance;

  beforeEach(async () => {
    repo = new InMemoryProfileRepository();
    app = await buildApp(repo);
    await repo.create({ name: 'program', yaml: CPU_YAML });
    await repo.create({ name: 'nvenc-test', yaml: NVENC_YAML });
  });

  afterEach(async () => {
    await app.close();
  });

  it('excludes GPU-only profiles from the selectable picker but flags them in items', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/profiles' });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    // The runnable selectable set offered to callers/UI excludes the GPU-only one.
    expect(body.profiles).toEqual(['program']);
    // But the full items list still surfaces it, explicitly flagged unrunnable.
    const nvenc = body.items.find((p: { name: string }) => p.name === 'nvenc-test');
    const program = body.items.find((p: { name: string }) => p.name === 'program');
    expect(nvenc.runnable).toBe(false);
    expect(program.runnable).toBe(true);
  });

  it('excludes GPU-only profiles from the Encore-facing index.yml', async () => {
    const index = await app.inject({ method: 'GET', url: '/api/v1/profiles/index.yml' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('program: program/yaml');
    expect(index.body).not.toContain('nvenc-test');
  });

  it('annotates a single profile with runnable', async () => {
    const nvenc = await app.inject({ method: 'GET', url: '/api/v1/profiles/nvenc-test' });
    expect(nvenc.statusCode).toBe(200);
    expect(nvenc.json().runnable).toBe(false);

    const program = await app.inject({ method: 'GET', url: '/api/v1/profiles/program' });
    expect(program.json().runnable).toBe(true);
  });
});

describe('profile bootstrap (issue #84)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a flat Encore profile index', () => {
    const parsed = parseProfileIndex('# comment\nprogram: program.yml\narchive: archive.yml\nnone: none.yml\n');
    expect(parsed).toEqual([
      { name: 'program', ref: 'program.yml' },
      { name: 'archive', ref: 'archive.yml' },
      { name: 'none', ref: 'none.yml' }
    ]);
  });

  it('seeds the repository from the index, resolving each ref, and skips "none"', async () => {
    const repo = new InMemoryProfileRepository();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/profiles.yml')) {
        return new Response('program: program.yml\nnone: none.yml\n', { status: 200 });
      }
      if (url.endsWith('/program.yml')) {
        return new Response('name: program\n', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await bootstrapProfiles({
      repository: repo,
      indexUrl: 'https://example.test/dir/profiles.yml'
    });

    // One remote profile seeded (`program`); built-ins (issue #385) are also
    // ensured, so builtinSeeded reflects the loudnorm profile added on a fresh
    // store. The remote `program` profile is still present with its exact YAML.
    expect(result.seeded).toBe(1);
    expect(result.skipped).toBe(false);
    expect(result.builtinSeeded).toBeGreaterThanOrEqual(1);
    const stored = await repo.list();
    const program = stored.find((p) => p.name === 'program');
    expect(program?.yaml).toBe('name: program\n');
  });

  it('skips seeding when profiles already exist', async () => {
    const repo = new InMemoryProfileRepository();
    await repo.create({ name: 'existing', yaml: 'x: 1\n' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await bootstrapProfiles({ repository: repo, indexUrl: 'https://example.test/profiles.yml' });
    // Remote-index seeding is skipped because the store already held a profile,
    // but built-ins (issue #385) are still ensured without any remote fetch.
    expect(result.seeded).toBe(0);
    expect(result.skipped).toBe(true);
    expect(result.builtinSeeded).toBeGreaterThanOrEqual(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('built-in loudness-normalisation profile (issue #385)', () => {
  it('ships single-pass loudnorm with a -23 LUFS default target parametrised via profileParams', () => {
    // The shipped filter is single-pass loudnorm (ADR-013), with the integrated
    // target defaulted to -23 LUFS (broadcast EBU R128) via a profileParams SpEL
    // expression, and TP=-1 / LRA=7 as the fixed EBU R128 companions.
    expect(LOUDNORM_DEFAULT_TARGET_LUFS).toBe(-23);
    expect(LOUDNORM_FILTER).toBe(
      `loudnorm=I=#{profileParams['${LOUDNORM_TARGET_PARAM}']?:-23}:TP=-1:LRA=7`
    );
    // The target key is auto-allowlisted for POST /:id/transcode because the
    // allowlist extractor (#290) derives keys from exactly this SpEL shape.
    expect(declaredProfileParamKeys(LOUDNORM_FILTER).has(LOUDNORM_TARGET_PARAM)).toBe(true);
  });

  it('is seeded by bootstrap, appears in the served index.yml and is runnable', async () => {
    const repo = new InMemoryProfileRepository();
    // A store that already holds a profile: remote-index seeding is skipped, but
    // the built-in loudnorm profile must still be ensured (issue #385).
    await repo.create({ name: 'existing', yaml: 'x: 1\n' });
    vi.stubGlobal('fetch', vi.fn());
    await bootstrapProfiles({ repository: repo, indexUrl: 'https://example.test/profiles.yml' });
    vi.restoreAllMocks();

    const app = await buildApp(repo);
    try {
      // The stored profile is CPU-only (no NVENC/CUDA) -> runnable.
      const stored = await repo.get(LOUDNORM_PROFILE_NAME);
      expect(stored).toBeDefined();
      expect(isProfileRunnable(stored!.yaml)).toBe(true);

      // It appears in the runnable selectable picker.
      const list = await app.inject({ method: 'GET', url: '/api/v1/profiles' });
      expect(list.json().profiles).toContain(LOUDNORM_PROFILE_NAME);

      // It appears in the public Encore-facing index.yml (runnable-gated).
      const index = await app.inject({ method: 'GET', url: '/api/v1/profiles/index.yml' });
      expect(index.statusCode).toBe(200);
      expect(index.body).toContain(`${LOUDNORM_PROFILE_NAME}: ${LOUDNORM_PROFILE_NAME}/yaml`);

      // Its served YAML carries the parametrised single-pass loudnorm filter.
      const yaml = await app.inject({
        method: 'GET',
        url: `/api/v1/profiles/${LOUDNORM_PROFILE_NAME}/yaml`
      });
      expect(yaml.statusCode).toBe(200);
      expect(yaml.body).toContain(LOUDNORM_FILTER);
      expect(yaml.body).toContain('type: AudioEncode');
    } finally {
      await app.close();
    }
  });
});
