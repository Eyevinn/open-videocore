/**
 * open-videocore ops dashboard — tracks-panel.js
 *
 * The read-only "Tracks" block on the asset detail view (issue #902, broken out
 * of #794): one section per track kind — video, audio, subtitle — each listing
 * only the attributes the API actually exposes for that kind, and each with an
 * explicit empty state when the asset has none.
 *
 * READ-ONLY by construction. This module creates no form controls and issues no
 * POST/DELETE, so the add/remove routes that do exist
 * (`POST|DELETE /assets/{id}/audio-tracks`, `…/subtitle-tracks`) have nothing
 * here to originate from. It also issues no GET: every value it renders is
 * already in the `GET /assets/{id}` body the detail view fetched, so the panel
 * adds no round-trip to the render.
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
 * the UI, or `{ text, badge: true }` for the "Default" flag.
 *
 * @param {string} caption
 * @param {string[]} columns
 * @param {(string|{text: string, mono?: boolean, badge?: boolean})[][]} rows
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
      if (spec.badge) {
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

  const block = el('div', 'mt12 tracks-block');
  block.id = 'asset-tracks';
  block.appendChild(el('div', 'section-title', TRACKS_COPY.heading));
  block.appendChild(el('div', 'tracks-note', TRACKS_COPY.intro));

  appendVideoSection(block, video, d.extractionError);
  appendAudioSection(block, audioEditorial, audioProbed);
  appendSubtitleSection(block, subtitles);

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
 * @param {object} opts
 * @param {object}      opts.asset      the `GET /assets/{id}` 200 body already
 *                                      rendered by the caller
 * @param {HTMLElement} [opts.host]     container to append to
 * @param {HTMLElement} [opts.anchorEl] element to insert before, inside its parent
 * @returns {{ block: HTMLElement, update: (asset: object) => void }}
 */
export function mountAssetTracks(opts) {
  const o = opts || {};

  let rendered = null;

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

  /** Re-render from a freshly read asset body, in place. */
  function update(asset) {
    const a = asset || {};
    const editorial = editorialTracksFromAsset(a);
    const next = renderTracksBlock({
      video: videoTracksFromAsset(a),
      audioEditorial: editorial.audioTracks,
      audioProbed: probedAudioStreamsFromAsset(a),
      subtitles: editorial.subtitleTracks,
      extractionError: a.technicalMetadataError,
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
