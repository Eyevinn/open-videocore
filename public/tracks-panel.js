/**
 * open-videocore ops dashboard — tracks-panel.js
 *
 * The read-only "Tracks" block on the asset detail view (issue #902, broken out
 * of #794): one section per track kind — video, audio, subtitle — each listing
 * only the attributes the API actually exposes for that kind, and each with an
 * explicit empty state when the asset has none.
 *
 * READ-ONLY BY DEFAULT, with ONE opt-in exception: the subtitle section gains
 * add + remove controls when — and only when — the caller passes
 * `subtitleControls` (issue #904, see "SUBTITLE CONTROLS" below). Without that
 * argument this module still creates no form control and issues no request of
 * any kind, so the video and audio sections remain read-only reporting surfaces
 * and the audio add/remove routes that exist have nothing here to originate
 * from. It never issues a GET during render either: every value the first render
 * shows is already in the `GET /assets/{id}` body the detail view fetched, so
 * the panel adds no round-trip to the render.
 *
 * Every operator-visible string is written with `textContent` / `createElement`
 * — no server value ever reaches `innerHTML`, including a subtitle `format` or
 * a `language` this build does not recognise, which are rendered verbatim as
 * text rather than guessed at or dropped.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's generated spec and route source on this branch. Nothing
 * is taken from the issue text — in particular the issue names three endpoints
 * as sources and two of them have no GET at all (see "What the API does NOT
 * expose" below). `openapi.json` declares no `operationId` on any operation, so
 * operations are identified below by path + method, as the spec itself does.
 *
 *   EVERYTHING HERE COMES FROM ONE READ —
 *   `openapi.json .paths["/api/v1/assets/{id}"].get`, 200 schema. That body
 *   carries the editorial tracks AND the probe's technical metadata, so the
 *   panel needs no call of its own.
 *
 *   AUDIO + SUBTITLE (editorial) — properties `audioTracks` / `subtitleTracks`
 *     of that same 200 schema. NEITHER is in `required`:
 *       `audioTracks[]` items: `{ id: string, language: string, codec?: string,
 *         channels?: number, label?: string, default?: boolean }`,
 *         `required: ["id","language"]`, `additionalProperties: false`.
 *       `subtitleTracks[]` items: `{ id: string, language: string,
 *         format: "vtt"|"srt"|"ttml", objectKey?: string, label?: string,
 *         default?: boolean }`, `required: ["id","language","format"]`,
 *         `additionalProperties: false`.
 *     Source of truth: `assetSchema` —
 *       `audioTracks: z.array(audioTrackOutSchema).optional()`
 *       (src/routes/assets.ts:907) and
 *       `subtitleTracks: z.array(subtitleTrackOutSchema).optional()` (:908),
 *       `audioTrackOutSchema` :795-802, `subtitleTrackOutSchema` :806-813; the
 *       subtitle vocabulary is `SUBTITLE_FORMATS = ['vtt','srt','ttml']`,
 *       src/data/asset-repo.ts:449, reached via `subtitleFormatSchema`
 *       (src/routes/assets.ts:804).
 *     ABSENT MEANS "NONE", NOT "UNKNOWN". The field is optional because the
 *       arrays are "absent until the first track of the respective kind is
 *       added" (src/routes/assets.ts:905-906); persistence only writes the
 *       block when the array is non-empty (`doc.structural.editorialAudio` /
 *       `editorialSubtitles`, src/data/asset-document.ts:553-557) and reads it
 *       straight back (:693-694). So an omitted array is an empty one, and this
 *       panel renders the kind's empty state — never an "unknown" state.
 *
 *   VIDEO — property `technicalMetadata` of the same 200 schema (nullable
 *     object, NOT in `required`):
 *       `{ codec: string, width: number, height: number,
 *          durationSeconds: number, bitrateBps: number,
 *          containerFormat: string, audioTracks: […], extractedAt: string }`,
 *       all eight `required`, `additionalProperties: false`.
 *     Source of truth: `technicalMetadata: technicalMetadataSchema.nullish()`
 *       (src/routes/assets.ts:884) with `technicalMetadataError: z.string()
 *       .optional()` (:885); `technicalMetadataSchema` :752-762.
 *     Of those eight, exactly FOUR are video-track attributes:
 *       `codec`, `width`, `height`, `bitrateBps`. That is not a judgement call —
 *       it is the tuple the persistence layer writes into the document's video
 *       track array: `technical.video = [{ codec, width, height, bitrateBps }]`
 *       (`technicalFromAsset`, src/data/asset-document.ts:402-404), read back as
 *       `technical.video?.[0]` (`technicalToAsset`, :422). `durationSeconds` and
 *       `containerFormat` are CONTAINER-level (they map to `technical.durationMs`
 *       / `technical.container`, :400-401), so they are not shown as track
 *       attributes here; they already appear in the detail KV grid.
 *     Deliberately NOT rendered: `frameRate` and `index`. Both exist on the
 *       stored `VideoTrackSchema` (src/data/asset-document.ts:51-58) but NO
 *       response schema exposes them, so there is nothing to read.
 *
 *   AUDIO, AS PROBED — the nested `technicalMetadata.audioTracks[]` array:
 *     items `{ index: number, codec: string, channels: number,
 *     sampleRateHz: number }`, all four `required`,
 *     `additionalProperties: false` (`audioTrackSchema`,
 *     src/routes/assets.ts:745-750; persisted as `technical.audio`,
 *     src/data/asset-document.ts:405-410).
 *     This is a DIFFERENT set of objects from the editorial `audioTracks` at the
 *     top level of the asset: different fields, different lifecycle (one is
 *     written by the ffprobe extraction, the other by an operator), no shared
 *     id. They share only a name. The audio section therefore lists them as two
 *     labelled groups and never merges, correlates, de-duplicates or SUMS them —
 *     the API publishes no key that would justify any of that, so each group
 *     carries its own count and the `Audio` heading carries none.
 *
 * WHAT THE API DOES NOT EXPOSE (checked, not assumed):
 *   - There is no GET on `/api/v1/assets/{id}/audio-tracks` or
 *     `…/subtitle-tracks`. In `openapi.json` those paths carry only `post`, and
 *     `…/{trackId}` only `delete` (src/routes/assets.ts:5279, 5314, 5344, 5392).
 *   - `GET /api/v1/assets/{id}/tracks` DOES exist and is the only *dedicated*
 *     read for the two editorial kinds — but it is not a second source of truth:
 *     its handler sends `asset.audioTracks ?? []` / `asset.subtitleTracks ?? []`
 *     from the very same document (src/routes/assets.ts:5268-5271, via
 *     `repo.get(request.params.id)` at :5264). A caller that already holds the
 *     asset — which the detail view always does — would be paying a round-trip
 *     for bytes it has, so this panel does not call it.
 *   - There is no video-track endpoint and no video-track ARRAY in any response:
 *     no path in `openapi.json` contains "video", and `technicalMetadata` carries
 *     one flattened set of video attributes. So this panel can list at most one
 *     video track for an asset, however many the source file holds. That ceiling
 *     is the API's, not this module's, and the section says so on screen rather
 *     than implying the file has exactly one video stream.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SUBTITLE CONTROLS — CONTRACT GROUNDING (issue #904, CLAUDE.md rule 7)
 *
 * Fetched from this repo's generated spec and route source on this branch before
 * either call below was written. Nothing is taken from the issue text.
 *
 *   ADD — `POST /api/v1/assets/{id}/subtitle-tracks`
 *     openapi.json .paths["/api/v1/assets/{id}/subtitle-tracks"].post;
 *     handler src/routes/assets.ts:5390-5432.
 *     Path param: `id` only (`z.object({ id: z.string() })`, :5395). It is the
 *       ULID — the handler passes the raw param to `repo.get` (:5404) with NO
 *       slug fallback, so a slug would 404.
 *     Body REQUIRED, `addSubtitleTrackSchema` (src/routes/assets.ts:829-834),
 *       `additionalProperties: false`:
 *         language  string, min 1, max 64   — REQUIRED
 *         format    "vtt" | "srt" | "ttml"  — REQUIRED
 *                   (`subtitleFormatSchema` :808 over
 *                    `SUBTITLE_FORMATS` src/data/asset-repo.ts:449)
 *         label     string, min 1, max 128  — optional
 *         default   boolean                 — optional
 *       Four fields, and no fifth: `objectKey` and `id` are NOT accepted —
 *       the id is server-generated (`randomUUID()`, :5408) and the object key is
 *       derived by the route (:5411). So this panel sends no id and no key.
 *     201 → `{ track, uploadUrl? }` (:5398). `track` is `subtitleTrackOutSchema`
 *       (:810-817) — the ONE new track, NOT the full list, which is why a
 *       successful add is followed by a re-read (below) rather than an
 *       append-in-place. `uploadUrl` is a presigned PUT, present only when
 *       object storage is configured (:5413-5416); it is NEVER rendered — it is
 *       a credential-bearing URL — and uploading subtitle BYTES is not part of
 *       this panel (#904 is add/remove of the track record).
 *     404 → `{ error, message? }` (`errorSchema`) for an unknown/foreign asset.
 *     APPEND-ONLY, verified: the handler spreads the existing array and pushes
 *       (`[...(asset.subtitleTracks ?? []), track]`, :5428). It does NOT clear
 *       `default` on the other tracks, so an asset CAN end up with two tracks
 *       flagged default. The form says so instead of implying otherwise.
 *
 *   REMOVE — `DELETE /api/v1/assets/{id}/subtitle-tracks/{trackId}`
 *     openapi.json .paths["/api/v1/assets/{id}/subtitle-tracks/{trackId}"]
 *       .delete; handler src/routes/assets.ts:5438-5460.
 *     Path params `{ id, trackId }` (:5443). No body, no query parameter: the
 *       operation declares `parameters` for the two path params and nothing else.
 *     204 → empty (`z.null()`, :5444), so a successful remove returns NO list
 *       and the fresh list must be re-read.
 *     404 → `{ error, message }` for an unknown asset AND for a track id that is
 *       not on it (`message: 'subtitle track not found'`, :5455). The two are not
 *       machine-distinguishable, so the inline error does not claim to tell them
 *       apart.
 *     The STORED FILE SURVIVES: "Leaves the subtitle object (if any) in storage"
 *       (:5434-5435) — the handler only filters the list (:5453) and patches
 *       `subtitleTracks` (:5457, applied as the single key by
 *       src/data/couch-asset-repo.ts:416-417). The confirmation step says this in
 *       words rather than letting the operator assume a file was deleted.
 *
 *   REFRESH AFTER A WRITE — `GET /api/v1/assets/{id}/tracks`
 *     openapi.json .paths["/api/v1/assets/{id}/tracks"].get → 200
 *     `{ audioTracks, subtitleTracks }`, BOTH `required` (`tracksSchema`,
 *     src/routes/assets.ts:836-839; handler :5301-5320 sends
 *     `asset.audioTracks ?? []` / `asset.subtitleTracks ?? []`, read through
 *     `repo.get(request.params.id)` at :5311).
 *     This is the read the panel refuses at RENDER time (it already holds those
 *     bytes) and needs after a WRITE, when it no longer does: neither write
 *     returns the resulting list. It is the smallest authoritative read of the
 *     two editorial arrays — the alternative is the whole asset body — and it
 *     cannot drift from the asset, since the handler projects the same document.
 *     Only the subtitle section is re-rendered from it; the video and probed-audio
 *     attributes come from `technicalMetadata`, which neither write touches.
 *
 *   AUTHORISATION — `editor` and `admin` only, mirrored client-side.
 *     Both routes sit under the assets router's two preHandlers: `authGate(app)`
 *     (src/routes/assets.ts:1738) and `resourceAuthorizationPreHandler('asset')`
 *     (:1748). `methodToAction` maps POST → `write` and DELETE → `delete`
 *     (src/auth/authorize.ts:79-93) and `MATRIX` (:54-58) grants both to `editor`
 *     and `admin` and neither to `viewer`. Refusal is 403
 *     `forbidden_insufficient_role` (`AUTHZ_FORBIDDEN_ERROR`, :99). The
 *     `canChange` flag is a MIRROR of that rule, not a substitute: a 403 that
 *     arrives anyway is still reported inline.
 */

// ─── Copy deck ───────────────────────────────────────────────────────────────

export const TRACKS_COPY = Object.freeze({
  heading: 'Tracks',
  /** Says outright that this block only reports; #902 is read-only. */
  intro:
    'Track structure as the API reports it. Read-only — tracks are added and ' +
    'removed through the API, not from this panel.',

  videoHeading: 'Video',
  audioHeading: 'Audio',
  subtitleHeading: 'Subtitles',

  /** Sub-group labels inside the audio section (two distinct record sets). */
  audioEditorialGroup: 'Editorial tracks',
  audioProbedGroup: 'Source streams',

  /** The one-video-track ceiling is the API's; say so instead of implying it. */
  videoNote:
    'The API reports one set of video attributes per asset, so this section ' +
    'lists at most one track — even if the source file carries more. Frame rate ' +
    'and stream index are not exposed by the API and are not shown.',
  audioNote:
    'Editorial tracks are the ones registered against this asset; source ' +
    'streams are what the probe found in the file. The API publishes no link ' +
    'between the two, so they are counted and listed separately and never added ' +
    'together.',

  /** Empty states — one per track kind (issue #902). */
  videoEmpty: 'No video tracks.',
  audioEmpty: 'No audio tracks.',
  subtitleEmpty: 'No subtitle tracks.',
  /** Why a kind is empty, when the API says why. */
  videoEmptyDetail:
    'Technical metadata has not been extracted for this asset yet, so no video ' +
    'track is reported.',
  videoEmptyErrorPrefix: 'Technical metadata extraction failed: ',
  audioEmptyDetail:
    'No editorial audio track is registered and the probe reported no audio ' +
    'stream.',
  subtitleEmptyDetail: 'No subtitle track is registered for this asset.',
  /** An empty sub-group shown alongside a non-empty one. */
  audioEditorialNone: 'No editorial audio tracks.',
  audioProbedNone: 'No audio streams reported by the probe.',

  /** Marks the track the API flagged `default: true`. Text, never colour alone. */
  defaultFlag: 'Default',
  /** Every optional attribute the server omitted. */
  absent: '—',

  // ── Subtitle add/remove controls (issue #904) ──
  // Only used when the caller opts in with `subtitleControls`.

  /** Replaces `intro` when the subtitle section is editable. */
  introEditable:
    'Track structure as the API reports it. Subtitle tracks can be added and ' +
    'removed here; video and audio are reported only.',

  actionsColumn: 'Actions',
  btnRemove: 'Remove',
  btnRemovePending: 'Removing…',

  addHeading: 'Add a subtitle track',
  fieldLanguage: 'Language',
  fieldFormat: 'Format',
  fieldLabel: 'Label',
  fieldDefault: 'Default track',
  btnAdd: 'Add track',
  btnAddPending: 'Adding…',

  /** Field help, each one a statement about the route, not a guess. */
  helpLanguage: 'Free-form language code, e.g. sv or en-GB. Required.',
  helpLabel: 'Optional display name. Left blank, no label is sent.',
  helpDefault:
    'The API appends the track as given and does not clear the flag on the ' +
    'others, so more than one track can end up marked default.',
  /** The track record is registered; the subtitle file is a separate concern. */
  addNote:
    'This registers the track on the asset. The subtitle file itself is ' +
    'uploaded through the API, not from this panel, so a new track lists no ' +
    'object key until that upload is done.',

  /** Client-side mirrors of the body schema, so an unsendable value is caught. */
  errLanguageRequired: 'Language is required.',
  errLanguageTooLong: 'Language must be 64 characters or fewer.',
  errLabelTooLong: 'Label must be 128 characters or fewer.',
  errFormatUnknown: 'Choose a subtitle format.',

  /** Outcomes. Every one of them lands inline, in the subtitle section. */
  addedOne: 'Subtitle track added.',
  removedOne: 'Subtitle track removed.',
  /** A write succeeded but the follow-up read did not — say exactly that. */
  refreshFailed:
    'The change was saved, but re-reading the track list failed, so the list ' +
    'below may be stale. Reload the asset to see it.',
  errForbidden:
    'Your role may not change subtitle tracks. Switch to editor or admin and ' +
    'try again.',
  errAddNotFound:
    'The API answered 404: this asset no longer exists. Reload the asset.',
  errRemoveNotFound:
    'The API answered 404: either the asset or that track no longer exists — ' +
    'the two are not distinguishable from the response. Reload the asset.',
  errAddFailedPrefix: 'Adding the track failed: ',
  errRemoveFailedPrefix: 'Removing the track failed: ',

  /** Shown instead of the controls when the client role may not write. */
  viewerNote:
    'Your role can view subtitle tracks but not add or remove them (editor or ' +
    'admin is required).',

  /** The name used for a track in the confirmation step when it has no label. */
  unnamedTrack: 'this subtitle track',
  confirmTitle: 'Remove subtitle track',
  confirmRemoveLabel: 'Remove track',
  confirmAffected:
    'The track is dropped from this asset’s subtitle track list.',
  confirmAffectedBurnIn:
    'A burn-in or packaging run that references this track id is refused ' +
    'afterwards, because the id is resolved against the asset’s own list.',
  confirmUnaffectedFile:
    'The subtitle file in object storage is left in place — the API removes the ' +
    'list entry only and never deletes the object.',
  confirmUnaffectedOthers:
    'No other subtitle track, and no audio or video track, is changed.',
  confirmFileDetailPrefix: 'Subtitle file still in storage: ',
  confirmNoFileDetail: 'No subtitle file is recorded for this track yet.',
});

/**
 * The subtitle `format` vocabulary, as an ordered list for the add form.
 *
 * Copied from the contract, not invented: `subtitleFormatSchema =
 * z.enum(SUBTITLE_FORMATS)` (src/routes/assets.ts:808) over
 * `SUBTITLE_FORMATS = ['vtt','srt','ttml']` (src/data/asset-repo.ts:449), which
 * is also what `openapi.json` publishes as the `format` enum on both the request
 * and the response schema. A format outside this list is rejected by the route,
 * so the form offers exactly these three and no free-text alternative.
 *
 * Rendering is unaffected: an existing track whose `format` this build does not
 * recognise is still LISTED verbatim (see `appendSubtitleSection`) — the API owns
 * the vocabulary, and this list only constrains what the panel may SEND.
 */
export const SUBTITLE_FORMATS = Object.freeze(['vtt', 'srt', 'ttml']);

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * The asset's editorial audio + subtitle tracks, straight off the
 * `GET /api/v1/assets/{id}` 200 body.
 *
 * Both properties are `.optional()` in `assetSchema`
 * (src/routes/assets.ts:907-908) and absent means the asset has none of that
 * kind (:905-906) — not that the answer is unknown. An absent or non-array
 * value therefore yields `[]`, which the sections render as their explicit
 * empty state.
 *
 * Non-object entries are dropped (nothing the schema could have produced), and
 * entries missing a `required` field are kept: a server that omits one is
 * reported as it answered, with `—` in that cell, rather than silently hidden.
 *
 * @param {object} asset  a `GET /api/v1/assets/{id}` 200 body
 * @returns {{ audioTracks: object[], subtitleTracks: object[] }}
 */
export function editorialTracksFromAsset(asset) {
  const a = asset && typeof asset === 'object' ? asset : {};
  const objectsOnly = function (value) {
    if (!Array.isArray(value)) return [];
    return value.filter(function (t) {
      return t !== null && typeof t === 'object';
    });
  };
  return {
    audioTracks: objectsOnly(a.audioTracks),
    subtitleTracks: objectsOnly(a.subtitleTracks),
  };
}

/**
 * The asset's video tracks, as the API is able to report them.
 *
 * Returns at most one entry — `technicalMetadata` carries a single flattened set
 * of video attributes (see CONTRACT GROUNDING). Returns `[]` when
 * `technicalMetadata` is null/absent (nullish in the schema: not yet extracted,
 * or the last extraction failed).
 *
 * Only the four track-level fields are lifted. `durationSeconds` and
 * `containerFormat` are container-level and are not returned here.
 *
 * @param {object} asset  a `GET /api/v1/assets/{id}` 200 body
 * @returns {{codec: unknown, width: unknown, height: unknown, bitrateBps: unknown}[]}
 */
export function videoTracksFromAsset(asset) {
  const tm = asset && typeof asset === 'object' ? asset.technicalMetadata : null;
  if (!tm || typeof tm !== 'object') return [];
  return [{ codec: tm.codec, width: tm.width, height: tm.height, bitrateBps: tm.bitrateBps }];
}

/**
 * The audio streams the probe reported, from `technicalMetadata.audioTracks`.
 * `[]` when technical metadata is absent or carries no audio stream.
 *
 * @param {object} asset  a `GET /api/v1/assets/{id}` 200 body
 * @returns {object[]}
 */
export function probedAudioStreamsFromAsset(asset) {
  const tm = asset && typeof asset === 'object' ? asset.technicalMetadata : null;
  if (!tm || typeof tm !== 'object' || !Array.isArray(tm.audioTracks)) return [];
  return tm.audioTracks.filter(function (t) {
    return t !== null && typeof t === 'object';
  });
}

/**
 * Render an optional attribute as a cell string. Anything the server omitted
 * becomes `—`; anything it sent is shown, including a value of a type this build
 * did not expect (rendered via String(), as text).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function attr(value) {
  if (value === undefined || value === null || value === '') return TRACKS_COPY.absent;
  return String(value);
}

/**
 * `width × height`, or `—` when either dimension is missing. Both are `required`
 * on `technicalMetadata`, so the guard only fires for a non-conforming server.
 *
 * @param {{width?: unknown, height?: unknown}} track
 * @returns {string}
 */
export function resolutionLabel(track) {
  const t = track || {};
  if (typeof t.width !== 'number' || typeof t.height !== 'number') return TRACKS_COPY.absent;
  return t.width + '×' + t.height;
}

/**
 * Bits per second as kbps, matching the detail KV grid's "Bitrate" row
 * (public/app.js) so the same number is not formatted two ways in one view.
 *
 * @param {unknown} bitrateBps
 * @returns {string}
 */
export function bitrateLabel(bitrateBps) {
  if (typeof bitrateBps !== 'number') return TRACKS_COPY.absent;
  return Math.round(bitrateBps / 1000) + ' kbps';
}

/**
 * Sample rate as kHz. `sampleRateHz` is `required` on a probed audio stream.
 *
 * @param {unknown} sampleRateHz
 * @returns {string}
 */
export function sampleRateLabel(sampleRateHz) {
  if (typeof sampleRateHz !== 'number') return TRACKS_COPY.absent;
  return (sampleRateHz / 1000).toFixed(1) + ' kHz';
}

// ─── Subtitle write helpers (issue #904) ─────────────────────────────────────

/**
 * A human-readable name for one subtitle track, for the confirmation step.
 *
 * NEVER the opaque track id: the house confirmation primitive requires the
 * subject to be a name an operator recognises (public/app.js, confirmModal's
 * `spec.subject` rule), and a `randomUUID()` (src/routes/assets.ts:5408) is not
 * one. `label` is the editorial display name when the server has one, `language`
 * is the only other field required on every track, and the fallback is a phrase
 * rather than an id.
 *
 * @param {{label?: unknown, language?: unknown}} track
 * @returns {string}
 */
export function subtitleTrackName(track) {
  const t = track || {};
  const label = typeof t.label === 'string' ? t.label.trim() : '';
  if (label !== '') return label;
  const language = typeof t.language === 'string' ? t.language.trim() : '';
  if (language !== '') return language;
  return TRACKS_COPY.unnamedTrack;
}

/**
 * Validate the add form and build the POST body.
 *
 * Mirrors `addSubtitleTrackSchema` (src/routes/assets.ts:829-834) EXACTLY, and
 * sends only the four keys it declares — the body is
 * `additionalProperties: false`, so a fifth key would be a 400 rather than a
 * silently ignored field.
 *
 * Two deliberate omissions rather than empty values:
 *   - a blank `label` is DROPPED, never sent as `''`: the schema is
 *     `z.string().min(1).max(128).optional()`, so `''` is a refusal, not "no
 *     label".
 *   - an unticked `default` is DROPPED, never sent as `false`: the route assigns
 *     `default: request.body.default` straight onto the stored track (:5426), so
 *     an explicit `false` would persist a flag the operator never set.
 *
 * @param {{language?: unknown, format?: unknown, label?: unknown, default?: unknown}} values
 * @returns {{ok: true, body: object}|{ok: false, message: string, field: string}}
 */
export function subtitleAddBody(values) {
  const v = values || {};
  const language = typeof v.language === 'string' ? v.language.trim() : '';
  if (language === '') {
    return { ok: false, message: TRACKS_COPY.errLanguageRequired, field: 'language' };
  }
  if (language.length > 64) {
    return { ok: false, message: TRACKS_COPY.errLanguageTooLong, field: 'language' };
  }
  const format = typeof v.format === 'string' ? v.format : '';
  if (SUBTITLE_FORMATS.indexOf(format) === -1) {
    return { ok: false, message: TRACKS_COPY.errFormatUnknown, field: 'format' };
  }
  const label = typeof v.label === 'string' ? v.label.trim() : '';
  if (label.length > 128) {
    return { ok: false, message: TRACKS_COPY.errLabelTooLong, field: 'label' };
  }

  const body = { language: language, format: format };
  if (label !== '') body.label = label;
  if (v.default === true) body.default = true;
  return { ok: true, body: body };
}

/**
 * Turn a rejected write into the sentence shown inline.
 *
 * `apiFetch` throws an Error carrying `status` and the parsed body, and already
 * prefers the server's human `message` over its machine `error` code
 * (public/app.js:289-321), so the server's own words are used wherever it sent
 * any. Only the two statuses the contract actually documents get bespoke copy:
 *   403 — `forbidden_insufficient_role` (src/auth/authorize.ts:99), the role
 *         mirror having been bypassed or the server disagreeing with it.
 *   404 — `errorSchema`. On remove this covers BOTH an unknown asset and an
 *         unknown track id (src/routes/assets.ts:5450, :5455); nothing in the
 *         response separates them, so the copy does not pretend to.
 * Everything else (network failure, 5xx, a 400 from a body this build built
 * wrongly) is reported with the message the failure carried, never swallowed.
 *
 * @param {{status?: number, message?: string}} err
 * @param {'add'|'remove'} op
 * @returns {{kind: 'forbidden'|'not-found'|'failed', message: string}}
 */
export function classifySubtitleTrackError(err, op) {
  const e = err || {};
  const status = typeof e.status === 'number' ? e.status : 0;
  if (status === 403) {
    return { kind: 'forbidden', message: TRACKS_COPY.errForbidden };
  }
  if (status === 404) {
    return {
      kind: 'not-found',
      message: op === 'remove' ? TRACKS_COPY.errRemoveNotFound : TRACKS_COPY.errAddNotFound,
    };
  }
  const detail = e.message ? String(e.message) : 'the request failed';
  const prefix =
    op === 'remove' ? TRACKS_COPY.errRemoveFailedPrefix : TRACKS_COPY.errAddFailedPrefix;
  return { kind: 'failed', message: prefix + detail };
}

/**
 * The confirmation spec for removing one track, built from route-verified facts.
 *
 * Both impact lists are required by the house primitive and every entry here was
 * read off the handler, not assumed: the list entry is filtered out
 * (src/routes/assets.ts:5453) and `subtitleTracks` is the only patched key
 * (:5457, src/data/couch-asset-repo.ts:416-417), while the stored object is
 * explicitly left alone (:5434-5435). The burn-in consequence is equally
 * verified: a referenced track id is resolved against the asset's own list and
 * refused when absent (src/pipeline/burn-in.ts:259-265).
 *
 * @param {object} track  one entry of `asset.subtitleTracks`
 * @returns {object} a `confirmModal` spec
 */
export function subtitleRemoveConfirmSpec(track) {
  const t = track || {};
  const name = subtitleTrackName(t);
  const objectKey = typeof t.objectKey === 'string' && t.objectKey !== '' ? t.objectKey : '';
  return {
    title: TRACKS_COPY.confirmTitle,
    subject: name,
    subjectLabel: 'subtitle track',
    question: 'Remove subtitle track “' + name + '” from this asset?',
    detail: objectKey
      ? TRACKS_COPY.confirmFileDetailPrefix + objectKey
      : TRACKS_COPY.confirmNoFileDetail,
    confirmLabel: TRACKS_COPY.confirmRemoveLabel,
    affected: [TRACKS_COPY.confirmAffected, TRACKS_COPY.confirmAffectedBurnIn],
    unaffected: [TRACKS_COPY.confirmUnaffectedFile, TRACKS_COPY.confirmUnaffectedOthers],
  };
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * A read-only table. `caption` is exposed to assistive technology but hidden
 * visually — the sighted reader already has the section heading (WCAG 2.1 AA:
 * the table is named without duplicating the heading on screen).
 *
 * Every cell is set with `textContent`. A cell may be a string, or
 * `{ text, mono }` to render it in the monospace class used for ids elsewhere in
 * the UI, or `{ text, badge: true }` for the "Default" flag, or `{ node }` to
 * place an already-built element (the per-row Remove control, issue #904 — the
 * only way a control ever enters one of these tables, and only when the caller
 * opted in).
 *
 * @param {string} caption
 * @param {string[]} columns
 * @param {(string|{text?: string, mono?: boolean, badge?: boolean, node?: HTMLElement})[][]} rows
 * @returns {HTMLElement}
 */
function renderTable(caption, columns, rows) {
  const wrap = el('div', 'table-wrap');
  const table = document.createElement('table');
  table.appendChild(el('caption', 'visually-hidden', caption));

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach(function (label) {
    const th = el('th', null, label);
    th.setAttribute('scope', 'col');
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach(function (cells) {
    const tr = document.createElement('tr');
    cells.forEach(function (cell) {
      const spec = typeof cell === 'object' && cell !== null ? cell : { text: String(cell) };
      const td = document.createElement('td');
      if (spec.node) {
        td.className = 'tracks-row-actions';
        td.appendChild(spec.node);
      } else if (spec.badge) {
        td.appendChild(el('span', 'badge badge-active', spec.text));
      } else {
        td.className = spec.mono ? 'cell-id' : '';
        td.textContent = spec.text;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  wrap.appendChild(table);
  return wrap;
}

/** The explicit "this kind has none" state required by #902. */
function renderEmpty(kind, text, detail) {
  const box = el('div', 'empty', text);
  box.setAttribute('data-empty', kind);
  if (detail) {
    const d = el('div', 'tracks-note', detail);
    box.appendChild(d);
  }
  return box;
}

/**
 * A section heading, optionally counted.
 *
 * The count is part of the heading so "how many" is answerable without counting
 * rows, and reads correctly under the browser's find-in-page. It is omitted
 * where no single number is defensible — see `appendAudioSection`.
 */
function renderSectionTitle(text, count) {
  return el('div', 'section-title', typeof count === 'number' ? text + ' (' + count + ')' : text);
}

/** A sub-group label inside a section, counted over that group alone. */
function renderGroupTitle(text, count) {
  return el('div', 'tracks-group-title', text + ' (' + count + ')');
}

// ─── Section builders ────────────────────────────────────────────────────────

function appendVideoSection(block, videoTracks, extractionError) {
  block.appendChild(renderSectionTitle(TRACKS_COPY.videoHeading, videoTracks.length));
  if (videoTracks.length === 0) {
    // A failed extraction and a not-yet-extracted asset are both "no video
    // track", but the API distinguishes WHY (`technicalMetadataError`), so the
    // detail line does too.
    const detail =
      typeof extractionError === 'string' && extractionError !== ''
        ? TRACKS_COPY.videoEmptyErrorPrefix + extractionError
        : TRACKS_COPY.videoEmptyDetail;
    block.appendChild(renderEmpty('video-tracks', TRACKS_COPY.videoEmpty, detail));
    return;
  }
  const rows = videoTracks.map(function (t, i) {
    return [
      String(i + 1),
      attr(t.codec),
      resolutionLabel(t),
      bitrateLabel(t.bitrateBps),
    ];
  });
  block.appendChild(renderTable('Video tracks', ['#', 'Codec', 'Resolution', 'Bitrate'], rows));
  block.appendChild(el('div', 'tracks-note', TRACKS_COPY.videoNote));
}

function appendAudioSection(block, editorial, probed) {
  // The `Audio` heading is deliberately UNCOUNTED. Editorial tracks and probed
  // source streams are different objects with no shared id (see CONTRACT
  // GROUNDING), so `editorial.length + probed.length` would be exactly the merge
  // this module refuses to make elsewhere — a two-track asset probed with two
  // streams is not a four-track asset. Each group carries its own count instead.
  block.appendChild(renderSectionTitle(TRACKS_COPY.audioHeading));

  if (editorial.length === 0 && probed.length === 0) {
    block.appendChild(
      renderEmpty('audio-tracks', TRACKS_COPY.audioEmpty, TRACKS_COPY.audioEmptyDetail)
    );
    return;
  }

  block.appendChild(renderGroupTitle(TRACKS_COPY.audioEditorialGroup, editorial.length));
  if (editorial.length > 0) {
    const rows = editorial.map(function (t) {
      return [
        attr(t.language),
        attr(t.label),
        attr(t.codec),
        attr(t.channels),
        t.default === true ? { text: TRACKS_COPY.defaultFlag, badge: true } : TRACKS_COPY.absent,
        { text: attr(t.id), mono: true },
      ];
    });
    block.appendChild(
      renderTable(
        'Editorial audio tracks',
        ['Language', 'Label', 'Codec', 'Channels', 'Default', 'Track ID'],
        rows
      )
    );
  } else {
    block.appendChild(el('div', 'tracks-none', TRACKS_COPY.audioEditorialNone));
  }

  block.appendChild(renderGroupTitle(TRACKS_COPY.audioProbedGroup, probed.length));
  if (probed.length > 0) {
    const rows = probed.map(function (t) {
      return [attr(t.index), attr(t.codec), attr(t.channels), sampleRateLabel(t.sampleRateHz)];
    });
    block.appendChild(
      renderTable('Probed audio streams', ['Stream', 'Codec', 'Channels', 'Sample rate'], rows)
    );
  } else {
    block.appendChild(el('div', 'tracks-none', TRACKS_COPY.audioProbedNone));
  }

  block.appendChild(el('div', 'tracks-note', TRACKS_COPY.audioNote));
}

/**
 * The inline message region for the subtitle section (issue #904).
 *
 * ONE region for every outcome of both writes, so a failure can never be read as
 * a success that happened elsewhere on the page. `role="alert"` so a refusal is
 * announced rather than only drawn; hidden while it has nothing to say, so the
 * read-only panel has no empty box in it.
 */
function renderSubtitleNotice(notice) {
  const box = el('div', 'msg subtitle-notice');
  box.setAttribute('data-subtitle-notice', '');
  box.setAttribute('role', 'alert');
  if (notice && notice.text) {
    const kind = notice.kind === 'success' || notice.kind === 'info' ? notice.kind : 'error';
    box.className = 'msg msg-' + kind + ' subtitle-notice';
    box.textContent = String(notice.text);
  } else {
    box.style.display = 'none';
  }
  return box;
}

function setSubtitleNotice(noticeEl, text, kind) {
  if (!noticeEl) return;
  const k = kind === 'success' || kind === 'info' ? kind : 'error';
  noticeEl.className = 'msg msg-' + k + ' subtitle-notice';
  noticeEl.textContent = String(text);
  noticeEl.style.display = '';
}

/**
 * The "Add a subtitle track" form: the four body fields and nothing else.
 *
 * Exactly the properties `addSubtitleTrackSchema` declares — language (required,
 * maxlength mirroring `max(64)`), format (a select over the contract enum, so an
 * unsendable format has no control to come from), label (optional, `max(128)`)
 * and default (a checkbox). No id and no object-key field: both are
 * server-owned (see SUBTITLE CONTROLS grounding).
 *
 * @returns {{row: HTMLElement, language: HTMLInputElement, format: HTMLSelectElement,
 *            label: HTMLInputElement, dflt: HTMLInputElement, submit: HTMLButtonElement}}
 */
function buildSubtitleAddForm() {
  const wrap = el('div', 'subtitle-add');
  wrap.appendChild(el('div', 'tracks-group-title-plain', TRACKS_COPY.addHeading));

  const row = el('div', 'form-row subtitle-add-row');

  const langField = el('div', 'form-field');
  const langLabel = el('label', null, TRACKS_COPY.fieldLanguage);
  langLabel.setAttribute('for', 'subtitle-add-language');
  const language = document.createElement('input');
  language.type = 'text';
  language.id = 'subtitle-add-language';
  language.maxLength = 64;
  language.required = true;
  language.placeholder = 'sv';
  const langHelp = el('div', 'text-muted tracks-field-help', TRACKS_COPY.helpLanguage);
  langHelp.id = 'subtitle-add-language-help';
  language.setAttribute('aria-describedby', langHelp.id);
  langField.appendChild(langLabel);
  langField.appendChild(language);
  langField.appendChild(langHelp);

  const formatField = el('div', 'form-field');
  const formatLabel = el('label', null, TRACKS_COPY.fieldFormat);
  formatLabel.setAttribute('for', 'subtitle-add-format');
  const format = document.createElement('select');
  format.id = 'subtitle-add-format';
  SUBTITLE_FORMATS.forEach(function (value) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    format.appendChild(opt);
  });
  formatField.appendChild(formatLabel);
  formatField.appendChild(format);

  const labelField = el('div', 'form-field');
  const labelLabel = el('label', null, TRACKS_COPY.fieldLabel);
  labelLabel.setAttribute('for', 'subtitle-add-label');
  const label = document.createElement('input');
  label.type = 'text';
  label.id = 'subtitle-add-label';
  label.maxLength = 128;
  const labelHelp = el('div', 'text-muted tracks-field-help', TRACKS_COPY.helpLabel);
  labelHelp.id = 'subtitle-add-label-help';
  label.setAttribute('aria-describedby', labelHelp.id);
  labelField.appendChild(labelLabel);
  labelField.appendChild(label);
  labelField.appendChild(labelHelp);

  const dfltField = el('div', 'form-field subtitle-add-default');
  const dfltLabel = el('label', 'subtitle-default-label');
  dfltLabel.setAttribute('for', 'subtitle-add-default');
  const dflt = document.createElement('input');
  dflt.type = 'checkbox';
  dflt.id = 'subtitle-add-default';
  dfltLabel.appendChild(dflt);
  dfltLabel.appendChild(document.createTextNode(' ' + TRACKS_COPY.fieldDefault));
  const dfltHelp = el('div', 'text-muted tracks-field-help', TRACKS_COPY.helpDefault);
  dfltHelp.id = 'subtitle-add-default-help';
  dflt.setAttribute('aria-describedby', dfltHelp.id);
  dfltField.appendChild(dfltLabel);
  dfltField.appendChild(dfltHelp);

  const submit = el('button', 'btn-sm', TRACKS_COPY.btnAdd);
  submit.type = 'button';
  submit.id = 'btn-subtitle-add';

  row.appendChild(langField);
  row.appendChild(formatField);
  row.appendChild(labelField);
  row.appendChild(dfltField);
  row.appendChild(submit);
  wrap.appendChild(row);
  wrap.appendChild(el('div', 'tracks-note', TRACKS_COPY.addNote));

  return { row: wrap, language: language, format: format, label: label, dflt: dflt, submit: submit };
}

function appendSubtitleSection(block, subtitles, controls) {
  // Controls are opt-in AND role-gated. `canChange === false` renders the note
  // instead of a disabled form: a control the role can never use is noise, and
  // the note says what role is needed rather than leaving a dead button.
  const editable = !!(
    controls &&
    controls.canChange &&
    typeof controls.onAdd === 'function'
  );
  // Remove is rendered ONLY when a confirmation gate came with it. No
  // confirm function, no Remove control — so there is no code path on which a
  // track can be deleted without the operator confirming first (#904).
  const removable = !!(
    controls &&
    controls.canChange &&
    typeof controls.onRemove === 'function' &&
    typeof controls.confirmRemove === 'function'
  );

  block.appendChild(renderSectionTitle(TRACKS_COPY.subtitleHeading, subtitles.length));

  const notice = controls ? renderSubtitleNotice(controls.notice) : null;

  // Buttons that must all be locked out together while one write is in flight —
  // a second DELETE for a row that is already being removed can only earn a 404,
  // and an add racing a remove would refresh the list twice.
  const busyControls = [];
  function setBusy(busy) {
    busyControls.forEach(function (btn) {
      btn.disabled = busy;
    });
  }

  if (subtitles.length === 0) {
    block.appendChild(
      renderEmpty('subtitle-tracks', TRACKS_COPY.subtitleEmpty, TRACKS_COPY.subtitleEmptyDetail)
    );
  } else {
    const rows = subtitles.map(function (t) {
      const cells = [
        attr(t.language),
        attr(t.label),
        // `format` is an enum in the contract, but an unrecognised value is still
        // rendered verbatim: the API owns the vocabulary.
        attr(t.format),
        t.default === true ? { text: TRACKS_COPY.defaultFlag, badge: true } : TRACKS_COPY.absent,
        // Optional: absent until the subtitle file's location is recorded.
        { text: attr(t.objectKey), mono: true },
        { text: attr(t.id), mono: true },
      ];
      if (removable) {
        // House destructive styling (`button.btn-danger`, public/style.css:688),
        // not a bespoke class — removing a track reads like every other
        // destructive control in this UI.
        const btn = el('button', 'btn-sm btn-danger', TRACKS_COPY.btnRemove);
        btn.type = 'button';
        // The id is not shown as the button's name — it is carried as data so the
        // DELETE path can be built from the exact value the server sent.
        btn.setAttribute('data-remove-track', String(t.id == null ? '' : t.id));
        btn.setAttribute(
          'aria-label',
          TRACKS_COPY.btnRemove + ' subtitle track ' + subtitleTrackName(t)
        );
        busyControls.push(btn);
        btn.addEventListener('click', async function () {
          if (btn.disabled) return;
          // Explicit confirmation FIRST: nothing is sent until the operator has
          // confirmed, and a dismissal leaves the list exactly as it was.
          const ok = await controls.confirmRemove(t);
          if (!ok) return;
          const prev = btn.textContent;
          setBusy(true);
          btn.textContent = TRACKS_COPY.btnRemovePending;
          try {
            await controls.onRemove(t);
            // Success re-renders this whole block from a fresh read, so this
            // button is gone by now — nothing to restore.
            return;
          } catch (err) {
            // The row stays, the change is NOT reported as applied, and the
            // reason lands inline (never an alert(), never console-only).
            setSubtitleNotice(notice, classifySubtitleTrackError(err, 'remove').message, 'error');
          } finally {
            if (btn.parentNode) {
              btn.textContent = prev;
              setBusy(false);
            }
          }
        });
        cells.push({ node: btn });
      }
      return cells;
    });
    const columns = ['Language', 'Label', 'Format', 'Default', 'Object key', 'Track ID'];
    if (removable) columns.push(TRACKS_COPY.actionsColumn);
    block.appendChild(renderTable('Subtitle tracks', columns, rows));
  }

  if (!controls) return;

  if (editable) {
    const form = buildSubtitleAddForm();
    busyControls.push(form.submit);
    form.submit.addEventListener('click', async function () {
      if (form.submit.disabled) return;
      // Client-side mirror of the body schema. A refusal here never reaches the
      // network and never clears what was typed.
      const built = subtitleAddBody({
        language: form.language.value,
        format: form.format.value,
        label: form.label.value,
        default: form.dflt.checked,
      });
      if (!built.ok) {
        setSubtitleNotice(notice, built.message, 'error');
        if (built.field === 'language') form.language.focus();
        if (built.field === 'label') form.label.focus();
        if (built.field === 'format') form.format.focus();
        return;
      }
      const prev = form.submit.textContent;
      setBusy(true);
      form.submit.textContent = TRACKS_COPY.btnAddPending;
      try {
        await controls.onAdd(built.body);
        // Re-rendered from the fresh list on success; this form is gone.
        return;
      } catch (err) {
        // Keep the typed values: the operator has lost nothing and can retry.
        setSubtitleNotice(notice, classifySubtitleTrackError(err, 'add').message, 'error');
      } finally {
        if (form.submit.parentNode) {
          form.submit.textContent = prev;
          setBusy(false);
        }
      }
    });
    block.appendChild(form.row);
  } else if (!controls.canChange) {
    block.appendChild(el('div', 'tracks-note', TRACKS_COPY.viewerNote));
  }

  // Last in the section, under whatever it is reporting on.
  block.appendChild(notice);
}

// ─── Block ───────────────────────────────────────────────────────────────────

/**
 * Build the whole block for one asset read. PURE: no fetch, no listeners.
 *
 * @param {object} data
 * @param {object[]} data.video            from `videoTracksFromAsset`
 * @param {object[]} data.audioEditorial   `asset.audioTracks`
 * @param {object[]} data.audioProbed      from `probedAudioStreamsFromAsset`
 * @param {object[]} data.subtitles        `asset.subtitleTracks`
 * @param {string}   [data.extractionError] `asset.technicalMetadataError`
 * @returns {HTMLElement}
 */
export function renderTracksBlock(data) {
  const d = data || {};
  const video = Array.isArray(d.video) ? d.video : [];
  const audioEditorial = Array.isArray(d.audioEditorial) ? d.audioEditorial : [];
  const audioProbed = Array.isArray(d.audioProbed) ? d.audioProbed : [];
  const subtitles = Array.isArray(d.subtitles) ? d.subtitles : [];
  // Opt-in only (issue #904). Absent — the default — and this render is exactly
  // the read-only panel #902 shipped: no control, no listener, no request.
  const subtitleControls =
    d.subtitleControls && typeof d.subtitleControls === 'object' ? d.subtitleControls : null;
  const editable = !!(subtitleControls && subtitleControls.canChange);

  const block = el('div', 'mt12 tracks-block');
  block.id = 'asset-tracks';
  block.appendChild(el('div', 'section-title', TRACKS_COPY.heading));
  // The intro must not promise read-only when one section is not. Still says in
  // words which kinds are editable, because only subtitles are.
  block.appendChild(
    el('div', 'tracks-note', editable ? TRACKS_COPY.introEditable : TRACKS_COPY.intro)
  );

  appendVideoSection(block, video, d.extractionError);
  appendAudioSection(block, audioEditorial, audioProbed);
  appendSubtitleSection(block, subtitles, subtitleControls);

  return block;
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Render the "Tracks" block into the asset detail view.
 *
 * Synchronous and network-free: all four record sets — the video attributes, the
 * editorial audio and subtitle tracks, and the probed source streams — are
 * properties of the `GET /assets/{id}` body the caller already holds, so the
 * panel neither re-reads the asset nor calls `GET /assets/{id}/tracks` for
 * bytes it was handed (see CONTRACT GROUNDING). It therefore adds no round-trip
 * to the detail render, and there is no "tracks unavailable" state: an absent
 * array is a known-empty kind, not a failed read.
 *
 * The block is inserted before `anchorEl` when given, else appended to `host`.
 *
 * ── Subtitle add/remove (issue #904) ──
 * Opt-in and additive: pass `assetId` + `apiFetch` and the subtitle section gains
 * an add form and a per-row Remove control. Omit either and the mount behaves
 * exactly as #902 shipped it — synchronous, network-free, read-only. `confirmModal`
 * is required for the Remove control specifically: without it no Remove button is
 * rendered at all, so an unconfirmed DELETE has nothing to originate from.
 *
 * A successful write re-reads `GET /assets/{id}/tracks` and re-renders the block
 * in place — the same in-place replacement `update()` already did, so the
 * subtitle section refreshes with no page reload and no navigation. Neither write
 * returns the resulting list (201 carries the one new track, 204 carries
 * nothing), so the list is never patched locally from a response: what is shown
 * after a write is what the server answered when asked for the list.
 *
 * @param {object} opts
 * @param {object}      opts.asset      the `GET /assets/{id}` 200 body already
 *                                      rendered by the caller
 * @param {HTMLElement} [opts.host]     container to append to
 * @param {HTMLElement} [opts.anchorEl] element to insert before, inside its parent
 * @param {string}      [opts.assetId]  the ULID for the subtitle sub-resource
 *                                      paths (never a slug — neither handler
 *                                      resolves one). Defaults to `asset.id`.
 * @param {boolean}     [opts.canChange] client-role mirror of the ADR-018 matrix
 *                                      (editor|admin); defaults to false, so the
 *                                      controls are off unless asked for.
 * @param {Function}    [opts.apiFetch] house API helper; required for controls
 * @param {Function}    [opts.confirmModal] house confirmation primitive;
 *                                      required for the Remove control
 * @param {(event: {op: 'add'|'remove', track: object|null}) => any} [opts.onChanged]
 *        called after a write has been applied AND the list re-read, so a caller
 *        can keep other views in step. Its failures are its own.
 * @returns {{ block: HTMLElement, update: (asset: object) => void,
 *            refreshSubtitles: () => Promise<void> }}
 */
export function mountAssetTracks(opts) {
  const o = opts || {};

  let rendered = null;
  // The most recent asset body this panel was given. Held so a subtitle refresh
  // can re-render the OTHER sections unchanged: `technicalMetadata` (video +
  // probed audio) is not touched by either subtitle write, so re-reading the
  // whole asset for it would be a round-trip for bytes we already have.
  let held = o.asset || {};
  // One pending inline message, rendered by the next render pass. Held here
  // rather than written into the DOM after the fact because a successful write
  // REPLACES the block — a message written before the swap would be discarded
  // with the old node.
  let notice = null;

  const assetId =
    o.assetId != null && String(o.assetId) !== ''
      ? String(o.assetId)
      : held && held.id != null
        ? String(held.id)
        : '';
  const canWrite = !!(o.canChange && typeof o.apiFetch === 'function' && assetId !== '');
  // Controls at all? Only when the caller asked. A viewer-role caller that still
  // passes apiFetch gets the section plus the "your role cannot" note, which is
  // why `wantsControls` is wider than `canWrite`.
  const wantsControls = !!(typeof o.apiFetch === 'function' && assetId !== '');

  const subtitlesPath = '/assets/' + encodeURIComponent(assetId) + '/subtitle-tracks';
  const tracksPath = '/assets/' + encodeURIComponent(assetId) + '/tracks';

  function place(block) {
    if (!rendered) {
      if (o.anchorEl && o.anchorEl.parentNode) {
        o.anchorEl.parentNode.insertBefore(block, o.anchorEl);
      } else if (o.host) {
        o.host.appendChild(block);
      }
      return;
    }
    if (rendered.parentNode) {
      rendered.parentNode.replaceChild(block, rendered);
    }
  }

  /**
   * Re-read the editorial track lists and re-render in place.
   *
   * `GET /assets/{id}/tracks` → `{ audioTracks, subtitleTracks }`, both
   * `required` (tracksSchema, src/routes/assets.ts:836-839). Both are adopted,
   * not just the subtitle one: the response is authoritative for the pair and
   * dropping the audio half would leave two lists on screen read at different
   * times.
   */
  async function refreshSubtitles() {
    const tracks = await o.apiFetch(tracksPath);
    const next = Object.assign({}, held);
    if (tracks && Array.isArray(tracks.subtitleTracks)) {
      next.subtitleTracks = tracks.subtitleTracks;
    }
    if (tracks && Array.isArray(tracks.audioTracks)) {
      next.audioTracks = tracks.audioTracks;
    }
    render(next);
  }

  /**
   * Apply one write, then refresh from the server.
   *
   * The refresh is awaited INSIDE the try so a failed re-read cannot be reported
   * as a failed write: the write succeeded, and the message says the list below
   * may be stale rather than implying nothing was saved.
   */
  async function applyThenRefresh(run, op, track, successText) {
    await run();
    try {
      notice = { text: successText, kind: 'success' };
      await refreshSubtitles();
    } catch (_) {
      notice = { text: TRACKS_COPY.refreshFailed, kind: 'info' };
      render(held);
    }
    if (typeof o.onChanged === 'function') {
      try {
        o.onChanged({ op: op, track: track || null });
      } catch (_) {
        /* a caller's own refresh failing must not undo a completed write */
      }
    }
  }

  function subtitleControls() {
    if (!wantsControls) return null;
    const controls = {
      canChange: canWrite,
      notice: notice,
    };
    if (!canWrite) return controls;

    controls.onAdd = function (body) {
      // POST /assets/{id}/subtitle-tracks — body built by subtitleAddBody(),
      // which sends exactly the four declared keys (additionalProperties:false).
      return applyThenRefresh(
        function () {
          return o.apiFetch(subtitlesPath, {
            method: 'POST',
            body: JSON.stringify(body),
          });
        },
        'add',
        null,
        TRACKS_COPY.addedOne
      );
    };

    if (typeof o.confirmModal === 'function') {
      // The explicit confirmation step, through the house primitive so this
      // destructive action looks and resolves like every other one in the UI.
      controls.confirmRemove = function (track) {
        return o.confirmModal(subtitleRemoveConfirmSpec(track));
      };
      controls.onRemove = function (track) {
        const trackId = track && track.id != null ? String(track.id) : '';
        return applyThenRefresh(
          function () {
            // DELETE /assets/{id}/subtitle-tracks/{trackId} — two path params,
            // no body, no query parameter (see SUBTITLE CONTROLS grounding).
            return o.apiFetch(subtitlesPath + '/' + encodeURIComponent(trackId), {
              method: 'DELETE',
            });
          },
          'remove',
          track,
          TRACKS_COPY.removedOne
        );
      };
    }
    return controls;
  }

  /** Build + place the block for one asset body. */
  function render(asset) {
    const a = asset || {};
    held = a;
    const editorial = editorialTracksFromAsset(a);
    const next = renderTracksBlock({
      video: videoTracksFromAsset(a),
      audioEditorial: editorial.audioTracks,
      audioProbed: probedAudioStreamsFromAsset(a),
      subtitles: editorial.subtitleTracks,
      extractionError: a.technicalMetadataError,
      subtitleControls: subtitleControls(),
    });
    place(next);
    rendered = next;
    // Consumed: a message belongs to the render that followed its write, not to
    // every later one.
    notice = null;
  }

  /** Re-render from a freshly read asset body, in place. */
  function update(asset) {
    render(asset);
  }

  update(o.asset);
  return {
    get block() {
      return rendered;
    },
    update: update,
    refreshSubtitles: refreshSubtitles,
  };
}
