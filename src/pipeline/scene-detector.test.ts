// Orchestration tests for the scene-detection pipeline step (issues #115, #798).
//
// The case that matters for #798: when the detector reports that the backing
// service structurally cannot produce cut timecodes, `detectScenes` must NOT
// persist `{ boundaries: [], sceneCount: 0 }` — that record asserts "this video has
// no scene cuts" and an API consumer cannot tell it apart from a genuine
// single-shot video.
//
// Contract source for the persisted shape: `openapi.json`
// `paths./api/v1/assets/{id}.get.responses.200...properties.sceneMetadata` —
// `required: ["boundaries","sceneCount","detectedAt"]`, `additionalProperties:
// false`, `nullable: true`; mirrored by `SceneMetadata` in src/data/asset-repo.ts.
// `additionalProperties: false` is why the gap cannot simply be recorded as an extra
// field on `sceneMetadata` without a ux-owned contract change.

import { describe, it, expect, vi } from 'vitest';
import { detectScenes, parseSceneResult, type SceneDetector } from './scene-detector.js';
import type { AssetRepository } from '../data/asset-repo.js';
import type { WorkspaceStorage } from '../data/storage.js';

function deps(detect: SceneDetector) {
  const update = vi.fn(async (_id: string, _patch: Record<string, unknown>) => ({}) as never);
  return {
    update,
    deps: {
      assets: { update } as unknown as AssetRepository,
      storage: {
        presignedGet: vi.fn(async () => 'https://minio.example/presigned')
      } as unknown as WorkspaceStorage,
      detect,
      ttlSeconds: 60
    }
  };
}

const PARAMS = { assetId: 'asset-1', objectKey: 'w/asset-1/source.mp4' };

describe('parseSceneResult', () => {
  it('normalizes structured scenes', () => {
    const md = parseSceneResult(
      { scenes: [{ startSeconds: 0, endSeconds: 4.5 }, { keyframeSeconds: 9 }] },
      '2026-09-26T00:00:00.000Z'
    );
    expect(md.sceneCount).toBe(2);
    expect(md.boundaries[0]).toEqual({ startSeconds: 0, endSeconds: 4.5 });
    expect(md.boundaries[1]).toEqual({ keyframeSeconds: 9 });
  });

  it('derives windows from bare, unsorted cut points', () => {
    const md = parseSceneResult({ cuts: [8, 2] }, '2026-09-26T00:00:00.000Z');
    expect(md.boundaries).toEqual([
      { startSeconds: 2, keyframeSeconds: 2, endSeconds: 8 },
      { startSeconds: 8, keyframeSeconds: 8 }
    ]);
  });
});

describe('detectScenes', () => {
  it('writes sceneMetadata when the detector reports boundaries', async () => {
    const { update, deps: d } = deps(async () => ({ cuts: [1, 2] }));
    await detectScenes(PARAMS, d);
    const patch = update.mock.calls[0]![1] as unknown as { sceneMetadata: { sceneCount: number } };
    expect(patch.sceneMetadata.sceneCount).toBe(2);
  });

  it('records sceneDetectionError on a genuine detection failure', async () => {
    const { update, deps: d } = deps(async () => {
      throw new Error('scene-detect job ended in state "failed"');
    });
    await detectScenes(PARAMS, d);
    expect(update.mock.calls[0]![1]).toEqual({
      sceneMetadata: null,
      sceneDetectionError: 'scene-detect job ended in state "failed"'
    });
  });

  it('never throws into its detached caller, even if the error write fails', async () => {
    const { deps: d } = deps(async () => {
      throw new Error('boom');
    });
    d.assets = {
      update: vi.fn(async () => {
        throw new Error('db down');
      })
    } as unknown as AssetRepository;
    await expect(detectScenes(PARAMS, d)).resolves.toBeUndefined();
  });

  // #798 — the blocking behaviour.
  it('writes NOTHING when boundaries are structurally unavailable', async () => {
    const onBoundariesUnavailable = vi.fn();
    const { update, deps: d } = deps(async () => ({
      boundariesUnavailable: { reason: 'service reports keyframe images only' }
    }));
    await detectScenes(PARAMS, { ...d, onBoundariesUnavailable });

    // No fabricated `sceneCount: 0`, and no fake sceneDetectionError either — the
    // job genuinely succeeded, it just cannot answer the question.
    expect(update).not.toHaveBeenCalled();
    expect(onBoundariesUnavailable).toHaveBeenCalledWith('service reports keyframe images only');
  });

  it('still writes a genuine zero-boundary result, so the two stay distinguishable', async () => {
    // A detector that really did analyse the video and found no cuts reports
    // `cuts: []` with no `boundariesUnavailable`; that must persist as
    // `sceneCount: 0`. This is the outcome the case above must not be confused with.
    const { update, deps: d } = deps(async () => ({ cuts: [] }));
    await detectScenes(PARAMS, d);
    const patch = update.mock.calls[0]![1] as unknown as {
      sceneMetadata: { sceneCount: number; boundaries: unknown[] };
    };
    expect(patch.sceneMetadata.sceneCount).toBe(0);
    expect(patch.sceneMetadata.boundaries).toEqual([]);
  });
});
