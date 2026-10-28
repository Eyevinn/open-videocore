/**
 * open-videocore ops — running-build indicator (issue #828)
 *
 * Surfaces WHICH BUILD of the API the ops UI is talking to, visibly, without
 * devtools, so a screenshot is enough to identify the deployment.
 *
 * ── Contract (verified, not assumed) ─────────────────────────────────────────
 * Source of truth: `GET /health` (operation: the only `get` under the `/health`
 * path in openapi.json; handler `healthRouter` in src/routes/health.ts:107).
 * Its 200 response schema is `healthResponseSchema` (src/routes/health.ts:71),
 * whose `build` object is `buildInfoSchema` (src/routes/health.ts:55) — added by
 * issue #827. The exact fields, all REQUIRED per openapi.json
 * `paths./health.get.responses.200...build.required`:
 *
 *   build.version        string        `git describe --tags --always --dirty`,
 *                                      e.g. "v1.5.0-56-g92a13cc", or "unknown"
 *   build.commit         string        commit SHA, or "unknown"
 *   build.sourceDigest   string        digest of the built source tree, or "unknown"
 *   build.builtAt        string|null   ISO-8601 build timestamp, or null
 *   build.packageVersion string        package.json version (the release line,
 *                                      NOT the build identity)
 *
 * `/health` is NOT under the /api/v1 prefix and is unauthenticated by design
 * (src/routes/health.ts:17-32, registered at src/main.ts:350), so this module
 * uses a plain same-origin fetch rather than app.js's apiFetch — no bearer, no
 * X-Stack-Name. Same origin is the same assumption app.js already makes for
 * API_BASE (`window.location.origin + '/api/v1'`).
 *
 * ── Why it is fetched and never baked in ─────────────────────────────────────
 * Requirement 4 of #828: the displayed value must identify the RUNNING
 * deployment. A value substituted into these static assets at build time would
 * identify whatever produced the assets, which drifts the moment a file is
 * cached, proxied, or served from a different image than the one answering API
 * calls — exactly the failure mode the issue reports. So there is deliberately
 * no constant in this file to fall back on: if `/health` cannot be reached the
 * indicator says so ("build unknown") rather than showing a stale guess.
 */

// Shown when /health is unreachable or its body is not the shape above. Never a
// version-looking string: an operator must not read a guess as a build identity.
const UNKNOWN_LABEL = 'build unknown';
const UNKNOWN_TITLE =
  'Could not read the running build from /health — this UI cannot identify the deployment it is pointed at.';

// Path of the contract above. Root-relative: /health is not under /api/v1.
const HEALTH_PATH = '/health';

/**
 * True when `build` carries the three string fields the indicator reads. Only
 * `version` is actually rendered, so that is the one field whose absence makes
 * the whole block unusable; the rest are checked loosely so a server that
 * grows the object stays compatible.
 */
function hasBuild(health) {
  return Boolean(
    health &&
      typeof health === 'object' &&
      health.build &&
      typeof health.build === 'object' &&
      typeof health.build.version === 'string' &&
      health.build.version.length > 0
  );
}

/**
 * The SHORT string on screen — `build.version`, the git-describe identity
 * (e.g. "v1.5.0-56-g92a13cc"). Deliberately not `packageVersion`: two images
 * built from different commits on the same release line share a packageVersion
 * and so could not be told apart, which is the whole point of #828.
 */
export function formatBuildLabel(build) {
  if (!build || typeof build.version !== 'string' || !build.version) return UNKNOWN_LABEL;
  return build.version;
}

/**
 * The FULL details, for the hover/`title` text and for the click-to-reveal
 * line. Every field from buildInfoSchema, including the ones the short label
 * drops. `builtAt` is nullable in the contract, so null renders as "unknown"
 * rather than as the string "null".
 */
export function formatBuildDetails(build, stack) {
  if (!build || typeof build !== 'object') return UNKNOWN_TITLE;
  const parts = [
    'version: ' + orUnknown(build.version),
    'commit: ' + orUnknown(build.commit),
    'source digest: ' + orUnknown(build.sourceDigest),
    'built at: ' + orUnknown(build.builtAt),
    'package version: ' + orUnknown(build.packageVersion),
  ];
  parts.push('stack: ' + (stack ? stack : 'none selected'));
  return parts.join('\n');
}

function orUnknown(v) {
  return typeof v === 'string' && v.length > 0 ? v : 'unknown';
}

/**
 * The single console line logged once on load (requirement 2): full build
 * details plus the stack the UI is pointed at. One line, so it is greppable in
 * a pasted console dump; the structured object is attached as a second argument
 * so it is also inspectable.
 */
export function formatConsoleLine(build, stack) {
  const b = build && typeof build === 'object' ? build : {};
  return (
    'open-videocore ops UI — running build ' +
    orUnknown(b.version) +
    ' (commit ' +
    orUnknown(b.commit) +
    ', built ' +
    orUnknown(b.builtAt) +
    ', package ' +
    orUnknown(b.packageVersion) +
    ', source digest ' +
    orUnknown(b.sourceDigest) +
    ') — stack: ' +
    (stack ? stack : 'none selected')
  );
}

/**
 * Read the running build from /health. Resolves with the `build` object on
 * success and with null on ANY failure (network, non-2xx, unparseable body,
 * missing `build`) — the caller renders the unknown state rather than throwing,
 * because an unreadable build identity must never break the ops UI.
 */
export async function fetchBuildInfo(fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;
  try {
    const res = await doFetch(window.location.origin + HEALTH_PATH, {
      // The build identity is fixed for the life of the process, but the
      // process may have been replaced since the last page view — so never
      // serve this from the HTTP cache.
      cache: 'no-store',
    });
    if (!res || !res.ok) return null;
    const health = await res.json();
    return hasBuild(health) ? health.build : null;
  } catch (_) {
    return null;
  }
}

/**
 * Fill a mount element with the indicator.
 *
 * Accessibility (WCAG 2.1 AA): the short version string is real text, so it is
 * announced, selectable and zoomable. The full details are reachable three ways
 * — never hover-only, which would fail 1.4.13/2.1.1 for keyboard and
 * screen-reader users:
 *   1. `title` for a pointer hover,
 *   2. a focusable <button> that toggles a visible details block (keyboard),
 *   3. `aria-expanded` + an adjacent live region so the toggle state and the
 *      revealed text are announced.
 * All text goes in via textContent, so nothing from the wire is interpolated
 * into markup (same rule as app.js's escHtml discipline).
 */
export function renderBuildIndicator(mount, build, stack) {
  if (!mount) return;
  mount.textContent = '';

  const details = formatBuildDetails(build, stack);
  const label = formatBuildLabel(build);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'build-indicator-toggle';
  btn.title = build ? details : UNKNOWN_TITLE;
  btn.setAttribute('aria-expanded', 'false');
  // Name the control for assistive tech: the visible text is just a version
  // string, which on its own does not say what the control does.
  btn.setAttribute(
    'aria-label',
    'Running build ' + label + '. Activate for full build details.'
  );

  const prefix = document.createElement('span');
  prefix.className = 'build-indicator-prefix';
  prefix.textContent = 'build';
  prefix.setAttribute('aria-hidden', 'true');

  const value = document.createElement('span');
  value.className = 'build-indicator-value';
  value.textContent = label;
  if (!build) value.classList.add('build-indicator-unknown');

  btn.appendChild(prefix);
  btn.appendChild(value);

  const panel = document.createElement('div');
  panel.className = 'build-indicator-details';
  panel.hidden = true;
  panel.textContent = details;

  btn.addEventListener('click', function () {
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    panel.hidden = open;
  });

  mount.appendChild(btn);
  mount.appendChild(panel);
}

/**
 * Entry point used by both realms (app.js for index.html, detail.js for the
 * detached detail windows — requirement 3; a separate window is a separate JS
 * realm, so each one fetches and logs for itself).
 *
 * @param {object}   opts
 * @param {Element}  opts.mount     element to render into (no-op when absent)
 * @param {string}   opts.stack     stack name the UI is pointed at
 * @param {Function} [opts.fetchImpl] injectable fetch, for tests
 * @param {object}   [opts.console]   injectable console, for tests
 * @returns {Promise<object|null>} the build object, or null when unreadable
 */
export async function initBuildIndicator(opts) {
  const o = opts || {};
  const build = await fetchBuildInfo(o.fetchImpl);
  renderBuildIndicator(o.mount, build, o.stack);
  const log = o.console || (typeof console !== 'undefined' ? console : null);
  if (log && typeof log.info === 'function') {
    // Requirement 2: exactly one line on load. Logged in both the known and
    // unknown case — "could not read the build" is itself the diagnostic an
    // operator needs when the indicator shows nothing useful.
    log.info(formatConsoleLine(build, o.stack), { build: build, stack: o.stack || null });
  }
  return build;
}

export { UNKNOWN_LABEL, HEALTH_PATH };
