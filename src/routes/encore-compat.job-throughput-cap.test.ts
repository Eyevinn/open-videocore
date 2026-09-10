// Route-level cap-exceeded error surface for the job-throughput cap (#580).
//
// When the operator-configured job-throughput cap is exceeded, the transcode
// submit path (EncoreClient.submit) throws JobThroughputCapExceededError. The
// encore-compat POST /encoreJobs route must map that to the documented
// machine-readable 429 with reason code `job_throughput_cap_exceeded`, rather
// than silently queueing or returning a generic 502.
//
// This drives a real HTTP request through the encore-compat router with an
// EncoreClient whose submit() throws the cap error, and asserts the 429 surface.
// An opt-in (no-cap) control confirms behaviour is unchanged when submit()
// succeeds.
//
// Contract sources cited before writing:
//   - encoreCompatRouter options + POST /encoreJobs cap mapping: src/routes/encore-compat.ts.
//   - JobThroughputCapExceededError.toResponseBody()/statusCode: src/encore-scaler/job-throughput-cap.ts.
//   - EncoreClient interface: src/pipeline/encore-client.ts.

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { encoreCompatRouter } from './encore-compat.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryJobRepository } from '../data/job-repo.js';
import type { EncoreClient } from '../pipeline/encore-client.js';
import { JobThroughputCapExceededError } from '../encore-scaler/job-throughput-cap.js';

function capExceededEncore(): EncoreClient {
  return {
    async submit() {
      // 5 outstanding, cap 5 => over the ceiling.
      throw new JobThroughputCapExceededError(5, 5);
    },
    async getJobStatus() {
      return undefined;
    },
    async cancel() {
      /* no-op */
    }
  };
}

function acceptingEncore(): EncoreClient {
  return {
    async submit(input) {
      return { encoreInternalId: input.externalId };
    },
    async getJobStatus() {
      return undefined;
    },
    async cancel() {
      /* no-op */
    }
  };
}

async function buildApp(encore: EncoreClient): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(encoreCompatRouter, {
    prefix: '/api/v1/encore',
    repository: new InMemoryAssetRepository(),
    jobRepository: new InMemoryJobRepository(),
    encore,
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket'
  });
  await app.ready();
  return app;
}

const submitPayload = {
  externalId: 'client-ext-1',
  inputs: [{ uri: 's3://src-bucket/ingest/my-video.mp4' }],
  outputFolder: 's3://out-bucket/renditions',
  profile: { name: 'program' }
};

describe('encore-compat submit returns 429 on job-throughput cap exceeded (#580)', () => {
  it('maps the cap error to a 429 with the documented reason code', async () => {
    const app = await buildApp(capExceededEncore());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/encore/encoreJobs',
      payload: submitPayload
    });

    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.error).toBe('job_throughput_cap_exceeded');
    expect(body.cap).toBe(5);
    expect(body.outstanding).toBe(5);
    expect(body.message).toMatch(/cap/i);
  });

  it('no cap (submit succeeds) => unchanged behaviour, job accepted as QUEUED', async () => {
    const app = await buildApp(acceptingEncore());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/encore/encoreJobs',
      payload: submitPayload
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('QUEUED');
  });
});
