// Editorial review-state read contract (issue #897, prerequisite for #792).
//
// The review state machine (issue #134) is enforced server-side: an illegal
// move is refused with 422. Until now a client had no way to know WHICH moves
// were legal without copying the graph, so the only way to find out was to try
// one and read the 422. These tests pin the read side of that contract:
//   - GET /:id/review-state returns the current state plus `allowedTransitions`
//   - the advertised set is EXACTLY the graph the 422 gate enforces, checked
//     exhaustively over every (from, to) pair through the real routes — so the
//     advertised and enforced graphs cannot drift apart silently
//   - the re-review paths are named explicitly: `approved` and `rejected` both
//     go back to `in-review` and to nothing else; nothing ever returns to
//     `draft`
//   - an asset with no stored reviewState reads as `draft` with draft's moves
//   - the current state is never advertised as a transition, even though
//     re-sending it is accepted as an idempotent no-op

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from './assets.js';
import {
  ASSET_REVIEW_STATES,
  InMemoryAssetRepository,
  allowedReviewTransitions,
  isValidReviewTransition,
  type Asset,
  type AssetReviewState
} from '../data/asset-repo.js';

type ReviewStateRead = {
  reviewState: AssetReviewState;
  allowedTransitions: AssetReviewState[];
};

async function buildApp(repo: InMemoryAssetRepository) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo });
  await app.ready();
  return app;
}

// The legal walk that lands an asset in each state. Review state is independent
// of the lifecycle `status`, so a freshly created (`uploading`) asset is fine.
const WALK: Record<AssetReviewState, AssetReviewState[]> = {
  draft: [],
  'in-review': ['in-review'],
  approved: ['in-review', 'approved'],
  rejected: ['in-review', 'rejected']
};

async function createAssetIn(
  repo: InMemoryAssetRepository,
  app: Awaited<ReturnType<typeof buildApp>>,
  state: AssetReviewState
): Promise<Asset> {
  const asset = await repo.create({ name: `review-${state}` });
  for (const step of WALK[state]) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/review-state`,
      payload: { reviewState: step }
    });
    expect(res.statusCode).toBe(200);
  }
  return asset;
}

async function readReviewState(
  app: Awaited<ReturnType<typeof buildApp>>,
  id: string
): Promise<ReviewStateRead> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/review-state` });
  expect(res.statusCode).toBe(200);
  return res.json() as ReviewStateRead;
}

describe('GET /assets/:id/review-state (issue #897)', () => {
  it('reports draft and its single legal move for a never-submitted asset', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);
    const asset = await repo.create({ name: 'fresh' });

    // Nothing was ever written to the field — the read still reports a concrete
    // state rather than an absent one.
    expect((await repo.get(asset.id))?.reviewState).toBeUndefined();

    expect(await readReviewState(app, asset.id)).toEqual({
      reviewState: 'draft',
      allowedTransitions: ['in-review']
    });
  });

  it('advertises the exact transition graph from every state', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);

    const expected: Record<AssetReviewState, AssetReviewState[]> = {
      draft: ['in-review'],
      'in-review': ['approved', 'rejected'],
      // The re-review paths, named explicitly: both verdicts return to
      // `in-review`, and neither returns to `draft`.
      approved: ['in-review'],
      rejected: ['in-review']
    };

    for (const state of ASSET_REVIEW_STATES) {
      const asset = await createAssetIn(repo, app, state);
      const read = await readReviewState(app, asset.id);
      expect(read.reviewState).toBe(state);
      expect(read.allowedTransitions).toEqual(expected[state]);
    }
  });

  it('never returns to draft from any state', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);

    for (const state of ASSET_REVIEW_STATES) {
      const asset = await createAssetIn(repo, app, state);
      const read = await readReviewState(app, asset.id);
      expect(read.allowedTransitions).not.toContain('draft');
    }
  });

  it('advertises exactly what the 422 gate accepts, for every (from, to) pair', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);

    for (const from of ASSET_REVIEW_STATES) {
      for (const to of ASSET_REVIEW_STATES) {
        const asset = await createAssetIn(repo, app, from);
        const advertised = (await readReviewState(app, asset.id)).allowedTransitions;

        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/assets/${asset.id}/review-state`,
          payload: { reviewState: to }
        });

        if (to === from) {
          // Idempotent no-op: accepted, but deliberately NOT advertised as a
          // move — a client must not render a button that changes nothing.
          expect(res.statusCode).toBe(200);
          expect(advertised).not.toContain(to);
          continue;
        }

        if (advertised.includes(to)) {
          expect(res.statusCode).toBe(200);
          expect((res.json() as Asset).reviewState).toBe(to);
        } else {
          expect(res.statusCode).toBe(422);
          expect((res.json() as { error: string }).error).toBe('invalid_review_transition');
          // The refused move left the state alone.
          expect((await readReviewState(app, asset.id)).reviewState).toBe(from);
        }
      }
    }
  });

  it('returns 404 for an unknown asset without leaking existence', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/01HZZZZZZZZZZZZZZZZZZZZZZZ/review-state'
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });
});

describe('allowedReviewTransitions() (issue #897)', () => {
  it('agrees with isValidReviewTransition on every pair, self-transitions aside', () => {
    for (const from of ASSET_REVIEW_STATES) {
      const allowed = allowedReviewTransitions(from);
      for (const to of ASSET_REVIEW_STATES) {
        if (to === from) {
          expect(allowed).not.toContain(to);
          continue;
        }
        expect(allowed.includes(to)).toBe(isValidReviewTransition(from, to));
      }
    }
  });

  it('defaults an absent state to draft', () => {
    expect(allowedReviewTransitions(undefined)).toEqual(allowedReviewTransitions('draft'));
  });

  it('returns a copy, so a caller cannot mutate the transition table', () => {
    const first = allowedReviewTransitions('in-review');
    first.push('draft');
    expect(allowedReviewTransitions('in-review')).toEqual(['approved', 'rejected']);
  });
});
