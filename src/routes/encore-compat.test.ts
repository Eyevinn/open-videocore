// Encore-compat router tests (issue #289).
//
// The Encore-compat router lets an integrator POST the native Encore job shape
// to /api/v1/encore/encoreJobs and have it translated into an open-videocore
// transcode submission. Issue #289: a compat request carrying a top-level
// `profileParams` map must reach Encore's job document intact (parity with the
// native /:id/transcode route), and a request WITHOUT the field must be
// unaffected (Encore keeps its `{}` default).
//
// We drive real HTTP requests through the router with a fake EncoreClient and
// assert on the EncoreSubmitInput it received — which toEncorePayload writes
// verbatim into the Encore job document's top-level `profileParams` key
// (src/pipeline/encore-client.ts:92, covered by encore-client.test.ts).

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { encoreCompatRouter } from './encore-compat.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryJobRepository } from '../data/job-repo.js';
import type { EncoreClient, EncoreSubmitInput } from '../pipeline/encore-client.js';

type Harness = {
  app: FastifyInstance;
  submitted: EncoreSubmitInput[];
};

function fakeEncore(): { client: EncoreClient; submitted: EncoreSubmitInput[] } {
  const submitted: EncoreSubmitInput[] = [];
  const client: EncoreClient = {
    async submit(input) {
      submitted.push(input);
      return { encoreInternalId: 'encore-internal-1' };
    },
    async getJobStatus() {
      return undefined;
    },
    async cancel() {
      /* no-op */
    }
  };
  return { client, submitted };
}

async function buildApp(): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const { client, submitted } = fakeEncore();

  await app.register(encoreCompatRouter, {
    prefix: '/api/v1/encore',
    repository: new InMemoryAssetRepository(),
    jobRepository: new InMemoryJobRepository(),
    encore: client,
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket'
  });
  await app.ready();
  return { app, submitted };
}

describe('Encore-compat router profileParams forwarding (issue #289)', () => {
  it('forwards a top-level profileParams map through to the Encore submit input', async () => {
    const h = await buildApp();
    const profileParams = { crf: '18', preset: 'slow', height: '720', keyframes: '48' };

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/encore/encoreJobs',
      payload: {
        externalId: 'client-ext-1',
        inputs: [{ uri: 's3://src-bucket/ingest/my-video.mp4' }],
        outputFolder: 's3://out-bucket/renditions',
        profile: { name: 'x264-crf-parametrized' },
        profileParams
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('QUEUED');

    // The compat request's profileParams reached Encore intact (verbatim map).
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0].profileParams).toEqual(profileParams);
  });

  it('leaves profileParams undefined when the compat request omits it', async () => {
    const h = await buildApp();

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/encore/encoreJobs',
      payload: {
        externalId: 'client-ext-2',
        inputs: [{ uri: 's3://src-bucket/ingest/plain.mp4' }],
        outputFolder: 's3://out-bucket/renditions',
        profile: { name: 'program' }
      }
    });

    expect(res.statusCode).toBe(200);
    expect(h.submitted).toHaveLength(1);
    // Omitted -> undefined so toEncorePayload drops the key and Encore keeps its
    // `{}` default (backward compatible; output unchanged).
    expect(h.submitted[0].profileParams).toBeUndefined();
  });

  it('rejects non-string profileParams values (flat string map contract)', async () => {
    const h = await buildApp();

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/encore/encoreJobs',
      payload: {
        inputs: [{ uri: 's3://src-bucket/ingest/x.mp4' }],
        outputFolder: 's3://out-bucket/renditions',
        // height is a number, not a string — violates Record<string,string>.
        profileParams: { height: 720 }
      }
    });

    expect(res.statusCode).toBe(400);
    expect(h.submitted).toHaveLength(0);
  });
});
