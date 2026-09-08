// Route-level fail-fast on an unreachable stack dependency (#616).
//
// When the transcode submit path's queue (Valkey) is unreachable, the request
// must NOT hang to the ~50s socket-drop boundary. It must return a prompt,
// definite 504 whose machine-readable body NAMES the failing dependency and its
// endpoint, and the failure must be logged server-side.
//
// This drives a real HTTP request through the encore-compat router with an
// EncoreClient whose submit() throws the structured DependencyUnreachableError
// the scaling client raises when a bounded Valkey write times out (see
// src/encore-scaler/index.ts + dependency-timeout.ts). It asserts the route maps
// that error to 504 with the named body, and that request.log.error was called.
//
// Contract sources cited before writing:
//   - encoreCompatRouter options + POST /encoreJobs mapping: src/routes/encore-compat.ts.
//   - DependencyUnreachableError.toResponseBody(): src/encore-scaler/dependency-timeout.ts.
//   - EncoreClient interface: src/pipeline/encore-client.ts.

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { encoreCompatRouter } from './encore-compat.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryJobRepository } from '../data/job-repo.js';
import type { EncoreClient } from '../pipeline/encore-client.js';
import { DependencyUnreachableError } from '../encore-scaler/dependency-timeout.js';

function unreachableQueueEncore(): EncoreClient {
  return {
    async submit() {
      throw new DependencyUnreachableError({
        dependency: 'queue',
        endpoint: 'redis://valkey.internal:6379',
        stackName: 'default',
        operation: 'lpush encore:queue:default',
        reason: 'timeout',
        timeoutMs: 5000
      });
    },
    async getJobStatus() {
      return undefined;
    },
    async cancel() {
      /* no-op */
    }
  };
}

async function buildApp(): Promise<{ app: FastifyInstance; errorLogs: unknown[] }> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const errorLogs: unknown[] = [];
  app.addHook('onRequest', async (req) => {
    // Capture server-side error logs without a real transport.
    req.log.error = ((obj: unknown) => {
      errorLogs.push(obj);
    }) as typeof req.log.error;
  });

  await app.register(encoreCompatRouter, {
    prefix: '/api/v1/encore',
    repository: new InMemoryAssetRepository(),
    jobRepository: new InMemoryJobRepository(),
    encore: unreachableQueueEncore(),
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket'
  });
  await app.ready();
  return { app, errorLogs };
}

describe('encore-compat submit fails fast on unreachable dependency (#616)', () => {
  it('returns a prompt 504 naming the failing dependency and endpoint', async () => {
    const { app, errorLogs } = await buildApp();

    const start = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/encore/encoreJobs',
      payload: {
        externalId: 'client-ext-1',
        inputs: [{ uri: 's3://src-bucket/ingest/my-video.mp4' }],
        outputFolder: 's3://out-bucket/renditions',
        profile: { name: 'program' }
      }
    });
    const elapsed = Date.now() - start;

    // Definite status, well inside the ~50s socket-drop window.
    expect(res.statusCode).toBe(504);
    expect(elapsed).toBeLessThan(5000);

    // Machine-readable body names the dependency + endpoint (credentials stripped).
    const body = res.json();
    expect(body.error).toBe('dependency_unreachable');
    expect(body.dependency).toBe('queue');
    expect(body.endpoint).toBe('redis://valkey.internal:6379');
    expect(body.message).toMatch(/queue/);

    // The failure was logged server-side with diagnostic detail.
    expect(errorLogs.length).toBeGreaterThan(0);
    const logged = errorLogs[0] as Record<string, unknown>;
    expect(logged.dependency).toBe('queue');
    expect(logged.endpoint).toBe('redis://valkey.internal:6379');
    expect(logged.reason).toBe('timeout');
  });
});
