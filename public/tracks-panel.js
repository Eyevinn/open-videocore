/**
 * open-videocore ops dashboard — tracks-panel.js
 *
 * The "Tracks" block on the asset detail view (issue #902, broken out of #794):
 * one section per track kind — video, audio, subtitle — each listing only the
 * attributes the API actually exposes for that kind, and each with an explicit
 * empty state when the asset has none.
 *
 * READ-ONLY BY DEFAULT, with TWO independent opt-ins. Mounted with neither it
 * is byte-for-byte the panel #902 shipped: no form control, no listener, no
 * request of any kind.
 *
 * Mounted WITH `audioEdit` (issue #903, broken out of #794) the editorial audio
 * group additionally renders add/remove controls — but this module still writes
 * nothing itself for audio: it asks public/audio-track-edit.js for two nodes (a
 * per-row control and the add block) and that module owns the calls, the
 * confirmation step, the inline error and the refresh. Layout stays here;
 * everything that writes audio stays there.
 *
 * Mounted WITH `subtitleControls` (issue #904, see "SUBTITLE CONTROLS" below)
 * the subtitle section gains its own add form and per-row Remove control, owned
 * by this module. The two opt-ins are scoped to their own section and neither
 * implies the other: video stays a reporting surface in every case.
 *
 * It issues no GET during render in any configuration: every value the first
 * render shows is already in the `GET /assets/{id}` body the detail view
 * fetched, so the panel adds no round-trip to the render. Both editors issue
 * requests only once an operator activates one of their controls.
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
 *       (src/routes/assets.ts:1037) and
 *       `subtitleTracks: z.array(subtitleTrackOutSchema).optional()` (:1038),
 *       `audioTrackOutSchema` :885-892, `subtitleTrackOutSchema` :896-903; the
 *       subtitle vocabulary is `SUBTITLE_FORMATS = ['vtt','srt','ttml']`,
 *       src/data/asset-repo.ts:466, reached via `subtitleFormatSchema`
 *       (src/routes/assets.ts:894).
 *     ABSENT MEANS "NONE", NOT "UNKNOWN". The field is optional because the
 *       arrays are "absent until the first track of the respective kind is
 *       added" (src/routes/assets.ts:1035-1036); persistence only writes the
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
 *   AUDIO, ADD + REMOVE (issue #903) — `POST /api/v1/assets/{id}/audio-tracks`
 *     (201 → the full updated `{ audioTracks }`) and
 *     `DELETE /api/v1/assets/{id}/audio-tracks/{trackId}` (204, empty body).
 *     Both operate on the EDITORIAL list only. The full request/response
 *     contract for them — bodies, bounds, both 404 shapes, and the post-remove
 *     re-read — is cited in public/audio-track-edit.js, which owns those calls.
 *     Nothing in this file issues them.
 *
 * WHAT THE API DOES NOT EXPOSE (checked, not assumed):
 *   - There is no GET on `/api/v1/assets/{id}/audio-tracks` or
 *     `…/subtitle-tracks`. In `openapi.json` those paths carry only `post`, and
 *     `…/{trackId}` only `delete` (src/routes/assets.ts:6429, 6464, 6494, 6542).
 *   - There is no UPDATE of any kind on a track: no PUT and no PATCH on either
 *     track path. A track's language, codec, channels, label or default flag
 *     cannot be edited in place, so this panel offers add and remove only —
 *     changing a track means removing it and adding a new one, which mints a
 *     new id.
 *   - There is no add/remove route for VIDEO tracks at all (no path in
 *     `openapi.json` contains "video"), so the video section stays read-only.
 *   - `GET /api/v1/assets/{id}/tracks` DOES exist and is the only *dedicated*
 *     read of the two editorial kinds — but it is not a second source of truth
 *     for them: its handler sends `asset.audioTracks ?? []` /
 *     `asset.subtitleTracks ?? []` from the very same document
 *     (src/routes/assets.ts:6420-6421, via `repo.get(request.params.id)` at
 *     :6414). A caller that already holds the asset — which the detail view
 *     always does — would be paying a round-trip for bytes it has, so this panel
 *     does not call it on the render path. It IS called after a write; see the
 *     refresh grounding below.
 *   - No endpoint writes video tracks, and the only response that carries a
 *     video-track ARRAY is that same `GET …/tracks` (`videoTracks`, issue #978,
 *     read-only). `GET /api/v1/assets/{id}` — the body this panel renders from —
 *     does NOT carry one: it exposes `technicalMetadata`, one flattened set of
 *     video attributes. So this panel can list at most one video track for an
 *     asset, however many the source file holds. That ceiling is the asset
 *     body's, not this module's, and the section says so on screen rather than
 *     implying the file has exactly one video stream.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SUBTITLE CONTROLS — CONTRACT GROUNDING (issue #904, CLAUDE.md rule 7)
 *
 * Fetched from this repo's generated spec and route source on this branch before
 * either call below was written. Nothing is taken from the issue text.
 *
 *   ADD — `POST /api/v1/assets/{id}/subtitle-tracks`
 *     openapi.json .paths["/api/v1/assets/{id}/subtitle-tracks"] carries `post`
 *     and nothing else; handler src/routes/assets.ts:6494-6536.
 *     Path param: `id` only (`z.object({ id: z.string() })`, :6499). It is the
 *       ULID — the handler passes the raw param to `repo.get` (:6508) with NO
 *       slug fallback, so a slug would 404.
 *     Body REQUIRED, `addSubtitleTrackSchema` (src/routes/assets.ts:915-920),
 *       `additionalProperties: false`:
 *         language  string, min 1, max 64   — REQUIRED
 *         format    "vtt" | "srt" | "ttml"  — REQUIRED
 *                   (`subtitleFormatSchema` :894 over
 *                    `SUBTITLE_FORMATS` src/data/asset-repo.ts:466)
 *         label     string, min 1, max 128  — optional
 *         default   boolean                 — optional
 *       Four fields, and no fifth: `objectKey` and `id` are NOT accepted —
 *       the id is server-generated (`randomUUID()`, :6512) and the object key is
 *       derived by the route (:6515). So this panel sends no id and no key.
 *     201 → `{ track, uploadUrl? }` (:6502). `track` is `subtitleTrackOutSchema`
 *       (:896-903) — the ONE new track, NOT the full list, which is why a
 *       successful add is followed by a re-read (below) rather than an
 *       append-in-place. `uploadUrl` is a presigned PUT, present only when
 *       object storage is configured (:6517-6519); it is NEVER rendered — it is
 *       a credential-bearing URL — and uploading subtitle BYTES is not part of
 *       this panel (#904 is add/remove of the track record).
 *     404 → `{ error, message? }` (`errorSchema`) for an unknown/foreign asset.
 *     APPEND-ONLY, verified: the handler spreads the existing array and pushes
 *       (`[...(asset.subtitleTracks ?? []), track]`, :6532). It does NOT clear
 *       `default` on the other tracks, so an asset CAN end up with two tracks
 *       flagged default. The form says so instead of implying otherwise.
 *
 *   REMOVE — `DELETE /api/v1/assets/{id}/subtitle-tracks/{trackId}`
 *     openapi.json .paths["/api/v1/assets/{id}/subtitle-tracks/{trackId}"]
 *       carries `delete` and nothing else; handler
 *       src/routes/assets.ts:6542-6564.
 *     Path params `{ id, trackId }` (:6547). No body, no query parameter: the
 *       operation declares `parameters` for the two path params and nothing else.
 *     204 → empty (`z.null()`, :6548), so a successful remove returns NO list
 *       and the fresh list must be re-read.
 *     404 → `{ error, message }` for an unknown asset AND for a track id that is
 *       not on it (`message: 'subtitle track not found'`, :6559). The two are not
 *       machine-distinguishable, so the inline error does not claim to tell them
 *       apart.
 *     The STORED FILE SURVIVES: "Leaves the subtitle object (if any) in storage"
 *       (:6538-6539) — the handler only filters the list (:6557) and patches
 *       `subtitleTracks` (:6561, applied as the single key by
 *       src/data/couch-asset-repo.ts:433-434). The confirmation step says this in
 *       words rather than letting the operator assume a file was deleted.
 *
 *   REFRESH AFTER A WRITE — `GET /api/v1/assets/{id}/tracks`
 *     openapi.json .paths["/api/v1/assets/{id}/tracks"].get → 200
 *     `{ videoTracks, audioTracks, subtitleTracks }` — THREE arrays, ALL THREE
 *     `required` (`tracksSchema`, src/routes/assets.ts:958-965; `videoTracks`
 *     added by issue #978). Handler :6404-6424 sends `videoTracksOf(asset)` /
 *     `asset.audioTracks ?? []` / `asset.subtitleTracks ?? []` (:6418-6422),
 *     read through `repo.get(request.params.id)` at :6414.
 *     This is the read the panel refuses at RENDER time (it already holds those
 *     bytes) and needs after a WRITE, when it no longer does: neither write
 *     returns the resulting list. It is the smallest authoritative read of the
 *     two editorial arrays — the alternative is the whole asset body — and it
 *     cannot drift from the asset, since the handler projects the same document.
 *     Only the subtitle and editorial-audio sections are re-rendered from it.
 *     `videoTracks` IS present on this response and is deliberately NOT adopted:
 *     the video section is projected from `technicalMetadata` by
 *     `videoTracksFromAsset`, because `GET /api/v1/assets/{id}` does NOT expose
 *     a `videoTracks` array (verified: its 200 schema has `technicalMetadata` /
 *     `technicalMetadataError` and no `videoTracks`), so the derived path is the
 *     only source available on the initial render. Adopting the array here would
 *     switch the video section to a second, differently-shaped source part-way
 *     through a session — `videoTrackOutSchema` (:930) can report MANY streams
 *     while the derived projection is capped at one — for data that neither
 *     subtitle write can change. Video stays read-only and single-sourced; see
 *     `refreshSubtitles`.
 *
 *   AUTHORISATION — `editor` and `admin` only, mirrored client-side.
 *     Both routes sit under the assets router's two preHandlers: `authGate(app)`
 *     (src/routes/assets.ts:1902) and `resourceAuthorizationPreHandler('asset')`
 *     (:1912). `methodToAction` maps POST → `write` and DELETE → `delete`
 *     (src/auth/authorize.ts:79-93) and `MATRIX` (:54-58) grants both to `editor`
 *     and `admin` and neither to `viewer`. Refusal is 403
 *     `forbidden_insufficient_role` (`AUTHZ_FORBIDDEN_ERROR`, :99). The
 *     `canChange` flag is a MIRROR of that rule, not a substitute: a 403 that
 *     arrives anyway is still reported inline.
 */

import { createAudioTrackEditor } from './audio-track-edit.js';

// ─── Copy deck ───────────────────────────────────────────────────────────────

export const TRACKS_COPY = Object.freeze({
  heading: 'Tracks',
  /**
   * Says outright that this block only reports. Used when the panel is mounted
   * WITHOUT an audio editor — the editor supplies its own intro (#903), because
   * a panel that can add and remove audio tracks must not claim to be read-only.
   */
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

  /**
   * Replaces `intro` when BOTH opt-ins are mounted — the #903 audio editor and
   * the #904 subtitle controls. Neither single-feature line is true then: one
   * would call audio read-only, the other would call subtitles read-only.
   */
  introEditableBoth:
    'Track structure as the API reports it. Editorial audio tracks and ' +
    'subtitle tracks can be added and removed here; video is reported only.',

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
 * z.enum(SUBTITLE_FORMATS)` (src/routes/assets.ts:894) over
 * `SUBTITLE_FORMATS = ['vtt','srt','ttml']` (src/data/asset-repo.ts:466), which
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
 * `spec.subject` rule), and a `randomUUID()` (src/routes/assets.ts:6512) is not
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
 * Mirrors `addSubtitleTrackSchema` (src/routes/assets.ts:915-920) EXACTLY, and
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
 *         unknown track id (src/routes/assets.ts:6554, :6559); nothing in the
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
 * (src/routes/assets.ts:6557) and `subtitleTracks` is the only patched key
 * (:6561, src/data/couch-asset-repo.ts:433-434), while the stored object is
 * explicitly left alone (:6538-6539). The burn-in consequence is equally
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
 * place an already-built element: the per-row Remove control — the only way a
 * control ever enters one of these tables, and only when the caller opted in.
 * For audio (#903) that node is built by public/audio-track-edit.js, never by
 * this module; for subtitles (#904) it is built below.
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
        // Both names are kept: the shared action-cell class the tables already
        // use, plus the tracks-specific one the panel's own stylesheet targets.
        td.className = 'cell-actions tracks-row-actions';
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

/**
 * @param {HTMLElement} block
 * @param {object[]} editorial  the asset's editorial `audioTracks`
 * @param {object[]} probed     `technicalMetadata.audioTracks`
 * @param {object}   [editor]   the #903 audio editor, when editing is enabled
 * @param {string}   [deniedNote]  why the controls are absent, when they are
 *                                 absent for a reason worth stating
 */
function appendAudioSection(block, editorial, probed, editor, deniedNote) {
  // The `Audio` heading is deliberately UNCOUNTED. Editorial tracks and probed
  // source streams are different objects with no shared id (see CONTRACT
  // GROUNDING), so `editorial.length + probed.length` would be exactly the merge
  // this module refuses to make elsewhere — a two-track asset probed with two
  // streams is not a four-track asset. Each group carries its own count instead.
  block.appendChild(renderSectionTitle(TRACKS_COPY.audioHeading));

  // Hand the list over before asking for any row control: the editor resets its
  // per-render control registry here, and keeps the list as the fallback for a
  // failed post-remove re-read.
  if (editor) editor.setTracks(editorial);

  // Add and remove act on the EDITORIAL list only, so the controls belong to
  // that group — never to the probed streams, which no endpoint can change.
  const addBlock = editor ? editor.addBlock() : null;

  if (editorial.length === 0 && probed.length === 0) {
    block.appendChild(
      renderEmpty('audio-tracks', TRACKS_COPY.audioEmpty, TRACKS_COPY.audioEmptyDetail)
    );
    // The empty state is still a place an operator adds the FIRST track from:
    // an asset with no audio at all is exactly when adding one matters, so the
    // control sits below the empty box rather than being withheld with it.
    if (addBlock) block.appendChild(addBlock);
    else if (deniedNote) block.appendChild(el('div', 'tracks-note', deniedNote));
    return;
  }

  block.appendChild(renderGroupTitle(TRACKS_COPY.audioEditorialGroup, editorial.length));
  if (editorial.length > 0) {
    const columns = ['Language', 'Label', 'Codec', 'Channels', 'Default', 'Track ID'];
    if (editor) columns.push(editor.actionsColumn);
    const rows = editorial.map(function (t) {
      const cells = [
        attr(t.language),
        attr(t.label),
        attr(t.codec),
        attr(t.channels),
        t.default === true ? { text: TRACKS_COPY.defaultFlag, badge: true } : TRACKS_COPY.absent,
        { text: attr(t.id), mono: true },
      ];
      // A track the server sent without an `id` cannot be removed: `trackId` is
      // a required path parameter and the handler matches on it. The cell says
      // so rather than offering a button that could only ever 404.
      if (editor) {
        cells.push(
          typeof t.id === 'string' && t.id !== ''
            ? { node: editor.removeControl(t) }
            : TRACKS_COPY.absent
        );
      }
      return cells;
    });
    block.appendChild(renderTable('Editorial audio tracks', columns, rows));
  } else {
    block.appendChild(el('div', 'tracks-none', TRACKS_COPY.audioEditorialNone));
  }

  if (addBlock) block.appendChild(addBlock);
  else if (deniedNote) block.appendChild(el('div', 'tracks-note', deniedNote));

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
 * The one intro line for a given pair of opt-ins, so no configuration claims a
 * section is read-only when it is not.
 *
 * @param {boolean} subtitlesEditable  the #904 controls are mounted AND writable
 * @param {object|null} audioEditor    the #903 editor, when mounted
 * @returns {string}
 */
function introFor(subtitlesEditable, audioEditor) {
  if (subtitlesEditable && audioEditor) return TRACKS_COPY.introEditableBoth;
  if (subtitlesEditable) return TRACKS_COPY.introEditable;
  // The editor owns its own wording for the audio-only case (#903).
  if (audioEditor) return audioEditor.panelIntro;
  return TRACKS_COPY.intro;
}

/**
 * Build the whole block for one asset read. PURE: no fetch, no listeners.
 *
 * @param {object} data
 * @param {object[]} data.video            from `videoTracksFromAsset`
 * @param {object[]} data.audioEditorial   `asset.audioTracks`
 * @param {object[]} data.audioProbed      from `probedAudioStreamsFromAsset`
 * @param {object[]} data.subtitles        `asset.subtitleTracks`
 * @param {string}   [data.extractionError] `asset.technicalMetadataError`
 * @param {object}   [data.audioEditor]   the #903 editor from
 *                                        createAudioTrackEditor. Absent =>
 *                                        the audio section stays read-only.
 * @param {string}   [data.audioEditDenied] note explaining absent controls
 * @param {object}   [data.subtitleControls] the #904 subtitle add/remove
 *                                        controls. Absent => the subtitle
 *                                        section stays read-only.
 * @returns {HTMLElement}
 */
export function renderTracksBlock(data) {
  const d = data || {};
  const video = Array.isArray(d.video) ? d.video : [];
  const audioEditorial = Array.isArray(d.audioEditorial) ? d.audioEditorial : [];
  const audioProbed = Array.isArray(d.audioProbed) ? d.audioProbed : [];
  const subtitles = Array.isArray(d.subtitles) ? d.subtitles : [];
  // Both opt-in only. Absent — the default for each — and this render is exactly
  // the read-only panel #902 shipped: no control, no listener, no request.
  const subtitleControls =
    d.subtitleControls && typeof d.subtitleControls === 'object' ? d.subtitleControls : null;
  const editable = !!(subtitleControls && subtitleControls.canChange);
  const editor = d.audioEditor || null;

  const block = el('div', 'mt12 tracks-block');
  block.id = 'asset-tracks';
  block.appendChild(el('div', 'section-title', TRACKS_COPY.heading));
  // The intro must not promise read-only when a section is not, and it names
  // the kinds that are editable rather than leaving the operator to probe for
  // them. Audio alone keeps the editor's own line (#903); subtitles alone and
  // both-at-once are stated here.
  block.appendChild(el('div', 'tracks-note', introFor(editable, editor)));

  appendVideoSection(block, video, d.extractionError);
  appendAudioSection(block, audioEditorial, audioProbed, editor, d.audioEditDenied);
  appendSubtitleSection(block, subtitles, subtitleControls);

  return block;
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Render the "Tracks" block into the asset detail view.
 *
 * The RENDER is synchronous and network-free: all four record sets — the video
 * attributes, the editorial audio and subtitle tracks, and the probed source
 * streams — are properties of the `GET /assets/{id}` body the caller already
 * holds, so the panel neither re-reads the asset nor calls
 * `GET /assets/{id}/tracks` for bytes it was handed (see CONTRACT GROUNDING).
 * It adds no round-trip to the detail render, and there is no "tracks
 * unavailable" state: an absent array is a known-empty kind, not a failed read.
 * That holds whether or not `audioEdit` is passed — the editor issues requests
 * only when an operator activates one of its controls.
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
 *                                      (editor|admin) for the SUBTITLE controls;
 *                                      defaults to false, so they are off unless
 *                                      asked for.
 * @param {Function}    [opts.apiFetch] house API helper; required for the
 *                                      subtitle controls
 * @param {Function}    [opts.confirmModal] house confirmation primitive;
 *                                      required for the subtitle Remove control
 * @param {(event: {op: 'add'|'remove', track: object|null}) => any} [opts.onChanged]
 *        called after a subtitle write has been applied AND the list re-read, so
 *        a caller can keep other views in step. Its failures are its own.
 * @param {object}      [opts.audioEdit]  enables the #903 audio add/remove
 *        controls, independently of the subtitle ones. Omit both and the panel
 *        is exactly the read-only #902 one.
 *        `{ assetId, apiFetch, confirmModal, onChanged? }` — `assetId` must be
 *        the ULID (the track routes do not resolve slugs); `onChanged` is called
 *        with the post-write `audioTracks` after the section has refreshed, so
 *        the caller can keep its own copy of the asset in step.
 * @param {string}      [opts.audioEditDenied]  shown in the audio section
 *        INSTEAD of the controls, when the caller withheld them for a reason an
 *        operator should see (e.g. a read-only client role).
 * @returns {{ block: HTMLElement, update: (asset: object) => void,
 *            refreshSubtitles: () => Promise<void> }}
 */
export function mountAssetTracks(opts) {
  const o = opts || {};

  let rendered = null;
  // The most recent asset body this panel was given. Held so a track refresh —
  // audio or subtitle — can re-render the OTHER sections unchanged:
  // `technicalMetadata` (video + probed audio) is not touched by any of the four
  // track writes, so re-reading the whole asset for it would be a round-trip for
  // bytes we already have.
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

  // The #903 audio editor, created ONCE so the add form's open/closed state, the
  // inline error and the success line survive the re-render a successful write
  // triggers. Independent of the subtitle controls above: either, both or
  // neither may be mounted.
  const editor = o.audioEdit
    ? createAudioTrackEditor({
        assetId: o.audioEdit.assetId,
        apiFetch: o.audioEdit.apiFetch,
        confirmModal: o.audioEdit.confirmModal,
        onChanged: function (audioTracks) {
          // `audioTracks` is the authoritative post-write list (the add 201's
          // body, or the post-remove re-read of GET /assets/{id}/tracks). It is
          // merged into the held body so the re-render keeps every other
          // section — including the subtitle list — exactly as last read.
          held = Object.assign({}, held, { audioTracks: audioTracks });
          update(held);
          if (typeof o.audioEdit.onChanged === 'function') {
            o.audioEdit.onChanged(audioTracks);
          }
        },
      })
    : null;

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
   * `GET /assets/{id}/tracks` → `{ videoTracks, audioTracks, subtitleTracks }` —
   * THREE arrays, ALL THREE `required` (tracksSchema,
   * src/routes/assets.ts:958-965; `videoTracks` added by issue #978).
   *
   * Both EDITORIAL arrays are adopted, not just the subtitle one: the response
   * is authoritative for the pair and dropping the audio half would leave two
   * lists on screen read at different times.
   *
   * `videoTracks` is read and KNOWINGLY IGNORED — this is deliberate, not an
   * oversight. The video section is projected from `technicalMetadata` by
   * `videoTracksFromAsset`, because `GET /api/v1/assets/{id}` exposes no
   * `videoTracks` array (its 200 schema carries `technicalMetadata` /
   * `technicalMetadataError`), so the derived projection is the only source the
   * INITIAL render has. Adopting the array only here would swap the video
   * section onto a second, differently-shaped source part-way through a session
   * — `videoTrackOutSchema` (src/routes/assets.ts:930) can report many streams,
   * the derived projection is capped at one — and would contradict the
   * single-video-row ceiling this panel states on screen. Neither subtitle write
   * can change video anyway: the POST/DELETE handlers patch `subtitleTracks`
   * only. Video stays read-only and single-sourced.
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
    // `tracks.videoTracks` is the third required array on this response and is
    // intentionally not copied onto `next` — see the note above. The video
    // section keeps its single source, `technicalMetadata`, which no subtitle
    // write touches.
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
      audioEditor: editor,
      audioEditDenied: o.audioEditDenied,
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
