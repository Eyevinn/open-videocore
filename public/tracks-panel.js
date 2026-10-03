/**
 * open-videocore ops dashboard — tracks-panel.js
 *
 * The "Tracks" block on the asset detail view (issue #902, broken out of #794):
 * one section per track kind — video, audio, subtitle — each listing only the
 * attributes the API actually exposes for that kind, and each with an explicit
 * empty state when the asset has none.
 *
 * READ-ONLY BY DEFAULT, with ONE opt-in exception (issue #939): the audio
 * section grows add/remove controls when — and only when — the caller supplies
 * `audioEdit`. A caller that omits it gets exactly the #902 block: no button, no
 * input, no request. Video and subtitle stay read-only here; the subtitle
 * add/remove routes exist but carry a file-upload step
 * (`POST /assets/{id}/subtitle-tracks` returns a presigned `uploadUrl`), which is
 * not this issue.
 *
 * The block still issues no GET. Every value it renders on first paint is
 * already in the `GET /assets/{id}` body the detail view fetched, so the panel
 * adds no round-trip to the render; after an add or a remove it re-renders from
 * what that write returned, not from a re-read.
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
 *   AUDIO ADD / REMOVE (issue #939) — the two write operations this module now
 *     originates. Both were read from `openapi.json` AND exercised against the
 *     live router in-process (the real `assetsRouter` over
 *     `InMemoryAssetRepository`) before a line of this was written, because the
 *     spec does not model the validation failure and the panel has to render it.
 *
 *     ADD — `openapi.json .paths["/api/v1/assets/{id}/audio-tracks"].post`
 *       (`app.post('/:id/audio-tracks', …)`, src/routes/assets.ts:5428-5458).
 *       parameters: exactly one — path `id` (string, required). No query params.
 *       requestBody (`addAudioTrackSchema`, src/routes/assets.ts:826-832):
 *         `{ language: string(1..64)   ← the ONLY required field,
 *            codec?: string(1..64),
 *            channels?: integer(1..64),
 *            label?: string(1..128),
 *            default?: boolean }`, `additionalProperties: false`.
 *         `id` is NOT accepted from the client — the server mints it with
 *         `randomUUID()` (:5447), per the schema's own comment (:824-825).
 *       responses declared: `201` and `404` only.
 *         201 body is `{ audioTracks: audioTrackOutSchema[] }` (:5436) — the
 *           WHOLE updated list, not just the new track (`[...(asset.audioTracks
 *           ?? []), track]` at :5454). Verified live:
 *           `{"audioTracks":[{"id":"9551…","language":"sv"}]}`. So the panel
 *           re-renders from this body and never re-reads the asset.
 *         404 body is `{ error: "not_found" }` (unknown/foreign asset, :5444).
 *       NOT declared, but reachable and therefore handled: `400` from
 *         fastify-type-provider-zod, in Fastify's own validation envelope,
 *         before the handler runs. Captured live, verbatim:
 *           `{"statusCode":400,"code":"FST_ERR_VALIDATION","error":"Bad Request",
 *             "message":"body/language String must contain at least 1 character(s)"}`
 *           `{"…","message":"body/channels Number must be greater than or equal to 1"}`
 *           `{"…","message":"body/channels Expected integer, received float"}`
 *         That `message` is what the panel surfaces verbatim on a rejection.
 *       `403` is reachable too — see Authorisation below.
 *
 *     REMOVE — `openapi.json
 *       .paths["/api/v1/assets/{id}/audio-tracks/{trackId}"].delete`
 *       (`app.delete('/:id/audio-tracks/:trackId', …)`,
 *       src/routes/assets.ts:5463-5485).
 *       parameters: path `id` and path `trackId`, both required strings
 *         (:5468). No body, no query params.
 *       responses: `204` (empty body) and `404`. Verified live: a first delete
 *         answers 204 with no body; a second answers
 *         `{"error":"not_found","message":"audio track not found"}` (:5480),
 *         and an unknown asset answers `{"error":"not_found"}` (:5475).
 *       The 204 carries NOTHING, so the post-remove list is derived the same way
 *         the handler derives it — `existing.filter(t => t.id !== trackId)`
 *         (:5478). `audioTracksAfterRemoval` below is that same filter.
 *       NOT A FILE OPERATION. The handler's only effect is
 *         `repo.update(asset.id, { audioTracks })` (:5482). An editorial audio
 *         track has no `objectKey` in `audioTrackOutSchema` (:804-811) — unlike
 *         a subtitle track (:819) — so there is no stored object to delete and
 *         none is deleted. That is what the confirmation dialog's "does not
 *         affect" list states, and it is read from the handler, not assumed.
 *
 *     Authorisation — `MATRIX` (src/auth/authorize.ts:54-58) grants `write` to
 *       `editor`/`admin` and `delete` to `editor`/`admin`, neither to `viewer`;
 *       `methodToAction` (:79-93) maps POST -> write and DELETE -> delete; the
 *       router-level `resourceAuthorizationPreHandler('asset')` (:126,
 *       registered src/routes/assets.ts:1773) applies it to both operations. So
 *       a `viewer` gets 403 `forbidden_insufficient_role` (:99). `canEdit` below
 *       is a client-side MIRROR of that rule; the 403 path is still handled,
 *       because the server is the authority.
 *
 *     Path parameters — the handler passes the raw `:id` to `repo.get`
 *       (:5442/:5473) with NO slug fallback, so this module always sends the
 *       ULID (`asset.id`), which the detail pane holds even when it was opened
 *       by slug.
 *
 * WHAT THE API DOES NOT EXPOSE (checked, not assumed):
 *   - There is no GET on `/api/v1/assets/{id}/audio-tracks` or
 *     `…/subtitle-tracks`. In `openapi.json` those paths carry only `post`, and
 *     `…/{trackId}` only `delete` (src/routes/assets.ts:5429, 5464, 5494, 5542).
 *   - There is no PATCH/PUT on any track path: a track cannot be EDITED, only
 *     added and removed. The panel therefore offers no edit affordance.
 *   - `openapi.json` declares no `operationId` on any operation, so the two
 *     write operations are identified above by path + method, as the spec does.
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
 */

// ─── Copy deck ───────────────────────────────────────────────────────────────

export const TRACKS_COPY = Object.freeze({
  heading: 'Tracks',
  /**
   * Says what the block reports and, honestly, what it can change. Only the
   * EDITORIAL audio list is writable from here — the API exposes no write for a
   * video track or a probed stream, and subtitles need a file upload — so the
   * intro names that one exception instead of claiming the panel is editable.
   */
  intro:
    'Track structure as the API reports it. Editorial audio tracks can be ' +
    'added and removed here; everything else on this panel is read-only.',
  /** The #902 intro, still used when the caller mounts the panel read-only. */
  introReadOnly:
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
});

// ─── Copy deck: audio add / remove (issue #939) ──────────────────────────────
//
// Kept as its own frozen object so the read-only #902 deck above stays exactly
// what it was. Exported so a test asserts against the same sentences the
// operator sees.

export const AUDIO_EDIT_COPY = Object.freeze({
  /** Column added to the editorial audio table when editing is enabled. */
  actionsColumn: 'Actions',

  /** The disclosure that reveals the add form. */
  addToggle: 'Add audio track',
  addFormLabel: 'Add audio track',
  /** Names the one required field up front, from `addAudioTrackSchema`. */
  addFormIntro:
    'Language is required; everything else is optional and is left unset when ' +
    'you leave it blank. The track id is assigned by the API.',

  languageLabel: 'Language',
  languageHelp: 'Required. A BCP-47 tag such as sv, en-GB. Up to 64 characters.',
  labelLabel: 'Label',
  labelHelp: 'Optional display name, up to 128 characters.',
  codecLabel: 'Codec',
  codecHelp: 'Optional, up to 64 characters.',
  channelsLabel: 'Channels',
  channelsHelp: 'Optional whole number from 1 to 64.',
  defaultLabel: 'Mark as the default audio track',

  btnAdd: 'Add track',
  btnAdding: 'Adding…',
  btnCancel: 'Cancel',
  btnRemove: 'Remove',
  btnRemoving: 'Removing…',
  /** Per-row accessible name, so "Remove" is not repeated without a subject. */
  removeAriaPrefix: 'Remove audio track ',

  /** Client-side validation, mirroring addAudioTrackSchema's own bounds. */
  errLanguageEmpty: 'Enter a language. The API requires one on every audio track.',
  errLanguageLong: 'Language is too long (maximum 64 characters).',
  errLabelLong: 'Label is too long (maximum 128 characters).',
  errCodecLong: 'Codec is too long (maximum 64 characters).',
  errChannelsNotInteger: 'Channels must be a whole number, or left blank.',
  errChannelsRange: 'Channels must be between 1 and 64, or left blank.',

  /** Prefix for a rejection the API explained itself. */
  errRejectedPrefix: 'The API rejected this track: ',
  errRejectedBare: 'The API rejected this track. Nothing was added.',
  errAddForbidden:
    'Your role cannot add an audio track. Ask an editor or administrator.',
  errRemoveForbidden:
    'Your role cannot remove an audio track. Ask an editor or administrator.',
  errAddNotFound: 'This asset no longer exists. No track was added.',
  errRemoveNotFound:
    'That audio track is no longer on this asset, so there was nothing to ' +
    'remove. The list below has been updated.',
  errAddNetwork: 'Could not reach the API. No track was added.',
  errRemoveNetwork: 'Could not reach the API. The track was not removed.',

  /** Confirmation before the destructive call. */
  confirmTitle: 'Remove audio track',
  confirmLabel: 'Remove track',
  confirmAffected1:
    'The audio track is removed from this asset’s editorial track list.',
  /**
   * Verified, and deliberately blunt: the DELETE handler
   * (src/routes/assets.ts:5463-5485) calls `repo.update` and emits NO audit
   * entry — unlike the archive/restore paths (:5714, :5933) it is not wired to
   * the audit emitter. There is also no undo route, because no POST can
   * reinstate a server-minted track id. Both are worth knowing BEFORE the call.
   */
  confirmAffected2:
    'This cannot be undone from the UI: re-adding the track mints a new id, ' +
    'and the removal is not written to the audit log.',
  confirmUnaffected1:
    'No media is deleted. An editorial audio track is metadata only — it ' +
    'carries no object key, and the handler only rewrites the asset’s ' +
    'audioTracks array.',
  confirmUnaffected2:
    'The source streams the probe found in the file are untouched: they are a ' +
    'separate record set the API does not let this panel change.',
  confirmUnaffected3: 'Subtitle tracks, renditions and manifests are untouched.',

  /** Outcomes, written into the live region beside the list. */
  addedPrefix: 'Added audio track ',
  removedPrefix: 'Removed audio track ',
  /** Used when a track carries neither label nor language to name it by. */
  unnamedTrack: 'this audio track',
});

/** Server-enforced bounds, read off `addAudioTrackSchema` (assets.ts:826-832). */
export const AUDIO_LANGUAGE_MAX = 64;
export const AUDIO_CODEC_MAX = 64;
export const AUDIO_LABEL_MAX = 128;
export const AUDIO_CHANNELS_MIN = 1;
export const AUDIO_CHANNELS_MAX = 64;

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

// ─── Pure helpers: audio add / remove (issue #939) ───────────────────────────

/**
 * A human-readable name for one editorial audio track.
 *
 * NEVER the id: the id is a server-minted `randomUUID()` (assets.ts:5447) and
 * naming a destructive action by an opaque id is exactly what the house
 * confirmation primitive forbids. `label` is the operator's own words when they
 * supplied one; `language` is the only field the API guarantees is present
 * (`required: ["id","language"]`), so it is the fallback; the last resort is a
 * descriptive phrase, not the id.
 *
 * @param {object} track
 * @returns {string}
 */
export function audioTrackName(track) {
  const t = track && typeof track === 'object' ? track : {};
  const label = typeof t.label === 'string' ? t.label.trim() : '';
  if (label !== '') return label;
  const language = typeof t.language === 'string' ? t.language.trim() : '';
  if (language !== '') return language;
  return AUDIO_EDIT_COPY.unnamedTrack;
}

/**
 * Validate the add form against the SERVER's own bounds before any request is
 * made, so a 400 is not the normal way an operator learns the rules.
 *
 * Mirrors `addAudioTrackSchema` (src/routes/assets.ts:826-832) field for field:
 *   language  z.string().min(1).max(64)              — the only required field
 *   codec     z.string().min(1).max(64).optional()
 *   channels  z.number().int().min(1).max(64).optional()
 *   label     z.string().min(1).max(128).optional()
 *   default   z.boolean().optional()
 *
 * Strings are TRIMMED, and a string that trims to empty is treated as OMITTED
 * rather than sent: `min(1)` would reject `""` for every one of them, and an
 * untouched optional field must mean "do not set this", not "set it to empty".
 * For `language` — where omission is not an option — empty is the one error.
 *
 * `default` is sent ONLY when true. `false` is a legal value the server would
 * store, but an unchecked box means "I did not say", and the item schema's own
 * convention is that an optional flag is ABSENT until set.
 *
 * @param {{language?: unknown, codec?: unknown, channels?: unknown,
 *          label?: unknown, default?: unknown}} raw
 * @returns {{ ok: boolean, body: object|null,
 *             errors: {field: string, message: string}[] }}
 */
export function normaliseAudioTrackInput(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const text = function (value) {
    return typeof value === 'string' ? value.trim() : '';
  };

  const language = text(r.language);
  if (language === '') {
    errors.push({ field: 'language', message: AUDIO_EDIT_COPY.errLanguageEmpty });
  } else if (language.length > AUDIO_LANGUAGE_MAX) {
    errors.push({ field: 'language', message: AUDIO_EDIT_COPY.errLanguageLong });
  }

  const label = text(r.label);
  if (label.length > AUDIO_LABEL_MAX) {
    errors.push({ field: 'label', message: AUDIO_EDIT_COPY.errLabelLong });
  }

  const codec = text(r.codec);
  if (codec.length > AUDIO_CODEC_MAX) {
    errors.push({ field: 'codec', message: AUDIO_EDIT_COPY.errCodecLong });
  }

  // `channels` arrives as the input's string value. Blank is "unset"; anything
  // else must parse to an integer in range, because `z.number().int()` refuses
  // a float and the live route answers 400 "Expected integer, received float".
  const channelsRaw = typeof r.channels === 'number' ? String(r.channels) : text(r.channels);
  let channels;
  if (channelsRaw !== '') {
    const n = Number(channelsRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      errors.push({ field: 'channels', message: AUDIO_EDIT_COPY.errChannelsNotInteger });
    } else if (n < AUDIO_CHANNELS_MIN || n > AUDIO_CHANNELS_MAX) {
      errors.push({ field: 'channels', message: AUDIO_EDIT_COPY.errChannelsRange });
    } else {
      channels = n;
    }
  }

  if (errors.length > 0) return { ok: false, body: null, errors };

  return {
    ok: true,
    body: addAudioTrackRequestBody({
      language,
      label,
      codec,
      channels,
      default: r.default === true,
    }),
    errors: [],
  };
}

/**
 * Build the JSON body for `POST /api/v1/assets/{id}/audio-tracks`.
 *
 * ONLY the five keys `addAudioTrackSchema` declares, and only the ones that
 * actually carry a value. `id` is deliberately never sent: the schema does not
 * accept it (its own comment says so at src/routes/assets.ts:824-825) and the
 * server mints it with `randomUUID()` (:5447). Keeping body construction in one
 * exported function is what makes that assertable.
 *
 * @param {{language: string, label?: string, codec?: string,
 *          channels?: number, default?: boolean}} values
 * @returns {object}
 */
export function addAudioTrackRequestBody(values) {
  const v = values || {};
  const body = { language: String(v.language) };
  if (typeof v.codec === 'string' && v.codec !== '') body.codec = v.codec;
  if (typeof v.channels === 'number') body.channels = v.channels;
  if (typeof v.label === 'string' && v.label !== '') body.label = v.label;
  if (v.default === true) body.default = true;
  return body;
}

/**
 * The audio track list after removing one id — the same derivation the handler
 * performs, `existing.filter(t => t.id !== trackId)` (src/routes/assets.ts:5478).
 *
 * Needed because the DELETE answers `204` with NO body (:5469, verified live),
 * so there is no server list to re-render from and nothing to re-read: the one
 * honest local update is the server's own filter.
 *
 * @param {object[]} tracks
 * @param {string} trackId
 * @returns {object[]}
 */
export function audioTracksAfterRemoval(tracks, trackId) {
  if (!Array.isArray(tracks)) return [];
  return tracks.filter(function (t) {
    return !(t && typeof t === 'object' && t.id === trackId);
  });
}

/**
 * Classify a failed add/remove into operator-facing copy.
 *
 * Only `201`/`404` (add) and `204`/`404` (remove) are declared on these
 * operations, so `400` and `403` are handled WITHOUT assuming a modelled body.
 *
 * On a `400` the API has already said precisely what is wrong, in the Fastify
 * validation envelope's `message` (`"body/channels Expected integer, received
 * float"`, captured live) — `apiFetch` surfaces that as `err.message`. It is
 * shown verbatim rather than replaced with a vaguer sentence of our own: this is
 * a developer-facing tool and the field name in that string is the useful part.
 *
 * `gone: true` means the server state already matches what was asked for, so the
 * caller drops the row from the list in addition to reporting the message.
 *
 * @param {{status?: number, message?: string, body?: any}} err  an apiFetch rejection
 * @param {'add'|'remove'} op
 * @returns {{kind: 'forbidden'|'not-found'|'rejected'|'other', message: string, gone: boolean}}
 */
export function classifyAudioTrackError(err, op) {
  const e = err || {};
  const removing = op === 'remove';
  switch (e.status) {
    case 401:
    case 403:
      return {
        kind: 'forbidden',
        message: removing ? AUDIO_EDIT_COPY.errRemoveForbidden : AUDIO_EDIT_COPY.errAddForbidden,
        gone: false,
      };
    case 404:
      // Remove: the track (or its asset) is not there — which is the outcome the
      // operator wanted, so the row goes, but it is reported rather than passed
      // off as a success.
      return {
        kind: 'not-found',
        message: removing ? AUDIO_EDIT_COPY.errRemoveNotFound : AUDIO_EDIT_COPY.errAddNotFound,
        gone: removing,
      };
    case 400:
    case 422: {
      const detail = typeof e.message === 'string' ? e.message.trim() : '';
      return {
        kind: 'rejected',
        message:
          detail === '' || /^HTTP \d+$/.test(detail)
            ? AUDIO_EDIT_COPY.errRejectedBare
            : AUDIO_EDIT_COPY.errRejectedPrefix + detail,
        gone: false,
      };
    }
    default:
      // Transport failure, 5xx, or anything else undeclared: one honest sentence
      // that states the outcome (nothing changed).
      return {
        kind: 'other',
        message: removing ? AUDIO_EDIT_COPY.errRemoveNetwork : AUDIO_EDIT_COPY.errAddNetwork,
        gone: false,
      };
  }
}

/**
 * The confirmModal spec for removing one audio track.
 *
 * Both impact lists are read from the DELETE handler
 * (src/routes/assets.ts:5463-5485), not assumed: its only effect is
 * `repo.update(asset.id, { audioTracks })` (:5482), and an editorial audio track
 * has no `objectKey` in `audioTrackOutSchema` (:804-811) — so "no media is
 * deleted" is a statement about the handler, not a hope.
 *
 * @param {object} track
 * @returns {object} a confirmModal spec
 */
export function removeAudioTrackConfirmSpec(track) {
  const name = audioTrackName(track);
  return {
    title: AUDIO_EDIT_COPY.confirmTitle,
    subject: name,
    question: 'Remove audio track "' + name + '" from this asset?',
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

/**
 * A read-only table. `caption` is exposed to assistive technology but hidden
 * visually — the sighted reader already has the section heading (WCAG 2.1 AA:
 * the table is named without duplicating the heading on screen).
 *
 * Every cell is set with `textContent`. A cell may be a string, or
 * `{ text, mono }` to render it in the monospace class used for ids elsewhere in
 * the UI, or `{ text, badge: true }` for the "Default" flag, or `{ node }` to
 * place an already-built element (the per-row Remove control, issue #939 — the
 * ONLY cell shape that is not pure text, and it is built by this module, never
 * from a server value).
 *
 * @param {string} caption
 * @param {string[]} columns
 * @param {(string|{text?: string, mono?: boolean, badge?: boolean, node?: Node})[][]} rows
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
        td.className = 'cell-actions';
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
 * Build one row's Remove control. Returns null when editing is off, which is
 * what keeps the #902 block free of any control at all.
 */
function renderRemoveButton(track, edit) {
  const btn = el('button', 'btn-sm btn-danger tracks-audio-remove', AUDIO_EDIT_COPY.btnRemove);
  btn.type = 'button';
  // The visible word is "Remove" on every row, so the accessible name carries
  // the subject (WCAG 2.1 AA 2.4.6 / 4.1.2): "Remove audio track Swedish 2.0".
  btn.setAttribute('aria-label', AUDIO_EDIT_COPY.removeAriaPrefix + audioTrackName(track));
  // The id is the DELETE path parameter; held as data so the handler never has
  // to find the row's track by index into a list that may have moved on.
  btn.dataset['trackId'] = String(track && track.id != null ? track.id : '');
  btn.addEventListener('click', function () {
    edit.onRemove(track, btn);
  });
  return btn;
}

/**
 * The inline add form (issue #939).
 *
 * Inline rather than modal, and placed directly under the editorial list, so
 * the new row appears where the operator was looking and a rejection can be
 * rendered next to the control that caused it (acceptance criterion 3). It
 * starts collapsed behind a disclosure button so the panel's read-only reading
 * is not pushed down by a form nobody asked for.
 */
function renderAudioAddControl(edit) {
  const wrap = el('div', 'tracks-audio-add');

  const toggle = el('button', 'btn-ghost tracks-audio-add-toggle', AUDIO_EDIT_COPY.addToggle);
  toggle.type = 'button';
  toggle.id = 'tracks-audio-add-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'tracks-audio-add-form');
  wrap.appendChild(toggle);

  const form = el('div', 'tracks-audio-add-form');
  form.id = 'tracks-audio-add-form';
  form.setAttribute('role', 'group');
  form.setAttribute('aria-label', AUDIO_EDIT_COPY.addFormLabel);
  form.hidden = true;
  wrap.appendChild(form);

  form.appendChild(el('div', 'tracks-note', AUDIO_EDIT_COPY.addFormIntro));

  const row = el('div', 'form-row mt12');
  const fields = {};

  function addField(key, labelText, helpText, build) {
    const field = el('div', 'form-field');
    const id = 'tracks-audio-' + key;
    const label = el('label', null, labelText);
    label.setAttribute('for', id);
    const input = build();
    input.id = id;
    const help = el('div', 'text-muted tracks-field-help', helpText);
    help.id = id + '-help';
    input.setAttribute('aria-describedby', help.id);
    field.appendChild(label);
    field.appendChild(input);
    field.appendChild(help);
    row.appendChild(field);
    fields[key] = input;
  }

  addField('language', AUDIO_EDIT_COPY.languageLabel, AUDIO_EDIT_COPY.languageHelp, function () {
    const i = document.createElement('input');
    i.type = 'text';
    i.maxLength = AUDIO_LANGUAGE_MAX;
    // Mirrors the schema's single required field, for assistive technology.
    i.required = true;
    i.setAttribute('aria-required', 'true');
    return i;
  });
  addField('label', AUDIO_EDIT_COPY.labelLabel, AUDIO_EDIT_COPY.labelHelp, function () {
    const i = document.createElement('input');
    i.type = 'text';
    i.maxLength = AUDIO_LABEL_MAX;
    return i;
  });
  addField('codec', AUDIO_EDIT_COPY.codecLabel, AUDIO_EDIT_COPY.codecHelp, function () {
    const i = document.createElement('input');
    i.type = 'text';
    i.maxLength = AUDIO_CODEC_MAX;
    return i;
  });
  addField('channels', AUDIO_EDIT_COPY.channelsLabel, AUDIO_EDIT_COPY.channelsHelp, function () {
    const i = document.createElement('input');
    i.type = 'number';
    i.min = String(AUDIO_CHANNELS_MIN);
    i.max = String(AUDIO_CHANNELS_MAX);
    i.step = '1';
    return i;
  });
  form.appendChild(row);

  const checkWrap = el('div', 'checkbox-group');
  const checkLabel = el('label', 'checkbox-label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'tracks-audio-default';
  checkLabel.appendChild(checkbox);
  checkLabel.appendChild(document.createTextNode(AUDIO_EDIT_COPY.defaultLabel));
  checkLabel.setAttribute('for', checkbox.id);
  checkWrap.appendChild(checkLabel);
  form.appendChild(checkWrap);
  fields['default'] = checkbox;

  // Inline error area. Every refusal — client-side or from the API — keeps the
  // form OPEN and writes here, so nothing typed is lost and no failure is a
  // silent no-op (acceptance criterion 3). Never an alert().
  const errorEl = el('div', 'msg msg-error tracks-audio-add-error');
  errorEl.id = 'tracks-audio-add-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.style.display = 'none';
  form.appendChild(errorEl);

  const actions = el('div', 'modal-actions');
  const cancelBtn = el('button', 'btn-sm tracks-audio-add-cancel', AUDIO_EDIT_COPY.btnCancel);
  cancelBtn.type = 'button';
  const submitBtn = el('button', 'btn-sm tracks-audio-add-submit', AUDIO_EDIT_COPY.btnAdd);
  submitBtn.type = 'button';
  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  form.appendChild(actions);

  function setOpen(open) {
    form.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) fields['language'].focus();
    else toggle.focus();
  }

  toggle.addEventListener('click', function () {
    setOpen(form.hidden);
  });
  cancelBtn.addEventListener('click', function () {
    errorEl.style.display = 'none';
    errorEl.textContent = '';
    Object.keys(fields).forEach(function (k) {
      if (k === 'default') fields[k].checked = false;
      else fields[k].value = '';
    });
    setOpen(false);
  });
  submitBtn.addEventListener('click', function () {
    edit.onAdd(fields, { errorEl, submitBtn, cancelBtn });
  });
  // Enter in any text field submits, so the required-field-only case is one
  // keystroke rather than a reach for the mouse.
  ['language', 'label', 'codec'].forEach(function (k) {
    fields[k].addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        edit.onAdd(fields, { errorEl, submitBtn, cancelBtn });
      }
    });
  });

  return wrap;
}

function appendAudioSection(block, editorial, probed, edit) {
  // The `Audio` heading is deliberately UNCOUNTED. Editorial tracks and probed
  // source streams are different objects with no shared id (see CONTRACT
  // GROUNDING), so `editorial.length + probed.length` would be exactly the merge
  // this module refuses to make elsewhere — a two-track asset probed with two
  // streams is not a four-track asset. Each group carries its own count instead.
  block.appendChild(renderSectionTitle(TRACKS_COPY.audioHeading));

  // Editing is strictly opt-in: with no `edit` this builds the #902 section,
  // control for control.
  const editing = !!(edit && edit.canEdit);

  if (editorial.length === 0 && probed.length === 0) {
    block.appendChild(
      renderEmpty('audio-tracks', TRACKS_COPY.audioEmpty, TRACKS_COPY.audioEmptyDetail)
    );
    // An asset with no audio at all is the case that MOST needs the add
    // control, so the empty state does not end the section when editing is on.
    if (editing) appendAudioEditAffordances(block, edit);
    return;
  }

  block.appendChild(renderGroupTitle(TRACKS_COPY.audioEditorialGroup, editorial.length));
  if (editorial.length > 0) {
    const rows = editorial.map(function (t) {
      const cells = [
        attr(t.language),
        attr(t.label),
        attr(t.codec),
        attr(t.channels),
        t.default === true ? { text: TRACKS_COPY.defaultFlag, badge: true } : TRACKS_COPY.absent,
        { text: attr(t.id), mono: true },
      ];
      if (editing) cells.push({ node: renderRemoveButton(t, edit) });
      return cells;
    });
    const columns = ['Language', 'Label', 'Codec', 'Channels', 'Default', 'Track ID'];
    if (editing) columns.push(AUDIO_EDIT_COPY.actionsColumn);
    block.appendChild(renderTable('Editorial audio tracks', columns, rows));
  } else {
    block.appendChild(el('div', 'tracks-none', TRACKS_COPY.audioEditorialNone));
  }

  // Both affordances sit with the EDITORIAL group, directly under its list and
  // above the probed group — the probed streams are not writable and must not
  // look as though a control between the two tables applied to them.
  if (editing) appendAudioEditAffordances(block, edit);

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
 * The two shared pieces of the editorial-audio edit surface: the live region a
 * remove reports into, and the add disclosure. Appended once, in this order, by
 * whichever branch of `appendAudioSection` ran.
 */
function appendAudioEditAffordances(block, edit) {
  // Remove outcomes land here — an error (role="alert", announced at once) and
  // a success notice (role="status", announced politely). Both sit next to the
  // Remove controls rather than in the detail pane's shared message strip, so a
  // failure is attached to the thing that failed.
  const removeError = el('div', 'msg msg-error tracks-audio-error');
  removeError.id = 'tracks-audio-error';
  removeError.setAttribute('role', 'alert');
  removeError.style.display = 'none';
  block.appendChild(removeError);

  const notice = el('div', 'msg msg-success tracks-audio-notice');
  notice.id = 'tracks-audio-notice';
  notice.setAttribute('role', 'status');
  if (typeof edit.notice === 'string' && edit.notice !== '') {
    notice.textContent = edit.notice;
  } else {
    notice.style.display = 'none';
  }
  block.appendChild(notice);

  block.appendChild(renderAudioAddControl(edit));
}

function appendSubtitleSection(block, subtitles) {
  block.appendChild(renderSectionTitle(TRACKS_COPY.subtitleHeading, subtitles.length));
  if (subtitles.length === 0) {
    block.appendChild(
      renderEmpty('subtitle-tracks', TRACKS_COPY.subtitleEmpty, TRACKS_COPY.subtitleEmptyDetail)
    );
    return;
  }
  const rows = subtitles.map(function (t) {
    return [
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
  });
  block.appendChild(
    renderTable(
      'Subtitle tracks',
      ['Language', 'Label', 'Format', 'Default', 'Object key', 'Track ID'],
      rows
    )
  );
}

// ─── Block ───────────────────────────────────────────────────────────────────

/**
 * Build the whole block for one asset read.
 *
 * NEVER fetches. Attaches listeners only when `data.audioEdit.canEdit` is set,
 * and even then only to the handlers the CALLER supplied — this function knows
 * no path, method or request shape of its own.
 *
 * @param {object} data
 * @param {object[]} data.video            from `videoTracksFromAsset`
 * @param {object[]} data.audioEditorial   `asset.audioTracks`
 * @param {object[]} data.audioProbed      from `probedAudioStreamsFromAsset`
 * @param {object[]} data.subtitles        `asset.subtitleTracks`
 * @param {string}   [data.extractionError] `asset.technicalMetadataError`
 * @param {object}   [data.audioEdit]      OPT-IN editorial-audio edit surface
 *   (issue #939). Omit it and the block is the #902 read-only one, with no
 *   button, input or listener anywhere in it.
 * @param {boolean}  [data.audioEdit.canEdit] client-side mirror of the ADR-018
 *   write/delete gate. False renders read-only, exactly as omitting audioEdit.
 * @param {(fields: object, ui: object) => void} [data.audioEdit.onAdd]
 * @param {(track: object, btn: HTMLElement) => void} [data.audioEdit.onRemove]
 * @param {string}   [data.audioEdit.notice] outcome text to show on this render
 * @returns {HTMLElement}
 */
export function renderTracksBlock(data) {
  const d = data || {};
  const video = Array.isArray(d.video) ? d.video : [];
  const audioEditorial = Array.isArray(d.audioEditorial) ? d.audioEditorial : [];
  const audioProbed = Array.isArray(d.audioProbed) ? d.audioProbed : [];
  const subtitles = Array.isArray(d.subtitles) ? d.subtitles : [];
  const audioEdit = d.audioEdit && d.audioEdit.canEdit ? d.audioEdit : null;

  const block = el('div', 'mt12 tracks-block');
  block.id = 'asset-tracks';
  block.appendChild(el('div', 'section-title', TRACKS_COPY.heading));
  // The intro must not promise an affordance this render does not carry.
  block.appendChild(
    el('div', 'tracks-note', audioEdit ? TRACKS_COPY.intro : TRACKS_COPY.introReadOnly)
  );

  appendVideoSection(block, video, d.extractionError);
  appendAudioSection(block, audioEditorial, audioProbed, audioEdit);
  appendSubtitleSection(block, subtitles);

  return block;
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Render the "Tracks" block into the asset detail view.
 *
 * Network-free ON RENDER: all four record sets — the video attributes, the
 * editorial audio and subtitle tracks, and the probed source streams — are
 * properties of the `GET /assets/{id}` body the caller already holds, so the
 * panel neither re-reads the asset nor calls `GET /assets/{id}/tracks` for
 * bytes it was handed (see CONTRACT GROUNDING). It therefore adds no round-trip
 * to the detail render, and there is no "tracks unavailable" state: an absent
 * array is a known-empty kind, not a failed read.
 *
 * It DOES issue requests when the operator acts, and only then — one
 * `POST /assets/{id}/audio-tracks` per add, one
 * `DELETE /assets/{id}/audio-tracks/{trackId}` per confirmed remove, and no
 * follow-up read after either: the POST's 201 carries the whole new list, and
 * the DELETE's effect is reproduced locally by the handler's own filter
 * (`audioTracksAfterRemoval`). Those two write options are supplied by the
 * caller (`apiFetch`, `confirmModal`); this module imports nothing.
 *
 * The block is inserted before `anchorEl` when given, else appended to `host`.
 *
 * @param {object} opts
 * @param {object}      opts.asset      the `GET /assets/{id}` 200 body already
 *                                      rendered by the caller
 * @param {HTMLElement} [opts.host]     container to append to
 * @param {HTMLElement} [opts.anchorEl] element to insert before, inside its parent
 * @param {boolean}  [opts.canEditAudio] client-side mirror of the ADR-018
 *   write/delete gate for this asset. Falsy (the default) mounts the panel
 *   read-only — no control is rendered at all, as before #939.
 * @param {Function} [opts.apiFetch]     required when canEditAudio is set
 * @param {Function} [opts.confirmModal] required when canEditAudio is set; the
 *   house destructive-confirmation primitive. No native confirm() is used.
 * @param {(audioTracks: object[], message: string, kind: string) => any}
 *   [opts.onAudioTracksChanged] notified after a successful add/remove with the
 *   authoritative list, so the caller can refresh anything else showing it.
 * @returns {{ block: HTMLElement, update: (asset: object) => void }}
 */
export function mountAssetTracks(opts) {
  const o = opts || {};

  let rendered = null;
  // The asset most recently rendered from, so a write can re-render the whole
  // block (video + probed + subtitles unchanged) with only the audio list moved
  // on. Never re-fetched: see the add/remove notes above.
  let currentAsset = o.asset || {};
  // Carried across exactly one re-render, then cleared — the success line lives
  // in the block, and the block is replaced wholesale on every update.
  let pendingNotice = '';

  // Editing needs both collaborators. Missing either would mean a control that
  // cannot complete its action, so it is not offered.
  const canEdit = !!(o.canEditAudio && typeof o.apiFetch === 'function' &&
    typeof o.confirmModal === 'function');

  // The ULID, never the slug: both track routes hand the raw `:id` to repo.get
  // with no slug fallback (src/routes/assets.ts:5442, :5473).
  function audioTracksPath() {
    return '/assets/' + encodeURIComponent(String(currentAsset.id)) + '/audio-tracks';
  }

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

  function showInline(node, message) {
    if (!node) return;
    node.textContent = message;
    node.style.display = '';
  }

  function clearInline(node) {
    if (!node) return;
    node.textContent = '';
    node.style.display = 'none';
  }

  /** Re-render from a track list the server just confirmed, and report it. */
  function applyAudioTracks(audioTracks, message) {
    pendingNotice = message || '';
    currentAsset = Object.assign({}, currentAsset, { audioTracks: audioTracks });
    update(currentAsset);
    if (typeof o.onAudioTracksChanged === 'function') {
      o.onAudioTracksChanged(audioTracks, pendingNotice, 'success');
    }
    pendingNotice = '';
  }

  async function onAdd(fields, ui) {
    clearInline(ui.errorEl);

    // Client-side gate first, against the SERVER's own bounds. A refusal here
    // sends no request at all and names the field that is wrong.
    const check = normaliseAudioTrackInput({
      language: fields.language.value,
      label: fields.label.value,
      codec: fields.codec.value,
      channels: fields.channels.value,
      default: fields['default'].checked,
    });
    if (!check.ok) {
      showInline(ui.errorEl, check.errors.map(function (e) { return e.message; }).join(' '));
      const first = fields[check.errors[0].field];
      if (first && typeof first.focus === 'function') first.focus();
      return;
    }

    const prev = ui.submitBtn.textContent;
    ui.submitBtn.disabled = true;
    ui.cancelBtn.disabled = true;
    ui.submitBtn.textContent = AUDIO_EDIT_COPY.btnAdding;
    try {
      // 201 -> { audioTracks: [...] }: the WHOLE updated list, so the panel
      // re-renders from the server's answer rather than appending its own guess
      // of what was stored.
      const result = await o.apiFetch(audioTracksPath(), {
        method: 'POST',
        body: JSON.stringify(check.body),
      });
      const list = result && Array.isArray(result.audioTracks) ? result.audioTracks : [];
      const added = list.length > 0 ? list[list.length - 1] : check.body;
      applyAudioTracks(list, AUDIO_EDIT_COPY.addedPrefix + audioTrackName(added) + '.');
    } catch (err) {
      // Never a silent no-op: the dialog stays open, keeping what was typed,
      // and the API's own explanation is rendered beside the control.
      const c = classifyAudioTrackError(err, 'add');
      showInline(ui.errorEl, c.message);
    } finally {
      ui.submitBtn.disabled = false;
      ui.cancelBtn.disabled = false;
      ui.submitBtn.textContent = prev;
    }
  }

  async function onRemove(track, btn) {
    const errorEl = rendered ? rendered.querySelector('#tracks-audio-error') : null;
    clearInline(errorEl);

    // The confirmation step required before the destructive call. The house
    // primitive, named by the track's human-readable name — never its id.
    const ok = await o.confirmModal(removeAudioTrackConfirmSpec(track));
    if (!ok) return;

    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = AUDIO_EDIT_COPY.btnRemoving;
    try {
      // 204, no body (verified live), so nothing is parsed from the response.
      await o.apiFetch(audioTracksPath() + '/' + encodeURIComponent(String(track.id)), {
        method: 'DELETE',
      });
      applyAudioTracks(
        audioTracksAfterRemoval(editorialTracksFromAsset(currentAsset).audioTracks, track.id),
        AUDIO_EDIT_COPY.removedPrefix + audioTrackName(track) + '.'
      );
    } catch (err) {
      const c = classifyAudioTrackError(err, 'remove');
      if (c.gone) {
        // A 404 means the server already agrees the track is not there. Drop the
        // row so the list stops lying, but report it as a failure, not a tidy
        // success — the operator asked for something that had already happened.
        pendingNotice = '';
        currentAsset = Object.assign({}, currentAsset, {
          audioTracks: audioTracksAfterRemoval(
            editorialTracksFromAsset(currentAsset).audioTracks,
            track.id
          ),
        });
        update(currentAsset);
        showInline(rendered.querySelector('#tracks-audio-error'), c.message);
        return;
      }
      showInline(rendered ? rendered.querySelector('#tracks-audio-error') : null, c.message);
    } finally {
      // Never leave a control stuck pending. The button is gone after a
      // successful re-render, which is why `parentNode` is checked.
      if (btn.parentNode) {
        btn.disabled = false;
        btn.textContent = prev;
      }
    }
  }

  /** Re-render from a freshly read asset body, in place. */
  function update(asset) {
    const a = asset || {};
    currentAsset = a;
    const editorial = editorialTracksFromAsset(a);
    const next = renderTracksBlock({
      video: videoTracksFromAsset(a),
      audioEditorial: editorial.audioTracks,
      audioProbed: probedAudioStreamsFromAsset(a),
      subtitles: editorial.subtitleTracks,
      extractionError: a.technicalMetadataError,
      audioEdit: canEdit
        ? { canEdit: true, onAdd: onAdd, onRemove: onRemove, notice: pendingNotice }
        : null,
    });
    place(next);
    rendered = next;
  }

  update(o.asset);
  return {
    get block() {
      return rendered;
    },
    update: update,
  };
}
