// Frame rate + start timecode in technical metadata (issue #1066).
//
// Frame-by-frame stepping needs the source's frame rate, and the probe's output
// for it was being dropped at parse time: `FfprobeStream` declared no
// `r_frame_rate`/`avg_frame_rate`, `parseFfprobe` returned no rate, and the
// persisted video track was built as `{ codec, width, height, bitrateBps }`, so
// `technical.video[0].frameRate` was never written even though the stored schema
// has always declared it.
//
// CONTRACT GROUNDING (CLAUDE.md rule 7) — every field below was read from this
// repo's source and generated spec, not from prose:
//   - ffprobe input shape: `FfprobeStream` / `FfprobeFormat`
//     (src/pipeline/metadata-extractor.ts). Frame rate arrives as a RATIONAL
//     STRING ("25/1", "30000/1001"), so the parser divides; the start timecode
//     arrives as a `tags.timecode` string on the stream or on the format.
//   - stored video track: `VideoTrackSchema` (src/data/asset-document.ts:51-62),
//     `frameRate: z.number().optional()` and `startTimecode: z.string().optional()`
//     — both optional, which is what keeps pre-existing documents readable.
//   - read API: `technicalMetadataSchema` (src/routes/assets.ts) on the
//     GET /api/v1/assets/{id} 200 body, and `tracksSchema`/`videoTrackOutSchema`
//     on the GET /api/v1/assets/{id}/tracks 200 body. Both objects are
//     `additionalProperties: false` in openapi.json, so the fields have to be
//     declared explicitly — asserted against the generated spec below.

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = { 'token-a': 'workspace-a' };
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
  AssetDocumentSchema,
  fromAssetDocument,
  toAssetDocument
} from '../src/data/asset-document.js';
import {
  extractTechnicalMetadata,
  parseFfprobe,
  parseFrameRate,
  type FfprobeResult,
  type ProbeRunner
} from '../src/pipeline/metadata-extractor.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

const A = { authorization: 'Bearer token-a' };
const ROOT = process.cwd();
const OPENAPI = JSON.parse(readFileSync(resolve(ROOT, 'openapi.json'), 'utf8'));

function fakeStorage(): WorkspaceStorage {
  return {
    presignedGet: vi.fn(async (key: string) => `https://minio.example/${key}?sig=abc`)
  } as unknown as WorkspaceStorage;
}

// A 29.97 fps source: the rate is the NTSC rational 30000/1001 and the container
// carries a start timecode, as a tape-sourced master would.
const NTSC: FfprobeResult = {
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      duration: '12.5',
      r_frame_rate: '30000/1001',
      avg_frame_rate: '30000/1001',
      tags: { timecode: '01:00:00:00' }
    },
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }
  ],
  format: { format_name: 'mov,mp4,m4a', duration: '12.5', bit_rate: '5000000' }
};

// An audio-only source: no video stream at all, so no frame rate and no timecode.
const AUDIO_ONLY: FfprobeResult = {
  streams: [{ index: 0, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }],
  format: { format_name: 'mov,mp4,m4a', duration: '30', bit_rate: '128000' }
};

type Built = {
  app: FastifyInstance;
  repo: InMemoryAssetRepository;
  extractionDone: () => Promise<void>;
};

// Same harness as test/metadata-extraction.test.ts: the extractor is
// fire-and-forget, so the test awaits the wrapped task instead of racing it.
async function buildApp(probe: ProbeRunner): Promise<Built> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
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

async function createReadyAsset(app: FastifyInstance, repo: InMemoryAssetRepository) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'clip' }
  });
  const id = res.json().id as string;
  await repo.update(id, { objectKey: `sources/${id}` });
  return id;
}

describe('frame rate + start timecode (issue #1066)', () => {
  describe('parseFrameRate: ffprobe reports a rational string, not a number', () => {
    it('parses an integer rate', () => {
      expect(parseFrameRate('25/1')).toBe(25);
      expect(parseFrameRate('50/1')).toBe(50);
    });

    it('parses the NTSC rationals to their real value', () => {
      // 30000/1001 = 29.97002997…; three decimals is the precision a stepping
      // client needs, and lands inside the ±0.01 the issue asks for.
      expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
      expect(parseFrameRate('24000/1001')).toBeCloseTo(23.976, 3);
    });

    it('treats an unusable value as absent rather than reporting 0 fps', () => {
      // "0/0" is what ffprobe emits for a stream with no meaningful rate.
      expect(parseFrameRate('0/0')).toBeUndefined();
      expect(parseFrameRate('25/0')).toBeUndefined();
      expect(parseFrameRate('N/A')).toBeUndefined();
      expect(parseFrameRate('')).toBeUndefined();
      expect(parseFrameRate(undefined)).toBeUndefined();
    });

    it('accepts a bare number, should a runner ever report one', () => {
      expect(parseFrameRate(25)).toBe(25);
      expect(parseFrameRate(0)).toBeUndefined();
    });
  });

  describe('parseFfprobe', () => {
    it('carries the rate and the start timecode through', () => {
      const md = parseFfprobe(NTSC, '2026-06-01T00:00:00.000Z');
      expect(md.frameRate).toBeCloseTo(29.97, 2);
      expect(md.startTimecode).toBe('01:00:00:00');
    });

    it('falls back to avg_frame_rate when the base rate is unusable', () => {
      const vfr: FfprobeResult = {
        streams: [
          {
            index: 0,
            codec_type: 'video',
            codec_name: 'h264',
            r_frame_rate: '0/0',
            avg_frame_rate: '25/1'
          }
        ],
        format: { format_name: 'matroska,webm' }
      };
      expect(parseFfprobe(vfr, 'now').frameRate).toBe(25);
    });

    it('reads a start timecode carried on the container instead of the stream', () => {
      const result: FfprobeResult = {
        streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', r_frame_rate: '25/1' }],
        format: { format_name: 'mxf', tags: { timecode: '10:00:00:00' } }
      };
      expect(parseFfprobe(result, 'now').startTimecode).toBe('10:00:00:00');
    });

    it('omits both fields for a source with no video stream (AC2)', () => {
      const md = parseFfprobe(AUDIO_ONLY, 'now');
      expect(md.frameRate).toBeUndefined();
      expect(md.startTimecode).toBeUndefined();
      // The rest of the metadata is still extracted, without error.
      expect(md.containerFormat).toBe('mov,mp4,m4a');
      expect(md.audioTracks).toHaveLength(1);
    });
  });

  describe('AC1: extraction stores the rate on the asset and serves it back', () => {
    it('POST /:id/extract-metadata on a 29.97 fps source persists frameRate', async () => {
      const probe = vi.fn<ProbeRunner>(async () => NTSC);
      const { app, repo, extractionDone } = await buildApp(probe);
      const id = await createReadyAsset(app, repo);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/extract-metadata`,
        headers: A
      });
      expect(res.statusCode).toBe(202);
      await extractionDone();

      const asset = await repo.get(id);
      expect(asset?.technicalMetadata?.frameRate).toBeCloseTo(29.97, 2);
      expect(asset?.technicalMetadata?.startTimecode).toBe('01:00:00:00');
      expect(asset?.technicalMetadataError).toBeUndefined();

      // And it survives the document mapping, which is where it was being
      // dropped before: technical.video[0] is the persisted track.
      const doc = AssetDocumentSchema.parse(toAssetDocument(asset!));
      expect(doc.technical.video?.[0]?.frameRate).toBeCloseTo(29.97, 2);
      expect(doc.technical.video?.[0]?.startTimecode).toBe('01:00:00:00');
    });

    it('GET /:id and GET /:id/tracks both report it (AC3)', async () => {
      const { app, repo, extractionDone } = await buildApp(vi.fn<ProbeRunner>(async () => NTSC));
      const id = await createReadyAsset(app, repo);
      await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/extract-metadata`,
        headers: A
      });
      await extractionDone();

      const get = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}`, headers: A });
      expect(get.statusCode).toBe(200);
      expect(get.json().technicalMetadata.frameRate).toBeCloseTo(29.97, 2);
      expect(get.json().technicalMetadata.startTimecode).toBe('01:00:00:00');

      const tracks = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${id}/tracks`,
        headers: A
      });
      expect(tracks.statusCode).toBe(200);
      expect(tracks.json().videoTracks).toHaveLength(1);
      expect(tracks.json().videoTracks[0].frameRate).toBeCloseTo(29.97, 2);
      expect(tracks.json().videoTracks[0].startTimecode).toBe('01:00:00:00');
    });
  });

  describe('AC2: a source with no video stream', () => {
    it('extracts without error and reports no video track', async () => {
      const probe = vi.fn<ProbeRunner>(async () => AUDIO_ONLY);
      const { app, repo, extractionDone } = await buildApp(probe);
      const id = await createReadyAsset(app, repo);
      await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/extract-metadata`,
        headers: A
      });
      await extractionDone();

      const asset = await repo.get(id);
      expect(asset?.technicalMetadataError).toBeUndefined();
      expect(asset?.technicalMetadata?.audioTracks).toHaveLength(1);
      expect(asset?.technicalMetadata?.frameRate).toBeUndefined();

      const get = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}`, headers: A });
      expect(get.statusCode).toBe(200);
      expect('frameRate' in get.json().technicalMetadata).toBe(false);

      const tracks = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${id}/tracks`,
        headers: A
      });
      expect(tracks.statusCode).toBe(200);
      expect(tracks.json().videoTracks).toEqual([]);
    });
  });

  describe('AC4: documents written before the field existed still read back', () => {
    it('a video track with no frameRate/startTimecode parses and maps to an asset', () => {
      const legacy = {
        _id: '01J9AAAAAAAAAAAAAAAAAAAAAA',
        type: 'asset',
        schemaVersion: 1,
        state: 'ready',
        descriptive: { title: 'Legacy clip' },
        technical: {
          container: 'matroska',
          durationMs: 12500,
          // Exactly the four-field track the pre-fix builder wrote.
          video: [{ codec: 'h264', width: 1920, height: 1080, bitrateBps: 5_000_000 }],
          audio: [{ index: 1, codec: 'aac', channels: 2, sampleRateHz: 48000 }],
          probe: { source: 'eyevinn-ffmpeg-s3', probedAt: '2026-01-01T00:00:00.000Z' }
        },
        administrative: {
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          source: { method: 'upload' }
        }
      };
      const doc = AssetDocumentSchema.parse(legacy);
      expect(doc.technical.video?.[0]?.frameRate).toBeUndefined();

      const asset = fromAssetDocument(doc);
      expect(asset.technicalMetadata?.codec).toBe('h264');
      // Absent, NOT zeroed: a legacy document must not claim 0 fps.
      expect(asset.technicalMetadata?.frameRate).toBeUndefined();
      expect(asset.technicalMetadata?.startTimecode).toBeUndefined();
      expect('frameRate' in (asset.technicalMetadata ?? {})).toBe(false);
    });
  });

  describe('AC3: the generated spec declares the fields', () => {
    const assetRead = OPENAPI.paths['/api/v1/assets/{id}'].get.responses['200'].content[
      'application/json'
    ].schema as {
      properties: Record<string, { properties?: Record<string, unknown> } & Record<string, unknown>>;
    };

    it('GET /api/v1/assets/{id} -> technicalMetadata carries frameRate + startTimecode', () => {
      // The object is `additionalProperties: false`, so an undeclared field would
      // be stripped from every response; it has to be in `properties`.
      const tm = assetRead.properties['technicalMetadata'] as Record<string, unknown>;
      const props = ((tm['properties'] ?? {}) as Record<string, { type?: string }>) ?? {};
      expect(props['frameRate']?.type).toBe('number');
      expect(props['startTimecode']?.type).toBe('string');
      // Optional, so neither appears in `required`.
      expect(tm['required']).not.toContain('frameRate');
      expect(tm['required']).not.toContain('startTimecode');
      expect(tm['additionalProperties']).toBe(false);
    });

    it('GET /api/v1/assets/{id}/tracks -> videoTracks[] carries frameRate', () => {
      const schema = OPENAPI.paths['/api/v1/assets/{id}/tracks'].get.responses['200'].content[
        'application/json'
      ].schema as {
        properties: Record<string, { items?: { properties?: Record<string, { type?: string }> } }>;
        required: string[];
      };
      const item = schema.properties['videoTracks']?.items;
      expect(item?.properties?.['frameRate']?.type).toBe('number');
      expect(item?.properties?.['startTimecode']?.type).toBe('string');
      expect(schema.required).toContain('videoTracks');
    });
  });
});
