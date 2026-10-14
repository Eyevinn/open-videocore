// @vitest-environment happy-dom
//
// Unit tests for public/detail-sections.js — the detail-panel primitives added
// in issue #963: the collapsed "Raw" record disclosure, its open-state carry
// across a re-render, the copyable field value, and the section heading.
// Requested by the PR review for #1125; the implementation is unchanged.
//
// Same harness as the other public/-module suites (happy-dom pragma, direct ESM
// import of the browser module) — see test/jobs-table.test.ts and
// test/asset-detail-lock-actions.test.ts.
//
// ─── Contract grounding (CLAUDE.md rule 7) ───────────────────────────────────
// These are presentation primitives: detail-sections.js reads NO named API
// field (its own header says so), so there is no response schema to pin here.
// What is verified against real source rather than assumed is the shape of the
// code these tests call into:
//
//   - `escHtml`            public/ops-ui-table.js:45-52 — escapes & < > " ' in
//                          that order (' becomes &#39;, " becomes &quot;).
//   - `copyableIdCellHtml` public/copy-id.js:75-88 — the single click-to-copy
//                          control in this UI; emits `.cell-id-value` text plus
//                          a `button.copy-id-btn[data-copy-id][aria-live=polite]`
//                          whose aria-label is "<label> <value>". An empty value
//                          degrades to `<span class="cell-id">—</span>`.
//   - `COPY_ID_BTN_CLASS`  public/copy-id.js:49 and
//     `FEEDBACK_MS`        public/copy-id.js:54 — imported here instead of
//                          restating the literals.
//   - `wireCopyIdButtons`  public/copy-id.js:119-172 — accepts an injectable
//                          `{ nav }` for tests, which is how the clipboard path
//                          below is driven without touching a real navigator.
//
// The one API-shaped fixture used below (a job record) is only ever passed as an
// opaque value to JSON.stringify, so its fields carry no assertion.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RAW_DISCLOSURE_ATTR,
  RAW_DISCLOSURE_CLASS,
  copyableFieldHtml,
  createRawDisclosure,
  escHtml,
  rawDisclosureOpen,
  sectionTitle,
  wireCopyableFields,
} from '../public/detail-sections.js';
import { COPY_ID_BTN_CLASS, FEEDBACK_MS } from '../public/copy-id.js';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── createRawDisclosure ─────────────────────────────────────────────────────

describe('createRawDisclosure', () => {
  it('is a native details/summary, collapsed by default', () => {
    const el = createRawDisclosure({ id: 'job-1' });

    expect(el.tagName).toBe('DETAILS');
    // Collapsed: the `open` boolean attribute must be absent, not just falsey.
    expect(el.open).toBe(false);
    expect(el.hasAttribute('open')).toBe(false);
    expect(el.classList.contains(RAW_DISCLOSURE_CLASS)).toBe(true);
    expect(el.getAttribute(RAW_DISCLOSURE_ATTR)).toBe('1');

    const summary = el.querySelector('summary')!;
    expect(summary).not.toBeNull();
    expect(summary.textContent).toBe('Raw');
  });

  it('stays collapsed for every non-true `open` value', () => {
    for (const open of [undefined, false, null, 0, '', 'true', 1]) {
      expect(createRawDisclosure({}, { open }).open).toBe(false);
    }
  });

  it('starts expanded only when `open` is exactly true', () => {
    const el = createRawDisclosure({}, { open: true });
    expect(el.open).toBe(true);
    expect(el.hasAttribute('open')).toBe(true);
  });

  it('pretty-prints the record as JSON with two-space indentation', () => {
    const job = { id: 'job-1', status: 'done', encodeAttempts: 2 };
    const pre = createRawDisclosure(job).querySelector('pre')!;

    expect(pre.className).toContain('raw-disclosure-body');
    expect(pre.textContent).toBe(JSON.stringify(job, null, 2));
    expect(pre.textContent).toContain('\n  "id": "job-1"');
  });

  it('accepts a caller label and extra classes', () => {
    const el = createRawDisclosure({}, { label: 'Raw job record', className: 'mt12' });
    expect(el.querySelector('summary')!.textContent).toBe('Raw job record');
    expect(el.className).toBe(RAW_DISCLOSURE_CLASS + ' mt12');
  });

  it('degrades to a readable placeholder for a circular record instead of blanking', () => {
    const circular: Record<string, unknown> = { id: 'job-1' };
    circular.self = circular;

    const el = createRawDisclosure(circular);
    expect(el.querySelector('pre')!.textContent).toBe('Could not serialise this record.');
  });

  it('degrades for a value JSON.stringify cannot represent at all', () => {
    // JSON.stringify returns undefined (not a string) for these.
    expect(createRawDisclosure(undefined).querySelector('pre')!.textContent).toBe('undefined');
    expect(createRawDisclosure(() => 1).querySelector('pre')!.textContent).toContain('=>');
  });

  it('writes the serialised record as text, never as markup', () => {
    const el = createRawDisclosure({ name: '<script>alert(1)</script>' });
    document.body.appendChild(el);

    expect(document.querySelector('script')).toBeNull();
    expect(el.querySelector('pre')!.textContent).toContain('<script>alert(1)</script>');
  });
});

// ─── rawDisclosureOpen round-trip ────────────────────────────────────────────

describe('rawDisclosureOpen', () => {
  it('is false on a first render, when no disclosure exists yet', () => {
    const container = document.createElement('div');
    expect(rawDisclosureOpen(container)).toBe(false);
  });

  it('is false for a missing or query-less root', () => {
    expect(rawDisclosureOpen(null)).toBe(false);
    expect(rawDisclosureOpen(undefined)).toBe(false);
    expect(rawDisclosureOpen({} as never)).toBe(false);
  });

  it('reports the collapsed/expanded state of a rendered disclosure', () => {
    const container = document.createElement('div');
    container.appendChild(createRawDisclosure({ id: 'job-1' }));
    document.body.appendChild(container);

    expect(rawDisclosureOpen(container)).toBe(false);

    // Operator expands it.
    container.querySelector('details')!.open = true;
    expect(rawDisclosureOpen(container)).toBe(true);
  });

  it('round-trips an operator expansion across a re-render of the same container', () => {
    // This is the poll-tick path: public/detail.js re-renders into the same
    // container every DETAIL_POLL_INTERVAL_MS, which throws away the DOM.
    const container = document.createElement('div');
    document.body.appendChild(container);

    container.appendChild(createRawDisclosure({ tick: 1 }));
    container.querySelector('details')!.open = true;

    // Re-render: read the state BEFORE clearing, pass it back in.
    const wasOpen = rawDisclosureOpen(container);
    container.innerHTML = '';
    container.appendChild(createRawDisclosure({ tick: 2 }, { open: wasOpen }));

    expect(rawDisclosureOpen(container)).toBe(true);
    expect(container.querySelector('pre')!.textContent).toContain('"tick": 2');

    // And a collapsed disclosure stays collapsed across the next tick.
    const stillOpen = rawDisclosureOpen(container);
    container.querySelector('details')!.open = false;
    const nowClosed = rawDisclosureOpen(container);
    container.innerHTML = '';
    container.appendChild(createRawDisclosure({ tick: 3 }, { open: nowClosed }));

    expect(stillOpen).toBe(true);
    expect(nowClosed).toBe(false);
    expect(rawDisclosureOpen(container)).toBe(false);
  });
});

// ─── copyableFieldHtml ───────────────────────────────────────────────────────

describe('copyableFieldHtml', () => {
  it('reuses the single copy control: value text + an aria-live copy button', () => {
    const html = copyableFieldHtml('01HQ8ENCORE', 'Copy Encore job id');
    const host = document.createElement('div');
    host.innerHTML = html;

    expect(host.querySelector('.cell-id-value')!.textContent).toBe('01HQ8ENCORE');
    const btn = host.querySelector('button.' + COPY_ID_BTN_CLASS) as HTMLButtonElement;
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.dataset.copyId).toBe('01HQ8ENCORE');
    expect(btn.getAttribute('aria-live')).toBe('polite');
    // Accessible name starts with the visible label and ends with the value, so
    // N fields give N distinguishable controls (WCAG 2.1 SC 2.5.3).
    expect(btn.getAttribute('aria-label')).toBe('Copy Encore job id 01HQ8ENCORE');
    expect(btn.textContent).toBe('Copy');
  });

  it('escapes a quote/angle-bracket-bearing id in the text, the data attribute and the label', () => {
    const nasty = 'job"><img src=x onerror=alert(1)>\'&';
    const html = copyableFieldHtml(nasty, 'Copy Encore job id');

    // The raw characters must not survive as markup anywhere in the string.
    expect(html).not.toContain('<img');
    expect(html).toContain(escHtml(nasty));
    expect(html).toContain('&quot;');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&#39;');

    // And parsing it yields one button, no injected element, with the value
    // intact as text on both the cell and the copy payload.
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);

    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(host.querySelector('.cell-id-value')!.textContent).toBe(nasty);
    const btn = host.querySelector('button') as HTMLButtonElement;
    expect(btn.dataset.copyId).toBe(nasty);
    expect(btn.getAttribute('aria-label')).toBe('Copy Encore job id ' + nasty);
  });

  it('defaults the label and stringifies a numeric id', () => {
    const host = document.createElement('div');
    host.innerHTML = copyableFieldHtml(42);
    expect((host.querySelector('button') as HTMLButtonElement).getAttribute('aria-label')).toBe(
      'Copy id 42'
    );
  });

  it('degrades to an em-dash with no copy button when the field is absent', () => {
    for (const value of [null, undefined, '']) {
      const host = document.createElement('div');
      host.innerHTML = copyableFieldHtml(value, 'Copy Encore job id');
      expect(host.textContent).toBe('—');
      expect(host.querySelector('button')).toBeNull();
    }
  });
});

// ─── wireCopyableFields ──────────────────────────────────────────────────────

describe('wireCopyableFields', () => {
  it('copies the field value and reports back on the button, then restores it', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const host = document.createElement('div');
    host.innerHTML = copyableFieldHtml('01HQ8ENCORE', 'Copy Encore job id');
    document.body.appendChild(host);

    wireCopyableFields(host, { nav: { clipboard: { writeText } } });
    const btn = host.querySelector('button') as HTMLButtonElement;
    btn.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('01HQ8ENCORE');
    expect(btn.textContent).toBe('Copied');
    // The accessible name moves with the visible text (SC 4.1.3).
    expect(btn.getAttribute('aria-label')).toBe('Copied');

    vi.advanceTimersByTime(FEEDBACK_MS);
    expect(btn.textContent).toBe('Copy');
    expect(btn.getAttribute('aria-label')).toBe('Copy Encore job id 01HQ8ENCORE');
  });

  it('is idempotent, so re-rendering a panel does not double-bind', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const host = document.createElement('div');
    host.innerHTML = copyableFieldHtml('abc', 'Copy Encore job id');
    document.body.appendChild(host);

    wireCopyableFields(host, { nav: { clipboard: { writeText } } });
    wireCopyableFields(host, { nav: { clipboard: { writeText } } });
    (host.querySelector('button') as HTMLButtonElement).click();

    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('tolerates a missing root rather than throwing into the render path', () => {
    expect(() => wireCopyableFields(null)).not.toThrow();
    expect(() => wireCopyableFields(undefined)).not.toThrow();
  });
});

// ─── sectionTitle ────────────────────────────────────────────────────────────

describe('sectionTitle', () => {
  it('matches the panels existing section-title treatment, with default spacing', () => {
    const el = sectionTitle('Encode attempts');
    expect(el.className).toBe('section-title mt12');
    expect(el.textContent).toBe('Encode attempts');
  });

  it('accepts custom or no spacing classes', () => {
    expect(sectionTitle('x', 'mt24').className).toBe('section-title mt24');
    expect(sectionTitle('x', '').className).toBe('section-title');
  });

  it('writes the heading text as text', () => {
    const el = sectionTitle('<b>Raw</b>');
    document.body.appendChild(el);
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toBe('<b>Raw</b>');
  });
});

// ─── escHtml re-export ───────────────────────────────────────────────────────

describe('escHtml re-export', () => {
  it('is the ops-ui-table escaper, so a caller needs one import', () => {
    expect(escHtml('<a href="x">\'&')).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    expect(escHtml(null)).toBe('');
  });
});
