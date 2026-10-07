// @vitest-environment happy-dom
//
// Audio track add/remove controls in the tracks panel (issue #903, broken out of
// #794). Extends the read-only panel #902 landed (test/asset-tracks-panel.test.ts)
// with the two writes the API already exposed and this UI could not reach.
//
// Acceptance criteria under test:
//   1. An operator can add an audio track and remove an existing one from the panel.
//   2. Remove requires an explicit confirmation step.
//   3. A failed add/remove surfaces an INLINE error; the panel does not silently
//      drop the change.
//   4. A successful add/remove refreshes the audio section with no page reload.
//
// CONTRACT GROUNDING — every path, method, field, bound and status below was read
// from this repo's generated spec and route source BEFORE these tests were
// written (CLAUDE.md rule 7), never from the issue text. `openapi.json` declares
// no `operationId` anywhere, so operations are named by path + method:
//
//   ADD — openapi.json .paths["/api/v1/assets/{id}/audio-tracks"].post
//     The path object's ONLY key is `post` (no GET, no PUT, no PATCH).
//     parameters: exactly one path param `id` (string, required). No query params.
//     requestBody required, application/json:
//       { language: string 1..64            (the ONLY required property),
//         codec?:   string 1..64,
//         channels?: INTEGER 1..64,
//         label?:   string 1..128,
//         default?: boolean }, additionalProperties: false.
//       Source: `addAudioTrackSchema`, src/routes/assets.ts:821-827, wired at
//       app.post('/:id/audio-tracks', …) :5325-5355 (`body:` at :5331). The track
//       `id` is NOT accepted from the client — "The server assigns the id"
//       (:819-820), minted with randomUUID() (:5344).
//     responses: EXACTLY 201 and 404.
//       201 { audioTracks: audioTrackOutSchema[] }, required ["audioTracks"],
//           additionalProperties: false (:5333). It is the FULL updated list, not
//           the new track alone: `[...(asset.audioTracks ?? []), track]` then
//           `send({ audioTracks })` (:5351-5353) — so a successful add needs NO
//           follow-up read, asserted below.
//       404 `{ error, message? }` sent as `{ error: 'not_found' }` with NO
//           message for an unknown/foreign asset (:5340-5342).
//     400 is NOT declared: an invalid body is refused by
//       fastify-type-provider-zod before the handler runs (verified:
//       `{ language: '' }` -> 400, test/tracks.test.ts:142-151).
//
//   REMOVE — openapi.json
//            .paths["/api/v1/assets/{id}/audio-tracks/{trackId}"].delete
//     The path object's ONLY key is `delete`.
//     parameters: exactly two path params, `id` and `trackId` (both string,
//       required). No body, no query params (no `?force=` on this operation).
//     responses: EXACTLY 204 and 404.
//       204 schema z.null() (:5366). On the wire the reply has an EMPTY body and
//           NO content-type header at all — probed through app.inject against the
//           real route — so apiFetch resolves `null` and there is no list to read.
//       404 `errorSchema`, in TWO distinguishable shapes: `{ error: 'not_found' }`
//           with NO `message` when the ASSET is unknown (:5371-5372), and
//           `{ error: 'not_found', message: 'audio track not found' }` when the
//           asset exists but has no such track (:5376-5378). The UI keys off the
//           PRESENCE of `message`, never its prose.
//     The handler filters and patches ONE key:
//       `existing.filter((t) => t.id !== trackId)` then
//       `repo.update(asset.id, { audioTracks })` (:5375, :5379). No file and no
//       stored object is deleted — which is what the confirmation dialog claims.
//
//   POST-REMOVE RE-READ — openapi.json .paths["/api/v1/assets/{id}/tracks"].get
//     200 { audioTracks, subtitleTracks }, BOTH required (`tracksSchema`,
//     src/routes/assets.ts:836-839; handler :5301-5320). 404 errorSchema.
//     The read-only panel does not call this (it already holds the arrays). After
//     a 204 it genuinely does not, so this is the one place that reads it.
//
//   `default` IS NOT EXCLUSIVE — the add handler appends and writes with no
//     de-defaulting pass anywhere (:5343-5353), so the API permits two tracks
//     flagged default. Nothing here asserts an exclusivity the server does not
//     enforce.
//
//   ROLE GATE — MATRIX (src/auth/authorize.ts:54-58) gives write+delete to
//     editor and admin and neither to viewer; methodToAction (:79-93) maps
//     POST -> write, DELETE -> delete; resourceAuthorizationPreHandler('asset')
//     is registered plugin-scoped on EVERY asset route (src/routes/assets.ts:1748).
//     So both operations 403 for a viewer with `forbidden_insufficient_role`
//     (AUTHZ_FORBIDDEN_ERROR, src/auth/authorize.ts:99).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetDetailBody } from '../public/app.js';
import { TRACKS_COPY, mountAssetTracks, renderTracksBlock } from '../public/tracks-panel.js';
import {
  AUDIO_EDIT_COPY,
  AUDIO_CHANNELS_MAX,
  AUDIO_LABEL_MAX,
  AUDIO_LANGUAGE_MAX,
  audioTrackName,
  audioTracksFromResponse,
  classifyAudioTrackError,
  createAudioTrackEditor,
  normaliseAddAudioTrackInput,
  removeAudioTrackConfirmSpec,
} from '../public/audio-track-edit.js';

const ULID = '01J9AAAAAAAAAAAAAAAAAAAAAA';

const EDITORIAL_AUDIO = [
  { id: 'aud-1', language: 'sv', codec: 'aac', channels: 2, label: 'Swedish 2.0', default: true },
  { id: 'aud-2', language: 'fi' },
];

const ASSET = {
  id: ULID,
  name: 'trailer-master.mov',
  status: 'ready',
  reviewState: 'draft',
  technicalMetadata: null,
  audioTracks: EDITORIAL_AUDIO,
  subtitleTracks: [],
  createdAt: '2026-09-21T08:00:00.000Z',
  updatedAt: '2026-09-21T09:00:00.000Z',
};

/** An error shaped exactly like the one apiFetch throws. */
function apiError(status: number, body?: unknown) {
  const b = body as { message?: string; error?: string } | undefined;
  const err = new Error(b?.message || b?.error || 'HTTP ' + status) as Error & {
    status?: number;
    body?: unknown;
  };
  err.status = status;
  err.body = body;
  return err;
}

async function flush(ticks = 20) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

// ─── DOM probes ──────────────────────────────────────────────────────────────

function block(root: ParentNode): HTMLElement {
  return root.querySelector('#asset-tracks') as HTMLElement;
}

/** The table whose visually-hidden caption matches, so index drift cannot lie. */
function tableByCaption(root: ParentNode, caption: string): HTMLTableElement | null {
  const tables = Array.from(block(root).querySelectorAll('table'));
  return (
    (tables.find((t) => (t.querySelector('caption')?.textContent || '') === caption) as
      | HTMLTableElement
      | undefined) || null
  );
}

function headers(root: ParentNode, caption: string): string[] {
  const t = tableByCaption(root, caption);
  if (!t) return [];
  return Array.from(t.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim());
}

function languages(root: ParentNode): string[] {
  const t = tableByCaption(root, 'Editorial audio tracks');
  if (!t) return [];
  return Array.from(t.querySelectorAll('tbody tr')).map(
    (tr) => (tr.querySelector('td')?.textContent || '').trim()
  );
}

function addButton(root: ParentNode): HTMLButtonElement | null {
  return block(root).querySelector('#btn-add-audio-track');
}

function removeButtons(root: ParentNode): HTMLButtonElement[] {
  return Array.from(block(root).querySelectorAll('.audio-track-remove'));
}

function errorEl(root: ParentNode): HTMLElement | null {
  return block(root).querySelector('#audio-track-error');
}

function statusEl(root: ParentNode): HTMLElement | null {
  return block(root).querySelector('#audio-track-status');
}

function errorText(root: ParentNode): string {
  const e = errorEl(root);
  if (!e || e.style.display === 'none') return '';
  return (e.textContent || '').trim();
}

function field(root: ParentNode, id: string): HTMLInputElement {
  return block(root).querySelector('#' + id) as HTMLInputElement;
}

/** Fill the add form. Only the fields named are touched. */
function fillForm(root: ParentNode, values: Record<string, string | boolean>) {
  Object.keys(values).forEach((key) => {
    const input = field(root, 'audio-track-' + key);
    const v = values[key];
    if (typeof v === 'boolean') input.checked = v;
    else input.value = v;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('add request body, built against addAudioTrackSchema', () => {
  it('requires a language and trims it, because minLength is 1', () => {
    expect(normaliseAddAudioTrackInput({ language: '  ' })).toMatchObject({
      ok: false,
      field: 'language',
      message: AUDIO_EDIT_COPY.errLanguageRequired,
    });
    expect(normaliseAddAudioTrackInput({ language: '  sv  ' })).toEqual({
      ok: true,
      body: { language: 'sv' },
    });
  });

  it('OMITS every blank optional rather than sending an empty string', () => {
    // additionalProperties: false with minLength 1 on each optional — sending
    // `codec: ''` would be a 400, and sending `null` is not in the schema at all.
    const r = normaliseAddAudioTrackInput({
      language: 'en',
      codec: '',
      channels: '',
      label: '',
      default: false,
    });
    expect(r).toEqual({ ok: true, body: { language: 'en' } });
    expect(Object.keys((r as { body: object }).body)).toEqual(['language']);
  });

  it('sends every optional the operator did set, and nothing else', () => {
    expect(
      normaliseAddAudioTrackInput({
        language: 'sv',
        codec: 'aac',
        channels: '6',
        label: 'Swedish 5.1',
        default: true,
      })
    ).toEqual({
      ok: true,
      // channels is an INTEGER in the contract, so it leaves here as a number.
      body: { language: 'sv', codec: 'aac', channels: 6, label: 'Swedish 5.1', default: true },
    });
  });

  it('refuses a non-integer channel count instead of letting the server bounce it', () => {
    expect(normaliseAddAudioTrackInput({ language: 'en', channels: '2.5' })).toMatchObject({
      ok: false,
      field: 'channels',
      message: AUDIO_EDIT_COPY.errChannelsInteger,
    });
    expect(normaliseAddAudioTrackInput({ language: 'en', channels: 'two' })).toMatchObject({
      ok: false,
      field: 'channels',
      message: AUDIO_EDIT_COPY.errChannelsInteger,
    });
  });

  it('mirrors the server bounds exactly: 1..64 channels, 64/64/128 characters', () => {
    expect(normaliseAddAudioTrackInput({ language: 'en', channels: '0' })).toMatchObject({
      ok: false,
      field: 'channels',
    });
    expect(
      normaliseAddAudioTrackInput({ language: 'en', channels: String(AUDIO_CHANNELS_MAX + 1) })
    ).toMatchObject({ ok: false, field: 'channels' });
    expect(
      normaliseAddAudioTrackInput({ language: 'en', channels: String(AUDIO_CHANNELS_MAX) })
    ).toMatchObject({ ok: true });

    expect(
      normaliseAddAudioTrackInput({ language: 'x'.repeat(AUDIO_LANGUAGE_MAX + 1) })
    ).toMatchObject({ ok: false, field: 'language' });
    expect(
      normaliseAddAudioTrackInput({ language: 'en', codec: 'x'.repeat(65) })
    ).toMatchObject({ ok: false, field: 'codec' });
    expect(
      normaliseAddAudioTrackInput({ language: 'en', label: 'x'.repeat(AUDIO_LABEL_MAX + 1) })
    ).toMatchObject({ ok: false, field: 'label' });
  });

  it('does not send default:false — the operator set nothing, so nothing is sent', () => {
    const r = normaliseAddAudioTrackInput({ language: 'en', default: false }) as { body: object };
    expect('default' in r.body).toBe(false);
  });
});

describe('reading the updated list off a response', () => {
  it('takes `audioTracks` from the add 201, which carries the FULL list', () => {
    expect(audioTracksFromResponse({ audioTracks: EDITORIAL_AUDIO })).toEqual(EDITORIAL_AUDIO);
  });

  it('distinguishes a genuinely empty list from a response that carried none', () => {
    // `audioTracks` is REQUIRED on the 201, so its absence is a non-conforming
    // server — not a signal to blank the section.
    expect(audioTracksFromResponse({ audioTracks: [] })).toEqual([]);
    expect(audioTracksFromResponse({})).toBeNull();
    expect(audioTracksFromResponse(null)).toBeNull();
    expect(audioTracksFromResponse({ audioTracks: 'nope' })).toBeNull();
  });
});

describe('error classification, per declared status', () => {
  it('names the role requirement on a 403 and marks the control retired', () => {
    const c = classifyAudioTrackError(apiError(403, { error: 'forbidden_insufficient_role' }), 'add');
    expect(c.kind).toBe('forbidden');
    expect(c.message).toContain('editor or admin');
  });

  it('tells a missing TRACK from a missing ASSET by the presence of `message`', () => {
    // The two 404 bodies the DELETE handler sends (src/routes/assets.ts:5371, :5377).
    const trackGone = classifyAudioTrackError(
      apiError(404, { error: 'not_found', message: 'audio track not found' }),
      'remove'
    );
    expect(trackGone.kind).toBe('gone');

    const assetGone = classifyAudioTrackError(apiError(404, { error: 'not_found' }), 'remove');
    expect(assetGone.kind).toBe('asset-gone');
    expect(assetGone.message).toContain('asset was not found');

    // Add has only the asset-level 404.
    expect(classifyAudioTrackError(apiError(404, { error: 'not_found' }), 'add').kind).toBe(
      'asset-gone'
    );
  });

  it('reports an undeclared 400 as what the validator said, not as a guess', () => {
    const c = classifyAudioTrackError(apiError(400, { message: 'body/language must be string' }), 'add');
    expect(c.kind).toBe('invalid');
    expect(c.message).toContain('body/language must be string');
  });

  it('falls through to the server message for anything unmodelled', () => {
    expect(classifyAudioTrackError(apiError(503, { error: 'upstream' }), 'remove').message).toContain(
      'Removing the audio track failed'
    );
    // A network failure has no status at all.
    expect(classifyAudioTrackError(new Error('Failed to fetch'), 'add').message).toContain(
      'Failed to fetch'
    );
  });
});

describe('the remove confirmation spec', () => {
  it('names the track by a human-readable name, never by the opaque id', () => {
    const spec = removeAudioTrackConfirmSpec(EDITORIAL_AUDIO[0]);
    expect(spec.subject).toBe('Swedish 2.0');
    expect(spec.question).toContain('Swedish 2.0');
    // The id is still shown, as the secondary detail line.
    expect(spec.detail).toBe('Track ID aud-1');

    // A track with only the required fields falls back to its language.
    expect(removeAudioTrackConfirmSpec(EDITORIAL_AUDIO[1]).subject).toBe('fi');
    expect(audioTrackName({ id: 'aud-9' })).toBe('aud-9');
  });

  it('states what the DELETE does and does not change, per the handler', () => {
    const spec = removeAudioTrackConfirmSpec(EDITORIAL_AUDIO[0]);
    expect(spec.affected.length).toBeGreaterThan(0);
    expect(spec.unaffected.length).toBeGreaterThan(0);
    // The handler patches one key and deletes nothing (src/routes/assets.ts:5375-5379).
    expect(spec.unaffected.join(' ')).toContain('Deletes no media');
    expect(spec.unaffected.join(' ')).toContain('source audio streams');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Panel rendering with and without the editor
// ─────────────────────────────────────────────────────────────────────────────

describe('the read-only panel is unchanged when no editor is mounted (#902)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  it('renders no control and keeps the read-only intro', () => {
    host.appendChild(
      renderTracksBlock({ audioEditorial: EDITORIAL_AUDIO, audioProbed: [], subtitles: [] })
    );
    expect(block(host).querySelectorAll('button, input, select, textarea, form')).toHaveLength(0);
    expect(block(host).textContent).toContain('Read-only');
    expect(headers(host, 'Editorial audio tracks')).not.toContain(AUDIO_EDIT_COPY.actionsColumn);
  });

  it('states why the controls are absent when the caller withheld them', () => {
    // A viewer holds `read`, so the panel stays; only the writes go.
    mountAssetTracks({ asset: ASSET, host, audioEditDenied: AUDIO_EDIT_COPY.roleNote });
    expect(block(host).textContent).toContain('editor or admin role');
    expect(block(host).querySelectorAll('button')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Add + remove, driven through the mounted panel
// ─────────────────────────────────────────────────────────────────────────────

describe('audio track add/remove in the panel (issue #903)', () => {
  let host: HTMLElement;
  let apiFetch: ReturnType<typeof vi.fn>;
  let confirmModal: ReturnType<typeof vi.fn>;
  let onChanged: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  function mount(asset: object = ASSET) {
    return mountAssetTracks({
      asset,
      host,
      audioEdit: { assetId: ULID, apiFetch, confirmModal, onChanged },
    });
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    apiFetch = vi.fn();
    // Default: the operator confirms. Each remove test that cares overrides it.
    confirmModal = vi.fn(async () => true);
    onChanged = vi.fn();
    // Nothing in the panel may reach the network directly — it goes through the
    // injected apiFetch or not at all.
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Render ──

  it('offers a Remove control per editorial track and an Add control, with no request', () => {
    mount();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(headers(host, 'Editorial audio tracks')).toEqual([
      'Language',
      'Label',
      'Codec',
      'Channels',
      'Default',
      'Track ID',
      AUDIO_EDIT_COPY.actionsColumn,
    ]);
    expect(removeButtons(host)).toHaveLength(2);
    expect(addButton(host)).not.toBeNull();
    // The panel no longer claims to be read-only.
    expect(block(host).textContent).not.toContain('Read-only');
  });

  it('adds no control to the probed streams, which no endpoint can change', () => {
    mountAssetTracks({
      asset: { ...ASSET, technicalMetadata: { audioTracks: [{ index: 1, codec: 'aac', channels: 2, sampleRateHz: 48000 }] } },
      host,
      audioEdit: { assetId: ULID, apiFetch, confirmModal },
    });
    const probed = tableByCaption(host, 'Probed audio streams')!;
    expect(probed.querySelectorAll('button')).toHaveLength(0);
    expect(headers(host, 'Probed audio streams')).toEqual([
      'Stream',
      'Codec',
      'Channels',
      'Sample rate',
    ]);
  });

  it('still offers Add when the asset has no audio at all — that is when it matters', () => {
    mount({ ...ASSET, audioTracks: undefined, technicalMetadata: null });
    expect(block(host).querySelector('[data-empty="audio-tracks"]')).not.toBeNull();
    expect(addButton(host)).not.toBeNull();
  });

  // ── AC1 + AC4: add ──

  it('adds a track with EXACTLY the body the schema declares, and refreshes in place', async () => {
    const added = { id: 'aud-3', language: 'en', codec: 'aac', channels: 6, label: 'English 5.1' };
    apiFetch.mockResolvedValueOnce({ audioTracks: [...EDITORIAL_AUDIO, added] });

    mount();
    addButton(host)!.click();
    fillForm(host, { language: ' en ', codec: 'aac', channels: '6', label: 'English 5.1' });
    (block(host).querySelector('#audio-track-submit') as HTMLButtonElement).click();
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe('/assets/' + ULID + '/audio-tracks');
    expect(init.method).toBe('POST');
    // No `id`: the server mints it. No blank optionals. Trimmed language.
    expect(JSON.parse(init.body)).toEqual({
      language: 'en',
      codec: 'aac',
      channels: 6,
      label: 'English 5.1',
    });

    // AC4: the audio section now shows the new track, and the block was replaced
    // in place rather than duplicated.
    expect(host.querySelectorAll('#asset-tracks')).toHaveLength(1);
    expect(languages(host)).toEqual(['sv', 'fi', 'en']);
    expect((statusEl(host)!.textContent || '')).toContain('Added audio track');
    // The form closed and the Add control is back, focused.
    expect(block(host).querySelector('#audio-track-submit')).toBeNull();
    expect(document.activeElement).toBe(addButton(host));
    // The caller was handed the authoritative post-write list.
    expect(onChanged).toHaveBeenCalledWith([...EDITORIAL_AUDIO, added]);
  });

  it('needs no follow-up read: the 201 carries the full list', async () => {
    apiFetch.mockResolvedValueOnce({ audioTracks: [...EDITORIAL_AUDIO, { id: 'aud-3', language: 'en' }] });
    mount();
    addButton(host)!.click();
    fillForm(host, { language: 'en' });
    (block(host).querySelector('#audio-track-submit') as HTMLButtonElement).click();
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls.map((c) => String(c[0]))).not.toContain('/assets/' + ULID + '/tracks');
  });

  it('refuses an empty language client-side and sends nothing at all', async () => {
    mount();
    addButton(host)!.click();
    fillForm(host, { language: '   ' });
    (block(host).querySelector('#audio-track-submit') as HTMLButtonElement).click();
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
    expect(errorText(host)).toBe(AUDIO_EDIT_COPY.errLanguageRequired);
    // The form stays open with the typed values intact.
    expect(block(host).querySelector('#audio-track-submit')).not.toBeNull();
    expect(document.activeElement).toBe(field(host, 'audio-track-language'));
  });

  it('cancels the form without sending anything, and discards the draft', async () => {
    mount();
    addButton(host)!.click();
    fillForm(host, { language: 'en', label: 'English' });
    (block(host).querySelector('.audio-track-cancel') as HTMLButtonElement).click();
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
    expect(block(host).querySelector('#audio-track-submit')).toBeNull();
    expect(document.activeElement).toBe(addButton(host));

    // Reopening gives a blank form, not an abandoned attempt.
    addButton(host)!.click();
    expect(field(host, 'audio-track-language').value).toBe('');
    expect(field(host, 'audio-track-label').value).toBe('');
  });

  // ── AC3: failures ──

  it('surfaces a failed add INLINE and does not drop the typed values', async () => {
    apiFetch.mockRejectedValueOnce(apiError(404, { error: 'not_found' }));
    mount();
    addButton(host)!.click();
    fillForm(host, { language: 'en', label: 'English' });
    (block(host).querySelector('#audio-track-submit') as HTMLButtonElement).click();
    await flush();

    expect(errorText(host)).toContain('asset was not found');
    expect(errorEl(host)!.getAttribute('role')).toBe('alert');
    // The list is untouched — the change was refused, not silently applied.
    expect(languages(host)).toEqual(['sv', 'fi']);
    expect(onChanged).not.toHaveBeenCalled();
    // And the operator's input survives the refusal.
    expect(field(host, 'audio-track-language').value).toBe('en');
    expect(field(host, 'audio-track-label').value).toBe('English');
  });

  it('retires the controls once a 403 proves the role cannot write', async () => {
    apiFetch.mockRejectedValueOnce(apiError(403, { error: 'forbidden_insufficient_role' }));
    mount();
    addButton(host)!.click();
    fillForm(host, { language: 'en' });
    (block(host).querySelector('#audio-track-submit') as HTMLButtonElement).click();
    await flush();

    expect(errorText(host)).toContain('editor or admin');
    expect(addButton(host)).toBeNull();
    expect(block(host).textContent).toContain(AUDIO_EDIT_COPY.roleNote);
  });

  it('says so when the 201 does not carry the list it is required to carry', async () => {
    apiFetch.mockResolvedValueOnce({});
    mount();
    addButton(host)!.click();
    fillForm(host, { language: 'en' });
    (block(host).querySelector('#audio-track-submit') as HTMLButtonElement).click();
    await flush();

    expect(errorText(host)).toContain('did not return the updated');
    // The section is NOT blanked on a guess.
    expect(languages(host)).toEqual(['sv', 'fi']);
  });

  // ── AC2: remove needs an explicit confirmation ──

  it('sends no DELETE when the confirmation is dismissed', async () => {
    confirmModal.mockResolvedValueOnce(false);
    mount();
    removeButtons(host)[0].click();
    await flush();

    expect(confirmModal).toHaveBeenCalledTimes(1);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(languages(host)).toEqual(['sv', 'fi']);
  });

  it('confirms with the track named and the handler-verified impact lists', async () => {
    confirmModal.mockResolvedValueOnce(false);
    mount();
    removeButtons(host)[0].click();
    await flush();

    const spec = confirmModal.mock.calls[0][0];
    expect(spec.subject).toBe('Swedish 2.0');
    expect(spec.detail).toBe('Track ID aud-1');
    expect(Array.isArray(spec.affected) && spec.affected.length).toBeTruthy();
    expect(Array.isArray(spec.unaffected) && spec.unaffected.length).toBeTruthy();
  });

  // ── AC1 + AC4: remove ──

  it('removes a track, then re-reads the list the 204 could not carry', async () => {
    apiFetch
      .mockResolvedValueOnce(null) // DELETE -> 204, empty body, no content-type
      .mockResolvedValueOnce({ audioTracks: [EDITORIAL_AUDIO[1]], subtitleTracks: [] });

    mount();
    removeButtons(host)[0].click();
    await flush();

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[0][0]).toBe('/assets/' + ULID + '/audio-tracks/aud-1');
    expect(apiFetch.mock.calls[0][1]).toEqual({ method: 'DELETE' });
    // The dedicated tracks read — the cheapest authoritative post-204 list.
    expect(apiFetch.mock.calls[1][0]).toBe('/assets/' + ULID + '/tracks');
    expect(apiFetch.mock.calls[1][1]).toBeUndefined();

    expect(languages(host)).toEqual(['fi']);
    expect(host.querySelectorAll('#asset-tracks')).toHaveLength(1);
    expect(statusEl(host)!.textContent).toContain('Removed audio track "Swedish 2.0"');
    expect(onChanged).toHaveBeenCalledWith([EDITORIAL_AUDIO[1]]);
  });

  it('keeps the removal visible when the re-read fails, and says the re-read failed', async () => {
    apiFetch
      .mockResolvedValueOnce(null) // DELETE succeeded
      .mockRejectedValueOnce(apiError(503, { error: 'unavailable' })); // re-read did not

    mount();
    removeButtons(host)[0].click();
    await flush();

    // The write landed, so the row must not stay — the same filter the server
    // applied (`t.id !== trackId`) is applied locally.
    expect(languages(host)).toEqual(['fi']);
    expect(errorText(host)).toContain('re-reading the track list failed');
  });

  it('surfaces a failed remove INLINE and leaves the track listed', async () => {
    apiFetch.mockRejectedValueOnce(apiError(500, { error: 'boom', message: 'internal error' }));
    mount();
    removeButtons(host)[0].click();
    await flush();

    expect(errorText(host)).toContain('Removing the audio track failed');
    expect(errorText(host)).toContain('internal error');
    expect(languages(host)).toEqual(['sv', 'fi']);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('refreshes the list when the API says the track is already gone', async () => {
    apiFetch
      .mockRejectedValueOnce(apiError(404, { error: 'not_found', message: 'audio track not found' }))
      .mockResolvedValueOnce({ audioTracks: [EDITORIAL_AUDIO[1]], subtitleTracks: [] });

    mount();
    removeButtons(host)[0].click();
    await flush();

    // The explanation stays visible AND the stale row goes.
    expect(errorText(host)).toContain('no longer on this asset');
    expect(languages(host)).toEqual(['fi']);
  });

  it('does not offer a Remove control for a track the server sent without an id', () => {
    // `trackId` is a required path parameter, so such a row has no removable
    // identity — a button there could only ever 404.
    mount({ ...ASSET, audioTracks: [{ language: 'de' }] });
    expect(removeButtons(host)).toHaveLength(0);
    expect(languages(host)).toEqual(['de']);
  });

  // ── Accessibility ──

  it('names every Remove button by its track, and every field by a <label>', () => {
    mount();
    expect(removeButtons(host).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Remove audio track Swedish 2.0',
      'Remove audio track fi',
    ]);
    // The visible text is a prefix of the accessible name (WCAG 2.5.3).
    removeButtons(host).forEach((b) => {
      expect(b.getAttribute('aria-label')).toContain((b.textContent || '').trim());
    });

    addButton(host)!.click();
    ['language', 'codec', 'channels', 'label', 'default'].forEach((name) => {
      const input = field(host, 'audio-track-' + name);
      const label = block(host).querySelector('label[for="audio-track-' + name + '"]');
      expect(label, name).not.toBeNull();
      expect(input, name).not.toBeNull();
    });
    // Help text is associated, not merely adjacent.
    expect(field(host, 'audio-track-language').getAttribute('aria-describedby')).toBe(
      'audio-track-language-help'
    );
  });

  it('announces errors assertively and successes politely', async () => {
    apiFetch.mockResolvedValueOnce({ audioTracks: EDITORIAL_AUDIO });
    mount();
    expect(errorEl(host)!.getAttribute('role')).toBe('alert');
    expect(statusEl(host)!.getAttribute('role')).toBe('status');
    // Both are hidden until they have something to say.
    expect(errorEl(host)!.style.display).toBe('none');
    expect(statusEl(host)!.style.display).toBe('none');
  });

  it('disables every control while a write is in flight', async () => {
    let release: (v: unknown) => void = () => {};
    apiFetch.mockReturnValueOnce(new Promise((r) => { release = r; }));
    mount();
    removeButtons(host)[0].click();
    await flush();

    expect(removeButtons(host).every((b) => b.disabled)).toBe(true);
    // A second click cannot start a second write.
    removeButtons(host)[1].click();
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(1);

    release(null);
    await flush();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail view integration — proves app.js wires the editor in
// ─────────────────────────────────────────────────────────────────────────────

describe('asset detail — audio track controls are wired up', () => {
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

  function routedFetch(asset: object) {
    const calls: { url: string; method: string; body?: string }[] = [];
    const spy = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const method = String(init?.method || 'GET');
      calls.push({ url: path, method, body: init?.body as string | undefined });
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

      if (/\/audio-tracks$/.test(path) && method === 'POST') {
        return json({ audioTracks: [...EDITORIAL_AUDIO, { id: 'aud-3', language: 'no' }] }, 201);
      }
      if (/\/review-state$/.test(path)) return json({ reviewState: 'draft', allowedTransitions: [] });
      if (/\/lock$/.test(path)) return json(asset);
      if (/\/delivery$/.test(path)) return json({ urls: {} });
      if (/\/executions$/.test(path)) return json([]);
      if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
      if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
      if (/\/tracks$/.test(path)) return json({ audioTracks: EDITORIAL_AUDIO, subtitleTracks: [] });
      if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(asset);
      return json({});
    });
    return { spy, calls };
  }

  async function settle(ticks = 30) {
    for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
  }

  it('renders the controls without issuing any extra request on the render path', async () => {
    const { spy, calls } = routedFetch(ASSET);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(container.querySelector('#btn-add-audio-track')).not.toBeNull();
    expect(container.querySelectorAll('.audio-track-remove')).toHaveLength(2);
    // The read-only panel's rule still holds for the RENDER: no /tracks read and
    // no track write happens until an operator activates a control.
    expect(calls.some((c) => /\/tracks$/.test(c.url))).toBe(false);
    expect(calls.some((c) => /audio-tracks/.test(c.url))).toBe(false);
  });

  it('posts to the real route and refreshes the section with no page reload', async () => {
    const { spy, calls } = routedFetch(ASSET);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const renders = calls.length;
    (container.querySelector('#btn-add-audio-track') as HTMLButtonElement).click();
    (container.querySelector('#audio-track-language') as HTMLInputElement).value = 'no';
    (container.querySelector('#audio-track-submit') as HTMLButtonElement).click();
    await settle();

    const post = calls.find((c) => c.method === 'POST' && /\/audio-tracks$/.test(c.url))!;
    expect(post).toBeTruthy();
    expect(post.url).toContain('/api/v1/assets/' + ULID + '/audio-tracks');
    expect(JSON.parse(post.body as string)).toEqual({ language: 'no' });

    // The new track is on screen, and the asset was NOT re-read to get it there.
    const rows = Array.from(
      container.querySelectorAll('#asset-tracks table tbody tr')
    ).map((tr) => (tr.querySelector('td')?.textContent || '').trim());
    expect(rows).toContain('no');
    const reReads = calls
      .slice(renders)
      .filter((c) => c.method === 'GET' && /\/assets\/[^/?]+(?:\?|$)/.test(c.url));
    expect(reReads).toHaveLength(0);
  });

  it('withholds the controls from a read-only client role and says why', async () => {
    // viewer holds `read` but neither `write` nor `delete`
    // (src/auth/authorize.ts:54-58), so the panel stays and the controls go.
    localStorage.setItem('ovc_role', 'viewer');
    const { spy } = routedFetch(ASSET);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(container.querySelector('#btn-add-audio-track')).toBeNull();
    expect(container.querySelectorAll('.audio-track-remove')).toHaveLength(0);
    // The panel itself is still fully rendered.
    expect(container.querySelector('#asset-tracks')).not.toBeNull();
    expect(container.querySelector('#asset-tracks')!.textContent).toContain(TRACKS_COPY.audioHeading);
    expect(container.querySelector('#asset-tracks')!.textContent).toContain('editor or admin role');
  });
});
