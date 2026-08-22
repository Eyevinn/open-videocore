// Burn-in generation-race tests (issue #389).
//
// Issue #388 resolves a burn-in caption source to ONE concrete workspace-local
// S3 object key and threads a `subtitles=<key>` filter through profileParams,
// and it 409s (`burn_in_source_not_ready`) when a referenced `subtitleTrack`
// has NO `objectKey` yet. But #388 does NOT verify that the resolved key's BYTES
// have actually landed. Subtitle generation is fire-and-forget, so a resolved
// key (a caller-supplied `sidecarKey`, or a `subtitleTrack.objectKey` set before
// the generation callback landed) can point at an object that does not yet exist
// or is still zero-length. Either would silently burn NO captions.
//
// This suite drives real HTTP requests through the assets router against the
// native POST /:id/transcode route with a FAKE object store (statObject) and a
// FAKE Encore client, asserting the observable guarantee (ADR-014 D1: explicit
// source => clear error at submit time):
//   - ready path        : object exists (non-empty) => 202, subtitles filter set,
//                         Encore submit invoked once.
//   - not-ready (absent): object absent            => 409, Encore NEVER submitted.
//   - forced-race       : track.objectKey set but object absent/empty (callback
//                         not landed) => 409, Encore NEVER submitted.
//   - clean (no burnIn) : unaffected => 202, no subtitles filter, submit invoked.
//
// Contract sources (CLAUDE.md rule 7):
//   - WorkspaceStorage.statObject returns `{ size, etag } | undefined`
//     (undefined == NotFound): src/data/storage.ts:92-102 — the presence check
//     the enforcement reuses.
//   - resolveBurnInSource / buildSubtitlesFilter (#388): src/pipeline/burn-in.ts.
//   - checkBurnInObjectAvailable (#389, this issue): src/pipeline/burn-in.ts.
//   - The native transcode handler resolves burn-in then verifies existence:
//     src/routes/assets.ts (POST '/:id/transcode').
//   - EncoreClient / EncoreSubmitInput; burnInSubtitlesFilter threading:
//     src/pipeline/encore-client.ts, src/pipeline/transcode.ts.

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter, type StorageFactory } from './assets.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryJobRepository } from '../data/job-repo.js';
import type { EncoreClient, EncoreSubmitInput } from '../pipeline/encore-client.js';

// A fake object store exposing only the narrow `statObject` surface the burn-in
// availability check uses (src/data/storage.ts:92-102). `objects` maps a
// workspace-local key -> byte size; a missing key stats as `undefined`
// (NotFound), mirroring the real WorkspaceStorage.statObject.
function fakeStorage(objects: Record<string, number>): StorageFactory {
  const store = {
    async statObject(objectKey: string): Promise<{ size: number; etag: string } | undefined> {
      if (Object.prototype.hasOwnProperty.call(objects, objectKey)) {
        return { size: objects[objectKey]!, etag: 'etag-' + objectKey };
      }
      return undefined;
    }
  };
  return () => store as never;
}

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

type Harness = {
  app: FastifyInstance;
  repo: InMemoryAssetRepository;
  submitted: EncoreSubmitInput[];
};

async function buildApp(objects: Record<string, number>): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const { client, submitted } = fakeEncore();
  const repo = new InMemoryAssetRepository();

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    jobRepository: new InMemoryJobRepository(),
    encore: client,
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket',
    storageFor: fakeStorage(objects)
  });
  await app.ready();
  return { app, repo, submitted };
}

// Create a ready-to-transcode asset (has an objectKey) with optional subtitle
// tracks, and return its id.
async function seedAsset(
  repo: InMemoryAssetRepository,
  tracks?: { id: string; language: string; format: 'srt' | 'vtt' | 'ttml'; objectKey?: string }[]
): Promise<string> {
  const asset = await repo.create({ name: 'clip', objectKey: 'sources/clip.mp4' });
  if (tracks) {
    await repo.update(asset.id, { subtitleTracks: tracks });
  }
  return asset.id;
}

describe('POST /:id/transcode burn-in generation race (issue #389)', () => {
  it('ready path: sidecar object exists and is non-empty => 202 and the subtitles filter is carried', async () => {
    const key = 'subtitles/asset-1/track-1.vtt';
    const h = await buildApp({ [key]: 1234 });
    const id = await seedAsset(h.repo);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      payload: {
        profile: 'program',
        burnIn: { source: { type: 'sidecarKey', objectKey: key } }
      }
    });

    expect(res.statusCode).toBe(202);
    // Encore submit was invoked exactly once and carries the subtitles filter.
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0].profileParams?.['subtitlesFilter']).toBe(`subtitles=${key}`);
  });

  it('not-ready path: sidecar object is ABSENT => 409 burn_in_source_not_available and NO Encore submit', async () => {
    // Object store is empty: the caller-supplied key does not exist.
    const key = 'subtitles/asset-1/missing.vtt';
    const h = await buildApp({});
    const id = await seedAsset(h.repo);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      payload: {
        profile: 'program',
        burnIn: { source: { type: 'sidecarKey', objectKey: key } }
      }
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('burn_in_source_not_available');
    expect(body.message).toContain(key);
    // The race is closed: a burned rendition is NEVER dispatched with a missing
    // sidecar — the fake Encore client's submit was NOT invoked.
    expect(h.submitted).toHaveLength(0);
  });

  it('empty-object path: sidecar exists but is zero-length => 409 and NO Encore submit', async () => {
    const key = 'subtitles/asset-1/empty.vtt';
    const h = await buildApp({ [key]: 0 });
    const id = await seedAsset(h.repo);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      payload: {
        profile: 'program',
        burnIn: { source: { type: 'sidecarKey', objectKey: key } }
      }
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('burn_in_source_not_available');
    expect(body.message).toContain('empty');
    expect(h.submitted).toHaveLength(0);
  });

  it('forced-race: track has an objectKey but the object has not landed (absent) => 409, no dispatch', async () => {
    // The generation callback set track.objectKey, but the bytes are not in the
    // store yet — exactly the fire-and-forget race this issue closes.
    const trackKey = 'subtitles/asset-1/track-9.vtt';
    const h = await buildApp({}); // object NOT present
    const id = await seedAsset(h.repo, [
      { id: 'track-9', language: 'en', format: 'vtt', objectKey: trackKey }
    ]);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      payload: {
        profile: 'program',
        burnIn: { source: { type: 'subtitleTrack', trackId: 'track-9' } }
      }
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('burn_in_source_not_available');
    expect(body.message).toContain(trackKey);
    expect(h.submitted).toHaveLength(0);
  });

  it('forced-race: track has an objectKey but the landed object is empty => 409, no dispatch', async () => {
    const trackKey = 'subtitles/asset-1/track-empty.vtt';
    const h = await buildApp({ [trackKey]: 0 });
    const id = await seedAsset(h.repo, [
      { id: 'track-empty', language: 'en', format: 'vtt', objectKey: trackKey }
    ]);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      payload: {
        profile: 'program',
        burnIn: { source: { type: 'subtitleTrack', trackId: 'track-empty' } }
      }
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('burn_in_source_not_available');
    expect(h.submitted).toHaveLength(0);
  });

  it('subtitleTrack ready: track objectKey present AND object landed non-empty => 202, filter set', async () => {
    const trackKey = 'subtitles/asset-1/track-ok.srt';
    const h = await buildApp({ [trackKey]: 512 });
    const id = await seedAsset(h.repo, [
      { id: 'track-ok', language: 'en', format: 'srt', objectKey: trackKey }
    ]);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      payload: {
        profile: 'program',
        burnIn: { source: { type: 'subtitleTrack', trackId: 'track-ok' } }
      }
    });

    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0].profileParams?.['subtitlesFilter']).toBe(`subtitles=${trackKey}`);
  });

  it('#388 case still holds: referenced track with NO objectKey => 409 burn_in_source_not_ready, no dispatch, no stat', async () => {
    // Distinct from the object-existence race: here there is NO key to stat at
    // all, so #388's not_ready error fires before the availability check.
    const h = await buildApp({});
    const id = await seedAsset(h.repo, [{ id: 'track-x', language: 'en', format: 'vtt' }]);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      payload: {
        profile: 'program',
        burnIn: { source: { type: 'subtitleTrack', trackId: 'track-x' } }
      }
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('burn_in_source_not_ready');
    expect(h.submitted).toHaveLength(0);
  });

  it('clean path: no burnIn => 202, unaffected, no subtitles filter', async () => {
    const h = await buildApp({});
    const id = await seedAsset(h.repo);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      payload: { profile: 'program' }
    });

    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0].profileParams?.['subtitlesFilter']).toBeUndefined();
  });
});

// Styling/positioning contract + force_style hardening (issue #390). The default
// styling is whatever the sidecar carries; `forceStyle` is an OPTIONAL, VALIDATED
// override. These tests prove: (a) an allowlisted style is composed correctly into
// the filter that reaches Encore; (b) an injection/breakout attempt is REJECTED at
// request time with a 422 and NEVER reaches the composed filter / Encore submit.
describe('POST /:id/transcode burn-in styling contract (issue #390)', () => {
  it('composes a valid allowlisted forceStyle into the subtitles filter (202)', async () => {
    const key = 'subtitles/asset-1/track-1.vtt';
    const h = await buildApp({ [key]: 1234 });
    const id = await seedAsset(h.repo);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      payload: {
        profile: 'program',
        burnIn: {
          source: { type: 'sidecarKey', objectKey: key },
          forceStyle: 'FontName=Sans,FontSize=24,Alignment=2,MarginV=40'
        }
      }
    });

    expect(res.statusCode).toBe(202);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0].profileParams?.['subtitlesFilter']).toBe(
      `subtitles=${key}:force_style='FontName=Sans,FontSize=24,Alignment=2,MarginV=40'`
    );
  });

  it('REJECTS a filter-injection breakout attempt with 422 and NEVER submits to Encore', async () => {
    const key = 'subtitles/asset-1/track-1.vtt';
    const h = await buildApp({ [key]: 1234 });
    const id = await seedAsset(h.repo);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      payload: {
        profile: 'program',
        burnIn: {
          source: { type: 'sidecarKey', objectKey: key },
          // Attempts to close force_style='...' and chain a second filter.
          forceStyle: "FontName=X',subtitles=evil.srt"
        }
      }
    });

    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('burn_in_invalid_force_style');
    // The malicious fragment never reached a composed filter or Encore.
    expect(h.submitted).toHaveLength(0);
    expect(res.payload).not.toContain('evil');
  });

  it('REJECTS a non-allowlisted style key with 422', async () => {
    const key = 'subtitles/asset-1/track-1.vtt';
    const h = await buildApp({ [key]: 1234 });
    const id = await seedAsset(h.repo);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      payload: {
        profile: 'program',
        burnIn: {
          source: { type: 'sidecarKey', objectKey: key },
          forceStyle: 'Evil=1'
        }
      }
    });

    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('burn_in_invalid_force_style');
    expect(h.submitted).toHaveLength(0);
  });
});
