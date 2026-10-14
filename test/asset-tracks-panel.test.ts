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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetDetailBody } from '../public/app.js';
import {
  SUBTITLE_FORMATS,
  SUBTITLE_LABEL_MAX,
  SUBTITLE_LANGUAGE_MAX,
  TRACKS_COPY,
  appendSubtitleTrack,
  attr,
  bitrateLabel,
  buildAddSubtitleBody,
  classifySubtitleWriteError,
  editorialTracksFromAsset,
  mountAssetTracks,
  probedAudioStreamsFromAsset,
  removeSubtitleConfirmSpec,
  removeSubtitleTrackById,
  renderTracksBlock,
  resolutionLabel,
  sampleRateLabel,
  subtitleTrackSubject,
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

  // #940 adds subtitle add/remove, so "no control anywhere" is no longer the
  // panel's contract — but it IS still the contract for a caller that does not
  // opt in, and #902's video/audio sections stay read-only unconditionally
  // (the API exposes no video-track route at all).
  it('creates no control at all when the caller does not opt into the write path', () => {
    const root = render({
      video: videoTracksFromAsset(ASSET),
      audioEditorial: EDITORIAL_AUDIO,
      audioProbed: TECHNICAL.audioTracks,
      subtitles: EDITORIAL_SUBTITLES,
    });
    const block = root.querySelector('#asset-tracks')!;
    expect(block.querySelectorAll('button, input, select, textarea, form, a')).toHaveLength(0);
    expect(block.textContent).toContain(TRACKS_COPY.intro);
  });

  it('keeps the video and audio sections control-free even with the write path on', () => {
    const root = render({
      video: videoTracksFromAsset(ASSET),
      audioEditorial: EDITORIAL_AUDIO,
      audioProbed: TECHNICAL.audioTracks,
      subtitles: EDITORIAL_SUBTITLES,
      subtitleControls: { canChange: true, canRemove: true },
    });
    const block = root.querySelector('#asset-tracks')!;
    // Everything interactive is inside the subtitle section: the add form, or a
    // Remove button in the subtitle table.
    const controls = Array.from(block.querySelectorAll('button, input, select, textarea, form'));
    expect(controls.length).toBeGreaterThan(0);
    controls.forEach((node) => {
      const inForm = node.closest('.subtitle-add-form') !== null;
      const inSubtitleTable = node.classList.contains('subtitle-remove');
      expect(inForm || inSubtitleTable).toBe(true);
    });
    // And the intro no longer claims the whole block is read-only.
    expect(block.textContent).toContain(TRACKS_COPY.introWritableSubtitles);
    expect(block.textContent).not.toContain(TRACKS_COPY.intro);
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
// Subtitle add / remove (issue #940, broken out of #794)
//
// CONTRACT GROUNDING for this block — read from the route source and the
// generated spec on this branch before a single assertion was written
// (CLAUDE.md rule 7), never from the issue text:
//
//   POST /api/v1/assets/{id}/subtitle-tracks
//     (openapi.json .paths["/api/v1/assets/{id}/subtitle-tracks"].post — the
//      ONLY key on that path object is `post`; there is no GET.)
//     requestBody REQUIRED, application/json, additionalProperties: false,
//       required ["language","format"]:
//         language  string, minLength 1, maxLength 64
//         format    string, enum ["vtt","srt","ttml"]
//         label     string, minLength 1, maxLength 128  (optional)
//         default   boolean                             (optional)
//       Source: `addSubtitleTrackSchema`, src/routes/assets.ts:834-839, wired as
//       `body: addSubtitleTrackSchema` at :5676 on
//       `app.post('/:id/subtitle-tracks', …)` :5670-5712. Format vocabulary:
//       `subtitleFormatSchema = z.enum(SUBTITLE_FORMATS)` (:813) over
//       `SUBTITLE_FORMATS = ['vtt','srt','ttml']` (src/data/asset-repo.ts:449).
//     201 = { track, uploadUrl? }, required ["track"],
//       additionalProperties: false. `track` is `subtitleTrackOutSchema`
//       (:815-822) and is literally the object the handler persisted — built
//       :5698-5707, written `repo.update(asset.id, { subtitleTracks })` :5709,
//       sent :5710 — appended to the server's own array at :5708.
//     404 = { error, message? } for an unknown/foreign asset (:5685-5687).
//     400 is NOT declared but IS reachable: the router's setErrorHandler
//       (:2837-2914) rethrows what it cannot classify, so a body failing
//       addSubtitleTrackSchema gets Fastify's 400. Asserted by the API's own
//       suite — `format: 'sub'` -> 400, test/tracks.test.ts:223-233.
//
//   DELETE /api/v1/assets/{id}/subtitle-tracks/{trackId}
//     (…].delete — the ONLY key on that path object.)
//     parameters: exactly two path params (`id`, `trackId`), both string +
//       required. NO body. NO query params — there is no `?force=` here.
//     204 (null) on removal; 404 { error, message? } for an unknown/foreign
//       asset (:5729-5731) OR no track with that id (:5734-5736).
//     Removes the TRACK RECORD only: the handler filters + persists
//       (:5732-5737) and the route comment states it "Leaves the subtitle object
//       (if any) in storage" (:5714).
//     Source: `app.delete('/:id/subtitle-tracks/:trackId', …)`, :5718-5740.
//
//   Both writes sit behind `resourceAuthorizationPreHandler('asset')`
//     (src/auth/authorize.ts:126, registered src/routes/assets.ts:1773) with the
//     action from `methodToAction` (:79-93): POST -> write, DELETE -> delete.
//     `MATRIX` (:54-58) gives a `viewer` NEITHER, so a viewer gets no controls
//     and a 403 (`AUTHZ_FORBIDDEN_ERROR`, :99) if one ever fires.
//
//   There is NO PATCH/PUT on either track path, so nothing here tests "edit".
// ─────────────────────────────────────────────────────────────────────────────

/** A 201 body, shaped exactly as the response schema declares it. */
const CREATED = {
  track: {
    id: 'sub-3',
    language: 'de',
    format: 'vtt',
    objectKey: 'subtitles/' + ULID + '/sub-3.vtt',
    label: 'German',
  },
  uploadUrl: 'https://store.example/' + ULID + '/sub-3.vtt?signature=deadbeef&expires=1800',
};

/** An apiFetch rejection, shaped as public/app.js:304-308 builds it. */
function apiError(status: number, message: string, body?: unknown) {
  const err = new Error(message) as Error & { status: number; body?: unknown };
  err.status = status;
  err.body = body === undefined ? { error: 'x', message } : body;
  return err;
}

describe('buildAddSubtitleBody — mirrors addSubtitleTrackSchema', () => {
  it('sends ONLY the declared properties, because the schema forbids extras', () => {
    const r = buildAddSubtitleBody({
      language: 'de',
      format: 'vtt',
      label: 'German',
      default: true,
      // Not a declared property. additionalProperties: false makes it a 400, so
      // it must not survive into the body.
      objectKey: 'nope',
      id: 'nope',
    } as never);
    expect(r.ok).toBe(true);
    expect((r as { body: object }).body).toEqual({
      language: 'de',
      format: 'vtt',
      label: 'German',
      default: true,
    });
  });

  it('requires language and format — the schema’s two required fields', () => {
    expect(buildAddSubtitleBody({ format: 'vtt' })).toMatchObject({
      ok: false,
      field: 'language',
      message: TRACKS_COPY.errLanguageRequired,
    });
    // Whitespace is not a language: min(1) would store " ".
    expect(buildAddSubtitleBody({ language: '   ', format: 'vtt' })).toMatchObject({
      ok: false,
      field: 'language',
    });
    expect(buildAddSubtitleBody({ language: 'de', format: '' })).toMatchObject({
      ok: false,
      field: 'format',
      message: TRACKS_COPY.errFormatRequired,
    });
  });

  it('refuses a format outside the enum rather than letting the API 400 on it', () => {
    // `dfxp` is a real subtitle format and is still not in SUBTITLE_FORMATS.
    expect(buildAddSubtitleBody({ language: 'de', format: 'dfxp' })).toMatchObject({
      ok: false,
      field: 'format',
    });
    SUBTITLE_FORMATS.forEach((fmt) => {
      expect(buildAddSubtitleBody({ language: 'de', format: fmt }).ok).toBe(true);
    });
  });

  it('enforces the same maxLengths the schema declares', () => {
    expect(SUBTITLE_LANGUAGE_MAX).toBe(64);
    expect(SUBTITLE_LABEL_MAX).toBe(128);
    expect(
      buildAddSubtitleBody({ language: 'a'.repeat(65), format: 'vtt' })
    ).toMatchObject({ ok: false, field: 'language' });
    expect(buildAddSubtitleBody({ language: 'a'.repeat(64), format: 'vtt' }).ok).toBe(true);
    expect(
      buildAddSubtitleBody({ language: 'de', format: 'vtt', label: 'x'.repeat(129) })
    ).toMatchObject({ ok: false, field: 'label' });
    expect(
      buildAddSubtitleBody({ language: 'de', format: 'vtt', label: 'x'.repeat(128) }).ok
    ).toBe(true);
  });

  it('OMITS a blank label instead of sending "", which min(1) would refuse', () => {
    const r = buildAddSubtitleBody({ language: 'de', format: 'vtt', label: '   ' });
    expect(r.ok).toBe(true);
    expect(Object.keys((r as { body: object }).body)).toEqual(['language', 'format']);
  });

  it('omits `default` unless it was actually asked for', () => {
    const off = buildAddSubtitleBody({ language: 'de', format: 'vtt', default: false });
    expect(Object.keys((off as { body: object }).body)).toEqual(['language', 'format']);
    const on = buildAddSubtitleBody({ language: 'de', format: 'vtt', default: true });
    expect((on as { body: { default?: boolean } }).body.default).toBe(true);
  });

  it('trims the language it sends', () => {
    const r = buildAddSubtitleBody({ language: '  en-GB  ', format: 'srt' });
    expect((r as { body: { language: string } }).body.language).toBe('en-GB');
  });
});

describe('subtitleTrackSubject / removeSubtitleConfirmSpec', () => {
  it('names a track by label + language + format, never by its id', () => {
    expect(subtitleTrackSubject(EDITORIAL_SUBTITLES[0])).toBe('Swedish — sv (vtt)');
    // `label` is optional in subtitleTrackOutSchema, so language + format is the
    // fallback that is always available.
    expect(subtitleTrackSubject(EDITORIAL_SUBTITLES[1])).toBe('en (srt)');
    expect(subtitleTrackSubject(EDITORIAL_SUBTITLES[0])).not.toContain('sub-1');
  });

  it('still produces a readable name for a track with neither label nor language', () => {
    expect(subtitleTrackSubject({ id: 'sub-9', format: 'ttml' })).toBe('untitled ttml track');
    expect(subtitleTrackSubject({})).toBe('untitled subtitle track');
  });

  it('states what the removal affects AND what it leaves alone', () => {
    const spec = removeSubtitleConfirmSpec(EDITORIAL_SUBTITLES[0]);
    expect(spec.subject).toBe('Swedish — sv (vtt)');
    expect(spec.subject).not.toContain('sub-1');
    expect(spec.affected.length).toBeGreaterThan(0);
    expect(spec.unaffected.length).toBeGreaterThan(0);
    // Verified against the route: the handler filters the array and the comment
    // says the storage object is left behind (src/routes/assets.ts:5714).
    expect(spec.unaffected.join(' ')).toContain('NOT deleted');
    expect(spec.confirmLabel).toBe(TRACKS_COPY.confirmRemoveLabel);
    // Not the blocked variant: this operation answers only 204 or 404.
    expect(spec.blocked).toBeUndefined();
  });
});

describe('classifySubtitleWriteError', () => {
  it('surfaces the server’s own 400 message verbatim — never a silent no-op', () => {
    const c = classifySubtitleWriteError(
      apiError(400, "body/format must be equal to one of the allowed values"),
      'add'
    );
    expect(c.kind).toBe('invalid');
    expect(c.message).toContain('body/format');
    expect(c.forbidden).toBe(false);
  });

  it('treats 401 and 403 as a role refusal and retires the controls', () => {
    [401, 403].forEach((status) => {
      const c = classifySubtitleWriteError(apiError(status, 'forbidden_insufficient_role'), 'add');
      expect(c.kind).toBe('forbidden');
      expect(c.forbidden).toBe(true);
      expect(c.message).toBe(TRACKS_COPY.errForbidden);
    });
  });

  it('reads a 404 differently per operation, because the route does', () => {
    // POST: the only 404 is the asset (src/routes/assets.ts:5685-5687).
    const add = classifySubtitleWriteError(apiError(404, 'not_found'), 'add');
    expect(add.kind).toBe('asset-gone');
    expect(add.retire).toBe(false);
    // DELETE: unknown asset OR unknown track (:5729-5731 / :5734-5736). Either
    // way the server does not have this track, so the row goes.
    const rm = classifySubtitleWriteError(apiError(404, 'subtitle track not found'), 'remove');
    expect(rm.kind).toBe('gone');
    expect(rm.retire).toBe(true);
  });

  it('distinguishes "never answered" from "answered with a failure"', () => {
    const net = classifySubtitleWriteError(new Error('fetch failed'), 'add');
    expect(net.kind).toBe('network');
    expect(net.message).toBe(TRACKS_COPY.errNetwork);
    const other = classifySubtitleWriteError(apiError(503, 'upstream down'), 'remove');
    expect(other.kind).toBe('other');
    expect(other.message).toContain('upstream down');
  });
});

describe('list arithmetic after a write', () => {
  it('appends the track the 201 returned, where the server appended it', () => {
    const next = appendSubtitleTrack(EDITORIAL_SUBTITLES, CREATED.track);
    expect(next.map((t: any) => t.id)).toEqual(['sub-1', 'sub-2', 'sub-3']);
    // The original is untouched.
    expect(EDITORIAL_SUBTITLES).toHaveLength(2);
  });

  it('ignores a malformed 201 rather than pushing a placeholder row', () => {
    expect(appendSubtitleTrack(EDITORIAL_SUBTITLES, null)).toHaveLength(2);
    expect(appendSubtitleTrack(EDITORIAL_SUBTITLES, undefined)).toHaveLength(2);
  });

  it('drops exactly the removed id, the same filter the handler applies', () => {
    expect(removeSubtitleTrackById(EDITORIAL_SUBTITLES, 'sub-1').map((t: any) => t.id)).toEqual([
      'sub-2',
    ]);
    expect(removeSubtitleTrackById(EDITORIAL_SUBTITLES, 'nope')).toHaveLength(2);
  });
});

describe('the subtitle section with the write path on', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
  });

  function render(controls: object | null) {
    host.innerHTML = '';
    host.appendChild(
      renderTracksBlock({
        video: videoTracksFromAsset(ASSET),
        audioEditorial: EDITORIAL_AUDIO,
        audioProbed: TECHNICAL.audioTracks,
        subtitles: EDITORIAL_SUBTITLES,
        subtitleControls: controls,
      })
    );
    return host;
  }

  it('asks for exactly the four properties the request schema declares', () => {
    const root = render({ canChange: true, canRemove: true });
    const form = root.querySelector('#subtitle-add-form')!;
    const named = Array.from(form.querySelectorAll('input, select')).map((n) =>
      n.getAttribute('name')
    );
    expect(named.sort()).toEqual(['default', 'format', 'label', 'language']);

    // The two required ones are marked required, and say so in words too — the
    // requirement is not conveyed by styling alone.
    expect((root.querySelector('#subtitle-add-language') as HTMLInputElement).required).toBe(true);
    expect((root.querySelector('#subtitle-add-format') as HTMLSelectElement).required).toBe(true);
    expect((root.querySelector('#subtitle-add-label') as HTMLInputElement).required).toBe(false);
    expect(TRACKS_COPY.helpLanguage).toContain('Required');
    expect(TRACKS_COPY.helpFormat).toContain('Required');
  });

  it('offers exactly the enum the API accepts, and nothing else', () => {
    const root = render({ canChange: true, canRemove: true });
    const options = Array.from(root.querySelectorAll('#subtitle-add-format option')).map(
      (o) => (o as HTMLOptionElement).value
    );
    expect(options).toEqual([...SUBTITLE_FORMATS]);
    expect(options).toEqual(['vtt', 'srt', 'ttml']);
  });

  it('caps the two length-limited inputs at the schema’s maxLengths', () => {
    const root = render({ canChange: true, canRemove: true });
    expect((root.querySelector('#subtitle-add-language') as HTMLInputElement).maxLength).toBe(64);
    expect((root.querySelector('#subtitle-add-label') as HTMLInputElement).maxLength).toBe(128);
  });

  it('labels every field and wires its help text for assistive technology', () => {
    const root = render({ canChange: true, canRemove: true });
    ['subtitle-add-language', 'subtitle-add-format', 'subtitle-add-label'].forEach((id) => {
      const field = root.querySelector('#' + id)!;
      const label = root.querySelector('label[for="' + id + '"]')!;
      expect(label).not.toBeNull();
      expect((label.textContent || '').trim()).not.toBe('');
      const describedBy = field.getAttribute('aria-describedby')!;
      expect(root.querySelector('#' + describedBy)).not.toBeNull();
    });
    // The checkbox is wrapped by its own label, so it needs no `for`.
    const checkbox = root.querySelector('#subtitle-add-default')!;
    expect(checkbox.closest('label')).not.toBeNull();
  });

  it('warns that `default` is not exclusive, because the API does not clear it', () => {
    const root = render({ canChange: true, canRemove: true });
    const help = root.querySelector('#subtitle-add-default-help')!;
    expect(help.textContent).toBe(TRACKS_COPY.addDefaultNote);
    // A checkbox, not a radio group: a radio group would imply the API enforces
    // one winner, and it does not (src/routes/assets.ts:5698-5707).
    expect((root.querySelector('#subtitle-add-default') as HTMLInputElement).type).toBe('checkbox');
    expect(root.querySelectorAll('#subtitle-add-form input[type="radio"]')).toHaveLength(0);
  });

  it('says the add registers a track and does NOT upload a subtitle file', () => {
    const root = render({ canChange: true, canRemove: true });
    expect(root.querySelector('#subtitle-add-form')!.textContent).toContain(
      TRACKS_COPY.addFileNote
    );
  });

  it('gives each row a Remove control whose accessible name says which track', () => {
    const root = render({ canChange: true, canRemove: true });
    const buttons = Array.from(root.querySelectorAll('button.subtitle-remove'));
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.getAttribute('data-track-id'))).toEqual(['sub-1', 'sub-2']);
    // WCAG 2.4.6 (distinguishable) + 2.5.3 (the accessible name starts with the
    // visible text, so speech input still matches "Remove").
    expect(buttons[0].textContent).toBe(TRACKS_COPY.btnRemove);
    expect(buttons[0].getAttribute('aria-label')).toBe(
      'Remove subtitle track Swedish — sv (vtt)'
    );
    expect(buttons[1].getAttribute('aria-label')).toBe('Remove subtitle track en (srt)');
    // Marked as the destructive one.
    expect(buttons[0].classList.contains('btn-danger')).toBe(true);
  });

  it('adds the Remove column header only when a Remove control is offered', () => {
    const withRemove = render({ canChange: true, canRemove: true });
    expect(headerCells(withRemove, 3)).toEqual([
      'Language',
      'Label',
      'Format',
      'Default',
      'Object key',
      'Track ID',
      TRACKS_COPY.colRemove,
    ]);

    // No confirmation dialog available -> no destructive control at all, and no
    // header advertising one.
    const withoutRemove = render({ canChange: true, canRemove: false });
    expect(headerCells(withoutRemove, 3)).not.toContain(TRACKS_COPY.colRemove);
    expect(withoutRemove.querySelectorAll('button.subtitle-remove')).toHaveLength(0);
    // The add form is unaffected: adding is not the destructive half.
    expect(withoutRemove.querySelector('#subtitle-add-form')).not.toBeNull();
  });

  it('offers no control to a role that cannot write, and says why', () => {
    const root = render({ canChange: false, canRemove: true });
    expect(root.querySelector('#subtitle-add-form')).toBeNull();
    expect(root.querySelectorAll('button.subtitle-remove')).toHaveLength(0);
    expect(headerCells(root, 3)).not.toContain(TRACKS_COPY.colRemove);
    expect(root.querySelector('#asset-tracks')!.textContent).toContain(TRACKS_COPY.roleNote);
  });

  it('gives the subtitle section its own live region for outcomes', () => {
    const root = render({ canChange: true, canRemove: true });
    const msg = root.querySelector('#subtitle-track-msg')!;
    expect(msg).not.toBeNull();
    expect(msg.getAttribute('aria-live')).toBe('polite');
    expect(msg.getAttribute('role')).toBe('status');
    // Inside the Tracks block, next to the controls — not a page-level toast.
    expect(msg.closest('#asset-tracks')).not.toBeNull();
  });

  it('still shows the add form when the asset has no subtitle track at all', () => {
    host.innerHTML = '';
    host.appendChild(
      renderTracksBlock({ subtitles: [], subtitleControls: { canChange: true, canRemove: true } })
    );
    // The empty state and the way out of it, together.
    expect(host.querySelector('[data-empty="subtitle-tracks"]')).not.toBeNull();
    expect(host.querySelector('#subtitle-add-form')).not.toBeNull();
  });

  it('offers no Remove control for a track the server sent without an id', () => {
    // `id` is `required` on subtitleTrackOutSchema, so this is a non-conforming
    // server — but the row is still real, and a button here would build
    // `/subtitle-tracks/undefined`.
    host.innerHTML = '';
    host.appendChild(
      renderTracksBlock({
        subtitles: [{ language: 'de', format: 'vtt' }],
        subtitleControls: { canChange: true, canRemove: true },
      })
    );
    expect(host.querySelectorAll('button.subtitle-remove')).toHaveLength(0);
    expect(host.querySelector('#asset-tracks table')).not.toBeNull();
  });
});

describe('mountAssetTracks — subtitle add', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  function mount(over: Record<string, unknown> = {}) {
    const apiFetch = vi.fn(async () => CREATED);
    const confirmModal = vi.fn(async () => true);
    const mounted = mountAssetTracks({
      asset: ASSET,
      host,
      assetId: ULID,
      apiFetch,
      confirmModal,
      ...over,
    });
    return { mounted, apiFetch: (over.apiFetch as typeof apiFetch) || apiFetch, confirmModal };
  }

  function fill(language: string, format: string, label = '', isDefault = false) {
    (host.querySelector('#subtitle-add-language') as HTMLInputElement).value = language;
    (host.querySelector('#subtitle-add-format') as HTMLSelectElement).value = format;
    (host.querySelector('#subtitle-add-label') as HTMLInputElement).value = label;
    (host.querySelector('#subtitle-add-default') as HTMLInputElement).checked = isDefault;
  }

  function submit() {
    (host.querySelector('#subtitle-add-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true })
    );
  }

  function msgText() {
    const el = host.querySelector('#subtitle-track-msg');
    return (el && el.textContent) || '';
  }

  it('POSTs to the sub-resource path with exactly the declared body', async () => {
    const { apiFetch } = mount();
    fill('de', 'vtt', 'German', true);
    submit();
    await settle(5);

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    // The sub-resource path takes the ULID — these routes pass params.id to
    // repo.get and do NOT resolve a slug.
    expect(path).toBe('/assets/' + ULID + '/subtitle-tracks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      language: 'de',
      format: 'vtt',
      label: 'German',
      default: true,
    });
  });

  it('shows the track the 201 returned in the list, and reports it inline', async () => {
    mount();
    expect(host.querySelectorAll('button.subtitle-remove')).toHaveLength(2);

    fill('de', 'vtt', 'German');
    submit();
    await settle(5);

    // Appended where the server appended it (src/routes/assets.ts:5708).
    const rows = tableRows(host, 3);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual([
      'de',
      'German',
      'vtt',
      '—',
      'subtitles/' + ULID + '/sub-3.vtt',
      'sub-3',
      // The new row is addressable like any other: it has its own Remove cell.
      TRACKS_COPY.btnRemove,
    ]);
    expect(msgText()).toContain(TRACKS_COPY.addedPrefix);
    expect(msgText()).toContain('German — de (vtt)');
  });

  it('never prints the presigned uploadUrl into the DOM', async () => {
    mount();
    fill('de', 'vtt');
    submit();
    await settle(5);

    // It is a short-lived credential; the object key it points at is already in
    // the table, which is the part an operator needs.
    expect(host.textContent).not.toContain('signature=deadbeef');
    expect(host.textContent).not.toContain(CREATED.uploadUrl);
    expect(host.textContent).toContain('subtitles/' + ULID + '/sub-3.vtt');
  });

  it('clears the form after a success so the next add starts clean', async () => {
    mount();
    fill('de', 'vtt', 'German', true);
    submit();
    await settle(5);

    expect((host.querySelector('#subtitle-add-language') as HTMLInputElement).value).toBe('');
    expect((host.querySelector('#subtitle-add-label') as HTMLInputElement).value).toBe('');
    expect((host.querySelector('#subtitle-add-default') as HTMLInputElement).checked).toBe(false);
  });

  it('refuses a missing language at the control without calling the API', async () => {
    const { apiFetch } = mount();
    fill('', 'vtt');
    submit();
    await settle(5);

    expect(apiFetch).not.toHaveBeenCalled();
    // Inline, next to the control — never a silent no-op (#940 AC3).
    expect(msgText()).toContain(TRACKS_COPY.errLanguageRequired);
    expect(
      (host.querySelector('#subtitle-add-language') as HTMLInputElement).getAttribute(
        'aria-invalid'
      )
    ).toBe('true');
  });

  it('keeps keyboard focus in the section after the re-render (WCAG 2.4.3)', async () => {
    mount();
    fill('de', 'vtt');
    submit();
    await settle(5);

    // The submit button the operator was standing on was destroyed by the
    // re-render; focus must not have fallen to the document.
    expect(document.activeElement).toBe(host.querySelector('#subtitle-add-language'));
  });

  it('clears a field marking once that field is no longer the problem', async () => {
    const { apiFetch } = mount();
    fill('', 'vtt');
    submit();
    await settle(5);
    const language = host.querySelector('#subtitle-add-language') as HTMLInputElement;
    expect(language.getAttribute('aria-invalid')).toBe('true');
    expect(apiFetch).not.toHaveBeenCalled();

    // Fixed. The stale mark must not survive the next attempt.
    fill('de', 'vtt');
    submit();
    await settle(5);
    expect(
      (host.querySelector('#subtitle-add-language') as HTMLInputElement).getAttribute(
        'aria-invalid'
      )
    ).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces the API’s own 400 inline and keeps what the operator typed', async () => {
    const apiFetch = vi.fn(async () => {
      throw apiError(400, 'body/format must be equal to one of the allowed values');
    });
    mount({ apiFetch });
    fill('de', 'vtt', 'German');
    submit();
    await settle(5);

    expect(msgText()).toContain('body/format');
    // The form is NOT rebuilt on a failure: the typed values survive and the
    // button is usable again.
    expect((host.querySelector('#subtitle-add-language') as HTMLInputElement).value).toBe('de');
    expect((host.querySelector('#subtitle-add-label') as HTMLInputElement).value).toBe('German');
    expect((host.querySelector('#subtitle-add-submit') as HTMLButtonElement).disabled).toBe(false);
    expect((host.querySelector('#subtitle-add-submit') as HTMLButtonElement).textContent).toBe(
      TRACKS_COPY.btnAdd
    );
    // And nothing was added to the list.
    expect(tableRows(host, 3)).toHaveLength(2);
  });

  it('reports a 404 as the asset being gone, not as a bad field', async () => {
    const apiFetch = vi.fn(async () => {
      throw apiError(404, 'not_found');
    });
    mount({ apiFetch });
    fill('de', 'vtt');
    submit();
    await settle(5);

    expect(msgText()).toBe(TRACKS_COPY.errAssetGone);
    expect(tableRows(host, 3)).toHaveLength(2);
  });

  it('retires the controls on a 403 rather than inviting a second refusal', async () => {
    const apiFetch = vi.fn(async () => {
      throw apiError(403, 'forbidden_insufficient_role');
    });
    mount({ apiFetch });
    fill('de', 'vtt');
    submit();
    await settle(5);

    // The refusal still has to be SAID: retirement withdraws the controls, not
    // the message region they reported into.
    expect(msgText()).toBe(TRACKS_COPY.errForbidden);
    expect(host.querySelector('#subtitle-add-form')).toBeNull();
    expect(host.querySelectorAll('button.subtitle-remove')).toHaveLength(0);
    expect(headerCells(host, 3)).not.toContain(TRACKS_COPY.colRemove);
    // The read-only panel is still there, and says why the controls went.
    expect(tableRows(host, 3)).toHaveLength(2);
    expect(host.querySelector('#asset-tracks')!.textContent).toContain(TRACKS_COPY.roleNote);
  });

  it('reports a request that never got an answer as exactly that', async () => {
    const apiFetch = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    mount({ apiFetch });
    fill('de', 'vtt');
    submit();
    await settle(5);

    expect(msgText()).toBe(TRACKS_COPY.errNetwork);
  });

  it('tells the caller the new subtitle list after a success', async () => {
    const onTracksChanged = vi.fn();
    mount({ onTracksChanged });
    fill('de', 'vtt');
    submit();
    await settle(5);

    expect(onTracksChanged).toHaveBeenCalledTimes(1);
    expect((onTracksChanged.mock.calls[0][0] as any[]).map((t) => t.id)).toEqual([
      'sub-1',
      'sub-2',
      'sub-3',
    ]);
  });

  it('shows only the latest outcome, never a stale success above a fresh failure', async () => {
    let fail = false;
    const apiFetch = vi.fn(async () => {
      if (fail) throw apiError(400, 'body/language must NOT have fewer than 1 characters');
      return CREATED;
    });
    mount({ apiFetch });

    fill('de', 'vtt');
    submit();
    await settle(5);
    expect(msgText()).toContain(TRACKS_COPY.addedPrefix);

    fail = true;
    fill('de', 'vtt');
    submit();
    await settle(5);
    expect(msgText()).toContain('body/language');
    expect(msgText()).not.toContain(TRACKS_COPY.addedPrefix);
  });
});

describe('mountAssetTracks — subtitle remove', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  function mount(over: Record<string, unknown> = {}) {
    const apiFetch = vi.fn(async () => null);
    const confirmModal = vi.fn(async () => true);
    mountAssetTracks({
      asset: ASSET,
      host,
      assetId: ULID,
      apiFetch,
      confirmModal,
      ...over,
    });
    return {
      apiFetch: (over.apiFetch as typeof apiFetch) || apiFetch,
      confirmModal: (over.confirmModal as typeof confirmModal) || confirmModal,
    };
  }

  function clickRemove(trackId: string) {
    (
      host.querySelector('button.subtitle-remove[data-track-id="' + trackId + '"]') as HTMLElement
    ).click();
  }

  function msgText() {
    const el = host.querySelector('#subtitle-track-msg');
    return (el && el.textContent) || '';
  }

  it('confirms BEFORE the destructive call, naming the track in words', async () => {
    const { apiFetch, confirmModal } = mount();
    clickRemove('sub-1');
    await settle(5);

    expect(confirmModal).toHaveBeenCalledTimes(1);
    const spec = confirmModal.mock.calls[0][0] as any;
    expect(spec.subject).toBe('Swedish — sv (vtt)');
    expect(spec.affected.length).toBeGreaterThan(0);
    expect(spec.unaffected.length).toBeGreaterThan(0);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    // The confirmation resolved first.
    expect(confirmModal.mock.invocationCallOrder[0]).toBeLessThan(
      apiFetch.mock.invocationCallOrder[0]
    );
  });

  it('sends nothing when the confirmation is declined', async () => {
    const confirmModal = vi.fn(async () => false);
    const { apiFetch } = mount({ confirmModal });
    clickRemove('sub-1');
    await settle(5);

    expect(confirmModal).toHaveBeenCalledTimes(1);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(tableRows(host, 3)).toHaveLength(2);
    // A cancel is not a failure, so nothing is reported.
    expect(msgText()).toBe('');
  });

  it('DELETEs the track path with no body and no query parameters', async () => {
    const { apiFetch } = mount();
    clickRemove('sub-2');
    await settle(5);

    const [path, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/assets/' + ULID + '/subtitle-tracks/sub-2');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    // There is no `?force=` on this operation.
    expect(path).not.toContain('?');
  });

  it('drops the row on a 204 and reports it inline', async () => {
    mount();
    clickRemove('sub-1');
    await settle(5);

    expect(tableRows(host, 3).map((r) => r[5])).toEqual(['sub-2']);
    expect(msgText()).toContain(TRACKS_COPY.removedPrefix);
    expect(msgText()).toContain('Swedish — sv (vtt)');
  });

  it('drops the row on a 404 too, because the server does not have it either way', async () => {
    const apiFetch = vi.fn(async () => {
      throw apiError(404, 'subtitle track not found');
    });
    mount({ apiFetch });
    clickRemove('sub-1');
    await settle(5);

    expect(tableRows(host, 3).map((r) => r[5])).toEqual(['sub-2']);
    expect(msgText()).toBe(TRACKS_COPY.errTrackGone);
  });

  it('keeps the row and re-enables the control when the call simply failed', async () => {
    const apiFetch = vi.fn(async () => {
      throw apiError(503, 'upstream down');
    });
    mount({ apiFetch });
    clickRemove('sub-1');
    await settle(5);

    expect(tableRows(host, 3)).toHaveLength(2);
    const btn = host.querySelector(
      'button.subtitle-remove[data-track-id="sub-1"]'
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe(TRACKS_COPY.btnRemove);
    expect(msgText()).toContain('upstream down');
  });

  it('moves focus onto the row that took the removed one\u2019s place', async () => {
    mount();
    clickRemove('sub-1');
    await settle(5);

    // sub-1 was row 0; row 0 is now sub-2's control.
    expect(document.activeElement).toBe(
      host.querySelector('button.subtitle-remove[data-track-id="sub-2"]')
    );
  });

  it('falls back to the add form when the row removed was the last one', async () => {
    const apiFetch = vi.fn(async () => null);
    host.innerHTML = '';
    mountAssetTracks({
      asset: { id: ULID, subtitleTracks: [EDITORIAL_SUBTITLES[0]] },
      host,
      assetId: ULID,
      apiFetch,
      confirmModal: vi.fn(async () => true),
    });
    clickRemove('sub-1');
    await settle(5);

    expect(host.querySelectorAll('button.subtitle-remove')).toHaveLength(0);
    expect(document.activeElement).toBe(host.querySelector('#subtitle-add-language'));
  });

  it('tells the caller the new subtitle list after a removal', async () => {
    const onTracksChanged = vi.fn();
    mount({ onTracksChanged });
    clickRemove('sub-1');
    await settle(5);

    expect((onTracksChanged.mock.calls[0][0] as any[]).map((t) => t.id)).toEqual(['sub-2']);
  });

  it('offers no remove control at all without a confirmation dialog to gate it', () => {
    mount({ confirmModal: undefined });
    // #940 requires a confirmation step, so the destructive call gets no
    // unconfirmed path to exist on.
    expect(host.querySelectorAll('button.subtitle-remove')).toHaveLength(0);
    expect(headerCells(host, 3)).not.toContain(TRACKS_COPY.colRemove);
    // Adding is unaffected.
    expect(host.querySelector('#subtitle-add-form')).not.toBeNull();
  });

  it('issues no call and offers no control without an apiFetch or an assetId', () => {
    const confirmModal = vi.fn(async () => true);
    host.innerHTML = '';
    mountAssetTracks({ asset: ASSET, host, confirmModal });
    expect(host.querySelector('#subtitle-add-form')).toBeNull();
    expect(host.querySelectorAll('button.subtitle-remove')).toHaveLength(0);
    expect(host.querySelector('#subtitle-track-msg')).toBeNull();

    host.innerHTML = '';
    const apiFetch = vi.fn(async () => CREATED);
    mountAssetTracks({ asset: ASSET, host, apiFetch, confirmModal });
    expect(host.querySelector('#subtitle-add-form')).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('re-seeds from the asset on update(), discarding its own list', async () => {
    const mounted = mountAssetTracks({
      asset: ASSET,
      host,
      assetId: ULID,
      apiFetch: vi.fn(async () => null),
      confirmModal: vi.fn(async () => true),
    });
    clickRemove('sub-1');
    await settle(5);
    expect(tableRows(host, 3)).toHaveLength(1);

    // The caller re-read the asset; its copy wins.
    mounted.update(ASSET);
    expect(tableRows(host, 3)).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detail view integration — the REAL renderer, the REAL apiFetch, the REAL
// confirmation dialog. This is what proves the panel's path composition and the
// role gate match the routes, rather than matching a stub of them.
// ─────────────────────────────────────────────────────────────────────────────

describe('asset detail — subtitle track controls (issue #940)', () => {
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
  });

  /** routedFetch plus the two subtitle writes. */
  function writableFetch(opts: { addStatus?: number; addBody?: unknown; delStatus?: number } = {}) {
    const base = routedFetch();
    return vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const method = (init && init.method) || 'GET';
      if (/\/subtitle-tracks$/.test(path) && method === 'POST') {
        const status = opts.addStatus || 201;
        return json(status === 201 ? opts.addBody || CREATED : { error: 'bad_request', message: opts.addBody }, status);
      }
      if (/\/subtitle-tracks\/[^/]+$/.test(path) && method === 'DELETE') {
        const status = opts.delStatus || 204;
        if (status === 204) return new Response(null, { status: 204 });
        return json({ error: 'not_found', message: 'subtitle track not found' }, status);
      }
      return base(path);
    });
  }

  it('POSTs to the real route with the real client when a track is added', async () => {
    const fetchSpy = writableFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    // Nothing was sent on render.
    expect(
      fetchSpy.mock.calls.filter((c) => /\/subtitle-tracks/.test(String(c[0])))
    ).toHaveLength(0);

    (container.querySelector('#subtitle-add-language') as HTMLInputElement).value = 'de';
    (container.querySelector('#subtitle-add-format') as HTMLSelectElement).value = 'ttml';
    (container.querySelector('#subtitle-add-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true })
    );
    await settle();

    const post = fetchSpy.mock.calls.find((c) => {
      const init = c[1] as RequestInit | undefined;
      return init && init.method === 'POST' && /\/subtitle-tracks$/.test(String(c[0]));
    })!;
    expect(String(post[0])).toBe(
      window.location.origin + '/api/v1/assets/' + ULID + '/subtitle-tracks'
    );
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      language: 'de',
      format: 'ttml',
    });
    // The returned track is on screen.
    expect(sectionText(container, TRACKS_COPY.subtitleHeading)).toContain('sub-3');
    expect(container.querySelector('#subtitle-track-msg')!.textContent).toContain(
      TRACKS_COPY.addedPrefix
    );
  });

  it('goes through the house confirmation dialog before the real DELETE', async () => {
    const fetchSpy = writableFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    (
      container.querySelector(
        'button.subtitle-remove[data-track-id="sub-1"]'
      ) as HTMLElement
    ).click();
    await settle(5);

    // The ONE confirmation primitive in this UI (issue #919), not a native
    // confirm() and not a second bespoke dialog.
    const dialog = document.querySelector('.confirm-dialog') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('Swedish — sv (vtt)');
    expect(dialog.textContent).toContain('What this affects');
    expect(dialog.textContent).toContain('What this does not affect');
    // Nothing has been sent yet.
    expect(
      fetchSpy.mock.calls.filter((c) => {
        const init = c[1] as RequestInit | undefined;
        return init && init.method === 'DELETE';
      })
    ).toHaveLength(0);

    (dialog.querySelector('.confirm-accept') as HTMLElement).click();
    await settle();

    const del = fetchSpy.mock.calls.find((c) => {
      const init = c[1] as RequestInit | undefined;
      return init && init.method === 'DELETE';
    })!;
    expect(String(del[0])).toBe(
      window.location.origin + '/api/v1/assets/' + ULID + '/subtitle-tracks/sub-1'
    );
    expect(sectionText(container, TRACKS_COPY.subtitleHeading)).not.toContain('sub-1');
    expect(container.querySelector('#subtitle-track-msg')!.textContent).toContain(
      TRACKS_COPY.removedPrefix
    );
  });

  it('sends no DELETE when the operator dismisses the confirmation', async () => {
    const fetchSpy = writableFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    (
      container.querySelector(
        'button.subtitle-remove[data-track-id="sub-1"]'
      ) as HTMLElement
    ).click();
    await settle(5);
    (document.querySelector('.confirm-cancel') as HTMLElement).click();
    await settle();

    expect(
      fetchSpy.mock.calls.filter((c) => {
        const init = c[1] as RequestInit | undefined;
        return init && init.method === 'DELETE';
      })
    ).toHaveLength(0);
    expect(sectionText(container, TRACKS_COPY.subtitleHeading)).toContain('sub-1');
  });

  it('surfaces a real 400 body inline, next to the control', async () => {
    const fetchSpy = writableFetch({
      addStatus: 400,
      addBody: 'body/format must be equal to one of the allowed values',
    });
    vi.stubGlobal('fetch', fetchSpy);

    await renderAssetDetailBody(ULID, container);
    await settle();

    (container.querySelector('#subtitle-add-language') as HTMLInputElement).value = 'de';
    (container.querySelector('#subtitle-add-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true })
    );
    await settle();

    const msg = container.querySelector('#subtitle-track-msg')!;
    expect(msg.textContent).toContain('body/format');
    // Inline at the control, inside the Tracks block — not a page-level toast.
    expect(msg.closest('#asset-tracks')).not.toBeNull();
  });

  it('withholds both controls from a viewer, who may neither write nor delete', async () => {
    // `MATRIX` (src/auth/authorize.ts:54-58) gives `viewer` read only, and
    // methodToAction (:79-93) maps POST -> write, DELETE -> delete.
    localStorage.setItem('ovc_role', 'viewer');
    vi.stubGlobal('fetch', writableFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(container.querySelector('#subtitle-add-form')).toBeNull();
    expect(container.querySelectorAll('button.subtitle-remove')).toHaveLength(0);
    // But the read-only panel is intact, because GET is `read` and a viewer has it.
    expect(sectionText(container, TRACKS_COPY.subtitleHeading)).toContain('sub-1');
    expect(container.querySelector('#asset-tracks')!.textContent).toContain(TRACKS_COPY.roleNote);
  });

  it('gives an editor both controls', async () => {
    localStorage.setItem('ovc_role', 'editor');
    vi.stubGlobal('fetch', writableFetch());

    await renderAssetDetailBody(ULID, container);
    await settle();

    expect(container.querySelector('#subtitle-add-form')).not.toBeNull();
    expect(container.querySelectorAll('button.subtitle-remove')).toHaveLength(2);
  });
});
