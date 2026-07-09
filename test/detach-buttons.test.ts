// @vitest-environment happy-dom
//
// Covers the detach ("pop-out") buttons that open a standalone detail view.
// Both the asset detach button (#popout-detail) and the job detach button
// (#popout-job-detail) call the same helper, openDetailWindow(type, id), in
// public/app.js. We test that helper directly: it is the exact code path both
// button handlers invoke, so asserting its output proves the detach behaviour
// without rendering the full pane DOM.
//
// Verified contract (public/app.js):
//   - openDetailWindow(type, id)  @ app.js:392-397
//   - #popout-detail  -> openDetailWindow('asset', id)  @ app.js:704-705
//   - #popout-job-detail -> openDetailWindow('job', id) @ app.js:1220
//   - getActiveStack() reads localStorage 'ovc_stack'   @ app.js:26-28
//   - setActiveStack(name) writes it                    @ app.js:30-33

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDetailWindow, setActiveStack } from '../public/app.js';

describe('detach buttons -> openDetailWindow', () => {
  beforeEach(() => {
    // Clean slate for the shared localStorage-backed active stack.
    setActiveStack('');
    vi.restoreAllMocks();
  });

  it('opens detail.html with the asset type/id/stack query string + noopener', () => {
    setActiveStack('mystack');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    openDetailWindow('asset', 'abc123');

    expect(open).toHaveBeenCalledTimes(1);
    const [url, target, features] = open.mock.calls[0];
    expect(url).toBe('detail.html?type=asset&id=abc123&stack=mystack');
    expect(target).toBe('_blank');
    expect(features).toMatch(/noopener/);
  });

  it('opens detail.html with the job type/id (matching the job detach button)', () => {
    setActiveStack('mystack');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    openDetailWindow('job', 'job-9');

    const [url] = open.mock.calls[0];
    expect(url).toBe('detail.html?type=job&id=job-9&stack=mystack');
  });

  it('URL-encodes the id via encodeURIComponent', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    openDetailWindow('asset', 'a b/c');

    const [url] = open.mock.calls[0];
    expect(url).toContain('&id=a%20b%2Fc&');
    // Sanity: the raw, unencoded id must not leak into the query string.
    expect(url).not.toContain('a b/c');
  });

  it('URL-encodes the active stack value too', () => {
    setActiveStack('stack/one two');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    openDetailWindow('asset', 'x');

    const [url] = open.mock.calls[0];
    expect(url).toContain('stack=stack%2Fone%20two');
  });
});
