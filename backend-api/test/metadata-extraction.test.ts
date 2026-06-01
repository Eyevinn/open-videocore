// Technical metadata extraction tests (issue #6).
//
// Exercises the assets router + extractor against the in-memory repository with
// a stubbed ffprobe ProbeRunner and a fake WorkspaceStorage. Covers:
//   - successful extraction populates technicalMetadata + audioTracks
//   - failure records technicalMetadataError without blocking the asset record
//   - the on-demand POST /:id/extract-metadata endpoint (202, 409, 501, 404)
//   - multi-track audio containers
// The extractor is fire-and-forget, so tests await the injected runner directly
// (via a deterministic, awaited fake) rather than racing the detached task.

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import {
  extractTechnicalMetadata,
  parseFfprobe,
  type FfprobeResult,
  type ProbeRunner
} from '../src/pipeline/metadata-extractor.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

// Minimal fake storage: only presignedGet is exercised by the extractor.
function fakeStorage(): WorkspaceStorage {
  return {
    presignedGet: vi.fn(async (key: string) => `https://minio.example/${key}?sig=abc`)
  } as unknown as WorkspaceStorage;
}

// A single-video single-audio ffprobe payload.
const SINGLE: FfprobeResult = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, duration: '12.5' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }
  ],
  format: { format_name: 'mov,mp4,m4a', duration: '12.5', bit_rate: '5000000' }
};

// A multi-track audio payload (two language tracks).
const MULTI: FfprobeResult = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160 },
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
    { index: 2, codec_type: 'audio', codec_name: 'ac3', channels: 6, sample_rate: '44100' }
  ],
  format: { format_name: 'matroska,webm', duration: '60', bit_rate: '12000000' }
};

type Built = {
  app: FastifyInstance;
  repo: InMemoryAssetRepository;
  // Resolves once the (single) in-flight extraction task settles.
  extractionDone: () => Promise<void>;
};

async function buildApp(opts: {
  probe?: ProbeRunner;
  withStorage?: boolean;
} = {}): Promise<Built> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();

  // Wrap the real extractor so tests can await its completion deterministically.
  let pending: Promise<void> = Promise.resolve();
  const extract = ((params, deps) => {
    pending = extractTechnicalMetadata(params, deps);
    return pending;
  }) as typeof extractTechnicalMetadata;

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor: opts.withStorage === false ? undefined : () => fakeStorage(),
    probe: opts.probe,
    extract
  });
  await app.ready();
  return { app, repo, extractionDone: () => pending };
}

async function createReadyAsset(app: FastifyInstance, repo: InMemoryAssetRepository) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'clip' }
  });
  const id = res.json().id as string;
  // Give it a stored object key (as ingest would).
  await repo.update('workspace-a', id, { objectKey: `sources/${id}` });
  return id;
}

describe('technical metadata extraction (issue #6)', () => {
  describe('parseFfprobe mapping', () => {
    it('maps a single video + audio container', () => {
      const md = parseFfprobe(SINGLE, '2026-06-01T00:00:00.000Z');
      expect(md.codec).toBe('h264');
      expect(md.width).toBe(1920);
      expect(md.height).toBe(1080);
      expect(md.durationSeconds).toBe(12.5);
      expect(md.bitrateBps).toBe(5000000);
      expect(md.containerFormat).toBe('mov,mp4,m4a');
      expect(md.audioTracks).toEqual([
        { index: 1, codec: 'aac', channels: 2, sampleRateHz: 48000 }
      ]);
      expect(md.extractedAt).toBe('2026-06-01T00:00:00.000Z');
    });

    it('collects every audio track for multi-track containers', () => {
      const md = parseFfprobe(MULTI, '2026-06-01T00:00:00.000Z');
      expect(md.codec).toBe('hevc');
      expect(md.audioTracks).toHaveLength(2);
      expect(md.audioTracks).toEqual([
        { index: 1, codec: 'aac', channels: 2, sampleRateHz: 48000 },
        { index: 2, codec: 'ac3', channels: 6, sampleRateHz: 44100 }
      ]);
    });

    it('defends missing fields without throwing', () => {
      const md = parseFfprobe({}, 'now');
      expect(md.codec).toBe('unknown');
      expect(md.width).toBe(0);
      expect(md.audioTracks).toEqual([]);
      expect(md.containerFormat).toBe('unknown');
    });
  });

  describe('on-demand POST /:id/extract-metadata', () => {
    it('returns 202 and populates technicalMetadata on success', async () => {
      const probe = vi.fn<ProbeRunner>(async () => SINGLE);
      const { app, repo, extractionDone } = await buildApp({ probe });
      const id = await createReadyAsset(app, repo);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/extract-metadata`,
        headers: A
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ assetId: id, status: 'extracting' });

      await extractionDone();
      const asset = await repo.get('workspace-a', id);
      expect(probe).toHaveBeenCalledOnce();
      expect(asset?.technicalMetadata?.codec).toBe('h264');
      expect(asset?.technicalMetadata?.audioTracks).toHaveLength(1);
      expect(asset?.technicalMetadataError).toBeUndefined();
    });

    it('returns the technicalMetadata in the asset GET response', async () => {
      const probe = vi.fn<ProbeRunner>(async () => MULTI);
      const { app, repo, extractionDone } = await buildApp({ probe });
      const id = await createReadyAsset(app, repo);
      await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/extract-metadata`,
        headers: A
      });
      await extractionDone();

      const get = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}`, headers: A });
      expect(get.statusCode).toBe(200);
      expect(get.json().technicalMetadata.containerFormat).toBe('matroska,webm');
      expect(get.json().technicalMetadata.audioTracks).toHaveLength(2);
    });

    it('records technicalMetadataError on failure without blocking the asset', async () => {
      const probe = vi.fn<ProbeRunner>(async () => {
        throw new Error('ffprobe job failed: container exited non-zero');
      });
      const { app, repo, extractionDone } = await buildApp({ probe });
      const id = await createReadyAsset(app, repo);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/extract-metadata`,
        headers: A
      });
      // The endpoint still accepts (202) — failure is async and non-blocking.
      expect(res.statusCode).toBe(202);
      await extractionDone();

      const asset = await repo.get('workspace-a', id);
      // Asset record is intact; only the metadata fields reflect the failure.
      expect(asset?.status).toBe('uploading');
      expect(asset?.technicalMetadata).toBeNull();
      expect(asset?.technicalMetadataError).toContain('ffprobe job failed');
    });

    it('a later successful re-extraction clears a prior error', async () => {
      let call = 0;
      const probe = vi.fn<ProbeRunner>(async () => {
        call++;
        if (call === 1) throw new Error('transient');
        return SINGLE;
      });
      const { app, repo, extractionDone } = await buildApp({ probe });
      const id = await createReadyAsset(app, repo);

      await app.inject({ method: 'POST', url: `/api/v1/assets/${id}/extract-metadata`, headers: A });
      await extractionDone();
      expect((await repo.get('workspace-a', id))?.technicalMetadataError).toBe('transient');

      await app.inject({ method: 'POST', url: `/api/v1/assets/${id}/extract-metadata`, headers: A });
      await extractionDone();
      const asset = await repo.get('workspace-a', id);
      expect(asset?.technicalMetadata?.codec).toBe('h264');
      expect(asset?.technicalMetadataError).toBeUndefined();
    });

    it('returns 409 when the asset has no stored object', async () => {
      const probe = vi.fn<ProbeRunner>(async () => SINGLE);
      const { app } = await buildApp({ probe });
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/assets',
        headers: A,
        payload: { name: 'no-object' }
      });
      const id = create.json().id;
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/extract-metadata`,
        headers: A
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('no_object');
      expect(probe).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown asset', async () => {
      const { app } = await buildApp({ probe: vi.fn<ProbeRunner>(async () => SINGLE) });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/nope/extract-metadata',
        headers: A
      });
      expect(res.statusCode).toBe(404);
    });

    it('does not leak existence across workspaces (404)', async () => {
      const { app, repo } = await buildApp({ probe: vi.fn<ProbeRunner>(async () => SINGLE) });
      const id = await createReadyAsset(app, repo);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/extract-metadata`,
        headers: auth('token-b')
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 501 when no probe runner is configured', async () => {
      const { app, repo } = await buildApp({ probe: undefined });
      const id = await createReadyAsset(app, repo);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/extract-metadata`,
        headers: A
      });
      expect(res.statusCode).toBe(501);
      expect(res.json().error).toBe('not_configured');
    });
  });

  describe('extractTechnicalMetadata is fire-and-forget safe', () => {
    it('never rejects even when the error-recording write also fails', async () => {
      const repo = new InMemoryAssetRepository();
      const asset = await repo.create('workspace-a', { name: 'x', objectKey: 'sources/x' });
      const onError = vi.fn();
      // probe throws AND the repo update throws -> still resolves.
      const brokenRepo = {
        ...repo,
        update: vi.fn(async () => {
          throw new Error('couch unreachable');
        })
      } as unknown as InMemoryAssetRepository;

      await expect(
        extractTechnicalMetadata(
          { workspaceId: 'workspace-a', assetId: asset.id, objectKey: 'sources/x' },
          {
            assets: brokenRepo,
            storage: fakeStorage(),
            probe: async () => {
              throw new Error('boom');
            },
            onError
          }
        )
      ).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalledOnce();
    });
  });
});
