/**
 * open-videocore ops — standalone detached detail view (detail.js)
 *
 * Entry point for detail.html. Renders exactly ONE detail view (a single asset
 * or a single job) in its own browser window, self-polling at the shared
 * main-UI interval. It reuses the renderer + helper logic from app.js via ES
 * module imports (no duplication), and shares NO module-level state with the
 * opener window (a separate window is a separate JS realm anyway).
 *
 * URL params:
 *   type   'asset' | 'job'   (which detail renderer to run)
 *   id     the asset or job id to render
 *   stack  (optional) the OSC stack name to target; falls back to the
 *          window's own localStorage when absent.
 *
 * Security note: all dynamic values continue to flow through app.js's escHtml
 * before interpolation — this file only builds static chrome and delegates the
 * data-driven rendering to the shared body-renderers.
 */

import {
  renderAssetDetailBody,
  renderJobDetailBody,
  setStackOverride,
  getActiveStack,
  DETAIL_POLL_INTERVAL_MS,
} from './app.js';

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

const type = getParam('type');
const id = getParam('id');
const stackParam = getParam('stack');

// Target the same stack as the opener without depending on its localStorage.
// Use a window-scoped override (not the shared localStorage key) so popping out
// a detail for a different stack cannot switch the opener window's active stack.
if (stackParam) setStackOverride(stackParam);

const root = document.getElementById('detail-root');
const stackLabel = document.getElementById('detail-stack-label');
const activeStack = stackParam || getActiveStack();
if (stackLabel) stackLabel.textContent = activeStack ? ('Stack: ' + activeStack) : '';

let pollTimer = null;

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Release the interval when the window is closed/navigated away to avoid leaks.
window.addEventListener('beforeunload', stopPolling);

function fatal(message) {
  stopPolling();
  root.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'detail-panel-header';
  const h3 = document.createElement('h3');
  h3.textContent = 'Not available';
  header.appendChild(h3);
  const body = document.createElement('div');
  body.className = 'detail-panel-body';
  const msg = document.createElement('div');
  msg.className = 'msg msg-error';
  msg.textContent = message;
  body.appendChild(msg);
  root.appendChild(header);
  root.appendChild(body);
}

function isNotFound(err) {
  return (err && err.status === 404) || (err && typeof err.message === 'string' && /HTTP 404|not[_ -]?found/i.test(err.message));
}

// Build the static chrome (header + body). Title text is set via textContent.
function buildChrome(headingText) {
  root.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'detail-panel-header';
  const h3 = document.createElement('h3');
  h3.textContent = headingText;
  header.appendChild(h3);
  const body = document.createElement('div');
  body.className = 'detail-panel-body';
  body.id = 'detail-body';
  root.appendChild(header);
  root.appendChild(body);
  return body;
}

async function runAsset(bodyEl) {
  const asset = await renderAssetDetailBody(id, bodyEl);
  // Prefer the human-friendly title/name once fetched; fall back to the id.
  const label = (asset && (asset.title || asset.name)) || id;
  document.title = 'Asset ' + label + ' — open-videocore ops';
}

async function runJob(bodyEl) {
  const job = await renderJobDetailBody(id, bodyEl, {});
  const label = (job && job.type) ? (job.type + ' ' + id) : id;
  document.title = 'Job ' + label + ' — open-videocore ops';
}

async function tick() {
  const bodyEl = document.getElementById('detail-body');
  if (!bodyEl) return;
  try {
    if (type === 'asset') {
      await runAsset(bodyEl);
    } else {
      await runJob(bodyEl);
    }
  } catch (err) {
    // Mirror the jobs-table behaviour: stop self-polling once the resource is
    // gone (404). Transient errors already render inline via the body-renderer,
    // so keep polling in that case.
    if (isNotFound(err)) {
      fatal(capitalize(type) + ' ' + id + ' no longer exists.');
    }
  }
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function boot() {
  if (!id || (type !== 'asset' && type !== 'job')) {
    fatal('Missing or invalid "type"/"id" URL parameters.');
    return;
  }

  const heading = type === 'asset' ? 'Asset Detail' : 'Job Detail';
  // Provisional title until the first fetch resolves the friendly name.
  document.title = capitalize(type) + ' ' + id + ' — open-videocore ops';
  buildChrome(heading);

  // Initial render, then self-poll at the shared main-UI interval.
  tick();
  pollTimer = setInterval(tick, DETAIL_POLL_INTERVAL_MS);
}

boot();
