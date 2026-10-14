// Regression tests: a profile created on a NON-FIRST stack must be resolvable
// by that stack's own Encore (issue #1164).
//
// The bug. The profile store is per stack, and the router's repository is the
// PerWorkspaceProfileRepository, which resolves the stack of the in-flight
// request and falls back to the FIRST listed stack when the request named none
// (src/data/per-workspace-repos.ts:362-366 -> src/services/workspace-stack.ts
// `resolve()`, no-stackName branch). An API caller names its stack with
// `X-Stack-Name`, so `POST /api/v1/profiles/` landed on the right stack and that
// stack's `GET /api/v1/profiles/` listed it. But a scaler-spawned Encore
// instance fetches its `profilesUrl` with a plain, header-less, tokenless GET
// (src/encore-scaler/instance-pool.ts:604-608), so EVERY stack's Encore read the
// FIRST listed stack's index — and a transcode on the non-first stack failed
// with "Could not find location for profile <name>!" while the same profile
// worked as soon as it was also created on the first-listed stack.
//
// The fix under test: the stack travels in the index URL
// (`/api/v1/profiles/stacks/:stack/index.yml`, with relative per-profile entries
// resolving onto the same prefix), and the scaler hands each stack's loop its
// own scoped URL. These tests FAIL before the fix (the stack-scoped routes do
// not exist: 404, and the URL is not rewritten per stack) and PASS after it.
//
// Contracts fetched before writing (CLAUDE.md rule 7):
//   - src/routes/profiles.ts — `profilesRouter` options { repository,
//     bootstrapIndexUrl }; `GET /index.yml` (200, `text/yaml; charset=utf-8`,
//     `x-profile-count`, `{name}: {name}/yaml` lines, `{}\n` when empty);
//     `GET /stacks/:stack/index.yml`; `GET /stacks/:stack/:name/yaml`;
//     `POST /` body { name, yaml } -> 201.
//   - src/data/profile-repo.ts — `ProfileRepository` CRUD signatures and the
//     `Profile` shape { name, yaml, createdAt, updatedAt }.
//   - src/data/per-workspace-repos.ts:362-366 —
//     `PerWorkspaceProfileRepository.repo()` = `(await resolver.resolve(
//     currentRequestStackName())).profiles`.
//   - src/services/workspace-stack.ts:986-1010,1167 — `resolve(stackName?)`
//     caches on `stackName ?? ''` and a name with no stored config falls back to
//     the workspace default (first listed stack): the behaviour the fake
//     resolver below reproduces.
//   - src/services/request-stack-context.ts — `requestStackNameFromHeaders`,
//     `runWithRequestedStack` (the `onRequest` hook in src/main.ts:508-509).
//   - src/services/public-base-url.ts — `LOCAL_PROFILES_INDEX_PATH`,
//     `localProfilesIndexPathForStack`, `stackScopedProfilesIndexUrl`.

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { profilesRouter } from './profiles.js';
import { PerWorkspaceProfileRepository } from '../data/per-workspace-repos.js';
import { InMemoryProfileRepository } from '../data/inmemory-profile-repo.js';
import type { ProfileRepository } from '../data/profile-repo.js';
import type { WorkspaceStackResolver } from '../services/workspace-stack.js';
import {
  requestStackNameFromHeaders,
  runWithRequestedStack
} from '../services/request-stack-context.js';
import {
  LOCAL_PROFILES_INDEX_PATH,
  localProfilesIndexPathForStack,
  stackScopedProfilesIndexUrl
} from '../services/public-base-url.js';
import { isProfilesIndexUrl } from '../encore-scaler/retry-policy.js';

// A runnable profile YAML (isProfileRunnable excludes GPU-only NVENC/CUDA
// profiles from the Encore-facing index — issue #286), so a profile seeded here
// is expected in index.yml.
const RUNNABLE_YAML = 'video:\n  - params:\n      pix_fmt: yuv420p\n      c:v: libx264\n';

// The stack listing of a two-stack install, in listing order. `stack-two` is the
// NON-FIRST stack the issue is about.
const FIRST_STACK = 'stack-one';
const SECOND_STACK = 'stack-two';

type World = {
  app: FastifyInstance;
  stores: Map<string, ProfileRepository>;
  // Every stack name `resolve()` was called with, in order (undefined = "the
  // request named none"), so a test can assert WHICH store a request reached.
  resolvedWith: (string | undefined)[];
};

// A stand-in for WorkspaceStackResolver that reproduces the two resolution
// semantics this bug lives in (src/services/workspace-stack.ts): a name with a
// stored config resolves to THAT stack verbatim, and no name — or a name with no
// stored config — resolves to the FIRST listed stack.
async function buildWorld(): Promise<World> {
  const stores = new Map<string, ProfileRepository>([
    [FIRST_STACK, new InMemoryProfileRepository()],
    [SECOND_STACK, new InMemoryProfileRepository()]
  ]);
  const resolvedWith: (string | undefined)[] = [];

  const resolver = {
    async resolve(stackName?: string) {
      resolvedWith.push(stackName);
      const name = stackName && stores.has(stackName) ? stackName : FIRST_STACK;
      return { profiles: stores.get(name)! };
    }
  } as unknown as WorkspaceStackResolver;

  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // The production stack hook (src/main.ts:508-509): the untrusted X-Stack-Name
  // header becomes the ambient ROUTING stack for the request.
  app.addHook('onRequest', (request, _reply, done) => {
    runWithRequestedStack(requestStackNameFromHeaders(request.headers), done);
  });
  await app.register(profilesRouter, {
    prefix: '/api/v1/profiles',
    repository: new PerWorkspaceProfileRepository(resolver),
    bootstrapIndexUrl: 'https://example.invalid/profiles/index.yml'
  });
  await app.ready();
  return { app, stores, resolvedWith };
}

// Parse an Encore-format index body into the mapping Encore itself builds.
function parseIndex(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '{}' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf(':');
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
}

describe('profiles are resolved per stack, whatever the listing position (issue #1164)', () => {
  let world: World;

  beforeEach(async () => {
    world = await buildWorld();
  });

  it('serves a profile created on the NON-FIRST stack from that stack\'s own index', async () => {
    // 1. Create the profile exactly as the reporter did: POST with X-Stack-Name
    //    set to the stack that is NOT first in the listing.
    const created = await world.app.inject({
      method: 'POST',
      url: '/api/v1/profiles/',
      headers: { 'x-stack-name': SECOND_STACK },
      payload: { name: 'sdrerun', yaml: RUNNABLE_YAML }
    });
    expect(created.statusCode).toBe(201);
    // It really landed on the non-first stack's store, and only there.
    expect(await world.stores.get(SECOND_STACK)!.get('sdrerun')).toBeDefined();
    expect(await world.stores.get(FIRST_STACK)!.get('sdrerun')).toBeUndefined();

    // 2. The non-first stack's Encore fetches ITS index — a header-less,
    //    tokenless GET, which is all a spawned instance can issue. The profile
    //    MUST be there; before the fix this URL did not exist at all.
    const index = await world.app.inject({
      method: 'GET',
      url: `/api/v1/profiles/stacks/${SECOND_STACK}/index.yml`
    });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toBe('text/yaml; charset=utf-8');
    const entries = parseIndex(index.body);
    expect(Object.keys(entries)).toContain('sdrerun');
    // The fixed #460 header contract holds on the scoped route too.
    expect(index.headers['x-profile-count']).toBe(String(Object.keys(entries).length));

    // 3. Encore then resolves the index entry as a RELATIVE reference against
    //    the index URL. Doing that resolution here proves the per-profile fetch
    //    stays on the SAME stack rather than falling back to the first one.
    const indexUrl = new URL(
      `https://api.example${localProfilesIndexPathForStack(SECOND_STACK)}`
    );
    const yamlUrl = new URL(entries['sdrerun']!, indexUrl);
    expect(yamlUrl.pathname).toBe(
      `/api/v1/profiles/stacks/${SECOND_STACK}/sdrerun/yaml`
    );
    const yaml = await world.app.inject({ method: 'GET', url: yamlUrl.pathname });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.headers['content-type']).toBe('text/yaml; charset=utf-8');
    expect(yaml.body).toBe(RUNNABLE_YAML);
  });

  it('does not leak the non-first stack\'s profile into another stack\'s index', async () => {
    await world.app.inject({
      method: 'POST',
      url: '/api/v1/profiles/',
      headers: { 'x-stack-name': SECOND_STACK },
      payload: { name: 'sdrerun', yaml: RUNNABLE_YAML }
    });

    // The FIRST stack's scoped index must not list it: the stacks have separate
    // profile stores, and the fix must not merge them.
    const firstIndex = await world.app.inject({
      method: 'GET',
      url: `/api/v1/profiles/stacks/${FIRST_STACK}/index.yml`
    });
    expect(firstIndex.statusCode).toBe(200);
    expect(Object.keys(parseIndex(firstIndex.body))).not.toContain('sdrerun');
    // An empty store still answers with a valid YAML mapping (#459/#461).
    expect(firstIndex.body).toBe('{}\n');
    expect(firstIndex.headers['x-profile-count']).toBe('0');

    // And the per-profile document is 404 on the stack that does not hold it,
    // rather than silently served from the first-listed stack's store.
    const crossStack = await world.app.inject({
      method: 'GET',
      url: `/api/v1/profiles/stacks/${FIRST_STACK}/sdrerun/yaml`
    });
    expect(crossStack.statusCode).toBe(404);
  });

  it('resolves the scoped routes against the stack NAMED IN THE PATH, with no header', async () => {
    await world.app.inject({
      method: 'POST',
      url: '/api/v1/profiles/',
      headers: { 'x-stack-name': SECOND_STACK },
      payload: { name: 'sdrerun', yaml: RUNNABLE_YAML }
    });
    world.resolvedWith.length = 0;

    await world.app.inject({
      method: 'GET',
      url: `/api/v1/profiles/stacks/${SECOND_STACK}/index.yml`
    });
    // The repository resolved the stack from the path — not `undefined`, which
    // is what produced the first-listed-stack read this issue is about.
    expect(world.resolvedWith).toEqual([SECOND_STACK]);
  });

  it('keeps the unscoped index unchanged for a caller that names its stack by header', async () => {
    await world.app.inject({
      method: 'POST',
      url: '/api/v1/profiles/',
      headers: { 'x-stack-name': SECOND_STACK },
      payload: { name: 'sdrerun', yaml: RUNNABLE_YAML }
    });
    const index = await world.app.inject({
      method: 'GET',
      url: '/api/v1/profiles/index.yml',
      headers: { 'x-stack-name': SECOND_STACK }
    });
    expect(index.statusCode).toBe(200);
    expect(parseIndex(index.body)['sdrerun']).toBe('sdrerun/yaml');
  });

  it('rejects a path segment that cannot name a stack instead of serving a default', async () => {
    const res = await world.app.inject({
      method: 'GET',
      url: '/api/v1/profiles/stacks/Not a Stack/index.yml'
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_stack_name' });
  });

  it('still routes the unscoped per-profile document for a profile named "stacks"', async () => {
    // The scoped routes add a `stacks` path segment under the same prefix the
    // `/:name/yaml` route lives on, and `stacks` is a legal profile name
    // (isValidProfileName). Guard the router against shadowing it.
    const created = await world.app.inject({
      method: 'POST',
      url: '/api/v1/profiles/',
      headers: { 'x-stack-name': SECOND_STACK },
      payload: { name: 'stacks', yaml: RUNNABLE_YAML }
    });
    expect(created.statusCode).toBe(201);
    const yaml = await world.app.inject({
      method: 'GET',
      url: '/api/v1/profiles/stacks/yaml',
      headers: { 'x-stack-name': SECOND_STACK }
    });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.body).toBe(RUNNABLE_YAML);
  });
});

describe('stackScopedProfilesIndexUrl (issue #1164)', () => {
  const base = 'https://api.example';

  it('rewrites this app\'s own index URL to the stack-scoped form', () => {
    expect(
      stackScopedProfilesIndexUrl(`${base}${LOCAL_PROFILES_INDEX_PATH}`, SECOND_STACK)
    ).toBe(`${base}${localProfilesIndexPathForStack(SECOND_STACK)}`);
  });

  it('gives each stack a DIFFERENT URL, so no stack reads another stack\'s index', () => {
    const url = `${base}${LOCAL_PROFILES_INDEX_PATH}`;
    expect(stackScopedProfilesIndexUrl(url, FIRST_STACK)).not.toBe(
      stackScopedProfilesIndexUrl(url, SECOND_STACK)
    );
  });

  it('preserves an ingress path prefix ahead of the index path', () => {
    expect(
      stackScopedProfilesIndexUrl(
        `${base}/videocore${LOCAL_PROFILES_INDEX_PATH}`,
        SECOND_STACK
      )
    ).toBe(`${base}/videocore${localProfilesIndexPathForStack(SECOND_STACK)}`);
  });

  it('leaves an EXTERNAL index untouched — it has no per-stack form', () => {
    const remote = 'https://testcontent.example/encore/profiles.yml';
    expect(stackScopedProfilesIndexUrl(remote, SECOND_STACK)).toBe(remote);
    const bucket = 'https://minio.example/openvideocore-profiles/index.yml';
    expect(stackScopedProfilesIndexUrl(bucket, SECOND_STACK)).toBe(bucket);
  });

  it('stays classifiable as the profiles index by the retry policy (#1101)', () => {
    // The #1101 rule — a 401/403 on the unauthenticated profiles index is an
    // infrastructure verdict and therefore retryable — must keep applying now
    // that Encore is pointed at the stack-scoped URL.
    expect(
      isProfilesIndexUrl(
        stackScopedProfilesIndexUrl(`${base}${LOCAL_PROFILES_INDEX_PATH}`, SECOND_STACK)
      )
    ).toBe(true);
    expect(
      isProfilesIndexUrl(`.../api/v1/profiles/stacks/${SECOND_STACK}/index.yml`)
    ).toBe(true);
    // A per-profile document on a scoped prefix is still NOT the index.
    expect(
      isProfilesIndexUrl(`${base}/api/v1/profiles/stacks/${SECOND_STACK}/sdrerun/yaml`)
    ).toBe(false);
  });

  it('leaves the URL unscoped for a key that cannot name a stack', () => {
    const url = `${base}${LOCAL_PROFILES_INDEX_PATH}`;
    // A single-stack env-override deployment keys its loop on a fixed deployment
    // context, not a stack name: it must keep the process-global URL.
    expect(stackScopedProfilesIndexUrl(url, 'deployment_context')).toBe(url);
    expect(stackScopedProfilesIndexUrl(url, undefined)).toBe(url);
    expect(stackScopedProfilesIndexUrl(url, '')).toBe(url);
  });
});
