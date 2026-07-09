// Issue #128 — the detached pane entrypoint is served as a static file.
//
// The detach buttons open `detail.html?...` relative to the page, which resolves
// to `/ui/detail.html` because the SPA is served from the `/ui/` prefix (see
// src/main.ts: app.register(fastifyStatic, { root: '../public', prefix: '/ui/' }).
//
// Booting the full main.ts app pulls in OSC/storage/db wiring, so this test
// registers @fastify/static exactly as main.ts does — same root + prefix — and
// asserts the pane entrypoint (and its module) are served at the URLs the detach
// buttons request. This is the automatable half of the acceptance criteria; the
// live auto-refresh in a real browser window is covered by detached-pane.test.ts
// (DOM) and still warrants a human click-through.

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../public');

const app = Fastify();

beforeAll(async () => {
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/ui/',
    decorateReply: false,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('static serving of the detached pane entrypoint — issue #128', () => {
  it('serves /ui/detail.html (the URL the detach buttons open)', async () => {
    const res = await app.inject({ method: 'GET', url: '/ui/detail.html' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // Minimal chrome: the pane mount point is present, the global tab bar is not.
    expect(res.body).toContain('id="detail-root"');
    expect(res.body).not.toContain('class="tab-bar"');
  });

  it('serves /ui/detail.js (the module that reuses the #127 renderers)', async () => {
    const res = await app.inject({ method: 'GET', url: '/ui/detail.js' });
    expect(res.statusCode).toBe(200);
    // It imports the shared renderers from app.js rather than duplicating them.
    expect(res.body).toContain("from './app.js'");
    expect(res.body).toContain('renderAssetDetailBody');
    expect(res.body).toContain('renderJobDetailBody');
  });
});
