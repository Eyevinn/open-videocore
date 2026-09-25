// @vitest-environment happy-dom
//
// Parity between the ops UI's pipeline catalog and the backend's pipeline
// definitions (issue #739).
//
// `PIPELINE_CATALOG` (public/app.js) is a hand-maintained copy of the server's
// `BUILT_IN_PIPELINES` / `PIPELINE_DESCRIPTIONS` (src/pipeline/pipelines.ts). The
// UI picker renders from the copy while `POST /api/v1/assets/:id/execute`
// validates against `PIPELINE_NAMES`, which derives from `BUILT_IN_PIPELINES` —
// so a drift means the UI either offers a pipeline the API rejects, or hides one
// it accepts, or describes a pipeline's steps wrongly. Nothing asserted that
// before; this does.
//
// Contracts verified (not guessed):
//   - `BUILT_IN_PIPELINES`, `PIPELINE_DESCRIPTIONS`, `PIPELINE_NAMES` —
//     src/pipeline/pipelines.ts.
//   - `PIPELINE_CATALOG` entries are `{ name, label, description, steps }` —
//     public/app.js (consumed by the picker at app.js:1672 and the pipelines tab
//     at app.js:4546).

import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_PIPELINES,
  PIPELINE_DESCRIPTIONS,
  PIPELINE_NAMES
} from '../src/pipeline/pipelines.js';
import { PIPELINE_CATALOG } from '../public/app.js';

type CatalogEntry = { name: string; label: string; description: string; steps: string[] };

const catalog = PIPELINE_CATALOG as CatalogEntry[];

describe('UI PIPELINE_CATALOG parity with backend pipelines (issue #739)', () => {
  it('lists exactly the built-in pipelines the execute enum accepts, in order', () => {
    expect(catalog.map((p) => p.name)).toEqual([...PIPELINE_NAMES]);
  });

  it('carries the same steps as BUILT_IN_PIPELINES for every pipeline', () => {
    for (const entry of catalog) {
      expect(entry.steps, `steps for "${entry.name}"`).toEqual(BUILT_IN_PIPELINES[entry.name]);
    }
  });

  it('carries the same description as PIPELINE_DESCRIPTIONS for every pipeline', () => {
    for (const entry of catalog) {
      expect(entry.description, `description for "${entry.name}"`).toBe(
        PIPELINE_DESCRIPTIONS[entry.name]
      );
    }
  });

  it('gives every pipeline a non-empty human label', () => {
    for (const entry of catalog) {
      expect(entry.label.trim().length, `label for "${entry.name}"`).toBeGreaterThan(0);
    }
  });
});
