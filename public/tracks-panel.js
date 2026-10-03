/**
 * open-videocore ops dashboard — tracks-panel.js
 *
 * The "Tracks" block on the asset detail view (issue #902, broken out of #794):
 * one section per track kind — video, audio, subtitle — each listing only the
 * attributes the API actually exposes for that kind, and each with an explicit
 * empty state when the asset has none.
 *
 * READ-ONLY EXCEPT FOR SUBTITLE ADD/REMOVE (issue #940). The video and audio
 * sections create no control and issue no call: the API has no video-track route
 * at all, and the audio add/remove routes are out of scope for #940. The
 * subtitle section is the one exception — it carries an add form and a per-row
 * remove control wired to `POST /assets/{id}/subtitle-tracks` and
 * `DELETE /assets/{id}/subtitle-tracks/{trackId}` (contract below).
 *
 * It still issues no GET. Every value the panel renders on first paint is
 * already in the `GET /assets/{id}` body the detail view fetched, so the panel
 * adds no round-trip to the render; after a write it re-renders from the write's
 * OWN response body (the 201 carries the track the server persisted), not from a
 * guess and not from a second read.
 *
 * The write controls are opt-in: with no `apiFetch` injected the module behaves
 * exactly as #902 shipped it — no controls, no listeners, no calls.
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
 *       (src/routes/assets.ts:916) and
 *       `subtitleTracks: z.array(subtitleTrackOutSchema).optional()` (:917),
 *       `audioTrackOutSchema` :804-811, `subtitleTrackOutSchema` :815-822; the
 *       subtitle vocabulary is `SUBTITLE_FORMATS = ['vtt','srt','ttml']`,
 *       src/data/asset-repo.ts:449, reached via `subtitleFormatSchema`
 *       (src/routes/assets.ts:813).
 *     ABSENT MEANS "NONE", NOT "UNKNOWN". The field is optional because the
 *       arrays are "absent until the first track of the respective kind is
 *       added" (src/routes/assets.ts:914-915); persistence only writes the
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
 *       (src/routes/assets.ts:893) with `technicalMetadataError: z.string()
 *       .optional()` (:894); `technicalMetadataSchema` :761-771.
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
 *     src/routes/assets.ts:754-759; persisted as `technical.audio`,
 *     src/data/asset-document.ts:405-410).
 *     This is a DIFFERENT set of objects from the editorial `audioTracks` at the
 *     top level of the asset: different fields, different lifecycle (one is
 *     written by the ffprobe extraction, the other by an operator), no shared
 *     id. They share only a name. The audio section therefore lists them as two
 *     labelled groups and never merges, correlates, de-duplicates or SUMS them —
 *     the API publishes no key that would justify any of that, so each group
 *     carries its own count and the `Audio` heading carries none.
 *
 *   SUBTITLE ADD (issue #940) — `openapi.json
 *     .paths["/api/v1/assets/{id}/subtitle-tracks"].post`. The ONLY key on that
 *     path object is `post`; there is no GET (see "What the API does NOT
 *     expose").
 *     parameters: exactly one — path `id` (string, required). NO query params.
 *     requestBody: `required: true`, `application/json`,
 *       `additionalProperties: false`, `required: ["language","format"]`:
 *         `language` string, minLength 1, maxLength 64
 *         `format`   string, enum ["vtt","srt","ttml"]
 *         `label`    string, minLength 1, maxLength 128   (optional)
 *         `default`  boolean                              (optional)
 *       So exactly TWO fields are required and the form asks for exactly those
 *       two plus the two optional ones — nothing else may be sent, because
 *       `additionalProperties: false` makes an extra key a 400.
 *     Source of truth: `addSubtitleTrackSchema`, src/routes/assets.ts:834-839,
 *       wired as `body: addSubtitleTrackSchema` at :5676 on
 *       `app.post('/:id/subtitle-tracks', …)` :5670-5712. The format vocabulary
 *       is `subtitleFormatSchema = z.enum(SUBTITLE_FORMATS)` (:813) over
 *       `SUBTITLE_FORMATS = ['vtt','srt','ttml']` (src/data/asset-repo.ts:449) —
 *       the SAME constant the read path renders, so the select cannot offer a
 *       value the response schema would refuse.
 *     responses: exactly `201` and `404` are DECLARED (:5677-5681).
 *       201: `{ track: <subtitleTrackOutSchema>, uploadUrl?: string }`,
 *            `required: ["track"]`, `additionalProperties: false`.
 *            `track` is the SAME item schema the read path renders, and it is
 *            literally the object the handler persisted — built at :5698-5707,
 *            written by `repo.update(asset.id, { subtitleTracks })` at :5709,
 *            then sent at :5710. So appending it to the on-screen list shows
 *            what the server stored; it is the server's answer, not an
 *            optimistic patch.
 *       404: `{ error: string, message?: string }` — unknown/foreign asset
 *            (:5685-5687, `errorSchema` :538).
 *       400 is NOT declared but IS reachable: a body that fails
 *            `addSubtitleTrackSchema` is a Fastify validation error, and the
 *            router's `setErrorHandler` (:2837-2914) rethrows anything it does
 *            not classify, so Fastify's default handler answers 400. Asserted
 *            in the API's own suite — `format: 'sub'` → 400,
 *            test/tracks.test.ts:223-233. Surfaced inline verbatim.
 *       `uploadUrl` is a presigned PUT for the subtitle FILE
 *            (`storageFor().presignedPut(objectKey)`, :5695), returned only when
 *            object storage is configured. The track is created either way
 *            (:5704 — `objectKey` is recorded only when storage exists).
 *            Adding a track therefore REGISTERS it; it does not upload a
 *            subtitle file. The panel says so and deliberately does NOT print
 *            the signed URL into the DOM — it is a short-lived credential, and
 *            the object key it points at is already in the table.
 *
 *   SUBTITLE REMOVE (issue #940) — `openapi.json
 *     .paths["/api/v1/assets/{id}/subtitle-tracks/{trackId}"].delete`. The ONLY
 *     key on that path object is `delete`.
 *     parameters: exactly two path params, `id` and `trackId`, both string +
 *       required. NO query params — there is no `?force=` on this operation.
 *     requestBody: NONE.
 *     responses: exactly `204` (null) and `404` `{ error, message? }`.
 *     Source of truth: `app.delete('/:id/subtitle-tracks/:trackId', …)`,
 *       src/routes/assets.ts:5718-5740; params :5723, response map :5724.
 *     The 404 covers BOTH "unknown/foreign asset" (:5729-5731) and "no track
 *       with that id" (:5734-5736). The panel does not try to tell those apart:
 *       under either one the server does not have this track, so dropping the
 *       row is correct for both.
 *     This removes the TRACK RECORD only. The handler filters the array and
 *       updates the document (:5732-5737); the subtitle object in storage is
 *       left behind on purpose — "Leaves the subtitle object (if any) in
 *       storage; storage reclamation is a separate lifecycle concern" (:5714).
 *       The confirmation dialog states exactly that, both sides.
 *
 *   AUTHORISATION for both writes — the ADR-018 role×action matrix `MATRIX`
 *     (src/auth/authorize.ts:54-58: `viewer { read: true, write: false,
 *     delete: false }`, editor/admin all true) applied by
 *     `resourceAuthorizationPreHandler('asset')` (src/auth/authorize.ts:126,
 *     registered src/routes/assets.ts:1773), with the action from
 *     `methodToAction` (:79-93): POST → `write`, DELETE → `delete`. A `viewer`
 *     holds neither, so both controls are withheld for that role and the 403
 *     (`AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role'`,
 *     src/auth/authorize.ts:99) is still handled when it arrives — the server is
 *     the authority, the client gate is only a mirror.
 *
 *   NOT offered, because the contract does not support it: editing a track in
 *     place. There is no PATCH/PUT on either track path, so "change the label"
 *     is add + remove, and this panel does not dress those two calls up as one
 *     edit. Nor is `default` exclusive: the add handler stores the flag as given
 *     and never clears it on the other tracks (:5698-5707), so two tracks CAN
 *     both read Default. The form says so rather than implying a radio group.
 *
 * WHAT THE API DOES NOT EXPOSE (checked, not assumed):
 *   - There is no GET on `/api/v1/assets/{id}/audio-tracks` or
 *     `…/subtitle-tracks`. In `openapi.json` those paths carry only `post`, and
 *     `…/{trackId}` only `delete` (src/routes/assets.ts:5606, 5641, 5671, 5719).
 *   - `GET /api/v1/assets/{id}/tracks` DOES exist and is the only *dedicated*
 *     read for the two editorial kinds — but it is not a second source of truth:
 *     its handler sends `asset.audioTracks ?? []` / `asset.subtitleTracks ?? []`
 *     from the very same document (src/routes/assets.ts:5595-5598, via
 *     `repo.get(request.params.id)` at :5591). A caller that already holds the
 *     asset — which the detail view always does — would be paying a round-trip
 *     for bytes it has, so this panel does not call it. It is not called after a
 *     write either: the 201 already carries the persisted track and the 204
 *     already means "gone", so a re-read would buy nothing.
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
  /** Says outright that this block only reports; #902 is read-only. */
  intro:
    'Track structure as the API reports it. Read-only — tracks are added and ' +
    'removed through the API, not from this panel.',
  /**
   * The intro once the subtitle controls are live (#940). It says which kind is
   * writable rather than claiming the whole block is: the API has no video-track
   * route at all, so "editable" would be a lie for two of the three sections.
   */
  introWritableSubtitles:
    'Track structure as the API reports it. Subtitle tracks can be added and ' +
    'removed here; video and audio are read-only, because the API exposes no ' +
    'write path for them from this panel.',

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

  // ── Subtitle add/remove (issue #940) ──────────────────────────────────────

  addHeading: 'Add a subtitle track',
  /**
   * What the add call does and — just as important — what it does NOT do. The
   * 201 registers a track and hands back a presigned PUT for the file
   * (src/routes/assets.ts:5698); it does not move any bytes, and this panel does
   * not upload the file either. Saying that here is the difference between an
   * operator who knows the track is still empty and one who thinks subtitles are
   * live.
   */
  addIntro:
    'Registers a subtitle track against this asset. Language and format are ' +
    'the only fields the API requires.',
  addFileNote:
    'This registers the track only — it does not upload a subtitle file. When ' +
    'object storage is configured the API records the object key the file ' +
    'belongs at (shown in the table) and returns a short-lived upload URL for ' +
    'it; uploading is a separate step and is not done from this panel.',
  /**
   * `default` is NOT exclusive in the contract: the handler stores the flag as
   * given and never clears it on the other tracks (src/routes/assets.ts:5698-5707).
   * So this is a checkbox with a warning, not a radio group that would imply the
   * API enforces one winner.
   */
  addDefaultNote:
    'The API stores this flag as given and does not clear it on the other ' +
    'tracks, so more than one track can end up marked Default.',

  fieldLanguage: 'Language',
  fieldFormat: 'Format',
  fieldLabel: 'Label',
  fieldDefault: 'Default track',
  /** `language` is a free-form BCP-47 string in the contract, not an enum. */
  helpLanguage: 'Free-form language tag, e.g. "en", "sv" or "en-GB". Required.',
  helpFormat: 'The formats the API accepts. Required.',
  helpLabel: 'Optional display name, e.g. "English (forced)". Left out when blank.',

  btnAdd: 'Add subtitle track',
  btnAdding: 'Adding…',
  btnRemove: 'Remove',
  btnRemoving: 'Removing…',
  colRemove: 'Remove',

  /** Client-side mirrors of `addSubtitleTrackSchema` (src/routes/assets.ts:834-839). */
  errLanguageRequired: 'Language is required.',
  errLanguageTooLong: 'Language must be 64 characters or fewer.',
  errFormatRequired: 'Choose a subtitle format.',
  errLabelTooLong: 'Label must be 128 characters or fewer.',

  /** Outcomes. */
  addedPrefix: 'Added subtitle track ',
  removedPrefix: 'Removed subtitle track ',

  /** Failures, by the statuses the operation can actually answer with. */
  errAddFailed: 'The API refused this track: ',
  errRemoveFailed: 'The API refused the removal: ',
  errAssetGone:
    'This asset is no longer available to the API — it may have been removed, ' +
    'or it belongs to another workspace. Reload the asset.',
  errTrackGone:
    'The API no longer has that track, so it has been taken off this list. ' +
    'Someone else may have removed it.',
  errForbidden:
    'Your role may not change tracks on this asset. The API refused with 403.',
  errNetwork: 'The call did not complete. Nothing was changed.',

  /** Withheld-control note, for a role that cannot write. */
  roleNote:
    'Your role can read tracks but not change them, so the add and remove ' +
    'controls are not offered. Adding or removing needs the editor or admin ' +
    'role.',

  // Confirmation dialog for the destructive call.
  confirmRemoveTitle: 'Remove subtitle track',
  confirmRemoveLabel: 'Remove track',
  confirmAffected1: 'The subtitle track record is removed from this asset.',
  confirmAffected2:
    'Any packaging or delivery that lists this track stops seeing it.',
  /**
   * Verified, not assumed: the handler filters the array and updates the
   * document (src/routes/assets.ts:5732-5737) and the route comment says it
   * "Leaves the subtitle object (if any) in storage" (:5714).
   */
  confirmUnaffected1:
    'The subtitle file in object storage is NOT deleted — only the track record ' +
    'is. Reclaiming the object is a separate lifecycle step.',
  confirmUnaffected2:
    'No other track, and no video or audio, is touched. The asset itself is not ' +
    'archived or deleted.',
  confirmIrreversible:
    'There is no undo: the API exposes no edit on a track, so restoring it means ' +
    'adding it again with the same fields and a new track id.',
});

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

// ─── Subtitle write path: pure helpers (issue #940) ──────────────────────────

/**
 * The subtitle formats the API accepts, in the order the contract lists them.
 *
 * `SUBTITLE_FORMATS = ['vtt','srt','ttml']` (src/data/asset-repo.ts:449), reached
 * from the request body as `format: subtitleFormatSchema`
 * (`z.enum(SUBTITLE_FORMATS)`, src/routes/assets.ts:813, used by
 * `addSubtitleTrackSchema` :836). This is the whole vocabulary — a value outside
 * it is a 400 — so the select is built from exactly this list and can send
 * nothing else.
 *
 * The READ path stays deliberately permissive (`attr(t.format)` renders whatever
 * the server sent, enum or not): this client owns what it may SEND, never what
 * the API may report.
 */
export const SUBTITLE_FORMATS = Object.freeze(['vtt', 'srt', 'ttml']);

/** `language.max(64)` — src/routes/assets.ts:835. */
export const SUBTITLE_LANGUAGE_MAX = 64;
/** `label.max(128)` — src/routes/assets.ts:837. */
export const SUBTITLE_LABEL_MAX = 128;

/**
 * Build the `POST /assets/{id}/subtitle-tracks` request body from form input, or
 * say which field is wrong.
 *
 * A mirror of `addSubtitleTrackSchema` (src/routes/assets.ts:834-839), not a
 * reinterpretation of it:
 *   - `language`: required, `min(1).max(64)`. Trimmed, because " " would pass a
 *     naive presence check and then be stored as whitespace.
 *   - `format`: required, must be in `SUBTITLE_FORMATS`.
 *   - `label`: optional, `min(1).max(128)`. A BLANK label is OMITTED, never sent
 *     as `''` — `min(1)` means the empty string is a 400, so "I left it blank"
 *     has to serialise as absence.
 *   - `default`: optional boolean. Omitted when false, so the body carries only
 *     what the operator actually asked for.
 * Nothing else is ever added: the schema is `additionalProperties: false`, so an
 * extra key would be refused outright.
 *
 * The client check exists to put the message next to the field; it is not the
 * authority. A body that slips past it still gets the server's 400 rendered
 * verbatim.
 *
 * @param {{language?: unknown, format?: unknown, label?: unknown, default?: unknown}} input
 * @returns {{ok: true, body: object} | {ok: false, field: string, message: string}}
 */
export function buildAddSubtitleBody(input) {
  const i = input || {};
  const language = typeof i.language === 'string' ? i.language.trim() : '';
  const format = typeof i.format === 'string' ? i.format : '';
  const label = typeof i.label === 'string' ? i.label.trim() : '';

  if (language === '') {
    return { ok: false, field: 'language', message: TRACKS_COPY.errLanguageRequired };
  }
  if (language.length > SUBTITLE_LANGUAGE_MAX) {
    return { ok: false, field: 'language', message: TRACKS_COPY.errLanguageTooLong };
  }
  if (SUBTITLE_FORMATS.indexOf(format) === -1) {
    return { ok: false, field: 'format', message: TRACKS_COPY.errFormatRequired };
  }
  if (label.length > SUBTITLE_LABEL_MAX) {
    return { ok: false, field: 'label', message: TRACKS_COPY.errLabelTooLong };
  }

  const body = { language: language, format: format };
  if (label !== '') body.label = label;
  if (i.default === true) body.default = true;
  return { ok: true, body: body };
}

/**
 * A human-readable name for one subtitle track, for the confirmation dialog.
 *
 * confirmModal's rule is that the subject is never an opaque id, and a subtitle
 * track has no `name`: `label` is OPTIONAL in `subtitleTrackOutSchema`
 * (src/routes/assets.ts:815-822) and only `id`, `language` and `format` are
 * `required`. So the name is built from the two fields that are always there,
 * with the label in front when the server has one. The id is never the subject —
 * it is server-generated (`randomUUID()`, src/routes/assets.ts:5688) and means
 * nothing to a reader.
 *
 * @param {{language?: unknown, format?: unknown, label?: unknown}} track
 * @returns {string}
 */
export function subtitleTrackSubject(track) {
  const t = track || {};
  const parts = [];
  if (typeof t.label === 'string' && t.label.trim() !== '') parts.push(t.label.trim());
  if (typeof t.language === 'string' && t.language.trim() !== '') parts.push(t.language.trim());
  const name = parts.join(' — ');
  const format = typeof t.format === 'string' && t.format !== '' ? t.format : null;
  if (name === '') return format ? 'untitled ' + format + ' track' : 'untitled subtitle track';
  return format ? name + ' (' + format + ')' : name;
}

/**
 * The confirmModal spec for removing one track. Built here, as a value, so the
 * impact lists live next to the contract note that justifies them.
 *
 * Both lists are route-verified, not plausible-sounding: the handler filters the
 * array and persists it (src/routes/assets.ts:5732-5737) and the route comment
 * states the storage object is left behind (:5714). `blocked` is never set —
 * this operation has no refusal state to explain up front; it answers only 204
 * or 404.
 *
 * @param {object} track  one entry of `asset.subtitleTracks`
 * @returns {object} a confirmModal spec
 */
export function removeSubtitleConfirmSpec(track) {
  const subject = subtitleTrackSubject(track);
  return {
    title: TRACKS_COPY.confirmRemoveTitle,
    subject: subject,
    question: 'Remove the subtitle track "' + subject + '" from this asset?',
    detail: TRACKS_COPY.confirmIrreversible,
    confirmLabel: TRACKS_COPY.confirmRemoveLabel,
    affected: [TRACKS_COPY.confirmAffected1, TRACKS_COPY.confirmAffected2],
    unaffected: [TRACKS_COPY.confirmUnaffected1, TRACKS_COPY.confirmUnaffected2],
  };
}

/**
 * Classify a failed subtitle add or remove.
 *
 * Statuses, from the contract rather than from habit:
 *   400 — DECLARED nowhere on either operation, but reachable on the POST: the
 *         router's `setErrorHandler` rethrows what it cannot classify
 *         (src/routes/assets.ts:2837-2914), so a body that fails
 *         `addSubtitleTrackSchema` gets Fastify's 400 (asserted by the API's own
 *         suite, test/tracks.test.ts:223-233). The server's own `message` names
 *         the offending field, so it is surfaced VERBATIM rather than replaced
 *         with a generic line — a silent no-op is the one outcome #940 forbids.
 *   401/403 — not declared on either operation either, but produced by the auth
 *         gate ahead of the handler (src/auth/authorize.ts:126, registered
 *         src/routes/assets.ts:1773).
 *   404 — DECLARED on both. On the POST it can only mean the asset
 *         (src/routes/assets.ts:5685-5687). On the DELETE it means the asset OR
 *         the track (:5729-5731 / :5734-5736); `retire` tells the caller to drop
 *         the row, which is right under either reading.
 *   413/422/409 — none of these exist on these two operations. Nothing here
 *         pretends to handle them; they fall to `other`.
 *
 * @param {{status?: number, message?: string, body?: any}} err  an apiFetch rejection
 * @param {'add'|'remove'} op
 * @returns {{kind: string, message: string, forbidden: boolean, retire: boolean}}
 */
export function classifySubtitleWriteError(err, op) {
  const e = err || {};
  const prefix = op === 'remove' ? TRACKS_COPY.errRemoveFailed : TRACKS_COPY.errAddFailed;

  if (e.status === 401 || e.status === 403) {
    return { kind: 'forbidden', message: TRACKS_COPY.errForbidden, forbidden: true, retire: false };
  }
  if (e.status === 404) {
    // On a remove, either 404 means the server does not have this track, so the
    // row goes. On an add, the only 404 is the asset.
    if (op === 'remove') {
      return { kind: 'gone', message: TRACKS_COPY.errTrackGone, forbidden: false, retire: true };
    }
    return { kind: 'asset-gone', message: TRACKS_COPY.errAssetGone, forbidden: false, retire: false };
  }
  if (e.status === 400) {
    // apiFetch already prefers the body's human `message` over its machine
    // `error` code (public/app.js:296-303), so e.message is the server's own
    // sentence when it sent one.
    const detail = typeof e.message === 'string' && e.message !== '' ? e.message : 'HTTP 400';
    return { kind: 'invalid', message: prefix + detail, forbidden: false, retire: false };
  }
  if (typeof e.status === 'number') {
    const detail = typeof e.message === 'string' && e.message !== '' ? e.message : 'HTTP ' + e.status;
    return { kind: 'other', message: prefix + detail, forbidden: false, retire: false };
  }
  // No status at all: the request never got an answer (offline, DNS, abort).
  return { kind: 'network', message: TRACKS_COPY.errNetwork, forbidden: false, retire: false };
}

/**
 * The on-screen subtitle list after a successful add.
 *
 * Appends the track the 201 RETURNED — which is the object the handler persisted
 * (built src/routes/assets.ts:5698-5707, written :5709, sent :5710) — at the end,
 * matching the server's own append (`[...(asset.subtitleTracks ?? []), track]`,
 * :5708). Not an optimistic patch: it is the server's answer, placed where the
 * server put it.
 *
 * A malformed 201 (no `track` object) leaves the list untouched rather than
 * pushing a placeholder row.
 *
 * @param {object[]} list
 * @param {object} created  the 201 body's `track`
 * @returns {object[]} a new array
 */
export function appendSubtitleTrack(list, created) {
  const base = Array.isArray(list) ? list.slice() : [];
  if (!created || typeof created !== 'object') return base;
  base.push(created);
  return base;
}

/**
 * The on-screen subtitle list after a successful (or 404'd) remove: the same
 * `filter` on `id` the handler applies (src/routes/assets.ts:5733).
 *
 * @param {object[]} list
 * @param {string} trackId
 * @returns {object[]} a new array
 */
export function removeSubtitleTrackById(list, trackId) {
  if (!Array.isArray(list)) return [];
  return list.filter(function (t) {
    return !t || typeof t !== 'object' ? true : t.id !== trackId;
  });
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
 * the UI, or `{ text, badge: true }` for the "Default" flag, or
 * `{ node }` to place an already-built element (the per-row Remove control,
 * #940) — which is the ONLY way a node gets in, so no caller can hand this
 * function a markup string to parse.
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
        td.className = 'cell-action';
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
 * One row's Remove control (issue #940).
 *
 * The visible word is "Remove" — short enough to fit a table cell — while the
 * accessible name carries which track it removes, so a screen-reader user
 * tabbing the column does not meet six identically-named buttons (WCAG 2.4.6).
 * The accessible name STARTS with the visible text, so speech input still
 * matches it (WCAG 2.5.3 Label in Name).
 *
 * The track id rides on a data attribute rather than in the name: it is the
 * value the DELETE path needs and means nothing to a reader.
 */
function renderRemoveButton(track) {
  const btn = el('button', 'btn-sm btn-danger subtitle-remove', TRACKS_COPY.btnRemove);
  btn.type = 'button';
  btn.setAttribute('data-track-id', typeof track.id === 'string' ? track.id : '');
  btn.setAttribute(
    'aria-label',
    TRACKS_COPY.btnRemove + ' subtitle track ' + subtitleTrackSubject(track)
  );
  return btn;
}

/**
 * The add form (issue #940). PURE: builds controls and attaches NO listener —
 * the mount wires submit, so `renderTracksBlock` stays side-effect free.
 *
 * Asks for exactly the four properties `addSubtitleTrackSchema` declares
 * (src/routes/assets.ts:834-839) and nothing else, since the schema is
 * `additionalProperties: false`. Required fields are marked `required` AND named
 * as required in their help text, so the requirement is not conveyed by styling
 * alone.
 *
 * A real `<form>`, so Enter submits from any field — this is an operator tool
 * and the add is a four-field form, not a toolbar button.
 */
function renderAddForm() {
  const form = document.createElement('form');
  form.className = 'subtitle-add-form mt12';
  form.id = 'subtitle-add-form';
  // `novalidate` with `required` still set on the two required fields: the
  // attributes carry the requirement to assistive technology, but the browser's
  // own bubble is suppressed so EVERY refusal — client-side or from the API —
  // lands in the same live region, in the same words. Two different refusal
  // surfaces for one form would be the worse outcome.
  // No action/method either: there is nowhere to navigate, and the mount calls
  // preventDefault on submit.
  form.setAttribute('novalidate', 'novalidate');

  const legendWrap = el('div', 'tracks-group-title', TRACKS_COPY.addHeading);
  form.appendChild(legendWrap);
  form.appendChild(el('div', 'tracks-note', TRACKS_COPY.addIntro));

  const row = el('div', 'form-row mt12');

  // Language — required, free-form (BCP-47 string, not an enum).
  const langField = el('div', 'form-field');
  const langLabel = el('label', null, TRACKS_COPY.fieldLanguage);
  langLabel.setAttribute('for', 'subtitle-add-language');
  const langInput = document.createElement('input');
  langInput.type = 'text';
  langInput.id = 'subtitle-add-language';
  langInput.name = 'language';
  langInput.required = true;
  langInput.maxLength = SUBTITLE_LANGUAGE_MAX;
  langInput.autocomplete = 'off';
  const langHelp = el('div', 'text-muted tracks-note', TRACKS_COPY.helpLanguage);
  langHelp.id = 'subtitle-add-language-help';
  langInput.setAttribute('aria-describedby', langHelp.id);
  langField.appendChild(langLabel);
  langField.appendChild(langInput);
  langField.appendChild(langHelp);
  row.appendChild(langField);

  // Format — required, exactly the enum.
  const fmtField = el('div', 'form-field');
  const fmtLabel = el('label', null, TRACKS_COPY.fieldFormat);
  fmtLabel.setAttribute('for', 'subtitle-add-format');
  const fmtSelect = document.createElement('select');
  fmtSelect.id = 'subtitle-add-format';
  fmtSelect.name = 'format';
  fmtSelect.required = true;
  SUBTITLE_FORMATS.forEach(function (fmt) {
    const opt = document.createElement('option');
    opt.value = fmt;
    opt.textContent = fmt;
    fmtSelect.appendChild(opt);
  });
  const fmtHelp = el('div', 'text-muted tracks-note', TRACKS_COPY.helpFormat);
  fmtHelp.id = 'subtitle-add-format-help';
  fmtSelect.setAttribute('aria-describedby', fmtHelp.id);
  fmtField.appendChild(fmtLabel);
  fmtField.appendChild(fmtSelect);
  fmtField.appendChild(fmtHelp);
  row.appendChild(fmtField);

  // Label — optional. Blank is OMITTED from the body, never sent as ''.
  const labField = el('div', 'form-field grow');
  const labLabel = el('label', null, TRACKS_COPY.fieldLabel);
  labLabel.setAttribute('for', 'subtitle-add-label');
  const labInput = document.createElement('input');
  labInput.type = 'text';
  labInput.id = 'subtitle-add-label';
  labInput.name = 'label';
  labInput.maxLength = SUBTITLE_LABEL_MAX;
  labInput.autocomplete = 'off';
  const labHelp = el('div', 'text-muted tracks-note', TRACKS_COPY.helpLabel);
  labHelp.id = 'subtitle-add-label-help';
  labInput.setAttribute('aria-describedby', labHelp.id);
  labField.appendChild(labLabel);
  labField.appendChild(labInput);
  labField.appendChild(labHelp);
  row.appendChild(labField);

  form.appendChild(row);

  // Default — optional, and NOT exclusive in the contract.
  const defField = el('div', 'form-field mt12');
  const defWrap = el('label', 'subtitle-add-default-label');
  defWrap.setAttribute('for', 'subtitle-add-default');
  const defInput = document.createElement('input');
  defInput.type = 'checkbox';
  defInput.id = 'subtitle-add-default';
  defInput.name = 'default';
  const defHelp = el('div', 'text-muted tracks-note', TRACKS_COPY.addDefaultNote);
  defHelp.id = 'subtitle-add-default-help';
  defInput.setAttribute('aria-describedby', defHelp.id);
  defWrap.appendChild(defInput);
  defWrap.appendChild(el('span', null, ' ' + TRACKS_COPY.fieldDefault));
  defField.appendChild(defWrap);
  defField.appendChild(defHelp);
  form.appendChild(defField);

  const submitBtn = el('button', 'btn-sm mt12', TRACKS_COPY.btnAdd);
  submitBtn.type = 'submit';
  submitBtn.id = 'subtitle-add-submit';
  form.appendChild(submitBtn);

  // Says what the add does NOT do: it registers a track, it does not upload a
  // subtitle file (see CONTRACT GROUNDING on `uploadUrl`).
  form.appendChild(el('div', 'tracks-note', TRACKS_COPY.addFileNote));

  return {
    form: form,
    languageInput: langInput,
    formatSelect: fmtSelect,
    labelInput: labInput,
    defaultInput: defInput,
    submitBtn: submitBtn,
    fields: { language: langInput, format: fmtSelect, label: labInput },
  };
}

/**
 * The subtitle section: the list, then — when the write controls are on — the
 * per-row Remove buttons, the inline message area and the add form.
 *
 * `controls` is `{ canChange: boolean, canRemove: boolean }` or null/undefined
 * for the #902 read-only rendering. When it is absent NOTHING here creates a
 * control, so the module's read-only contract is unchanged for any caller that
 * does not opt in. `canRemove: false` suppresses the Remove column entirely —
 * including its header — rather than leaving an empty column: the mount sets it
 * when it has no confirmation dialog to gate the destructive call with, and a
 * header over nothing would advertise an action that is not on offer.
 *
 * The message area sits BETWEEN the table and the add form — i.e. next to both
 * controls it reports on — because #940 requires a refusal to land near the
 * control that caused it, not in a page-level toast the operator has to go
 * looking for. It is a live region, so the outcome is announced rather than only
 * drawn.
 */
function appendSubtitleSection(block, subtitles, controls) {
  const writable = !!controls;
  const canChange = writable && controls.canChange !== false;
  const canRemove = canChange && controls.canRemove !== false;
  const handles = { removeButtons: [], add: null, msgHost: null };

  block.appendChild(renderSectionTitle(TRACKS_COPY.subtitleHeading, subtitles.length));

  if (subtitles.length === 0) {
    block.appendChild(
      renderEmpty('subtitle-tracks', TRACKS_COPY.subtitleEmpty, TRACKS_COPY.subtitleEmptyDetail)
    );
  } else {
    const columns = ['Language', 'Label', 'Format', 'Default', 'Object key', 'Track ID'];
    if (canRemove) columns.push(TRACKS_COPY.colRemove);

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
      if (canRemove) {
        // A track the server sent without an `id` cannot be addressed by the
        // DELETE path (`/{trackId}` is required), so it gets no control rather
        // than a button that would build a 404 URL.
        if (typeof t.id === 'string' && t.id !== '') {
          const btn = renderRemoveButton(t);
          handles.removeButtons.push(btn);
          cells.push({ node: btn });
        } else {
          cells.push(TRACKS_COPY.absent);
        }
      }
      return cells;
    });

    block.appendChild(renderTable('Subtitle tracks', columns, rows));
  }

  if (!writable) return handles;

  // Inline outcome area for BOTH controls, before the form so it is adjacent to
  // the table above and the submit below.
  const msgHost = el('div', 'subtitle-track-msg');
  msgHost.id = 'subtitle-track-msg';
  msgHost.setAttribute('role', 'status');
  msgHost.setAttribute('aria-live', 'polite');
  block.appendChild(msgHost);
  handles.msgHost = msgHost;

  if (!canChange) {
    // Say why the controls are missing instead of leaving a role with no
    // explanation for an absence (the review block's rule).
    block.appendChild(el('div', 'tracks-note', TRACKS_COPY.roleNote));
    return handles;
  }

  const add = renderAddForm();
  block.appendChild(add.form);
  handles.add = add;
  return handles;
}

// ─── Block ───────────────────────────────────────────────────────────────────

/**
 * Build the whole block for one asset read. PURE: no fetch, no listeners.
 *
 * `data.subtitleControls` opts the subtitle section into the #940 write
 * controls. Omit it and the block is byte-for-byte the #902 read-only rendering:
 * no form, no buttons, no message region. Controls are BUILT here but never
 * WIRED here — the mount attaches every listener — so this function stays
 * side-effect free and directly testable.
 *
 * The built controls are exposed on `block.subtitleControls` (a property on the
 * returned element) so the mount can wire them without re-querying the DOM,
 * while the return value stays the single element every existing caller expects.
 *
 * @param {object} data
 * @param {object[]} data.video            from `videoTracksFromAsset`
 * @param {object[]} data.audioEditorial   `asset.audioTracks`
 * @param {object[]} data.audioProbed      from `probedAudioStreamsFromAsset`
 * @param {object[]} data.subtitles        `asset.subtitleTracks`
 * @param {string}   [data.extractionError] `asset.technicalMetadataError`
 * @param {{canChange?: boolean, canRemove?: boolean}} [data.subtitleControls]
 *        opt in to the add form / remove controls
 * @returns {HTMLElement}
 */
export function renderTracksBlock(data) {
  const d = data || {};
  const video = Array.isArray(d.video) ? d.video : [];
  const audioEditorial = Array.isArray(d.audioEditorial) ? d.audioEditorial : [];
  const audioProbed = Array.isArray(d.audioProbed) ? d.audioProbed : [];
  const subtitles = Array.isArray(d.subtitles) ? d.subtitles : [];
  const controls = d.subtitleControls || null;

  const block = el('div', 'mt12 tracks-block');
  block.id = 'asset-tracks';
  block.appendChild(el('div', 'section-title', TRACKS_COPY.heading));
  // The intro must not claim the block is read-only once part of it is not.
  block.appendChild(
    el(
      'div',
      'tracks-note',
      controls && controls.canChange !== false
        ? TRACKS_COPY.introWritableSubtitles
        : TRACKS_COPY.intro
    )
  );

  appendVideoSection(block, video, d.extractionError);
  appendAudioSection(block, audioEditorial, audioProbed);
  const subtitleHandles = appendSubtitleSection(block, subtitles, controls);
  block.subtitleControls = subtitleHandles;

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
 * It DOES call on operator action, once #940's controls are enabled: one POST
 * per add, one DELETE per remove, and nothing else — no re-read afterwards,
 * because the 201 carries the persisted track and the 204 means it is gone.
 *
 * SUBTITLE WRITES ARE OPT-IN. They are wired only when `apiFetch` and `assetId`
 * are both supplied. Without them this returns exactly what #902 returned:
 * a read-only block with no controls and no listeners.
 *
 * The block is inserted before `anchorEl` when given, else appended to `host`.
 *
 * @param {object} opts
 * @param {object}      opts.asset      the `GET /assets/{id}` 200 body already
 *                                      rendered by the caller
 * @param {HTMLElement} [opts.host]     container to append to
 * @param {HTMLElement} [opts.anchorEl] element to insert before, inside its parent
 * @param {string}      [opts.assetId]  the ULID for the sub-resource paths. Sub-
 *                                      resource routes take `params.id` straight
 *                                      to `repo.get` and do NOT resolve a slug,
 *                                      so this must be `asset.id` even when the
 *                                      pane was opened by slug.
 * @param {Function}    [opts.apiFetch] the house client; enables the controls
 * @param {boolean}     [opts.canChange] client-side mirror of the ADR-018 matrix
 *                                      (editor|admin may write). Default true.
 * @param {Function}    [opts.confirmModal] the house confirmation dialog. REQUIRED
 *                                      for the remove control: without it no
 *                                      remove button is offered at all, because
 *                                      #940 mandates a confirmation step and a
 *                                      destructive call must never fall back to
 *                                      going ahead unconfirmed.
 * @param {Function}    [opts.showMsg]  house message renderer (host, text, kind)
 * @param {(subtitleTracks: object[]) => any} [opts.onTracksChanged] called with
 *        the new subtitle list after each successful write, so the caller can
 *        keep its own copy of the asset in step without re-reading.
 * @returns {{ block: HTMLElement, update: (asset: object) => void }}
 */
export function mountAssetTracks(opts) {
  const o = opts || {};
  const apiFetch = typeof o.apiFetch === 'function' ? o.apiFetch : null;
  const assetId = o.assetId == null ? '' : String(o.assetId);
  // Both are needed to build a call at all: no client, or no id for the path,
  // means no control is offered rather than one that cannot fire.
  const writable = !!(apiFetch && assetId !== '');
  const canChange = o.canChange !== false;
  const confirmFn = typeof o.confirmModal === 'function' ? o.confirmModal : null;

  const basePath = '/assets/' + encodeURIComponent(assetId) + '/subtitle-tracks';

  let rendered = null;
  // The subtitle list currently on screen. Seeded from the asset read and then
  // advanced ONLY by a server answer (the 201's track, or a 204/404 for a
  // removal) — never by a local guess.
  let subtitles = [];
  // Set when a 403 proves this client may not write: the controls come off for
  // the rest of this view of the asset rather than inviting a second refusal.
  let retired = false;

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
   * Write one outcome into the subtitle section's own live region — next to the
   * controls, never as a page-level toast somewhere else (#940 AC3).
   */
  function report(text, kind) {
    const handles = rendered && rendered.subtitleControls;
    const host = handles && handles.msgHost;
    if (!host) return;
    // One message at a time: a stale "Added…" sitting above a fresh failure
    // reads as if both happened.
    host.textContent = '';
    if (typeof o.showMsg === 'function') {
      o.showMsg(host, text, kind || 'error');
      return;
    }
    host.appendChild(el('div', 'msg msg-' + (kind || 'error'), text));
  }

  /**
   * Mark a field as the one the refusal is about, for assistive technology as
   * well as sighted use, and move focus there so the fix is one keystroke away.
   *
   * `markInvalid(null)` clears the marking on every field — called at the start
   * of each attempt, so a mark left over from the PREVIOUS refusal cannot sit on
   * a field that is now fine.
   */
  function markInvalid(field) {
    const handles = rendered && rendered.subtitleControls;
    if (!handles || !handles.add) return;
    const fields = handles.add.fields;
    Object.keys(fields).forEach(function (name) {
      if (field && name === field) fields[name].setAttribute('aria-invalid', 'true');
      else fields[name].removeAttribute('aria-invalid');
    });
    if (field && fields[field] && typeof fields[field].focus === 'function') {
      fields[field].focus();
    }
  }

  /**
   * Put keyboard focus somewhere real after a write re-rendered the section.
   *
   * A successful add or remove replaces the whole block, which destroys the
   * control the operator was standing on — and a destroyed focused element drops
   * focus to `document.body`, losing a keyboard user's place entirely
   * (WCAG 2.4.3). So focus is moved explicitly, to the nearest thing that makes
   * the NEXT action possible:
   *   after an add    — the fresh Language field, ready for another track;
   *   after a remove  — the Remove control that took the row's place (or the one
   *                     above it when the last row went), else the add form.
   * Never a no-op: if the section has no control left at all (a 403 retirement),
   * the live region has the message and there is nothing to focus.
   */
  function restoreFocus(intent, removedIndex) {
    const handles = rendered && rendered.subtitleControls;
    if (!handles) return;
    let target = null;
    if (intent === 'remove' && handles.removeButtons.length > 0) {
      const i = Math.min(removedIndex, handles.removeButtons.length - 1);
      target = handles.removeButtons[Math.max(i, 0)];
    }
    if (!target && handles.add) target = handles.add.languageInput;
    if (target && typeof target.focus === 'function') target.focus();
  }

  /** Re-render the block from the current subtitle list, then wire the controls. */
  function draw(asset) {
    const a = asset || {};
    const next = renderTracksBlock({
      video: videoTracksFromAsset(a),
      audioEditorial: editorialTracksFromAsset(a).audioTracks,
      audioProbed: probedAudioStreamsFromAsset(a),
      // The panel's own list, not the asset's: after a write the asset body the
      // caller handed us is out of date and the write's response is not.
      subtitles: subtitles,
      extractionError: a.technicalMetadataError,
      // A retirement withdraws the CONTROLS, not the section's message region:
      // the 403 that caused it is the one thing that still has to be said, and
      // dropping the region with the buttons would turn the refusal into the
      // silent no-op #940 exists to prevent. So `canChange: false` — the same
      // rendering a read-only role gets, message area and explanation included.
      subtitleControls: writable
        ? { canChange: canChange && !retired, canRemove: !!confirmFn }
        : null,
    });
    place(next);
    rendered = next;
    wire(a);
  }

  function wire(asset) {
    const handles = rendered && rendered.subtitleControls;
    if (!handles) return;

    // Remove: confirm first, then DELETE. With no confirmation primitive the
    // column was never rendered (`canRemove: false`), so this list is empty —
    // the destructive call has no unconfirmed path to reach.
    handles.removeButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        void removeTrack(btn.getAttribute('data-track-id'), btn, asset);
      });
    });

    if (handles.add) {
      handles.add.form.addEventListener('submit', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        void addTrack(handles.add, asset);
      });
    }
  }

  async function addTrack(add, asset) {
    // Start each attempt from a clean slate: a mark from the last refusal must
    // not linger on a field the operator has since fixed.
    markInvalid(null);
    const built = buildAddSubtitleBody({
      language: add.languageInput.value,
      format: add.formatSelect.value,
      label: add.labelInput.value,
      default: add.defaultInput.checked === true,
    });
    if (!built.ok) {
      // A client-side refusal is still a refusal shown at the control — and it
      // keeps what the operator typed.
      report(built.message, 'error');
      markInvalid(built.field);
      return;
    }

    const label = add.submitBtn.textContent;
    add.submitBtn.disabled = true;
    add.submitBtn.textContent = TRACKS_COPY.btnAdding;
    try {
      // Exactly the declared properties; `additionalProperties: false` means an
      // extra key would be a 400.
      const created = await apiFetch(basePath, {
        method: 'POST',
        body: JSON.stringify(built.body),
      });
      const track = created && typeof created === 'object' ? created.track : null;
      subtitles = appendSubtitleTrack(subtitles, track);
      draw(asset);
      if (typeof o.onTracksChanged === 'function') o.onTracksChanged(subtitles.slice());
      report(TRACKS_COPY.addedPrefix + subtitleTrackSubject(track) + '.', 'success');
      restoreFocus('add');
    } catch (err) {
      const c = classifySubtitleWriteError(err, 'add');
      if (c.forbidden) {
        retired = true;
        draw(asset);
      } else {
        add.submitBtn.disabled = false;
        add.submitBtn.textContent = label;
      }
      report(c.message, 'error');
    }
  }

  async function removeTrack(trackId, btn, asset) {
    const track = subtitles.filter(function (t) {
      return t && t.id === trackId;
    })[0];
    if (!trackId || !track) {
      // The row went away under the click (a parallel add/remove re-rendered the
      // table). Nothing is sent on a guess.
      report(TRACKS_COPY.errTrackGone, 'error');
      return;
    }

    // Where this row sits, so focus can land on its replacement after the
    // re-render rather than falling to the document.
    const rowIndex = subtitles.indexOf(track);

    // The confirmation step #940 requires, before anything is sent.
    const ok = await confirmFn(removeSubtitleConfirmSpec(track));
    if (!ok) return;

    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = TRACKS_COPY.btnRemoving;
    try {
      // No body and no query params on this operation (see CONTRACT GROUNDING).
      await apiFetch(basePath + '/' + encodeURIComponent(trackId), { method: 'DELETE' });
      subtitles = removeSubtitleTrackById(subtitles, trackId);
      draw(asset);
      if (typeof o.onTracksChanged === 'function') o.onTracksChanged(subtitles.slice());
      report(TRACKS_COPY.removedPrefix + subtitleTrackSubject(track) + '.', 'success');
      restoreFocus('remove', rowIndex);
    } catch (err) {
      const c = classifySubtitleWriteError(err, 'remove');
      if (c.retire) {
        // A 404 means the server does not have this track, under either reading
        // of the status — so the row goes, and the message says why.
        subtitles = removeSubtitleTrackById(subtitles, trackId);
        draw(asset);
        if (typeof o.onTracksChanged === 'function') o.onTracksChanged(subtitles.slice());
        restoreFocus('remove', rowIndex);
      } else if (c.forbidden) {
        retired = true;
        draw(asset);
      } else if (btn.parentNode) {
        btn.disabled = false;
        btn.textContent = label;
      }
      report(c.message, 'error');
    }
  }

  /**
   * Re-render from a freshly read asset body, in place. The subtitle list is
   * RESEEDED from that body — the caller has just re-read the asset, so its copy
   * supersedes anything this panel was holding.
   */
  function update(asset) {
    subtitles = editorialTracksFromAsset(asset || {}).subtitleTracks;
    draw(asset);
  }

  update(o.asset);
  return {
    get block() {
      return rendered;
    },
    update: update,
  };
}
