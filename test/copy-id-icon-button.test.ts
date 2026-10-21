// @vitest-environment happy-dom
//
// Issue #990 — the click-to-copy control beside an id is an icon button, and the
// word it used to show is still in the DOM doing the three other jobs it had.
//
// CONTRACT GROUNDING (the "contract" here is the existing source, read not
// guessed — this is a pure front-end change with no API surface):
//   - `copyableIdCellHtml` / `wireCopyIdButtons` / `COPY_ID_BTN_CLASS` /
//     `FEEDBACK_MS`, public/copy-id.js — the shared control both call sites use:
//     the assets table ID column (`render: (a) => copyableIdCellHtml(a.id, 'Copy
//     asset id')`, public/assets-table.js:618, wired at :988) and the asset
//     detail key/value grid (public/app.js:2554, wired at :2616). The jobs table
//     composes the same helper (public/jobs-table.js:224/227).
//   - `.visually-hidden`, public/style.css:194 — the EXISTING utility the hidden
//     label reuses; #990 says do not add a second one.
//   - `.copy-id-btn` / `.copy-id-btn:hover`, public/style.css (the 11px pill
//     before this change) — the muted/hover colours the glyph must inherit
//     rather than hardcode.
//   - `.ops-search-icon`, public/style.css:2081 — the in-repo precedent for an
//     icon drawn in CSS from `currentColor` pseudo-elements, which is how this
//     glyph is drawn too. An inline `<svg>` is not available: the assets-table
//     row is asserted SVG-free by test/asset-list-lock-indicator.test.ts:413,
//     and that row contains this button.
//
// The behaviour under test is in the shared module, so it holds at every call
// site at once; the two the issue names are additionally smoke-checked at the
// bottom through createAssetsTable.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAssetsTable } from '../public/assets-table.js';
import {
  copyableIdCellHtml,
  wireCopyIdButtons,
  COPY_ID_BTN_CLASS,
  COPY_ID_ICON_CLASS,
  COPY_ID_LABEL_CLASS,
  COPY_ID_OK_CLASS,
  COPY_ID_FAIL_CLASS,
  FEEDBACK_MS,
} from '../public/copy-id.js';

const ULID = '01M39TGAB79CPKREYVBGKGVNQS';
const STYLESHEET = readFileSync(resolve(process.cwd(), 'public/style.css'), 'utf8');

const deps = () => ({
  renderBadge: (s: string) => '<span class="badge">' + s + '</span>',
  renderTags: () => '',
  fmtDate: (v: string) => String(v || '—'),
  isAssetWedged: () => false,
});

function stubWin(search = '') {
  return {
    location: { search, pathname: '/', hash: '' },
    history: { state: null, replaceState: () => {}, pushState: () => {} },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** The control, mounted and wired, with an injectable clipboard. */
function mountControl(clipboard?: { writeText: (v: string) => Promise<void> }) {
  const host = document.createElement('div');
  host.innerHTML = copyableIdCellHtml(ULID, 'Copy asset id');
  document.body.appendChild(host);
  wireCopyIdButtons(host, {
    nav: (clipboard ? { clipboard } : {}) as unknown as Navigator,
  });
  const btn = host.querySelector('.' + COPY_ID_BTN_CLASS) as HTMLButtonElement;
  const label = btn.querySelector('.' + COPY_ID_LABEL_CLASS) as HTMLElement;
  const icon = btn.querySelector('.' + COPY_ID_ICON_CLASS) as HTMLElement;
  return { host, btn, label, icon };
}

/** Put the real sheet in the document so assertions read resolved values. */
function withStylesheet(): () => void {
  const style = document.createElement('style');
  style.textContent = STYLESHEET;
  document.head.appendChild(style);
  return () => style.remove();
}

afterEach(() => {
  document.body.innerHTML = '';
  document.head.querySelectorAll('style').forEach((s) => s.remove());
  vi.restoreAllMocks();
});

describe('copy control renders as an icon button (issue #990)', () => {
  it('shows a glyph and no visible "Copy" text, with the words still exposed to AT', () => {
    const drop = withStylesheet();
    try {
      const { btn, label, icon } = mountControl();

      // The glyph: an empty, aria-hidden box. Empty because the shape is drawn by
      // CSS pseudo-elements, aria-hidden so it is never announced and never lands
      // in the live-region payload below.
      expect(icon).not.toBeNull();
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.innerHTML).toBe('');

      // The word is gone from the page but not from the accessibility tree: it is
      // in the EXISTING `.visually-hidden` utility (public/style.css:194), which
      // really does resolve to the clipped 1px box here rather than being a class
      // name that happens to look right.
      expect(label.textContent).toBe('Copy');
      expect(label.classList.contains('visually-hidden')).toBe(true);
      const hidden = getComputedStyle(label);
      expect(hidden.position).toBe('absolute');
      expect(hidden.width).toBe('1px');
      expect(hidden.height).toBe('1px');
      expect(hidden.overflow).toBe('hidden');

      // No second utility was introduced to do the same job.
      expect(STYLESHEET).not.toMatch(/\.sr-only\b/);

      // And the button's text is EXACTLY the label — the icon contributes no text
      // node, so the live-region payload stays a clean word.
      expect(btn.textContent).toBe('Copy');
    } finally {
      drop();
    }
  });

  it('keeps the control at least as easy to hit as the worded pill it replaces', () => {
    const drop = withStylesheet();
    try {
      const { btn } = mountControl();
      const css = getComputedStyle(btn);
      // The painted box is square and meets SC 2.5.8 Target Size (Minimum) on
      // both axes, which the ~20px-tall 11px pill did not.
      expect(css.width).toBe('24px');
      expect(css.height).toBe('24px');
      // A positioned button is what lets the hit-area pseudo-element below (and
      // the clipped label above) resolve against it.
      expect(css.position).toBe('relative');
      // The clickable region is pushed 4px past the paint on every side, so the
      // target area (32x32) does not shrink against the old ~40x20 pill.
      expect(STYLESHEET).toMatch(/\.copy-id-btn::after\s*\{[^}]*inset:\s*-4px/);
    } finally {
      drop();
    }
  });

  it('draws the glyph from currentColor, hardcoding no hue of its own', () => {
    // AC: the icon inherits the existing muted/hover colours. Read off the rules
    // because happy-dom does not compute pseudo-element styles.
    const block = STYLESHEET.slice(
      STYLESHEET.indexOf('.copy-id-btn {'),
      STYLESHEET.indexOf('/* Jobs table Asset cell')
      // Comments out: an issue reference like `#990` is not a colour literal.
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('currentColor');
    // Every colour in the block is either inherited or a theme token — no literal.
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toMatch(/\brgba?\(/);
    expect(block).not.toMatch(/\bhsla?\(/);
  });
});

describe('the hidden word is still the feedback channel and the live region (issue #990)', () => {
  it('announces success in the live region and shows it as a distinct glyph state', async () => {
    const drop = withStylesheet();
    try {
      const writeText = vi.fn(async () => {});
      const { btn, label } = mountControl({ writeText });

      // Resting: the accessible name still carries the value being copied, so N
      // rows give N distinguishable controls.
      expect(btn.getAttribute('aria-live')).toBe('polite');
      expect(btn.getAttribute('aria-label')).toBe('Copy asset id ' + ULID);

      btn.click();
      expect(writeText).toHaveBeenCalledWith(ULID);

      // Announced: the transient result is text inside the polite live region.
      await vi.waitFor(() => expect(label.textContent).toBe('Copied'));
      expect(label.closest('[aria-live]')).toBe(btn);
      expect(label.closest('[aria-hidden="true"]')).toBeNull();

      // Seen: a sighted operator gets the outcome from the glyph state instead of
      // the word, and the resolved colour is the success token, not the resting
      // muted one.
      expect(btn.classList.contains(COPY_ID_OK_CLASS)).toBe(true);
      expect(btn.classList.contains(COPY_ID_FAIL_CLASS)).toBe(false);
      expect(getComputedStyle(btn).color).toBe('#22c55e');
    } finally {
      drop();
    }
  });

  it('keeps failure distinguishable from success, by shape as well as colour', async () => {
    const drop = withStylesheet();
    try {
      const { btn, label } = mountControl({
        writeText: vi.fn(() => Promise.reject(new Error('denied'))),
      });

      btn.click();
      await vi.waitFor(() => expect(label.textContent).toBe('Copy failed'));

      expect(btn.classList.contains(COPY_ID_FAIL_CLASS)).toBe(true);
      expect(btn.classList.contains(COPY_ID_OK_CLASS)).toBe(false);
      // Danger token, not the success token and not the resting muted colour.
      expect(getComputedStyle(btn).color).toBe('#ef4444');

      // Not colour alone (WCAG 1.4.1): the two states select different glyph
      // geometry — the failed state rotates a pair of bars into a cross, the
      // success state drops the second sheet and rotates a tick.
      expect(STYLESHEET).toContain(
        '.copy-id-btn.is-copy-failed .copy-id-btn-icon::after {\n  transform: rotate(-45deg);'
      );
      expect(STYLESHEET).toContain(
        '.copy-id-btn.is-copied .copy-id-btn-icon::after {\n  content: none;'
      );
    } finally {
      drop();
    }
  });

  it('reports the no-clipboard fallback as not-copied, in both channels', () => {
    const drop = withStylesheet();
    try {
      const { host, btn, label } = mountControl();
      btn.click();
      // The words still instruct the AT user; the glyph tells a sighted one that
      // the clipboard did not receive anything.
      expect(label.textContent).toBe('Select to copy');
      expect(btn.classList.contains(COPY_ID_FAIL_CLASS)).toBe(true);
      // And the value is still there to select by hand.
      expect(host.textContent).toContain(ULID);
    } finally {
      drop();
    }
  });

  it('clears both channels together when the feedback window closes', async () => {
    vi.useFakeTimers();
    try {
      const { btn, label } = mountControl({ writeText: () => Promise.resolve() });
      btn.click();
      await vi.advanceTimersByTimeAsync(10);
      expect(label.textContent).toBe('Copied');
      expect(btn.classList.contains(COPY_ID_OK_CLASS)).toBe(true);

      await vi.advanceTimersByTimeAsync(FEEDBACK_MS + 50);
      // Word, name and glyph all back to resting — the icon can never be left
      // claiming an outcome the live region has already retracted.
      expect(label.textContent).toBe('Copy');
      expect(btn.getAttribute('aria-label')).toBe('Copy asset id ' + ULID);
      expect(btn.classList.contains(COPY_ID_OK_CLASS)).toBe(false);
      expect(btn.classList.contains(COPY_ID_FAIL_CLASS)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not strand the icon button on "Copied" when clicked twice in the window', async () => {
    // The bug `restingText` guards, re-checked now that the text it captures lives
    // in a child span: a second click inside the feedback window must not capture
    // the transient "Copied" as the value to restore.
    vi.useFakeTimers();
    try {
      const { btn, label } = mountControl({ writeText: () => Promise.resolve() });

      btn.click();
      await vi.advanceTimersByTimeAsync(10);
      expect(label.textContent).toBe('Copied');

      await vi.advanceTimersByTimeAsync(500);
      btn.click();
      await vi.advanceTimersByTimeAsync(10);
      expect(label.textContent).toBe('Copied');

      // Past the first timer's deadline, before the second's.
      await vi.advanceTimersByTimeAsync(FEEDBACK_MS - 400);
      // Past the second's: resting again, in every channel.
      await vi.advanceTimersByTimeAsync(FEEDBACK_MS);
      expect(label.textContent).toBe('Copy');
      expect(btn.getAttribute('aria-label')).toBe('Copy asset id ' + ULID);
      expect(btn.classList.contains(COPY_ID_OK_CLASS)).toBe(false);
      expect(btn.className).toBe(COPY_ID_BTN_CLASS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the button itself when markup carries no label span', async () => {
    // Defensive: pre-#990 markup (text straight on the button) keeps working, so
    // the wiring is not coupled to one HTML shape.
    const host = document.createElement('div');
    host.innerHTML =
      '<button type="button" class="' +
      COPY_ID_BTN_CLASS +
      '" data-copy-id="' +
      ULID +
      '" aria-live="polite" aria-label="Copy asset id ' +
      ULID +
      '">Copy</button>';
    document.body.appendChild(host);
    wireCopyIdButtons(host, {
      nav: { clipboard: { writeText: vi.fn(async () => {}) } } as unknown as Navigator,
    });
    const btn = host.querySelector('.' + COPY_ID_BTN_CLASS) as HTMLButtonElement;
    btn.click();
    await vi.waitFor(() => expect(btn.textContent).toBe('Copied'));
  });
});

describe('both call sites named in the issue get the icon button (issue #990)', () => {
  it('renders it in the assets table ID column with no visible word', async () => {
    const t = createAssetsTable({
      ...deps(),
      apiFetch: vi.fn(async () => ({
        items: [
          { id: ULID, slug: 's-1', name: 'Clip', status: 'ready', createdAt: '2026-01-01T00:00:00Z' },
        ],
        total: 1,
      })),
      win: stubWin(),
    });
    document.body.appendChild(t.el);
    await tick();

    const btn = t.el.querySelector('.' + COPY_ID_BTN_CLASS) as HTMLButtonElement;
    expect(btn.querySelector('.' + COPY_ID_ICON_CLASS)).not.toBeNull();
    const label = btn.querySelector('.' + COPY_ID_LABEL_CLASS) as HTMLElement;
    expect(label.classList.contains('visually-hidden')).toBe(true);
    // The id itself stays visible text in the cell; only the control's word went.
    expect((btn.closest('td') as HTMLElement).textContent).toContain(ULID);
  });
});
