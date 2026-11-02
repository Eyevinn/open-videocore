// @vitest-environment happy-dom
//
// Parametrised profiles in the ops UI run control (issue #869).
//
// A parametrised profile exposes knobs through SpEL — `#{profileParams['crf']?:23}`
// — but the run control could only name a profile, so such a profile could only
// ever run with its built-in defaults even though the API has accepted overrides
// since #287/#288. These tests cover the client only; the server side is already
// pinned by test/profile-params-allowlist.test.ts and
// test/execute-profile-params.test.ts.
//
// CONTRACT GROUNDING (CLAUDE.md rule 7) — every field below was read from this
// repo's own route source and generated spec, never from the issue text:
//
//   POST /api/v1/assets/{id}/execute — openapi.json
//     .paths["/api/v1/assets/{id}/execute"].post.requestBody: object,
//     `required: ["pipeline"]`, `additionalProperties: false`, with the optional
//     siblings `profile` (string, minLength 1) and
//     `profileParams: { type: 'object', additionalProperties: { type: 'string' } }`.
//     So profileParams is a TOP-LEVEL FLAT STRING MAP next to `profile`.
//     Schema source: src/routes/assets.ts:433
//     (`profileParams: profileParamsSchema.optional()`) over
//     src/routes/assets.ts:376 (`z.record(z.string(), z.string())`). The spec
//     assigns this operation no operationId; it is keyed by path + method.
//
//   400 `unknown_profile_params` — a key the chosen profile does not declare is
//     rejected at submit time with a `message` naming the accepted set
//     (src/routes/assets.ts:5695-5760 -> validateProfileParams,
//     src/pipeline/profile-params.ts:132-138). apiFetch prefers `body.message`
//     (public/app.js:573), so that sentence is the one the operator reads.
//
//   GET /api/v1/profiles — 200 `{ profiles: string[], items: [{ name, yaml,
//     runnable, createdAt, updatedAt }] }` (listResponseSchema,
//     src/routes/profiles.ts:121-124; `items` built at :173). The picker reads
//     the declared params off `items[].yaml` — the same document the Profiles
//     tab's View YAML button shows and the one the server derives its accepted
//     key set from.
//
// The accepted key set is DERIVED from the YAML, so the first describe asserts
// the UI extractor agrees with the SERVER's own `declaredProfileParamKeys`
// (src/pipeline/profile-params.ts) rather than with a hand-written list — if the
// two ever drift, the form would offer keys the API would reject.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { declaredProfileParamKeys } from '../src/pipeline/profile-params.js';
import {
  collectProfileParams,
  declaredProfileParams,
  profileOptionLabel,
  renderAssetDetailBody,
  renderProfileParamsForm,
} from '../public/app.js';

// SpEL param references copied verbatim from the fetched profile YAML documents
// (same fixtures as test/profile-params-allowlist.test.ts).
const X264_CRF_PARAMETRIZED_YAML = `name: x264-crf-parametrized
description: Program profile
scaling: bicubic
encodes:
  - type: X264Encode
    suffix: _x264_#{profileParams['preset']?:"medium"}_crf_#{profileParams['crf']?:23}
    twoPass: false
    height: #{profileParams['height']?:1080}
    params:
      crf: #{profileParams['crf']?:23}
      force_key_frames: #{profileParams['keyframes']?:'expr:not(mod(n,96))'}
      preset: #{profileParams['preset']?:"medium"}
`;

const PROGRAM_YAML = `name: program
description: Program profile
encodes:
  - type: X264Encode
    params:
      force_key_frames: expr:not(mod(n,96))
`;

const ULID = '01J8YYYYYYYYYYYYYYYYYYYYYY';

const READY_ASSET = {
  id: ULID,
  name: 'trailer.mov',
  slug: 'trailer',
  status: 'ready',
  statusHistory: [{ at: '2026-10-20T10:00:00.000Z', from: null, to: 'ready' }],
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
};

const PROFILES_BODY = {
  // `profiles` is the picker's selectable (runnable, "none"-free) name list.
  profiles: ['program', 'x264-crf-parametrized'],
  items: [
    {
      name: 'program',
      yaml: PROGRAM_YAML,
      runnable: true,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
    {
      name: 'x264-crf-parametrized',
      yaml: X264_CRF_PARAMETRIZED_YAML,
      runnable: true,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
};

type Executed = { body: Record<string, unknown> };

// Routes the handful of reads renderAssetDetailBody performs, and records the
// execute POST body. `executeFailure` turns the execute call into the API's own
// 400 `unknown_profile_params` response.
function routedFetch(
  executed: Executed[],
  executeFailure?: { error: string; message: string }
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (/\/execute$/.test(path)) {
      executed.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      if (executeFailure) return json(executeFailure, 400);
      return json({ id: 'exec-1', pipelineName: 'transcode', status: 'running', steps: [] }, 202);
    }
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json(PROFILES_BODY);
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(READY_ASSET);
    return json({}, 200);
  });
}

function selectProfile(container: HTMLElement, name: string) {
  const sel = container.querySelector('#profile-select') as HTMLSelectElement;
  sel.value = name;
  sel.dispatchEvent(new Event('change'));
  return sel;
}

describe('declaredProfileParams — derived from the profile YAML (issue #869)', () => {
  it('extracts every declared key with its SpEL default, quotes stripped', () => {
    expect(declaredProfileParams(X264_CRF_PARAMETRIZED_YAML)).toEqual([
      { key: 'preset', defaultValue: 'medium' },
      { key: 'crf', defaultValue: '23' },
      { key: 'height', defaultValue: '1080' },
      { key: 'keyframes', defaultValue: 'expr:not(mod(n,96))' },
    ]);
  });

  it('offers exactly the key set the SERVER accepts for the same YAML', () => {
    const uiKeys = declaredProfileParams(X264_CRF_PARAMETRIZED_YAML)
      .map((p: { key: string }) => p.key)
      .sort();
    expect(uiKeys).toEqual([...declaredProfileParamKeys(X264_CRF_PARAMETRIZED_YAML)].sort());
  });

  it('treats a profile that references no profileParams as not parametrised', () => {
    expect(declaredProfileParams(PROGRAM_YAML)).toEqual([]);
    expect(declaredProfileParams(undefined)).toEqual([]);
  });

  it('handles double-quoted SpEL keys and a reference with no default', () => {
    expect(declaredProfileParams(`suffix: #{profileParams["crf"]?:23}`)).toEqual([
      { key: 'crf', defaultValue: '23' },
    ]);
    expect(declaredProfileParams(`suffix: #{profileParams['crf']}`)).toEqual([
      { key: 'crf', defaultValue: '' },
    ]);
  });
});

describe('profileOptionLabel — the picker marks a parametrised profile (issue #869)', () => {
  it('leaves a profile with no params exactly as it read before', () => {
    expect(profileOptionLabel('program', [])).toBe('program');
    expect(profileOptionLabel('program', undefined)).toBe('program');
  });

  it('states how many parameters a parametrised profile declares', () => {
    expect(profileOptionLabel('program-kf', [{ key: 'keyframes', defaultValue: '' }])).toBe(
      'program-kf — 1 parameter'
    );
    expect(
      profileOptionLabel('x264-crf-parametrized', declaredProfileParams(X264_CRF_PARAMETRIZED_YAML))
    ).toBe('x264-crf-parametrized — 4 parameters');
  });
});

describe('collectProfileParams — only edited values travel (issue #869)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => host.remove());

  it('sends nothing when every field still holds its declared default', () => {
    renderProfileParamsForm(
      host,
      'x264-crf-parametrized',
      declaredProfileParams(X264_CRF_PARAMETRIZED_YAML)
    );
    expect(collectProfileParams(host)).toEqual({});
  });

  it('sends only the edited keys, as strings', () => {
    renderProfileParamsForm(
      host,
      'x264-crf-parametrized',
      declaredProfileParams(X264_CRF_PARAMETRIZED_YAML)
    );
    (host.querySelector('#profile-param-crf') as HTMLInputElement).value = '30';
    (host.querySelector('#profile-param-preset') as HTMLInputElement).value = 'veryfast';
    expect(collectProfileParams(host)).toEqual({ crf: '30', preset: 'veryfast' });
  });

  it('treats a cleared field as "use the profile default" rather than an empty value', () => {
    renderProfileParamsForm(
      host,
      'x264-crf-parametrized',
      declaredProfileParams(X264_CRF_PARAMETRIZED_YAML)
    );
    (host.querySelector('#profile-param-crf') as HTMLInputElement).value = '   ';
    expect(collectProfileParams(host)).toEqual({});
  });
});

describe('asset detail run control — parametrised profile end to end (issue #869)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('marks the parametrised profile in the picker and leaves the plain one alone', async () => {
    vi.stubGlobal('fetch', routedFetch([]));

    await renderAssetDetailBody(ULID, container);

    const options = [].map.call(
      container.querySelectorAll('#profile-select option'),
      (o: HTMLOptionElement) => ({ value: o.value, text: o.textContent, title: o.title })
    ) as Array<{ value: string; text: string; title: string }>;
    const plain = options.find((o) => o.value === 'program');
    const parametrised = options.find((o) => o.value === 'x264-crf-parametrized');

    expect(plain?.text).toBe('program');
    // The option VALUE stays the bare profile name — that is what `profile`
    // carries on the wire — while the label says there is something to set.
    expect(parametrised?.value).toBe('x264-crf-parametrized');
    expect(parametrised?.text).toContain('4 parameters');
    expect(parametrised?.title).toContain('crf');
    expect(parametrised?.title).toContain('preset');

    // Nothing is drawn for the plain profile selected by default.
    expect(container.querySelector('#profile-params')).toBeNull();
  });

  it('renders one field per declared key, prefilled with the declared default', async () => {
    vi.stubGlobal('fetch', routedFetch([]));

    await renderAssetDetailBody(ULID, container);
    selectProfile(container, 'x264-crf-parametrized');

    const fieldset = container.querySelector('#profile-params');
    expect(fieldset).not.toBeNull();
    expect(fieldset?.tagName).toBe('FIELDSET');
    expect(fieldset?.querySelector('legend')?.textContent).toContain('x264-crf-parametrized');

    const inputs = [].map.call(
      container.querySelectorAll('.profile-param-input'),
      (i: HTMLInputElement) => [i.dataset.paramKey, i.value]
    );
    expect(inputs).toEqual([
      ['preset', 'medium'],
      ['crf', '23'],
      ['height', '1080'],
      ['keyframes', 'expr:not(mod(n,96))'],
    ]);

    // Every field keeps a real <label for>, and the group's hint is wired to
    // both the fieldset and the picker (WCAG 2.1 AA: labels + instructions).
    const crf = container.querySelector('#profile-param-crf') as HTMLInputElement;
    const label = container.querySelector('label[for="profile-param-crf"]');
    expect(label?.textContent).toBe('crf');
    expect(crf.type).toBe('text');
    expect(fieldset?.getAttribute('aria-describedby')).toBe('profile-params-hint');
    expect(container.querySelector('#profile-select')?.getAttribute('aria-describedby')).toBe(
      'profile-params-hint'
    );

    // Switching back to a profile with no params takes the form away again.
    selectProfile(container, 'program');
    expect(container.querySelector('#profile-params')).toBeNull();
  });

  it('posts no profileParams at all when nothing was edited — today’s behaviour, unchanged', async () => {
    const executed: Executed[] = [];
    vi.stubGlobal('fetch', routedFetch(executed));

    await renderAssetDetailBody(ULID, container);
    selectProfile(container, 'x264-crf-parametrized');
    (container.querySelector('#btn-run-pipeline') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(executed).toHaveLength(1));

    expect(executed[0].body).toEqual({ pipeline: 'transcode', profile: 'x264-crf-parametrized' });
    expect(executed[0].body).not.toHaveProperty('profileParams');
  });

  it('sends the edited values as a flat top-level string map', async () => {
    const executed: Executed[] = [];
    vi.stubGlobal('fetch', routedFetch(executed));

    await renderAssetDetailBody(ULID, container);
    selectProfile(container, 'x264-crf-parametrized');
    (container.querySelector('#profile-param-crf') as HTMLInputElement).value = '30';
    (container.querySelector('#profile-param-preset') as HTMLInputElement).value = 'veryfast';
    (container.querySelector('#btn-run-pipeline') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(executed).toHaveLength(1));

    // Sibling of `profile`, never nested; untouched keys (height, keyframes)
    // are absent so the profile's own defaults apply.
    expect(executed[0].body).toEqual({
      pipeline: 'transcode',
      profile: 'x264-crf-parametrized',
      profileParams: { preset: 'veryfast', crf: '30' },
    });
  });

  it('shows the API’s rejected-key message next to the fields, and keeps the edits', async () => {
    const executed: Executed[] = [];
    vi.stubGlobal(
      'fetch',
      routedFetch(executed, {
        error: 'unknown_profile_params',
        message:
          "unknown profileParams key: crfs — accepted keys for profile " +
          "'x264-crf-parametrized': crf, height, keyframes, preset",
      })
    );

    await renderAssetDetailBody(ULID, container);
    selectProfile(container, 'x264-crf-parametrized');
    (container.querySelector('#profile-param-crf') as HTMLInputElement).value = '30';
    (container.querySelector('#btn-run-pipeline') as HTMLButtonElement).click();

    const error = container.querySelector('#profile-params-error') as HTMLElement;
    await vi.waitFor(() => expect(error.textContent).toContain('accepted keys for profile'));
    // Announced where the fields are, without moving focus.
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('crf, height, keyframes, preset');
    // The page-level message reports the failure too...
    expect(container.querySelector('#action-msg')?.textContent).toContain('unknown profileParams');
    // ...and the rejected run did not wipe the values that caused it.
    expect((container.querySelector('#profile-param-crf') as HTMLInputElement).value).toBe('30');
  });
});
