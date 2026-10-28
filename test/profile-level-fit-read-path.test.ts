// Level-safe ladder fitting on the READ/PUBLISH path, plus the portrait
// transpose in the geometry prediction (issue #1167 review, findings 1-3).
//
// WHAT THESE PIN.
//   1. The two surfaces the transcoding service actually reads — the per-profile
//      YAML document (`GET /api/v1/profiles/:name/yaml`) and the published
//      object-store mirror (`publishProfileIndex`) — are level-safe regardless of
//      how the profile got into the store, including an operator `POST`/`PUT` of
//      a height-only rung that declares an H.264 level (finding 3: neither write
//      route applied the fit, so the bug was re-authorable at any time).
//   2. The STORED document is left exactly as authored: the management reads
//      (`GET /api/v1/profiles/:name`) still return the operator's bytes, which is
//      why fitting at the read path is preferable to rewriting on write.
//   3. The portrait transpose the encoder applies before scaling (finding 1):
//      `flipWidthHeightIfPortrait` is ON by default upstream, so a portrait
//      source against a landscape box is fitted into the TRANSPOSED box.
//
// CONTRACT SOURCES (CLAUDE.md rule 7), all fetched 2026-10-19 via the GitHub
// contents API against svt/encore's default branch:
//   - `encore-common/src/main/kotlin/se/svt/oss/encore/model/profile/VideoEncode.kt`
//     `fun videoFilter(debugOverlay, encodingProperties, videoInput)`:
//       val outputIsPortrait = outputDar < Fraction.ONE
//       val isScalingWithinLandscape = scaleToWidth != null && scaleToHeight != null &&
//         Fraction(scaleToWidth, scaleToHeight) > Fraction.ONE
//       if (encodingProperties.flipWidthHeightIfPortrait && outputIsPortrait &&
//           isScalingWithinLandscape) { scaleToWidth = height; scaleToHeight = width }
//       then `scale=$scaleToWidth:$scaleToHeight:force_original_aspect_ratio=decrease:force_divisible_by=2`
//     — `outputDar` prefers the analyzed stream's `displayAspectRatio` (reciprocal
//     when the stream is rotated 90 degrees) over `Fraction(width, height)`.
//   - `encore-common/src/main/kotlin/se/svt/oss/encore/config/EncodingProperties.kt`:
//     `val flipWidthHeightIfPortrait: Boolean = true`.
//   - src/pipeline/profile-level-fit.ts — `levelSafeProfileYaml(yaml: string):
//     string`, `predictScaledOutput(source, box, opts?)`,
//     `fitProfileLadderToLevel(yaml): LadderFitResult`, `frameSizeMbs(w, h)`,
//     `lookupH264Level(value)`.
//   - src/routes/profiles.ts — `profilesRouter` options `{ repository,
//     bootstrapIndexUrl, onProfilesChanged? }`; `GET /:name/yaml` responds 200
//     `text/yaml`, `GET /:name` responds with `{ name, yaml, runnable, createdAt,
//     updatedAt }`.
//   - src/services/profile-index-publisher.ts — `publishProfileIndex({
//     storageClient, objectStoreEndpoint, resolveEndpoint?, listProfiles, bucket?,
//     log? }): Promise<PublishOutcome>`, `ProfilesBucketClient` ({ bucketExists,
//     putObject(bucket, key, body, size, meta?), setBucketPolicy }),
//     `publishedProfileObjectKey(name)`, `PROFILES_BUCKET`.

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { profilesRouter } from '../src/routes/profiles.js';
import { InMemoryProfileRepository } from '../src/data/inmemory-profile-repo.js';
import {
  fitProfileLadderToLevel,
  levelSafeProfileYaml,
  predictScaledOutput,
  frameSizeMbs,
  lookupH264Level
} from '../src/pipeline/profile-level-fit.js';
import {
  publishProfileIndex,
  publishedProfileObjectKey,
  PROFILES_BUCKET,
  type ProfilesBucketClient
} from '../src/services/profile-index-publisher.js';

// A two-rung ladder in exactly the shape the reported failure needs: a height,
// a declared level, NO width. This is what an operator can author through
// POST/PUT today.
const OPERATOR_LADDER = `name: operator
encodes:
  - type: X264Encode
    suffix: _x264_3100
    height: 1080
    params:
      profile:v: high
      level: 4.1
    x264-params:
      ref: 4

  - type: X264Encode
    suffix: _x264_2069
    height: 720
    params:
      profile:v: main
      level: 3.1
    x264-params:
      ref: 4
`;

// The reported source: approximately-16:9, which is what overflows a height-only
// rung's declared level.
const REPORTED_SOURCE = { width: 854, height: 480 };

async function buildApp(repo: InMemoryProfileRepository): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(profilesRouter, {
    prefix: '/api/v1/profiles',
    repository: repo,
    bootstrapIndexUrl: 'https://example.test/profiles.yml'
  });
  await app.ready();
  return app;
}

function widthsOf(yaml: string): (number | undefined)[] {
  return yaml
    .split('\n')
    .filter((l) => /^\s*width\s*:/.test(l))
    .map((l) => Number(l.split(':')[1].trim()));
}

describe('levelSafeProfileYaml (the read/publish-path guard)', () => {
  it('is the fitted form of an unfitted ladder', () => {
    expect(levelSafeProfileYaml(OPERATOR_LADDER)).toBe(
      fitProfileLadderToLevel(OPERATOR_LADDER).yaml
    );
    expect(widthsOf(levelSafeProfileYaml(OPERATOR_LADDER))).toEqual([1920, 1280]);
  });

  it('returns its input unchanged when there is nothing to fit, and is idempotent', () => {
    const noLevel = 'name: x\nencodes:\n  - type: X264Encode\n    height: 1080\n';
    expect(levelSafeProfileYaml(noLevel)).toBe(noLevel);
    const once = levelSafeProfileYaml(OPERATOR_LADDER);
    expect(levelSafeProfileYaml(once)).toBe(once);
  });
});

describe('POST/PUT-authored ladders are served level-safe (finding 3)', () => {
  it('serves the fitted YAML for a profile created through POST', async () => {
    const repo = new InMemoryProfileRepository();
    const app = await buildApp(repo);
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/profiles',
        payload: { name: 'operator', yaml: OPERATOR_LADDER }
      });
      expect(created.statusCode).toBe(201);

      const served = await app.inject({ method: 'GET', url: '/api/v1/profiles/operator/yaml' });
      expect(served.statusCode).toBe(200);
      expect(served.headers['content-type']).toContain('text/yaml');
      expect(served.body).toBe(fitProfileLadderToLevel(OPERATOR_LADDER).yaml);
      expect(widthsOf(served.body)).toEqual([1920, 1280]);

      // ...and the reported source now fits every rung's declared level.
      for (const box of [
        { width: 1920, height: 1080, level: '4.1', ref: 4 },
        { width: 1280, height: 720, level: '3.1', ref: 4 }
      ]) {
        const out = predictScaledOutput(REPORTED_SOURCE, { width: box.width, height: box.height });
        const mbs = frameSizeMbs(out.width, out.height);
        const limits = lookupH264Level(box.level);
        expect(mbs).toBeLessThanOrEqual(limits?.maxFrameSizeMbs ?? 0);
        expect(mbs * box.ref).toBeLessThanOrEqual(limits?.maxDpbMbs ?? 0);
      }

      // The STORED document is still exactly what the operator authored.
      expect((await repo.get('operator'))?.yaml).toBe(OPERATOR_LADDER);
      const management = await app.inject({ method: 'GET', url: '/api/v1/profiles/operator' });
      expect(management.json()).toMatchObject({ name: 'operator', yaml: OPERATOR_LADDER });
    } finally {
      await app.close();
    }
  });

  it('serves the fitted YAML after a PUT replaces a fitted ladder with an unfitted one', async () => {
    const repo = new InMemoryProfileRepository();
    await repo.create({ name: 'operator', yaml: fitProfileLadderToLevel(OPERATOR_LADDER).yaml });
    const app = await buildApp(repo);
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/v1/profiles/operator',
        payload: { yaml: OPERATOR_LADDER }
      });
      expect(put.statusCode).toBe(200);

      const served = await app.inject({ method: 'GET', url: '/api/v1/profiles/operator/yaml' });
      expect(widthsOf(served.body)).toEqual([1920, 1280]);
    } finally {
      await app.close();
    }
  });
});

describe('the published object-store mirror is level-safe (finding 2)', () => {
  it('publishes the fitted YAML for a stored-unfitted profile', async () => {
    const puts: { key: string; body: string }[] = [];
    const client: ProfilesBucketClient = {
      bucketExists: async () => true,
      putObject: async (_bucket, key, body) => {
        puts.push({ key, body: typeof body === 'string' ? body : body.toString('utf8') });
        return {};
      },
      setBucketPolicy: async () => undefined
    };

    const outcome = await publishProfileIndex({
      storageClient: client,
      objectStoreEndpoint: 'https://store.example.test',
      listProfiles: async () => [{ name: 'operator', yaml: OPERATOR_LADDER }]
    });
    expect(outcome.ok).toBe(true);

    const published = puts.find((p) => p.key === publishedProfileObjectKey('operator'));
    expect(published?.body).toBe(fitProfileLadderToLevel(OPERATOR_LADDER).yaml);
    expect(widthsOf(published?.body ?? '')).toEqual([1920, 1280]);
    // The index itself is unchanged by the fit (it maps names to object keys).
    expect(puts.find((p) => p.key === 'index.yml')?.body).toBe('operator: operator.yml\n');
    expect(PROFILES_BUCKET).toBe('openvideocore-profiles');
  });

  it('publishes a profile with nothing to fit byte-identically', async () => {
    const plain = 'name: plain\nvideoEncodes:\n  - codec: libx264\n';
    const puts: { key: string; body: string }[] = [];
    const client: ProfilesBucketClient = {
      bucketExists: async () => true,
      putObject: async (_bucket, key, body) => {
        puts.push({ key, body: typeof body === 'string' ? body : body.toString('utf8') });
        return {};
      },
      setBucketPolicy: async () => undefined
    };
    await publishProfileIndex({
      storageClient: client,
      objectStoreEndpoint: 'https://store.example.test',
      listProfiles: async () => [{ name: 'plain', yaml: plain }]
    });
    expect(puts.find((p) => p.key === publishedProfileObjectKey('plain'))?.body).toBe(plain);
  });
});

describe('portrait transpose in the predicted geometry (finding 1)', () => {
  // A 1080x1920 portrait source against the fitted 1080 rung's 1920x1080 box.
  const PORTRAIT = { width: 1080, height: 1920 };

  it('transposes a landscape box for a portrait source (flag ON by default)', () => {
    expect(predictScaledOutput(PORTRAIT, { width: 1920, height: 1080 })).toEqual({
      width: 1080,
      height: 1920
    });
    expect(predictScaledOutput(PORTRAIT, { width: 1280, height: 720 })).toEqual({
      width: 720,
      height: 1280
    });
  });

  it('models the flag being turned off (letterboxed inside the landscape box)', () => {
    expect(
      predictScaledOutput(PORTRAIT, { width: 1920, height: 1080 }, {
        flipWidthHeightIfPortrait: false
      })
    ).toEqual({ width: 608, height: 1080 });
  });

  it('does not transpose a landscape or square source, or a non-landscape box', () => {
    // Landscape source: unchanged behaviour (this is the no-regression case).
    expect(predictScaledOutput({ width: 1920, height: 1080 }, { width: 1920, height: 1080 })).toEqual(
      { width: 1920, height: 1080 }
    );
    // Square source is NOT portrait (upstream compares outputDar < 1 strictly).
    expect(predictScaledOutput({ width: 1080, height: 1080 }, { width: 1920, height: 1080 })).toEqual(
      { width: 1080, height: 1080 }
    );
    // Square box is NOT "scaling within landscape" (Fraction(w,h) > 1 strictly).
    expect(predictScaledOutput(PORTRAIT, { width: 1080, height: 1080 })).toEqual({
      width: 608,
      height: 1080
    });
    // A portrait box is already portrait: nothing to transpose.
    expect(predictScaledOutput(PORTRAIT, { width: 1080, height: 1920 })).toEqual({
      width: 1080,
      height: 1920
    });
  });

  it('honours a display aspect ratio that disagrees with the pixel dimensions', () => {
    // Upstream prefers the analyzed stream's DAR, and takes its reciprocal for a
    // 90-degree rotation — so a stream whose pixel dimensions are landscape but
    // whose DAR is portrait transposes the box (and vice versa). Only the
    // transpose decision is driven by the DAR; the fit itself still uses the
    // source's pixel dimensions, as ffmpeg does.
    expect(
      predictScaledOutput({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }, {
        displayAspectRatio: { width: 9, height: 16 }
      })
    ).toEqual({ width: 1080, height: 608 });
    expect(
      predictScaledOutput(PORTRAIT, { width: 1920, height: 1080 }, {
        displayAspectRatio: { width: 16, height: 9 }
      })
    ).toEqual({ width: 608, height: 1080 });
  });

  it('leaves a height-only rung on the untransposed scale=-2:H path', () => {
    // Upstream only transposes when BOTH box dimensions are set
    // (isScalingWithinLandscape requires scaleToWidth != null && scaleToHeight != null).
    expect(predictScaledOutput(PORTRAIT, { height: 1080 })).toEqual({ width: 608, height: 1080 });
  });

  it('keeps a portrait source inside every fitted rung, with the transposed geometry', () => {
    // The macroblock bound of a box is transpose-invariant
    // (ceil(w/16)*ceil(h/16)), so the widths the fit computed hold for portrait
    // material too — this is why modelling the transpose does not change the fit.
    const rungs = [
      { width: 1920, height: 1080, level: '4.1', ref: 4 },
      { width: 1280, height: 720, level: '3.1', ref: 4 },
      { width: 960, height: 540, level: '3.1', ref: 4 },
      { width: 640, height: 360, level: '3.1', ref: 4 },
      { width: 416, height: 234, level: '3.1', ref: 3 }
    ];
    for (const rung of rungs) {
      const out = predictScaledOutput(PORTRAIT, { width: rung.width, height: rung.height });
      expect({ rung: rung.height, portrait: out.height > out.width }).toEqual({
        rung: rung.height,
        portrait: true
      });
      const mbs = frameSizeMbs(out.width, out.height);
      const limits = lookupH264Level(rung.level);
      expect({
        rung: rung.height,
        frameFits: mbs <= (limits?.maxFrameSizeMbs ?? 0),
        dpbFits: mbs * rung.ref <= (limits?.maxDpbMbs ?? 0)
      }).toEqual({ rung: rung.height, frameFits: true, dpbFits: true });
    }
  });
});
