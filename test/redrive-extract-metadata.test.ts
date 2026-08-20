// Re-drive metadata extraction recovery tests (issue #281).
//
// The on-demand POST /:id/extract-metadata endpoint gains a synchronous
// RE-DRIVE mode for an asset WEDGED in `processing` with a
// `technicalMetadataError` set (typically after a prior conflict/probe
// failure). Re-driving such an asset re-runs extraction and, on success:
//   - clears `technicalMetadataError`
//   - populates `technicalMetadata`
//   - advances the lifecycle `processing -> ready`
// and returns 200 with the resolved status so an operator gets a definitive
// answer in a single call. Re-drive is idempotent: an already-`ready` asset is
// a safe no-op.
//
// These tests use the CURRENT (non-workspace-scoped) repository signatures —
// InMemoryAssetRepository.get(id) / .update(id, patch) — matching src on this
// branch. (The older metadata-extraction.test.ts is out of sync with the
// current signatures; that is the pre-existing workspace-scoping drift and is
// unrelated to this change.)

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import {
  extractTechnicalMetadata,
  type FfprobeResult,
  type ProbeRunner
} from '../src/pipeline/metadata-extractor.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

const A = { authorization: 'Bearer token-a' };

function fakeStorage(): WorkspaceStorage {
  return {
    presignedGet: async (key: string) => `https://minio.example/${key}?sig=abc`
  } as unknown as WorkspaceStorage;
}

const SINGLE: FfprobeResult = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, duration: '12.5' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }
  ],
  format: { format_name: 'mov,mp4,m4a', duration: '12.5', bit_rate: '5000000' }
};

type Built = {
  app: FastifyInstance;
  repo: InMemoryAssetRepository;
  extractionDone: () => Promise<void>;
};

async function buildApp(probe: ProbeRunner): Promise<Built> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();

  // Wrap the real extractor so tests can await its completion deterministically
  // even for the fire-and-forget (non-wedged) path.
  let pending: Promise<void> = Promise.resolve();
  const extract = ((params, deps) => {
    pending = extractTechnicalMetadata(params, deps);
    return pending;
  }) as typeof extractTechnicalMetadata;

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor: () => fakeStorage(),
    probe,
    extract
  });
  await app.ready();
  return { app, repo, extractionDone: () => pending };
}

// Create an asset with a stored object, directly through the repository so we
// avoid the auth-mock coupling of the ingest routes.
async function createStoredAsset(repo: InMemoryAssetRepository): Promise<string> {
  const asset = await repo.create({ name: 'clip', objectKey: 'sources/clip.mp4' });
  return asset.id;
}

// Drive an asset into the WEDGED state: processing + technicalMetadataError set,
// exactly as a prior failed/conflicted extraction leaves it.
async function wedge(repo: InMemoryAssetRepository, id: string): Promise<void> {
  await repo.update(id, { status: 'processing' });
  await repo.update(id, { technicalMetadataError: 'update conflict during extraction' });
}

describe('re-drive metadata extraction recovery (issue #281)', () => {
  it('re-drives a wedged asset to ready with metadata populated and error cleared', async () => {
    const probe: ProbeRunner = async () => SINGLE;
    const { app, repo } = await buildApp(probe);
    const id = await createStoredAsset(repo);
    await wedge(repo, id);

    const before = await repo.get(id);
    expect(before?.status).toBe('processing');
    expect(before?.technicalMetadataError).toBe('update conflict during extraction');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/extract-metadata`,
      headers: A
    });

    // Synchronous re-drive reports the resolved outcome.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ assetId: id, status: 'ready' });

    const after = await repo.get(id);
    expect(after?.status).toBe('ready');
    expect(after?.technicalMetadata?.codec).toBe('h264');
    expect(after?.technicalMetadata?.audioTracks).toHaveLength(1);
    expect(after?.technicalMetadataError).toBeUndefined();
  });

  it('is idempotent / safe on an already-ready asset (no-op)', async () => {
    const probe: ProbeRunner = async () => SINGLE;
    const { app, repo, extractionDone } = await buildApp(probe);
    const id = await createStoredAsset(repo);

    // Recover once so the asset is ready with no error.
    await wedge(repo, id);
    await app.inject({ method: 'POST', url: `/api/v1/assets/${id}/extract-metadata`, headers: A });
    expect((await repo.get(id))?.status).toBe('ready');

    // Re-drive again on the already-ready asset. Not wedged -> fire-and-forget
    // 202; it must remain ready with metadata intact and no error introduced.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/extract-metadata`,
      headers: A
    });
    expect(res.statusCode).toBe(202);
    await extractionDone();

    const after = await repo.get(id);
    expect(after?.status).toBe('ready');
    expect(after?.technicalMetadata?.codec).toBe('h264');
    expect(after?.technicalMetadataError).toBeUndefined();
  });

  it('re-driving a wedged asset that still fails keeps it observable (records error, stays processing)', async () => {
    const probe: ProbeRunner = async () => {
      throw new Error('ffprobe still failing');
    };
    const { app, repo } = await buildApp(probe);
    const id = await createStoredAsset(repo);
    await wedge(repo, id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/extract-metadata`,
      headers: A
    });

    // The synchronous re-drive still returns 200 (the extractor never throws),
    // but the resolved status shows the asset is not yet recovered.
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('processing');

    const after = await repo.get(id);
    expect(after?.status).toBe('processing');
    expect(after?.technicalMetadata).toBeNull();
    expect(after?.technicalMetadataError).toContain('ffprobe still failing');
  });
});
