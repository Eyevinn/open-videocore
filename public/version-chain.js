/**
 * open-videocore ops dashboard — version-chain.js
 *
 * The "Versions" block on the asset detail view (issue #942, broken out of
 * #795), implementing the interaction spec in
 * `docs/design/asset-version-chain.md` (issue #941): the whole version chain
 * rendered as a tree, the current version badged from the server's own field,
 * every other member navigable, and an explicit empty state for an asset that
 * has no other versions.
 *
 * READ-ONLY by construction. There is no promote / set-current endpoint in this
 * API (see CONTRACT GROUNDING), so this module creates no control that would
 * imply one: current is presented as observed state, never as an operator
 * choice.
 *
 * Every operator-visible string is written with `textContent` / `createElement`
 * — no server value ever reaches `innerHTML`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's generated spec and source on this branch. Nothing is
 * taken from the issue text. `openapi.json` declares no `operationId` on any
 * operation, so the operation is identified by path + method, as the spec
 * itself does.
 *
 *   OPERATION — `openapi.json .paths["/api/v1/assets/{id}/versions"]`; the only
 *     key is `get`. Its only parameter is path `id` (`type: string`,
 *     `required: true`) — there is NO pagination parameter. Handler:
 *     `app.get('/:id/versions')`, src/routes/assets.ts:3689-3727, mounted under
 *     the `/api/v1/assets` prefix.
 *
 *   200 ENVELOPE — that operation's
 *     `responses["200"].content["application/json"].schema`: properties
 *     `assetId`, `versionGroupId`, `currentVersionId`, `versions`;
 *     `required: ["assetId","currentVersionId","versions"]`,
 *     `additionalProperties: false`. Source: src/routes/assets.ts:3694-3699.
 *       - `assetId`          — the id that was queried, echoed (:3720). Always a
 *                              member, so it is what "you are here" marks.
 *       - `versionGroupId`   — OPTIONAL (`z.string().optional()`, :3696). Read
 *                              from the TARGET asset, not searched for in the
 *                              page (:3721, rationale :3708-3714). Absent means
 *                              the asset has never been versioned.
 *       - `currentVersionId` — REQUIRED (:3697), SERVER-computed by
 *                              `currentVersionId(versions)` (:3718, defined
 *                              src/data/asset-repo.ts:1275-1295).
 *       - `versions`         — `z.array(assetSchema)` (:3698); each item's
 *                              `required` is
 *                              `["id","name","status","statusHistory","createdAt","updatedAt"]`.
 *
 *   PER-MEMBER LINEAGE FIELDS — `versionOfAssetId` and `versionGroupId`, both
 *     `z.string().optional()` on `assetSchema` (src/routes/assets.ts:887-888).
 *     `versionOfAssetId` is the edge to the IMMEDIATE predecessor and is absent
 *     on the root; `versionGroupId` spans the whole lineage. Set at create by
 *     `resolveVersionLinkage` (src/data/asset-repo.ts:1210-1221) and immutable
 *     afterwards.
 *
 *   `status` ENUM — `uploading` | `processing` | `ready` | `failed` |
 *     `archived` (that schema's `versions.items.properties.status.enum`).
 *
 *   ORDERING — oldest first: `createdAt` ascending, ties broken by `id`
 *     ascending. One comparator, `compareVersionOrder`
 *     (src/data/asset-repo.ts:1231-1233), applied by both repositories.
 *     Pinned by src/routes/assets.versions.test.ts:146-204.
 *
 *   CURRENT VERSION IS NOT THE LAST ELEMENT. `currentVersionId` is a preference
 *     ladder over `status` — `ready`, then `uploading`|`processing`, then
 *     `failed`, then `archived`, newest-first within the highest non-empty tier
 *     (src/data/asset-repo.ts:1275-1295). The comment at :1239-1246 says
 *     outright that clients MUST read the field and MUST NOT re-derive it, and
 *     :1266-1270 that it names the head of the lineage WITHOUT promising the
 *     member is `ready`. Pinned by src/routes/assets.versions.test.ts:237-381
 *     (archived / in-flight / failed heads are all skipped). This module
 *     therefore compares ids against the field and never sorts or scans for a
 *     "latest".
 *
 *   THE CHAIN IS A TREE, NOT A LIST. Two versions cut from one source share a
 *     group and both carry the same `versionOfAssetId`; the endpoint returns the
 *     whole tree. Asserted by src/routes/assets.versions.test.ts:206-235 and
 *     documented by ADR-024 D4
 *     (docs/architecture/ADR-024-asset-version-chain-contract.md).
 *
 *   NEVER-VERSIONED ASSET — a single-member chain containing only itself, with
 *     `versionGroupId` ABSENT (src/data/asset-repo.ts:1811-1813,
 *     src/data/couch-asset-repo.ts:620-622; pinned by
 *     src/routes/assets.versions.test.ts:112-126). There is NO empty `versions`
 *     array for an existing asset, so the empty state is detected as
 *     `versions.length === 1 && !versionGroupId` — never as `length === 0`,
 *     which is unreachable.
 *
 *   404 — `{ error: string, message?: string }`, `required: ["error"]`; the
 *     handler sends `{ error: 'not_found' }` (src/routes/assets.ts:3707). Flat
 *     strings, NOT the nested `{ error: { code, message } }` envelope.
 *
 *   TRUNCATION — the chain is not paginated, but `listVersions` caps the page at
 *     `MAX_LIMIT = 200` (src/data/asset-repo.ts:853, applied
 *     src/data/couch-asset-repo.ts:626) and `currentVersionId` is computed from
 *     the page that came back (ADR-024 D6). At exactly the cap the view says so
 *     rather than quietly presenting a possibly-wrong head, and a member whose
 *     `versionOfAssetId` is not in the page is shown as an orphan rather than
 *     reparented.
 *
 * WHAT THE API DOES NOT EXPOSE (checked, not assumed):
 *   - No promote / set-current operation: no path in `openapi.json` contains
 *     "current", and `assetSchema` carries no operator-set current marker. So
 *     no "Make current" control exists here (spec §0 gap 1).
 *   - No per-version label, note or author: a member carries `name`, `status`,
 *     `createdAt` and the lineage edges, nothing that says WHY it exists
 *     (spec §0 gap 2).
 */

// The established asset-id affordance (issue #851): the full ULID as selectable
// monospace text plus an always-visible copy button. Reused rather than
// restated so a version id behaves like every other id in this UI. The helper
// escapes the value it interpolates (public/copy-id.js:76-91).
import { copyableIdCellHtml, wireCopyIdButtons } from './copy-id.js';

// ─── Copy deck ───────────────────────────────────────────────────────────────

export const VERSIONS_COPY = Object.freeze({
  heading: 'Versions',
  /** Shown beside the heading when the asset belongs to a lineage. */
  groupLabel: 'versionGroupId',

  /** The one badge that marks `currentVersionId`. Never "Latest" — the ladder
   *  skips in-flight and failed members, so "latest" would be a lie. */
  currentBadge: 'Current',
  currentBadgeConsequence:
    'Current version: the newest version of this asset that is usable.',
  /** The row for the asset the detail view is showing. */
  hereMarker: 'you are here',

  /** Current names the head of the lineage; it does not promise playability. */
  nothingReadyNote:
    'No version of this asset is ready yet. Current names the newest version ' +
    'in the chain.',

  /** Members whose source version fell outside the returned page. */
  orphanGroup: 'Source version not in this list',

  truncationNote:
    'Showing the first 200 versions of this chain. Some versions are not ' +
    'listed, and the current version shown may not be the newest one.',

  /** Empty state: a chain of one. Not an error, and not an action prompt. */
  empty: 'This asset has no other versions.',
  emptyDetail:
    'Versions are created by running a clip or export with asVersion enabled.',

  /** Fetch failure — a fact about the request, never about the asset. */
  errorPrefix: 'Could not load versions: ',
  retry: 'Retry',

  prev: 'Previous version',
  next: 'Next version',
  /** Says which ordering the stepper walks, because the chain is a tree. */
  navNote: 'Oldest first, in the order the API returned.',

  loading: 'Loading versions…',
  /** A member the server sent without the optional field. */
  absent: '—',
});

/** `MAX_LIMIT`, src/data/asset-repo.ts:853 — the cap `listVersions` applies. */
export const VERSION_PAGE_LIMIT = 200;

/**
 * Visual indent ceiling. Depth beyond this renders at the cap so a long chain
 * cannot run off the panel; `aria-level` still carries the true depth.
 */
export const VERSION_DEPTH_CAP = 4;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Normalise a `GET /api/v1/assets/{id}/versions` 200 body into the shape the
 * renderer consumes, without inventing anything.
 *
 * `assetId` and `currentVersionId` are `required` on the wire, so the fallbacks
 * here only fire for a non-conforming server: `assetId` falls back to the id
 * that was requested (the one fact the caller already knows), and
 * `currentVersionId` falls back to the empty string, which matches no member and
 * simply leaves the Current badge off rather than guessing which row deserves
 * it. `versionGroupId` is genuinely optional and stays `null` when absent —
 * that absence is what the empty state is detected from.
 *
 * @param {unknown} body       the 200 body
 * @param {string} requestedId the id the request was made for
 * @returns {{assetId: string, versionGroupId: string|null, currentVersionId: string, versions: object[]}}
 */
export function normaliseVersionsRead(body, requestedId) {
  const b = body && typeof body === 'object' ? body : {};
  const versions = Array.isArray(b.versions)
    ? b.versions.filter(function (v) {
        return v !== null && typeof v === 'object' && typeof v.id === 'string' && v.id !== '';
      })
    : [];
  return {
    assetId: typeof b.assetId === 'string' && b.assetId !== '' ? b.assetId : String(requestedId || ''),
    versionGroupId:
      typeof b.versionGroupId === 'string' && b.versionGroupId !== '' ? b.versionGroupId : null,
    currentVersionId: typeof b.currentVersionId === 'string' ? b.currentVersionId : '',
    versions: versions,
  };
}

/**
 * Is this the "no other versions" case?
 *
 * `versions.length === 1 && !versionGroupId` — the single-member chain a
 * never-versioned asset returns (src/data/asset-repo.ts:1811-1813). Deliberately
 * NOT `versions.length === 0`: that shape does not occur for an existing asset,
 * so a branch testing for it could never run.
 *
 * @param {{versions: object[], versionGroupId: string|null}} read
 * @returns {boolean}
 */
export function isUnversioned(read) {
  const r = read || {};
  return Array.isArray(r.versions) && r.versions.length === 1 && !r.versionGroupId;
}

/**
 * Did the page hit `MAX_LIMIT`? At the cap the lineage may continue past the
 * window and `currentVersionId` may name the head of the PAGE (ADR-024 D6).
 *
 * @param {{versions: object[]}} read
 * @returns {boolean}
 */
export function isVersionChainTruncated(read) {
  const r = read || {};
  return Array.isArray(r.versions) && r.versions.length >= VERSION_PAGE_LIMIT;
}

/**
 * The member named by `currentVersionId`, or `null` when the page does not
 * contain it (only reachable on a truncated chain or a non-conforming server).
 *
 * @param {{versions: object[], currentVersionId: string}} read
 * @returns {object|null}
 */
export function currentVersionMember(read) {
  const r = read || {};
  if (!Array.isArray(r.versions)) return null;
  for (let i = 0; i < r.versions.length; i++) {
    if (r.versions[i].id === r.currentVersionId) return r.versions[i];
  }
  return null;
}

/**
 * Reconstruct the chain's TREE from the flat, oldest-first `versions`
 * projection, and return it as rows ready to render.
 *
 * The rule (spec §2): index by `id`; the root is the member with no
 * `versionOfAssetId`; every other member attaches under the member its
 * `versionOfAssetId` names. Children keep the server's order, so a strictly
 * linear chain falls out as a flat, un-indented list.
 *
 * A member whose `versionOfAssetId` names an id that is NOT in the page is an
 * ORPHAN and is returned separately. Orphans are never dropped and never
 * reparented to the root — that would fabricate a lineage edge the API did not
 * report. A member that is part of a reference cycle (impossible through the
 * API, since `versionOfAssetId` is set at create and immutable, but cheap to
 * survive) is reported as an orphan too rather than hanging the walk.
 *
 * @param {{versions: object[]}} read
 * @returns {{rows: {version: object, depth: number, last: boolean}[], orphans: {version: object, depth: number, last: boolean}[]}}
 */
export function buildVersionRows(read) {
  const versions = read && Array.isArray(read.versions) ? read.versions : [];
  const byId = new Map();
  versions.forEach(function (v) {
    if (!byId.has(v.id)) byId.set(v.id, v);
  });

  const children = new Map();
  const roots = [];
  const orphans = [];
  versions.forEach(function (v) {
    const src = typeof v.versionOfAssetId === 'string' ? v.versionOfAssetId : '';
    if (src === '') {
      roots.push(v);
      return;
    }
    if (src === v.id || !byId.has(src)) {
      orphans.push(v);
      return;
    }
    if (!children.has(src)) children.set(src, []);
    children.get(src).push(v);
  });

  const rows = [];
  const emitted = new Set();
  const walk = function (node, depth, last) {
    if (emitted.has(node.id)) return;
    emitted.add(node.id);
    rows.push({ version: node, depth: depth, last: last });
    const kids = children.get(node.id) || [];
    kids.forEach(function (kid, i) {
      walk(kid, depth + 1, i === kids.length - 1);
    });
  };
  roots.forEach(function (root, i) {
    walk(root, 0, i === roots.length - 1);
  });

  // Anything neither emitted nor already flagged: a cycle member, or a child of
  // one. Report it, in server order, rather than losing it.
  const orphanIds = new Set(
    orphans.map(function (v) {
      return v.id;
    })
  );
  versions.forEach(function (v) {
    if (!emitted.has(v.id) && !orphanIds.has(v.id)) {
      orphans.push(v);
      orphanIds.add(v.id);
    }
  });

  return {
    rows: rows,
    orphans: orphans.map(function (v, i, all) {
      return { version: v, depth: 0, last: i === all.length - 1 };
    }),
  };
}

/**
 * Where the viewed asset sits in `versions`, and which members step away from
 * it, in ARRAY order (oldest → newest).
 *
 * Array order, not tree order: it is the server's declared total order and is
 * stable across reads, so stepping is predictable on a branching chain where
 * "next" has no single tree answer (spec §4).
 *
 * @param {{versions: object[], assetId: string}} read
 * @returns {{index: number, total: number, prevId: string|null, nextId: string|null}}
 */
export function versionChainPosition(read) {
  const r = read || {};
  const versions = Array.isArray(r.versions) ? r.versions : [];
  let index = -1;
  for (let i = 0; i < versions.length; i++) {
    if (versions[i].id === r.assetId) {
      index = i;
      break;
    }
  }
  return {
    index: index,
    total: versions.length,
    prevId: index > 0 ? versions[index - 1].id : null,
    nextId: index !== -1 && index < versions.length - 1 ? versions[index + 1].id : null,
  };
}

/**
 * The row label: the member's `name` (`required` on each item), falling back to
 * its id when a server omitted it — the same degradation the jobs detail pane
 * uses for a missing asset name (public/app.js:3604-3607).
 *
 * @param {object} version
 * @returns {string}
 */
export function versionLabel(version) {
  const v = version || {};
  if (typeof v.name === 'string' && v.name !== '') return v.name;
  return typeof v.id === 'string' && v.id !== '' ? v.id : VERSIONS_COPY.absent;
}

/**
 * `createdAt` as ISO 8601 UTC (spec §2). The field is `required` and already an
 * ISO instant; an unparseable value is shown verbatim rather than replaced.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function isoUtc(value) {
  if (value === undefined || value === null || value === '') return VERSIONS_COPY.absent;
  const d = new Date(String(value));
  if (isNaN(d.getTime())) return String(value);
  return d.toISOString();
}

/** The `.badge-*` class for a lifecycle status, mirroring public/app.js. */
function statusBadgeClass(status) {
  const s = typeof status === 'string' ? status.toLowerCase() : '';
  if (s === 'ready') return 'badge-ready';
  if (s === 'uploading' || s === 'processing') return 'badge-pending';
  if (s === 'failed' || s === 'archived') return 'badge-failed';
  return 'badge-unknown';
}

/** Tree connector for a row. Decorative: duplicated by `aria-level` + text. */
function connectorFor(depth, last) {
  if (depth <= 0) return '';
  return last ? '└─' : '├─';
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function sectionHeading(read) {
  const head = el('div', 'version-chain-head');
  head.appendChild(el('div', 'section-title', VERSIONS_COPY.heading));
  // The group id identifies the lineage; the empty state leaves the slot empty
  // rather than printing "none" (spec §5).
  if (read && read.versionGroupId) {
    const group = el('div', 'version-group');
    group.appendChild(el('span', 'version-group-label', VERSIONS_COPY.groupLabel));
    group.appendChild(el('span', 'text-mono version-group-id', read.versionGroupId));
    head.appendChild(group);
  }
  return head;
}

/**
 * One row of the chain.
 *
 * `current` and `here` are different facts and frequently land on different
 * rows, so they are separate elements and can coexist (spec §3). The Current
 * slot is always present, so rows stay aligned whether or not the badge is in
 * it.
 */
function renderVersionRow(entry, read, canNavigate) {
  const v = entry.version;
  const isHere = v.id === read.assetId;
  const isCurrent = v.id === read.currentVersionId;

  const li = el('li', 'version-row version-depth-' + Math.min(entry.depth, VERSION_DEPTH_CAP));
  li.setAttribute('data-version-id', v.id);
  li.setAttribute('aria-level', String(entry.depth + 1));
  if (isHere) {
    li.classList.add('version-row-here');
    li.setAttribute('aria-current', 'true');
    // Focus target after an in-chain navigation; never in the tab order.
    li.setAttribute('tabindex', '-1');
  }
  if (typeof v.status === 'string' && v.status.toLowerCase() === 'archived') {
    li.classList.add('version-row-archived');
  }

  const connector = connectorFor(entry.depth, entry.last);
  if (connector) {
    const c = el('span', 'version-connector', connector);
    c.setAttribute('aria-hidden', 'true');
    li.appendChild(c);
  }

  const currentSlot = el('span', 'version-current-slot');
  if (isCurrent) {
    const badge = el('span', 'badge badge-current', VERSIONS_COPY.currentBadge);
    // Text, not colour alone, carries the state (WCAG 1.4.1); the consequence
    // clause follows the `.badge-locked` convention.
    badge.appendChild(el('span', 'visually-hidden', ' ' + VERSIONS_COPY.currentBadgeConsequence));
    currentSlot.appendChild(badge);
  }
  li.appendChild(currentSlot);

  const label = versionLabel(v);
  if (isHere || !canNavigate) {
    li.appendChild(el('span', 'version-name', label));
  } else {
    const link = el('a', 'version-name version-link', label);
    link.setAttribute('href', '#');
    // Same delegated convention the jobs pane uses for an asset link
    // (public/app.js:3604).
    link.setAttribute('data-asset-id', v.id);
    li.appendChild(link);
  }

  const status = el('span', 'badge ' + statusBadgeClass(v.status), v.status || 'unknown');
  li.appendChild(status);

  li.appendChild(el('span', 'version-created text-mono', isoUtc(v.createdAt)));

  // Escaped by the helper; `mountVersionChain` binds the button.
  const idCell = el('span', 'version-id');
  idCell.innerHTML = copyableIdCellHtml(v.id, 'Copy version id');
  li.appendChild(idCell);

  if (isHere) {
    li.appendChild(el('span', 'version-here', VERSIONS_COPY.hereMarker));
  }

  // The connector is the only visual carrier of the lineage edge, so name the
  // source version in text for assistive technology.
  if (typeof v.versionOfAssetId === 'string' && v.versionOfAssetId !== '') {
    const source = (read.versions || []).filter(function (m) {
      return m.id === v.versionOfAssetId;
    })[0];
    li.appendChild(
      el(
        'span',
        'visually-hidden',
        ' Source version: ' + (source ? versionLabel(source) : v.versionOfAssetId) + '.'
      )
    );
  }

  return li;
}

function renderRowList(entries, read, canNavigate) {
  const list = el('ul', 'version-chain-list');
  entries.forEach(function (entry) {
    list.appendChild(renderVersionRow(entry, read, canNavigate));
  });
  return list;
}

function renderStepper(read, canNavigate) {
  const pos = versionChainPosition(read);
  const nav = el('div', 'version-chain-nav');

  const prev = el('button', 'btn-ghost', VERSIONS_COPY.prev);
  prev.type = 'button';
  prev.id = 'version-prev';
  prev.disabled = !canNavigate || !pos.prevId;
  if (pos.prevId) prev.setAttribute('data-asset-id', pos.prevId);

  const next = el('button', 'btn-ghost', VERSIONS_COPY.next);
  next.type = 'button';
  next.id = 'version-next';
  next.disabled = !canNavigate || !pos.nextId;
  if (pos.nextId) next.setAttribute('data-asset-id', pos.nextId);

  nav.appendChild(prev);
  nav.appendChild(next);
  if (pos.index !== -1) {
    nav.appendChild(
      el(
        'span',
        'version-nav-position',
        'Version ' + (pos.index + 1) + ' of ' + pos.total + '. ' + VERSIONS_COPY.navNote
      )
    );
  }
  return nav;
}

// ─── Block renderers ─────────────────────────────────────────────────────────

/** The shell every state shares, so the section never disappears. */
function versionsBlock(read) {
  const block = el('div', 'mt12 version-chain-block');
  block.id = 'asset-versions';
  block.appendChild(sectionHeading(read));
  return block;
}

/**
 * Render the whole "Versions" block from one normalised read. Pure: no network,
 * no listeners — `mountVersionChain` wires the behaviour.
 *
 * @param {{assetId: string, versionGroupId: string|null, currentVersionId: string, versions: object[]}} read
 * @param {{canNavigate?: boolean}} [opts]
 * @returns {HTMLElement}
 */
export function renderVersionChainBlock(read, opts) {
  const o = opts || {};
  const canNavigate = o.canNavigate !== false;
  const block = versionsBlock(read);

  // Empty state: a chain of one, with no group. Rendered as a section, not
  // hidden, and with no action button — creating a version is the clip/export
  // flow elsewhere on this page (spec §5).
  if (isUnversioned(read)) {
    const empty = el('div', 'empty', VERSIONS_COPY.empty);
    empty.setAttribute('data-empty', 'versions');
    empty.appendChild(el('div', 'version-note', VERSIONS_COPY.emptyDetail));
    block.appendChild(empty);
    return block;
  }

  if (isVersionChainTruncated(read)) {
    const note = el('div', 'version-note version-truncation', VERSIONS_COPY.truncationNote);
    note.setAttribute('data-note', 'truncated');
    block.appendChild(note);
  }

  // Current names the head of the lineage, not a servable member. When the
  // named member is not `ready`, say so — and keep the badge, so the view does
  // not disagree with the API (spec §3).
  const current = currentVersionMember(read);
  if (current && current.status !== 'ready') {
    const note = el('div', 'version-note version-not-ready', VERSIONS_COPY.nothingReadyNote);
    note.setAttribute('data-note', 'nothing-ready');
    block.appendChild(note);
  }

  const tree = buildVersionRows(read);
  block.appendChild(renderRowList(tree.rows, read, canNavigate));

  if (tree.orphans.length > 0) {
    const orphanTitle = el('div', 'version-group-title', VERSIONS_COPY.orphanGroup);
    orphanTitle.setAttribute('data-group', 'orphans');
    block.appendChild(orphanTitle);
    block.appendChild(renderRowList(tree.orphans, read, canNavigate));
  }

  block.appendChild(renderStepper(read, canNavigate));
  return block;
}

/**
 * The in-flight state. Keeps the heading so the section does not pop in and
 * out of the page as the detail view loads.
 *
 * @returns {HTMLElement}
 */
export function renderVersionChainLoading() {
  const block = versionsBlock(null);
  const loading = el('div', 'loading');
  const spinner = el('span', 'spinner');
  spinner.setAttribute('aria-hidden', 'true');
  loading.appendChild(spinner);
  loading.appendChild(document.createTextNode(' ' + VERSIONS_COPY.loading));
  block.appendChild(loading);
  return block;
}

/**
 * The fetch-failure state: a fact about the REQUEST, with a retry. Never
 * degraded into "no other versions", which would read as a fact about the asset
 * (spec §5).
 *
 * @param {string} message  the server's `message`, else its `error`
 * @returns {HTMLElement}
 */
export function renderVersionChainError(message) {
  const block = versionsBlock(null);
  const box = el('div', 'msg msg-error', VERSIONS_COPY.errorPrefix + String(message || ''));
  box.setAttribute('role', 'alert');
  box.setAttribute('data-error', 'versions');
  const retry = el('button', 'btn-ghost version-retry', VERSIONS_COPY.retry);
  retry.type = 'button';
  retry.id = 'versions-retry';
  box.appendChild(retry);
  block.appendChild(box);
  return block;
}

/**
 * The flat error text for a failed read. `apiFetch` already prefers the body's
 * `message` over its `error` (public/app.js:298-303); this re-reads the parsed
 * body defensively for callers that do not.
 */
export function versionChainErrorText(err) {
  const e = err || {};
  const body = e.body && typeof e.body === 'object' ? e.body : {};
  if (typeof body.message === 'string' && body.message !== '') return body.message;
  if (typeof e.message === 'string' && e.message !== '') return e.message;
  if (typeof body.error === 'string' && body.error !== '') return body.error;
  return 'request failed';
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Fetch and render the "Versions" block into the asset detail view.
 *
 * Options:
 *   assetId     the ULID of the asset being viewed (the path param).
 *   apiFetch    the shared fetch wrapper.
 *   host        element to append the block to when there is no anchor.
 *   anchorEl    optional element to insert before.
 *   onNavigate  async (id) => void — opens another version's detail. Omit it
 *               and rows render as plain text instead of dead links.
 *   focusHere   when true, move focus to the you-are-here row once rendered;
 *               set after an in-chain navigation so the reader keeps their
 *               place in the chain (spec §4).
 *
 * Re-fetches on every mount: the envelope is target-relative (`assetId` moves),
 * and carrying the previous response over would show a stale chain.
 *
 * @returns {Promise<{block: HTMLElement|null, reload: (focus?: boolean) => Promise<void>}>}
 */
export async function mountVersionChain(opts) {
  const o = opts || {};
  const apiFetch = o.apiFetch;
  const assetId = String(o.assetId || '');
  const path = '/assets/' + encodeURIComponent(assetId) + '/versions';
  const canNavigate = typeof o.onNavigate === 'function';

  let rendered = null;
  let placed = false;

  function place(block) {
    if (!placed) {
      if (o.anchorEl && o.anchorEl.parentNode) {
        o.anchorEl.parentNode.insertBefore(block, o.anchorEl);
      } else if (o.host) {
        o.host.appendChild(block);
      }
      placed = true;
      rendered = block;
      return;
    }
    if (rendered && rendered.parentNode) {
      rendered.parentNode.replaceChild(block, rendered);
    }
    rendered = block;
  }

  function navigate(id) {
    if (!canNavigate || !id) return;
    Promise.resolve(o.onNavigate(id)).catch(function () {
      /* the navigation target renders its own failure */
    });
  }

  function wire(block, focusHere) {
    // Click-to-copy on every version id, the same binding the detail KV grid
    // and the assets table use.
    wireCopyIdButtons(block);
    block.querySelectorAll('.version-link').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        navigate(link.getAttribute('data-asset-id'));
      });
    });
    ['#version-prev', '#version-next'].forEach(function (sel) {
      const btn = block.querySelector(sel);
      if (!btn || btn.disabled) return;
      btn.addEventListener('click', function () {
        navigate(btn.getAttribute('data-asset-id'));
      });
    });
    const retry = block.querySelector('#versions-retry');
    if (retry) {
      retry.addEventListener('click', function () {
        load(false);
      });
    }
    if (!focusHere) return;
    const here = block.querySelector('.version-row-here');
    if (!here) return;
    try {
      if (typeof here.scrollIntoView === 'function') here.scrollIntoView({ block: 'nearest' });
      if (typeof here.focus === 'function') here.focus({ preventScroll: true });
    } catch (_) {
      /* a DOM without scrollIntoView/focus options must not break the render */
    }
  }

  async function load(focusHere) {
    let body;
    try {
      body = await apiFetch(path);
    } catch (err) {
      const block = renderVersionChainError(versionChainErrorText(err));
      place(block);
      wire(block, false);
      return;
    }
    const read = normaliseVersionsRead(body, assetId);
    const block = renderVersionChainBlock(read, { canNavigate: canNavigate });
    place(block);
    wire(block, focusHere === true);
  }

  place(renderVersionChainLoading());
  await load(o.focusHere === true);

  return {
    get block() {
      return rendered;
    },
    reload: function (focus) {
      return load(focus === true);
    },
  };
}
