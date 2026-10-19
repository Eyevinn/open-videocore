// Regression test: the post-mutation profile-index republish must stay inside
// ONE stack scope (issue #1207 review, BLOCKING 1).
//
// The bug. `publishProfileIndexToObjectStore()` in src/main.ts resolved its
// object-store WRITE target with NO stack name (`stackResolver.resolve()`,
// which keys on `stackName ?? ''` — the workspace default stack,
// src/services/workspace-stack.ts `resolve(stackName?)`), while READING the
// profiles through the request-scoped `PerWorkspaceProfileRepository`, which
// resolves via `currentRequestStackName()` (src/data/per-workspace-repos.ts).
// The republish hook fires synchronously inside the mutation handler and is
// detached with `void`, so it INHERITS the request's AsyncLocalStorage store
// (src/services/request-stack-context.ts). A `PUT /api/v1/profiles/:name` sent
// with `X-Stack-Name: stack-b` therefore rendered STACK-B's profiles and wrote
// them into the DEFAULT stack's `openvideocore-profiles` bucket: it clobbered
// the index Encore fetches for the default stack and exposed another
// workspace's profile YAML under the anonymous-read policy of ADR-026 D3.
//
// The fix under test: `makeStackScopedProfileIndexPublisher`
// (src/services/profile-index-publisher.ts) takes the ONE stack name to publish
// for and resolves BOTH the write target and the profile list from it, and the
// router hook in src/main.ts passes `currentRequestStackName()` — the same key
// the mutation's own repository resolved on. These assertions fail against the
// pre-fix wiring (the bytes land in the default stack's bucket) and pass after.
//
// Contracts fetched before writing (CLAUDE.md rule 7):
//   - src/services/profile-index-publisher.ts — `makeStackScopedProfileIndexPublisher(
//     { resolveTarget, bucket?, log? }) => (stackName: string | undefined) =>
//     Promise<PublishOutcome>`; `ProfileIndexPublishTarget = { storageClient,
//     objectStoreEndpoint, listProfiles, resolveEndpoint? }`;
//     `ProfilesBucketClient = { bucketExists(bucket): Promise<boolean>;
//     putObject(bucket, object, stream, size?, metaData?): Promise<unknown>;
//     setBucketPolicy(bucket, policy): Promise<void> }` — itself a verbatim
//     subset of the minio v8.0.7 declarations in
//     node_modules/minio/dist/esm/internal/client.d.mts, as the module header
//     records; `PROFILES_BUCKET`, `PUBLISHED_INDEX_KEY`,
//     `publishedProfileObjectKey(name)`.
//   - src/routes/profiles.ts — `profilesRouter` options { repository,
//     bootstrapIndexUrl, onProfilesChanged?: () => void }; `POST /` body
//     { name, yaml } -> 201; `PUT /:name` body { yaml } -> 200.
//   - src/data/per-workspace-repos.ts — `PerWorkspaceProfileRepository.repo()`
//     = `(await resolver.resolve(currentRequestStackName())).profiles`.
//   - src/services/workspace-stack.ts — `resolve(stackName?)`: a name with a
//     stored config resolves to THAT stack, no name resolves to the workspace
//     default (first listed) stack.
//   - src/services/request-stack-context.ts — `requestStackNameFromHeaders`,
//     `runWithRequestedStack` (the `onRequest` hook in src/main.ts),
//     `currentRequestStackName`.

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
  runWithRequestedStack,
  currentRequestStackName
} from '../services/request-stack-context.js';
import {
  makeStackScopedProfileIndexPublisher,
  PROFILES_BUCKET,
  PUBLISHED_INDEX_KEY,
  publishedProfileObjectKey,
  type ProfilesBucketClient
} from '../services/profile-index-publisher.js';

const RUNNABLE_YAML = 'video:\n  - params:\n      pix_fmt: yuv420p\n      c:v: libx264\n';
const UPDATED_YAML = 'video:\n  - params:\n      pix_fmt: yuv420p\n      c:v: libx265\n';

const DEFAULT_STACK = 'stack-a';
const OTHER_STACK = 'stack-b';

// One stack's object store: records every write so a test can assert WHICH
// stack's bucket received the bytes. Implements exactly the three-call
// ProfilesBucketClient surface the publisher declares.
class RecordingBucket implements ProfilesBucketClient {
  readonly written = new Map<string, string>();
  readonly policies: string[] = [];
  async bucketExists(_bucketName: string): Promise<boolean> {
    return true;
  }
  async putObject(
    bucketName: string,
    objectName: string,
    stream: Buffer | string,
    _size?: number,
    _metaData?: Record<string, string>
  ): Promise<unknown> {
    this.written.set(
      `${bucketName}/${objectName}`,
      typeof stream === 'string' ? stream : stream.toString('utf8')
    );
    return {};
  }
  async setBucketPolicy(_bucketName: string, policy: string): Promise<void> {
    this.policies.push(policy);
  }
}

type Stack = { profiles: ProfileRepository; bucket: RecordingBucket; endpoint: string };

type World = {
  app: FastifyInstance;
  stacks: Map<string, Stack>;
  // Stack names the PUBLISHER resolved with, in order (undefined = default).
  publishedFor: (string | undefined)[];
  // Resolves once the detached republish of the in-flight mutation has settled.
  publishSettled: () => Promise<void>;
};

async function buildWorld(): Promise<World> {
  const stacks = new Map<string, Stack>([
    [
      DEFAULT_STACK,
      {
        profiles: new InMemoryProfileRepository(),
        bucket: new RecordingBucket(),
        endpoint: 'https://objects-a.example'
      }
    ],
    [
      OTHER_STACK,
      {
        profiles: new InMemoryProfileRepository(),
        bucket: new RecordingBucket(),
        endpoint: 'https://objects-b.example'
      }
    ]
  ]);

  // Reproduces the two resolution semantics of WorkspaceStackResolver.resolve():
  // a known name resolves to THAT stack, no name (or an unknown name) resolves
  // to the workspace default.
  const resolve = async (stackName?: string): Promise<Stack> =>
    stacks.get(stackName && stacks.has(stackName) ? stackName : DEFAULT_STACK)!;
  const resolver = {
    async resolve(stackName?: string) {
      return { profiles: (await resolve(stackName)).profiles };
    }
  } as unknown as WorkspaceStackResolver;

  const publishedFor: (string | undefined)[] = [];
  // The PRODUCTION publisher, wired the way src/main.ts wires it: one stack
  // name feeds both the write target and the profile list.
  const publish = makeStackScopedProfileIndexPublisher({
    resolveTarget: async (stackName) => {
      publishedFor.push(stackName);
      const stack = await resolve(stackName);
      return {
        storageClient: stack.bucket,
        objectStoreEndpoint: stack.endpoint,
        listProfiles: () => stack.profiles.list()
      };
    }
  });

  // The hook is fire-and-forget in production; the test needs to await the
  // detached work, so each notification's promise is kept here.
  let inFlight: Promise<unknown> = Promise.resolve();

  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // The production stack hook (src/main.ts): the untrusted X-Stack-Name header
  // becomes the ambient ROUTING stack for the request, and the detached
  // republish below inherits that AsyncLocalStorage store — which is exactly
  // what made the two-scope mix possible.
  app.addHook('onRequest', (request, _reply, done) => {
    runWithRequestedStack(requestStackNameFromHeaders(request.headers), done);
  });
  await app.register(profilesRouter, {
    prefix: '/api/v1/profiles',
    repository: new PerWorkspaceProfileRepository(resolver),
    bootstrapIndexUrl: 'https://example.invalid/profiles/index.yml',
    // Verbatim the wiring in src/main.ts: capture the mutated stack
    // synchronously, pass it explicitly into the detached publish.
    onProfilesChanged: () => {
      const mutatedStackName = currentRequestStackName();
      inFlight = publish(mutatedStackName);
    }
  });
  await app.ready();

  return {
    app,
    stacks,
    publishedFor,
    publishSettled: async () => {
      await inFlight;
    }
  };
}

describe('profile index republish stays in one stack scope (issue #1207 review, BLOCKING 1)', () => {
  let world: World;

  beforeEach(async () => {
    world = await buildWorld();
  });

  it('publishes a non-default stack\'s mutation into THAT stack\'s bucket, not the default stack\'s', async () => {
    // A mutation routed to the NON-DEFAULT stack, exactly as a client sends it.
    // runWithRequestedStack is applied by the onRequest hook above from this
    // header, so the handler and the detached republish both run inside it.
    const created = await world.app.inject({
      method: 'POST',
      url: '/api/v1/profiles/',
      headers: { 'x-stack-name': OTHER_STACK },
      payload: { name: 'sdrerun', yaml: RUNNABLE_YAML }
    });
    expect(created.statusCode).toBe(201);
    await world.publishSettled();

    // The profile really landed on the non-default stack only.
    expect(await world.stacks.get(OTHER_STACK)!.profiles.get('sdrerun')).toBeDefined();
    expect(await world.stacks.get(DEFAULT_STACK)!.profiles.get('sdrerun')).toBeUndefined();

    // The publish was scoped to the mutated stack...
    expect(world.publishedFor).toEqual([OTHER_STACK]);

    // ...and the bytes went into THAT stack's bucket: index plus the per-profile
    // document.
    const otherWrites = world.stacks.get(OTHER_STACK)!.bucket.written;
    expect(otherWrites.get(`${PROFILES_BUCKET}/${PUBLISHED_INDEX_KEY}`)).toBe(
      `sdrerun: ${publishedProfileObjectKey('sdrerun')}\n`
    );
    expect(
      otherWrites.get(`${PROFILES_BUCKET}/${publishedProfileObjectKey('sdrerun')}`)
    ).toBe(RUNNABLE_YAML);

    // The DEFAULT stack's bucket was not touched at all. Before the fix it
    // received stack-b's index here — clobbering the index that stack's Encore
    // fetches and exposing another workspace's profile YAML under the
    // anonymous-read policy (ADR-026 D3).
    expect([...world.stacks.get(DEFAULT_STACK)!.bucket.written.keys()]).toEqual([]);
  });

  it('keeps an update on the non-default stack out of the default stack\'s bucket', async () => {
    // Seed one profile per stack directly, so both stores are non-empty and a
    // cross-scope publish would be visible as the WRONG profile set.
    await world.stacks
      .get(DEFAULT_STACK)!
      .profiles.create({ name: 'defaultonly', yaml: RUNNABLE_YAML });
    await world.stacks
      .get(OTHER_STACK)!
      .profiles.create({ name: 'otheronly', yaml: RUNNABLE_YAML });

    const updated = await world.app.inject({
      method: 'PUT',
      url: '/api/v1/profiles/otheronly',
      headers: { 'x-stack-name': OTHER_STACK },
      payload: { yaml: UPDATED_YAML }
    });
    expect(updated.statusCode).toBe(200);
    await world.publishSettled();

    // The index written for stack-b lists stack-b's profile set only...
    const otherIndex = world.stacks
      .get(OTHER_STACK)!
      .bucket.written.get(`${PROFILES_BUCKET}/${PUBLISHED_INDEX_KEY}`);
    expect(otherIndex).toBe(`otheronly: ${publishedProfileObjectKey('otheronly')}\n`);
    expect(
      world.stacks
        .get(OTHER_STACK)!
        .bucket.written.get(`${PROFILES_BUCKET}/${publishedProfileObjectKey('otheronly')}`)
    ).toBe(UPDATED_YAML);

    // ...and the default stack's bucket still holds nothing: its own index is
    // only ever rewritten by a publish scoped to it.
    expect([...world.stacks.get(DEFAULT_STACK)!.bucket.written.keys()]).toEqual([]);
  });

  it('publishes the DEFAULT stack when the mutation names no stack', async () => {
    const created = await world.app.inject({
      method: 'POST',
      url: '/api/v1/profiles/',
      payload: { name: 'plain', yaml: RUNNABLE_YAML }
    });
    expect(created.statusCode).toBe(201);
    await world.publishSettled();

    expect(world.publishedFor).toEqual([undefined]);
    expect(
      world.stacks
        .get(DEFAULT_STACK)!
        .bucket.written.get(`${PROFILES_BUCKET}/${PUBLISHED_INDEX_KEY}`)
    ).toBe(`plain: ${publishedProfileObjectKey('plain')}\n`);
    expect([...world.stacks.get(OTHER_STACK)!.bucket.written.keys()]).toEqual([]);
  });
});
