// @vitest-environment happy-dom
//
// Read-only tracks panel on the asset detail view (issue #902, broken out of
// #794): video, audio and subtitle tracks each listed in their own section with
// the attributes the API actually exposes for that kind, and an explicit empty
// state for a kind with zero tracks.
//
// The integration block drives the REAL detail renderer (renderAssetDetailBody —
// the same code path used by the asset side panel and the detached detail window)
// against a stubbed fetch.
//
// CONTRACT GROUNDING — every path, field and status below was read from this
// repo's generated spec and route source before the tests were written
// (CLAUDE.md rule 7), never from the issue text. `openapi.json` declares no
// `operationId` anywhere, so operations are named by path + method:
//
//   ONE READ FEEDS THE WHOLE PANEL —
//   openapi.json .paths["/api/v1/assets/{id}"].get, 200 schema. It carries the
//   editorial tracks AND the probe output, so the panel needs no call of its own.
//
//   EDITORIAL AUDIO + SUBTITLE — `audioTracks` / `subtitleTracks` on that body.
//     audioTracks[]:    { id, language, codec?, channels?, label?, default? },
//                       required ["id","language"], additionalProperties: false.
//     subtitleTracks[]: { id, language, format: "vtt"|"srt"|"ttml",
//                       objectKey?, label?, default? },
//                       required ["id","language","format"],
//                       additionalProperties: false.
//     Neither property is in the 200 schema's `required` list:
//     `audioTracks: z.array(audioTrackOutSchema).optional()`
//     (src/routes/assets.ts:907) and
//     `subtitleTracks: z.array(subtitleTrackOutSchema).optional()` (:908),
//     audioTrackOutSchema :795-802, subtitleTrackOutSchema :806-813,
//     SUBTITLE_FORMATS src/data/asset-repo.ts:449.
//     ABSENT MEANS NONE: the arrays are "absent until the first track of the
//     respective kind is added" (:905-906); persistence writes the block only
//     when non-empty (src/data/asset-document.ts:553-557) and reads it straight
//     back (:693-694). So an omitted array renders the kind's EMPTY state.
//
//   GET /api/v1/assets/{id}/tracks exists (the ONLY key on that path is `get`)
//     but is NOT a second source: its handler returns
//     `asset.audioTracks ?? []` / `asset.subtitleTracks ?? []` from the same
//     document (src/routes/assets.ts:5268-5271, `repo.get(request.params.id)` at
//     :5264). A caller holding the asset would be paying a round-trip for bytes
//     it has, so the panel does not call it — asserted below.
//
//   There is NO GET on /api/v1/assets/{id}/audio-tracks or …/subtitle-tracks —
//     those paths carry only `post`, and …/{trackId} only `delete`
//     (src/routes/assets.ts:5279, 5314, 5344, 5392).
//
//   VIDEO — no path in openapi.json contains "video" and no response schema
//     carries a video-track array. The only video attributes exposed anywhere are
//     on `technicalMetadata` (GET /api/v1/assets/{id} 200 schema, nullable object,
//     NOT in `required`): { codec, width, height, durationSeconds, bitrateBps,
//     containerFormat, audioTracks[], extractedAt }, all eight required,
//     additionalProperties: false (src/routes/assets.ts:884, schema :752-762,
//     with technicalMetadataError :885).
//     The four that are TRACK-level are exactly the tuple the persistence layer
//     writes into the document's video track array —
//     `technical.video = [{ codec, width, height, bitrateBps }]`
//     (src/data/asset-document.ts:402-404), read back as `technical.video?.[0]`
//     (:422) — so the API can report at most ONE video track per asset.
//     `frameRate` / `index` exist on the stored VideoTrackSchema
//     (src/data/asset-document.ts:51-58) but no response exposes them.
//
//   AUDIO, AS PROBED — technicalMetadata.audioTracks[]:
//     { index, codec, channels, sampleRateHz }, all four required,
//     additionalProperties: false (audioTrackSchema, src/routes/assets.ts:745-750).
//     A DIFFERENT record set from the editorial audioTracks: no shared field, no
//     shared id, so the panel lists them as two separately-counted groups and
//     never publishes their sum.
//
// ─────────────────────────────────────────────────────────────────────────────
// SUBTITLE ADD/REMOVE CONTROLS (issue #904) — CONTRACT GROUNDING
//
// Fetched from this repo's generated spec and route source before these tests
// were written (CLAUDE.md rule 7), never from the issue text. The spec itself is
// re-read at run time in "contract anchor" below, so a drift between the panel
// and the published contract fails here rather than in a browser.
//
//   ADD — POST /api/v1/assets/{id}/subtitle-tracks
//     openapi.json .paths["/api/v1/assets/{id}/subtitle-tracks"].post
//     (no operationId is declared anywhere in this spec);
//     handler src/routes/assets.ts:5390-5432.
//     Body REQUIRED, additionalProperties: false — exactly
//       { language: string 1..64 (required),
//         format: "vtt"|"srt"|"ttml" (required),
//         label?: string 1..128, default?: boolean }
//     (`addSubtitleTrackSchema`, src/routes/assets.ts:829-834, over
//      `subtitleFormatSchema` :808 / SUBTITLE_FORMATS src/data/asset-repo.ts:449).
//     The id is server-generated (`randomUUID()` :5408) and the objectKey is
//     derived by the route (:5411), so neither is accepted from a client.
//     201 → { track, uploadUrl? } (:5398) — the ONE new track
//     (`subtitleTrackOutSchema` :810-817), NOT the resulting list. `uploadUrl` is
//     a presigned PUT (:5413-5416) and is credential-bearing, so it is never
//     rendered. 404 → { error, message? } for an unknown asset.
//     APPEND-ONLY: the handler spreads and pushes (:5428) and never clears
//     `default` on the other tracks, so two default tracks are reachable.
//
//   REMOVE — DELETE /api/v1/assets/{id}/subtitle-tracks/{trackId}
//     handler src/routes/assets.ts:5438-5460. Two path params (:5443), no body
//     and no query parameter. 204 → empty (`z.null()` :5444), so the resulting
//     list must be re-read. 404 → { error, message } for an unknown asset AND
//     for an unknown track id (:5450, :5455) — not machine-distinguishable.
//     The stored object survives: the handler filters the list (:5453) and
//     patches `subtitleTracks` alone (:5457, src/data/couch-asset-repo.ts:416-417),
//     and says so in its own comment (:5434-5435).
//
//   REFRESH — GET /api/v1/assets/{id}/tracks → 200 { audioTracks, subtitleTracks },
//     both required (`tracksSchema` :836-839; handler :5301-5320, repo.get at
//     :5311). The panel refuses this read at RENDER time (it already holds the
//     bytes) and needs it after a WRITE, when neither 201 nor 204 carries the
//     list.
//
//   AUTHORISATION — editor|admin only: MATRIX (src/auth/authorize.ts:54-58) gives
//     write+delete to editor and admin and neither to viewer; methodToAction
//     (:79-93) maps POST→write and DELETE→delete; both routes sit under the
//     assets router's authGate (src/routes/assets.ts:1738) and
//     resourceAuthorizationPreHandler('asset') (:1748). Refusal is 403
//     `forbidden_insufficient_role` (src/auth/authorize.ts:99). The client flag
//     is a mirror, so a 403 that arrives anyway is still asserted below.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderAssetDetailBody } from '../public/app.js';
import {
  SUBTITLE_FORMATS,
  TRACKS_COPY,
  attr,
  bitrateLabel,
  classifySubtitleTrackError,
  editorialTracksFromAsset,
  mountAssetTracks,
  probedAudioStreamsFromAsset,
  renderTracksBlock,
  resolutionLabel,
  sampleRateLabel,
  subtitleAddBody,
  subtitleRemoveConfirmSpec,
  subtitleTrackName,
  videoTracksFromAsset,
} from '../public/tracks-panel.js';

const ULID = '01J9AAAAAAAAAAAAAAAAAAAAAA';

// A probed asset: one video stream's attributes plus two audio streams, exactly
// as technicalMetadataSchema declares them.
const TECHNICAL = {
  codec: 'h264',
  width: 1920,
  height: 1080,
  durationSeconds: 92.5,
  bitrateBps: 5_000_000,
  containerFormat: 'mov',
  audioTracks: [
    { index: 1, codec: 'aac', channels: 2, sampleRateHz: 48000 },
    { index: 2, codec: 'aac', channels: 6, sampleRateHz: 48000 },
  ],
  extractedAt: '2026-09-21T09:00:00.000Z',
};

// Editorial tracks, with and without the optional fields, per the assetSchema
// item schemas. `sv` carries every optional field; `fi` carries only the
// required ones.
const EDITORIAL_AUDIO = [
  { id: 'aud-1', language: 'sv', codec: 'aac', channels: 2, label: 'Swedish 2.0', default: true },
  { id: 'aud-2', language: 'fi' },
];

const EDITORIAL_SUBTITLES = [
  {
    id: 'sub-1',
    language: 'sv',
    format: 'vtt',
    objectKey: 'ws/subtitles/' + ULID + '/sub-1.vtt',
    label: 'Swedish',
    default: true,
  },
  { id: 'sub-2', language: 'en', format: 'srt' },
];

const ASSET = {
  id: ULID,
  name: 'trailer-master.mov',
  status: 'ready',
  reviewState: 'draft',
  statusHistory: [{ at: '2026-09-21T08:00:00.000Z', from: null, to: 'ready' }],
  technicalMetadata: TECHNICAL,
  audioTracks: EDITORIAL_AUDIO,
  subtitleTracks: EDITORIAL_SUBTITLES,
  createdAt: '2026-09-21T08:00:00.000Z',
  updatedAt: '2026-09-21T09:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Route by path. Every asset read serves `asset`. */
function routedFetch(asset: object = ASSET) {
  return vi.fn(async (url: string) => {
    const path = String(url);
    if (/\/tracks$/.test(path)) {
      // Nothing should reach this: the panel reads the arrays off the asset.
      return json({ audioTracks: [], subtitleTracks: [] });
    }
    if (/\/review-state$/.test(path)) {
      return json({ reviewState: 'draft', allowedTransitions: ['in-review'] });
    }
    if (/\/lock$/.test(path)) return json(asset);
    if (/\/delivery$/.test(path)) return json({ urls: {} });
    if (/\/executions$/.test(path)) return json([]);
    if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
    if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
    if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) return json(asset);
    return json({}, 200);
  });
}

async function settle(ticks = 30) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Text of one section, from its heading up to the next `.section-title`. */
function sectionText(root: ParentNode, heading: string): string {
  const block = root.querySelector('#asset-tracks');
  if (!block) return '';
  const nodes = Array.from(block.children);
  const start = nodes.findIndex(
    (n) => n.classList.contains('section-title') && (n.textContent || '').startsWith(heading)
  );
  if (start === -1) return '';
  const out: string[] = [];
  for (let i = start; i < nodes.length; i++) {
    if (i > start && nodes[i].classList.contains('section-title')) break;
    out.push(nodes[i].textContent || '');
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Rows of the nth table inside the block, as arrays of cell text. */
function tableRows(root: ParentNode, nth: number): string[][] {
  const block = root.querySelector('#asset-tracks')!;
  const table = block.querySelectorAll('table')[nth];
  if (!table) return [];
  return Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())
  );
}

function headerCells(root: ParentNode, nth: number): string[] {
  const block = root.querySelector('#asset-tracks')!;
  const table = block.querySelectorAll('table')[nth];
  return Array.from(table.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('editorial tracks, read off the asset body', () => {
  it('takes both arrays verbatim, preserving server order', () => {
    const r = editorialTracksFromAsset(ASSET);
    expect(r.audioTracks.map((t: any) => t.id)).toEqual(['aud-1', 'aud-2']);
    expect(r.subtitleTracks.map((t: any) => t.id)).toEqual(['sub-1', 'sub-2']);
  });

  it('treats an ABSENT array as "none", because the schema says so', () => {
    // `audioTracks` / `subtitleTracks` are `.optional()` on assetSchema
    // (src/routes/assets.ts:907-908) and absent until the first track of that
    // kind is added (:905-906) — so omitted is empty, not unknown.
    const r = editorialTracksFromAsset({ id: ULID });
    expect(r.audioTracks).toEqual([]);
    expect(r.subtitleTracks).toEqual([]);
  });

  it('survives a malformed or missing body without inventing tracks', () => {
    expect(editorialTracksFromAsset({ audioTracks: {}, subtitleTracks: 7 } as any)).toEqual({
      audioTracks: [],
      subtitleTracks: [],
    });
    expect(editorialTracksFromAsset(null as any)).toEqual({ audioTracks: [], subtitleTracks: [] });
    expect(editorialTracksFromAsset(undefined as any)).toEqual({
      audioTracks: [],
      subtitleTracks: [],
    });
  });

  it('keeps a track that is missing an optional field, and never invents one', () => {
    const r = editorialTracksFromAsset({ audioTracks: [{ id: 'aud-2', language: 'fi' }] });
    expect(r.audioTracks).toEqual([{ id: 'aud-2', language: 'fi' }]);
    // No codec/channels/label/default materialised out of nowhere.
    expect(Object.keys(r.audioTracks[0] as object)).toEqual(['id', 'language']);
  });
});

describe('video tracks, as the API is able to report them', () => {
  it('lifts exactly the four track-level fields from technicalMetadata', () => {
    // durationSeconds and containerFormat are CONTAINER-level
    // (src/data/asset-document.ts:400-401) and must not appear as track attributes.
    expect(videoTracksFromAsset(ASSET)).toEqual([
      { codec: 'h264', width: 1920, height: 1080, bitrateBps: 5_000_000 },
    ]);
  });

  it('reports at most one track, because that is all the API exposes', () => {
    expect(videoTracksFromAsset(ASSET)).toHaveLength(1);
  });

  it('reports none when technicalMetadata is null/absent (nullish in the schema)', () => {
    expect(videoTracksFromAsset({ ...ASSET, technicalMetadata: null })).toEqual([]);
    expect(videoTracksFromAsset({ id: ULID } as any)).toEqual([]);
    expect(videoTracksFromAsset(null as any)).toEqual([]);
  });
});

describe('probed audio streams (technicalMetadata.audioTracks)', () => {
  it('returns the probe array as the server sent it', () => {
    expect(probedAudioStreamsFromAsset(ASSET)).toEqual(TECHNICAL.audioTracks);
  });

  it('returns none when technical metadata is absent or carries no audio', () => {
    expect(probedAudioStreamsFromAsset({ ...ASSET, technicalMetadata: null })).toEqual([]);
    expect(
      probedAudioStreamsFromAsset({
        ...ASSET,
        technicalMetadata: { ...TECHNICAL, audioTracks: [] },
      })
    ).toEqual([]);
  });
});

describe('attribute formatting', () => {
  it('renders an omitted optional attribute as the absent marker', () => {
    expect(attr(undefined)).toBe(TRACKS_COPY.absent);
    expect(attr(null)).toBe(TRACKS_COPY.absent);
    expect(attr('')).toBe(TRACKS_COPY.absent);
    // A legitimate falsy value is a value, not an absence.
    expect(attr(0)).toBe('0');
    expect(attr(false)).toBe('false');
  });

  it('formats resolution, bitrate and sample rate the way the rest of the UI does', () => {
    expect(resolutionLabel({ width: 1920, height: 1080 })).toBe('1920×1080');
    expect(resolutionLabel({ width: 1920 })).toBe(TRACKS_COPY.absent);
    expect(bitrateLabel(5_000_000)).toBe('5000 kbps');
    expect(bitrateLabel(undefined)).toBe(TRACKS_COPY.absent);
    expect(sampleRateLabel(48000)).toBe('48.0 kHz');
    expect(sampleRateLabel(undefined)).toBe(TRACKS_COPY.absent);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block rendering
// ─────────────────────────────────────────────────────────────────────────────

describe('tracks block (pure render)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
  });

  function render(data: Record<string, unknown>) {
    host.innerHTML = '';
    host.appendChild(renderTracksBlock(data));
    return host;
  }

  it('gives every track kind its own section, and never sums the two audio sets', () => {
    const root = render({
      video: videoTracksFromAsset(ASSET),
      audioEditorial: EDITORIAL_AUDIO,
      audioProbed: TECHNICAL.audioTracks,
      subtitles: EDITORIAL_SUBTITLES,
    });
    const titles = Array.from(root.querySelectorAll('#asset-tracks > .section-title')).map(
      (n) => n.textContent
    );
    expect(titles).toEqual([
      TRACKS_COPY.heading,
      TRACKS_COPY.videoHeading + ' (1)',
      // UNCOUNTED: editorial tracks and probed streams are different objects
      // with no shared id, so 2 + 2 is not "4 audio tracks". Each group carries
      // its own count instead.
      TRACKS_COPY.audioHeading,
      TRACKS_COPY.subtitleHeading + ' (2)',
    ]);
    expect(titles).not.toContain(TRACKS_COPY.audioHeading + ' (4)');

    const groups = Array.from(root.querySelectorAll('.tracks-group-title')).map(
      (n) => n.textContent
    );
    expect(groups).toEqual([
      TRACKS_COPY.audioEditorialGroup + ' (2)',
      TRACKS_COPY.audioProbedGroup + ' (2)',
    ]);
  });

  it('lists the video track with only its schema-verified attributes', () => {
    const root = render({ video: videoTracksFromAsset(ASSET) });
    expect(headerCells(root, 0)).toEqual(['#', 'Codec', 'Resolution', 'Bitrate']);
    expect(tableRows(root, 0)).toEqual([['1', 'h264', '1920×1080', '5000 kbps']]);
    // Container-level values are NOT presented as track attributes.
    const video = sectionText(root, TRACKS_COPY.videoHeading);
    expect(video).not.toContain('92.5');
    expect(video).not.toContain('mov');
    // And the one-track ceiling is stated rather than implied.
    expect(video).toContain('lists at most one track');
  });

  it('lists editorial audio tracks and probed streams as separate groups', () => {
    const root = render({
      audioEditorial: EDITORIAL_AUDIO,
      audioProbed: TECHNICAL.audioTracks,
    });
    expect(headerCells(root, 0)).toEqual([
      'Language',
      'Label',
      'Codec',
      'Channels',
      'Default',
      'Track ID',
    ]);
    expect(tableRows(root, 0)).toEqual([
      ['sv', 'Swedish 2.0', 'aac', '2', TRACKS_COPY.defaultFlag, 'aud-1'],
      // Every optional field omitted by the server renders as absent — not as a
      // guessed codec or channel count.
      ['fi', '—', '—', '—', '—', 'aud-2'],
    ]);

    // The probe's streams carry a DIFFERENT attribute set (index/sampleRateHz),
    // so they get their own columns and are never merged into the table above.
    expect(headerCells(root, 1)).toEqual(['Stream', 'Codec', 'Channels', 'Sample rate']);
    expect(tableRows(root, 1)).toEqual([
      ['1', 'aac', '2', '48.0 kHz'],
      ['2', 'aac', '6', '48.0 kHz'],
    ]);
  });

  it('lists subtitle tracks with format and object key', () => {
    const root = render({ subtitles: EDITORIAL_SUBTITLES });
    expect(headerCells(root, 0)).toEqual([
      'Language',
      'Label',
      'Format',
      'Default',
      'Object key',
      'Track ID',
    ]);
    expect(tableRows(root, 0)).toEqual([
      ['sv', 'Swedish', 'vtt', TRACKS_COPY.defaultFlag, 'ws/subtitles/' + ULID + '/sub-1.vtt', 'sub-1'],
      ['en', '—', 'srt', '—', '—', 'sub-2'],
    ]);
  });

  it('renders a format outside the enum verbatim rather than dropping the track', () => {
    // The API owns the vocabulary (SUBTITLE_FORMATS, src/data/asset-repo.ts:449);
    // a value this build has not heard of is still a real track.
    const root = render({ subtitles: [{ id: 'sub-9', language: 'de', format: 'dfxp' }] });
    expect(tableRows(root, 0)[0]).toEqual(['de', '—', 'dfxp', '—', '—', 'sub-9']);
  });

  it('renders an explicit empty state per kind with zero tracks', () => {
    const root = render({ video: [], audioEditorial: [], audioProbed: [], subtitles: [] });
    const empties = Array.from(root.querySelectorAll('.empty')).map((n) => ({
      kind: n.getAttribute('data-empty'),
      text: (n.textContent || '').trim(),
    }));
    expect(empties.map((e) => e.kind)).toEqual([
      'video-tracks',
      'audio-tracks',
      'subtitle-tracks',
    ]);
    expect(empties[0].text).toContain(TRACKS_COPY.videoEmpty);
    expect(empties[1].text).toContain(TRACKS_COPY.audioEmpty);
    expect(empties[2].text).toContain(TRACKS_COPY.subtitleEmpty);
    // No table is rendered for a kind with nothing in it.
    expect(root.querySelectorAll('#asset-tracks table')).toHaveLength(0);
  });

  it('says WHY there is no video track when the API says the extraction failed', () => {
    const root = render({ video: [], extractionError: 'ffprobe exited 1' });
    const empty = root.querySelector('[data-empty="video-tracks"]')!;
    expect(empty.textContent).toContain(TRACKS_COPY.videoEmptyErrorPrefix + 'ffprobe exited 1');

    const pending = render({ video: [] });
    expect(pending.querySelector('[data-empty="video-tracks"]')!.textContent).toContain(
      TRACKS_COPY.videoEmptyDetail
    );
  });

  it('keeps the audio section explicit when one group is empty and the other is not', () => {
    const root = render({ audioEditorial: [], audioProbed: TECHNICAL.audioTracks });
    // Not an "audio-tracks" empty state — the kind is not empty.
    expect(root.querySelector('[data-empty="audio-tracks"]')).toBeNull();
    const audio = sectionText(root, TRACKS_COPY.audioHeading);
    expect(audio).toContain(TRACKS_COPY.audioEditorialNone);
    expect(audio).toContain(TRACKS_COPY.audioEditorialGroup + ' (0)');
    expect(audio).toContain(TRACKS_COPY.audioProbedGroup + ' (2)');
  });

  it('creates no control that could add or remove a track (read-only, #902)', () => {
    const root = render({
      video: videoTracksFromAsset(ASSET),
      audioEditorial: EDITORIAL_AUDIO,
      audioProbed: TECHNICAL.audioTracks,
      subtitles: EDITORIAL_SUBTITLES,
    });
    const block = root.querySelector('#asset-tracks')!;
    expect(block.querySelectorAll('button, input, select, textarea, form, a')).toHaveLength(0);
  });

  it('names every table for assistive technology without duplicating it on screen', () => {
    const root = render({
      video: videoTracksFromAsset(ASSET),
      audioEditorial: EDITORIAL_AUDIO,
      audioProbed: TECHNICAL.audioTracks,
      subtitles: EDITORIAL_SUBTITLES,
    });
    const tables = Array.from(root.querySelectorAll('#asset-tracks table'));
    expect(tables).toHaveLength(4);
    tables.forEach((t) => {
      const caption = t.querySelector('caption')!;
      expect(caption.textContent).toBeTruthy();
      expect(caption.classList.contains('visually-hidden')).toBe(true);
      // Column headers are scoped, so a cell's header is unambiguous.
      const ths = Array.from(t.querySelectorAll('thead th'));
      expect(ths.every((th) => th.getAttribute('scope') === 'col')).toBe(true);
    });
  });

  it('marks the default track with text, never with colour alone (WCAG 1.4.1)', () => {
    const root = render({ audioEditorial: EDITORIAL_AUDIO });
    const flags = Array.from(root.querySelectorAll('#asset-tracks .badge')).map(
      (n) => n.textContent
    );
    expect(flags).toEqual([TRACKS_COPY.defaultFlag]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mount
// ─────────────────────────────────────────────────────────────────────────────

describe('mountAssetTracks', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  it('renders all four record sets from the asset it was given, with no fetch', () => {
    // GET /assets/{id} already carries the editorial arrays and the probe output
    // (src/routes/assets.ts:884, :907-908), so the panel has nothing to ask for.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    mountAssetTracks({ asset: ASSET, host });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sectionText(host, TRACKS_COPY.videoHeading)).toContain('1920×1080');
    expect(tableRows(host, 1)[0]).toEqual([
      'sv',
      'Swedish 2.0',
      'aac',
      '2',
      TRACKS_COPY.defaultFlag,
      'aud-1',
    ]);
    expect(tableRows(host, 2)[0]).toEqual(['1', 'aac', '2', '48.0 kHz']);
    expect(tableRows(host, 3)[0][0]).toBe('sv');

    vi.unstubAllGlobals();
  });

  it('renders the empty state for a kind the asset omits entirely', () => {
    const bare = { id: ULID, technicalMetadata: null };
    mountAssetTracks({ asset: bare, host });

    // Absent array means none, so this is an empty state — never "unavailable".
    expect(host.querySelector('[data-empty="audio-tracks"]')!.textContent).toContain(
      TRACKS_COPY.audioEmpty
    );
    expect(host.querySelector('[data-empty="subtitle-tracks"]')!.textContent).toContain(
      TRACKS_COPY.subtitleEmpty
    );
    expect(host.querySelector('[data-empty="video-tracks"]')).not.toBeNull();
  });

  it('inserts before the anchor when one is given', () => {
    const anchor = document.createElement('div');
    anchor.id = 'anchor';
    host.appendChild(anchor);
    mountAssetTracks({ asset: ASSET, host, anchorEl: anchor });

    expect(host.children[0].id).toBe('asset-tracks');
    expect(host.children[1].id).toBe('anchor');
  });

  it('replaces the block in place on update rather than appending a second one', () => {
    const mounted = mountAssetTracks({ asset: { id: ULID, technicalMetadata: null }, host });
    expect(host.querySelector('[data-empty="subtitle-tracks"]')).not.toBeNull();

    mounted.update(ASSET);
    expect(host.querySelectorAll('#asset-tracks')).toHaveLength(1);
    expect(host.querySelector('[data-empty="subtitle-tracks"]')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail view integration
// ─────────────────────────────────────────────────────────────────────────────

describe('asset detail — tracks panel (issue #902)', () => {
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

  it('renders all three sections without issuing a single extra request', async () => {
    const fetchSpy = routedFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    // /tracks returns `asset.audioTracks ?? []` off the same document
    // (src/routes/assets.ts:5268-5271), so calling it would cost a round-trip
    // for bytes the detail read already returned.
    expect(calls.some((u) => /\/tracks$/.test(u))).toBe(false);
    // And the paths the issue names have no GET at all
    // (src/routes/assets.ts:5279, 5344).
    expect(calls.some((u) => /\/audio-tracks$/.test(u))).toBe(false);
    expect(calls.some((u) => /\/subtitle-tracks$/.test(u))).toBe(false);

    expect(sectionText(container, TRACKS_COPY.videoHeading)).toContain('1920×1080');
    expect(sectionText(container, TRACKS_COPY.audioHeading)).toContain('Swedish 2.0');
    expect(sectionText(container, TRACKS_COPY.subtitleHeading)).toContain('vtt');
  });

  it('shows an explicit empty state per kind for an asset with no tracks at all', async () => {
    const bare = { ...ASSET, technicalMetadata: null, audioTracks: undefined, subtitleTracks: undefined };
    vi.stubGlobal('fetch', routedFetch(bare));

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(container.querySelector('[data-empty="video-tracks"]')!.textContent).toContain(
      TRACKS_COPY.videoEmpty
    );
    expect(container.querySelector('[data-empty="audio-tracks"]')!.textContent).toContain(
      TRACKS_COPY.audioEmpty
    );
    expect(container.querySelector('[data-empty="subtitle-tracks"]')!.textContent).toContain(
      TRACKS_COPY.subtitleEmpty
    );
  });

  it('does not disturb the technical KV rows the detail view already showed', async () => {
    // The panel adds a surface; it does not take over resolution/codec/duration.
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    const kv = container.querySelector('.kv-grid')!.textContent || '';
    expect(kv).toContain('Resolution');
    expect(kv).toContain('1920×1080');
    expect(kv).toContain('Container');
  });

  it('renders the panel above the action controls (read-only information block)', async () => {
    vi.stubGlobal('fetch', routedFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    const tracks = container.querySelector('#asset-tracks')!;
    const executions = container.querySelector('#executions-area')!;
    expect(tracks.compareDocumentPosition(executions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Subtitle add/remove controls (issue #904)
//
// Acceptance criteria under test:
//   1. An operator can add a subtitle track and remove an existing one.
//   2. Remove requires an explicit confirmation step.
//   3. A failed add/remove surfaces an INLINE error and the panel does not
//      silently drop the change.
//   4. A successful add/remove refreshes the subtitle section without a full
//      page reload.
// ─────────────────────────────────────────────────────────────────────────────

/** The published spec, re-read at run time so a contract drift fails here. */
const OPENAPI = JSON.parse(readFileSync(resolve(process.cwd(), 'openapi.json'), 'utf8')) as any;
const ADD_OP = OPENAPI.paths['/api/v1/assets/{id}/subtitle-tracks'];
const REMOVE_OP = OPENAPI.paths['/api/v1/assets/{id}/subtitle-tracks/{trackId}'];
const TRACKS_OP = OPENAPI.paths['/api/v1/assets/{id}/tracks'];

describe('contract anchor — the operations the controls were written against', () => {
  it('declares an add operation at POST /api/v1/assets/{id}/subtitle-tracks only', () => {
    expect(Object.keys(ADD_OP)).toEqual(['post']);
    expect(ADD_OP.post.parameters.map((p: any) => [p.in, p.name])).toEqual([['path', 'id']]);
    expect(ADD_OP.post.requestBody.required).toBe(true);
  });

  it('accepts exactly the four body fields the add form offers, and no fifth', () => {
    const body = ADD_OP.post.requestBody.content['application/json'].schema;
    expect(Object.keys(body.properties).sort()).toEqual(['default', 'format', 'label', 'language']);
    expect(body.required.sort()).toEqual(['format', 'language']);
    // additionalProperties:false — a fifth key would be a 400, so subtitleAddBody
    // must never invent one (asserted below).
    expect(body.additionalProperties).toBe(false);
    expect(body.properties.language.maxLength).toBe(64);
    expect(body.properties.label.minLength).toBe(1);
    expect(body.properties.label.maxLength).toBe(128);
    // Neither id nor objectKey is client-supplied.
    expect(body.properties.id).toBeUndefined();
    expect(body.properties.objectKey).toBeUndefined();
  });

  it('offers exactly the format vocabulary the API accepts', () => {
    const enumerated = ADD_OP.post.requestBody.content['application/json'].schema.properties.format.enum;
    expect([...SUBTITLE_FORMATS]).toEqual(enumerated);
  });

  it('answers the add with the ONE new track, not the resulting list', () => {
    const created = ADD_OP.post.responses['201'].content['application/json'].schema;
    expect(Object.keys(created.properties).sort()).toEqual(['track', 'uploadUrl']);
    expect(created.required).toEqual(['track']);
    // No array of tracks anywhere in the 201 — hence the follow-up read.
    expect(created.properties.track.type).toBe('object');
    expect(ADD_OP.post.responses['404']).toBeTruthy();
  });

  it('declares a remove operation at DELETE …/{trackId} with two path params and no body', () => {
    expect(Object.keys(REMOVE_OP)).toEqual(['delete']);
    expect(REMOVE_OP.delete.parameters.map((p: any) => [p.in, p.name])).toEqual([
      ['path', 'id'],
      ['path', 'trackId'],
    ]);
    expect(REMOVE_OP.delete.requestBody).toBeUndefined();
    // 204 carries nothing, so the resulting list must be re-read.
    expect(REMOVE_OP.delete.responses['204']).toBeTruthy();
    expect(REMOVE_OP.delete.responses['404']).toBeTruthy();
  });

  it('exposes the refresh read as GET /api/v1/assets/{id}/tracks with both arrays required', () => {
    expect(Object.keys(TRACKS_OP)).toEqual(['get']);
    const ok = TRACKS_OP.get.responses['200'].content['application/json'].schema;
    expect(ok.required.sort()).toEqual(['audioTracks', 'subtitleTracks']);
  });
});

describe('subtitleAddBody — the POST body, mirrored from addSubtitleTrackSchema', () => {
  it('sends the declared keys and nothing else', () => {
    const r = subtitleAddBody({ language: 'sv', format: 'vtt', label: 'Swedish', default: true });
    expect(r).toEqual({
      ok: true,
      body: { language: 'sv', format: 'vtt', label: 'Swedish', default: true },
    });
  });

  it('drops a blank label instead of sending "" (min(1) would be a refusal)', () => {
    const r = subtitleAddBody({ language: 'sv', format: 'vtt', label: '   ' }) as any;
    expect(r.ok).toBe(true);
    expect('label' in r.body).toBe(false);
  });

  it('drops an unticked default instead of persisting default:false', () => {
    // The route assigns `default: request.body.default` straight onto the stored
    // track (src/routes/assets.ts:5426), so a false would be a flag nobody set.
    const r = subtitleAddBody({ language: 'sv', format: 'vtt', default: false }) as any;
    expect(r.ok).toBe(true);
    expect('default' in r.body).toBe(false);
    expect(Object.keys(r.body)).toEqual(['language', 'format']);
  });

  it('trims the language and refuses a blank one', () => {
    expect((subtitleAddBody({ language: '  sv  ', format: 'srt' }) as any).body.language).toBe('sv');
    expect(subtitleAddBody({ language: '   ', format: 'srt' })).toEqual({
      ok: false,
      message: TRACKS_COPY.errLanguageRequired,
      field: 'language',
    });
    expect((subtitleAddBody({ format: 'srt' }) as any).ok).toBe(false);
  });

  it('refuses values the schema bounds would reject, before any request is built', () => {
    expect(subtitleAddBody({ language: 'x'.repeat(65), format: 'vtt' })).toEqual({
      ok: false,
      message: TRACKS_COPY.errLanguageTooLong,
      field: 'language',
    });
    expect(subtitleAddBody({ language: 'sv', format: 'vtt', label: 'y'.repeat(129) })).toEqual({
      ok: false,
      message: TRACKS_COPY.errLabelTooLong,
      field: 'label',
    });
    expect(subtitleAddBody({ language: 'sv', format: 'dfxp' })).toEqual({
      ok: false,
      message: TRACKS_COPY.errFormatUnknown,
      field: 'format',
    });
  });
});

describe('subtitleTrackName — a name an operator recognises, never an id', () => {
  it('prefers the editorial label, then the language, then a phrase', () => {
    expect(subtitleTrackName({ id: 'sub-1', label: 'Swedish', language: 'sv' })).toBe('Swedish');
    expect(subtitleTrackName({ id: 'sub-2', language: 'en' })).toBe('en');
    expect(subtitleTrackName({ id: 'sub-3' })).toBe(TRACKS_COPY.unnamedTrack);
    // The server id is a randomUUID() (src/routes/assets.ts:5408) and is never a name.
    expect(subtitleTrackName({ id: 'sub-3' })).not.toContain('sub-3');
  });
});

describe('classifySubtitleTrackError — what a refusal says inline', () => {
  it('names the role requirement on 403 (forbidden_insufficient_role)', () => {
    expect(classifySubtitleTrackError({ status: 403, message: 'forbidden_insufficient_role' }, 'add'))
      .toEqual({ kind: 'forbidden', message: TRACKS_COPY.errForbidden });
  });

  it('does not claim to tell an unknown asset from an unknown track on a 404 remove', () => {
    // src/routes/assets.ts:5450 and :5455 both answer 404 and nothing in the
    // body separates them.
    const r = classifySubtitleTrackError({ status: 404 }, 'remove');
    expect(r).toEqual({ kind: 'not-found', message: TRACKS_COPY.errRemoveNotFound });
    expect(r.message).toContain('not distinguishable');
    expect(classifySubtitleTrackError({ status: 404 }, 'add').message).toBe(
      TRACKS_COPY.errAddNotFound
    );
  });

  it('repeats the failure it was given for every other outcome, never swallowing it', () => {
    expect(classifySubtitleTrackError({ status: 500, message: 'upstream exploded' }, 'add')).toEqual({
      kind: 'failed',
      message: TRACKS_COPY.errAddFailedPrefix + 'upstream exploded',
    });
    // A network failure carries no status at all.
    expect(classifySubtitleTrackError(new Error('Failed to fetch') as any, 'remove').message).toBe(
      TRACKS_COPY.errRemoveFailedPrefix + 'Failed to fetch'
    );
    expect(classifySubtitleTrackError(undefined as any, 'add').kind).toBe('failed');
  });
});

describe('subtitleRemoveConfirmSpec — what the confirmation step states', () => {
  const spec = subtitleRemoveConfirmSpec(EDITORIAL_SUBTITLES[0]) as any;

  it('names the subject by its human-readable name, not its id', () => {
    expect(spec.subject).toBe('Swedish');
    expect(spec.question).toContain('Swedish');
    // The track id is a randomUUID() (src/routes/assets.ts:5408) and never names
    // the subject. It appears only inside the storage object key, which is a
    // path the operator is being told about, not an identifier being used as a
    // name.
    expect(spec.subject).not.toContain('sub-1');
    expect(spec.question).not.toContain('sub-1');
    expect(spec.affected.join(' ')).not.toContain('sub-1');
    expect(spec.unaffected.join(' ')).not.toContain('sub-1');
  });

  it('states what IS and what is NOT affected, both route-verified', () => {
    expect(spec.affected.length).toBeGreaterThan(0);
    expect(spec.unaffected.length).toBeGreaterThan(0);
    // The handler filters the list and patches subtitleTracks alone
    // (src/routes/assets.ts:5453, :5457).
    expect(spec.affected.join(' ')).toContain('subtitle track list');
    // "Leaves the subtitle object (if any) in storage" (:5434-5435).
    expect(spec.unaffected.join(' ')).toContain('object storage');
  });

  it('says whether a stored subtitle file is involved at all', () => {
    expect(spec.detail).toBe(
      TRACKS_COPY.confirmFileDetailPrefix + 'ws/subtitles/' + ULID + '/sub-1.vtt'
    );
    expect((subtitleRemoveConfirmSpec(EDITORIAL_SUBTITLES[1]) as any).detail).toBe(
      TRACKS_COPY.confirmNoFileDetail
    );
  });
});

// ─── The controls, driven through the mount ──────────────────────────────────

type ApiCall = { path: string; method: string; body?: any };

/**
 * Mount an editable panel over a tiny in-memory "server" that behaves like the
 * two routes: POST appends and answers with the ONE new track, DELETE answers
 * 204 (null through apiFetch), and GET /tracks answers the resulting lists. The
 * panel is never handed the resulting list by a write, so every refreshed row
 * below can only have come from the follow-up read.
 */
function mountPanel(
  host: HTMLElement,
  options: {
    subtitles?: any[];
    canChange?: boolean;
    withConfirm?: boolean;
    confirmAnswer?: boolean;
    failPost?: any;
    failDelete?: any;
    failGet?: any;
    onChanged?: (e: any) => void;
  } = {}
) {
  const server = { subtitles: [...(options.subtitles ?? EDITORIAL_SUBTITLES)] };
  const calls: ApiCall[] = [];

  const apiFetch = vi.fn(async (path: string, init: any = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ path, method, body: init.body ? JSON.parse(init.body) : undefined });
    if (method === 'POST') {
      if (options.failPost) throw options.failPost;
      const track = { id: 'sub-new', ...JSON.parse(init.body) };
      server.subtitles = [...server.subtitles, track];
      return { track };
    }
    if (method === 'DELETE') {
      if (options.failDelete) throw options.failDelete;
      const id = decodeURIComponent(path.split('/').pop() as string);
      server.subtitles = server.subtitles.filter((t) => t.id !== id);
      return null;
    }
    if (options.failGet) throw options.failGet;
    return { audioTracks: EDITORIAL_AUDIO, subtitleTracks: [...server.subtitles] };
  });

  const confirmModal = vi.fn(async () => options.confirmAnswer !== false);

  const mounted = mountAssetTracks({
    asset: {
      id: ULID,
      technicalMetadata: null,
      audioTracks: [],
      subtitleTracks: [...server.subtitles],
    },
    host,
    assetId: ULID,
    canChange: options.canChange !== false,
    apiFetch,
    confirmModal: options.withConfirm === false ? undefined : confirmModal,
    onChanged: options.onChanged,
  });

  return { server, calls, apiFetch, confirmModal, mounted };
}

/** Rows of the subtitle table, found by its caption rather than by position. */
function subtitleTable(root: ParentNode): HTMLTableElement | null {
  const tables = Array.from(root.querySelectorAll('#asset-tracks table'));
  return (tables.find(
    (t) => (t.querySelector('caption')?.textContent || '') === 'Subtitle tracks'
  ) ?? null) as HTMLTableElement | null;
}

function subtitleRows(root: ParentNode): string[][] {
  const table = subtitleTable(root);
  if (!table) return [];
  return Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())
  );
}

function noticeEl(root: ParentNode): HTMLElement | null {
  return root.querySelector('[data-subtitle-notice]') as HTMLElement | null;
}

function addForm(root: ParentNode) {
  return {
    language: root.querySelector('#subtitle-add-language') as HTMLInputElement,
    format: root.querySelector('#subtitle-add-format') as HTMLSelectElement,
    label: root.querySelector('#subtitle-add-label') as HTMLInputElement,
    dflt: root.querySelector('#subtitle-add-default') as HTMLInputElement,
    submit: root.querySelector('#btn-subtitle-add') as HTMLButtonElement,
  };
}

function removeButton(root: ParentNode, trackId: string): HTMLButtonElement | null {
  return root.querySelector('[data-remove-track="' + trackId + '"]') as HTMLButtonElement | null;
}

describe('subtitle controls — when they are offered at all (issue #904)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  it('renders nothing writable unless the caller opts in', () => {
    // The #902 mount is unchanged: no apiFetch, no control, no listener.
    mountAssetTracks({ asset: ASSET, host, canChange: true });
    const block = host.querySelector('#asset-tracks')!;
    expect(block.querySelectorAll('button, input, select, textarea, form')).toHaveLength(0);
  });

  it('offers add and remove to a role that holds write+delete', () => {
    mountPanel(host);
    const form = addForm(host);
    expect(form.language).toBeTruthy();
    expect(form.format).toBeTruthy();
    expect(form.submit).toBeTruthy();
    expect(removeButton(host, 'sub-1')).toBeTruthy();
    expect(removeButton(host, 'sub-2')).toBeTruthy();
    // The intro no longer promises a read-only panel.
    expect(host.querySelector('#asset-tracks')!.textContent).toContain(
      TRACKS_COPY.introEditable
    );
  });

  it('offers the three formats the API accepts and no free-text alternative', () => {
    mountPanel(host);
    const opts = Array.from(addForm(host).format.options).map((o) => o.value);
    expect(opts).toEqual([...SUBTITLE_FORMATS]);
  });

  it('replaces the controls with a role note for a viewer', () => {
    // MATRIX gives viewer neither write nor delete (src/auth/authorize.ts:54-58).
    mountPanel(host, { canChange: false });
    expect(addForm(host).submit).toBeNull();
    expect(removeButton(host, 'sub-1')).toBeNull();
    expect(host.querySelector('#asset-tracks')!.textContent).toContain(TRACKS_COPY.viewerNote);
    // The tracks themselves are still readable — a viewer holds `read`.
    expect(subtitleRows(host)).toHaveLength(2);
  });

  it('renders NO remove control when no confirmation gate was supplied', () => {
    // AC2 structurally: without a confirm function there is no button, so there
    // is no code path to an unconfirmed DELETE.
    mountPanel(host, { withConfirm: false });
    expect(removeButton(host, 'sub-1')).toBeNull();
    expect(subtitleTable(host)!.querySelectorAll('thead th')).toHaveLength(6);
    // Add is unaffected: it is not the destructive half.
    expect(addForm(host).submit).toBeTruthy();
  });

  it('issues no request at all while merely rendering the controls', () => {
    const { apiFetch } = mountPanel(host);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('adding a subtitle track (issue #904 AC1/AC4)', () => {
  let host: HTMLElement;
  let marker: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    // A sibling that a full page reload would take with it.
    marker = document.createElement('div');
    marker.id = 'reload-marker';
    document.body.appendChild(host);
    document.body.appendChild(marker);
  });

  afterEach(() => {
    host.remove();
    marker.remove();
    vi.restoreAllMocks();
  });

  it('POSTs exactly the declared body to the subtitle-tracks path', async () => {
    const { calls } = mountPanel(host);
    const form = addForm(host);
    form.language.value = 'de';
    form.format.value = 'ttml';
    form.label.value = 'German';
    form.dflt.checked = true;
    form.submit.click();
    await settle();

    expect(calls[0]).toEqual({
      path: '/assets/' + ULID + '/subtitle-tracks',
      method: 'POST',
      body: { language: 'de', format: 'ttml', label: 'German', default: true },
    });
  });

  it('re-reads the list from the server and refreshes the section in place', async () => {
    const { calls } = mountPanel(host);
    const before = host.querySelector('#asset-tracks');
    const form = addForm(host);
    form.language.value = 'de';
    form.format.value = 'srt';
    form.submit.click();
    await settle();

    // The 201 carries one track, never the list (openapi 201 schema above), so
    // the refreshed rows can only have come from GET /tracks.
    expect(calls[1]).toEqual({
      path: '/assets/' + ULID + '/tracks',
      method: 'GET',
      body: undefined,
    });
    const rows = subtitleRows(host);
    expect(rows).toHaveLength(3);
    expect(rows[2][0]).toBe('de');
    expect(rows[2][2]).toBe('srt');

    // Refreshed WITHOUT a reload: same document, same host, one block, swapped
    // in place — and the sibling a reload would have destroyed is still here.
    expect(document.getElementById('reload-marker')).not.toBeNull();
    expect(host.querySelectorAll('#asset-tracks')).toHaveLength(1);
    expect(host.querySelector('#asset-tracks')).not.toBe(before);
    expect(host.querySelector('#asset-tracks')!.parentNode).toBe(host);
  });

  it('adopts the audio half of the refresh read too, so both lists share one read', async () => {
    // tracksSchema returns BOTH arrays as required (src/routes/assets.ts:836-839)
    // and the response is authoritative for the pair — dropping the audio half
    // would leave two lists on screen that were read at different times. The
    // panel mounts with no editorial audio; the refresh read has two.
    mountPanel(host);
    // Neither editorial nor probed audio on the mounted body, so the whole kind
    // is in its empty state.
    expect(host.querySelector('[data-empty="audio-tracks"]')).not.toBeNull();

    const form = addForm(host);
    form.language.value = 'de';
    form.submit.click();
    await settle();

    expect(host.querySelector('#asset-tracks')!.textContent).toContain(
      TRACKS_COPY.audioEditorialGroup + ' (2)'
    );
    expect(host.querySelector('#asset-tracks')!.textContent).toContain('Swedish 2.0');
  });

  it('reports the outcome inline and keeps the count in the heading honest', async () => {
    mountPanel(host);
    const form = addForm(host);
    form.language.value = 'de';
    form.submit.click();
    await settle();

    const notice = noticeEl(host)!;
    expect(notice.textContent).toBe(TRACKS_COPY.addedOne);
    expect(notice.className).toContain('msg-success');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(host.querySelector('#asset-tracks')!.textContent).toContain(
      TRACKS_COPY.subtitleHeading + ' (3)'
    );
  });

  it('tells the caller a write landed', async () => {
    const onChanged = vi.fn();
    mountPanel(host, { onChanged });
    const form = addForm(host);
    form.language.value = 'de';
    form.submit.click();
    await settle();

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged.mock.calls[0][0].op).toBe('add');
  });
});

describe('removing a subtitle track (issue #904 AC1/AC2/AC4)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  it('asks for confirmation BEFORE issuing anything, naming the track', async () => {
    const { calls, confirmModal } = mountPanel(host);
    removeButton(host, 'sub-1')!.click();
    await settle();

    expect(confirmModal).toHaveBeenCalledTimes(1);
    const spec = confirmModal.mock.calls[0][0] as any;
    expect(spec.subject).toBe('Swedish');
    expect(spec.affected.length).toBeGreaterThan(0);
    expect(spec.unaffected.length).toBeGreaterThan(0);
    expect(calls[0].method).toBe('DELETE');
  });

  it('sends DELETE to the track path and refreshes the section in place', async () => {
    const { calls } = mountPanel(host);
    removeButton(host, 'sub-1')!.click();
    await settle();

    expect(calls[0]).toEqual({
      path: '/assets/' + ULID + '/subtitle-tracks/sub-1',
      method: 'DELETE',
      body: undefined,
    });
    // 204 carries nothing, so the remaining rows come from the follow-up read.
    expect(calls[1].method).toBe('GET');
    expect(calls[1].path).toBe('/assets/' + ULID + '/tracks');

    const rows = subtitleRows(host);
    expect(rows).toHaveLength(1);
    expect(rows[0][5]).toBe('sub-2');
    expect(host.querySelectorAll('#asset-tracks')).toHaveLength(1);
    expect(noticeEl(host)!.textContent).toBe(TRACKS_COPY.removedOne);
  });

  it('sends NOTHING when the confirmation is dismissed', async () => {
    const { calls, apiFetch } = mountPanel(host, { confirmAnswer: false });
    removeButton(host, 'sub-1')!.click();
    await settle();

    expect(apiFetch).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    // The list is exactly as it was, and nothing is reported as having happened.
    expect(subtitleRows(host)).toHaveLength(2);
    expect(noticeEl(host)!.style.display).toBe('none');
  });

  it('drops the last track to the explicit empty state rather than an empty table', async () => {
    mountPanel(host, { subtitles: [EDITORIAL_SUBTITLES[1]] });
    removeButton(host, 'sub-2')!.click();
    await settle();

    expect(subtitleTable(host)).toBeNull();
    expect(host.querySelector('[data-empty="subtitle-tracks"]')!.textContent).toContain(
      TRACKS_COPY.subtitleEmpty
    );
  });
});

describe('failed writes surface inline and change nothing (issue #904 AC3)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  function failure(status: number, message: string) {
    const err: any = new Error(message);
    err.status = status;
    return err;
  }

  it('refuses an unsendable add before the network, keeping what was typed', async () => {
    const { apiFetch } = mountPanel(host);
    const form = addForm(host);
    form.label.value = 'German';
    form.submit.click();
    await settle();

    expect(apiFetch).not.toHaveBeenCalled();
    expect(noticeEl(host)!.textContent).toBe(TRACKS_COPY.errLanguageRequired);
    expect(noticeEl(host)!.className).toContain('msg-error');
    expect(form.label.value).toBe('German');
    expect(document.activeElement).toBe(form.language);
  });

  it('reports a rejected add inline and does not show the track as added', async () => {
    mountPanel(host, { failPost: failure(500, 'upstream exploded') });
    const form = addForm(host);
    form.language.value = 'de';
    form.submit.click();
    await settle();

    expect(noticeEl(host)!.textContent).toBe(
      TRACKS_COPY.errAddFailedPrefix + 'upstream exploded'
    );
    expect(noticeEl(host)!.className).toContain('msg-error');
    // Not optimistically appended, and the typed values survive for a retry.
    expect(subtitleRows(host)).toHaveLength(2);
    expect(addForm(host).language.value).toBe('de');
    expect(addForm(host).submit.disabled).toBe(false);
    expect(addForm(host).submit.textContent).toBe(TRACKS_COPY.btnAdd);
  });

  it('reports a rejected remove inline and leaves the row in place', async () => {
    const { calls } = mountPanel(host, { failDelete: failure(404, 'subtitle track not found') });
    removeButton(host, 'sub-1')!.click();
    await settle();

    expect(noticeEl(host)!.textContent).toBe(TRACKS_COPY.errRemoveNotFound);
    expect(subtitleRows(host)).toHaveLength(2);
    // No refresh was issued: nothing changed, so there is nothing to re-read.
    expect(calls.map((c) => c.method)).toEqual(['DELETE']);
    expect(removeButton(host, 'sub-1')!.disabled).toBe(false);
    expect(removeButton(host, 'sub-1')!.textContent).toBe(TRACKS_COPY.btnRemove);
  });

  it('names the role requirement when the server answers 403', async () => {
    mountPanel(host, { failPost: failure(403, 'forbidden_insufficient_role') });
    const form = addForm(host);
    form.language.value = 'de';
    form.submit.click();
    await settle();

    expect(noticeEl(host)!.textContent).toBe(TRACKS_COPY.errForbidden);
  });

  it('never reports a saved change as unsaved when only the re-read failed', async () => {
    const { server } = mountPanel(host, { failGet: failure(503, 'unavailable') });
    const form = addForm(host);
    form.language.value = 'de';
    form.submit.click();
    await settle();

    // The POST landed — the "server" holds three tracks.
    expect(server.subtitles).toHaveLength(3);
    const notice = noticeEl(host)!;
    expect(notice.textContent).toBe(TRACKS_COPY.refreshFailed);
    expect(notice.className).toContain('msg-info');
    expect(notice.textContent).toContain('was saved');
  });
});

describe('subtitle controls — accessibility (WCAG 2.1 AA)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  it('binds every field to a visible label and keeps its help text programmatic', () => {
    mountPanel(host);
    const form = addForm(host);
    [form.language, form.format, form.label, form.dflt].forEach((input) => {
      const label = host.querySelector('label[for="' + input.id + '"]');
      expect(label, input.id).toBeTruthy();
      expect((label!.textContent || '').trim().length).toBeGreaterThan(0);
    });
    const describedBy = form.language.getAttribute('aria-describedby')!;
    expect(host.querySelector('#' + describedBy)!.textContent).toBe(TRACKS_COPY.helpLanguage);
  });

  it('distinguishes the per-row Remove controls by accessible name', () => {
    mountPanel(host);
    expect(removeButton(host, 'sub-1')!.getAttribute('aria-label')).toBe(
      TRACKS_COPY.btnRemove + ' subtitle track Swedish'
    );
    // sub-2 has no label, so the language names it — never the opaque id.
    expect(removeButton(host, 'sub-2')!.getAttribute('aria-label')).toBe(
      TRACKS_COPY.btnRemove + ' subtitle track en'
    );
  });

  it('announces every outcome through one live region', () => {
    mountPanel(host);
    const notices = host.querySelectorAll('[data-subtitle-notice]');
    expect(notices).toHaveLength(1);
    expect(notices[0].getAttribute('role')).toBe('alert');
  });

  it('keeps the actions column headed and scoped like every other column', () => {
    mountPanel(host);
    const ths = Array.from(subtitleTable(host)!.querySelectorAll('thead th'));
    expect(ths.map((t) => t.textContent)).toEqual([
      'Language',
      'Label',
      'Format',
      'Default',
      'Object key',
      'Track ID',
      TRACKS_COPY.actionsColumn,
    ]);
    expect(ths.every((t) => t.getAttribute('scope') === 'col')).toBe(true);
  });

  it('renders a server-sent value as text, never as markup', () => {
    mountPanel(host, {
      subtitles: [{ id: 'sub-x', language: 'sv', format: 'vtt', label: '<img src=x onerror=1>' }],
    });
    const table = subtitleTable(host)!;
    expect(table.querySelector('img')).toBeNull();
    expect(table.textContent).toContain('<img src=x onerror=1>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail view integration — the real renderer, the real confirmation dialog
// ─────────────────────────────────────────────────────────────────────────────

describe('asset detail — subtitle add/remove end to end (issue #904)', () => {
  let container: HTMLElement;

  /** Routes the real apiFetch URLs, mutating an in-memory subtitle list. */
  function writableFetch(subtitles: any[]) {
    const state = { subtitles: [...subtitles] };
    const spy = vi.fn(async (url: string, init: any = {}) => {
      const path = String(url);
      const method = String(init?.method || 'GET').toUpperCase();
      if (/\/subtitle-tracks$/.test(path) && method === 'POST') {
        const body = JSON.parse(init.body);
        const track = { id: 'sub-new', ...body };
        state.subtitles = [...state.subtitles, track];
        return json({ track }, 201);
      }
      if (/\/subtitle-tracks\/[^/]+$/.test(path) && method === 'DELETE') {
        const id = decodeURIComponent(path.split('/').pop() as string);
        state.subtitles = state.subtitles.filter((t) => t.id !== id);
        return new Response(null, { status: 204 });
      }
      if (/\/tracks$/.test(path)) {
        return json({ audioTracks: EDITORIAL_AUDIO, subtitleTracks: state.subtitles });
      }
      if (/\/review-state$/.test(path)) {
        return json({ reviewState: 'draft', allowedTransitions: ['in-review'] });
      }
      if (/\/lock$/.test(path)) return json(ASSET);
      if (/\/delivery$/.test(path)) return json({ urls: {} });
      if (/\/executions$/.test(path)) return json([]);
      if (/\/profiles$/.test(path)) return json({ profiles: ['program'] });
      if (/\/files$/.test(path)) return json({ files: [], fileGroups: [] });
      if (/\/assets\/[^/?]+(?:\?|$)/.test(path)) {
        return json({ ...ASSET, subtitleTracks: state.subtitles });
      }
      return json({}, 200);
    });
    return { spy, state };
  }

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
  });

  it('still issues no track request while rendering the detail view', async () => {
    const { spy } = writableFetch(EDITORIAL_SUBTITLES);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const calls = spy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => /\/tracks$/.test(u))).toBe(false);
    expect(calls.some((u) => /subtitle-tracks/.test(u))).toBe(false);
    // …and the controls are nonetheless there for the default (admin) role.
    expect(container.querySelector('#btn-subtitle-add')).not.toBeNull();
    expect(container.querySelector('[data-remove-track="sub-1"]')).not.toBeNull();
  });

  it('adds a track through the real API path and refreshes without a reload', async () => {
    const { spy, state } = writableFetch(EDITORIAL_SUBTITLES);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const kvBefore = container.querySelector('.kv-grid');
    const form = addForm(container);
    form.language.value = 'de';
    form.format.value = 'vtt';
    form.submit.click();
    await settle();

    const writes = spy.mock.calls.filter((c) => String((c[1] as any)?.method) === 'POST');
    expect(writes).toHaveLength(1);
    expect(String(writes[0][0])).toBe(
      window.location.origin + '/api/v1/assets/' + ULID + '/subtitle-tracks'
    );
    expect(JSON.parse(String((writes[0][1] as any).body))).toEqual({
      language: 'de',
      format: 'vtt',
    });
    expect(state.subtitles).toHaveLength(3);

    const rows = subtitleRows(container);
    expect(rows).toHaveLength(3);
    expect(rows[2][0]).toBe('de');
    // Nothing else on the detail view was torn down and rebuilt.
    expect(container.querySelector('.kv-grid')).toBe(kvBefore);
  });

  it('removes a track only after the house confirmation dialog is accepted', async () => {
    const { spy, state } = writableFetch(EDITORIAL_SUBTITLES);
    vi.stubGlobal('fetch', spy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const deletes = () => spy.mock.calls.filter((c) => String((c[1] as any)?.method) === 'DELETE');

    // 1. The dialog opens and NOTHING is sent yet.
    (container.querySelector('[data-remove-track="sub-1"]') as HTMLButtonElement).click();
    await settle(5);
    const dialog = document.querySelector('.confirm-dialog') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('Swedish');
    expect(dialog.querySelector('.confirm-affected')).toBeTruthy();
    expect(dialog.querySelector('.confirm-unaffected')).toBeTruthy();
    expect(deletes()).toHaveLength(0);

    // 2. Dismissing it sends nothing and leaves the row.
    (dialog.querySelector('.confirm-cancel') as HTMLButtonElement).click();
    await settle();
    expect(deletes()).toHaveLength(0);
    expect(subtitleRows(container)).toHaveLength(2);

    // 3. Accepting it sends the DELETE and refreshes the section in place.
    (container.querySelector('[data-remove-track="sub-1"]') as HTMLButtonElement).click();
    await settle(5);
    (document.querySelector('.confirm-accept') as HTMLButtonElement).click();
    await settle();

    expect(deletes()).toHaveLength(1);
    expect(String(deletes()[0][0])).toBe(
      window.location.origin + '/api/v1/assets/' + ULID + '/subtitle-tracks/sub-1'
    );
    expect(state.subtitles.map((t) => t.id)).toEqual(['sub-2']);
    expect(subtitleRows(container)).toHaveLength(1);
    expect(container.querySelectorAll('#asset-tracks')).toHaveLength(1);
  });

  it('surfaces a server refusal inline on the panel, never as an alert', async () => {
    const { spy } = writableFetch(EDITORIAL_SUBTITLES);
    const failing = vi.fn(async (url: string, init: any = {}) => {
      if (/\/subtitle-tracks$/.test(String(url)) && String(init?.method) === 'POST') {
        return json({ error: 'not_found', message: 'asset not found' }, 404);
      }
      return spy(url, init);
    });
    vi.stubGlobal('fetch', failing);
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    const form = addForm(container);
    form.language.value = 'de';
    form.submit.click();
    await settle();

    expect(noticeEl(container)!.textContent).toBe(TRACKS_COPY.errAddNotFound);
    expect(alertSpy).not.toHaveBeenCalled();
    // The change was NOT silently dropped: the list still shows what the server has.
    expect(subtitleRows(container)).toHaveLength(2);
  });
});
