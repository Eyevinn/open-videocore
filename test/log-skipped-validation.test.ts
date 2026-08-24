// Logging a skipped profileParams validation at the transcode call site
// (issue #393).
//
// When the profile YAML cannot be resolved, validateProfileParams SKIPS the
// key check and the request succeeds permissively (issue #391). That silence
// hides two real problems: a mistyped profile name + mistyped param name gets
// no feedback, and a profile-store outage silently skips validation for its
// whole duration. Issue #393 adds ONE log line at the call site — no
// behavioural change — that names the profile and the unvalidated keys and
// distinguishes a store outage from an ordinary profile-not-found. This test
// asserts that log line is actually emitted (not merely that the branch keeps
// returning ok), for BOTH the not-found and store-unreachable cases, and that
// NO such line is emitted on a genuine validated pass.
//
// Harness note (isolation of the store-unreachable case): the transcode handler
// calls opts.profileRepository.get() TWICE — once via unrunnableProfileReason()
// (GPU-runnability check, issue #286) BEFORE the profileParams block, and once
// via resolveProfileYaml() INSIDE it. A profileRepository whose get() throws
// unconditionally would therefore blow up in the first call (an uncaught 500 —
// a known out-of-scope gap from #392) before the logging branch under test is
// ever reached. To keep the test isolated to #393's behaviour we OMIT the
// top-level `profile` field for the store-unreachable case: with no profile,
// unrunnableProfileReason(undefined) returns early WITHOUT calling get(), while
// the profileParams block defaults profileName to 'program' and calls get()
// there — which throws — producing exactly the store-unreachable path we want
// to exercise.

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
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
import type { Profile, ProfileRepository } from '../src/data/profile-repo.js';
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

// ---------------------------------------------------------------------------
// A capturing logger. Fastify's per-request \`request.log\` is a child of the
// instance logger; we make child() return the same collector so warn/info
// calls made on request.log are recorded here. Implements the FastifyBaseLogger
// surface (level + the seven level methods + child).
// ---------------------------------------------------------------------------
type LogRecord = { level: 'info' | 'warn'; obj: Record<string, unknown>; msg: string };

function capturingLogger(): { logger: FastifyBaseLogger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const record =
    (level: 'info' | 'warn') =>
    (obj?: unknown, msg?: unknown, ..._args: unknown[]): void => {
      // Match the structured-object-first, message-string call shape used at
      // the call site.
      if (obj && typeof obj === 'object') {
        records.push({ level, obj: obj as Record<string, unknown>, msg: String(msg ?? '') });
      } else {
        records.push({ level, obj: {}, msg: String(obj ?? '') });
      }
    };
  const noop = (): void => {};
  const logger: FastifyBaseLogger = {
    level: 'info',
    info: record('info') as FastifyBaseLogger['info'],
    warn: record('warn') as FastifyBaseLogger['warn'],
    error: noop as FastifyBaseLogger['error'],
    debug: noop as FastifyBaseLogger['debug'],
    fatal: noop as FastifyBaseLogger['fatal'],
    trace: noop as FastifyBaseLogger['trace'],
    silent: noop as FastifyBaseLogger['silent'],
    child() {
      return logger;
    }
  };
  return { logger, records };
}

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
  records: LogRecord[];
  submitted: EncoreSubmitInput[];
}> {
  const { logger, records } = capturingLogger();
  const app = Fastify({ loggerInstance: logger });
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
  return { app, assets, records, submitted };
}

async function makeSource(assets: InMemoryAssetRepository): Promise<string> {
  const asset = await assets.create({ name: 'my-video', objectKey: 'ingest/my-video' });
  return asset.id;
}

// Only the skipped-validation log lines this issue adds carry a `reason`.
function skippedLines(records: LogRecord[]): LogRecord[] {
  return records.filter((r) => 'reason' in r.obj);
}

describe('log skipped profileParams validation at transcode call site (issue #393)', () => {
  it('(a) profile-not-found -> ONE info line, reason profile-not-found, naming profile + unvalidated keys', async () => {
    // Store reachable, but the chosen profile is not in it -> not-found ->
    // validation skipped.
    const profiles = new InMemoryProfileRepository();
    const { app, assets, records, submitted } = await buildApp(profiles);
    const id = await makeSource(assets);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { authorization: 'Bearer token-a' },
      // Deliberately unsorted keys so we can assert the logged set is sorted.
      payload: { profile: 'not-in-store', profileParams: { zeta: '1', alpha: '2' } }
    });

    // Permissive behaviour unchanged: still accepted + submitted.
    expect(res.statusCode).toBe(202);
    expect(submitted).toHaveLength(1);

    const lines = skippedLines(records);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.level).toBe('info');
    expect(line.obj.reason).toBe('profile-not-found');
    expect(line.obj.profileName).toBe('not-in-store');
    expect(line.obj.unvalidatedKeys).toEqual(['alpha', 'zeta']);
    // profile-not-found is ordinary use -> no captured error attached.
    expect(line.obj.err).toBeUndefined();
    expect(line.msg).toMatch(/skipped/i);

    await app.close();
  });

  it('(b) store-unreachable -> ONE warn line, reason store-unreachable, carrying the captured error', async () => {
    // A profile store whose get() THROWS = an outage. We OMIT the top-level
    // `profile` field (see harness note) so the ONLY get() that runs is the one
    // inside the profileParams block, which then hits the store-unreachable
    // path we want to exercise.
    const outage = new Error('couch ECONNREFUSED');
    const throwingRepo: ProfileRepository = {
      async get(_name: string): Promise<Profile | undefined> {
        throw outage;
      },
      async create() {
        throw new Error('unused');
      },
      async list() {
        return [];
      },
      async update() {
        return undefined;
      },
      async delete() {
        /* unused */
      },
      async count() {
        return 0;
      }
    };
    const { app, assets, records, submitted } = await buildApp(throwingRepo);
    const id = await makeSource(assets);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { authorization: 'Bearer token-a' },
      // No `profile` field -> defaults to 'program' in the params block.
      payload: { profileParams: { crf: '20' } }
    });

    // Store outage must NOT turn a submit into a 500: still accepted +
    // submitted (permissive), and the outage is logged, not thrown.
    expect(res.statusCode).toBe(202);
    expect(submitted).toHaveLength(1);

    const lines = skippedLines(records);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.level).toBe('warn');
    expect(line.obj.reason).toBe('store-unreachable');
    expect(line.obj.profileName).toBe('program');
    expect(line.obj.unvalidatedKeys).toEqual(['crf']);
    // The captured resolution.error is attached as `err` so an operator can see
    // the underlying outage.
    expect(line.obj.err).toBe(outage);
    expect(line.msg).toMatch(/unreachable/i);

    await app.close();
  });

  it('(c) genuine validated pass -> NO skipped-validation line is emitted', async () => {
    const profiles = new InMemoryProfileRepository();
    await profiles.create({ name: 'x264-crf-parametrized', yaml: X264_CRF_PARAMETRIZED_YAML });
    const { app, assets, records, submitted } = await buildApp(profiles);
    const id = await makeSource(assets);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: { authorization: 'Bearer token-a' },
      // A declared key -> genuine validated pass.
      payload: { profile: 'x264-crf-parametrized', profileParams: { crf: '20' } }
    });

    expect(res.statusCode).toBe(202);
    expect(submitted).toHaveLength(1);
    expect(skippedLines(records)).toHaveLength(0);

    await app.close();
  });
});
