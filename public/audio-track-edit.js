/**
 * open-videocore ops dashboard — audio-track-edit.js
 *
 * The add/remove controls for the EDITORIAL audio tracks listed in the tracks
 * panel's Audio section (issue #903, broken out of #794). The read-only panel
 * (#902, public/tracks-panel.js) renders the list; this module owns everything
 * that writes: the add form, the per-row Remove button, the confirmation step,
 * the inline error surface, and the refresh that follows a success.
 *
 * UI ONLY. No route, schema or response shape is changed here: both operations
 * already exist on the API and neither had an affordance in this UI.
 *
 * SEAM. public/tracks-panel.js keeps layout and stays pure; it asks this module
 * for two nodes (a row control and the add block) and never issues a request
 * itself. A panel mounted WITHOUT an editor is byte-for-byte the read-only panel
 * #902 shipped — no form controls, no fetch.
 *
 * Every operator-visible string is written with `textContent` / `createElement`.
 * A track `language`, `codec` and `label` are free-form tenant text (the server
 * constrains length only), so no server value ever reaches `innerHTML`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's generated spec (`openapi.json`, regenerated at HEAD by
 * `chore(openapi): regenerate openapi.json and docs`) and from the route source
 * on this branch. Nothing is taken from the issue text. `openapi.json` declares
 * no `operationId` on any operation, so operations are identified below by
 * path + method, exactly as the spec itself identifies them.
 *
 *   ADD — `openapi.json .paths["/api/v1/assets/{id}/audio-tracks"].post`
 *     The path object has EXACTLY ONE key: `post`. There is no GET and no PUT.
 *     parameters: exactly one — path `id` (string, required). No query params.
 *     requestBody: `required: true`, `application/json`, schema
 *       `{ language, codec?, channels?, label?, default? }`,
 *       `required: ["language"]`, `additionalProperties: false`:
 *         language — string, minLength 1, maxLength 64
 *         codec    — string, minLength 1, maxLength 64
 *         channels — INTEGER, minimum 1, maximum 64
 *         label    — string, minLength 1, maxLength 128
 *         default  — boolean
 *       The track `id` is NOT accepted from the client: "The server assigns the
 *       id, so it is not accepted from the client" (src/routes/assets.ts:819-820)
 *       and the handler mints it with `randomUUID()` (:5344).
 *       Source of truth: `addAudioTrackSchema`, src/routes/assets.ts:821-827,
 *       wired at `app.post('/:id/audio-tracks', …)` :5325-5355 (`body:
 *       addAudioTrackSchema` at :5331).
 *     responses: EXACTLY `201` and `404`.
 *       201 — `{ audioTracks: audioTrackOutSchema[] }`, `required:
 *         ["audioTracks"]`, `additionalProperties: false` (:5333). This is the
 *         asset's FULL updated audio track list, not just the new track —
 *         `const audioTracks = [...(asset.audioTracks ?? []), track]` then
 *         `reply.code(201).send({ audioTracks })` (:5351-5353). So a successful
 *         add needs NO follow-up read: the authoritative post-write list is in
 *         the response. This module uses it directly.
 *       404 — `{ error: string, message?: string }` (`errorSchema`), sent as
 *         `{ error: 'not_found' }` with NO `message` when the asset is unknown
 *         or belongs to another workspace (:5340-5342).
 *     400 is NOT declared on this operation. A body that violates
 *       `addAudioTrackSchema` is rejected by fastify-type-provider-zod BEFORE
 *       the handler runs, in Fastify's own validation envelope (verified:
 *       `payload: { language: '' }` → 400, test/tracks.test.ts:142-151). Nothing
 *       here assumes a modelled body for it, and the form validates client-side
 *       first so a 400 is not the normal way an operator learns the rules.
 *
 *   REMOVE — `openapi.json .paths["/api/v1/assets/{id}/audio-tracks/{trackId}"]
 *             .delete`
 *     The path object has EXACTLY ONE key: `delete`.
 *     parameters: exactly two — path `id` (string, required) and path `trackId`
 *       (string, required). No query params; in particular there is no
 *       `?force=…` on this operation (that is a DELETE /assets/{id} parameter
 *       and has no meaning here).
 *     requestBody: none.
 *     responses: EXACTLY `204` and `404`.
 *       204 — schema `z.null()` (:5366). Verified ON THE WIRE, not assumed: the
 *         reply carries an empty body and NO `content-type` header at all
 *         (probed through `app.inject` against the real route). apiFetch's
 *         content-type check therefore misses, and it resolves `null` — there is
 *         no JSON to parse and no updated list to read.
 *       404 — `errorSchema`, and the handler sends TWO DISTINGUISHABLE bodies:
 *         `{ error: 'not_found' }` with NO `message` when the ASSET is unknown
 *         (:5371-5372), and `{ error: 'not_found', message: 'audio track not
 *         found' }` when the asset exists but holds no track with that id
 *         (:5376-5378). This module keys off the PRESENCE of `message`, not its
 *         prose, so the two refusals get different operator copy without
 *         matching on a sentence the server is free to reword.
 *     The removal itself is a pure list rewrite:
 *       `const audioTracks = existing.filter((t) => t.id !== trackId)` then
 *       `repo.update(asset.id, { audioTracks })` (:5375, :5379). The patch
 *       carries ONE key. Nothing else on the asset is touched, and no stored
 *       object is deleted — which is what the confirmation dialog's
 *       "what this does not affect" list states.
 *
 *   REFRESH AFTER A REMOVE — `openapi.json .paths["/api/v1/assets/{id}/tracks"]
 *                             .get`
 *     200 — `{ audioTracks: [], subtitleTracks: [] }`, both `required`
 *       (`tracksSchema`, src/routes/assets.ts:836-839; handler :5301-5320 sends
 *       `asset.audioTracks ?? []` / `asset.subtitleTracks ?? []`). 404 —
 *       `errorSchema`.
 *     The read-only panel deliberately does NOT call this: it already holds the
 *     arrays from the `GET /assets/{id}` body (see tracks-panel.js). That
 *     reasoning does not survive a DELETE — the 204 carries no body, so after a
 *     remove this UI genuinely does not hold the post-write list. This is the
 *     cheapest authoritative read of it (two arrays, not the whole asset), so it
 *     is the ONLY place in the tracks surface that calls it, and only after a
 *     confirmed 204.
 *     If that refresh read fails the removal has still happened, so the section
 *     falls back to the same filter the server applied (`id !== trackId`) and
 *     says the re-read failed rather than pretending it succeeded.
 *
 *   WHAT `default` DOES NOT DO (checked in the handler, not assumed):
 *     Adding a track with `default: true` does NOT clear the flag on any other
 *     track. The handler appends the new track and writes the list
 *     (:5343-5353); there is no de-defaulting pass anywhere on the write path.
 *     So the API permits two tracks flagged default, and the form says so
 *     instead of implying an exclusivity the server does not enforce.
 *
 *   ROLE GATE — `MATRIX` (src/auth/authorize.ts:54-58) grants `write` and
 *     `delete` to `editor` and `admin` and neither to `viewer`; `methodToAction`
 *     (:79-93) maps POST → write and DELETE → delete; and
 *     `resourceAuthorizationPreHandler('asset')` is registered plugin-scoped on
 *     EVERY asset route (src/routes/assets.ts:1748), so both operations are
 *     refused to a viewer with 403 `forbidden_insufficient_role`
 *     (AUTHZ_FORBIDDEN_ERROR, src/auth/authorize.ts:99). The caller passes a
 *     client-side MIRROR of that rule; the 403 is still handled if it arrives.
 */

// ─── Copy deck ───────────────────────────────────────────────────────────────

export const AUDIO_EDIT_COPY = Object.freeze({
  /** Replaces the read-only intro when the panel is mounted with an editor. */
  panelIntro:
    'Track structure as the API reports it. Editorial audio tracks can be added ' +
    'and removed here; video and subtitle tracks are read-only in this panel.',

  /** Shown instead of the controls when the client role may not write. */
  roleNote:
    'Your client role is read-only for assets, so audio tracks cannot be added ' +
    'or removed here. Adding and removing require the editor or admin role.',

  /** Column of per-row controls in the editorial audio table. */
  actionsColumn: 'Actions',

  btnAdd: 'Add audio track',
  btnRemove: 'Remove',
  btnSubmit: 'Add track',
  btnCancel: 'Cancel',
  busyAdding: 'Adding…',
  busyRemoving: 'Removing…',

  formTitle: 'New audio track',
  formIntro:
    'The API assigns the track id. Only a language is required; every other ' +
    'field is optional and is omitted from the request when left blank.',

  labelLanguage: 'Language',
  labelCodec: 'Codec',
  labelChannels: 'Channels',
  labelLabel: 'Label',
  labelDefault: 'Mark as default',

  helpLanguage:
    'Free-form BCP-47 tag, 1–64 characters. The API does not constrain it to a ' +
    'known list.',
  helpCodec: 'Optional, 1–64 characters. Free-form; the API validates length only.',
  helpChannels: 'Optional whole number, 1–64.',
  helpLabel: 'Optional display name, 1–128 characters.',
  helpDefault:
    'The API records this flag as given — it does not clear it on any other ' +
    'track, so more than one track can carry it.',

  /** Client-side refusals, phrased against the server bounds they mirror. */
  errLanguageRequired: 'Language is required.',
  errLanguageLong: 'Language must be 64 characters or fewer.',
  errCodecLong: 'Codec must be 64 characters or fewer.',
  errLabelLong: 'Label must be 128 characters or fewer.',
  errChannelsInteger: 'Channels must be a whole number.',
  errChannelsRange: 'Channels must be between 1 and 64.',

  /** Confirmation dialog for a remove. */
  confirmTitle: 'Remove audio track',
  confirmLabel: 'Remove track',
  confirmAffected1: 'Removes this track from the asset’s editorial audio track list.',
  confirmAffected2:
    'Discards its id, language, codec, channel count, label and default flag. ' +
    'Adding the track again mints a new id.',
  confirmUnaffected1:
    'Deletes no media and no stored object — the API only rewrites the asset’s ' +
    'audio track list.',
  confirmUnaffected2:
    'Leaves the source audio streams the probe reported untouched: they are a ' +
    'separate record set with no link to this one.',
  confirmUnaffected3:
    'Leaves subtitle tracks, the asset’s status and every other field unchanged.',
});

/** Bounds mirrored from `addAudioTrackSchema` (src/routes/assets.ts:821-827). */
export const AUDIO_LANGUAGE_MAX = 64;
export const AUDIO_CODEC_MAX = 64;
export const AUDIO_LABEL_MAX = 128;
export const AUDIO_CHANNELS_MIN = 1;
export const AUDIO_CHANNELS_MAX = 64;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * A human-readable name for a track, for the confirmation dialog's subject.
 *
 * `label` is optional and `language` is `required` on `audioTrackOutSchema`
 * (src/routes/assets.ts:799-806), so there is normally always a real name. The
 * id is the last resort only — a confirmation must never name its subject by an
 * opaque id when anything better exists (the house confirmModal rule).
 *
 * @param {object} track  an `audioTracks[]` item
 * @returns {string}
 */
export function audioTrackName(track) {
  const t = track && typeof track === 'object' ? track : {};
  const label = typeof t.label === 'string' ? t.label.trim() : '';
  if (label !== '') return label;
  const language = typeof t.language === 'string' ? t.language.trim() : '';
  if (language !== '') return language;
  const id = typeof t.id === 'string' ? t.id.trim() : '';
  return id !== '' ? id : 'this audio track';
}

/**
 * Validate the add form against the SERVER's bounds and build the request body.
 *
 * Returns the exact body `addAudioTrackSchema` accepts and nothing else: the
 * schema is `additionalProperties: false`, so a blank optional field is OMITTED
 * rather than sent as `''` (which would fail `minLength: 1`) or as `null`.
 *
 * `default: false` is omitted too. The flag is optional and the panel renders an
 * absent flag and a `false` flag identically, so sending it would only persist a
 * value the operator never set.
 *
 * A refusal here sends no request at all — a 400 from the server's validator is
 * not the normal way an operator should learn these rules.
 *
 * @param {object} raw  `{ language, codec, channels, label, default }` as typed
 * @returns {{ok: true, body: object} | {ok: false, field: string, message: string}}
 */
export function normaliseAddAudioTrackInput(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const str = function (v) {
    return typeof v === 'string' ? v.trim() : '';
  };

  // language — the only `required` property.
  const language = str(r.language);
  if (language === '') {
    return { ok: false, field: 'language', message: AUDIO_EDIT_COPY.errLanguageRequired };
  }
  if (language.length > AUDIO_LANGUAGE_MAX) {
    return { ok: false, field: 'language', message: AUDIO_EDIT_COPY.errLanguageLong };
  }
  const body = { language: language };

  const codec = str(r.codec);
  if (codec !== '') {
    if (codec.length > AUDIO_CODEC_MAX) {
      return { ok: false, field: 'codec', message: AUDIO_EDIT_COPY.errCodecLong };
    }
    body.codec = codec;
  }

  // `channels` is an INTEGER in the contract, so a decimal is refused here
  // rather than sent and bounced.
  const channels = str(r.channels === undefined || r.channels === null ? '' : String(r.channels));
  if (channels !== '') {
    if (!/^\d+$/.test(channels)) {
      return { ok: false, field: 'channels', message: AUDIO_EDIT_COPY.errChannelsInteger };
    }
    const n = Number(channels);
    if (n < AUDIO_CHANNELS_MIN || n > AUDIO_CHANNELS_MAX) {
      return { ok: false, field: 'channels', message: AUDIO_EDIT_COPY.errChannelsRange };
    }
    body.channels = n;
  }

  const label = str(r.label);
  if (label !== '') {
    if (label.length > AUDIO_LABEL_MAX) {
      return { ok: false, field: 'label', message: AUDIO_EDIT_COPY.errLabelLong };
    }
    body.label = label;
  }

  if (r.default === true) body.default = true;

  return { ok: true, body: body };
}

/**
 * The updated audio track list carried by the add operation's 201.
 *
 * `{ audioTracks }` is `required` on that response (src/routes/assets.ts:5333),
 * so a body without it is a non-conforming server; `null` is returned rather
 * than an empty array, so the caller can tell "the server told us the list is
 * empty" from "the server told us nothing" and re-read instead of blanking the
 * section.
 *
 * @param {unknown} body  the parsed 201 body
 * @returns {object[]|null}
 */
export function audioTracksFromResponse(body) {
  if (!body || typeof body !== 'object') return null;
  if (!Array.isArray(body.audioTracks)) return null;
  return body.audioTracks.filter(function (t) {
    return t !== null && typeof t === 'object';
  });
}

/**
 * Turn a thrown apiFetch error into operator copy, per operation.
 *
 * Only statuses the contract actually declares get specific copy; everything
 * else falls through to the server's own message, so an unmodelled failure is
 * reported rather than relabelled as something this module recognises.
 *
 * `kind: 'gone'` means the server says the thing is already not there — the
 * caller refreshes the section so the UI stops showing a track the API does not
 * have. `kind: 'forbidden'` means the control should stop being offered.
 *
 * @param {Error & {status?: number, body?: any}} err
 * @param {'add'|'remove'} op
 * @returns {{kind: string, message: string}}
 */
export function classifyAudioTrackError(err, op) {
  const e = err || {};
  const status = typeof e.status === 'number' ? e.status : 0;
  const serverMessage = typeof e.message === 'string' && e.message !== '' ? e.message : '';

  if (status === 401) {
    return {
      kind: 'unauthenticated',
      message:
        'The API rejected the request as unauthenticated. Reload the page and ' +
        'try again.',
    };
  }
  if (status === 403) {
    return {
      kind: 'forbidden',
      message:
        'Your role may not change this asset’s audio tracks. Adding and ' +
        'removing require the editor or admin role.',
    };
  }
  if (status === 404) {
    // The remove handler distinguishes a missing ASSET (no `message`) from a
    // missing TRACK (`message` present) — see CONTRACT GROUNDING. Keyed on
    // presence, never on the sentence.
    const hasMessage =
      e.body && typeof e.body === 'object' && typeof e.body.message === 'string';
    if (op === 'remove' && hasMessage) {
      return {
        kind: 'gone',
        message:
          'That audio track is no longer on this asset — it may already have ' +
          'been removed. The list has been refreshed.',
      };
    }
    return {
      kind: 'asset-gone',
      message:
        'This asset was not found. It may have been deleted, or it belongs to ' +
        'another workspace.',
    };
  }
  if (status === 400 || status === 422) {
    // Undeclared on both operations: Fastify's validator refused the body
    // before the handler ran. Report what it said rather than guessing.
    return {
      kind: 'invalid',
      message:
        'The API rejected the track as invalid' +
        (serverMessage ? ': ' + serverMessage : '.'),
    };
  }

  const verb = op === 'remove' ? 'Removing the audio track failed' : 'Adding the audio track failed';
  return { kind: 'failed', message: verb + (serverMessage ? ': ' + serverMessage : '.') };
}

/**
 * The confirmModal spec for removing one track.
 *
 * Every line in the two impact lists was read off the DELETE handler
 * (src/routes/assets.ts:5369-5382), which filters the list and patches exactly
 * one key — it touches no file, no object store and no other field.
 *
 * @param {object} track  the `audioTracks[]` item being removed
 * @returns {object} a spec-form confirmModal argument
 */
export function removeAudioTrackConfirmSpec(track) {
  const t = track && typeof track === 'object' ? track : {};
  const name = audioTrackName(t);
  const id = typeof t.id === 'string' ? t.id : '';
  return {
    title: AUDIO_EDIT_COPY.confirmTitle,
    subject: name,
    question: 'Remove the audio track "' + name + '" from this asset?',
    detail: id ? 'Track ID ' + id : undefined,
    confirmLabel: AUDIO_EDIT_COPY.confirmLabel,
    affected: [AUDIO_EDIT_COPY.confirmAffected1, AUDIO_EDIT_COPY.confirmAffected2],
    unaffected: [
      AUDIO_EDIT_COPY.confirmUnaffected1,
      AUDIO_EDIT_COPY.confirmUnaffected2,
      AUDIO_EDIT_COPY.confirmUnaffected3,
    ],
  };
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function field(id, labelText, helpText, input) {
  const wrap = el('div', 'form-field');
  const label = el('label', null, labelText);
  label.setAttribute('for', id);
  input.id = id;
  const help = el('div', 'tracks-note', helpText);
  help.id = id + '-help';
  input.setAttribute('aria-describedby', help.id);
  wrap.appendChild(label);
  wrap.appendChild(input);
  wrap.appendChild(help);
  return wrap;
}

function textInput(maxLength) {
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = maxLength;
  return input;
}

// ─── Editor ──────────────────────────────────────────────────────────────────

/**
 * Create the audio-track editor the tracks panel renders its controls from.
 *
 * Stateful and long-lived: it is created ONCE per mounted panel and survives the
 * panel's re-renders, so the open/closed state of the add form, the inline error
 * and the success line are not lost when a successful write re-renders the
 * section underneath them.
 *
 * It owns the two writes and the post-remove re-read. It does not own the list:
 * after a successful call it hands the new array to `onChanged` and lets the
 * panel re-render — so the audio section refreshes in place, with no page
 * reload and no re-read of the whole asset.
 *
 * @param {object} opts
 * @param {string}   opts.assetId   the asset ULID. NOT the slug: every track
 *                                  route hands the raw path param to
 *                                  `repo.get` with no slug fallback
 *                                  (src/routes/assets.ts:5339, :5370).
 * @param {Function} opts.apiFetch  app.js apiFetch (path, init) -> parsed body
 * @param {Function} opts.confirmModal  app.js confirmModal (spec) -> Promise<boolean>
 * @param {(audioTracks: object[]) => void} opts.onChanged
 *                                  called with the post-write list after a
 *                                  successful add or remove, before focus moves
 * @returns {object} the editor handle the panel renders from
 */
export function createAudioTrackEditor(opts) {
  const o = opts || {};
  const apiFetch = typeof o.apiFetch === 'function' ? o.apiFetch : null;
  const confirmRemove = typeof o.confirmModal === 'function' ? o.confirmModal : null;
  const onChanged = typeof o.onChanged === 'function' ? o.onChanged : function () {};

  const basePath = '/assets/' + encodeURIComponent(String(o.assetId == null ? '' : o.assetId)) +
    '/audio-tracks';

  // Survives re-render. `draft` is kept so a refused add does not throw away
  // what was typed — the operator fixes one field, not the whole form.
  const state = {
    formOpen: false,
    busy: false,
    error: null,
    status: null,
    retired: false,
    draft: { language: '', codec: '', channels: '', label: '', default: false },
  };

  // The list currently on screen, handed in by the panel on every render. Used
  // only as the fallback when the post-remove re-read fails.
  let tracks = [];

  // Rebuilt on every render; the container persists so the form can be toggled
  // without re-rendering the whole block.
  let container = null;
  let refs = {};

  // The per-row Remove buttons of the CURRENT render, so an in-flight write can
  // disable every control it could race with — not just the one that was
  // clicked. Cleared by setTracks(), which the panel calls once per render
  // before it asks for any row control.
  let rowButtons = [];

  /** Disable/enable every control in the section for the duration of a write. */
  function setBusy(flag) {
    state.busy = !!flag;
    rowButtons.forEach(function (b) {
      b.disabled = state.busy || state.retired;
    });
  }

  function resetDraft() {
    state.draft = { language: '', codec: '', channels: '', label: '', default: false };
  }

  function captureDraft() {
    if (!refs.language) return;
    state.draft = {
      language: refs.language.value,
      codec: refs.codec.value,
      channels: refs.channels.value,
      label: refs.label.value,
      default: !!refs.isDefault.checked,
    };
  }

  function showError(message, focusField) {
    state.status = null;
    state.error = message;
    renderControls();
    if (focusField && refs[focusField]) refs[focusField].focus();
  }

  /** Apply a post-write list: refresh the section, then put focus somewhere real. */
  function applyChange(next, message) {
    state.error = null;
    state.status = message;
    state.formOpen = false;
    resetDraft();
    // Re-renders the panel underneath us, which calls back into renderAddBlock()
    // and replaces `container`. Focus afterwards: focus() on a node that is still
    // detached is a no-op.
    onChanged(next);
    if (refs.addBtn) refs.addBtn.focus();
  }

  // ── Writes ──

  async function submitAdd() {
    captureDraft();
    const check = normaliseAddAudioTrackInput(state.draft);
    if (!check.ok) {
      showError(check.message, check.field);
      return;
    }
    if (!apiFetch || state.busy) return;

    setBusy(true);
    state.error = null;
    renderControls();
    try {
      // POST /assets/{id}/audio-tracks — 201 carries the FULL updated list, so
      // no follow-up read is needed (see CONTRACT GROUNDING).
      const body = await apiFetch(basePath, {
        method: 'POST',
        body: JSON.stringify(check.body),
      });
      const next = audioTracksFromResponse(body);
      setBusy(false);
      if (next === null) {
        // The 201 is contractually required to carry `audioTracks`. If it did
        // not, say so instead of blanking the section on a guess.
        showError(
          'The track may have been added, but the API did not return the updated ' +
            'track list. Reload the asset to see the current tracks.',
          null
        );
        return;
      }
      applyChange(next, 'Added audio track "' + audioTrackName(check.body) + '".');
    } catch (err) {
      setBusy(false);
      const c = classifyAudioTrackError(err, 'add');
      if (c.kind === 'forbidden') state.retired = true;
      showError(c.message, c.kind === 'invalid' ? 'language' : null);
    }
  }

  async function submitRemove(track) {
    if (!apiFetch || state.busy) return;
    const id = track && typeof track.id === 'string' ? track.id : '';
    if (id === '') return;

    // The explicit confirmation step. One dialog per action: a dismissal is a
    // no-op and sends nothing.
    if (confirmRemove) {
      const ok = await confirmRemove(removeAudioTrackConfirmSpec(track));
      if (!ok) return;
    }

    setBusy(true);
    state.error = null;
    renderControls();
    try {
      // DELETE /assets/{id}/audio-tracks/{trackId} — 204, empty body, no
      // content-type, so apiFetch resolves null and there is nothing to read.
      await apiFetch(basePath + '/' + encodeURIComponent(id), { method: 'DELETE' });
    } catch (err) {
      setBusy(false);
      const c = classifyAudioTrackError(err, 'remove');
      if (c.kind === 'forbidden') state.retired = true;
      if (c.kind === 'gone') {
        // The server says it is already not there, so the list on screen is
        // stale: refresh it AND keep the explanation visible.
        const refreshed = await readTracks();
        if (refreshed) {
          state.error = c.message;
          state.status = null;
          state.formOpen = false;
          onChanged(refreshed);
          return;
        }
      }
      showError(c.message, null);
      return;
    }

    // The removal succeeded. The 204 carried no list, so re-read the dedicated
    // tracks endpoint for the authoritative one.
    const name = audioTrackName(track);
    const refreshed = await readTracks();
    setBusy(false);
    if (refreshed) {
      applyChange(refreshed, 'Removed audio track "' + name + '".');
      return;
    }
    // The write landed but the re-read did not. Apply the same filter the server
    // applied (`t.id !== trackId`, src/routes/assets.ts:5375) so the section is
    // not left showing a track that is gone, and say the re-read failed.
    const local = tracks.filter(function (t) {
      return !t || t.id !== id;
    });
    state.status = null;
    state.formOpen = false;
    state.error =
      'Removed audio track "' + name + '", but re-reading the track list failed. ' +
      'The list below may be out of date — reload the asset to confirm.';
    onChanged(local);
  }

  /**
   * GET /assets/{id}/tracks for the post-write audio list. Returns null (never
   * an empty array) when the read fails or answers a shape the contract does not
   * declare, so the caller can tell a real empty list from a failed read.
   */
  async function readTracks() {
    if (!apiFetch) return null;
    try {
      const body = await apiFetch(
        '/assets/' + encodeURIComponent(String(o.assetId == null ? '' : o.assetId)) + '/tracks'
      );
      return audioTracksFromResponse(body);
    } catch (_) {
      return null;
    }
  }

  // ── Rendering ──

  function buildForm() {
    const form = el('div', 'audio-track-form');
    form.setAttribute('role', 'group');
    form.setAttribute('aria-label', AUDIO_EDIT_COPY.formTitle);

    form.appendChild(el('div', 'tracks-group-title', AUDIO_EDIT_COPY.formTitle));
    form.appendChild(el('div', 'tracks-note', AUDIO_EDIT_COPY.formIntro));

    const row = el('div', 'form-row mt12');

    refs.language = textInput(AUDIO_LANGUAGE_MAX);
    refs.language.value = state.draft.language;
    refs.language.required = true;
    row.appendChild(
      field('audio-track-language', AUDIO_EDIT_COPY.labelLanguage, AUDIO_EDIT_COPY.helpLanguage, refs.language)
    );

    refs.codec = textInput(AUDIO_CODEC_MAX);
    refs.codec.value = state.draft.codec;
    row.appendChild(
      field('audio-track-codec', AUDIO_EDIT_COPY.labelCodec, AUDIO_EDIT_COPY.helpCodec, refs.codec)
    );

    // `type=text` with an inputmode rather than `type=number`: the contract wants
    // an INTEGER and a number input would happily hand over "2.5" or an empty
    // string for unparseable text, hiding the refusal from the operator.
    refs.channels = textInput(2);
    refs.channels.value = state.draft.channels;
    refs.channels.setAttribute('inputmode', 'numeric');
    row.appendChild(
      field('audio-track-channels', AUDIO_EDIT_COPY.labelChannels, AUDIO_EDIT_COPY.helpChannels, refs.channels)
    );

    refs.label = textInput(AUDIO_LABEL_MAX);
    refs.label.value = state.draft.label;
    row.appendChild(
      field('audio-track-label', AUDIO_EDIT_COPY.labelLabel, AUDIO_EDIT_COPY.helpLabel, refs.label)
    );

    form.appendChild(row);

    const checkWrap = el('div', 'checkbox-group');
    const checkLabel = el('label', 'checkbox-label');
    refs.isDefault = document.createElement('input');
    refs.isDefault.type = 'checkbox';
    refs.isDefault.id = 'audio-track-default';
    refs.isDefault.checked = !!state.draft.default;
    checkLabel.setAttribute('for', refs.isDefault.id);
    checkLabel.appendChild(refs.isDefault);
    checkLabel.appendChild(el('span', null, AUDIO_EDIT_COPY.labelDefault));
    checkWrap.appendChild(checkLabel);
    form.appendChild(checkWrap);
    form.appendChild(el('div', 'tracks-note', AUDIO_EDIT_COPY.helpDefault));

    const actions = el('div', 'flex-gap mt12');
    refs.cancelBtn = el('button', 'btn-sm audio-track-cancel', AUDIO_EDIT_COPY.btnCancel);
    refs.cancelBtn.type = 'button';
    refs.submitBtn = el(
      'button',
      'btn-sm audio-track-submit',
      state.busy ? AUDIO_EDIT_COPY.busyAdding : AUDIO_EDIT_COPY.btnSubmit
    );
    refs.submitBtn.type = 'button';
    refs.submitBtn.id = 'audio-track-submit';
    refs.submitBtn.disabled = state.busy;
    refs.cancelBtn.disabled = state.busy;
    if (state.busy) refs.submitBtn.setAttribute('aria-busy', 'true');

    refs.cancelBtn.addEventListener('click', function () {
      // Cancel discards the draft outright: the next "Add audio track" opens a
      // blank form, not a half-finished one from an abandoned attempt.
      state.formOpen = false;
      state.error = null;
      resetDraft();
      renderControls();
      if (refs.addBtn) refs.addBtn.focus();
    });
    refs.submitBtn.addEventListener('click', function () {
      submitAdd();
    });

    actions.appendChild(refs.submitBtn);
    actions.appendChild(refs.cancelBtn);
    form.appendChild(actions);

    return form;
  }

  /** Rebuild the add block's contents in place, from `state`. */
  function renderControls() {
    if (!container) return;
    container.textContent = '';
    refs = { addBtn: null };

    if (state.retired) {
      // A 403 proved the control cannot succeed; it stops being offered rather
      // than inviting a second refusal.
      container.appendChild(el('div', 'tracks-note', AUDIO_EDIT_COPY.roleNote));
    } else if (state.formOpen) {
      container.appendChild(buildForm());
    } else {
      const addBtn = el('button', 'btn-sm btn-ghost audio-track-add', AUDIO_EDIT_COPY.btnAdd);
      addBtn.type = 'button';
      addBtn.id = 'btn-add-audio-track';
      addBtn.disabled = state.busy;
      addBtn.addEventListener('click', function () {
        state.formOpen = true;
        state.error = null;
        state.status = null;
        renderControls();
        if (refs.language) refs.language.focus();
      });
      refs.addBtn = addBtn;
      const row = el('div', 'flex-gap');
      row.appendChild(addBtn);
      container.appendChild(row);
    }

    // Inline error. `role="alert"` so a refusal is announced rather than only
    // drawn; it is never an alert() and never a silently dropped change.
    const errorEl = el('div', 'msg msg-error audio-track-error');
    errorEl.id = 'audio-track-error';
    errorEl.setAttribute('role', 'alert');
    if (state.error) errorEl.textContent = state.error;
    else errorEl.style.display = 'none';
    container.appendChild(errorEl);

    // Success line. `role="status"` (polite) so it does not interrupt.
    const statusEl = el('div', 'msg msg-success audio-track-status');
    statusEl.id = 'audio-track-status';
    statusEl.setAttribute('role', 'status');
    if (state.status) statusEl.textContent = state.status;
    else statusEl.style.display = 'none';
    container.appendChild(statusEl);
  }

  return {
    /** Column header the panel adds to the editorial audio table. */
    actionsColumn: AUDIO_EDIT_COPY.actionsColumn,

    /** Intro copy that replaces the read-only panel's "Read-only — …" line. */
    panelIntro: AUDIO_EDIT_COPY.panelIntro,

    /**
     * The panel hands over the list it is about to render, every render. Also
     * the per-render reset point for the row controls: the buttons registered
     * here belong to the DOM that is about to be replaced.
     */
    setTracks: function (list) {
      tracks = Array.isArray(list) ? list : [];
      rowButtons = [];
    },

    /**
     * The per-row Remove control.
     *
     * The visible text is just "Remove"; the accessible name names the track, so
     * a screen-reader user hitting six identical buttons can tell them apart
     * (WCAG 2.4.6). The visible string is a prefix of the accessible name, so
     * speech input still works (WCAG 2.5.3).
     */
    removeControl: function (track) {
      const btn = el('button', 'btn-sm btn-danger audio-track-remove', AUDIO_EDIT_COPY.btnRemove);
      btn.type = 'button';
      btn.disabled = state.busy || state.retired;
      btn.setAttribute('data-track-id', track && track.id ? String(track.id) : '');
      btn.setAttribute(
        'aria-label',
        AUDIO_EDIT_COPY.btnRemove + ' audio track ' + audioTrackName(track)
      );
      btn.addEventListener('click', function () {
        submitRemove(track);
      });
      rowButtons.push(btn);
      return btn;
    },

    /**
     * The add block: the button or the open form, plus the error and status
     * regions. Returns the SAME container across renders of its own contents,
     * but a fresh one per panel render — the panel rebuilds its DOM wholesale.
     */
    addBlock: function () {
      container = el('div', 'mt12 audio-track-controls');
      renderControls();
      return container;
    },
  };
}
