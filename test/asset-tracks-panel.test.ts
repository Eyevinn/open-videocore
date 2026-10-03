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
//     but is NOT a second source for the EDITORIAL tracks: its handler returns
//     `asset.audioTracks ?? []` / `asset.subtitleTracks ?? []` from the same
//     document (`repo.get(request.params.id)`). A caller holding the asset would
//     be paying a round-trip for bytes it has, so the panel does not call it —
//     asserted below. (Since #1066 that response ALSO carries `videoTracks`,
//     likewise derived from the same document's `technicalMetadata`, so it is
//     still not a second source for this panel.)
//
//   There is NO GET on /api/v1/assets/{id}/audio-tracks or …/subtitle-tracks —
//     those paths carry only `post`, and …/{trackId} only `delete`
//     (src/routes/assets.ts:5279, 5314, 5344, 5392).
//
//   VIDEO — no path in openapi.json contains "video" and no response schema
//     carries a video-track array. The only video attributes exposed anywhere are
//     on `technicalMetadata` (GET /api/v1/assets/{id} 200 schema, nullable object,
//     NOT in `required`): { codec, width, height, durationSeconds, bitrateBps,
//     containerFormat, audioTracks[], extractedAt } all required, plus the
//     OPTIONAL `frameRate` / `startTimecode` added in #1066;
//     additionalProperties: false (technicalMetadataSchema,
//     src/routes/assets.ts, with technicalMetadataError alongside it).
//     The TRACK-level ones are exactly the tuple the persistence layer writes
//     into the document's video track array — `technical.video = [{ codec, width,
//     height, bitrateBps, frameRate?, startTimecode? }]`
//     (src/data/asset-document.ts technicalFromAsset), read back as
//     `technical.video?.[0]` — so the API can report at most ONE video track per
//     asset. This panel lifts the four that predate #1066; `index` exists on the
//     stored VideoTrackSchema but no response exposes it.
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
  TRACKS_COPY,
  attr,
  bitrateLabel,
  editorialTracksFromAsset,
  mountAssetTracks,
  probedAudioStreamsFromAsset,
  renderTracksBlock,
  resolutionLabel,
  sampleRateLabel,
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
