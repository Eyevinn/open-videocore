// Regression tests for GET /api/v1/profiles/index.yml (issue #461).
//
// These guard the empty-store fix from issue #459: when the profile store is
// empty, the Encore-facing index MUST be a valid, non-empty YAML mapping body
// (`{}\n`) — NOT a zero-byte response. A zero-byte body makes the downstream
// engine's strict YAML load (SnakeYAML `Yaml.load`, used by the Encore instances
// the scaler spawns to read the profile index) fail with:
//   "No content to map due to end-of-input"
// The tests here FAIL against that old zero-byte behaviour and PASS with the
// empty-mapping fix present on this branch.
//
// Harness: patterned after src/routes/encore-compat.test.ts — build a bare
// Fastify instance with the zod validator/serializer compilers, register the
// router under test with a mocked repository, drive real HTTP through
// app.inject(), and assert on the raw response.
//
// Contracts fetched before writing (CLAUDE.md rule 7):
//   - src/routes/profiles.ts (GET /index.yml handler, lines 131-158): 200,
//     `content-type: text/yaml; charset=utf-8`, `{name}: {name}/yaml` lines
//     sorted by localeCompare joined with '\n' + trailing '\n', and `{}\n` on
//     an empty list.
//   - src/data/profile-repo.ts: ProfileRepository interface and Profile shape
//     ({ name, yaml, createdAt, updatedAt }).
//
// YAML parser: the repo declares NO YAML library as a dependency (package.json)
// and imports none anywhere in src/. Rather than pull in a new external
// dependency (forbidden by the task + CLAUDE.md), the contract-parseability
// assertion uses a tiny local strict-mapping loader (loadStrictYamlMapping)
// that reproduces the ONE downstream semantic under test: content-free input
// (empty / whitespace / comment-only) throws "No content to map", exactly as
// SnakeYAML's `Yaml.load` does, while a real mapping (`{}` or `k: v` lines)
// loads to an object. This keeps the suite dependency-free with no new external
// service dependency.

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { profilesRouter } from './profiles.js';
import type { Profile, ProfileRepository } from '../data/profile-repo.js';

// A mocked ProfileRepository whose `list()` returns a fixed set of profiles.
// Only `list()` is exercised by the index.yml handler; the rest satisfy the
// interface and throw if unexpectedly called.
function mockRepo(profiles: Profile[]): ProfileRepository {
  return {
    async list() {
      return profiles.map((p) => ({ ...p }));
    },
    async create() {
      throw new Error('not implemented in mock');
    },
    async get() {
      throw new Error('not implemented in mock');
    },
    async update() {
      throw new Error('not implemented in mock');
    },
    async delete() {
      throw new Error('not implemented in mock');
    },
    async count() {
      return profiles.length;
    }
  };
}

function profile(name: string, yaml = `# ${name}\nvideo:\n  - params:\n      pix_fmt: yuv420p\n`): Profile {
  return {
    name,
    yaml,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

async function buildApp(profiles: Profile[]): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(profilesRouter, {
    prefix: '/api/v1/profiles',
    repository: mockRepo(profiles),
    bootstrapIndexUrl: 'https://example.invalid/profiles/index.yml'
  });
  await app.ready();
  return app;
}

// Minimal strict block-mapping loader mirroring the ONE semantic the downstream
// engine (SnakeYAML `Yaml.load`, used by Encore to read the profile index)
// enforces: content-free input has nothing to map and MUST throw. A body that
// carries a mapping — the explicit empty flow mapping `{}` or `key: value`
// block lines — loads to a plain object. Anything else is out of scope for this
// index format and is rejected rather than silently accepted.
function loadStrictYamlMapping(source: string): Record<string, string> {
  const meaningfulLines = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (meaningfulLines.length === 0) {
    // SnakeYAML: "No content to map due to end-of-input".
    throw new Error('No content to map due to end-of-input');
  }

  const result: Record<string, string> = {};
  if (meaningfulLines.length === 1 && meaningfulLines[0] === '{}') {
    return result; // explicit empty mapping -> zero entries
  }
  for (const line of meaningfulLines) {
    const idx = line.indexOf(':');
    if (idx <= 0) {
      throw new Error(`not a mapping entry: ${line}`);
    }
    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

describe('GET /api/v1/profiles/index.yml empty-store regression (issue #461)', () => {
  it('empty store returns 200 text/yaml with a non-empty body that parses as a zero-entry YAML mapping', async () => {
    const app = await buildApp([]);

    const res = await app.inject({ method: 'GET', url: '/api/v1/profiles/index.yml' });

    expect(res.statusCode).toBe(200);
    // Non-zero-length body — the whole point of the #459 fix (zero-byte would
    // break the downstream strict load).
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.headers['content-type']).toBe('text/yaml; charset=utf-8');

    const parsed = loadStrictYamlMapping(res.body);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed)).toHaveLength(0);

    await app.close();
  });

  it('populated store keeps the "{name}: {name}/yaml" line format, localeCompare sort, and trailing newline', async () => {
    // Deliberately out of sort order on input so the handler's sort is observed.
    const app = await buildApp([profile('program'), profile('archive'), profile('program-x265')]);

    const res = await app.inject({ method: 'GET', url: '/api/v1/profiles/index.yml' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/yaml; charset=utf-8');
    // Exact body: sorted by localeCompare, each line `name: name/yaml`, single
    // trailing newline. Guards the populated path against regression.
    expect(res.body).toBe('archive: archive/yaml\nprogram: program/yaml\nprogram-x265: program-x265/yaml\n');

    // And it round-trips through the strict loader to the expected mapping.
    const parsed = loadStrictYamlMapping(res.body);
    expect(parsed).toEqual({
      archive: 'archive/yaml',
      program: 'program/yaml',
      'program-x265': 'program-x265/yaml'
    });

    await app.close();
  });

  it('contract: the empty-store body does NOT throw "No content to map" under a strict YAML load', async () => {
    const app = await buildApp([]);

    const res = await app.inject({ method: 'GET', url: '/api/v1/profiles/index.yml' });
    expect(res.statusCode).toBe(200);

    // The regression guard: a zero-byte body throws here; `{}\n` does not.
    expect(() => loadStrictYamlMapping(res.body)).not.toThrow();
    // And a genuine empty/zero-byte body still demonstrates the failure mode we
    // are protecting against, proving the assertion above is load-bearing.
    expect(() => loadStrictYamlMapping('')).toThrow('No content to map');

    await app.close();
  });
});
