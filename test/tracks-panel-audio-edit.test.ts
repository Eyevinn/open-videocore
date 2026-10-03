// @vitest-environment happy-dom
//
// Add/remove controls on the audio section of the tracks panel (issue #939).
//
// The read-only panel from #902 could show an asset's editorial audio tracks but
// could not change them, even though the API has always exposed both writes.
// These tests cover the new controls end to end: the pure input/body/error
// helpers, the rendered affordances, the wired add/remove flows against a fake
// apiFetch + the house confirmModal, and the detail-view integration driven
// through the REAL renderer (renderAssetDetailBody — the same code path the
// asset side panel and the detached detail window use).
//
// CONTRACT GROUNDING — every path, method, field and status below was read from
// this repo's route source and generated spec BEFORE the tests were written
// (CLAUDE.md rule 7), and additionally captured from the live in-process router
// (the real `assetsRouter` over `InMemoryAssetRepository`) because `openapi.json`
// does not model the validation failure that acceptance criterion 3 is about.
// `openapi.json` declares no `operationId` anywhere, so operations are named by
// path + method, as the spec itself does.
//
//   ADD — openapi.json .paths["/api/v1/assets/{id}/audio-tracks"].post
//     (`app.post('/:id/audio-tracks', …)`, src/routes/assets.ts:5428-5458)
//     parameters: exactly one — path `id` (string, required). No query params.
//     requestBody (`addAudioTrackSchema`, src/routes/assets.ts:826-832):
//       { language: string minLength 1 maxLength 64   ← the ONLY required field,
//         codec?:   string minLength 1 maxLength 64,
//         channels?: integer minimum 1 maximum 64,
//         label?:   string minLength 1 maxLength 128,
//         default?: boolean },  additionalProperties: false.
//       `id` is NOT accepted from the client: the server mints it with
//       randomUUID() (:5447), as the schema's own comment states (:824-825).
//     responses declared: 201 and 404 ONLY.
//       201 -> { audioTracks: audioTrackOutSchema[] } (:5436) — the WHOLE
//         updated list, `[...(asset.audioTracks ?? []), track]` (:5454).
//         Captured live: {"audioTracks":[{"id":"9551…","language":"sv"}]}.
//       404 -> { error: "not_found" } (:5444).
//     NOT declared but reachable, and therefore handled — 400 from
//       fastify-type-provider-zod in Fastify's own validation envelope, before
//       the handler runs. Captured live, verbatim:
//         {"statusCode":400,"code":"FST_ERR_VALIDATION","error":"Bad Request",
//          "message":"body/language String must contain at least 1 character(s)"}
//         {… "message":"body/channels Number must be greater than or equal to 1"}
//         {… "message":"body/channels Expected integer, received float"}
//
//   REMOVE — openapi.json
//     .paths["/api/v1/assets/{id}/audio-tracks/{trackId}"].delete
//     (`app.delete('/:id/audio-tracks/:trackId', …)`, src/routes/assets.ts:5463-5485)
//     parameters: path `id` and path `trackId`, both required strings (:5468).
//       No body, no query params.
//     responses: 204 (empty body, :5469) and 404. Captured live: a first delete
//       answers 204 with no body; a second answers
//       {"error":"not_found","message":"audio track not found"} (:5480); an
//       unknown asset answers {"error":"not_found"} (:5475).
//     The post-remove list is the handler's own filter,
//       `existing.filter(t => t.id !== trackId)` (:5478) — there is no body to
//       read it from, so `audioTracksAfterRemoval` reproduces exactly that.
//     METADATA ONLY: the handler's sole effect is
//       `repo.update(asset.id, { audioTracks })` (:5482), and an editorial audio
//       track has no `objectKey` in `audioTrackOutSchema` (:804-811) — unlike a
//       subtitle track (:819). No stored object exists to delete and none is
//       deleted; that is what the confirmation dialog asserts below.
//     NO audit entry is emitted: unlike the archive/restore paths (:5714, :5933)
//       neither track route is wired to the audit emitter.
//
//   There is NO PATCH/PUT on any track path, so a track can only be added and
//     removed, never edited — asserted below as an absence.
//
//   Authorisation — MATRIX (src/auth/authorize.ts:54-58) grants `write` and
//     `delete` to editor and admin and neither to viewer; methodToAction
//     (:79-93) maps POST -> write and DELETE -> delete;
//     resourceAuthorizationPreHandler('asset') (:126, registered
//     src/routes/assets.ts:1773) applies it. 403 code
//     AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role' (:99). GET is
//     `read`, which a viewer DOES hold, so a viewer keeps the whole panel and
//     loses only the controls.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canEditAudioTracks,
  confirmModal,
  renderAssetDetailBody,
  setClientRole,
} from '../public/app.js';
import {
  AUDIO_CHANNELS_MAX,
  AUDIO_EDIT_COPY,
  AUDIO_LABEL_MAX,
  AUDIO_LANGUAGE_MAX,
  TRACKS_COPY,
  addAudioTrackRequestBody,
  audioTrackName,
  audioTracksAfterRemoval,
  classifyAudioTrackError,
  mountAssetTracks,
  normaliseAudioTrackInput,
  removeAudioTrackConfirmSpec,
  renderTracksBlock,
} from '../public/tracks-panel.js';

const ULID = '01J9AAAAAAAAAAAAAAAAAAAAAA';

const TECHNICAL = {
  codec: 'h264',
  width: 1920,
  height: 1080,
  durationSeconds: 92.5,
  bitrateBps: 5_000_000,
  containerFormat: 'mov',
  audioTracks: [{ index: 1, codec: 'aac', channels: 2, sampleRateHz: 48000 }],
  extractedAt: '2026-09-21T09:00:00.000Z',
};

// Exactly the item shape of audioTrackOutSchema (src/routes/assets.ts:804-811):
// one track with every optional field, one with only the two required ones.
const EDITORIAL_AUDIO = [
  { id: 'aud-1', language: 'sv', codec: 'aac', channels: 2, label: 'Swedish 2.0', default: true },
  { id: 'aud-2', language: 'fi' },
];

const ASSET = {
  id: ULID,
  name: 'trailer-master.mov',
  status: 'ready',
  reviewState: 'draft',
  statusHistory: [{ at: '2026-09-21T08:00:00.000Z', from: null, to: 'ready' }],
  technicalMetadata: TECHNICAL,
  audioTracks: EDITORIAL_AUDIO,
  subtitleTracks: [],
  createdAt: '2026-09-21T08:00:00.000Z',
  updatedAt: '2026-09-21T09:00:00.000Z',
};

/** An apiFetch rejection, shaped exactly as public/app.js builds one. */
function apiError(status: number, body: Record<string, unknown>) {
  const err = new Error(
    (body['message'] as string) || (body['error'] as string) || 'HTTP ' + status
  ) as Error & { status: number; body: unknown };
  err.status = status;
  err.body = body;
  return err;
}

async function flush(ticks = 20) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

async function settle(ticks = 30) {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('audioTrackName (issue #939)', () => {
  it('prefers the operator-supplied label, then the only guaranteed field', () => {
    expect(audioTrackName(EDITORIAL_AUDIO[0])).toBe('Swedish 2.0');
    // `language` is in audioTrackOutSchema's `required` list; `label` is not.
    expect(audioTrackName(EDITORIAL_AUDIO[1])).toBe('fi');
  });

  it('falls back to a descriptive phrase and NEVER to the opaque id', () => {
    expect(audioTrackName({ id: 'aud-9' })).toBe(AUDIO_EDIT_COPY.unnamedTrack);
    expect(audioTrackName({ id: 'aud-9', label: '   ', language: '  ' })).toBe(
      AUDIO_EDIT_COPY.unnamedTrack
    );
    expect(audioTrackName({ id: 'aud-9' })).not.toContain('aud-9');
  });
});

describe('normaliseAudioTrackInput — the client mirror of addAudioTrackSchema', () => {
  it('requires language, because it is the schema’s only required field', () => {
    const r = normaliseAudioTrackInput({ language: '   ' });
    expect(r.ok).toBe(false);
    expect(r.body).toBeNull();
    expect(r.errors).toEqual([
      { field: 'language', message: AUDIO_EDIT_COPY.errLanguageEmpty },
    ]);
  });

  it('accepts a language-only track — every other field is optional', () => {
    const r = normaliseAudioTrackInput({ language: 'sv' });
    expect(r.ok).toBe(true);
    expect(r.body).toEqual({ language: 'sv' });
  });

  it('trims, and treats a blank optional field as OMITTED rather than empty', () => {
    // Every optional string is min(1) server-side, so sending "" would be a 400.
    const r = normaliseAudioTrackInput({
      language: '  en-GB  ',
      label: '   ',
      codec: '',
      channels: '',
    });
    expect(r.ok).toBe(true);
    expect(r.body).toEqual({ language: 'en-GB' });
    expect(Object.keys(r.body as object)).toEqual(['language']);
  });

  it('enforces the schema’s own string bounds before any request is made', () => {
    expect(normaliseAudioTrackInput({ language: 'x'.repeat(AUDIO_LANGUAGE_MAX) }).ok).toBe(true);
    expect(
      normaliseAudioTrackInput({ language: 'x'.repeat(AUDIO_LANGUAGE_MAX + 1) }).errors[0]
    ).toEqual({ field: 'language', message: AUDIO_EDIT_COPY.errLanguageLong });
    expect(
      normaliseAudioTrackInput({ language: 'sv', label: 'x'.repeat(AUDIO_LABEL_MAX + 1) }).errors[0]
    ).toEqual({ field: 'label', message: AUDIO_EDIT_COPY.errLabelLong });
    expect(
      normaliseAudioTrackInput({ language: 'sv', codec: 'x'.repeat(65) }).errors[0]
    ).toEqual({ field: 'codec', message: AUDIO_EDIT_COPY.errCodecLong });
  });

  it('refuses a non-integer or out-of-range channel count, as z.number().int().min(1).max(64) does', () => {
    // The live route answers 400 "Expected integer, received float" / "Number
    // must be greater than or equal to 1" for these, so they are caught first.
    expect(normaliseAudioTrackInput({ language: 'sv', channels: '2.5' }).errors[0]).toEqual({
      field: 'channels',
      message: AUDIO_EDIT_COPY.errChannelsNotInteger,
    });
    expect(normaliseAudioTrackInput({ language: 'sv', channels: 'six' }).errors[0]).toEqual({
      field: 'channels',
      message: AUDIO_EDIT_COPY.errChannelsNotInteger,
    });
    expect(normaliseAudioTrackInput({ language: 'sv', channels: '0' }).errors[0]).toEqual({
      field: 'channels',
      message: AUDIO_EDIT_COPY.errChannelsRange,
    });
    expect(
      normaliseAudioTrackInput({ language: 'sv', channels: String(AUDIO_CHANNELS_MAX + 1) })
        .errors[0]
    ).toEqual({ field: 'channels', message: AUDIO_EDIT_COPY.errChannelsRange });
    expect(normaliseAudioTrackInput({ language: 'sv', channels: '6' }).body).toEqual({
      language: 'sv',
      channels: 6,
    });
  });

  it('sends `default` only when it is true', () => {
    // An unchecked box means "I did not say", and the item schema's convention
    // is that an optional flag is ABSENT until set.
    expect(normaliseAudioTrackInput({ language: 'sv', default: false }).body).toEqual({
      language: 'sv',
    });
    expect(normaliseAudioTrackInput({ language: 'sv', default: true }).body).toEqual({
      language: 'sv',
      default: true,
    });
  });

  it('reports every broken field at once, not one at a time', () => {
    const r = normaliseAudioTrackInput({ language: '', channels: '0' });
    expect(r.errors.map((e: { field: string }) => e.field)).toEqual(['language', 'channels']);
  });
});

describe('addAudioTrackRequestBody', () => {
  it('builds only the five keys the schema declares', () => {
    expect(
      addAudioTrackRequestBody({
        language: 'sv',
        codec: 'aac',
        channels: 2,
        label: 'Swedish 2.0',
        default: true,
      })
    ).toEqual({ language: 'sv', codec: 'aac', channels: 2, label: 'Swedish 2.0', default: true });
  });

  it('never sends an id — the server mints it with randomUUID()', () => {
    const body = addAudioTrackRequestBody({ language: 'sv', id: 'client-chosen' } as never);
    expect(body).not.toHaveProperty('id');
    expect(Object.keys(body)).toEqual(['language']);
  });
});

describe('audioTracksAfterRemoval', () => {
  it('reproduces the handler’s own filter, since the 204 carries no body', () => {
    expect(audioTracksAfterRemoval(EDITORIAL_AUDIO, 'aud-1')).toEqual([EDITORIAL_AUDIO[1]]);
    // An id the list does not hold removes nothing.
    expect(audioTracksAfterRemoval(EDITORIAL_AUDIO, 'nope')).toEqual(EDITORIAL_AUDIO);
    expect(audioTracksAfterRemoval(undefined as never, 'aud-1')).toEqual([]);
  });
});

describe('classifyAudioTrackError (issue #939 AC3)', () => {
  it('surfaces the API’s own 400 explanation verbatim, never a silent no-op', () => {
    const c = classifyAudioTrackError(
      apiError(400, {
        statusCode: 400,
        code: 'FST_ERR_VALIDATION',
        error: 'Bad Request',
        message: 'body/channels Expected integer, received float',
      }),
      'add'
    );
    expect(c.kind).toBe('rejected');
    expect(c.message).toBe(
      AUDIO_EDIT_COPY.errRejectedPrefix + 'body/channels Expected integer, received float'
    );
    expect(c.gone).toBe(false);
  });

  it('falls back to its own sentence when the rejection explained nothing', () => {
    const c = classifyAudioTrackError(apiError(422, {}), 'add');
    expect(c.message).toBe(AUDIO_EDIT_COPY.errRejectedBare);
  });

  it('names the role gate for 401/403 on each operation', () => {
    expect(
      classifyAudioTrackError(apiError(403, { error: 'forbidden_insufficient_role' }), 'add')
        .message
    ).toBe(AUDIO_EDIT_COPY.errAddForbidden);
    expect(
      classifyAudioTrackError(apiError(401, { error: 'unauthorized' }), 'remove').message
    ).toBe(AUDIO_EDIT_COPY.errRemoveForbidden);
  });

  it('treats a 404 as "already gone" on remove only', () => {
    const removed = classifyAudioTrackError(
      apiError(404, { error: 'not_found', message: 'audio track not found' }),
      'remove'
    );
    expect(removed.message).toBe(AUDIO_EDIT_COPY.errRemoveNotFound);
    expect(removed.gone).toBe(true);

    // On add a 404 means the ASSET is gone; nothing is dropped from any list.
    const added = classifyAudioTrackError(apiError(404, { error: 'not_found' }), 'add');
    expect(added.message).toBe(AUDIO_EDIT_COPY.errAddNotFound);
    expect(added.gone).toBe(false);
  });

  it('states the outcome for a transport failure or an undeclared status', () => {
    expect(classifyAudioTrackError(new Error('boom'), 'add').message).toBe(
      AUDIO_EDIT_COPY.errAddNetwork
    );
    expect(classifyAudioTrackError(apiError(500, {}), 'remove').message).toBe(
      AUDIO_EDIT_COPY.errRemoveNetwork
    );
  });
});

describe('removeAudioTrackConfirmSpec', () => {
  it('names the track by its human-readable name, never by its id', () => {
    const spec = removeAudioTrackConfirmSpec(EDITORIAL_AUDIO[0]);
    expect(spec.subject).toBe('Swedish 2.0');
    expect(spec.question).toContain('Swedish 2.0');
    expect(JSON.stringify(spec)).not.toContain('aud-1');
  });

  it('states both impact lists, grounded in what the handler actually does', () => {
    const spec = removeAudioTrackConfirmSpec(EDITORIAL_AUDIO[0]);
    expect(spec.affected.length).toBeGreaterThan(0);
    expect(spec.unaffected.length).toBeGreaterThan(0);
    const unaffected = spec.unaffected.join(' ');
    // The handler only rewrites `audioTracks` (src/routes/assets.ts:5482) and an
    // editorial audio track carries no objectKey (:804-811).
    expect(unaffected).toContain('No media is deleted');
    expect(unaffected).toContain('source streams');
    // No audit entry is emitted by this route, and no POST can restore an id.
    expect(spec.affected.join(' ')).toContain('cannot be undone');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering: the controls are strictly opt-in
// ─────────────────────────────────────────────────────────────────────────────

describe('tracks block — audio edit affordances (issue #939)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
  });

  const EDIT = { canEdit: true, onAdd: () => {}, onRemove: () => {} };

  function render(data: Record<string, unknown>) {
    host.innerHTML = '';
    host.appendChild(renderTracksBlock(data));
    return host;
  }

  it('renders NOTHING interactive when audioEdit is absent (the #902 block is intact)', () => {
    const root = render({
      video: [{ codec: 'h264', width: 1920, height: 1080, bitrateBps: 1 }],
      audioEditorial: EDITORIAL_AUDIO,
      audioProbed: TECHNICAL.audioTracks,
      subtitles: [],
    });
    const block = root.querySelector('#asset-tracks')!;
    expect(block.querySelectorAll('button, input, select, textarea, form, a')).toHaveLength(0);
    expect(block.textContent).toContain(TRACKS_COPY.introReadOnly);
  });

  it('renders nothing interactive when the role mirror says the operator may not write', () => {
    const root = render({ audioEditorial: EDITORIAL_AUDIO, audioEdit: { ...EDIT, canEdit: false } });
    expect(root.querySelectorAll('#asset-tracks button')).toHaveLength(0);
  });

  it('adds an Actions column with one Remove control per EDITORIAL track', () => {
    const root = render({
      audioEditorial: EDITORIAL_AUDIO,
      audioProbed: TECHNICAL.audioTracks,
      audioEdit: EDIT,
    });
    const headers = Array.from(
      root.querySelectorAll('#asset-tracks table')[0].querySelectorAll('thead th')
    ).map((th) => th.textContent);
    expect(headers).toEqual([
      'Language',
      'Label',
      'Codec',
      'Channels',
      'Default',
      'Track ID',
      AUDIO_EDIT_COPY.actionsColumn,
    ]);

    const removes = Array.from(root.querySelectorAll('.tracks-audio-remove'));
    expect(removes).toHaveLength(EDITORIAL_AUDIO.length);
    // "Remove" repeats on every row, so the ACCESSIBLE name carries the subject.
    expect(removes.map((b) => b.getAttribute('aria-label'))).toEqual([
      AUDIO_EDIT_COPY.removeAriaPrefix + 'Swedish 2.0',
      AUDIO_EDIT_COPY.removeAriaPrefix + 'fi',
    ]);
  });

  it('leaves the probed source streams untouched — they are not writable', () => {
    const root = render({
      audioEditorial: EDITORIAL_AUDIO,
      audioProbed: TECHNICAL.audioTracks,
      audioEdit: EDIT,
    });
    const probedTable = root.querySelectorAll('#asset-tracks table')[1];
    expect(
      Array.from(probedTable.querySelectorAll('thead th')).map((th) => th.textContent)
    ).toEqual(['Stream', 'Codec', 'Channels', 'Sample rate']);
    expect(probedTable.querySelectorAll('button')).toHaveLength(0);
  });

  it('offers no EDIT affordance, because no route can change an existing track', () => {
    const root = render({ audioEditorial: EDITORIAL_AUDIO, audioEdit: EDIT });
    const labels = Array.from(root.querySelectorAll('#asset-tracks button')).map((b) =>
      (b.textContent || '').toLowerCase()
    );
    expect(labels.some((t) => t.includes('edit'))).toBe(false);
  });

  it('starts the add form collapsed and announces its state', () => {
    const root = render({ audioEditorial: EDITORIAL_AUDIO, audioEdit: EDIT });
    const toggle = root.querySelector('.tracks-audio-add-toggle') as HTMLButtonElement;
    const form = root.querySelector('.tracks-audio-add-form') as HTMLElement;
    expect(toggle.textContent).toBe(AUDIO_EDIT_COPY.addToggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(form.id);
    expect(form.hidden).toBe(true);
    expect(form.getAttribute('role')).toBe('group');
    expect(form.getAttribute('aria-label')).toBe(AUDIO_EDIT_COPY.addFormLabel);

    toggle.click();
    expect(form.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('labels every field, marks the one required field, and bounds it as the schema does', () => {
    const root = render({ audioEditorial: EDITORIAL_AUDIO, audioEdit: EDIT });
    const form = root.querySelector('.tracks-audio-add-form')!;
    ['language', 'label', 'codec', 'channels', 'default'].forEach((key) => {
      const input = form.querySelector('#tracks-audio-' + key) as HTMLInputElement;
      expect(input, key).toBeTruthy();
      const label = form.querySelector('label[for="tracks-audio-' + key + '"]');
      expect(label, key).toBeTruthy();
    });

    const language = form.querySelector('#tracks-audio-language') as HTMLInputElement;
    expect(language.getAttribute('aria-required')).toBe('true');
    expect(language.maxLength).toBe(AUDIO_LANGUAGE_MAX);
    expect(language.getAttribute('aria-describedby')).toBe('tracks-audio-language-help');

    const channels = form.querySelector('#tracks-audio-channels') as HTMLInputElement;
    expect(channels.type).toBe('number');
    expect(channels.min).toBe('1');
    expect(channels.max).toBe(String(AUDIO_CHANNELS_MAX));
  });

  it('offers the add control on an asset with NO audio at all', () => {
    // The empty-audio asset is the one that most needs it, and the #902 empty
    // state used to end the section.
    const root = render({ audioEditorial: [], audioProbed: [], audioEdit: EDIT });
    expect(root.querySelector('[data-empty="audio-tracks"]')).not.toBeNull();
    expect(root.querySelector('.tracks-audio-add-toggle')).not.toBeNull();
  });

  it('says on screen that only the editorial audio list is writable', () => {
    const root = render({ audioEditorial: EDITORIAL_AUDIO, audioEdit: EDIT });
    expect(root.querySelector('#asset-tracks')!.textContent).toContain(TRACKS_COPY.intro);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wired flows
// ─────────────────────────────────────────────────────────────────────────────

describe('mountAssetTracks — add an audio track (issue #939 AC1/AC3)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
    vi.restoreAllMocks();
  });

  function mount(apiFetch: ReturnType<typeof vi.fn>, asset: object = ASSET) {
    const changed = vi.fn();
    const mounted = mountAssetTracks({
      asset,
      host,
      canEditAudio: true,
      apiFetch,
      confirmModal: vi.fn(async () => true),
      onAudioTracksChanged: changed,
    });
    return { mounted, changed };
  }

  function openForm() {
    (host.querySelector('.tracks-audio-add-toggle') as HTMLButtonElement).click();
    return {
      language: host.querySelector('#tracks-audio-language') as HTMLInputElement,
      label: host.querySelector('#tracks-audio-label') as HTMLInputElement,
      codec: host.querySelector('#tracks-audio-codec') as HTMLInputElement,
      channels: host.querySelector('#tracks-audio-channels') as HTMLInputElement,
      dflt: host.querySelector('#tracks-audio-default') as HTMLInputElement,
      submit: host.querySelector('.tracks-audio-add-submit') as HTMLButtonElement,
      error: host.querySelector('.tracks-audio-add-error') as HTMLElement,
    };
  }

  it('POSTs exactly the fields the API requires, and shows the track the server returned', async () => {
    const created = {
      id: 'aud-3',
      language: 'en-GB',
      codec: 'aac',
      channels: 6,
      label: 'English 5.1',
      default: true,
    };
    const apiFetch = vi.fn(async () => ({ audioTracks: [...EDITORIAL_AUDIO, created] }));
    const { changed } = mount(apiFetch);

    const f = openForm();
    f.language.value = '  en-GB ';
    f.label.value = 'English 5.1';
    f.codec.value = 'aac';
    f.channels.value = '6';
    f.dflt.checked = true;
    f.submit.click();
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/assets/' + ULID + '/audio-tracks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      language: 'en-GB',
      codec: 'aac',
      channels: 6,
      label: 'English 5.1',
      default: true,
    });

    // The 201 carries the WHOLE list, so the panel re-renders from it.
    const ids = Array.from(host.querySelectorAll('.tracks-audio-remove')).map(
      (b) => (b as HTMLElement).dataset['trackId']
    );
    expect(ids).toEqual(['aud-1', 'aud-2', 'aud-3']);
    expect(host.textContent).toContain('English 5.1');
    expect((host.querySelector('.tracks-audio-notice') as HTMLElement).textContent).toBe(
      AUDIO_EDIT_COPY.addedPrefix + 'English 5.1.'
    );
    expect(changed).toHaveBeenCalledWith(
      [...EDITORIAL_AUDIO, created],
      AUDIO_EDIT_COPY.addedPrefix + 'English 5.1.',
      'success'
    );
    // The form closed on success.
    expect((host.querySelector('.tracks-audio-add-form') as HTMLElement).hidden).toBe(true);
  });

  it('omits every blank optional field rather than sending an empty string', async () => {
    const apiFetch = vi.fn(async () => ({ audioTracks: [{ id: 'aud-3', language: 'sv' }] }));
    mount(apiFetch);
    const f = openForm();
    f.language.value = 'sv';
    f.submit.click();
    await flush();

    const [, init] = apiFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ language: 'sv' });
  });

  it('sends NOTHING when the required field is missing, and says so beside the control', async () => {
    const apiFetch = vi.fn();
    mount(apiFetch);
    const f = openForm();
    f.language.value = '   ';
    f.submit.click();
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
    expect(f.error.style.display).not.toBe('none');
    expect(f.error.textContent).toBe(AUDIO_EDIT_COPY.errLanguageEmpty);
    expect(f.error.getAttribute('role')).toBe('alert');
    // The error sits INSIDE the add form, next to the control that failed.
    expect(host.querySelector('.tracks-audio-add-form')!.contains(f.error)).toBe(true);
    expect(document.activeElement).toBe(f.language);
  });

  it('surfaces an API rejection inline, verbatim, and keeps what was typed', async () => {
    const apiFetch = vi.fn(async () => {
      throw apiError(400, {
        statusCode: 400,
        code: 'FST_ERR_VALIDATION',
        error: 'Bad Request',
        message: 'body/language String must contain at least 1 character(s)',
      });
    });
    const { changed } = mount(apiFetch);
    const f = openForm();
    f.language.value = 'sv';
    f.label.value = 'Swedish';
    f.submit.click();
    await flush();

    expect(f.error.textContent).toBe(
      AUDIO_EDIT_COPY.errRejectedPrefix + 'body/language String must contain at least 1 character(s)'
    );
    expect(f.error.style.display).not.toBe('none');
    // Not a silent no-op, and not a lost draft: the form stays open and filled.
    expect((host.querySelector('.tracks-audio-add-form') as HTMLElement).hidden).toBe(false);
    expect((host.querySelector('#tracks-audio-label') as HTMLInputElement).value).toBe('Swedish');
    // And the list did not pretend anything was added.
    expect(host.querySelectorAll('.tracks-audio-remove')).toHaveLength(2);
    expect(changed).not.toHaveBeenCalled();
    // The control is usable again, never stuck in its pending label.
    expect(f.submit.disabled).toBe(false);
    expect(f.submit.textContent).toBe(AUDIO_EDIT_COPY.btnAdd);
  });

  it('explains a 403 from the role gate instead of failing silently', async () => {
    const apiFetch = vi.fn(async () => {
      throw apiError(403, { error: 'forbidden_insufficient_role' });
    });
    mount(apiFetch);
    const f = openForm();
    f.language.value = 'sv';
    f.submit.click();
    await flush();
    expect(f.error.textContent).toBe(AUDIO_EDIT_COPY.errAddForbidden);
  });
});

describe('mountAssetTracks — remove an audio track (issue #939 AC2/AC3)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
    vi.restoreAllMocks();
  });

  function mount(
    apiFetch: ReturnType<typeof vi.fn>,
    confirm: (spec: unknown) => Promise<boolean> | boolean
  ) {
    const changed = vi.fn();
    const confirmSpy = vi.fn(confirm);
    mountAssetTracks({
      asset: ASSET,
      host,
      canEditAudio: true,
      apiFetch,
      confirmModal: confirmSpy,
      onAudioTracksChanged: changed,
    });
    return { changed, confirmSpy };
  }

  function removeBtn(trackId: string) {
    return host.querySelector(
      '.tracks-audio-remove[data-track-id="' + trackId + '"]'
    ) as HTMLButtonElement;
  }

  it('asks for confirmation BEFORE the destructive call, naming the track', async () => {
    const apiFetch = vi.fn();
    const { confirmSpy } = mount(apiFetch, async () => false);

    removeBtn('aud-1').click();
    await flush();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const spec = confirmSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(spec['subject']).toBe('Swedish 2.0');
    expect(JSON.stringify(spec)).not.toContain('aud-1');
    // Declining sends nothing at all.
    expect(apiFetch).not.toHaveBeenCalled();
    expect(host.querySelectorAll('.tracks-audio-remove')).toHaveLength(2);
  });

  it('uses the HOUSE confirmation dialog, not a native confirm()', async () => {
    // Driven through the real confirmModal from app.js so the dialog that
    // appears is the app-styled one every other destructive action uses.
    const apiFetch = vi.fn(async () => null);
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);

    mountAssetTracks({
      asset: ASSET,
      host,
      canEditAudio: true,
      apiFetch,
      confirmModal,
    });

    removeBtn('aud-1').click();
    await flush();

    const dialog = document.querySelector('.confirm-dialog') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain('Swedish 2.0');
    expect(dialog.querySelector('.confirm-affected')).toBeTruthy();
    expect(dialog.querySelector('.confirm-unaffected')!.textContent).toContain(
      'No media is deleted'
    );
    // Focus starts on Cancel, so a stray Enter cannot delete anything.
    expect(document.activeElement).toBe(dialog.querySelector('.confirm-cancel'));
    expect(apiFetch).not.toHaveBeenCalled();

    (dialog.querySelector('.confirm-accept') as HTMLButtonElement).click();
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('DELETEs the right track id once confirmed and drops the row', async () => {
    const apiFetch = vi.fn(async () => null);
    const { changed } = mount(apiFetch, async () => true);

    removeBtn('aud-2').click();
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/assets/' + ULID + '/audio-tracks/aud-2');
    expect(init.method).toBe('DELETE');
    // No body on this operation.
    expect(init.body).toBeUndefined();

    const ids = Array.from(host.querySelectorAll('.tracks-audio-remove')).map(
      (b) => (b as HTMLElement).dataset['trackId']
    );
    expect(ids).toEqual(['aud-1']);
    expect((host.querySelector('.tracks-audio-notice') as HTMLElement).textContent).toBe(
      AUDIO_EDIT_COPY.removedPrefix + 'fi.'
    );
    expect(changed).toHaveBeenCalledWith(
      [EDITORIAL_AUDIO[0]],
      AUDIO_EDIT_COPY.removedPrefix + 'fi.',
      'success'
    );
  });

  it('issues exactly ONE delete and no follow-up read', async () => {
    const apiFetch = vi.fn(async () => null);
    mount(apiFetch, async () => true);
    removeBtn('aud-1').click();
    await flush();
    expect(apiFetch.mock.calls.map((c) => (c[1] as RequestInit).method)).toEqual(['DELETE']);
  });

  it('reports a 404 beside the control and stops showing a track the server does not have', async () => {
    const apiFetch = vi.fn(async () => {
      throw apiError(404, { error: 'not_found', message: 'audio track not found' });
    });
    const { changed } = mount(apiFetch, async () => true);

    removeBtn('aud-1').click();
    await flush();

    const err = host.querySelector('.tracks-audio-error') as HTMLElement;
    expect(err.textContent).toBe(AUDIO_EDIT_COPY.errRemoveNotFound);
    expect(err.style.display).not.toBe('none');
    expect(err.getAttribute('role')).toBe('alert');
    expect(
      Array.from(host.querySelectorAll('.tracks-audio-remove')).map(
        (b) => (b as HTMLElement).dataset['trackId']
      )
    ).toEqual(['aud-2']);
    // Reported as a failure, not dressed up as a clean removal.
    expect(changed).not.toHaveBeenCalled();
    expect(host.querySelector('.tracks-audio-notice')!.textContent).toBe('');
  });

  it('keeps the row and the button usable when the call fails', async () => {
    const apiFetch = vi.fn(async () => {
      throw apiError(500, { error: 'internal' });
    });
    mount(apiFetch, async () => true);

    removeBtn('aud-1').click();
    await flush();

    expect((host.querySelector('.tracks-audio-error') as HTMLElement).textContent).toBe(
      AUDIO_EDIT_COPY.errRemoveNetwork
    );
    const btn = removeBtn('aud-1');
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe(AUDIO_EDIT_COPY.btnRemove);
  });

  it('mounts read-only when a collaborator is missing, rather than offering a dead control', () => {
    const bare = document.createElement('div');
    document.body.appendChild(bare);
    mountAssetTracks({ asset: ASSET, host: bare, canEditAudio: true });
    expect(bare.querySelectorAll('button')).toHaveLength(0);
    bare.remove();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail view integration — the real renderer
// ─────────────────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? {} : { 'content-type': 'application/json' },
  });

describe('asset detail — audio track add/remove (issue #939)', () => {
  let container: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  /** Routes by path+method and records every write. */
  function routedFetch(asset: object = ASSET) {
    const calls: { method: string; path: string; body: unknown }[] = [];
    let current = asset as Record<string, unknown>;
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api\/v1/, '');
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({
        method,
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (/\/audio-tracks\/[^/]+$/.test(path) && method === 'DELETE') {
        const id = path.split('/').pop();
        current = {
          ...current,
          audioTracks: (current['audioTracks'] as { id: string }[]).filter((t) => t.id !== id),
        };
        return json(null, 204);
      }
      if (/\/audio-tracks$/.test(path) && method === 'POST') {
        const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        // The server mints the id; the client never supplies one.
        const track = { id: 'aud-new', ...sent };
        const audioTracks = [...(current['audioTracks'] as object[]), track];
        current = { ...current, audioTracks };
        return json({ audioTracks }, 201);
      }
      if (/\/review-state$/.test(path)) {
        return json({ reviewState: 'draft', allowedTransitions: ['in-review'] });
      }
      if (/\/lock$/.test(path)) return json(current);
      if (/\/delivery$/.test(path)) return json({ urls: {} });
      if (/\/executions$/.test(path)) return json([]);
      if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
      if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
      if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(current);
      return json({});
    });
    vi.stubGlobal('fetch', fetchStub);
    return calls;
  }

  it('offers the controls to a role that holds write+delete, and adds a track on the wire', async () => {
    setClientRole('editor');
    expect(canEditAudioTracks()).toBe(true);
    const calls = routedFetch();

    await renderAssetDetailBody(ULID, container);
    await settle();

    // Reading the asset costs no extra request: the panel still renders from the
    // detail body, and asks for nothing until the operator acts.
    expect(calls.filter((c) => /audio-tracks/.test(c.path))).toEqual([]);

    (container.querySelector('.tracks-audio-add-toggle') as HTMLButtonElement).click();
    (container.querySelector('#tracks-audio-language') as HTMLInputElement).value = 'de';
    (container.querySelector('#tracks-audio-label') as HTMLInputElement).value = 'German';
    (container.querySelector('.tracks-audio-add-submit') as HTMLButtonElement).click();
    await settle();

    const posts = calls.filter((c) => c.method === 'POST' && /\/audio-tracks$/.test(c.path));
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe('/assets/' + ULID + '/audio-tracks');
    expect(posts[0].body).toEqual({ language: 'de', label: 'German' });

    // The new track is in the list, and the outcome is reported.
    expect(container.querySelector('#asset-tracks')!.textContent).toContain('German');
    expect(container.querySelector('.tracks-audio-notice')!.textContent).toContain('German');
    expect(container.querySelector('#action-msg')!.textContent).toContain('German');
  });

  it('removes a track through the house confirmation dialog', async () => {
    setClientRole('admin');
    const calls = routedFetch();

    await renderAssetDetailBody(ULID, container);
    await settle();

    (
      container.querySelector(
        '.tracks-audio-remove[data-track-id="aud-1"]'
      ) as HTMLButtonElement
    ).click();
    await settle();

    const dialog = document.querySelector('.confirm-dialog') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('Swedish 2.0');
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);

    (dialog.querySelector('.confirm-accept') as HTMLButtonElement).click();
    await settle();

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].path).toBe('/assets/' + ULID + '/audio-tracks/aud-1');
    // The row is gone from the list. The name survives only in the outcome
    // line, which is the point of it.
    expect(
      Array.from(container.querySelectorAll('.tracks-audio-remove')).map(
        (b) => (b as HTMLElement).dataset['trackId']
      )
    ).toEqual(['aud-2']);
    expect(
      container.querySelectorAll('#asset-tracks table')[1].textContent
    ).not.toContain('Swedish 2.0');
    expect(container.querySelector('.tracks-audio-notice')!.textContent).toBe(
      AUDIO_EDIT_COPY.removedPrefix + 'Swedish 2.0.'
    );
  });

  it('gives a viewer the full panel and none of the controls', async () => {
    setClientRole('viewer');
    expect(canEditAudioTracks()).toBe(false);
    routedFetch();

    await renderAssetDetailBody(ULID, container);
    await settle();

    const block = container.querySelector('#asset-tracks')!;
    // Still fully readable — GET is `read`, which a viewer holds.
    expect(block.textContent).toContain('Swedish 2.0');
    expect(block.querySelectorAll('button, input, select, textarea')).toHaveLength(0);
    expect(block.textContent).toContain(TRACKS_COPY.introReadOnly);
  });
});
