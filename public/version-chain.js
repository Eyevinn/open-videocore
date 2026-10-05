/**
 * open-videocore ops dashboard — version-chain.js
 *
 * The "Versions" block on the asset detail view (issue #907, broken out of
 * #795): the whole version chain an asset belongs to, rendered as the TREE the
 * API can describe, with the server's current version badged, the asset being
 * viewed marked separately, every other member navigable, and an explicit state
 * for an asset that has no other versions.
 *
 * READ-ONLY by construction. This module creates no form controls and issues no
 * POST/PUT/DELETE. That is not a scoping choice: there is no promote /
 * set-current endpoint and no stored "current" marker anywhere in the contract
 * (see CONTRACT GROUNDING), so a "Make current" control would have nothing to
 * send. Current is presented as observed state, never as an operator choice.
 *
 * Every operator-visible string is written with `textContent` / `createElement`
 * — no server value ever reaches `innerHTML`, including a version `name` or a
 * `status` this build does not recognise, which are rendered verbatim as text
 * rather than guessed at or dropped.
 *
 * Implements docs/design/asset-version-chain.md (issue #941) §7, "What the
 * implementation ticket inherits", point by point.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's generated spec and route source on this branch, never
 * from the issue text. `openapi.json` declares no `operationId` on any
 * operation, so the operation is identified below by path + method, as the spec
 * itself does.
 *
 *   THE ONE CALL THIS PANEL MAKES —
 *   `openapi.json .paths["/api/v1/assets/{id}/versions"]`, whose ONLY key is
 *   `get`. Handler: src/routes/assets.ts:3446-3484.
 *
 *   PATH PARAMETER — `.get.parameters` is exactly one entry: `id`, `in: path`,
 *     `required: true`, `type: string` (`params: z.object({ id: z.string() })`,
 *     src/routes/assets.ts:3450). There are NO query parameters: the chain is
 *     returned whole and is NOT paginated (ADR-024 D6).
 *     The panel sends the ULID, never the slug: the handler passes the raw param
 *     to `repo.listVersions` (src/routes/assets.ts:3463), which looks the asset
 *     up by id alone (`this.store.get(id)`, src/data/asset-repo.ts:1806), so a
 *     slug would 404 here even though `GET /assets/{id}` accepts one.
 *
 *   200 ENVELOPE — `.get.responses["200"].content["application/json"].schema`:
 *     properties `assetId`, `versionGroupId`, `currentVersionId`, `versions`;
 *     `required: ["assetId","currentVersionId","versions"]`
 *     (src/routes/assets.ts:3452-3457).
 *       `assetId`          the id that was queried, echoed (:3478). Always a
 *                          member — this is the "you are here" row.
 *       `versionGroupId`   OPTIONAL (absent from `required`). Read off the
 *                          TARGET asset, not searched for in the page
 *                          (`versionGroupId: target?.versionGroupId`, :3479).
 *                          Absent means the asset has no lineage yet.
 *       `currentVersionId` REQUIRED. SERVER-COMPUTED: `currentVersionId(versions)`
 *                          (:3476), defined src/data/asset-repo.ts:1275-1294.
 *       `versions`         REQUIRED. `z.array(assetSchema)` (:3456) — the whole
 *                          chain, oldest first.
 *
 *   PER-MEMBER FIELDS — items are the full `assetSchema`,
 *     `required: ["id","name","status","statusHistory","createdAt","updatedAt"]`.
 *     This panel reads exactly five of them: `id`, `name`, `status`,
 *     `createdAt`, plus the optional lineage edge
 *     `versionOfAssetId: z.string().optional()` (src/routes/assets.ts:882;
 *     `versionGroupId: z.string().optional()` at :883 is the member's own copy
 *     of the group and is not read here — the envelope's copy is authoritative).
 *     `status` enum = uploading | processing | ready | failed | archived.
 *
 *   ORDERING — oldest first: `createdAt` ascending, ties broken by `id`
 *     ascending, by the single comparator `compareVersionOrder`
 *     (src/data/asset-repo.ts:1231-1233), applied by both repositories
 *     (src/data/asset-repo.ts:1817 in-memory, src/data/couch-asset-repo.ts:631).
 *     Ids are ULIDs, so the tiebreak is total and time-ordered.
 *
 *   CURRENT IS NOT THE LAST ELEMENT — src/data/asset-repo.ts:1239-1243 says so
 *     explicitly. The rule is a preference ladder over `status`
 *     (:1245-1262): `ready` -> (`uploading`|`processing`) -> `failed` ->
 *     `archived`, newest-first within the highest non-empty tier. So a chain
 *     whose newest member is `processing` reports an OLDER member as current.
 *     This panel therefore READS `currentVersionId` and never re-derives it.
 *     It also does not promise playability: ":1264-1269 — `currentVersionId`
 *     names the head of the lineage, it does not promise `ready`", so the
 *     member's own `status` badge is shown alongside the Current badge.
 *
 *   MEMBERSHIP — group-scoped, ALWAYS includes the target, and INCLUDES
 *     `archived` members: this is lineage history, not a live-asset listing
 *     (`listVersions`, src/data/asset-repo.ts:1805-1819;
 *     src/data/couch-asset-repo.ts:613-633; the route comment at
 *     src/routes/assets.ts:3440-3441). Archived members stay in the list and
 *     stay navigable.
 *
 *   NEVER-VERSIONED ASSET — a SINGLE-MEMBER chain containing only itself, with
 *     `versionGroupId` ABSENT: `if (!asset.versionGroupId) return [{ ...asset }]`
 *     (src/data/asset-repo.ts:1811-1813, mirrored
 *     src/data/couch-asset-repo.ts:620-622). There is no empty `versions` array
 *     for an existing asset, so the "no versions" state is detected as
 *     `versions.length === 1 && !versionGroupId` — never as `length === 0`,
 *     which is a branch nothing can reach.
 *
 *   CHAINS BRANCH — `resolveVersionLinkage` (src/data/asset-repo.ts:1210-1221)
 *     sets `versionOfAssetId` to the IMMEDIATE source and reuses that source's
 *     existing `versionGroupId`, and nothing rejects a second `asVersion`
 *     operation against the same source. Two siblings naming one predecessor is
 *     asserted behaviour, not an inference: src/routes/assets.versions.test.ts
 *     builds exactly that shape. `versions` is a flat projection of a tree, so
 *     this panel reconstructs the tree from `versionOfAssetId` (ADR-024 D4).
 *
 *   TRUNCATION — the chain is bounded by `MAX_LIMIT = 200`
 *     (src/data/asset-repo.ts:853) inside `listVersions`
 *     (src/data/couch-asset-repo.ts:626), and `currentVersionId` is computed
 *     from the page that came back (src/routes/assets.ts:3476), so a lineage
 *     over 200 can name the head of the PAGE rather than of the chain
 *     (ADR-024 D6). The route itself documents the matching hazard at
 *     :3467-3471. Hence the truncation notice and the orphan group below.
 *
 *   404 BODY — `{ error: string, message?: string }`, `required: ["error"]`,
 *     `additionalProperties: false` (`errorSchema`, src/routes/assets.ts:529;
 *     the handler sends `{ error: 'not_found' }` at :3465). FLAT strings — not
 *     the `{ error: { code, message } }` envelope used elsewhere in the API.
 *
 * WHAT THE API DOES NOT EXPOSE (checked, not assumed):
 *   - No promote / set-current / reorder operation on any path. The only two
 *     ways a version is ever created are `asVersion: true` on
 *     `POST /assets/{id}/export` and `POST /assets/{id}/clip`
 *     (`exportBodySchema` / `clipBodySchema`, src/routes/assets.ts:720, :733),
 *     both of which live elsewhere on this page. So this panel offers no
 *     create, promote or reorder control.
 *   - No per-version label, note or author. `assetSchema` carries `name`,
 *     `status`, `createdAt` and the lineage edges and nothing else that could
 *     say WHY a version exists, so no column claims to.
 *   - `?parentId=` is a DIFFERENT relationship — the rendition/child hierarchy,
 *     not edit versions (src/routes/assets.ts:3422-3423). The word "parent" is
 *     therefore never used here; a version's predecessor is its "source
 *     version".
 */

// ─── Copy deck ───────────────────────────────────────────────────────────────

export const VERSION_CHAIN_COPY = Object.freeze({
  heading: 'Versions',
  /** Says what the block is and that it only reports. */
  intro:
    'Every version in this asset’s chain, oldest first. Read-only — ' +
    'versions are created by running a clip or export with asVersion enabled.',

  groupKey: 'Version group',

  /** Column headers. "Source version", never "parent" (that is renditions). */
  colVersion: 'Version',
  colStatus: 'Status',
  colCreated: 'Created (UTC)',
  colId: 'Asset ID',
  tableCaption: 'Version chain, oldest first',

  /**
   * The Current badge. Never "Latest": `currentVersionId` is the newest USABLE
   * member, so on a chain whose newest member is `processing` or `failed` the
   * word "latest" would be false (src/data/asset-repo.ts:1245-1262).
   */
  current: 'Current',
  /** Visually-hidden consequence clause, mirroring the lock badge convention. */
  currentConsequence:
    'Current version: the newest version of this asset that is usable.',
  /** The row for the asset this page is showing. A different fact from Current. */
  youAreHere: 'You are here',
  youAreHereConsequence: 'This is the version you are viewing.',

  /** Prefix for the visually-hidden lineage edge on an indented row. */
  sourceVersionPrefix: 'Source version: ',

  /**
   * Current names the head of the lineage, NOT a playable asset
   * (src/data/asset-repo.ts:1264-1269). Shown when the current member's own
   * status is not `ready`.
   */
  noReadyVersion:
    'No version of this asset is ready yet. Current names the newest version ' +
    'in the chain.',

  /** Members whose source version fell outside the returned page. */
  orphanHeading: 'Source version not in this list',
  orphanNote:
    'These versions name a source version that is not in the list above, so ' +
    'their place in the chain cannot be shown.',

  /** Step controls, in the server's array order (oldest -> newest). */
  stepGroupLabel: 'Step through versions',
  stepPrevious: 'Previous version',
  stepNext: 'Next version',
  stepPosition: 'Version %POS% of %TOTAL%',

  /** The single-member chain — the "no versions" state (NOT an empty array). */
  emptyHeadline: 'This asset has no other versions.',
  emptyDetail:
    'Versions are created by running a clip or export with asVersion enabled.',

  /** Truncation above MAX_LIMIT. */
  truncated:
    'Showing the first 200 versions of this chain. Some versions are not ' +
    'listed, and the current version shown may not be the newest one.',

  /** Fetch failure — a fact about the request, never about the asset. */
  errorPrefix: 'Could not load versions: ',
  errorUnknown: 'the request failed.',
  retry: 'Retry',
  loading: 'Loading versions…',

  /** Any value the server omitted. */
  absent: '—',
});

/**
 * The server's page cap (`MAX_LIMIT`, src/data/asset-repo.ts:853). A page of
 * exactly this many members may be truncated.
 */
export const MAX_CHAIN_PAGE = 200;

/**
 * How deep the indent is allowed to grow before it is clamped, so a long chain
 * cannot run off the panel. Purely visual: the real depth is still carried in
 * `data-depth` and in the row's visually-hidden source-version line.
 */
export const DEPTH_CAP = 4;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Normalise one `GET /api/v1/assets/{id}/versions` 200 body into the shape the
 * renderer consumes, without inventing anything.
 *
 * `versionGroupId` stays `undefined` when the server omitted it — that absence
 * is load-bearing (it is what distinguishes a never-versioned asset), so it is
 * never defaulted to the asset id or to a placeholder.
 *
 * Non-object members are dropped (nothing `assetSchema` could have produced);
 * a member missing an optional field is kept and rendered as it arrived.
 *
 * @param {object} payload  a `GET /api/v1/assets/{id}/versions` 200 body
 * @returns {{assetId: string, versionGroupId: string|undefined,
 *            currentVersionId: string, versions: object[]}}
 */
export function normaliseVersionChain(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const versions = Array.isArray(p.versions)
    ? p.versions.filter(function (v) {
        return v !== null && typeof v === 'object' && typeof v.id === 'string' && v.id !== '';
      })
    : [];
  return {
    assetId: typeof p.assetId === 'string' ? p.assetId : '',
    versionGroupId: typeof p.versionGroupId === 'string' && p.versionGroupId !== ''
      ? p.versionGroupId
      : undefined,
    currentVersionId: typeof p.currentVersionId === 'string' ? p.currentVersionId : '',
    versions: versions,
  };
}

/**
 * The "no other versions" state.
 *
 * `listVersions` returns the asset itself when it has no `versionGroupId`
 * (src/data/asset-repo.ts:1811-1813), so the state arrives as a SINGLE-MEMBER
 * chain, never as an empty array. Testing for `length === 0` would produce a
 * branch nothing can reach.
 *
 * @param {{versions: object[], versionGroupId: string|undefined}} chain
 * @returns {boolean}
 */
export function isSingleMemberChain(chain) {
  const c = chain || {};
  return Array.isArray(c.versions) && c.versions.length === 1 && !c.versionGroupId;
}

/**
 * Whether the page may be truncated (ADR-024 D6). Exactly `MAX_CHAIN_PAGE`
 * members is the only observable signal the server gives.
 *
 * @param {{versions: object[]}} chain
 * @returns {boolean}
 */
export function isTruncatedChain(chain) {
  const c = chain || {};
  return Array.isArray(c.versions) && c.versions.length >= MAX_CHAIN_PAGE;
}

/**
 * Reconstruct the chain's tree from the flat, oldest-first projection.
 *
 * The root is the member with no `versionOfAssetId`. Every other member attaches
 * under the member its `versionOfAssetId` names. Siblings keep the order they
 * appear in `versions`, which preserves the server's ordering within each group.
 *
 * TWO EDGES ARE NEVER FABRICATED:
 *   - a member whose `versionOfAssetId` names an id not present in the page is
 *     an ORPHAN (its source fell outside the 200-member window);
 *   - a member caught in a cycle, or naming itself, is likewise an orphan.
 * Orphans are returned separately and are never silently reparented to the root
 * — that would assert a lineage edge the API did not report. They are never
 * dropped either.
 *
 * Depth is reported uncapped in `depth` and clamped in `indent` (DEPTH_CAP), so
 * the caller can draw a bounded indent without losing the real number.
 *
 * @param {object[]} versions  the `versions` array, in server order
 * @returns {{rows: {version: object, depth: number, indent: number,
 *            lastSibling: boolean, source: object|undefined}[],
 *           orphans: {version: object, depth: number, indent: number,
 *            lastSibling: boolean, source: object|undefined}[]}}
 */
export function buildVersionTree(versions) {
  const list = Array.isArray(versions)
    ? versions.filter(function (v) {
        return v !== null && typeof v === 'object' && typeof v.id === 'string' && v.id !== '';
      })
    : [];

  const byId = new Map();
  list.forEach(function (v) {
    if (!byId.has(v.id)) byId.set(v.id, v);
  });

  const roots = [];
  const orphans = [];
  const childrenOf = new Map();

  list.forEach(function (v) {
    const sourceId = typeof v.versionOfAssetId === 'string' ? v.versionOfAssetId : '';
    if (sourceId === '') {
      roots.push(v);
      return;
    }
    if (sourceId === v.id || !byId.has(sourceId)) {
      // Names itself, or names something outside this page: unplaceable.
      orphans.push(v);
      return;
    }
    const siblings = childrenOf.get(sourceId) || [];
    siblings.push(v);
    childrenOf.set(sourceId, siblings);
  });

  const rows = [];
  const emitted = new Set();

  const walk = function (version, depth, lastSibling, source) {
    if (emitted.has(version.id)) return;
    emitted.add(version.id);
    rows.push({
      version: version,
      depth: depth,
      indent: Math.min(depth, DEPTH_CAP),
      lastSibling: lastSibling,
      source: source,
    });
    const children = childrenOf.get(version.id) || [];
    children.forEach(function (child, i) {
      walk(child, depth + 1, i === children.length - 1, version);
    });
  };

  roots.forEach(function (root, i) {
    walk(root, 0, i === roots.length - 1, undefined);
  });

  // Anything still unplaced is part of a cycle the server should never emit.
  // Report it rather than dropping it.
  const stranded = list.filter(function (v) {
    return !emitted.has(v.id) && orphans.indexOf(v) === -1;
  });

  const orphanRows = orphans.concat(stranded).map(function (v, i, all) {
    return {
      version: v,
      depth: 0,
      indent: 0,
      lastSibling: i === all.length - 1,
      source: undefined,
    };
  });

  return { rows: rows, orphans: orphanRows };
}

/**
 * Where the asset being viewed sits in the server's array order, and which
 * members Previous / Next step to.
 *
 * ARRAY ORDER, NOT TREE ORDER. The array order is the server's declared total
 * order (`compareVersionOrder`, src/data/asset-repo.ts:1231-1233) and is stable
 * across reads; on a branching chain "the next one" has no single tree answer.
 *
 * `index` is -1 when the viewed asset is not in the page at all, which the route
 * itself warns is possible on a truncated lineage
 * (src/routes/assets.ts:3467-3471). Both steps are then unavailable rather than
 * guessing a position.
 *
 * @param {{assetId: string, versions: object[]}} chain
 * @returns {{index: number, total: number, previousId: string|null, nextId: string|null}}
 */
export function versionStepTargets(chain) {
  const c = chain || {};
  const versions = Array.isArray(c.versions) ? c.versions : [];
  let index = -1;
  for (let i = 0; i < versions.length; i++) {
    if (versions[i] && versions[i].id === c.assetId) {
      index = i;
      break;
    }
  }
  const at = function (i) {
    return i >= 0 && i < versions.length && versions[i] ? versions[i].id : null;
  };
  return {
    index: index,
    total: versions.length,
    previousId: index > 0 ? at(index - 1) : null,
    nextId: index >= 0 ? at(index + 1) : null,
  };
}

/**
 * `createdAt` as ISO 8601 UTC, so the chain's ordering is readable as written
 * and two rows are always comparable character by character.
 *
 * A value this build cannot parse is rendered verbatim rather than replaced:
 * the API owns the format.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function isoUtc(value) {
  if (value === undefined || value === null || value === '') {
    return VERSION_CHAIN_COPY.absent;
  }
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toISOString();
  } catch (_) {
    return String(value);
  }
}

/**
 * Default status -> badge class mapping, over the documented `status` enum
 * (uploading | processing | ready | failed | archived).
 *
 * Callers inside the ops UI inject the app's own `badgeClass` through
 * `opts.badgeClass` so one status never renders two ways on one page; this is
 * the fallback for standalone use.
 *
 * @param {unknown} status
 * @returns {string}
 */
export function versionStatusBadgeClass(status) {
  if (typeof status !== 'string' || status === '') return 'badge-unknown';
  const s = status.toLowerCase();
  if (s === 'ready') return 'badge-ready';
  if (s === 'uploading' || s === 'processing') return 'badge-pending';
  if (s === 'failed' || s === 'archived') return 'badge-failed';
  return 'badge-unknown';
}

/**
 * The inline message for a failed read, from the FLAT `{ error, message? }`
 * body this route sends (src/routes/assets.ts:529, :3465) — not the nested
 * `{ error: { code, message } }` envelope used elsewhere in the API.
 *
 * `apiFetch` already prefers `message` over `error` when building its Error, so
 * `err.message` is used first; `err.body` is read as the fallback.
 *
 * @param {{message?: string, body?: {error?: string, message?: string}}} err
 * @returns {string}
 */
export function versionChainErrorText(err) {
  const e = err || {};
  const body = e.body && typeof e.body === 'object' ? e.body : {};
  const detail =
    (typeof e.message === 'string' && e.message !== '' && e.message) ||
    (typeof body.message === 'string' && body.message !== '' && body.message) ||
    (typeof body.error === 'string' && body.error !== '' && body.error) ||
    VERSION_CHAIN_COPY.errorUnknown;
  return VERSION_CHAIN_COPY.errorPrefix + detail;
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Text that only assistive technology reads. */
function hidden(text) {
  return el('span', 'visually-hidden', text);
}

/**
 * The Current badge.
 *
 * A NEW `.badge` variant rather than a reuse of a status colour: Current is
 * orthogonal to `status` and the two sit on the same row. It carries the word
 * "Current" plus a visually-hidden consequence clause, so the state is never
 * carried by colour alone (WCAG 1.4.1).
 */
function renderCurrentBadge() {
  const badge = el('span', 'badge badge-current', VERSION_CHAIN_COPY.current);
  badge.setAttribute('data-version-current', 'true');
  badge.appendChild(hidden(' ' + VERSION_CHAIN_COPY.currentConsequence));
  return badge;
}

/** The "you are here" marker — a different fact from Current, on its own row. */
function renderHereMarker() {
  const marker = el('span', 'version-here', VERSION_CHAIN_COPY.youAreHere);
  marker.setAttribute('data-version-here', 'true');
  marker.appendChild(hidden(' ' + VERSION_CHAIN_COPY.youAreHereConsequence));
  return marker;
}

/**
 * One row of the chain.
 *
 * The name cell is a link for every member EXCEPT the one being viewed, which
 * has nowhere to navigate to. The link carries `data-asset-id`, matching the
 * delegated asset-link convention already used by the job detail view, and the
 * mount below is what binds it.
 */
function renderVersionRow(row, chain, opts) {
  const v = row.version;
  const badgeClass =
    typeof opts.badgeClass === 'function' ? opts.badgeClass : versionStatusBadgeClass;

  const tr = document.createElement('tr');
  tr.className = 'version-row';
  tr.setAttribute('data-version-id', v.id);
  tr.setAttribute('data-depth', String(row.depth));

  const isHere = v.id === chain.assetId;
  const isCurrent = v.id === chain.currentVersionId;
  if (isHere) tr.setAttribute('data-version-here', 'true');
  if (isCurrent) tr.setAttribute('data-version-current', 'true');
  if (v.status === 'archived') tr.classList.add('version-row--archived');

  // ── Version cell: indent + connector + markers + name ──
  const nameCell = document.createElement('td');
  nameCell.className = 'version-name-cell';

  const indent = el('span', 'version-indent');
  indent.setAttribute('aria-hidden', 'true');
  indent.style.paddingLeft = row.indent * 16 + 'px';
  if (row.depth > 0) {
    indent.appendChild(el('span', 'version-connector', row.lastSibling ? '└─' : '├─'));
  }
  nameCell.appendChild(indent);

  // The tree edge, stated in text so the structure is not indent-only
  // (WCAG 1.3.1: the relationship survives without the visual layout).
  if (row.source) {
    nameCell.appendChild(
      hidden(VERSION_CHAIN_COPY.sourceVersionPrefix + nameOf(row.source) + '. ')
    );
  }

  if (isHere) {
    nameCell.appendChild(el('span', 'version-name', nameOf(v)));
  } else {
    const link = el('a', 'version-link', nameOf(v));
    link.setAttribute('href', '#');
    link.setAttribute('data-asset-id', v.id);
    nameCell.appendChild(link);
  }

  if (isCurrent) nameCell.appendChild(renderCurrentBadge());
  if (isHere) nameCell.appendChild(renderHereMarker());
  tr.appendChild(nameCell);

  // ── Status ──
  const statusCell = document.createElement('td');
  const statusText = typeof v.status === 'string' && v.status !== ''
    ? v.status
    : VERSION_CHAIN_COPY.absent;
  statusCell.appendChild(el('span', 'badge ' + badgeClass(v.status), statusText));
  tr.appendChild(statusCell);

  // ── Created, ISO 8601 UTC ──
  tr.appendChild(el('td', 'version-created', isoUtc(v.createdAt)));

  // ── Asset id, monospace ──
  tr.appendChild(el('td', 'cell-id', v.id));

  return tr;
}

/** `name` is `required` on a chain member; the guard covers a stray server. */
function nameOf(version) {
  const v = version || {};
  if (typeof v.name === 'string' && v.name !== '') return v.name;
  return typeof v.id === 'string' && v.id !== '' ? v.id : VERSION_CHAIN_COPY.absent;
}

function renderChainTable(rows, chain, opts, caption) {
  const wrap = el('div', 'table-wrap');
  const table = document.createElement('table');
  table.className = 'version-chain-table';
  table.appendChild(el('caption', 'visually-hidden', caption));

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  [
    VERSION_CHAIN_COPY.colVersion,
    VERSION_CHAIN_COPY.colStatus,
    VERSION_CHAIN_COPY.colCreated,
    VERSION_CHAIN_COPY.colId,
  ].forEach(function (label) {
    const th = el('th', null, label);
    th.setAttribute('scope', 'col');
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach(function (row) {
    tbody.appendChild(renderVersionRow(row, chain, opts));
  });
  table.appendChild(tbody);

  wrap.appendChild(table);
  return wrap;
}

/**
 * Previous / Next, stepping through `versions` in the server's array order.
 *
 * Disabled at each end, and disabled outright when the viewed asset is not in
 * the page. Each button carries its target in `data-asset-id`, so it originates
 * navigation through exactly the same route as a row link.
 */
function renderStepControls(chain) {
  const step = versionStepTargets(chain);

  const group = el('div', 'version-steps');
  group.id = 'version-steps';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', VERSION_CHAIN_COPY.stepGroupLabel);

  const mk = function (label, targetId, which) {
    const btn = el('button', 'btn-ghost version-step', label);
    btn.type = 'button';
    btn.setAttribute('data-step', which);
    if (targetId) {
      btn.setAttribute('data-asset-id', targetId);
    } else {
      btn.disabled = true;
    }
    return btn;
  };

  group.appendChild(mk(VERSION_CHAIN_COPY.stepPrevious, step.previousId, 'previous'));

  if (step.index >= 0) {
    const pos = el(
      'span',
      'version-step-position',
      VERSION_CHAIN_COPY.stepPosition
        .replace('%POS%', String(step.index + 1))
        .replace('%TOTAL%', String(step.total))
    );
    group.appendChild(pos);
  }

  group.appendChild(mk(VERSION_CHAIN_COPY.stepNext, step.nextId, 'next'));
  return group;
}

// ─── Block ───────────────────────────────────────────────────────────────────

/**
 * Build the whole block for one read of the chain. PURE: no fetch, no
 * listeners — `mountVersionChain` wires the links and buttons it returns.
 *
 * @param {{assetId: string, versionGroupId: string|undefined,
 *          currentVersionId: string, versions: object[]}} chain
 * @param {{badgeClass?: (status: unknown) => string}} [opts]
 * @returns {{block: HTMLElement, links: HTMLElement[], steps: HTMLElement[]}}
 */
export function renderVersionChainBlock(chain, opts) {
  const o = opts || {};
  const c = normaliseVersionChain(chain);

  const block = el('div', 'mt12 version-chain-block');
  block.id = 'asset-versions';

  const headRow = el('div', 'version-chain-header');
  headRow.appendChild(el('div', 'section-title', VERSION_CHAIN_COPY.heading));
  // The group id, when there is one. Deliberately NOT filled with "none" for a
  // never-versioned asset: the slot stays empty, because the absence IS the
  // information and a placeholder would read as a value.
  if (c.versionGroupId) {
    const group = el('div', 'version-group-id');
    group.appendChild(el('span', 'version-group-key', VERSION_CHAIN_COPY.groupKey));
    group.appendChild(el('span', 'cell-id', c.versionGroupId));
    headRow.appendChild(group);
  }
  block.appendChild(headRow);

  // ── The "no other versions" state (single-member chain, no group) ──
  //
  // The section is RENDERED, never hidden: "this asset has no other versions"
  // is an answer, and an absent section is not.
  if (isSingleMemberChain(c)) {
    const empty = el('div', 'empty', VERSION_CHAIN_COPY.emptyHeadline);
    empty.setAttribute('data-empty', 'version-chain');
    empty.appendChild(el('div', 'version-note', VERSION_CHAIN_COPY.emptyDetail));
    block.appendChild(empty);
    return { block: block, links: [], steps: [] };
  }

  block.appendChild(el('div', 'version-note', VERSION_CHAIN_COPY.intro));

  if (isTruncatedChain(c)) {
    const notice = el('div', 'version-truncated', VERSION_CHAIN_COPY.truncated);
    notice.setAttribute('data-version-truncated', 'true');
    block.appendChild(notice);
  }

  const tree = buildVersionTree(c.versions);
  block.appendChild(renderChainTable(tree.rows, c, o, VERSION_CHAIN_COPY.tableCaption));

  // Members whose source version is outside the page. Grouped, never reparented.
  if (tree.orphans.length > 0) {
    const orphanBlock = el('div', 'version-orphans');
    orphanBlock.setAttribute('data-version-orphans', 'true');
    orphanBlock.appendChild(el('div', 'version-group-title', VERSION_CHAIN_COPY.orphanHeading));
    orphanBlock.appendChild(
      renderChainTable(tree.orphans, c, o, VERSION_CHAIN_COPY.orphanHeading)
    );
    orphanBlock.appendChild(el('div', 'version-note', VERSION_CHAIN_COPY.orphanNote));
    block.appendChild(orphanBlock);
  }

  // Current names the head of the lineage, not a playable asset. Say so when
  // the named member is not `ready` — and do NOT suppress the badge, which
  // would make the view disagree with the API.
  const currentMember = c.versions.filter(function (v) {
    return v.id === c.currentVersionId;
  })[0];
  if (currentMember && currentMember.status !== 'ready') {
    const note = el('div', 'version-note version-note--attention', VERSION_CHAIN_COPY.noReadyVersion);
    note.setAttribute('data-version-no-ready', 'true');
    block.appendChild(note);
  }

  block.appendChild(renderStepControls(c));

  return {
    block: block,
    links: Array.prototype.slice.call(block.querySelectorAll('.version-link')),
    steps: Array.prototype.slice.call(block.querySelectorAll('.version-step')),
  };
}

/** The inline failure state — a fact about the REQUEST, never about the asset. */
function renderErrorBlock(err) {
  const block = el('div', 'mt12 version-chain-block');
  block.id = 'asset-versions';
  block.appendChild(el('div', 'section-title', VERSION_CHAIN_COPY.heading));

  const msg = el('div', 'msg msg-error', versionChainErrorText(err));
  msg.id = 'version-chain-error';
  msg.setAttribute('role', 'status');
  block.appendChild(msg);

  const retry = el('button', 'btn-ghost', VERSION_CHAIN_COPY.retry);
  retry.type = 'button';
  retry.id = 'version-chain-retry';
  block.appendChild(retry);

  return { block: block, retry: retry };
}

function renderLoadingBlock() {
  const block = el('div', 'mt12 version-chain-block');
  block.id = 'asset-versions';
  block.appendChild(el('div', 'section-title', VERSION_CHAIN_COPY.heading));
  block.appendChild(el('div', 'version-note', VERSION_CHAIN_COPY.loading));
  return block;
}

/**
 * Move the reader to the row for the asset now being viewed, after a navigation
 * re-rendered the panel, so stepping through a chain does not reset the reader's
 * position in it. Best effort: `scrollIntoView` is absent in some test DOMs.
 *
 * @param {ParentNode} [root]
 */
export function focusYouAreHereRow(root) {
  const scope = root && typeof root.querySelector === 'function' ? root : undefined;
  if (!scope) return null;
  const row = scope.querySelector('.version-row[data-version-here="true"]');
  if (!row) return null;
  if (typeof row.scrollIntoView === 'function') {
    row.scrollIntoView({ block: 'nearest' });
  }
  return row;
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Fetch and render the "Versions" block into the asset detail view.
 *
 * ONE call: `GET /api/v1/assets/{id}/versions`, with the ULID (see CONTRACT
 * GROUNDING — this route does not resolve slugs). The detail view's own
 * `GET /assets/{id}` body cannot answer this: it carries the asset's own
 * `versionGroupId` but not the other members of the group.
 *
 * Navigation RE-FETCHES. The envelope is target-relative — `assetId` changes,
 * so "you are here" moves — and the caller's `onNavigate` re-renders the whole
 * detail view for the new id, which mounts this block again from a fresh read.
 * The previous response is never carried over.
 *
 * @param {object} opts
 * @param {string}      opts.assetId    the ULID (not the slug)
 * @param {Function}    opts.apiFetch   the app's fetch wrapper
 * @param {HTMLElement} [opts.host]     container to append to
 * @param {HTMLElement} [opts.anchorEl] element to insert before, inside its parent
 * @param {(status: unknown) => string} [opts.badgeClass] the app's status->class map
 * @param {(id: string) => any} [opts.onNavigate] open another version's detail
 * @returns {Promise<{block: HTMLElement, refresh: () => Promise<void>,
 *                    chain: () => object|null}>}
 */
export async function mountVersionChain(opts) {
  const o = opts || {};
  const apiFetch = o.apiFetch;
  const path = '/assets/' + encodeURIComponent(String(o.assetId)) + '/versions';

  let rendered = null;
  let placed = false;
  let chain = null;

  function place(next) {
    if (!placed) {
      if (o.anchorEl && o.anchorEl.parentNode) {
        o.anchorEl.parentNode.insertBefore(next, o.anchorEl);
      } else if (o.host) {
        o.host.appendChild(next);
      }
      placed = true;
      rendered = next;
      return;
    }
    if (rendered && rendered.parentNode) {
      rendered.parentNode.replaceChild(next, rendered);
    }
    rendered = next;
  }

  /**
   * Hand navigation to the caller, then put the reader on the row for the asset
   * that is now being viewed. The click is never allowed to reject into the
   * render path.
   */
  async function navigate(targetId) {
    if (!targetId || typeof o.onNavigate !== 'function') return;
    try {
      await o.onNavigate(targetId);
    } catch (_) {
      // The caller renders its own failure; nothing to add here.
      return;
    }
    const doc = rendered && rendered.ownerDocument ? rendered.ownerDocument : undefined;
    if (doc) focusYouAreHereRow(doc);
  }

  function wire(parts) {
    const bind = function (node) {
      node.addEventListener('click', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        navigate(node.getAttribute('data-asset-id'));
      });
    };
    parts.links.forEach(bind);
    parts.steps.forEach(function (btn) {
      if (!btn.disabled) bind(btn);
    });
  }

  function draw(next) {
    const parts = renderVersionChainBlock(next, { badgeClass: o.badgeClass });
    place(parts.block);
    chain = next;
    wire(parts);
  }

  async function refresh() {
    let payload;
    try {
      payload = await apiFetch(path);
    } catch (err) {
      chain = null;
      const failure = renderErrorBlock(err);
      place(failure.block);
      failure.retry.addEventListener('click', function () {
        place(renderLoadingBlock());
        refresh();
      });
      return;
    }
    draw(normaliseVersionChain(payload));
  }

  await refresh();

  return {
    get block() {
      return rendered;
    },
    refresh: refresh,
    chain: function () {
      return chain;
    },
  };
}
