// @vitest-environment happy-dom
//
// DOM tests for the read-only tracks panel on the asset detail view (issue
// #902). We exercise renderAssetTracks(assetId, container) directly — it is the
// exact code path renderAssetDetailBody invokes, and it is exported for reuse by
// the standalone detached detail window (detail.js), so these assertions cover
// both places.
//
// Verified contract — GET /api/v1/assets/{id}/tracks
//   Source: src/routes/assets.ts:5210-5229 (`app.get('/:id/tracks')`,
//   `response: { 200: tracksSchema, 404: errorSchema }`), mirrored in
//   openapi.json "/api/v1/assets/{id}/tracks" (only key: `get`).
//   200 body — tracksSchema (src/routes/assets.ts:831-834):
//     audioTracks[]    (audioTrackOutSchema, src/routes/assets.ts:794-801)
//       required id, language; optional codec, channels, label, default
//     subtitleTracks[] (subtitleTrackOutSchema, src/routes/assets.ts:805-812)
//       required id, language, format ('vtt'|'srt'|'ttml');
//       optional objectKey, label, default
//   Both arrays are required and may be empty. There is no video track in this
//   contract (the sibling /audio-tracks and /subtitle-tracks paths are write-only:
//   post + delete), so the panel has no video section to render.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetTracks } from '../public/app.js';

function mockTracksResponse(payload: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  );
}

const FULL_PAYLOAD = {
  audioTracks: [
    {
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      language: 'sv',
      codec: 'aac',
      channels: 2,
      label: 'Swedish stereo',
      default: true,
    },
    // Only the required fields — every optional omitted.
    { id: 'a1b2c3d4-0000-4000-8000-000000000002', language: 'en' },
  ],
  subtitleTracks: [
    {
      id: 'b1b2c3d4-0000-4000-8000-000000000001',
      language: 'sv',
      format: 'vtt',
      objectKey: 'subtitles/asset-1/b1b2c3d4.vtt',
      label: 'Swedish',
      default: false,
    },
  ],
};

describe('renderAssetTracks — listing', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads the single documented tracks endpoint', async () => {
    const fetchMock = mockTracksResponse(FULL_PAYLOAD);
    vi.stubGlobal('fetch', fetchMock);

    await renderAssetTracks('asset-1', container);

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/assets/asset-1/tracks');
  });

  it('renders one row per audio track with the schema-verified attributes', async () => {
    vi.stubGlobal('fetch', mockTracksResponse(FULL_PAYLOAD));

    await renderAssetTracks('asset-1', container);

    const rows = container.querySelectorAll('tbody tr');
    // 2 audio + 1 subtitle.
    expect(rows.length).toBe(3);

    const text = container.textContent ?? '';
    expect(text).toContain('Audio tracks (2)');
    expect(text).toContain('Swedish stereo');
    expect(text).toContain('aac');
    expect(text).toContain('a1b2c3d4-0000-4000-8000-000000000001');
    // `default: true` is badged; the second track's omitted optionals render as
    // an em dash rather than being dropped.
    expect(text).toContain('default');
    expect(text).toContain('—');
  });

  it('renders subtitle tracks with language, format and object key', async () => {
    vi.stubGlobal('fetch', mockTracksResponse(FULL_PAYLOAD));

    await renderAssetTracks('asset-1', container);

    const text = container.textContent ?? '';
    expect(text).toContain('Subtitle tracks (1)');
    expect(text).toContain('vtt');
    expect(text).toContain('subtitles/asset-1/b1b2c3d4.vtt');
  });

  it('is read-only: no add or remove controls anywhere in the panel', async () => {
    vi.stubGlobal('fetch', mockTracksResponse(FULL_PAYLOAD));

    await renderAssetTracks('asset-1', container);

    expect(container.querySelectorAll('button').length).toBe(0);
    expect(container.querySelectorAll('input, select, form').length).toBe(0);
  });

  it('escapes server-provided track text', async () => {
    vi.stubGlobal(
      'fetch',
      mockTracksResponse({
        audioTracks: [{ id: 'x', language: 'en', label: '<img src=x onerror=alert(1)>' }],
        subtitleTracks: [],
      })
    );

    await renderAssetTracks('asset-1', container);

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('renderAssetTracks — per-kind empty states', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows an explicit empty state for each kind with zero tracks', async () => {
    vi.stubGlobal('fetch', mockTracksResponse({ audioTracks: [], subtitleTracks: [] }));

    await renderAssetTracks('asset-1', container);

    const audioEmpty = container.querySelector('[data-empty="audio-tracks"]');
    const subtitleEmpty = container.querySelector('[data-empty="subtitle-tracks"]');
    expect(audioEmpty?.textContent).toBe('No audio tracks.');
    expect(subtitleEmpty?.textContent).toBe('No subtitle tracks.');
    // Headings stay visible so the section never silently disappears.
    expect(container.textContent).toContain('Audio tracks (0)');
    expect(container.textContent).toContain('Subtitle tracks (0)');
    expect(container.querySelector('table')).toBeNull();
  });

  it('shows the empty state for one kind while the other lists tracks', async () => {
    vi.stubGlobal(
      'fetch',
      mockTracksResponse({
        audioTracks: [],
        subtitleTracks: [{ id: 's1', language: 'en', format: 'srt' }],
      })
    );

    await renderAssetTracks('asset-1', container);

    expect(container.querySelector('[data-empty="audio-tracks"]')).not.toBeNull();
    expect(container.querySelector('[data-empty="subtitle-tracks"]')).toBeNull();
    expect(container.querySelectorAll('tbody tr').length).toBe(1);
  });
});

describe('renderAssetTracks — failure handling', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports inline instead of throwing when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
    );

    await expect(renderAssetTracks('asset-1', container)).resolves.toBeUndefined();
    expect(container.textContent).toContain('Could not load tracks');
  });
});
