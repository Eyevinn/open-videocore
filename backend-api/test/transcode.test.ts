// ABR transcoding job management tests (issue #8).
//
// Covers:
//   - POST /api/v1/assets/:id/transcode submits a job to Encore and returns
//     { jobId, encoreJobId }
//   - default preset (1080p) and explicit preset selection (720p, 480p)
//   - a custom profile is forwarded to Encore verbatim
//   - the source asset advances to `processing` on submit
//   - GET /api/v1/jobs/:id observes the transcode job (jobType=transcode)
//   - POST /api/v1/internal/encore-callback marks the job done, creates one
//     READY child asset per rendition (parentId=source), and records the
//     renditions array on the source asset (which returns to `ready`)
//   - a failed callback marks the job failed and the source failed
//   - duplicate callbacks are idempotent (no duplicate children)
//   - unknown encoreJobId resolves to 404
//   - submit returns 409 when the asset has no stored object, 501 when Encore
//     is not configured, 502 when Encore rejects the submission

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = { 'token-a': 'workspace-a', 'token-b': 'workspace-b' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { jobsRouter } from '../src/routes/jobs.js';
import { internalRouter } from '../src/routes/internal.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import type { EncoreClient, EncoreSubmitInput } from '../src/pipeline/encore-client.js';

const A = { authorization: 'Bearer token-a' };

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  jobs: InMemoryJobRepository;
  submitted: EncoreSubmitInput[];
};

function fakeEncore(fail?: Error): { client: EncoreClient; submitted: EncoreSubmitInput[] } {
  const submitted: EncoreSubmitInput[] = [];
  const client: EncoreClient = {
    async submit(input) {
      if (fail) throw fail;
      submitted.push(input);
      return { encoreInternalId: 'encore-internal-1' };
    }
  };
  return { client, submitted };
}

async function buildApp(opts: { encoreFail?: Error; noEncore?: boolean } = {}): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const { client, submitted } = fakeEncore(opts.encoreFail);

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: jobs,
    encore: opts.noEncore ? undefined : client,
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket'
  });
  await app.register(jobsRouter, { prefix: '/api/v1/jobs', repository: jobs });
  await app.register(internalRouter, {
    prefix: '/api/v1/internal',
    jobRepository: jobs,
    repository: assets
  });
  await app.ready();
  return { app, assets, jobs, submitted };
}

// Create a source asset already carrying a stored object (ready to transcode).
async function makeSource(h: Harness, name = 'my-video'): Promise<string> {
  const asset = await h.assets.create('workspace-a', { name, objectKey: `ingest/${name}` });
  await h.assets.update('workspace-a', asset.id, { status: 'processing' });
  await h.assets.update('workspace-a', asset.id, { status: 'ready' });
  return asset.id;
}

describe('transcode job management (issue #8)', () => {
  describe('POST /:id/transcode', () => {
    it('submits to Encore with the default 1080p preset and returns ids', async () => {
      const h = await buildApp();
      const sourceId = await makeSource(h);

      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/assets/${sourceId}/transcode`,
        headers: A,
        payload: {}
      });
      expect(res.statusCode).toBe(202);
      const { jobId, encoreJobId } = res.json();
      expect(jobId).toBeTruthy();
      expect(encoreJobId).toContain('workspace-a');

      // Encore received the resolved 1080p ladder + s3 input/output URIs.
      expect(h.submitted).toHaveLength(1);
      expect(h.submitted[0].profile.name).toBe('program');
      expect(h.submitted[0].profile.outputs[0].label).toBe('1080p');
      expect(h.submitted[0].inputUri).toBe(`s3://src-bucket/ingest/my-video`);
      expect(h.submitted[0].outputUri).toContain('s3://out-bucket/');
      expect(h.submitted[0].externalId).toBe(encoreJobId);

      // Source asset advanced to processing.
      const src = await h.assets.get('workspace-a', sourceId);
      expect(src?.status).toBe('processing');
    });

    it('honours explicit preset selection (720p, 480p)', async () => {
      const h = await buildApp();
      const sourceId = await makeSource(h);

      for (const [preset, name] of [['720p', 'program'], ['480p', 'program']] as const) {
        h.submitted.length = 0;
        const res = await h.app.inject({
          method: 'POST',
          url: `/api/v1/assets/${sourceId}/transcode`,
          headers: A,
          payload: { profile: preset }
        });
        expect(res.statusCode).toBe(202);
        expect(h.submitted[0].profile.name).toBe(name);
      }
    });

    it('forwards a custom profile verbatim', async () => {
      const h = await buildApp();
      const sourceId = await makeSource(h);
      const customProfile = {
        name: 'my-custom',
        outputs: [
          {
            label: 'square',
            width: 720,
            height: 720,
            videoBitrateBps: 2_000_000,
            audioBitrateBps: 96_000,
            format: 'mp4'
          }
        ]
      };
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/assets/${sourceId}/transcode`,
        headers: A,
        payload: { customProfile }
      });
      expect(res.statusCode).toBe(202);
      expect(h.submitted[0].profile.name).toBe('my-custom');
      expect(h.submitted[0].profile.outputs[0].label).toBe('square');
    });

    it('rejects supplying both profile and customProfile', async () => {
      const h = await buildApp();
      const sourceId = await makeSource(h);
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/assets/${sourceId}/transcode`,
        headers: A,
        payload: { profile: '720p', customProfile: { name: 'x', outputs: [] } }
      });
      expect(res.statusCode).toBe(400);
    });

    it('404 for unknown source, 409 when no stored object', async () => {
      const h = await buildApp();
      const missing = await h.app.inject({
        method: 'POST',
        url: `/api/v1/assets/asset-999/transcode`,
        headers: A,
        payload: {}
      });
      expect(missing.statusCode).toBe(404);

      const noObj = await h.assets.create('workspace-a', { name: 'no-object' });
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/assets/${noObj.id}/transcode`,
        headers: A,
        payload: {}
      });
      expect(res.statusCode).toBe(409);
    });

    it('501 when Encore is not configured', async () => {
      const h = await buildApp({ noEncore: true });
      const sourceId = await makeSource(h);
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/assets/${sourceId}/transcode`,
        headers: A,
        payload: {}
      });
      expect(res.statusCode).toBe(501);
    });

    it('502 when Encore rejects the submission and reverts the source', async () => {
      const h = await buildApp({ encoreFail: new Error('encore boom') });
      const sourceId = await makeSource(h);
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/assets/${sourceId}/transcode`,
        headers: A,
        payload: {}
      });
      expect(res.statusCode).toBe(502);
      const src = await h.assets.get('workspace-a', sourceId);
      expect(src?.status).toBe('failed');
    });
  });

  describe('GET /api/v1/jobs/:id observes transcode jobs', () => {
    it('returns the job with type=transcode', async () => {
      const h = await buildApp();
      const sourceId = await makeSource(h);
      const submit = await h.app.inject({
        method: 'POST',
        url: `/api/v1/assets/${sourceId}/transcode`,
        headers: A,
        payload: {}
      });
      const { jobId } = submit.json();
      const res = await h.app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers: A });
      expect(res.statusCode).toBe(200);
      const job = res.json();
      expect(job.type).toBe('transcode');
      expect(job.status).toBe('running');
      expect(job.assetId).toBe(sourceId);
    });
  });

  describe('POST /api/v1/internal/encore-callback', () => {
    async function submitJob(h: Harness, sourceId: string): Promise<string> {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/assets/${sourceId}/transcode`,
        headers: A,
        payload: {}
      });
      return res.json().encoreJobId;
    }

    it('creates ready child assets and records renditions on the source', async () => {
      const h = await buildApp();
      const sourceId = await makeSource(h);
      const encoreJobId = await submitJob(h, sourceId);

      const cb = await h.app.inject({
        method: 'POST',
        url: '/api/v1/internal/encore-callback',
        // No auth header — internal endpoint.
        payload: {
          externalId: encoreJobId,
          status: 'SUCCESSFUL',
          // Real Encore shape: field is "output" (not "outputs"), VideoFile with videoStreams
          output: [
            { type: 'VideoFile', file: 'out/1080.mp4', videoStreams: [{ width: 1920, height: 1080 }] },
            { type: 'VideoFile', file: 'out/720.mp4', videoStreams: [{ width: 1280, height: 720 }] }
          ]
        }
      });
      expect(cb.statusCode).toBe(200);
      const body = cb.json();
      expect(body.applied).toBe(true);
      expect(body.renditionAssetIds).toHaveLength(2);

      // Children are ready and linked to the source.
      for (const childId of body.renditionAssetIds) {
        const child = await h.assets.get('workspace-a', childId);
        expect(child?.status).toBe('ready');
        expect(child?.parentId).toBe(sourceId);
      }

      // Source carries the renditions array and is ready again.
      const src = await h.assets.get('workspace-a', sourceId);
      expect(src?.status).toBe('ready');
      expect(src?.renditions).toHaveLength(2);
      expect(src?.renditions?.map((r) => r.label)).toEqual(['rendition-1', 'rendition-2']);
      expect(src?.renditions?.[0].objectKey).toBe('out/1080.mp4');
    });

    it('is idempotent for duplicate callbacks (no duplicate children)', async () => {
      const h = await buildApp();
      const sourceId = await makeSource(h);
      const encoreJobId = await submitJob(h, sourceId);
      const payload = {
        externalId: encoreJobId,
        status: 'SUCCESSFUL',
        output: [{ type: 'VideoFile', file: 'out/1080.mp4', videoStreams: [{ width: 1920, height: 1080 }] }]
      };
      const first = await h.app.inject({
        method: 'POST',
        url: '/api/v1/internal/encore-callback',
        payload
      });
      expect(first.json().applied).toBe(true);
      const second = await h.app.inject({
        method: 'POST',
        url: '/api/v1/internal/encore-callback',
        payload
      });
      expect(second.json().applied).toBe(false);

      const children = await h.assets.list('workspace-a', { parentId: sourceId });
      expect(children.total).toBe(1);
    });

    it('marks the job and source failed on a failure callback', async () => {
      const h = await buildApp();
      const sourceId = await makeSource(h);
      const encoreJobId = await submitJob(h, sourceId);
      const cb = await h.app.inject({
        method: 'POST',
        url: '/api/v1/internal/encore-callback',
        payload: { externalId: encoreJobId, status: 'FAILED', message: 'bad input' }
      });
      expect(cb.statusCode).toBe(200);
      const src = await h.assets.get('workspace-a', sourceId);
      expect(src?.status).toBe('failed');
      const found = await h.jobs.findByEncoreJobId(encoreJobId);
      expect(found?.job.status).toBe('failed');
      expect(found?.job.error).toContain('bad input');
    });

    it('404 for an unknown encoreJobId', async () => {
      const h = await buildApp();
      const cb = await h.app.inject({
        method: 'POST',
        url: '/api/v1/internal/encore-callback',
        payload: { externalId: 'workspace-a__job-nope', status: 'SUCCESSFUL', output: [] }
      });
      expect(cb.statusCode).toBe(404);
    });
  });
});
