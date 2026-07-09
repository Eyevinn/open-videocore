// @vitest-environment happy-dom
//
// DOM tests for the Files + File Groups panel added to the asset detail view
// (issue #136). We test renderAssetFiles(assetId, container) directly — it is
// the exact code path renderAssetDetailBody invokes for a `ready` asset
// (public/app.js ~L1029), and it is exported for reuse by the standalone
// detached detail window (detail.js), so exercising it proves the section
// renders identically in both places.
//
// Verified contract — GET /api/v1/assets/{id}/files
//   Source: openapi.json  "/api/v1/assets/{id}/files" (200 response schema)
//   Cross-checked against the route handler in src/routes/assets.ts (the
//   `/:id/files` GET, assetFileSchema / assetFileGroupSchema).
//   files[]:      { id, type: 'source'|'rendition'|'export', name, format,
//                   objectKey, url (presigned), sizeBytes?, label?, width?,
//                   height?, bitrateBps?, codec? }
//   fileGroups[]: { id, type: 'hls-package'|'dash-package', name, manifestUrl,
//                   segmentCount?, objectKeyPrefix }

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAssetFiles } from '../public/app.js';

// apiFetch() inside app.js calls the global fetch with API_BASE + path. We stub
// fetch to return a JSON Response matching the verified files contract.
function mockFilesResponse(payload: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
}

const FULL_PAYLOAD = {
  files: [
    {
      id: 'source',
      type: 'source',
      name: 'original.mov',
      format: 'mov',
      objectKey: 'ws/original.mov',
      url: 'https://s3.example.com/original.mov?sig=abc',
      sizeBytes: 1048576,
    },
    {
      id: 'rendition:01H',
      type: 'rendition',
      name: 'rendition.mp4',
      format: 'mp4',
      objectKey: 'transcode/01H/rendition.mp4',
      url: 'https://s3.example.com/rendition.mp4?sig=def',
      label: '720p',
      width: 1280,
      height: 720,
      bitrateBps: 2_500_000,
      codec: 'h264',
    },
  ],
  fileGroups: [
    {
      id: 'hls',
      type: 'hls-package',
      name: 'HLS',
      manifestUrl: 'https://cdn.example.com/hls/master.m3u8',
      segmentCount: 42,
      objectKeyPrefix: 'hls/',
    },
  ],
};

describe('renderAssetFiles — files table', () => {
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

  it('renders one row per file with a working presigned download link', async () => {
    vi.stubGlobal('fetch', mockFilesResponse(FULL_PAYLOAD));

    await renderAssetFiles('asset-1', container);

    const rows = container.querySelectorAll('.table-wrap table tbody tr');
    expect(rows.length).toBe(2);

    const links = container.querySelectorAll<HTMLAnchorElement>('.table-wrap table a[download]');
    expect(links.length).toBe(2);
    // Download links come straight from the presigned `url` field.
    expect(links[0].getAttribute('href')).toBe('https://s3.example.com/original.mov?sig=abc');
    expect(links[1].getAttribute('href')).toBe('https://s3.example.com/rendition.mp4?sig=def');
    expect(links[0].getAttribute('target')).toBe('_blank');

    // The rendition row surfaces label + resolution details.
    const text = container.textContent ?? '';
    expect(text).toContain('720p');
    expect(text).toContain('1280×720');
  });
});

describe('renderAssetFiles — file-group cards', () => {
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

  it('renders a card per package with manifest URL, copy button and segment count', async () => {
    vi.stubGlobal('fetch', mockFilesResponse(FULL_PAYLOAD));

    await renderAssetFiles('asset-1', container);

    const cards = container.querySelectorAll('.file-group-card');
    expect(cards.length).toBe(1);

    const card = cards[0];
    // Manifest URL is shown verbatim (and used as the Open link + title).
    expect(card.textContent).toContain('https://cdn.example.com/hls/master.m3u8');
    // Segment count is rendered from the contract's segmentCount field.
    expect(card.textContent).toContain('42 segments');

    const copyBtn = card.querySelector('.file-group-copy');
    expect(copyBtn).not.toBeNull();
    expect(copyBtn?.textContent).toContain('Copy URL');
  });

  it('copy button writes the manifest URL to the clipboard', async () => {
    vi.stubGlobal('fetch', mockFilesResponse(FULL_PAYLOAD));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await renderAssetFiles('asset-1', container);

    const copyBtn = container.querySelector<HTMLButtonElement>('.file-group-copy');
    copyBtn?.click();

    expect(writeText).toHaveBeenCalledWith('https://cdn.example.com/hls/master.m3u8');
  });

  it('shows a fallback label when segmentCount is absent (optional in the contract)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFilesResponse({
        files: [],
        fileGroups: [
          {
            id: 'dash',
            type: 'dash-package',
            name: 'DASH',
            manifestUrl: 'https://cdn.example.com/dash/manifest.mpd',
            objectKeyPrefix: 'dash/',
          },
        ],
      })
    );

    await renderAssetFiles('asset-1', container);

    const card = container.querySelector('.file-group-card');
    expect(card?.textContent).toContain('segment count unavailable');
  });
});

describe('renderAssetFiles — empty states', () => {
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

  it('renders a "no files" empty state when files is empty', async () => {
    vi.stubGlobal('fetch', mockFilesResponse({ files: [], fileGroups: [] }));

    await renderAssetFiles('asset-1', container);

    const filesEmpty = container.querySelector('[data-empty="files"]');
    expect(filesEmpty).not.toBeNull();
    expect(filesEmpty?.textContent).toContain('No files');
    // No files table should be present.
    expect(container.querySelector('.table-wrap table')).toBeNull();
  });

  it('renders a "no packages" empty state when fileGroups is empty', async () => {
    vi.stubGlobal('fetch', mockFilesResponse({ files: [], fileGroups: [] }));

    await renderAssetFiles('asset-1', container);

    const groupsEmpty = container.querySelector('[data-empty="file-groups"]');
    expect(groupsEmpty).not.toBeNull();
    expect(groupsEmpty?.textContent).toMatch(/No streaming packages/i);
    // No cards should be present.
    expect(container.querySelector('.file-group-card')).toBeNull();
  });
});
