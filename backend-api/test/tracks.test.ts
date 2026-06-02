// Multi-language audio & subtitle track tests (issue #18).
//
// Exercises the assets router track routes against the in-memory repository,
// which shares the track persistence semantics with the CouchDB backend, so the
// rules under test here are backend-agnostic by construction.
//
// Covers:
//   - GET /:id/tracks (empty + populated)
//   - POST/DELETE /:id/audio-tracks
//   - POST/DELETE /:id/subtitle-tracks (with + without storage configured)
//   - validation, 404 semantics, and workspace isolation

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
import type { WorkspaceStorage } from '../src/data/storage.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');
const B = auth('token-b');

function fakeStorage(): WorkspaceStorage {
  return {
    presignedPut: vi.fn(async (key: string) => `https://minio.example/${key}?sig=put`),
    presignedGet: vi.fn(async (key: string) => `https://minio.example/${key}?sig=get`)
  } as unknown as WorkspaceStorage;
}

async function buildApp(opts: { withStorage?: boolean } = {}): Promise<{
  app: FastifyInstance;
  repo: InMemoryAssetRepository;
}> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor: opts.withStorage === false ? undefined : () => fakeStorage()
  });
  await app.ready();
  return { app, repo };
}

async function createAsset(app: FastifyInstance, headers = A): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers,
    payload: { name: 'clip' }
  });
  return res.json()['id'] as string;
}

describe('multi-language tracks (issue #18)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    ({ app } = await buildApp());
  });

  describe('GET /:id/tracks', () => {
    it('returns empty arrays for a fresh asset', async () => {
      const id = await createAsset(app);
      const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/tracks`, headers: A });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ audioTracks: [], subtitleTracks: [] });
    });

    it('returns 404 for an unknown asset', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/assets/nope/tracks',
        headers: A
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('audio tracks', () => {
    it('adds an audio track with a server-generated id and returns the list', async () => {
      const id = await createAsset(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/audio-tracks`,
        headers: A,
        payload: { language: 'sv', codec: 'aac', channels: 2, label: 'Svenska', default: true }
      });
      expect(res.statusCode).toBe(201);
      const tracks = res.json()['audioTracks'];
      expect(tracks).toHaveLength(1);
      expect(tracks[0]).toMatchObject({
        language: 'sv',
        codec: 'aac',
        channels: 2,
        label: 'Svenska',
        default: true
      });
      expect(typeof tracks[0]['id']).toBe('string');
      expect(tracks[0]['id'].length).toBeGreaterThan(0);
    });

    it('appends multiple audio tracks and surfaces them on GET /tracks', async () => {
      const id = await createAsset(app);
      await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/audio-tracks`,
        headers: A,
        payload: { language: 'en' }
      });
      await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/audio-tracks`,
        headers: A,
        payload: { language: 'sv' }
      });
      const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/tracks`, headers: A });
      const langs = res.json()['audioTracks'].map((t: { language: string }) => t.language);
      expect(langs).toEqual(['en', 'sv']);
    });

    it('rejects an empty language', async () => {
      const id = await createAsset(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/audio-tracks`,
        headers: A,
        payload: { language: '' }
      });
      expect(res.statusCode).toBe(400);
    });

    it('removes an audio track by id', async () => {
      const id = await createAsset(app);
      const add = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/audio-tracks`,
        headers: A,
        payload: { language: 'en' }
      });
      const trackId = add.json()['audioTracks'][0]['id'];
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/assets/${id}/audio-tracks/${trackId}`,
        headers: A
      });
      expect(del.statusCode).toBe(204);
      const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/tracks`, headers: A });
      expect(res.json()['audioTracks']).toEqual([]);
    });

    it('returns 404 deleting an unknown track id', async () => {
      const id = await createAsset(app);
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/assets/${id}/audio-tracks/does-not-exist`,
        headers: A
      });
      expect(del.statusCode).toBe(404);
    });

    it('returns 404 adding to an unknown asset', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/nope/audio-tracks',
        headers: A,
        payload: { language: 'en' }
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('subtitle tracks', () => {
    it('adds a subtitle track and returns a presigned uploadUrl when storage is configured', async () => {
      const id = await createAsset(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/subtitle-tracks`,
        headers: A,
        payload: { language: 'en', format: 'vtt', label: 'English' }
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body['track']).toMatchObject({ language: 'en', format: 'vtt', label: 'English' });
      const trackId = body['track']['id'];
      expect(body['track']['objectKey']).toBe(`subtitles/${id}/${trackId}.vtt`);
      expect(body['uploadUrl']).toContain(`subtitles/${id}/${trackId}.vtt`);
    });

    it('omits uploadUrl and objectKey when storage is not configured', async () => {
      ({ app } = await buildApp({ withStorage: false }));
      const id = await createAsset(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/subtitle-tracks`,
        headers: A,
        payload: { language: 'en', format: 'srt' }
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body['uploadUrl']).toBeUndefined();
      expect(body['track']['objectKey']).toBeUndefined();
    });

    it('rejects an unsupported subtitle format', async () => {
      const id = await createAsset(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/subtitle-tracks`,
        headers: A,
        payload: { language: 'en', format: 'sub' }
      });
      expect(res.statusCode).toBe(400);
    });

    it('lists subtitle tracks on GET /tracks and removes one by id', async () => {
      const id = await createAsset(app);
      const add = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/subtitle-tracks`,
        headers: A,
        payload: { language: 'sv', format: 'ttml' }
      });
      const trackId = add.json()['track']['id'];

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${id}/tracks`,
        headers: A
      });
      expect(list.json()['subtitleTracks']).toHaveLength(1);

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/assets/${id}/subtitle-tracks/${trackId}`,
        headers: A
      });
      expect(del.statusCode).toBe(204);

      const after = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${id}/tracks`,
        headers: A
      });
      expect(after.json()['subtitleTracks']).toEqual([]);
    });

    it('returns 404 deleting an unknown subtitle track id', async () => {
      const id = await createAsset(app);
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/assets/${id}/subtitle-tracks/nope`,
        headers: A
      });
      expect(del.statusCode).toBe(404);
    });
  });

  describe('workspace isolation', () => {
    it('does not expose one workspace tracks to another', async () => {
      const id = await createAsset(app, A);
      await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/audio-tracks`,
        headers: A,
        payload: { language: 'en' }
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${id}/tracks`,
        headers: B
      });
      expect(res.statusCode).toBe(404);
    });

    it('does not let another workspace add tracks', async () => {
      const id = await createAsset(app, A);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/audio-tracks`,
        headers: B,
        payload: { language: 'en' }
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
