/**
 * open-videocore ops dashboard — app.js
 *
 * Security note: All dynamic values from the API or user input are passed through
 * escHtml() before being interpolated into HTML template literals. escHtml() encodes
 * &, <, >, and " characters. No raw external strings are inserted into innerHTML.
 * DOM APIs (textContent, createElement) are used where possible; innerHTML is used
 * only with fully-escaped, controlled template strings.
 */

import { createJobsTable } from './jobs-table.js';
// Shared assets-table wiring (issue #369). Composes the merged shared table
// primitive (#367/#372) and URL-state contract (#368/#373) against the verified
// GET /api/v1/assets/ + GET /api/v1/search/ contracts. See public/assets-table.js.
import { createAssetsTable } from './assets-table.js';
// Shared logs-table wiring (issue #371). Composes the merged shared table
// primitive (#367/#372) in CURSOR paging mode and the URL-state contract
// (#368/#373) against the verified GET /api/v1/logs/ contract. See
// public/logs-table.js.
import { createLogsTable } from './logs-table.js';
// Shared audit-table wiring (issue #987). Composes the merged shared table
// primitive (#367/#372) in OFFSET paging mode and the URL-state contract
// (#368/#373) against the verified GET /api/v1/audit contract (src/routes/
// audit.ts:62-80). See public/audit-table.js.
import { createAuditTable } from './audit-table.js';
// Size-based upload routing (issue #747): stream small files through the proxy,
// but push medium/large files straight to MinIO via the presigned single-part
// and multipart routes so they never hit the proxy's request-body limit.
import { uploadAssetFile, describeUploadFailure } from './upload.js';
// Presigned thumbnail loading (issue #801). An <img> GET carries no
// Authorization header, so thumbnails are resolved to a short-lived signed URL
// over apiFetch first. Contract grounding lives in public/thumbnail-url.js.
import { applyThumbnail } from './thumbnail-url.js';
// Copyable identifier cells (issue #851). A column headed "ID" shows the ULID
// the API accepts as an asset id, as selectable text with a click-to-copy
// button; slugs are shown under their own "Slug" header. Contract grounding for
// which value each endpoint accepts lives in public/copy-id.js.
import { copyableIdCellHtml, slugCellHtml, wireCopyIdButtons } from './copy-id.js';
// Shared detail-panel primitives (issue #963): the collapsed "Raw" disclosure
// that holds the full server record, and the copyable field value built on the
// copy-id.js control. Factored out because the pipeline-execution detail view
// (issue #964) needs the same two affordances; contract grounding for the
// values passed in stays with each caller.
import {
  createRawDisclosure,
  rawDisclosureOpen,
  copyableFieldHtml,
  wireCopyableFields,
} from './detail-sections.js';
// Encode-attempt history (issue #963): the derivation + rendering of
// `encodeAttemptLog` / `encodeAttempts`, so a job rescued by a classified retry
// reads differently from a plain slow success. Full contract grounding for
// every field it touches is in that module's header.
import { renderAttemptHistory } from './job-attempts.js';
// Delete-lock detail surface (issue #895): the "Delete protection" block and the
// lock / unlock / edit-note actions on the asset detail view, implementing
// docs/ux/asset-lock-state-spec.md §4. State derivation and copy live in
// public/lock-state.js (#894) and public/lock-detail.js; the contract grounding
// for PUT/DELETE /assets/{id}/lock is in the latter's header.
import { mountDeleteProtection } from './lock-detail.js';

// Blocked-archive explanation (issue #896), implementing
// docs/ux/asset-lock-state-spec.md §5. Classifies the 409 from
// DELETE /api/v1/assets/{id} — whose body is an anyOf, so `error ===
// 'delete_blocked'` is checked before `reason`/`blockedBy` are read — and builds
// the blocked confirmModal variant. Full contract grounding, including why
// `?force=true` can never defeat a delete lock, is in that module's header.
import { classifyDeleteBlock, protectedBlock, showDeleteBlocked } from './delete-blocked.js';

// Editorial review-state block (issue #901, broken out of #792): the current
// review state rendered distinctly from the lifecycle `status` badge (#134), and
// a transition control built ONLY from the `allowedTransitions` the API
// advertises on GET /assets/{id}/review-state (#897) — so an illegal move has no
// control to originate from. The state machine is never re-derived client-side;
// full contract grounding is in that module's header.
import { mountReviewState } from './review-state.js';

// Asset rename affordance (issues #956, #927): a control for the `name` field
// that PATCH /api/v1/assets/{id} has always accepted but that nothing in this UI
// could trigger. UI only — no route or schema changes. Full contract grounding,
// including why a rename cannot move the asset's id, slug or stored object keys,
// is in that module's header.
//   mountAssetRename  — the detail view's action-row control (#956).
//   openRenameDialog  — the dialog behind it, called directly by the assets
//                       table's per-row Rename control (#927) so both surfaces
//                       share one interaction and one request shape.
import { mountAssetRename, openRenameDialog } from './asset-rename.js';

// Clip / trim affordance (issue #793): a control for POST
// /api/v1/assets/{id}/clip, which the API has served since issue #17 but which
// nothing in this UI could reach. UI only — no route or schema changes. Full
// contract grounding, including where the duration bound comes from and why a
// 502 is reported as an outright failure, is in that module's header.
import { mountAssetClip } from './asset-clip.js';

// Collection rename affordance (issue #928): the same control, for the `name`
// field that PATCH /api/v1/collections/{id} accepts since issue #926 but that
// nothing in this UI could trigger — a collection could only be named at
// creation. Both modules adapt ONE shared component (public/rename-dialog.js),
// so the two interactions cannot drift. UI only — no route or schema changes.
// Full contract grounding, including why membership (`assetIds`) can neither be
// sent nor affected, is in that module's header.
import { mountCollectionRename } from './collection-rename.js';

// Read-only tracks panel (issue #902, broken out of #794): one section per track
// kind — video, audio, subtitle — each listing only the attributes the API
// exposes for that kind, each with an explicit empty state. All of it comes from
// the GET /assets/{id} body this renderer already read: the editorial
// `audioTracks` / `subtitleTracks` arrays and the probe's `technicalMetadata`
// are all properties of that one response, so the panel issues no call of its
// own. Full contract grounding, including what the API does NOT expose, is in
// that module's header.
import { mountAssetTracks } from './tracks-panel.js';
import { AUDIO_EDIT_COPY } from './audio-track-edit.js';

// Comments panel (issue #900): the free-text notes on an asset, plus one control
// to add another. ADD + READ ONLY — the API exposes exactly `post` and `get` on
// /api/v1/assets/{id}/comments and no `…/comments/{commentId}` path at all, so
// an edit or delete control would have nothing to call. Full contract grounding,
// including the author field the API does not have, is in that module's header.
import { mountAssetComments } from './comments-panel.js';

// Version-chain navigation on asset detail (issue #907, broken out of #795):
// the whole lineage an asset belongs to, as the tree the API can describe, with
// the SERVER-COMPUTED current version badged, the asset being viewed marked
// separately, every other member navigable, and an explicit state for an asset
// with no other versions. One call — GET /assets/{id}/versions — which the
// detail view's own GET /assets/{id} body cannot answer: that body carries the
// asset's own `versionGroupId` but not the other members of the group. Full
// contract grounding, and what the API does NOT expose (no promote/set-current
// operation of any kind), is in that module's header; the interaction design it
// implements is docs/design/asset-version-chain.md.
import { mountVersionChain } from './version-chain.js';

// External identifiers panel (issue #908, broken out of #796): the
// `{ namespace, id }` correlations to upstream systems of record, which until now
// were reachable only by whatever integration wrote them. The sub-resource is the
// ONLY surface that exposes them — `assetSchema` declares no
// `externalIdentifiers` property, so the GET /assets/{id} body this renderer
// already holds cannot supply them.
//
// The panel offers exactly the affordances the verified contract can perform:
// `GET` + `POST` on /assets/{id}/external-ids and `DELETE` on
// /{namespace}/{externalId}. There is NO PUT and NO PATCH, so "edit" is POST +
// DELETE, two requests, and the form says so. Full contract grounding — including
// why POST appends rather than replaces, and why a 409 can only be handled
// reactively — is in that module's header.
import { mountAssetExternalIds } from './external-ids.js';

// Tags panel (issue #934, broken out of #792): the asset's tag list plus an add
// control and a per-tag remove control. Tags have been readable AND writable
// over the API since #11 (POST /assets/{id}/tags, DELETE /assets/{id}/tags/{tag})
// but nothing in this UI could write one. UI only — no route or schema changes.
// The panel mirrors the API's own validation bounds client-side and re-renders
// only from server answers; full contract grounding, including the verified
// "any characters allowed" rule and the list-cap asymmetry on the append route,
// is in that module's header.
import { mountAssetTags } from './asset-tags.js';

// Export action (issue #945, broken out of #796): pick one of the export
// destinations this deployment has registered (read live from
// GET /api/v1/export-destinations), trigger POST /assets/{id}/deliver, and read
// the outcome truthfully. Copy and visual treatment for the in-progress /
// exported / failed / not-available states come from
// docs/design/export-action-states.md (issue #911), plus the two states that
// spec deferred until a destination-carrying endpoint existed ("nothing
// registered" and "the list could not be read"). The module header carries the
// full contract grounding for both calls.
import { mountExportAction } from './export-action.js';

// ─── Escape helper (XSS prevention) ─────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Stack selector ──────────────────────────────────────────────────────────

const STACK_KEY = 'ovc_stack';

function getActiveStack() {
  return localStorage.getItem(STACK_KEY) || '';
}

function setActiveStack(name) {
  if (name) localStorage.setItem(STACK_KEY, name);
  else localStorage.removeItem(STACK_KEY);
}

// ─── Client role (ADR-018) ─────────────────────────────────────────────────
//
// Authorisation is driven server-side by the trusted `X-OVC-Role` header, read
// by src/auth/principal.ts (ROLE_HEADER = 'x-ovc-role', src/auth/principal.ts:36).
// There is NO whoami endpoint and no per-user identity (single-operator model,
// src/auth/principal.ts:11-16), so the ops UI cannot ask the server for its
// role — it mirrors the server's own semantics:
//   - the three roles are viewer | editor | admin (src/auth/principal.ts:31);
//   - an absent role resolves to admin (single-operator default,
//     src/auth/principal.ts:98-104).
// getClientRole() therefore reads an operator-chosen role from localStorage and
// defaults to 'admin' exactly as the server does; apiFetch() forwards it as the
// X-OVC-Role header so, when the deployment sets OVC_TRUST_ROLE_HEADER=true
// (src/main.ts:431), the same value gates the API. The issue's "operator/admin"
// binds to the real editor|admin contract: those two roles may manage storage.
const ROLE_KEY = 'ovc_role';
const CLIENT_ROLES = ['viewer', 'editor', 'admin'];

function getClientRole() {
  const stored = localStorage.getItem(ROLE_KEY);
  return CLIENT_ROLES.includes(stored) ? stored : 'admin';
}

function setClientRole(role) {
  if (CLIENT_ROLES.includes(role)) localStorage.setItem(ROLE_KEY, role);
  else localStorage.removeItem(ROLE_KEY);
}

// Whether the current client role may see + manage storage backends. Bound to
// the real matrix (src/auth/authorize.ts:54-58): editor and admin may write;
// viewer is read-only and does not get the management surface. This is the
// "operator/admin" gate from issue #680, expressed in the codebase's roles.
function canManageStorage() {
  const r = getClientRole();
  return r === 'editor' || r === 'admin';
}

// Whether the current client role may set or clear an asset's delete lock
// (issue #895). Bound to the SAME matrix, read before this was written:
// `MATRIX` (src/auth/authorize.ts:54-58) gives `write` and `delete` to `editor`
// and `admin` and neither to `viewer`; `methodToAction` (:79-93) maps
// PUT -> write and DELETE -> delete, and `resourceAuthorizationPreHandler('asset')`
// (:126, registered at src/routes/assets.ts:1718) applies it to both lock
// routes. So the two roles that may lock are exactly editor and admin. There is
// no scope/claim model and no capability endpoint in this API, so this is a
// client-side MIRROR of the server rule, not a substitute for it: the 403
// (`AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role'`, :99) is still
// handled when it arrives (docs/ux/asset-lock-state-spec.md §4.4).
function canChangeDeleteLock() {
  const r = getClientRole();
  return r === 'editor' || r === 'admin';
}

// Whether the current client role may apply an editorial review transition
// (issue #901). Same matrix, checked before this was written: `MATRIX`
// (src/auth/authorize.ts:54-58) gives `write` to `editor` and `admin` only, and
// `methodToAction` (:79-93) maps POST -> write, so POST /assets/{id}/review-state
// is refused to a `viewer` with 403 by
// `resourceAuthorizationPreHandler('asset')` (:126, registered
// src/routes/assets.ts:1718). GET on the same sub-resource is `read`, which a
// viewer DOES hold — hence a viewer still sees the state and its legal moves,
// read-only (docs/findings/review-state-contract-897.md §4). Client-side mirror
// only: the 403 is still handled if it arrives.
function canChangeReviewState() {
  const r = getClientRole();
  return r === 'editor' || r === 'admin';
}

// Whether the current client role may export an asset (issue #945). Same matrix,
// checked before this was written: `MATRIX` (src/auth/authorize.ts:54-58) gives
// `write` to `editor` and `admin` only, and `methodToAction` (:79-92) maps
// POST -> write, so POST /assets/{id}/deliver is refused to a `viewer` with 403
// by `resourceAuthorizationPreHandler('asset')` (:126, registered
// src/routes/assets.ts:1773). Client-side mirror only: the 403 is still handled
// if it arrives. A `viewer` may still READ the destinations list, which needs
// only `read`.
function canExportAsset() {
  const r = getClientRole();
  return r === 'editor' || r === 'admin';
}

// Whether the current client role may add or remove an asset's subtitle tracks
// (issue #940). Same matrix, read before this was written: `MATRIX`
// (src/auth/authorize.ts:54-58) gives `write` and `delete` to `editor` and
// `admin` and NEITHER to `viewer`, and `methodToAction` (:79-93) maps
// POST -> write and DELETE -> delete, so both
// POST /assets/{id}/subtitle-tracks and
// DELETE /assets/{id}/subtitle-tracks/{trackId} are refused to a `viewer` with
// 403 by `resourceAuthorizationPreHandler('asset')` (:126, registered
// src/routes/assets.ts:1773). A viewer keeps the read-only panel, which is `read`
// on GET /assets/{id} and permitted. Client-side mirror only: the 403 is still
// handled if it arrives.
function canChangeSubtitleTracks() {
  const r = getClientRole();
  return r === 'editor' || r === 'admin';
}

// Whether the current client role may rename an asset (issue #956). Same matrix,
// checked before this was written: `MATRIX` (src/auth/authorize.ts:54-58) gives
// `write` to `editor` and `admin` only, and `methodToAction` (:79-93) maps
// PATCH -> write, so PATCH /assets/{id} is refused to a `viewer` with 403 by
// `resourceAuthorizationPreHandler('asset')` (:126, registered
// src/routes/assets.ts:1718). Client-side mirror only: the 403 is still handled
// if it arrives.
function canRenameAsset() {
  const r = getClientRole();
  return r === 'editor' || r === 'admin';
}

// Whether the current client role may add or remove an asset's tags (issue
// #934). Same matrix, checked before this was written: `MATRIX`
// (src/auth/authorize.ts:54-58) gives `write` AND `delete` to `editor` and
// `admin` and neither to `viewer`; `methodToAction` (:79-93) maps POST -> write
// and DELETE -> delete, and `resourceAuthorizationPreHandler('asset')` (:126,
// registered src/routes/assets.ts:1773) applies both to the tag sub-resource —
// verified against the real router: a viewer gets 403 on POST /tags AND on
// DELETE /tags/{tag}. A viewer still READS the tags, which arrive on the asset
// body itself. Client-side mirror only: the 403 is still handled if it arrives.
function canChangeTags() {
  const r = getClientRole();
  return r === 'editor' || r === 'admin';
}

// Whether the current client role may rename a collection (issue #928). The SAME
// matrix and the same answer as canRenameAsset, which is the point: ADR-018
// decision 4 states there is no asset/collection distinction in the permission
// table, and the code agrees — `authorize()` takes `resourceType` but does not
// index `MATRIX` with it (src/auth/authorize.ts:64-73, "`asset` and `collection`
// are identical (no cascade, decision 4)"). `methodToAction` (:79-93) maps
// PATCH -> write, and `resourceAuthorizationPreHandler('collection')` is
// registered on the collections router (src/routes/collections.ts:267), so
// PATCH /collections/{id} is refused to a `viewer` with 403
// `forbidden_insufficient_role`. Kept as its own named function rather than
// re-using canRenameAsset so that if the server ever does distinguish the two
// resources, there is already a seam to change. Client-side mirror only: the 403
// is still handled if it arrives.
function canRenameCollection() {
  const r = getClientRole();
  return r === 'editor' || r === 'admin';
}

// Whether the current client role may add/edit/remove an asset's external
// identifiers (issue #908). Same matrix, checked before this was written: `MATRIX`
// (src/auth/authorize.ts:54-58) gives `write` AND `delete` to `editor` and `admin`
// only, and `methodToAction` (:79-93) maps POST -> write and DELETE -> delete, so
// BOTH mutating operations on this sub-resource — POST /assets/{id}/external-ids
// and DELETE /assets/{id}/external-ids/{namespace}/{externalId} — are refused to a
// `viewer` with 403 by `resourceAuthorizationPreHandler('asset')`
// (src/auth/authorize.ts:126, registered src/routes/assets.ts:1748). One predicate
// covers both because the matrix grants the two actions to exactly the same roles.
// GET on the same sub-resource is `read`, which a viewer DOES hold — hence a
// viewer still sees every namespace and value, read-only. Client-side mirror
// only: the 403 is still handled if it arrives.
function canChangeExternalIds() {
  const r = getClientRole();
  return r === 'editor' || r === 'admin';
}

// Whether the current client role may add or remove an asset's editorial audio
// tracks (issue #903). Same matrix, checked before this was written: `MATRIX`
// (src/auth/authorize.ts:54-58) gives `write` to `editor` and `admin` only and
// `delete` to the same two, and `methodToAction` (:79-93) maps POST -> write and
// DELETE -> delete. Both track routes sit under
// `resourceAuthorizationPreHandler('asset')`, registered plugin-scoped on EVERY
// asset route (src/routes/assets.ts:1748), so POST /assets/{id}/audio-tracks and
// DELETE /assets/{id}/audio-tracks/{trackId} are both refused to a `viewer` with
// 403 `forbidden_insufficient_role` (:99). A viewer still holds `read`, so the
// tracks panel itself stays fully visible — only the write controls go.
// Client-side mirror only: the 403 is still handled if it arrives.
function canEditAudioTracks() {
  const r = getClientRole();
  return r === 'editor' || r === 'admin';
}

// Whether the current client role may add a comment to an asset (issue #900).
// Same matrix, checked before this was written: `MATRIX`
// (src/auth/authorize.ts:54-58) gives `write` to `editor` and `admin` only, and
// `methodToAction` (:79-93) maps POST -> write, so POST /assets/{id}/comments is
// refused to a `viewer` with 403 by `resourceAuthorizationPreHandler('asset')`
// (:126, registered src/routes/assets.ts:1748). GET on the same sub-resource is
// `read`, which a viewer DOES hold — so a viewer still sees every comment,
// read-only. Client-side mirror only: the 403 is still handled if it arrives.
function canAddComment() {
  const r = getClientRole();
  return r === 'editor' || r === 'admin';
}

// Whether the current client role may clip an asset (issue #793). Same matrix,
// checked before this was written: `MATRIX` (src/auth/authorize.ts:54-58) gives
// `write` to `editor` and `admin` only, and `methodToAction` (:79-93) maps
// POST -> write, so POST /assets/{id}/clip is refused to a `viewer` with 403 by
// `resourceAuthorizationPreHandler('asset')` (:126, registered
// src/routes/assets.ts:1718). Client-side mirror only: the 403 is still handled
// if it arrives.
function canClipAsset() {
  const r = getClientRole();
  return r === 'editor' || r === 'admin';
}

// Window-scoped stack override for detached windows (e.g. detail.html). Unlike
// setActiveStack, this does NOT touch the shared localStorage key, so popping
// out a detail for a different stack cannot switch the opener window's active
// stack. Because each window imports app.js in its own module realm, this
// variable is naturally isolated per window.
let stackOverride = null;

function setStackOverride(name) {
  stackOverride = name || null;
}

async function initStackSelector() {
  const sel = document.getElementById('stack-select');
  if (!sel) return;
  try {
    const names = await apiFetch('/provision');
    sel.innerHTML = '';
    if (!names || !names.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '— no stacks —';
      sel.appendChild(opt);
      return;
    }
    const stored = getActiveStack();
    const validStored = names.includes(stored) ? stored : '';
    if (!validStored) setActiveStack(names[0]);
    names.forEach(function(name) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === (validStored || names[0])) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function() {
      setActiveStack(sel.value);
      // Reload current tab with new stack
      const active = document.querySelector('.tab-btn.active');
      if (active) active.click();
    });
  } catch (_) {
    sel.innerHTML = '<option value="">— unavailable —</option>';
  }
}

// ─── Shared polling interval ──────────────────────────────────────────────────
// Single source of truth for the main-UI auto-refresh cadence. Reused by the
// jobs-table poll and by the standalone detached detail windows (detail.js).
const DETAIL_POLL_INTERVAL_MS = 5000;

// ─── UI-scoped access token (issue #740) ─────────────────────────────────────
//
// Every workspace-scoped router now attaches the 401 presence gate as its first
// preHandler (authGate, src/auth/middleware.ts:76 → app.authenticate →
// requireAuth, src/auth/workspace.ts:52), so a request without an
// `Authorization: Bearer` header is rejected 401 "missing access token"
// (src/auth/workspace.ts:54). The OSC auth wall authenticates the operator's
// browser session before /ui loads, but it does NOT inject that bearer header
// onto the page's own fetch()/XHR calls, so every gated call from the UI failed.
//
// requireAuth is a PURE PRESENCE gate: it admits ANY non-empty bearer string and
// never inspects it for identity (src/auth/workspace.ts:22-32) — the sole inbound
// security boundary is the OSC auth wall the request has already crossed. So the
// UI only has to present a non-empty, UI-scoped token to satisfy the gate, and it
// must NOT be handed the real OSC access token (that would leak a wall-crossing
// credential into the browser). We mint an opaque, per-page token and hold it
// ONLY in memory for the lifetime of the page — never localStorage/sessionStorage,
// per CLAUDE.md's never-persist-tokens rule (mirrors the storage-secret handling
// at app.js:3178-3181). An anonymous request from OUTSIDE the UI still carries no
// token and still gets 401, so this does not weaken the gate (#711 intact).
const UI_ACCESS_TOKEN = (function mintUiAccessToken() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return 'ui-' + crypto.randomUUID();
    }
  } catch (_) { /* fall through to a non-crypto fallback */ }
  return 'ui-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
})();

// The Authorization header the UI presents on gated requests. Held only in the
// module realm for the page's lifetime; never persisted.
function uiAuthHeader() {
  return { 'Authorization': 'Bearer ' + UI_ACCESS_TOKEN };
}

// ─── API fetch helper ────────────────────────────────────────────────────────

const API_BASE = window.location.origin + '/api/v1';

// `options.raw` (issue #801): resolve with the Response itself instead of a
// parsed JSON body, for routes that serve bytes rather than JSON — e.g.
// GET /api/v1/assets/:id/thumbnails/:index, which streams image/jpeg
// (src/routes/assets.ts:4391-4405). Non-ok handling is unchanged, so a caller
// still sees the same thrown Error for 404/501. `raw` is stripped before the
// options reach fetch(); it is not a fetch init field.
async function apiFetch(path, { raw = false, ...options } = {}) {
  const stack = stackOverride || getActiveStack();
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(stack ? { 'X-Stack-Name': stack } : {}),
    // Satisfy the 401 presence gate on every gated router (issue #740). See the
    // UI-scoped access token note above.
    ...uiAuthHeader(),
    // Mirror the server's trusted role header (src/auth/principal.ts:36). Only
    // honoured server-side when OVC_TRUST_ROLE_HEADER=true (src/main.ts:431);
    // otherwise it is stripped and ignored, so sending it is always safe.
    'X-OVC-Role': getClientRole(),
    ...(options.headers || {}),
  };
  const res = await fetch(API_BASE + path, { ...options, headers });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    let body;
    try {
      body = await res.json();
      // Prefer the human-readable `message` when present (e.g. the 409
      // backend_in_use body defines both a machine `error` code and a
      // human `message` — storage.ts:274-283 on issue-679); fall back to
      // the machine code, then the status line.
      msg = body.message || body.error || msg;
    } catch (_) { /* ignore */ }
    const err = new Error(msg);
    err.status = res.status;
    // Expose the parsed error body so callers can read machine fields
    // (e.g. the 409 `references` counts) without re-reading the response.
    err.body = body;
    throw err;
  }
  if (raw) return res;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return res.json();
  }
  return null;
}

// Abort an in-progress multipart upload and clean up its server-side state
// (issue #748). On a failed or cancelled multipart upload the client MUST hit
// the documented abort route so the staged parts are reclaimed AND the asset is
// not left stranded in `uploading`. Contract: DELETE
// /assets/:id/multipart/:uploadId -> 204 (src/routes/asset-upload.ts:328, params
// { id, uploadId } at asset-upload.ts:76); the server also transitions the asset
// out of `uploading` (asset-upload.ts abort handler). Best-effort: swallows its
// own errors so cleanup never masks the original upload failure being reported.
async function abortMultipartUpload(assetId, uploadId) {
  if (!assetId || !uploadId) return;
  try {
    await apiFetch(
      '/assets/' + encodeURIComponent(assetId) + '/multipart/' + encodeURIComponent(uploadId),
      { method: 'DELETE' }
    );
  } catch (_) {
    /* best-effort cleanup — do not mask the original upload failure */
  }
}

// ─── Utility helpers ─────────────────────────────────────────────────────────

function fmtDate(val) {
  if (!val) return '—';
  try {
    return new Date(val).toLocaleString();
  } catch (_) {
    return String(val);
  }
}

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  n = Number(n);
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return (i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

function badgeClass(status) {
  if (!status) return 'badge-unknown';
  const s = status.toLowerCase();
  if (['ready', 'active', 'done', 'completed'].includes(s)) return 'badge-ready';
  if (['pending', 'queued', 'ingesting', 'transcoding', 'processing', 'running'].includes(s)) return 'badge-pending';
  if (['failed', 'error', 'archived'].includes(s)) return 'badge-failed';
  return 'badge-unknown';
}

function renderBadge(status) {
  // status is escaped before insertion
  return '<span class="badge ' + badgeClass(status) + '">' + escHtml(status || 'unknown') + '</span>';
}

// ─── Storage-backend status badge (issue #680) ───────────────────────────────
//
// The GET /api/v1/storage/backends view (src/routes/storage.ts:144-166, mirrored
// in openapi.json at "/api/v1/storage/backends".get.responses.200) carries NO
// persisted connection-status field today: the redacted backendViewSchema has
// id/name/role/backend/bucket/accessKeyId/endpointUrl/region/publicBaseUrl/
// hasSessionToken/deletable/createdAt/credentials and nothing else. Per the
// acceptance criterion, when no explicit status is stored the badge shows
// "Unknown". We therefore read an OPTIONAL, forward-compatible
// `connectionStatus` off the backend (a later API revision may populate it) and
// map it to one of the three issue states; anything unrecognised or absent is
// Unknown. Returns { label, cls } — both fed through escHtml at render time.
function storageBackendStatus(backend) {
  const raw = backend && typeof backend.connectionStatus === 'string'
    ? backend.connectionStatus.toLowerCase()
    : '';
  if (raw === 'connected') return { label: 'Connected', cls: 'badge-ready' };
  if (raw === 'unreachable') return { label: 'Unreachable', cls: 'badge-failed' };
  return { label: 'Unknown', cls: 'badge-unknown' };
}

// The OSC-managed default backend (ADR-017 D3) is the one that is not deletable
// (src/routes/storage.ts:140-142 / registry marks id 'default' deletable:false).
// It must be visually distinguished and must not expose edit/delete controls.
function isDefaultStorageBackend(backend) {
  return !(backend && backend.deletable === true);
}

// Pure render of the storage-backend list view (issue #680). Framework-free and
// contract-only: it takes the already-fetched array of redacted backend views
// and returns a detached DOM element, so it is directly unit-testable without a
// network call. Every dynamic value is written via textContent / escHtml — no
// raw external string reaches innerHTML, and the secret (always
// '***redacted***' in credentials.secretAccessKey) is never rendered.
function renderStorageBackendsList(backends) {
  const wrap = document.createElement('div');
  wrap.className = 'storage-backends-wrap';

  const list = Array.isArray(backends) ? backends : [];
  if (list.length === 0) {
    // Defensive: the API always returns at least the default backend
    // (src/routes/storage.ts:257-273), so an empty array means the registry is
    // unconfigured/unreachable rather than "no backends".
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No storage backends available.';
    wrap.appendChild(empty);
    return wrap;
  }

  const table = document.createElement('table');
  table.className = 'storage-backends-table';
  table.innerHTML =
    '<thead><tr>' +
    '<th>Name</th><th>Endpoint</th><th>Bucket</th><th>Region</th>' +
    '<th>Status</th><th>Actions</th>' +
    '</tr></thead>';
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  list.forEach(function(b) {
    const isDefault = isDefaultStorageBackend(b);
    const status = storageBackendStatus(b);
    const tr = document.createElement('tr');
    tr.className = 'storage-backend-row';
    if (isDefault) tr.classList.add('is-default');
    if (b && b.id != null) tr.dataset.backendId = String(b.id);

    // Name cell, with a "Default" label for the platform-provisioned backend.
    const nameTd = document.createElement('td');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'storage-backend-name';
    nameSpan.textContent = (b && b.name) ? String(b.name) : '—';
    nameTd.appendChild(nameSpan);
    if (isDefault) {
      const tag = document.createElement('span');
      tag.className = 'badge badge-attention storage-default-tag';
      tag.textContent = 'Default';
      nameTd.appendChild(document.createTextNode(' '));
      nameTd.appendChild(tag);
    }
    tr.appendChild(nameTd);

    const endpointTd = document.createElement('td');
    endpointTd.className = 'mono';
    endpointTd.textContent = (b && b.endpointUrl) ? String(b.endpointUrl) : '—';
    tr.appendChild(endpointTd);

    const bucketTd = document.createElement('td');
    bucketTd.className = 'mono';
    bucketTd.textContent = (b && b.bucket) ? String(b.bucket) : '—';
    tr.appendChild(bucketTd);

    const regionTd = document.createElement('td');
    regionTd.textContent = (b && b.region) ? String(b.region) : '—';
    tr.appendChild(regionTd);

    const statusTd = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'badge ' + status.cls + ' storage-backend-status';
    badge.textContent = status.label;
    statusTd.appendChild(badge);
    tr.appendChild(statusTd);

    // Actions: edit/delete are ABSENT/disabled for the default backend
    // (issue #680). We disable rather than omit so the row stays aligned and the
    // reason is announced to assistive tech.
    const actionsTd = document.createElement('td');
    actionsTd.className = 'storage-backend-actions';

    // Test connection (issue #683): available for EVERY row, including the
    // OSC-managed default (the server answers the default `connected` without a
    // probe, storage-backend-registry.ts:820-826). The whole Storage tab is
    // already gated on canManageStorage (issue #680 ROLE_GATED_TABS), so the
    // presence of this control matches the surrounding management controls'
    // role gate without a second check here. Wiring is attached in loadBackends.
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'btn-sm storage-backend-test-conn';
    test.textContent = 'Test connection';
    actionsTd.appendChild(test);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn-sm storage-backend-delete';
    del.textContent = 'Delete';
    if (isDefault) {
      del.disabled = true;
      del.title = 'The platform-provisioned default backend cannot be deleted.';
      del.setAttribute('aria-disabled', 'true');
    }
    actionsTd.appendChild(del);
    tr.appendChild(actionsTd);

    tbody.appendChild(tr);
  });

  wrap.appendChild(table);
  return wrap;
}

// ─── Add / edit storage-backend form (issue #681) ────────────────────────────
//
// Contract (per CLAUDE.md rule 7), verified against the authoritative endpoints
// added on branch issue-679/storage-backend-api-endpoints:
//   - POST   /api/v1/storage/backends            create (registerBackendSchema)
//       src/routes/storage.ts:128-140 (issue-679) — required: name, bucket,
//       accessKeyId, secretAccessKey; optional: region, endpointUrl.
//   - PATCH  /api/v1/storage/backends/{id}        update (updateBackendSchema)
//       src/routes/storage.ts:178-201 (issue-679) — every field optional; a
//       credential rotation MUST send accessKeyId + secretAccessKey together.
//   - POST   /api/v1/storage/backends/{id}/test-connection
//       src/routes/storage.ts:206-213 (issue-679) — body { secretAccessKey },
//       response { status: 'connected' | 'unreachable', message }.
//   - Secrets return masked as '***redacted***' (backendViewSchema, storage.ts
//       :148-166 issue-679); we NEVER echo returned key material into the field.
//
// The issue lists these six fields: name, endpoint URL, bucket name, region,
// access key ID, secret access key. `region` is `.optional()` in the create
// schema; the issue copy says "all fields required on add", so we require it in
// the UI (a stricter-than-API client constraint is safe — the API still accepts
// it). Everything is framework-free so the field/validation logic is directly
// unit-testable.
const STORAGE_SECRET_PLACEHOLDER = '••••••••  (unchanged)';

// The six form fields in render order. `secret:true` marks the password input
// whose value, on edit, is a masked placeholder the operator may leave untouched
// to keep the stored credential. `type` drives the <input type>.
const STORAGE_BACKEND_FORM_FIELDS = [
  { key: 'name', label: 'Name', type: 'text', placeholder: 'e.g. Cold archive' },
  { key: 'endpointUrl', label: 'Endpoint URL', type: 'url', placeholder: 'https://s3.example.com' },
  { key: 'bucket', label: 'Bucket name', type: 'text', placeholder: 'my-bucket' },
  { key: 'region', label: 'Region', type: 'text', placeholder: 'us-east-1' },
  { key: 'accessKeyId', label: 'Access key ID', type: 'text', placeholder: 'AKIA…' },
  { key: 'secretAccessKey', label: 'Secret access key', type: 'password', secret: true, placeholder: '' },
];

// Pure, network-free validation of the raw field values (issue #681). `mode` is
// 'add' | 'edit'. Returns { valid, errors, patch/body }. Error messages are
// actionable per the acceptance criteria. On 'edit' an untouched secret (empty
// string) is omitted so the backend receives no secret update; a typed secret is
// treated as a credential rotation and paired with accessKeyId (the API refuses
// one without the other — updateBackendSchema.refine, storage.ts:190-201).
function validateStorageBackendForm(mode, values) {
  const v = {};
  for (const f of STORAGE_BACKEND_FORM_FIELDS) {
    v[f.key] = typeof values[f.key] === 'string' ? values[f.key].trim() : '';
  }
  const errors = {};
  const isAdd = mode === 'add';

  // Non-secret required fields — required on add; on edit each may be left as
  // its pre-populated value (never blank, since the form is pre-filled) but we
  // still reject a field the operator has cleared to empty.
  for (const key of ['name', 'endpointUrl', 'bucket', 'region', 'accessKeyId']) {
    if (!v[key]) {
      const label = STORAGE_BACKEND_FORM_FIELDS.find((f) => f.key === key).label;
      errors[key] = label + ' is required.';
    }
  }

  // URL format — must be an absolute http/https URL (the API's endpointUrl is
  // z.string().url(), storage.ts:138; we give a friendlier, protocol-specific
  // message than the server's generic 422).
  if (v.endpointUrl && !/^https?:\/\/.+/i.test(v.endpointUrl)) {
    errors.endpointUrl = 'Endpoint URL must start with http:// or https://';
  } else if (v.endpointUrl && !errors.endpointUrl) {
    try {
      // eslint-disable-next-line no-new
      new URL(v.endpointUrl);
    } catch (_) {
      errors.endpointUrl = 'Endpoint URL is not a valid URL.';
    }
  }

  // Secret. On add it is required. On edit an empty value means "leave the
  // stored credential unchanged" (issue #681) — no secret is sent.
  const secretTyped = v.secretAccessKey.length > 0;
  if (isAdd && !secretTyped) {
    errors.secretAccessKey = 'Secret access key is required.';
  }

  const valid = Object.keys(errors).length === 0;
  if (!valid) return { valid: false, errors: errors };

  if (isAdd) {
    return {
      valid: true,
      errors: {},
      body: {
        name: v.name,
        endpointUrl: v.endpointUrl,
        bucket: v.bucket,
        region: v.region,
        accessKeyId: v.accessKeyId,
        secretAccessKey: v.secretAccessKey,
      },
    };
  }

  // Edit: build a PATCH body of the non-secret fields, and only include the
  // credential pair when the operator actually typed a new secret.
  const body = {
    name: v.name,
    endpointUrl: v.endpointUrl,
    bucket: v.bucket,
    region: v.region,
  };
  if (secretTyped) {
    body.accessKeyId = v.accessKeyId;
    body.secretAccessKey = v.secretAccessKey;
  }
  return { valid: true, errors: {}, body: body };
}

// Pure render of the add/edit form (issue #681). Framework-free and network-free
// so it is directly unit-testable. `mode` is 'add' | 'edit'; `backend` is the
// redacted view (edit only) used to pre-populate non-secret fields. The secret
// field is NEVER populated with returned key material: on edit it shows a masked
// placeholder (the operator leaves it blank to keep the stored credential).
// Returns the detached <form> element; wiring (submit, test-connection, cancel)
// is attached by the caller.
function renderStorageBackendForm(mode, backend) {
  const isEdit = mode === 'edit';
  const b = backend || {};
  const form = document.createElement('form');
  form.className = 'storage-backend-form';
  form.setAttribute('novalidate', 'novalidate');
  form.dataset.mode = mode;
  if (isEdit && b.id != null) form.dataset.backendId = String(b.id);

  const heading = document.createElement('div');
  heading.className = 'section-title';
  heading.textContent = isEdit ? 'Edit storage backend' : 'Add storage backend';
  form.appendChild(heading);

  STORAGE_BACKEND_FORM_FIELDS.forEach(function(f) {
    const fieldWrap = document.createElement('div');
    fieldWrap.className = 'form-field storage-backend-field';

    const inputId = 'sbf-' + f.key;
    const label = document.createElement('label');
    label.setAttribute('for', inputId);
    label.textContent = f.label;
    fieldWrap.appendChild(label);

    const input = document.createElement('input');
    input.type = f.type;
    input.id = inputId;
    input.name = f.key;
    input.className = 'storage-backend-input';
    input.dataset.field = f.key;
    // Required for keyboard/AT semantics; JS validation still runs (novalidate
    // on the form suppresses the browser's own bubble so our inline messages win).
    input.required = !isEdit || !f.secret;

    if (f.secret) {
      // NEVER seed the secret input with the redacted marker or any returned key
      // material. On edit, show a masked placeholder the operator can ignore.
      input.value = '';
      input.autocomplete = 'new-password';
      input.placeholder = isEdit ? STORAGE_SECRET_PLACEHOLDER : (f.placeholder || '');
      if (isEdit) {
        input.setAttribute('aria-describedby', inputId + '-hint');
      }
    } else {
      // Pre-populate non-secret fields on edit from the redacted view.
      input.value = isEdit && b[f.key] != null ? String(b[f.key]) : '';
      input.placeholder = f.placeholder || '';
    }
    fieldWrap.appendChild(input);

    if (f.secret && isEdit) {
      const hint = document.createElement('div');
      hint.id = inputId + '-hint';
      hint.className = 'form-hint';
      hint.textContent = 'Leave blank to keep the current secret. Type a new value to rotate it.';
      fieldWrap.appendChild(hint);
    }

    const errEl = document.createElement('div');
    errEl.className = 'form-error';
    errEl.dataset.errorFor = f.key;
    errEl.setAttribute('role', 'alert');
    fieldWrap.appendChild(errEl);

    form.appendChild(fieldWrap);
  });

  // Actions row: Save, Test connection, Cancel + inline result/status areas.
  const actions = document.createElement('div');
  actions.className = 'form-row storage-backend-form-actions';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'storage-backend-submit';
  submitBtn.textContent = isEdit ? 'Save changes' : 'Add backend';
  actions.appendChild(submitBtn);

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'btn-sm storage-backend-test';
  testBtn.textContent = 'Test connection';
  actions.appendChild(testBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn-sm storage-backend-cancel';
  cancelBtn.textContent = 'Cancel';
  actions.appendChild(cancelBtn);

  form.appendChild(actions);

  const testResult = document.createElement('div');
  testResult.className = 'storage-backend-test-result';
  testResult.dataset.testResult = '1';
  testResult.setAttribute('role', 'status');
  testResult.setAttribute('aria-live', 'polite');
  form.appendChild(testResult);

  const formMsg = document.createElement('div');
  formMsg.className = 'storage-backend-form-msg';
  formMsg.dataset.formMsg = '1';
  form.appendChild(formMsg);

  return form;
}

// Apply the { errors } map from validateStorageBackendForm to a rendered form:
// clears any previous errors, writes each message into its field's error slot,
// and toggles an `has-error` class for styling. Returns the first field key with
// an error (for focus management) or null.
function applyStorageBackendFormErrors(form, errors) {
  let first = null;
  form.querySelectorAll('.form-error[data-error-for]').forEach(function(el) {
    const key = el.dataset.errorFor;
    const field = el.closest('.storage-backend-field');
    if (errors && errors[key]) {
      el.textContent = errors[key];
      if (field) field.classList.add('has-error');
      if (first === null) first = key;
    } else {
      el.textContent = '';
      if (field) field.classList.remove('has-error');
    }
  });
  return first;
}

// ─── Wedged-asset detection (issue #282) ─────────────────────────────────────
// An asset is "wedged" when it is stuck in `processing` yet carries a non-empty
// `technicalMetadataError`: technical-metadata extraction failed, so the asset
// never advanced `processing -> ready` and is not usable. Both the `status`
// enum value (`processing`) and the error field name (`technicalMetadataError`)
// are verified against the asset contract:
//   - ASSET_STATUSES  src/data/asset-repo.ts:28  ('processing' member)
//   - assetSchema.technicalMetadataError  src/routes/assets.ts:439 (z.string().optional())
// The re-drive endpoint POST /api/v1/assets/:id/extract-metadata recovers such
// an asset synchronously and returns 200 { assetId, status } (issue #281,
// src/routes/assets.ts:1859-1906).
function isAssetWedged(asset) {
  return !!(asset
    && asset.status === 'processing'
    && typeof asset.technicalMetadataError === 'string'
    && asset.technicalMetadataError.length > 0);
}

// Client-side filter helper: narrow a list of assets to only the wedged ones.
// Kept pure (no DOM, no fetch) so it is directly unit-testable and reused by the
// list renderer's "wedged only" toggle.
function filterWedgedAssets(assets) {
  return (Array.isArray(assets) ? assets : []).filter(isAssetWedged);
}

function renderTags(tags) {
  if (!tags || tags.length === 0) return '<span class="text-muted">—</span>';
  // each tag is escaped individually
  return tags.map(function(t) { return '<span class="tag">' + escHtml(t) + '</span>'; }).join(' ');
}

// Fetch and render an asset's PipelineExecution list into `container`. Each
// execution is a small table: pipeline name + status badge, then one row per
// step with its status badge. All server text inserted via escHtml.
async function renderExecutions(assetId, container) {
  container.innerHTML = '';
  var title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = 'Executions';
  container.appendChild(title);

  var executions;
  try {
    executions = await apiFetch('/assets/' + encodeURIComponent(assetId) + '/executions');
  } catch (err) {
    var e = document.createElement('div');
    e.className = 'text-muted';
    e.textContent = 'Could not load executions: ' + err.message;
    container.appendChild(e);
    return;
  }
  if (!executions || executions.length === 0) {
    var none = document.createElement('div');
    none.className = 'text-muted';
    none.textContent = 'No pipeline executions yet.';
    container.appendChild(none);
    return;
  }

  var execBadge = function(status) {
    var color = { running: 'var(--accent,#60a5fa)', pending: 'var(--text-muted,#9ca3af)', done: 'var(--success,#4ade80)', failed: 'var(--error,#f87171)' }[status] || '';
    return '<span style="color:' + color + '">' + escHtml(status) + '</span>';
  };

  executions.forEach(function(exec) {
    var wrap = document.createElement('div');
    wrap.className = 'mt8';
    var rows = exec.steps.map(function(s) {
      var extra = s.error ? ' — ' + escHtml(s.error) : '';
      return '<tr><td>' + escHtml(s.name) + '</td><td>' + execBadge(s.status) + extra + '</td></tr>';
    }).join('');
    wrap.innerHTML =
      '<table class="mini-table"><thead><tr><th colspan="2">' +
      escHtml(exec.pipelineName) + ' — ' + execBadge(exec.status) +
      '</th></tr></thead><tbody>' + rows + '</tbody></table>';
    container.appendChild(wrap);
  });
}

// ─── Pipeline visualization framework ─────────────────────────────────────────
// Reusable: renders a horizontal row of status nodes connected by arrows.
// Each stage: { label: string, status: 'pending'|'running'|'completed'|'failed'|'warning', detail?: string }
// Returns a DOM element. All server-derived text is inserted via textContent.
function renderPipeline(stages) {
  const PIPELINE_STATUSES = ['pending', 'running', 'completed', 'failed', 'warning'];
  const STATUS_LABEL = {
    pending: 'Pending',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    warning: 'Warning'
  };

  const wrap = document.createElement('div');
  wrap.className = 'pipeline';
  wrap.setAttribute('role', 'list');
  wrap.setAttribute('aria-label', 'Pipeline stages');

  (stages || []).forEach(function(stage, i) {
    const status = PIPELINE_STATUSES.indexOf(stage && stage.status) !== -1 ? stage.status : 'pending';

    const node = document.createElement('div');
    node.className = 'pipeline-node pipeline-node--' + status;
    node.setAttribute('role', 'listitem');

    const label = document.createElement('div');
    label.className = 'pipeline-node-label';
    label.textContent = stage && stage.label != null ? String(stage.label) : '';
    node.appendChild(label);

    const badge = document.createElement('span');
    badge.className = 'pipeline-badge pipeline-badge--' + status;
    badge.textContent = STATUS_LABEL[status];
    if (status === 'running') {
      badge.setAttribute('aria-live', 'polite');
    }
    node.appendChild(badge);

    if (stage && stage.detail != null && stage.detail !== '') {
      const detail = document.createElement('div');
      detail.className = 'pipeline-node-detail';
      detail.textContent = String(stage.detail);
      node.appendChild(detail);
    }

    wrap.appendChild(node);

    if (i < (stages || []).length - 1) {
      const arrow = document.createElement('div');
      arrow.className = 'pipeline-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '→'; // →
      wrap.appendChild(arrow);
    }
  });

  return wrap;
}

// Derive the transcode pipeline stages from a job + (optional) source asset.
// Contract sources:
//   src/data/job-repo.ts   — JobStatus = 'pending'|'queued'|'running'|'done'|'failed'; JobType includes 'transcode'
//   src/data/asset-repo.ts — AssetStatus = 'uploading'|'processing'|'ready'|'failed'|'archived'; Asset.renditions?: Rendition[]
function buildTranscodePipeline(job, asset) {
  const jobStatus = job && job.status;
  const hasRenditions = !!(asset && Array.isArray(asset.renditions) && asset.renditions.length);
  const assetReady = !!(asset && asset.status === 'ready');

  // Upload — the asset exists if the job exists.
  const upload = { label: 'Upload', status: 'completed' };

  // Transcode (Encore)
  let transcode;
  if (jobStatus === 'queued') {
    // Job is waiting in the Encore auto-scaler's local queue, not yet dispatched
    // to an Encore instance (ADR-006). Show it as an active (amber) stage.
    transcode = {
      label: 'Transcode (Encore)',
      status: 'running',
      detail: 'Queued'
    };
  } else if (jobStatus === 'running') {
    transcode = {
      label: 'Transcode (Encore)',
      status: 'running',
      detail: (job && job.progress != null) ? job.progress + '%' : undefined
    };
  } else if (jobStatus === 'done') {
    transcode = { label: 'Transcode (Encore)', status: 'completed' };
  } else if (jobStatus === 'failed') {
    transcode = { label: 'Transcode (Encore)', status: 'failed' };
  } else {
    transcode = { label: 'Transcode (Encore)', status: 'pending' };
  }

  const transcodeDone = jobStatus === 'done';

  // Package
  let pkg;
  if (hasRenditions) {
    pkg = { label: 'Package', status: 'completed' };
  } else if (transcodeDone && asset && asset.status === 'processing') {
    pkg = { label: 'Package', status: 'running' };
  } else if (jobStatus === 'failed') {
    pkg = { label: 'Package', status: 'pending' };
  } else {
    pkg = { label: 'Package', status: 'pending' };
  }

  // Ready
  const ready = {
    label: 'Ready',
    status: (assetReady && hasRenditions) ? 'completed' : 'pending'
  };

  return [upload, transcode, pkg, ready];
}

function showMsg(container, text, type) {
  type = type || 'info';
  const el = document.createElement('div');
  el.className = 'msg msg-' + type;
  el.textContent = text;
  container.appendChild(el);
  setTimeout(function() { el.remove(); }, 6000);
}

// ─── Modal dialog helper ───────────────────────────────────────────────────────
// Opens a centered modal with a backdrop. `title` is a plain string (set via
// textContent). `buildBody(bodyEl, close)` populates the body. Returns a close fn.
//
// `opts.onClose` (optional, issue #919) fires exactly once when the dialog is
// removed, whichever route removed it — the × button, Escape, a backdrop click,
// or the caller invoking the returned/handed-in `close()`. confirmModal() needs
// this to resolve `false` on a dismissal it did not initiate; without it the
// three built-in dismissal routes are invisible to the caller.
function openModal(title, buildBody, opts) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const header = document.createElement('div');
  header.className = 'modal-header';
  const h = document.createElement('h3');
  h.textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close-btn';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';
  header.appendChild(h);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'modal-body';

  dialog.appendChild(header);
  dialog.appendChild(body);
  backdrop.appendChild(dialog);

  let closed = false;
  function close() {
    // Idempotent: a caller that calls close() after Escape already fired must
    // not double-invoke onClose.
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (opts && typeof opts.onClose === 'function') opts.onClose();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', function(e) {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);

  buildBody(body, close);
  document.body.appendChild(backdrop);
  return close;
}

// ─── Destructive-action confirmation dialog (issue #919) ───────────────────────
//
// The single confirmation primitive for every destructive operator-facing action
// in this UI. It replaces native `confirm()`, which could only render one line of
// text and in practice identified its subject by an opaque id ("Delete collection
// col_01J8…?") while saying nothing about blast radius.
//
// confirmModal(spec) -> Promise<boolean>
//   spec.title        — dialog heading, e.g. 'Archive asset'.
//   spec.subject      — the HUMAN-READABLE name of the thing being acted on
//                       (asset name, collection name, profile name, webhook URL,
//                       object filename, stack name, instance name). NEVER an
//                       opaque id. Required and non-empty; see nameOrFallback().
//   spec.subjectLabel — optional qualifier rendered before the subject, e.g.
//                       'collection', 'stack'.
//   spec.question     — optional full question line. When omitted it is built as
//                       `<title> "<subject>"?`.
//   spec.detail       — optional secondary line (e.g. the full object key when
//                       the subject is just the filename).
//   spec.affected     — REQUIRED non-empty array of strings: what this action
//                       DOES change. Each entry must be verified against the
//                       route handler, never assumed.
//   spec.unaffected   — REQUIRED non-empty array of strings: what it does NOT
//                       change. Same verification bar.
//   spec.confirmLabel — confirm button text (default 'Confirm').
//
// ── Blocked variant (issue #896, docs/ux/asset-lock-state-spec.md §5.2) ──
// Additive; every field below is optional and existing callers are unchanged.
//   spec.blocked      — when truthy the dialog explains a refusal instead of
//                       asking for one. NO confirm button is rendered, the
//                       dismiss button is labelled `Close` (spec.closeLabel),
//                       and the promise always resolves `false`. There is
//                       nothing to confirm: the API has already refused and
//                       nothing changed. An empty `spec.affected` is omitted
//                       rather than rendered as an empty list, because in this
//                       variant "nothing is affected" is the whole point and the
//                       detail line says so in words.
//   spec.closeLabel   — dismiss button text in the blocked variant.
//   spec.blockedBy    — optional { heading, items[] } list of the ids that
//                       caused the refusal (job ids, collection ids). Rendered
//                       through the same textContent-only impactList.
//   spec.resolution   — optional sentence under the lists telling the operator
//                       what WOULD unblock the action.
//   spec.secondary    — optional { label, onActivate } non-destructive action
//                       (e.g. `Open detail`, the route to the Unlock control).
//                       Closes the dialog, resolves `false`, then invokes
//                       onActivate.
//
// Resolves `true` only when the operator activates the confirm button, and
// `false` for every dismissal route (Cancel, ×, Escape, backdrop click) via
// openModal's onClose hook. It resolves EXACTLY ONCE, so a caller can await it
// as the single gate for the action — one dialog per action, never a second
// nested confirmation.
//
// Everything is written with textContent: subject names are operator/tenant data
// (asset names, webhook URLs, object keys) and must never be parsed as HTML.
//
// ── Positional form (issue #952) ──
// confirmModal(subjectName, message, onConfirm) -> Promise<boolean>
//   The terse form, for a call site that holds a subject name and one question
//   line and has nothing route-verified to put in the impact lists. It
//   normalises onto the spec form below and shares its markup, focus order and
//   resolution contract — this UI has ONE confirmation dialog, not two that
//   drift apart.
//     subjectName — the human-readable name, same rule as spec.subject: never an
//                   opaque id. Run it through nameOrFallback() if it may be blank.
//     message     — the full question line (spec.question). Omitted/blank falls
//                   back to the generated `Confirm "<subjectName>"?`.
//     onConfirm   — optional callback invoked once, only on confirm, after the
//                   dialog has closed. Its return value is ignored and it must
//                   handle its own failures (errorModal() is for that) — the
//                   same convention as spec.secondary.onActivate above.
//   The promise still resolves true/false, so an awaiting caller keeps working
//   whether or not it also passes onConfirm.
//
//   A spec-form call is a single object argument; a positional call starts with
//   a string, which is how the two are told apart.
function confirmModal(spec, message, onConfirm) {
  if (typeof spec === 'string') {
    const line = message == null || String(message).trim() === '' ? null : String(message);
    const normalised = {
      subject: spec,
      question: line,
      // No impact lists were supplied, so empty ones are dropped rather than
      // rendered as headings over nothing.
      terse: true,
    };
    // The spec is built as a value rather than inlined: this is the normalisation
    // step, not a destructive call SITE, and the source scan in
    // test/confirm-modal-destructive.test.ts counts inline-spec call sites.
    return confirmModal(normalised).then(function (confirmed) {
      if (confirmed && typeof onConfirm === 'function') onConfirm();
      return confirmed;
    });
  }

  const s = spec || {};
  const subject = s.subject == null ? '' : String(s.subject);
  const question = s.question
    ? String(s.question)
    : (s.title || 'Confirm') + ' ' + (s.subjectLabel ? String(s.subjectLabel) + ' ' : '') +
      '"' + subject + '"?';

  return new Promise(function (resolve) {
    // Guard so the promise settles once no matter which route fires first: the
    // confirm handler calls close(), which triggers onClose immediately after.
    let settled = false;
    function settle(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }

    // Held so focus can be set AFTER openModal has attached the backdrop —
    // focus() on a still-detached element is a no-op.
    let cancelRef = null;

    // The returned close handle is deliberately not bound: this dialog closes
    // through the `closeDialog` callback openModal passes into the body builder.
    openModal(
      s.title || 'Confirm',
      function (body, closeDialog) {
        body.classList.add('confirm-dialog');

        const prompt = document.createElement('p');
        prompt.className = 'confirm-question';
        prompt.textContent = question;
        body.appendChild(prompt);

        if (s.detail) {
          const detail = document.createElement('p');
          detail.className = 'confirm-detail';
          detail.textContent = String(s.detail);
          body.appendChild(detail);
        }

        const blocked = !!s.blocked;
        // The terse positional form (issue #952) carries no impact lists at all,
        // so both empty lists are dropped for it. The spec form is unchanged:
        // both lists are REQUIRED there, and an empty heading showing up in the
        // dialog is a caller bug worth seeing rather than hiding.
        const terse = !!s.terse;
        const affected = Array.isArray(s.affected) ? s.affected : [];
        const unaffected = Array.isArray(s.unaffected) ? s.unaffected : [];
        // The blocked variant drops an empty "What this affects" list rather
        // than rendering a heading over nothing.
        if (!(blocked || terse) || affected.length > 0) {
          body.appendChild(impactList('What this affects', 'confirm-affected', s.affected));
        }
        if (!terse || unaffected.length > 0) {
          body.appendChild(
            impactList('What this does not affect', 'confirm-unaffected', s.unaffected)
          );
        }

        // The ids that caused a refusal (job ids, collection ids). Server data,
        // so it goes through impactList's textContent path like everything else.
        if (blocked && s.blockedBy && Array.isArray(s.blockedBy.items) && s.blockedBy.items.length) {
          body.appendChild(
            impactList(String(s.blockedBy.heading || ''), 'confirm-blocked-by', s.blockedBy.items)
          );
        }

        // What would unblock the action. Sits under the lists because it is the
        // operator's next step, not a description of this one.
        if (blocked && s.resolution) {
          const resolution = document.createElement('p');
          resolution.className = 'confirm-resolution';
          resolution.textContent = String(s.resolution);
          body.appendChild(resolution);
        }

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-sm confirm-cancel';
        cancelBtn.textContent = blocked ? String(s.closeLabel || 'Close') : 'Cancel';

        actions.appendChild(cancelBtn);

        // Optional non-destructive secondary action, blocked variant only.
        if (blocked && s.secondary && s.secondary.label) {
          const secondaryBtn = document.createElement('button');
          secondaryBtn.type = 'button';
          secondaryBtn.className = 'btn-sm confirm-secondary';
          secondaryBtn.textContent = String(s.secondary.label);
          secondaryBtn.addEventListener('click', function () {
            settle(false);
            closeDialog();
            if (typeof s.secondary.onActivate === 'function') s.secondary.onActivate();
          });
          actions.appendChild(secondaryBtn);
        }

        // No confirm button in the blocked variant: the action already failed
        // and re-issuing it would fail identically (spec §5.3 — no "force",
        // "delete anyway" or "retry" affordance).
        if (!blocked) {
          const confirmBtn = document.createElement('button');
          confirmBtn.type = 'button';
          confirmBtn.className = 'btn-sm btn-danger confirm-accept';
          confirmBtn.textContent = s.confirmLabel || 'Confirm';
          confirmBtn.addEventListener('click', function () {
            settle(true);
            closeDialog();
          });
          actions.appendChild(confirmBtn);
        }

        body.appendChild(actions);

        cancelBtn.addEventListener('click', function () {
          settle(false);
          closeDialog();
        });

        cancelRef = cancelBtn;
      },
      {
        // Escape / × / backdrop click — and the confirm+cancel paths above, which
        // have already settled. Any unsettled close is a dismissal.
        onClose: function () { settle(false); },
      }
    );

    // Focus Cancel, not the destructive control: a stray Enter/Space on a freshly
    // opened destructive dialog must not perform the action. Done here, after
    // openModal has attached the backdrop to the document.
    if (cancelRef) cancelRef.focus();
  });
}

// Render one labelled impact list for confirmModal. Lists are plain <ul>s so a
// screen reader announces the item count; the heading is a <div> rather than a
// heading element so it does not compete with the dialog's own <h3> title.
function impactList(heading, className, items) {
  const wrap = document.createElement('div');
  wrap.className = 'confirm-impact ' + className;

  const head = document.createElement('div');
  head.className = 'confirm-impact-heading';
  head.textContent = heading;
  wrap.appendChild(head);

  const ul = document.createElement('ul');
  (Array.isArray(items) ? items : []).forEach(function (item) {
    const li = document.createElement('li');
    li.textContent = String(item);
    ul.appendChild(li);
  });
  wrap.appendChild(ul);
  return wrap;
}

// Resolve a human-readable subject name for a confirmation dialog, falling back
// through a list of candidates. Used so a dialog never degrades to naming its
// subject by an opaque id when a name field happens to be empty: the LAST
// candidate is a descriptive phrase (e.g. 'this collection'), not an id.
function nameOrFallback() {
  for (let i = 0; i < arguments.length; i++) {
    const candidate = arguments[i];
    if (candidate == null) continue;
    const text = String(candidate).trim();
    if (text.length > 0) return text;
  }
  return '';
}

// ─── Action-failure dialog (issue #918) ────────────────────────────────────────
//
// The shared way to report a FAILED operator action, and the counterpart to
// confirmModal() above: confirmModal gates the action, errorToast reports it
// going wrong. It is the replacement for native `alert('Error: ' + err.message)`,
// which rendered outside the app's own styling, froze the whole tab, and gave the
// operator a bare line with no indication of WHICH action had failed.
//
// Named `errorToast` for continuity with the issue, but it is deliberately a
// modal built on openModal, not a transient toast: a failed destructive action
// must be dismissed on purpose, not time out unread while the operator is
// looking elsewhere. Transient, non-blocking status still belongs in showMsg().
//
// errorToast(message, opts) -> close fn
//   Returns openModal's close handle, so a caller can dismiss the dialog
//   programmatically (e.g. when a retry succeeds behind it).
//
//   message       — the human-readable failure text. Usually `err.message`, which
//                   apiFetch (app.js:259-275) has already resolved through the
//                   server's human `message`, then its machine `error` code, then
//                   the `HTTP <status>` line. An absent/blank message falls back
//                   to a plain sentence rather than opening an empty dialog.
//   opts.title    — dialog heading (default 'Something went wrong').
//   opts.action   — optional short phrase naming what failed, e.g.
//                   'Delete collection'. Rendered above the message so the
//                   operator does not have to infer it from the message text.
//   opts.detail   — optional secondary line (an object key, id, or next step).
//   opts.closeLabel — dismiss button text (default 'Close').
//   opts.onClose  — optional callback; fires exactly once, on whichever route
//                   dismissed the dialog (Close, ×, Escape, backdrop click),
//                   via openModal's onClose hook.
//
// The message carries the app's own `.msg .msg-error` classes (style.css:670 and
// :677, the same pair showMsg() applies) so a failure looks identical whether it
// lands inline or in this dialog, and `role="alert"` so a screen reader announces
// it on open — the heading alone is static, the message is the part that differs
// between failures (WCAG 2.1 AA 4.1.3 Status Messages).
//
// Everything is written with textContent: error messages embed server and tenant
// data (object keys, asset names, webhook URLs) and must never be parsed as HTML.
function errorToast(message, opts) {
  const o = opts || {};
  const text = (message == null || String(message).trim() === '')
    ? 'The action failed, and the server did not say why.'
    : String(message);

  // Held so focus can be set AFTER openModal has attached the backdrop —
  // focus() on a still-detached element is a no-op (same reason as confirmModal).
  let dismissRef = null;

  const close = openModal(
    o.title || 'Something went wrong',
    function (body, closeDialog) {
      body.classList.add('error-dialog');

      if (o.action) {
        const action = document.createElement('p');
        action.className = 'error-action';
        action.textContent = String(o.action) + ' failed.';
        body.appendChild(action);
      }

      const msg = document.createElement('div');
      msg.className = 'msg msg-error';
      msg.setAttribute('role', 'alert');
      msg.textContent = text;
      body.appendChild(msg);

      if (o.detail) {
        const detail = document.createElement('p');
        detail.className = 'error-detail';
        detail.textContent = String(o.detail);
        body.appendChild(detail);
      }

      const actions = document.createElement('div');
      actions.className = 'modal-actions';

      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'btn-sm error-dismiss';
      dismissBtn.textContent = o.closeLabel || 'Close';
      dismissBtn.addEventListener('click', function () { closeDialog(); });
      actions.appendChild(dismissBtn);

      body.appendChild(actions);

      dismissRef = dismissBtn;
    },
    {
      onClose: typeof o.onClose === 'function' ? o.onClose : undefined,
    }
  );

  // Dismiss is the only control, so focusing it is both the safe default and the
  // fastest route out. Done here, after openModal has attached the backdrop.
  if (dismissRef) dismissRef.focus();

  return close;
}

// ─── Machine-readable failure reasons (issue #920) ─────────────────────────────
//
// errorToast() shows whatever text it is handed, and apiFetch (app.js:260-269)
// hands it `body.message` — which for a refusal is written for a developer, not
// an operator: `collection 01J8… is in use (2 member asset(s))`
// (CollectionInUseError, src/data/collection-repo.ts:160) or `asset 01J8… is
// protected from deletion by an explicit lock` (DeleteProtectedError,
// src/data/asset-repo.ts:830). Those internal sentences are what this issue
// exists to stop showing.
//
// CONTRACT GROUNDING (CLAUDE.md rule 7 — read in the live tree, not assumed)
//
// The API's shared refusal envelope carries a machine-readable `reason` beside
// the human `message`. Both routers that emit it declare the SAME closed enum:
//     src/routes/assets.ts:570       deleteBlockedSchema
//     src/routes/collections.ts:65   deleteBlockedSchema
//         reason: z.enum(['referenced_by_job', 'member_of_collection',
//                         'delete_protected'])
// and the three values are emitted at:
//     delete_protected      src/routes/assets.ts:2695, src/routes/collections.ts:262
//     member_of_collection  src/routes/assets.ts:2707, src/routes/collections.ts:275
//     referenced_by_job     src/routes/assets.ts:2720
//
// `reason` is OPTIONAL on the generic envelope (`reason: z.string().optional()`,
// src/routes/collections.ts:46), so a body may carry none, or one this client
// does not know — every lookup below is guarded and falls back to the server's
// own `message`, then to errorToast's own generic sentence.
//
// DELIBERATELY NOT MAPPED: the collection metadata-cap reasons
// (`description_too_long`, `too_many_tags`, `tag_too_long`, `custom_too_large`;
// CollectionMetadataCapReason, src/routes/collections.ts:122-126). Their server
// `message` is already operator-readable AND quotes the live limit
// (collections.ts:148-177, e.g. "description exceeds the maximum length of 2048
// characters"). Restating those numbers here would duplicate a server-owned
// value that can change without this file.
const ACTION_FAILURE_REASON_COPY = Object.freeze({
  delete_protected:
    'A delete lock is set on it, so the API refuses the delete. Clear the lock from the ' +
    'item’s detail view first — the lock cannot be forced.',
  member_of_collection:
    'It is still a member of one or more collections. Remove it from those collections ' +
    'first, then try again.',
  referenced_by_job:
    'A job that is still running references it. Wait for that job to finish or cancel it, ' +
    'then try again.',
});

// Map an apiFetch rejection to operator-facing copy, or null when the body
// carries no reason this client recognises.
//
// `err.body` is the parsed error body apiFetch attaches (app.js:271-274).
// hasOwnProperty, not `in`, so a body whose `reason` is `constructor` or
// `toString` cannot reach an inherited property.
function humanizeErrorReason(err) {
  const body = err && err.body;
  if (!body || typeof body !== 'object') return null;
  const reason = typeof body.reason === 'string' ? body.reason : null;
  if (!reason) return null;
  if (!Object.prototype.hasOwnProperty.call(ACTION_FAILURE_REASON_COPY, reason)) return null;
  return ACTION_FAILURE_REASON_COPY[reason];
}

// Report a failed operator action in app styling (issue #920). The single
// replacement for `alert('Error: ' + err.message)`: it prefers the humanized
// reason when the API sent a structured one, falls back to the server's own
// message, and — via errorToast — to a generic sentence when there is neither.
//
// `opts` is errorToast's (action / detail / title / closeLabel / onClose);
// `action` and `detail` are what the native alert could never carry, so a caller
// names WHICH action failed and what is consequently still true.
function reportActionFailure(err, opts) {
  return errorToast(humanizeErrorReason(err) || (err && err.message), opts);
}

// ─── Permanently unrecoverable outcome (issue #933) ────────────────────────────
//
// CONTRACT GROUNDING (CLAUDE.md rule 7 — read in the live tree, not assumed)
//
//   POST /api/v1/assets/{id}/restore declares exactly three responses:
//       response: { 200: assetSchema, 404: errorSchema, 410: errorSchema }
//     src/routes/assets.ts:5755 — mirrored in openapi.json
//     .paths["/api/v1/assets/{id}/restore"].post.responses (keys 200/404/410;
//     one required path parameter `id`; no requestBody).
//   errorSchema is
//       z.object({ error: z.string(), message: z.string().optional() })
//     src/routes/assets.ts:529 — so `error` is the ONLY guaranteed field and
//     `message` may legitimately be absent.
//   The route emits its 410 in exactly one place:
//       return reply.code(410).send({ error: 'gone', message: 'asset has been purged' });
//     src/routes/assets.ts:5767, reached when repo.getState(id) reports
//     `kind === 'tombstone'` (assets.ts:5764-5768) — i.e. the retention sweep
//     already purged the archived asset and replaced its document in place with a
//     tombstone. The handler returns there: no state change, no audit entry
//     (documented at assets.ts:5743-5744 and 5780-5781).
//
// WHY THIS IS NOT REPORTED LIKE EVERY OTHER FAILURE
//
// `.msg-error` and errorToast/reportActionFailure are this app's single signal
// for "the action failed" — and in practice that means "try again": every refusal
// this client humanizes ends with literally that instruction
// (ACTION_FAILURE_REASON_COPY above). A 410 here is the opposite class of fact.
// `archived` is terminal on the ordinary state machine (ALLOWED_TRANSITIONS.
// archived = [], src/data/asset-repo.ts:39), `/:id/restore` is the only route
// back out of it — and that is precisely the route that just refused, for a
// document the API can no longer turn back into an asset. So a retry is not
// merely unlikely to work; nothing in the API can ever make it work. Painting it
// in the same red box as a 503 or a dropped connection invites exactly the retry
// the issue exists to prevent, so it gets its own treatment: its own class, its
// own label, and — the part styling alone cannot do — removal of the control that
// led here.
const PURGED_UNRECOVERABLE_LABEL = 'Permanently unrecoverable';

// Curly-quote the first usable candidate for inline prose (same argument order as
// nameOrFallback), or return '' when there is none — so a nameless record falls
// back to the notice's own generic subject rather than reading as empty quotes.
function quotedOrEmpty() {
  const name = nameOrFallback.apply(null, arguments);
  return name ? '“' + name + '”' : '';
}

// True for the apiFetch rejection raised by the tombstone 410 above.
//
// `err.status` is the primary discriminator (apiFetch sets it from the response,
// app.js:292) and is sufficient on its own: the route declares one 410 and emits
// it from one line. `err.body` (app.js:295) is used to CONFIRM the machine code
// when a body was parsed, never required — per errorSchema a body may carry only
// `error`, and a truncated/non-JSON response leaves `body` undefined.
function isPurgedGone(err) {
  if (!err || err.status !== 410) return false;
  const body = err.body;
  if (body && typeof body === 'object' && typeof body.error === 'string') {
    return body.error === 'gone';
  }
  return true;
}

// Report a purged asset as permanently unrecoverable, and take away the retry
// affordance that led here.
//
// `host`      — element to append the notice to (e.g. #action-msg).
// `opts.retire` — elements to REMOVE from the DOM. Disabling a button is not
//              enough: a greyed-out control still reads as "unavailable for now",
//              and the whole point of a 410 is that there is no "for now". The
//              explanatory note that described the action goes with it, so no
//              stale promise (or dangling aria-describedby target) survives.
// `opts.subject` — operator-facing name of the asset (untrusted text).
// `opts.serverMessage` — the API's own `message`, shown verbatim as a secondary
//              line when present; omitted entirely when it is not.
// `opts.id`   — element id for the notice, so a caller can address its own.
//
// Built with innerHTML so every interpolated value passes through escHtml: both
// `subject` and `serverMessage` carry data this client did not author.
function renderPurgedUnrecoverable(host, opts) {
  if (!host) return null;
  const o = opts || {};

  // Retire the control FIRST, so the notice is never announced next to a button
  // that contradicts it.
  const retire = o.retire || [];
  for (let i = 0; i < retire.length; i++) {
    const el = retire[i];
    if (el && typeof el.remove === 'function') el.remove();
  }

  const notice = document.createElement('div');
  notice.id = o.id || 'purged-unrecoverable-notice';
  // Deliberately NOT .msg-error — see the note above. `.msg` alone keeps the
  // shared box metrics; `.msg-unrecoverable` (style.css) supplies the distinct
  // terminal styling.
  notice.className = 'msg msg-unrecoverable';
  // Appears without a page change, and is the outcome of an action the operator
  // just took (WCAG 2.1 AA 4.1.3 Status Messages).
  notice.setAttribute('role', 'alert');
  // Machine-readable outcome class, so a test — or a future view — can tell a
  // terminal outcome from a retryable one without matching on prose.
  notice.setAttribute('data-outcome', 'unrecoverable');

  const subject = nameOrFallback(o.subject, 'This asset');
  const serverMessage = o.serverMessage == null ? '' : String(o.serverMessage).trim();

  notice.innerHTML =
    '<span class="unrecoverable-label">' + escHtml(PURGED_UNRECOVERABLE_LABEL) + '</span>' +
    '<span class="unrecoverable-body">' +
      escHtml(subject) + ' has been purged by the retention sweep. Its record is now a ' +
      'tombstone, so the API answers 410 Gone and the asset can never be restored. ' +
      'This is final — not a temporary failure, and not something a retry or a later ' +
      'attempt can change. To work with this material again, ingest the source file as ' +
      'a new asset.' +
    '</span>' +
    (serverMessage
      ? '<span class="unrecoverable-detail">The API reported: ' + escHtml(serverMessage) + '</span>'
      : '');

  host.appendChild(notice);
  return notice;
}

// ─── Action-failure dialog, title-first form (issue #952) ──────────────────────
//
// errorModal(title, reason, opts) -> close fn
//
// The counterpart to confirmModal's positional form, and the same normalise-onto-
// one-dialog move: a call site that holds a heading and whatever the API sent
// back gets the dialog errorToast() already renders, without having to know which
// of the failure shapes it is holding. Returns errorToast's close handle.
//
//   title  — dialog heading, e.g. 'Delete collection failed'. Blank/absent falls
//            back to errorToast's own default heading.
//   reason — what went wrong, in any shape a call site actually holds:
//              * an apiFetch rejection — `message` already resolved as
//                body.message -> body.error -> 'HTTP <status>' (app.js:260-269),
//                with `status` and the parsed `body` attached (app.js:271-274);
//              * a parsed error body on its own, `{ error, message?, reason? }`
//                (errorSchema, src/routes/collections.ts:43-47);
//              * an already-resolved human string;
//              * nothing at all.
//   opts   — forwarded to errorToast (action / detail / closeLabel / onClose).
//
// Resolution order lives in resolveFailureText() below, so a caller does not
// have to reproduce it.
function errorModal(title, reason, opts) {
  const o = opts || {};
  const heading = title == null || String(title).trim() === '' ? undefined : String(title);
  return errorToast(resolveFailureText(reason), {
    title: heading,
    action: o.action,
    detail: o.detail,
    closeLabel: o.closeLabel,
    onClose: o.onClose,
  });
}

// Resolve the text errorModal shows out of an apiFetch rejection, a parsed error
// body, a plain string, or nothing. Returns '' when the failure says nothing at
// all, so errorToast applies its own generic sentence instead of this file
// carrying a second copy of it.
//
// Precedence, and why:
//   1. Operator-facing copy for a structured `reason` this client recognises —
//      ACTION_FAILURE_REASON_COPY above, keyed by the closed enum both routers
//      declare (src/routes/assets.ts:570, src/routes/collections.ts:65). It wins
//      over the server `message`, which for those refusals is written for a
//      developer and names its subject by an opaque id (issue #920).
//   2. The server's human `message` — on the rejection, then on the body.
//   3. The bare code, when `reason` is a value this client has no copy for
//      (`reason` is z.string().optional() on the generic envelope, so it need not
//      be one of the three) or when only `error` is set. Naming the code the
//      server sent beats claiming it sent nothing; the fall-through order mirrors
//      apiFetch's own message -> error precedence.
//   4. '' — no reason and no message.
function resolveFailureText(reason) {
  if (reason == null) return '';
  if (typeof reason === 'string') return reason;
  if (typeof reason !== 'object') return String(reason);

  // An apiFetch rejection carries the parsed body on `.body`; a body handed over
  // directly IS the body. hasOwnProperty, not `in`, for the same reason
  // humanizeErrorReason() uses it: a `body` key must not resolve up the chain.
  const body = Object.prototype.hasOwnProperty.call(reason, 'body') ? reason.body : reason;

  const humanized = humanizeErrorReason({ body: body });
  if (humanized) return humanized;

  const own = typeof reason.message === 'string' ? reason.message.trim() : '';
  if (own) return own;

  const envelope = body && typeof body === 'object' ? body : {};
  const message = typeof envelope.message === 'string' ? envelope.message.trim() : '';
  if (message) return message;

  const code = typeof envelope.reason === 'string' && envelope.reason.trim()
    ? envelope.reason.trim()
    : (typeof envelope.error === 'string' ? envelope.error.trim() : '');
  if (code) return 'The server refused the action (' + code + ').';

  return '';
}

// ─── Storage-backend remove confirmation (issue #682) ──────────────────────────
// Format the human-readable in-use error for a 409 body. The authoritative
// contract (branch issue-679/storage-backend-api-endpoints,
// src/routes/storage.ts:216-224 inUseErrorSchema + :274-283 handler) is:
//   { error: 'backend_in_use', message: string,
//     references: { assetIds: string[], activeJobIds: string[] } }
// The server always supplies a human `message`; we prefer it verbatim. When it
// is somehow absent we synthesise one from the reference counts so the operator
// still learns why removal was blocked.
function describeBackendInUse(err) {
  const body = err && err.body;
  if (body && typeof body.message === 'string' && body.message.trim()) {
    return body.message;
  }
  const refs = (body && body.references) || {};
  const assets = Array.isArray(refs.assetIds) ? refs.assetIds.length : 0;
  const jobs = Array.isArray(refs.activeJobIds) ? refs.activeJobIds.length : 0;
  const n = assets + jobs;
  return 'This backend is still referenced by ' + n +
    ' asset' + (n === 1 ? '' : 's') + ' or active job' + (n === 1 ? '' : 's') +
    ' and cannot be removed.';
}

// Open a confirmation dialog for removing a storage backend (issue #682). The
// DELETE (src/routes/storage.ts:517-535 on issue-679, openapi.json
// /api/v1/storage/backends/{id}.delete) is issued ONLY when the operator clicks
// Remove inside this dialog. A 409 (BackendInUseError -> backend_in_use) keeps
// the dialog open and surfaces the human-readable message; on 204 we close and
// invoke opts.onRemoved so the caller drops the row without a full reload.
function openStorageBackendRemoveDialog(backend, opts) {
  const options = opts || {};
  const id = backend && backend.id != null ? String(backend.id) : '';
  const name = backend && backend.name ? String(backend.name) : id;

  return openModal('Remove storage backend', function(body, close) {
    body.classList.add('storage-remove-dialog');

    const prompt = document.createElement('p');
    prompt.className = 'storage-remove-prompt';
    // textContent — the backend name is untrusted and must never be parsed as
    // HTML (mirrors the list view's escaping guarantee).
    prompt.textContent = 'Remove storage backend "' + name + '"? This cannot be undone.';
    body.appendChild(prompt);

    const errEl = document.createElement('div');
    errEl.className = 'storage-remove-error';
    errEl.setAttribute('role', 'alert');
    errEl.style.display = 'none';
    body.appendChild(errEl);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-sm storage-remove-cancel';
    cancelBtn.textContent = 'Cancel';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn-sm btn-danger storage-remove-confirm';
    confirmBtn.textContent = 'Remove';

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    body.appendChild(actions);

    cancelBtn.addEventListener('click', close);

    confirmBtn.addEventListener('click', async function() {
      errEl.style.display = 'none';
      errEl.textContent = '';
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      try {
        await apiFetch('/storage/backends/' + encodeURIComponent(id), { method: 'DELETE' });
        close();
        if (typeof options.onRemoved === 'function') options.onRemoved(backend);
      } catch (err) {
        // 409 = still referenced by an asset or active job (issue #679). Keep
        // the dialog open and surface a human-readable reason (acceptance
        // criterion). Any other failure surfaces its own message likewise.
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
        errEl.textContent = err && err.status === 409
          ? describeBackendInUse(err)
          : 'Error: ' + (err && err.message ? err.message : 'removal failed');
        errEl.style.display = '';
        confirmBtn.focus();
      }
    });

    // Focus the confirm control so a keyboard user can act immediately.
    confirmBtn.focus();
  });
}

// ─── Storage-backend test-connection (issue #683) ──────────────────────────────
// Contract (per CLAUDE.md rule 7), verified against the authoritative endpoint
// on branch issue-679/storage-backend-api-endpoints:
//   - POST /api/v1/storage/backends/{id}/test-connection
//       Handler: src/routes/storage.ts:478-501 (issue-679).
//       Request body (testConnectionBodySchema, storage.ts:206-209):
//         { secretAccessKey: string(min 1), sessionToken?: string(min 1) }
//         — secretAccessKey is REQUIRED; the literal secret was never persisted
//         (ADR-017 D1) so the caller re-supplies it to probe with.
//       Response (testConnectionResultSchema, storage.ts:210-213 / openapi.json
//         "/api/v1/storage/backends/{id}/test-connection".post.responses.200):
//         { status: 'connected' | 'unreachable', message: string }.
//       404 — no such backend; 501 — registry not configured.
//   - The server enforces its own 10s hard ceiling
//       (TEST_CONNECTION_TIMEOUT_MS, storage-backend-registry.ts:558) resolving a
//       hung probe to `unreachable`. The issue additionally requires the UI to
//       surface a timeout if the call itself exceeds 10s, so we abort client-side
//       at the same bound as a defence against a stalled/absent response.
//   - The OSC-managed default (id 'default', DEFAULT_BACKEND_ID,
//       storage-backend-registry.ts:57) is answered `connected` by the handler
//       BEFORE any probe (registry.testConnection short-circuits on the id), so
//       the required secret value is irrelevant for it — we send a non-empty
//       placeholder purely to satisfy the schema's minLength(1).
const STORAGE_TEST_CONNECTION_TIMEOUT_MS = 10_000;

// Placeholder secret sent for the default backend only. The handler never probes
// with it (see the contract note above); it exists only so the required
// secretAccessKey field is a non-empty string.
const STORAGE_TEST_DEFAULT_SECRET = 'platform-default';

// Reusable probe call shared by the add/edit form (issue #681) and the per-row
// action (issue #683). Sends the redacted-free secret the caller supplies and
// resolves to the verbatim { status, message } contract, or throws (network /
// HTTP error, or a client-side timeout when the call exceeds 10s). Kept free of
// any DOM so it is directly unit-testable.
async function testStorageBackendConnection(id, secret, extra) {
  const body = { secretAccessKey: secret };
  if (extra && extra.sessionToken) body.sessionToken = extra.sessionToken;

  // Client-side 10s abort (issue #683 acceptance): if the request itself does
  // not settle within the bound, surface a timeout rather than waiting forever.
  // AbortController is available in browsers and happy-dom; guard defensively.
  let controller;
  let timer;
  const opts = { method: 'POST', body: JSON.stringify(body) };
  if (typeof AbortController === 'function') {
    controller = new AbortController();
    opts.signal = controller.signal;
  }
  const timeout = new Promise(function(_, reject) {
    timer = setTimeout(function() {
      if (controller) {
        try { controller.abort(); } catch (_) { /* ignore */ }
      }
      const err = new Error(
        'Test connection timed out after ' +
        (STORAGE_TEST_CONNECTION_TIMEOUT_MS / 1000) + ' seconds.'
      );
      err.isTimeout = true;
      reject(err);
    }, STORAGE_TEST_CONNECTION_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      apiFetch('/storage/backends/' + encodeURIComponent(id) + '/test-connection', opts),
      timeout,
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Pure DOM helper (issue #683): show an in-flight spinner in a row's status cell.
// Returns the status-badge element so a caller can restore it if needed. The
// cell is the <td> holding `.storage-backend-status`.
function setStorageBackendRowProbing(row) {
  const statusTd = row && row.querySelector('.storage-backend-status')
    ? row.querySelector('.storage-backend-status').parentNode
    : null;
  if (!statusTd) return;
  statusTd.innerHTML = '';
  const probing = document.createElement('span');
  probing.className = 'badge badge-pending storage-backend-status is-probing';
  probing.setAttribute('role', 'status');
  probing.setAttribute('aria-live', 'polite');
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  probing.appendChild(spinner);
  probing.appendChild(document.createTextNode(' Testing…'));
  statusTd.appendChild(probing);
}

// Pure DOM helper (issue #683): render the outcome of a probe inline on the row.
// Replaces the status badge with Connected (green) / Unreachable (red) and, on
// failure or timeout, shows the message beneath the badge. `outcome` is either a
// contract result { status, message } or { status:'unreachable', message } we
// synthesise from a thrown error. Every dynamic value is set via textContent.
function applyStorageBackendRowTestResult(row, outcome) {
  const badge = row && row.querySelector('.storage-backend-status');
  const statusTd = badge ? badge.parentNode : null;
  if (!statusTd) return;
  const connected = outcome && outcome.status === 'connected';
  statusTd.innerHTML = '';

  const newBadge = document.createElement('span');
  newBadge.className = 'badge ' + (connected ? 'badge-ready' : 'badge-failed') +
    ' storage-backend-status';
  newBadge.textContent = connected ? 'Connected' : 'Unreachable';
  statusTd.appendChild(newBadge);

  // On failure surface the message inline beneath the badge (acceptance
  // criterion). On success the message ('reachable' / default note) is
  // conveyed by the badge itself, so we keep the cell compact.
  if (!connected) {
    const msg = outcome && outcome.message ? String(outcome.message) : 'Unreachable.';
    const msgEl = document.createElement('div');
    msgEl.className = 'storage-backend-test-error';
    msgEl.setAttribute('role', 'alert');
    msgEl.textContent = msg;
    statusTd.appendChild(msgEl);
  }
}

function loadingEl() {
  const el = document.createElement('div');
  el.className = 'loading';
  el.innerHTML = '<span class="spinner"></span>';
  const txt = document.createTextNode(' Loading…');
  el.appendChild(txt);
  return el;
}

// ─── Detached detail window ───────────────────────────────────────────────────
// Opens a standalone detail view (asset or job) in a new browser window. The
// detached window renders ONLY that one detail view, self-polls, and shares no
// state with this window. The active stack is passed explicitly so the detached
// window targets the same stack without depending on the opener's localStorage.
// The URL of that standalone view. Broken out (issue #793) so a link to another
// resource's detail — e.g. the child asset a clip produced — can be a REAL
// anchor href (openable in a new tab, copyable) rather than a click handler
// that only works in the window it was built in. `getActiveStack()` already
// resolves the window-scoped override first, so a link built inside a detached
// window targets that window's stack.
function detailWindowUrl(type, id) {
  return 'detail.html?type=' + encodeURIComponent(type) +
    '&id=' + encodeURIComponent(id) +
    '&stack=' + encodeURIComponent(getActiveStack());
}

function openDetailWindow(type, id) {
  window.open(detailWindowUrl(type, id), '_blank', 'width=680,height=800,noopener');
}

// ─── Tab switching ────────────────────────────────────────────────────────────

// Routing allowlist. This MUST stay in step with the `.tab-btn[data-tab]`
// buttons rendered by public/index.html and with the TAB_RENDERERS registry
// below. `logs` was rendered and had a registered renderer but was never added
// here, so switchTab dropped every click on it (issue #823). The list is kept
// explicit rather than derived from the DOM so a stray/injected button cannot
// become routable; auditTabWiring() below is what keeps the three in step.
const TABS = ['assets', 'jobs', 'logs', 'audit', 'transcoders', 'pipelines', 'profiles', 'collections', 'search', 'webhooks', 'storage', 'provision'];
const TAB_RENDERERS = {};

const TAB_KEY = 'ovc-active-tab';

// Tabs whose sidebar entry + view are gated on the caller's role. Storage
// backend management is an editor/admin surface (issue #680); a viewer must
// never see the entry nor be able to route to it.
const ROLE_GATED_TABS = { storage: canManageStorage };

function isTabAllowed(name) {
  const gate = ROLE_GATED_TABS[name];
  return typeof gate === 'function' ? gate() : true;
}

// Report — rather than silently ignore — any rendered tab button that is not
// routable (issue #823 acceptance criterion 3). A button with no allowlist
// entry is inert; a button in the allowlist with no registered renderer would
// throw in switchTab. Both are wiring mistakes that must be loud at startup.
// Pure: takes the root to scan and returns the problems, so a test can assert
// on the result without capturing console output.
function auditTabWiring(root) {
  const scope = root || document;
  const problems = [];
  scope.querySelectorAll('.tab-btn[data-tab]').forEach(function (btn) {
    const name = btn.dataset.tab;
    const inAllowlist = TABS.includes(name);
    const hasRenderer = typeof TAB_RENDERERS[name] === 'function';
    if (!inAllowlist || !hasRenderer) {
      problems.push({ tab: name, inAllowlist: inAllowlist, hasRenderer: hasRenderer });
    }
  });
  // Also catch the inverse: an allowlisted tab with no renderer would throw the
  // moment anything routed to it (including a stale persisted TAB_KEY).
  TABS.forEach(function (name) {
    if (typeof TAB_RENDERERS[name] !== 'function' && !problems.some(function (p) { return p.tab === name; })) {
      problems.push({ tab: name, inAllowlist: true, hasRenderer: false });
    }
  });
  return problems;
}

function reportTabWiring(root) {
  const problems = auditTabWiring(root);
  problems.forEach(function (p) {
    const reasons = [];
    if (!p.inAllowlist) reasons.push('missing from the TABS allowlist');
    if (!p.hasRenderer) reasons.push('has no registered renderer in TAB_RENDERERS');
    console.error('[ops-ui] tab "' + p.tab + '" is not routable: ' + reasons.join(' and ') + '.');
  });
  return problems;
}

function switchTab(name) {
  // Never fail silently on an unroutable name: a bare `return` here left the
  // previous view on screen with no error, which is exactly what hid #823. It
  // also blanked the page on boot from a stale persisted TAB_KEY. Report and
  // fall back to the always-available default instead.
  if (!TABS.includes(name)) {
    console.error('[ops-ui] switchTab("' + name + '"): unknown tab, falling back to "assets".');
    name = 'assets';
  }
  // Fail closed: never render a role-gated view for a role that may not see it,
  // even if an old persisted TAB_KEY or a manual call names it.
  if (!isTabAllowed(name)) name = 'assets';
  localStorage.setItem(TAB_KEY, name);
  document.querySelectorAll('.tab-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  if (jobsPollTimer) { clearInterval(jobsPollTimer); jobsPollTimer = null; }
  const content = document.getElementById('content');
  content.innerHTML = '';
  content.classList.toggle('content-fullbleed', name === 'assets' || name === 'jobs' || name === 'pipelines');
  TAB_RENDERERS[name](content);
}

function setupTabs() {
  // Startup wiring check (issue #823): surface any rendered-but-unroutable tab
  // before the operator discovers it by clicking a dead button.
  reportTabWiring(document);
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    // Hide the sidebar entry for any role-gated tab the current role may not
    // access. Acceptance criterion #680: the Storage link renders only for
    // editor/admin. Hidden (not just disabled) so it is absent for viewers.
    if (!isTabAllowed(btn.dataset.tab)) {
      btn.style.display = 'none';
      btn.setAttribute('aria-hidden', 'true');
      return;
    }
    btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
  });
}

// ─── ASSETS TAB ──────────────────────────────────────────────────────────────
//
// The table itself (sort / filter / pagination + URL state) is provided by the
// shared assets-table wiring in public/assets-table.js (issue #369), which
// composes the merged shared table primitive (#367/#372) and URL-state contract
// (#368/#373) against the verified GET /api/v1/assets/ + GET /api/v1/search/
// contracts. This tab owns only the surrounding chrome: the upload/ingest modals
// and the detail side panel. `assetsTable` holds the live instance so the modals
// and row actions can trigger a reload.
let assetsTable = null;

async function renderAssetsTab(container) {
  // Layout: full-height table on the left, detail side panel on the right (hidden initially).
  const layout = document.createElement('div');
  layout.className = 'assets-layout';
  container.appendChild(layout);

  // ── Main (table) column ──
  const main = document.createElement('div');
  main.className = 'assets-main';
  layout.appendChild(main);

  const header = document.createElement('div');
  header.className = 'assets-main-header';
  header.innerHTML = [
    '<span class="section-title">Assets</span>',
    '<div class="flex-gap">',
    '  <button id="btn-open-upload" class="header-btn">Upload File</button>',
    '  <button id="btn-open-ingest" class="header-btn">Ingest URL</button>',
    '  <button id="assets-refresh" class="btn-ghost" style="font-size:12px;padding:6px 12px;">Refresh</button>',
    '</div>',
  ].join('');
  main.appendChild(header);

  // ── Side detail panel (created on demand) ──
  const detailPanel = document.createElement('div');
  detailPanel.id = 'asset-detail';
  detailPanel.className = 'assets-side';
  detailPanel.style.display = 'none';
  layout.appendChild(detailPanel);

  // ── Shared assets table (sort / filter / pagination + URL state) ──
  // The status filter (a proper lifecycle-state select) subsumes the old
  // "Needs attention" checkbox: operators isolate `processing` via the status
  // filter; the per-row "Needs attention" badge + inline Re-drive action are
  // preserved by the table's Status/Actions column renderers.
  // ── Bulk-action bar (issue #916) ──
  // Mounted above the table and declared before it so the table's
  // `onSelectionChange` can hand it every change. It starts with an empty
  // selection, which is the state its controls render as disabled.
  let bulkBar = null;

  assetsTable = createAssetsTable({
    apiFetch,
    renderBadge,
    renderTags,
    fmtDate,
    isAssetWedged,
    // Opt in to the leading tick-box column (issue #916). Without this the
    // table renders exactly as before, which is what every other consumer of
    // createAssetsTable still gets.
    selectable: true,
    onSelectionChange: function (selection) {
      if (bulkBar) bulkBar.setSelection(selection);
    },
    onRowClick: function (id) {
      showAssetDetail(id, detailPanel);
    },
    // ── Rename from the row (issue #927) ──
    //
    // The detail view got this action first (#956); this is the same action
    // reached one click earlier. It is deliberately the SAME dialog
    // (openRenameDialog) and therefore the same single PATCH /api/v1/assets/{id}
    // body — `{ name }` and nothing else — rather than a second rename path that
    // could drift from it. The contract is cited in full in
    // public/asset-rename.js; nothing about the API changes for this control.
    //
    // Passed as the function, not its result: the table calls it while rendering
    // each page, so changing role in the UI takes effect on the next repaint.
    canRename: canRenameAsset,
    onRename: async function (id, name) {
      const outcome = await openRenameDialog({
        // `name` is the row's current title, so the field is prefilled without a
        // second GET. The row carries the ULID in `data-id`, which is what
        // PATCH /:id requires — that route has no slug fallback.
        asset: { id: id, name: name },
        apiFetch: apiFetch,
        openModal: openModal,
      });
      if (outcome.renamed) {
        // Reload (the table's default) so the new title appears in the Name /
        // Title column. If the detail pane happens to be showing this asset, it
        // is re-read too: it renders the same `name` and would otherwise keep
        // displaying the old one.
        if (detailPanel.style.display !== 'none' && detailPanel.dataset.assetId === id) {
          showAssetDetail(id, detailPanel);
        }
        return true;
      }
      // Not renamed — cancelled, or refused. Every refusal (403, 404, a rejected
      // name, a transport failure) has already been stated IN the dialog, where
      // the operator still has what they typed, so nothing is reported a second
      // time out here. A 404 is the one case that still earns a reload: the row on
      // screen is stale, and the reload is what removes it.
      return outcome.gone === true;
    },
    onDelete: async function (id, name, rowState) {
      const label = nameOrFallback(name, 'this asset');
      // Route the operator from a blocked archive to the place the block can be
      // resolved. For a delete lock that is the detail view's Unlock control
      // (#895); the side panel is exactly what a row click opens.
      const openDetail = function () {
        showAssetDetail(id, detailPanel);
      };

      // ── Pre-flight: the row already knows it is delete-locked (issue #896,
      // docs/ux/asset-lock-state-spec.md §5.1). The Archive button stays ENABLED
      // and focusable — a `disabled` button cannot say why, the free-text search
      // tier cannot know lock state at all (its projection omits `deleteLock`),
      // and the lock is only one of four guards, so an enabled Archive must
      // never be read as a promise that the archive will succeed. The
      // explanation point is this dialog, and it is the SAME dialog the 409 path
      // below opens, so the two cannot drift apart.
      if (rowState && rowState.locked) {
        await showDeleteBlocked({
          block: protectedBlock(),
          name: label,
          confirmModal,
          onOpenDetail: openDetail,
        });
        // No reload: the row already carries the Locked badge, so the client
        // learned nothing new.
        return false;
      }

      // Archive confirmation (issue #919). Impact wording verified against the
      // real semantics, NOT assumed:
      //   - DELETE /api/v1/assets/{id} is a SOFT delete: it sets status to
      //     `archived` and destroys nothing (src/routes/assets.ts:5474-5560 —
      //     "Soft delete: archive rather than destroy"; file header :10-11;
      //     ASSET_STATUSES / ALLOWED_TRANSITIONS.archived = []
      //     src/data/asset-repo.ts:28,39 — archived is terminal).
      //   - It is reversible: POST /api/v1/assets/{id}/restore revives an
      //     archived asset that has not yet been purged (src/routes/assets.ts:
      //     5626-5660; 410 once purged).
      //   - Files are deleted only later, by the retention purge sweep
      //     (src/pipeline/archived-asset-purge-sweep.ts header + per-asset purge
      //     steps), and only when a window is configured — ARCHIVE_RETENTION_MS
      //     unset/0 means never purge (RETENTION_DISABLED_MS,
      //     src/routes/retention.ts:36 + archiveRetentionMsFromEnv :42-44).
      //   - The archive is audited as `asset.archived` (assets.ts:5546-5558).
      //   - It can also be REFUSED outright. Four guards run BEFORE the archive
      //     (assets.ts:5499-5540 — the archive itself is `repo.remove` at :5542),
      //     in this fixed precedence:
      //       1. deleteLock.locked -> DeleteProtectedError (HARD, :5500-5502)
      //       2. an active job referencing the asset -> ReferencedByJobError
      //          (HARD, :5512-5518)
      //       3. countChildren() > 0 -> HasChildrenError (HARD, :5520-5523)
      //       4. membership of any collection -> AssetMemberOfCollectionError
      //          (SOFT, overridable by `?force=true`, :5533-5540)
      //     This UI sends no `force`, so guard 4 fires for any asset that sits in
      //     a collection. All four answer 409 and leave the asset untouched, so
      //     the dialog states the refusal instead of promising the archive.
      // Deliberately NOT claimed: that the asset disappears from lists or stops
      // playing back. The list endpoint applies no implicit status filter and no
      // delivery route gates on `ready`, so both would be false.
      const ok = await confirmModal({
        title: 'Archive asset',
        subject: label,
        question: 'Archive "' + label + '"?',
        confirmLabel: 'Archive',
        affected: [
          'If the asset is delete-locked, referenced by a running job, still has renditions, or belongs to a collection, the API refuses the archive and nothing changes.',
          'Otherwise the asset’s status becomes "archived" and the change is recorded in the audit log.',
          'Archived is a terminal state: no ordinary status update moves the asset out of it — only Restore does.',
          'If this deployment has an archive retention window configured, a background sweep will eventually delete the stored files for good and replace the record with a tombstone.',
        ],
        unaffected: [
          'Nothing is erased right now. The source file, renditions, packaged output, subtitles, thumbnails and all metadata stay in storage.',
          'You can Restore the asset at any point before that retention sweep purges it.',
          'Other assets, collections and jobs are left exactly as they are.',
        ],
      });
      if (!ok) return false;
      try {
        // No `?force=true`. It is a real query parameter on this route
        // (openapi.json .paths["/api/v1/assets/{id}"].delete.parameters) but it
        // only relaxes the soft collection-membership guard, and it can never
        // defeat a delete lock: the lock guard throws at
        // src/routes/assets.ts:5499-5502, 31 lines before `request.query.force`
        // is first read at :5533. Sending it would change nothing for a locked
        // asset and would silently widen the blast radius for every other one.
        await apiFetch('/assets/' + encodeURIComponent(id), { method: 'DELETE' });
        return true;
      } catch (err) {
        // A 409 is a refusal, not a fault: the API declined and nothing changed
        // (all four guards run before `repo.remove`, assets.ts:5499-5542).
        // Explain it instead of showing the bare server sentence in an `alert`
        // (issue #896, spec §5.4). Covers the case the pre-flight check above
        // cannot: a search-tier row whose projection carries no lock field, and
        // a race where another client locked the asset a moment ago.
        const block = classifyDeleteBlock(err);
        if (block) {
          await showDeleteBlocked({
            block,
            name: label,
            confirmModal,
            onOpenDetail: openDetail,
          });
          // Reload the table: the client has just learned the true state, so the
          // Locked badge should appear on the row it was refused for. Returning
          // `true` triggers the table's reload — it means "refresh", not
          // "deleted"; the asset is demonstrably still there.
          return true;
        }
        // Not a refusal classifyDeleteBlock explains (a 404, a 403, a network
        // failure): report it in app styling rather than a native alert.
        reportActionFailure(err, {
          action: 'Archive asset',
          detail: '"' + label + '" was not archived. Nothing has changed.',
        });
        return false;
      }
    },
    onRedrive: async function (id) {
      // Re-run the extractor synchronously via the recovery path of
      // POST /assets/:id/extract-metadata (200 { assetId, status }, issue #281).
      try {
        await apiFetch('/assets/' + encodeURIComponent(id) + '/extract-metadata', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        return true;
      } catch (err) {
        // POST /assets/:id/extract-metadata answers 200 | 202 | 404 | 409 | 501,
        // the failures all on the plain `{ error, message? }` envelope
        // (src/routes/assets.ts:4059-4068), so there is no `reason` to humanize
        // here — reportActionFailure falls back to the server's message.
        reportActionFailure(err, {
          action: 'Re-drive metadata extraction',
          detail: 'Asset ' + id + ' is unchanged.',
        });
        return false;
      }
    },
  });

  // Bulk bar between the header and the table: the controls sit next to the
  // rows they act on, and the DOM order matches the reading order (tick rows ->
  // choose a target -> add), not the other way round.
  bulkBar = renderAssetsBulkBar({
    apiFetch,
    getSelection: function () { return assetsTable.getSelection(); },
    // Per-id untick, so a partial run narrows the table's authoritative
    // selection instead of leaving already-added assets ticked (issue #916).
    deselect: function (ids) { assetsTable.deselect(ids); },
    clearSelection: function () { assetsTable.clearSelection(); },
    onAdded: function () {
      // Membership lives on the collection, not on the asset row, so the asset
      // list itself has nothing new to show — deliberately no reload() here.
    },
  });
  main.appendChild(bulkBar.el);
  main.appendChild(assetsTable.el);

  // ── Upload modal ──
  header.querySelector('#btn-open-upload').addEventListener('click', function() {
    openModal('Upload File', function(body, close) {
      body.innerHTML = [
        '<div class="form-field grow">',
        '  <label for="upload-file">File</label>',
        '  <input type="file" id="upload-file" accept="video/*,audio/*" />',
        '</div>',
        '<div class="flex-gap mt12">',
        '  <button id="upload-btn">Upload</button>',
        '</div>',
        '<div id="upload-msg"></div>',
      ].join('');
      const fileInput = body.querySelector('#upload-file');
      const uploadBtn = body.querySelector('#upload-btn');
      const uploadProgress = body.querySelector('#upload-msg');
      uploadBtn.addEventListener('click', async function() {
        const file = fileInput.files && fileInput.files[0];
        uploadProgress.textContent = '';
        if (!file) { showMsg(uploadProgress, 'Select a file first.', 'error'); return; }
        uploadBtn.disabled = true;
        uploadBtn.textContent = 'Uploading…';
        // Track the asset and any multipart session so a failure or cancel can
        // clean up rather than strand the asset in `uploading` (issue #748).
        // `multipartUploadId` is set by the multipart transfer path (initiate ->
        // part-urls -> complete, wired by the UI multipart routing in #747); the
        // proxied PUT path below leaves it null. Whenever it is set, a thrown
        // error triggers the documented abort route via abortMultipartUpload().
        let assetId = null;
        let multipartUploadId = null;
        try {
          const asset = await apiFetch('/assets', {
            method: 'POST',
            body: JSON.stringify({ name: file.name })
          });
          // Assign the outer `assetId` (not a fresh `const`) so the catch below
          // can clean up via abortMultipartUpload(assetId, …) on failure (#748).
          assetId = asset.id;
          const totalMb = Math.round(file.size / 1024 / 1024 * 10) / 10;
          showMsg(uploadProgress, 'Uploading ' + file.name + ' (' + totalMb + ' MB)…', 'info');
          // Route the transport by file size (issue #747). Small files stream
          // through the proxied PUT /assets/:id/upload as before; medium/large
          // files PUT straight to object storage via the presigned single-part
          // or multipart routes so no single request carries the whole payload
          // through the proxy (which enforces a body limit well below the
          // route's 10 GiB bodyLimit and 413s large files otherwise).
          await uploadAssetFile(assetId, file, {
            apiFetch: apiFetch,
            apiBase: API_BASE,
            stackName: stackOverride || getActiveStack(),
            // The streamed proxy PUT inside uploadAssetFile bypasses apiFetch, so
            // hand it the same UI-scoped bearer apiFetch spreads (issue #740). The
            // presigned/multipart PUTs go straight to object storage under their
            // presigned signature and deliberately do NOT carry this header.
            authHeader: uiAuthHeader(),
            // Surface the multipart session id so the shared abort route can run
            // on a later failure/cancel (issue #748). uploadAssetFile also aborts
            // internally on a mid-transfer failure; this outer hook keeps #748's
            // best-effort abortMultipartUpload() path wired as a safety net.
            onMultipartInit: function (uploadId) { multipartUploadId = uploadId; },
            onProgress: function (loaded, total) {
              const pct = total ? Math.floor((loaded / total) * 100) : 0;
              showMsg(
                uploadProgress,
                'Uploading ' + file.name + ' — ' + pct + '% (' + totalMb + ' MB)…',
                'info'
              );
            },
          });
          close();
          if (assetsTable) assetsTable.reload();
        } catch (err) {
          // Abort/cleanup on failure or cancel so no orphan is left behind
          // (issue #748). If a multipart session was open, hit its abort route;
          // the server reclaims the staged parts and moves the asset out of
          // `uploading`. Best-effort, so it never masks the error shown below.
          if (multipartUploadId) {
            await abortMultipartUpload(assetId, multipartUploadId);
            if (assetsTable) assetsTable.reload();
          }
          // Show the identified CAUSE of the failure, not the bare transport
          // status (issue #772). Every rejection out of uploadAssetFile carries
          // a `failureCause` mirroring the API's `cause` field
          // (src/routes/upload-failure-cause.ts `uploadErrorSchema`);
          // describeUploadFailure() maps it to a sentence and degrades to the
          // status — then to a generic line — when no structured cause is
          // present (e.g. a failure of the `POST /assets` create call above).
          showMsg(uploadProgress, describeUploadFailure(err), 'error');
          uploadBtn.disabled = false;
          uploadBtn.textContent = 'Upload';
        }
      });
    });
  });

  // ── Ingest modal ──
  header.querySelector('#btn-open-ingest').addEventListener('click', function() {
    openModal('Ingest from URL', function(body, close) {
      body.innerHTML = [
        '<div class="form-field grow">',
        '  <label for="ingest-url">Source URL</label>',
        '  <input type="url" id="ingest-url" placeholder="https://example.com/video.mp4" />',
        '</div>',
        '<div class="form-field grow mt8">',
        '  <label for="ingest-title">Title (optional)</label>',
        '  <input type="text" id="ingest-title" placeholder="My asset" />',
        '</div>',
        '<div class="flex-gap mt12">',
        '  <button id="ingest-btn">Ingest</button>',
        '</div>',
        '<div id="ingest-msg"></div>',
      ].join('');
      body.querySelector('#ingest-btn').addEventListener('click', async function() {
        const url = body.querySelector('#ingest-url').value.trim();
        const titleVal = body.querySelector('#ingest-title').value.trim();
        const msgEl = body.querySelector('#ingest-msg');
        msgEl.innerHTML = '';
        if (!url) { showMsg(msgEl, 'Source URL is required.', 'error'); return; }
        try {
          const reqBody = { sourceUrl: url };
          if (titleVal) reqBody.title = titleVal;
          await apiFetch('/assets/ingest-url', { method: 'POST', body: JSON.stringify(reqBody) });
          close();
          if (assetsTable) assetsTable.reload();
        } catch (err) {
          showMsg(msgEl, 'Error: ' + err.message, 'error');
        }
      });
    });
  });

  header.querySelector('#assets-refresh').addEventListener('click', function() {
    if (assetsTable) assetsTable.reload();
  });
}

async function showAssetDetail(id, detailPanel) {
  detailPanel.style.display = 'flex';
  // Which asset this pane is currently showing, so a list-row action that changes
  // the asset (the row Rename, issue #927) can tell whether the open pane is now
  // displaying a stale value and needs re-reading.
  detailPanel.dataset.assetId = id;
  // Static structural HTML only. A "pop out" affordance sits next to the close
  // button so the user can detach this asset detail into its own window.
  detailPanel.innerHTML = [
    '<div class="detail-panel-header">',
    '  <h3>Asset Detail</h3>',
    '  <div class="detail-panel-actions">',
    '    <button id="popout-detail" class="side-close-btn" aria-label="Open in new window" title="Open in new window">⧉</button>',
    '    <button id="close-detail" class="side-close-btn" aria-label="Close">×</button>',
    '  </div>',
    '</div>',
    '<div class="detail-panel-body" id="detail-body"></div>',
  ].join('');

  detailPanel.querySelector('#close-detail').addEventListener('click', function() {
    detailPanel.style.display = 'none';
    detailPanel.innerHTML = '';
    var table = document.querySelector('#assets-table-wrap table');
    if (table) table.querySelectorAll('tbody tr').forEach(function(r) { r.classList.remove('row-selected'); });
  });

  detailPanel.querySelector('#popout-detail').addEventListener('click', function() {
    openDetailWindow('asset', id);
  });

  const body = detailPanel.querySelector('#detail-body');
  // Navigating the version chain (issue #907) rebuilds the whole pane, not just
  // the body: the pop-out button above closes over `id`, so re-rendering the
  // body alone would leave "open in new window" pointing at the version the
  // operator just navigated away from.
  await renderAssetDetailBody(id, body, {
    onNavigate: function (nextId) { return showAssetDetail(nextId, detailPanel); },
  });
}

// Fetch and render an asset's downloadable files + streaming file groups into
// `container` from GET /assets/:id/files. Only meaningful once an asset is
// `ready`; callers gate on that. The response shape is verified against
// src/routes/assets.ts (assetFileSchema / assetFileGroupSchema, ~L187-214) and
// openapi.json:
//   files[]:      { id, type: 'source'|'rendition'|'export', name, format,
//                   objectKey, url, sizeBytes?, label?, width?, height?,
//                   bitrateBps?, codec? }
//   fileGroups[]: { id, type: 'hls-package'|'dash-package', name, manifestUrl,
//                   segmentCount?, objectKeyPrefix }
// Renders a "Files" table (source + renditions + exports, each with a presigned
// download link) and "File Groups" cards (one per HLS/DASH package, with the
// manifest URL, a copy-to-clipboard button, and the segment count). Each section
// shows a distinct empty state when its list is empty (issue #136). All
// server-provided text flows through escHtml before interpolation.
async function renderAssetFiles(assetId, container) {
  container.innerHTML = '';

  var data;
  try {
    data = await apiFetch('/assets/' + encodeURIComponent(assetId) + '/files');
  } catch (err) {
    // A transient/records failure here should not blank the whole detail panel;
    // surface it inline and leave the rest of the panel intact.
    var e = document.createElement('div');
    e.className = 'text-muted';
    e.textContent = 'Could not load files: ' + err.message;
    container.appendChild(e);
    return;
  }

  var files = (data && data.files) || [];
  var fileGroups = (data && data.fileGroups) || [];

  // A compact "resolution/bitrate" summary for a rendition. Any of the optional
  // fields may be absent (e.g. audio-only rendition) — the row still renders
  // with whatever is present, and shows '—' when nothing is available.
  var detailsFor = function(f) {
    var parts = [];
    if (f.width && f.height) parts.push(f.width + '×' + f.height);
    if (f.bitrateBps) parts.push(Math.round(f.bitrateBps / 1000) + ' kbps');
    if (f.codec) parts.push(escHtml(f.codec));
    if (f.sizeBytes != null) parts.push(escHtml(fmtBytes(f.sizeBytes)));
    return parts.length ? parts.join(' · ') : '<span class="text-muted">—</span>';
  };

  // ── Files table (source + renditions + exports) ──────────────────────────
  // Always render the "Files" heading so a ready asset with no downloadable
  // files still shows an explicit empty state (issue #136), rather than the
  // section silently disappearing.
  var filesTitle = document.createElement('div');
  filesTitle.className = 'section-title';
  filesTitle.textContent = 'Files';
  container.appendChild(filesTitle);

  if (files.length > 0) {
    var fwrap = document.createElement('div');
    fwrap.className = 'table-wrap';
    var frows = files.map(function(f) {
      var label = f.label ? (escHtml(f.name) + ' <span class="text-muted">(' + escHtml(f.label) + ')</span>') : escHtml(f.name);
      return '<tr>' +
        '<td>' + renderBadge(f.type) + '</td>' +
        '<td>' + label + '</td>' +
        '<td>' + escHtml(f.format || '—') + '</td>' +
        '<td>' + detailsFor(f) + '</td>' +
        '<td><a class="btn-ghost" href="' + escHtml(f.url) + '" target="_blank" rel="noopener" download>Download</a></td>' +
        '</tr>';
    }).join('');
    fwrap.innerHTML =
      '<table><thead><tr>' +
      '<th>Type</th><th>Filename</th><th>Format</th><th>Details</th><th></th>' +
      '</tr></thead><tbody>' + frows + '</tbody></table>';
    container.appendChild(fwrap);
  } else {
    var filesEmpty = document.createElement('div');
    filesEmpty.className = 'empty';
    filesEmpty.setAttribute('data-empty', 'files');
    filesEmpty.textContent = 'No files available for this asset yet.';
    container.appendChild(filesEmpty);
  }

  // ── File-group cards (HLS / DASH streaming packages) ─────────────────────
  var groupsTitle = document.createElement('div');
  groupsTitle.className = 'section-title mt12';
  groupsTitle.textContent = 'File Groups';
  container.appendChild(groupsTitle);

  if (fileGroups.length > 0) {
    var cards = document.createElement('div');
    cards.className = 'file-group-cards';
    var cardHtml = fileGroups.map(function(g, i) {
      // segmentCount is optional in the contract (assetFileGroupSchema); show it
      // only when the server actually populated it.
      var segLine = (g.segmentCount != null)
        ? '<div class="file-group-meta">' + escHtml(String(g.segmentCount)) + ' segment' + (g.segmentCount === 1 ? '' : 's') + '</div>'
        : '<div class="file-group-meta text-muted">segment count unavailable</div>';
      return '<div class="file-group-card">' +
        '<div class="file-group-card-head">' + renderBadge(g.type) + '<span class="file-group-name">' + escHtml(g.name) + '</span></div>' +
        '<div class="file-group-url cell-id" title="' + escHtml(g.manifestUrl) + '">' + escHtml(g.manifestUrl) + '</div>' +
        segLine +
        '<div class="file-group-actions">' +
          '<button type="button" class="btn-ghost file-group-copy" data-idx="' + i + '">Copy URL</button> ' +
          '<a class="btn-ghost" href="' + escHtml(g.manifestUrl) + '" target="_blank" rel="noopener">Open</a>' +
        '</div>' +
        '</div>';
    }).join('');
    cards.innerHTML = cardHtml;
    container.appendChild(cards);

    // Copy-to-clipboard for each manifest URL. Bound via the untrusted URL held
    // in JS (not re-parsed from the DOM) and reported with transient feedback.
    cards.querySelectorAll('.file-group-copy').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var group = fileGroups[Number(btn.dataset.idx)];
        if (!group) return;
        var restore = function(text) {
          var prev = btn.textContent;
          btn.textContent = text;
          setTimeout(function() { btn.textContent = prev; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(group.manifestUrl).then(
            function() { restore('Copied'); },
            function() { restore('Copy failed'); }
          );
        } else {
          restore('Copy unavailable');
        }
      });
    });
  } else {
    var groupsEmpty = document.createElement('div');
    groupsEmpty.className = 'empty';
    groupsEmpty.setAttribute('data-empty', 'file-groups');
    groupsEmpty.textContent = 'No streaming packages (HLS/DASH) for this asset yet.';
    container.appendChild(groupsEmpty);
  }
}

// Populate an asset detail view into `bodyEl` from a freshly-fetched asset.
// Reusable in both the embedded side panel and the standalone detached window.
// Clears `bodyEl` first so it is safe to call repeatedly (self-poll). Returns
// the fetched asset (or throws if the fetch fails / 404s so callers can react).
//
// `opts.onNavigate(nextId)` (optional, issue #907) is how the version-chain
// block hands the view to another member of the same chain. The default —
// re-render this same body element for the new id — is correct for the embedded
// side panel; callers whose surface owns more chrome than the body (the asset
// pane's pop-out button, the detached window's self-poll) override it so their
// chrome follows the navigation instead of going stale.
async function renderAssetDetailBody(id, bodyEl, opts) {
  const options = opts || {};
  const navigateToVersion = typeof options.onNavigate === 'function'
    ? options.onNavigate
    : function (nextId) { return renderAssetDetailBody(nextId, bodyEl, options); };
  const body = bodyEl;
  body.innerHTML = '';
  const loader = loadingEl();
  body.appendChild(loader);

  {
    try {
    const asset = await apiFetch('/assets/' + encodeURIComponent(id));
    let deliveryUrl = null;
    try { deliveryUrl = await apiFetch('/assets/' + encodeURIComponent(id) + '/delivery'); } catch (_) {}

    loader.remove();

    // Build KV grid with escaped values
    const kvRows = [
      // Issue #851: "ID" carries the ULID unconditionally — never the slug, and
      // never a value that varies per asset. It is the one value every asset-id
      // endpoint accepts (the collections membership route resolves it with a
      // plain repo.get — no slug fallback), and it matches the ID column of the
      // Assets table this pane opens from, so the two never disagree about what
      // "ID" means. The copy button is here because a 26-character ULID should
      // never have to be retyped into a form.
      //
      // Contract: openapi.json .paths["/api/v1/assets/{id}"].get 200 schema —
      // `id` is in `required`, `slug` is an optional property.
      ['ID', copyableIdCellHtml(asset.id, 'Copy asset id')],
    ];
    // The slug keeps its place as the human-readable handle (issues #131/#132/
    // #133) — under its own honest label, never as "ID". Omitted entirely for
    // pre-slug assets, which have no slug at all (optional in the contract
    // above, and `slug?: string` on `Asset`, src/data/asset-repo.ts:455).
    if (asset.slug) {
      kvRows.push(['Slug', '<span class="text-mono">' + escHtml(asset.slug) + '</span>']);
    }
    // Status cell; when the scene-detect pipeline recorded a failure
    // (asset.sceneDetectionError, a plain string per src/routes/assets.ts:381),
    // surface it as a warning right alongside the asset status. Detection never
    // changes the asset's lifecycle status, so this is purely advisory.
    var statusCell = renderBadge(asset.status);
    // Wedged flag (issue #282): stuck in `processing` with a
    // `technicalMetadataError`. Surface it right next to the status so the
    // operator immediately sees the asset is stalled and why.
    if (isAssetWedged(asset)) {
      statusCell += ' <span class="badge badge-attention" title="' + escHtml(asset.technicalMetadataError) + '">Needs attention</span>';
    }
    if (asset.sceneDetectionError) {
      statusCell += ' <span class="text-mono" style="color:var(--error,#f87171)" title="Scene detection failed">⚠ Scene detection: ' + escHtml(asset.sceneDetectionError) + '</span>';
    }
    kvRows.push(
      ['Title', escHtml(asset.title || asset.name || '—')],
      ['Status', statusCell],
      ['MIME type', escHtml(asset.mimeType || '—')],
      // Tags are NOT a key/value row any more (issue #934): they live in the
      // editable "Tags" block mounted just below this grid. Two renderings of
      // one list is exactly how a stale UI happens — the block re-renders from
      // the asset each mutation returns, and this grid is built once per detail
      // read, so a row here would keep showing the pre-mutation list.
      ['Created', escHtml(fmtDate(asset.createdAt))],
      ['Updated', escHtml(fmtDate(asset.updatedAt))]
    );
    if (deliveryUrl && deliveryUrl.urls) {
      var du = deliveryUrl.urls;
      if (du.hls) kvRows.push(['HLS', '<a href="' + escHtml(du.hls) + '" target="_blank" rel="noopener" style="color:var(--accent)">Open</a>']);
      if (du.dash) kvRows.push(['DASH', '<a href="' + escHtml(du.dash) + '" target="_blank" rel="noopener" style="color:var(--accent)">Open</a>']);
      if (du.source) kvRows.push(['Source URL', '<a href="' + escHtml(du.source) + '" target="_blank" rel="noopener" style="color:var(--accent)">Download</a>']);
    }
    if (asset.technicalMetadata) {
      var tm = asset.technicalMetadata;
      kvRows.push(['Codec', escHtml(tm.codec || '—')]);
      kvRows.push(['Resolution', (tm.width && tm.height) ? (tm.width + '×' + tm.height) : '—']);
      kvRows.push(['Duration', tm.durationSeconds ? (tm.durationSeconds.toFixed(1) + 's') : '—']);
      kvRows.push(['Bitrate', tm.bitrateBps ? (Math.round(tm.bitrateBps / 1000) + ' kbps') : '—']);
      kvRows.push(['Container', escHtml(tm.containerFormat || '—')]);
      if (tm.audioTracks && tm.audioTracks.length > 0) {
        var audioLabel = tm.audioTracks.map(function(t) {
          return escHtml(t.codec) + ' ' + t.channels + 'ch ' + (t.sampleRateHz / 1000).toFixed(1) + 'kHz';
        }).join(', ');
        kvRows.push(['Audio', audioLabel]);
      }
    } else if (asset.technicalMetadataError) {
      kvRows.push(['Tech Metadata', '<span style="color:var(--error,#f87171)">' + escHtml(asset.technicalMetadataError) + '</span>']);
    }
    const kvHtml = kvRows.map(function(r) {
      return '<span class="kv-key">' + r[0] + '</span><span class="kv-val">' + r[1] + '</span>';
    }).join('');

    const kvDiv = document.createElement('div');
    kvDiv.className = 'kv-grid';
    kvDiv.innerHTML = kvHtml;
    body.appendChild(kvDiv);
    // Bind the ULID copy affordance (issue #851).
    wireCopyIdButtons(kvDiv);

    // ── Tags: add / remove (issue #934, broken out of #792) ──
    //
    // Contract, fetched before these calls were written (CLAUDE.md rule 7) and
    // cited in full — with the verified constraints — in public/asset-tags.js:
    //   READ: there is NO GET /assets/{id}/tags. `openapi.json
    //        .paths["/api/v1/assets/{id}/tags"]` declares `post` only; the list
    //        is the optional `tags` array on the asset body already awaited
    //        above (`assetSchema`, src/routes/assets.ts:919), so the panel adds
    //        no round-trip. Absent and `[]` both mean "no tags" and both occur.
    //   POST /api/v1/assets/{id}/tags — body REQUIRED
    //        { tags: string[] }, each 1..128 chars, 1..128 items,
    //        additionalProperties: false; 200 = the FULL asset, 404 { error }.
    //        APPENDS and deduplicates (src/routes/assets.ts:5568-5590, merge at
    //        :5583 via normalizeTags, src/data/asset-repo.ts:1297).
    //   DELETE /api/v1/assets/{id}/tags/{tag} — no body; 200 = the FULL asset,
    //        404 { error }. Removing an absent tag is a 200 no-op
    //        (src/routes/assets.ts:5595-5618, filter at :5609).
    // Mounted directly under the key/value grid, where the read-only "Tags" row
    // used to be, so the tags stay where operators already look for them — and
    // so there is exactly ONE rendering of the list. Both mutations return the
    // full asset and the panel re-renders from THAT (never from a local edit),
    // which is what keeps the list in step with the server after every change.
    //
    // The sub-resource takes the ULID (`asset.id`): unlike GET /:id neither
    // handler resolves a slug (verified — POST to /assets/<slug>/tags 404s), and
    // this pane holds the ULID even when it was opened by slug.
    mountAssetTags({
      asset: asset,
      host: body,
      canChange: canChangeTags(),
      apiFetch: apiFetch,
      showMsg: showMsg,
    });

    // ── Status history (issue #889) ──
    // The audited lifecycle trail. Rendered here so a status transition an
    // operator triggers from this pane (notably Restore, below) is VISIBLE as a
    // transition and not just as a changed badge.
    //
    // Contract — openapi.json .paths["/api/v1/assets/{id}"].get and
    // .paths["/api/v1/assets/{id}/restore"].post, 200 schema property
    // `statusHistory` (also in that schema's `required` list):
    //   array of { at: string, from: <status>|null, to: <status> },
    //   each item `required: ["at","from","to"]`, additionalProperties: false;
    //   status enum = uploading|processing|ready|failed|archived.
    // Mirrored in source by statusHistory on assetSchema (src/routes/assets.ts:855).
    // Entries are APPENDED, never rewritten (ADR-005; applyRestore,
    // src/data/asset-repo.ts:1022-1030), so the newest transition is last.
    // `from` is null only for the very first entry (asset creation).
    var lifecycleHistory = Array.isArray(asset.statusHistory) ? asset.statusHistory : [];
    if (lifecycleHistory.length > 0) {
      const histDiv = document.createElement('div');
      histDiv.className = 'mt12';
      histDiv.id = 'status-history';

      const histTitle = document.createElement('div');
      histTitle.className = 'section-title';
      histTitle.textContent = 'Status history';
      histDiv.appendChild(histTitle);

      // Newest first: the transition just performed is the one an operator is
      // looking for, and it is the last element on the wire.
      var histRows = lifecycleHistory
        .slice()
        .reverse()
        .map(function (h) {
          var from = h && h.from ? h.from : null;
          var to = h && h.to ? h.to : '—';
          var transition = from
            ? renderBadge(from) + ' <span aria-hidden="true">→</span> ' + renderBadge(to)
            : '<span class="text-muted">created</span> <span aria-hidden="true">→</span> ' + renderBadge(to);
          return (
            '<tr>' +
            '<td class="text-mono">' + escHtml(fmtDate(h && h.at)) + '</td>' +
            '<td>' + transition + '</td>' +
            '</tr>'
          );
        })
        .join('');

      var hwrap = document.createElement('div');
      hwrap.className = 'table-wrap';
      hwrap.innerHTML =
        '<table><caption class="visually-hidden">Audited status transitions, newest first</caption>' +
        '<thead><tr><th scope="col">At</th><th scope="col">Transition</th></tr></thead>' +
        '<tbody>' + histRows + '</tbody></table>';
      histDiv.appendChild(hwrap);
      body.appendChild(histDiv);
    }

    if (asset.metadata) {
      const metaDiv = document.createElement('div');
      metaDiv.className = 'mt12';
      const metaTitle = document.createElement('div');
      metaTitle.className = 'section-title';
      metaTitle.textContent = 'Metadata';
      const pre = document.createElement('pre');
      pre.className = 'code-block';
      pre.textContent = JSON.stringify(asset.metadata, null, 2);
      metaDiv.appendChild(metaTitle);
      metaDiv.appendChild(pre);
      body.appendChild(metaDiv);
    }

    // Scene/shot-detection metadata (issue #197). Shape verified against
    // src/data/asset-repo.ts: SceneMetadata { boundaries: SceneBoundary[];
    // sceneCount: number; detectedAt: string } (L159-165) and each
    // SceneBoundary { startSeconds?; endSeconds?; keyframeSeconds? } (L147-151),
    // mirrored by sceneMetadataSchema in src/routes/assets.ts:293-297. The field
    // is `null` until the first successful detection, so only render the section
    // when boundaries are actually present — never an empty section.
    var sm = asset.sceneMetadata;
    if (sm && Array.isArray(sm.boundaries) && sm.boundaries.length > 0) {
      const sceneDiv = document.createElement('div');
      sceneDiv.className = 'mt12';

      const sceneTitle = document.createElement('div');
      sceneTitle.className = 'section-title';
      // sceneCount is a convenience mirror of boundaries.length; fall back to the
      // array length if the server omitted/mismatched it.
      var count = (typeof sm.sceneCount === 'number') ? sm.sceneCount : sm.boundaries.length;
      sceneTitle.textContent = 'Scenes (' + count + ')';
      sceneDiv.appendChild(sceneTitle);

      if (sm.detectedAt) {
        const detectedLine = document.createElement('div');
        detectedLine.className = 'text-muted';
        detectedLine.textContent = 'Detected ' + fmtDate(sm.detectedAt);
        sceneDiv.appendChild(detectedLine);
      }

      // Format a boundary as "start → end" using whatever seconds fields are
      // present; every field is optional in the contract, so guard each one.
      var fmtSecs = function(v) {
        return (typeof v === 'number') ? v.toFixed(1) + 's' : '—';
      };
      var rows = sm.boundaries.map(function(b, i) {
        var window = fmtSecs(b.startSeconds) + ' → ' + fmtSecs(b.endSeconds);
        var key = (typeof b.keyframeSeconds === 'number')
          ? escHtml('key ' + b.keyframeSeconds.toFixed(1) + 's')
          : '<span class="text-muted">—</span>';
        return '<tr>' +
          '<td>' + (i + 1) + '</td>' +
          '<td class="text-mono">' + escHtml(window) + '</td>' +
          '<td class="text-mono">' + key + '</td>' +
          '</tr>';
      }).join('');
      var swrap = document.createElement('div');
      swrap.className = 'table-wrap';
      swrap.innerHTML =
        '<table><thead><tr>' +
        '<th>#</th><th>Window</th><th>Keyframe</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
      sceneDiv.appendChild(swrap);
      body.appendChild(sceneDiv);
    }

    // ── Tracks: video / audio / subtitle (issue #902, + subtitle add/remove #940) ──
    //
    // Contract, fetched before these calls were written (CLAUDE.md rule 7) and
    // cited in full in public/tracks-panel.js. Every field on first paint comes
    // from the ONE GET /api/v1/assets/{id} 200 body already awaited above — the
    // panel adds no round-trip to the render:
    //   Editorial audio + subtitle: `audioTracks` / `subtitleTracks` on that
    //        body. Item schemas { id, language, codec?, channels?, label?,
    //        default? } and { id, language, format, objectKey?, label?,
    //        default? } (audioTrackOutSchema src/routes/assets.ts:804-811,
    //        subtitleTrackOutSchema :815-822). Both properties are `.optional()`
    //        on assetSchema (:916, :917) and absent means the asset has none of
    //        that kind (:914-915) — never "unknown" — so each renders its own
    //        empty state.
    //   Video: NO endpoint exposes a video-track array. The only video
    //        attributes in any response are on `technicalMetadata`
    //        (src/routes/assets.ts:893, schema :761-771) — the same four fields
    //        the persistence layer writes into the document's video track,
    //        `technical.video = [{ codec, width, height, bitrateBps }]`
    //        (src/data/asset-document.ts:402-404).
    //
    // The two subtitle writes (#940), also verified against the live schema:
    //   POST /api/v1/assets/{id}/subtitle-tracks — body REQUIRED,
    //        additionalProperties: false, required ["language","format"]:
    //        language (string 1..64), format ("vtt"|"srt"|"ttml"), label
    //        (string 1..128, optional), default (boolean, optional).
    //        201 = { track, uploadUrl? } where `track` is the object the handler
    //        persisted; 404 = { error, message? } for an unknown/foreign asset;
    //        400 (undeclared but real) for a body the schema refuses.
    //        (addSubtitleTrackSchema src/routes/assets.ts:915-920, route
    //        :6527-6569, `track` built :6555-6564 and sent :6567.)
    //   DELETE /api/v1/assets/{id}/subtitle-tracks/{trackId} — no body, no query
    //        params; 204 on removal, 404 for an unknown asset OR an unknown
    //        track. Removes the TRACK RECORD only and leaves the subtitle object
    //        in storage (src/routes/assets.ts:6571, :6575-6597).
    //
    // ── Audio track add/remove (issue #903, broken out of #794) ──
    // Contract fetched before these calls were written and cited in full in
    // public/audio-track-edit.js:
    //   POST /api/v1/assets/{id}/audio-tracks — body
    //        { language (required, 1-64), codec? (1-64), channels? (int 1-64),
    //        label? (1-128), default? } `additionalProperties: false`
    //        (addAudioTrackSchema, src/routes/assets.ts:907-913, wired :6462-6492);
    //        201 returns the asset's FULL updated `{ audioTracks }` (:6470,
    //        :6490), so a successful add needs no follow-up read. 404 is the
    //        only other declared response.
    //   DELETE /api/v1/assets/{id}/audio-tracks/{trackId} — no body; 204 (empty,
    //        no content-type on the wire) or 404 (src/routes/assets.ts:6497-6519).
    //        The handler filters the list and patches ONE key, so it deletes no
    //        media and touches nothing else.
    //
    // All four writes are gated by resourceAuthorizationPreHandler('asset')
    // (src/auth/authorize.ts:126, registered src/routes/assets.ts:1938): POST ->
    // write, DELETE -> delete, neither held by `viewer` — hence
    // canChangeSubtitleTracks() and canEditAudioTracks().
    //
    // GET /api/v1/assets/{id}/tracks exists but is NOT called on the render
    // path, nor after a subtitle write: its handler sends
    // `asset.audioTracks ?? []` / `asset.subtitleTracks ?? []` off the same
    // document (src/routes/assets.ts:6453-6454, repo.get at :6447), so it would
    // cost a round-trip for bytes this renderer — or the write's own response —
    // already holds. The audio editor DOES call it, but only after a 204 from a
    // remove, which carries no body — see public/audio-track-edit.js.
    //
    // Mounted here, with the other information blocks (status history, metadata,
    // scenes) and ABOVE the action row: the panel is still overwhelmingly a
    // report, and both sets of track controls belong beside the lists they
    // change rather than in the asset-wide action row, which is for whole-asset
    // verbs.
    //
    // `confirmModal` is handed in rather than imported: tracks-panel.js is
    // imported BY this module, so importing back would be a cycle (the same
    // injection pattern delete-blocked.js and lock-detail.js use). Without it
    // the panel offers no remove control at all, so neither destructive call can
    // happen unconfirmed. `asset.id` is the ULID even when this pane was opened
    // by slug — every one of these sub-resource routes takes params.id straight
    // to repo.get and does not resolve slugs.
    mountAssetTracks({
      asset: asset,
      host: body,
      assetId: asset.id,
      apiFetch: apiFetch,
      canChange: canChangeSubtitleTracks(),
      confirmModal: confirmModal,
      showMsg: showMsg,
      audioEdit: canEditAudioTracks()
        ? {
            assetId: asset.id,
            apiFetch: apiFetch,
            confirmModal: confirmModal,
          }
        : null,
      // A viewer keeps the whole panel (they hold `read`) and is told once why
      // the controls are not there, rather than being left to wonder.
      audioEditDenied: canEditAudioTracks() ? null : AUDIO_EDIT_COPY.roleNote,
    });

    // ── Versions: the asset's whole version chain (issue #907) ──
    //
    // Contract, fetched before this call was written (CLAUDE.md rule 7) and
    // cited in full in public/version-chain.js:
    //   GET /api/v1/assets/{id}/versions — the ONLY operation on that path
    //        (openapi.json .paths["/api/v1/assets/{id}/versions"]; handler
    //        src/routes/assets.ts:3446-3484). 200 =
    //        { assetId, versionGroupId?, currentVersionId, versions[] },
    //        required ["assetId","currentVersionId","versions"] (:3452-3457);
    //        items are the full assetSchema, of which this block reads `id`,
    //        `name`, `status`, `createdAt` and the lineage edge
    //        `versionOfAssetId` (:882). 404 = flat { error, message? } (:529).
    //        No query parameters: the chain is not paginated, only capped at
    //        MAX_LIMIT = 200 (src/data/asset-repo.ts:853).
    //
    // Three things this block does NOT do, because the contract does not
    // support them:
    //   - It never re-derives the current version. `currentVersionId` is
    //     computed server-side by a preference ladder over `status`
    //     (src/data/asset-repo.ts:1275-1294) and is explicitly NOT "the last
    //     array element" (:1239-1243), so the field is read as sent.
    //   - It offers no promote / set-current control: no endpoint accepts one,
    //     and there is no stored marker it could write (ADR-024 D3). Current is
    //     shown as observed state, never as an operator choice.
    //   - It never reparents a member whose `versionOfAssetId` is outside the
    //     returned page; those are grouped as orphans rather than attached to
    //     the root, which would assert an edge the API did not report.
    //
    // The path takes the ULID (`asset.id`): unlike GET /assets/{id}, this route
    // passes the raw param to repo.listVersions (:3463), which looks up by id
    // alone — a slug would 404. The detail pane holds the ULID even when it was
    // opened by slug.
    //
    // Mounted with the other read-only information blocks and ABOVE the action
    // controls, next to Tracks: it reports lineage and originates no mutation.
    await mountVersionChain({
      assetId: asset.id,
      host: body,
      apiFetch: apiFetch,
      // Inject the app's own status->class map so one `status` value never
      // renders two different ways on a single page.
      badgeClass: badgeClass,
      onNavigate: navigateToVersion,
    });

    // Pipeline executions (PipelineExecution feature). Rendered as a small table
    // per execution; refreshed by the Run Pipeline control below.
    const execDiv = document.createElement('div');
    execDiv.className = 'mt12';
    execDiv.id = 'executions-area';
    body.appendChild(execDiv);
    await renderExecutions(id, execDiv);

    // Run Pipeline control: pipeline select + optional profile select + trigger.
    // Pipeline options + the transcode gate (ENCODE_PIPELINES) are both derived
    // from the module-level PIPELINE_CATALOG, so new built-in pipelines show up
    // here automatically without editing this dialog.

    // Load available Encore profiles from the public GET /profiles endpoint.
    // No auth header needed, so use a plain fetch rather than apiFetch.
    // Fall back to the known-good 'program' profile if the fetch fails or is empty.
    var encodeProfiles = ['program'];
    try {
      const profilesResp = await fetch('/api/v1/profiles');
      if (profilesResp.ok) {
        const profilesData = await profilesResp.json();
        if (profilesData && Array.isArray(profilesData.profiles) && profilesData.profiles.length > 0) {
          encodeProfiles = profilesData.profiles;
        } else {
          console.warn('GET /profiles returned no profiles; falling back to default ["program"]');
        }
      } else {
        console.warn('GET /profiles failed with status ' + profilesResp.status + '; falling back to default ["program"]');
      }
    } catch (e) {
      console.warn('GET /profiles request failed; falling back to default ["program"]', e);
    }

    // Which opt-in steps the ACTIVE stack has configured (issue #790). Read
    // before the options are built so an unconfigured optional step is disabled
    // up front rather than silently skipped at run time. Fail-open: an
    // unreadable stack config leaves every option enabled.
    var stepAvailability = await loadOptionalStepAvailability();

    // Build the pipeline options from the shared catalog so future built-in
    // pipelines appear automatically. Each option label shows the pipeline id
    // plus its ordered step list, e.g. "subtitles (subtitles)".
    var pipelineOptions = PIPELINE_CATALOG.map(function(p) {
      var stepSummary = p.steps.join(' + ');
      var label = p.name + ' (' + stepSummary + ')';
      var blocked = unconfiguredOptionalSteps(p, stepAvailability);
      var unavailable = isPipelineUnavailable(p, stepAvailability);
      var title = p.description;
      if (unavailable) {
        // Nothing this pipeline does is configured — disable it and say why.
        label += ' — not configured for this stack';
        title = notConfiguredText(blocked) +
          '. Provision the ' + optionalServiceNames(blocked) +
          ' service from the Provision tab to enable this pipeline.';
      } else if (blocked.length > 0) {
        // Mixed pipeline: still runnable, but warn which step will be skipped.
        label += ' — ' + blocked.join(', ') + ' will be skipped';
        title = notConfiguredText(blocked) + ', so that step is skipped. The other steps still run.';
      }
      return '<option value="' + escHtml(p.name) + '"' +
        (unavailable ? ' disabled' : '') +
        ' title="' + escHtml(title) + '">' +
        escHtml(label) + '</option>';
    }).join('');

    // Steps the stack cannot run, surfaced once above the selector so the reason
    // is readable without hovering a disabled option (touch-safe, and announced
    // by assistive tech alongside the selector).
    var unconfiguredSteps = Object.keys(OPTIONAL_STEP_CONFIG).filter(function(step) {
      return stepAvailability[step] === false;
    });

    const runDiv = document.createElement('div');
    runDiv.className = 'mt12 flex-gap';
    runDiv.innerHTML = [
      '<select id="pipeline-select" class="input"' +
        (unconfiguredSteps.length > 0 ? ' aria-describedby="pipeline-unconfigured-note"' : '') + '>',
      pipelineOptions,
      '</select>',
      '<select id="profile-select" class="input" title="Encode profile (for pipelines with a transcode step)">',
      encodeProfiles.map(function(p) { return '<option value="' + escHtml(p) + '">' + escHtml(p) + '</option>'; }).join(''),
      '</select>',
      '<button id="btn-run-pipeline" class="btn-ghost">Run Pipeline</button>',
    ].join('');
    body.appendChild(runDiv);

    // One plain-language line explaining the disabled options (issue #790).
    // Rendered only when something is actually unconfigured, so a fully
    // provisioned stack sees no extra chrome.
    if (unconfiguredSteps.length > 0) {
      const stepNote = document.createElement('div');
      stepNote.id = 'pipeline-unconfigured-note';
      stepNote.className = 'mt8 text-muted';
      stepNote.style.fontSize = '12px';
      stepNote.textContent =
        notConfiguredText(unconfiguredSteps) +
        ', so pipelines that only use those steps are disabled. Provision ' +
        optionalServiceNames(unconfiguredSteps) +
        ' from the Provision tab to enable them.';
      body.appendChild(stepNote);
    }

    // Show/hide profile selector based on whether chosen pipeline has a transcode step.
    var pipelineSel = runDiv.querySelector('#pipeline-select');
    var profileSel = runDiv.querySelector('#profile-select');

    // Never leave a disabled option as the active selection. Browsers already
    // skip disabled options when picking the default, but the catalog order is
    // data-driven and a future first entry could be optional.
    var selectedOpt = pipelineSel.options[pipelineSel.selectedIndex];
    if (!selectedOpt || selectedOpt.disabled) {
      for (var oi = 0; oi < pipelineSel.options.length; oi++) {
        if (!pipelineSel.options[oi].disabled) {
          pipelineSel.selectedIndex = oi;
          break;
        }
      }
    }

    function updateProfileVisibility() {
      var hasTranscode = ENCODE_PIPELINES.indexOf(pipelineSel.value) !== -1;
      profileSel.style.display = hasTranscode ? '' : 'none';
    }
    pipelineSel.addEventListener('change', updateProfileVisibility);
    updateProfileVisibility();

    // Action buttons — static labels, no dynamic content
    // For a wedged asset (issue #282) the extraction action is a recovery
    // "re-drive": POST /assets/:id/extract-metadata runs synchronously and
    // returns the settled status (200), so label it accordingly and refresh the
    // detail afterwards to reflect the status change.
    var wedgedDetail = isAssetWedged(asset);
    // Restore is offered for, and ONLY for, an asset currently in `archived`
    // (issue #889). `archived` is terminal on the ordinary state machine
    // (ALLOWED_TRANSITIONS.archived = [], src/data/asset-repo.ts:39), so this
    // endpoint is the single way back — and the API answers 404 for a restore
    // of anything that is not archived, so showing the control on a live asset
    // would only offer a guaranteed failure.
    var isArchived = asset.status === 'archived';
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'mt12 flex-gap';
    actionsDiv.innerHTML = [
      isArchived
        ? '<button id="btn-restore-asset" class="btn-primary" aria-describedby="restore-note">Restore</button>'
        : '',
      '<button id="btn-extract-meta" class="' + (wedgedDetail ? 'btn-primary' : 'btn-ghost') + '">' +
        (wedgedDetail ? 'Re-drive extraction' : 'Extract Metadata') + '</button>',
      '<button id="btn-thumbnails" class="btn-ghost">Thumbnails</button>',
    ].join('');
    body.appendChild(actionsDiv);

    // Plain-language note for the restore control, verified against the route
    // rather than assumed (see the handler below for the full citation list):
    //   - the target status is the pre-archive one when it was `ready`,
    //     otherwise `failed` (restoreTargetStatus, src/data/asset-repo.ts:1006-1014)
    //   - restore moves the LIFECYCLE axis only; `storageTiering` is untouched
    //     (src/routes/assets.ts:5640-5644), so bytes on a cold tier stay cold.
    // Deliberately NOT claimed: any remaining-retention countdown. No such field
    // exists on the asset or the restore response
    // (docs/findings/asset-restore-contract-888.md §4), so the UI does not
    // invent one.
    if (isArchived) {
      const restoreNote = document.createElement('div');
      restoreNote.id = 'restore-note';
      restoreNote.className = 'mt8 text-muted';
      restoreNote.style.fontSize = '12px';
      restoreNote.textContent =
        'This asset is archived. Restore returns it to the status it held before ' +
        'archiving (“ready”, or “failed” if it was not ready) and records the ' +
        'transition in its status history. It restores the lifecycle status only — ' +
        'stored bytes are not moved between storage tiers. Once the retention ' +
        'sweep has purged the asset, restore is no longer possible.';
      body.appendChild(restoreNote);
    }

    var runBtn = runDiv.querySelector('#btn-run-pipeline');
    runBtn.addEventListener('click', async function() {
      actionMsg.innerHTML = '';
      var pipeline = pipelineSel.value;
      var hasTranscode = ENCODE_PIPELINES.indexOf(pipeline) !== -1;
      var body2 = { pipeline: pipeline };
      if (hasTranscode) body2.profile = profileSel.value;

      // Loading state: disable the button (and selects) and show progress so the
      // user gets immediate feedback that the dispatch is in flight.
      var prevLabel = runBtn.textContent;
      runBtn.disabled = true;
      pipelineSel.disabled = true;
      profileSel.disabled = true;
      runBtn.textContent = 'Running…';
      showMsg(actionMsg, 'Queuing pipeline…', 'info');

      try {
        var exec = await apiFetch('/assets/' + encodeURIComponent(id) + '/execute', {
          method: 'POST',
          body: JSON.stringify(body2)
        });
        actionMsg.innerHTML = '';
        // showMsg inserts via textContent, so pass the raw server strings (no escHtml).
        showMsg(actionMsg, 'Pipeline "' + exec.pipelineName + '" queued (execution ' + exec.id + ').', 'success');
        // Refresh the executions/status area so the queued job appears immediately.
        await renderExecutions(id, execDiv);
      } catch (err) {
        actionMsg.innerHTML = '';
        // err.message carries the API error detail (apiFetch extracts body.error/message).
        showMsg(actionMsg, 'Error: ' + err.message, 'error');
      } finally {
        runBtn.disabled = false;
        pipelineSel.disabled = false;
        profileSel.disabled = false;
        runBtn.textContent = prevLabel;
        updateProfileVisibility();
      }
    });

    const actionMsg = document.createElement('div');
    actionMsg.id = 'action-msg';
    actionMsg.className = 'mt8';
    // One-line outcomes (lock set/cleared, restore, extraction) land here after
    // the action completes. Announced politely so a change that does not move
    // focus is still reported to assistive technology
    // (docs/ux/asset-lock-state-spec.md §8).
    actionMsg.setAttribute('aria-live', 'polite');
    body.appendChild(actionMsg);

    const thumbArea = document.createElement('div');
    thumbArea.id = 'thumbnails-area';
    body.appendChild(thumbArea);

    // Files + File Groups (issue #157). Only fetch/show for a ready asset; the
    // helper itself hides the section when the response has no files or groups.
    // 'ready' matches the ASSET_STATUSES enum (src/data/asset-repo.ts:28).
    if (asset.status === 'ready') {
      const filesArea = document.createElement('div');
      filesArea.className = 'mt12';
      filesArea.id = 'files-area';
      body.appendChild(filesArea);
      await renderAssetFiles(id, filesArea);
    }

    // ── Restore an archived asset (issue #889) ──
    //
    // Contract, fetched before this call was written (CLAUDE.md rule 7):
    //   openapi.json .paths["/api/v1/assets/{id}/restore"] — the only key is
    //   `post`; its `responses` keys are exactly 200 / 404 / 410; the single
    //   parameter is path `id` (string, required); there is NO requestBody.
    //   Source of truth: src/routes/assets.ts:5645-5690 (`app.post('/:id/restore')`,
    //   schema `{ 200: assetSchema, 404: errorSchema, 410: errorSchema }` at :5650),
    //   mounted under the `/api/v1/assets` prefix.
    //   200 — the FULL updated asset (same schema as GET /assets/{id}): `status`
    //         has flipped out of `archived` to `ready`|`failed`, and exactly one
    //         `{ at, from: "archived", to: <status> }` entry is APPENDED to
    //         `statusHistory`. One `asset.restored` audit entry is emitted
    //         (src/routes/assets.ts:5677-5687).
    //   410 — { "error": "gone", "message": "asset has been purged" }
    //         (src/routes/assets.ts:5662) — the retention sweep tombstoned the
    //         document. Unrecoverable: no later retry can succeed.
    //   404 — { "error": "not_found" } (src/routes/assets.ts:5667) for BOTH an
    //         unknown id AND an asset that is not currently archived. The two
    //         causes are not machine-distinguishable
    //         (docs/findings/asset-restore-contract-888.md §3, gap G1), so the
    //         message below does not pretend to tell them apart.
    // The path param must be the ULID: unlike GET /:id, the restore handler does
    // NOT resolve a slug (it passes the raw param to repo.restore), so a slug
    // would 404. `asset.id` is the ULID even when this pane was opened by slug.
    // Re-render from the server after a state change, then report the outcome in
    // the freshly built #action-msg (the re-render replaces the old one). Shared
    // by the restore action (#889) and the lock actions (#895), both of which
    // must re-read rather than patch the view optimistically.
    var rerenderThenMsg = async function (text, kind) {
      try {
        await renderAssetDetailBody(id, bodyEl);
      } catch (_) {
        // The re-read itself failed (e.g. the asset is now a tombstone). The
        // renderer has already written its own error into bodyEl; don't mask it.
        return;
      }
      var host = bodyEl.querySelector('#action-msg') || bodyEl;
      showMsg(host, text, kind);
    };

    // ── Editorial review state + legal transitions (issue #901) ──
    //
    // Contract, fetched before this call was written (CLAUDE.md rule 7) and
    // cited in full in public/review-state.js:
    //   GET  /api/v1/assets/{id}/review-state — 200
    //        { reviewState, allowedTransitions } (both `required`), 404 { error }.
    //        (openapi.json .paths["/api/v1/assets/{id}/review-state"].get;
    //        src/routes/assets.ts:5437-5457, schema :223-241)
    //   POST /api/v1/assets/{id}/review-state — body REQUIRED
    //        { reviewState } (the only property); 200 = the full asset,
    //        404 { error }, 422 { error: 'invalid_review_transition', message }.
    //        (…].post; src/routes/assets.ts:5470-5484, 422 mapping :2663-2664)
    //
    // The block is mounted ABOVE "Delete protection" and renders its own badge
    // class, because the review axis is INDEPENDENT of the lifecycle `status`
    // shown in the KV grid above (src/data/asset-repo.ts:55-61) — the two must
    // not read as one control (#134). The transition buttons are built only from
    // the server's `allowedTransitions`, so an illegal move has no control to
    // originate from; the asset's own `reviewState` field is deliberately NOT
    // used to gate anything, since it carries the state but not the graph.
    //
    // Sub-resource paths take the ULID (`asset.id`), which this pane holds even
    // when it was opened by slug.
    await mountReviewState({
      assetId: asset.id,
      anchorEl: actionsDiv,
      host: body,
      canChange: canChangeReviewState(),
      apiFetch: apiFetch,
      showMsg: showMsg,
    });

    // ── External identifiers: upstream { namespace, id } correlations (issue #908) ──
    //
    // Contract, fetched before these calls were written (CLAUDE.md rule 7) and
    // cited in full in public/external-ids.js. `openapi.json .paths` carries
    // EXACTLY three operations for this sub-resource — checked key by key:
    //   GET  /api/v1/assets/{id}/external-ids — 200 is a bare ARRAY of
    //        { namespace, id } (both `required`, additionalProperties: false),
    //        "in persisted order … no dedup, sort, or reformatting"; 404 { error }
    //        only when the ASSET is unknown (an asset with none is 200 []).
    //        (…].get; src/routes/assets.ts:3315-3362)
    //   POST /api/v1/assets/{id}/external-ids — body REQUIRED
    //        { namespace (1..256), id (1..1024) }; 200 = the full asset,
    //        400 { error }, 404 { error }, 409 { error, reason:
    //        'external_id_conflict', namespace, externalId, conflictingAssetId }.
    //        (…].post; src/routes/assets.ts:3173-3209, schema :501-518, 409
    //        envelope :524-531 sent at :2696-2704)
    //   DELETE /api/v1/assets/{id}/external-ids/{namespace}/{externalId} — no
    //        body; 204 idempotently whether or not the pair was attached,
    //        400/404 { error }. (…].delete; src/routes/assets.ts:3247-3294)
    //
    // THERE IS NO PUT AND NO PATCH on either path, and POST cannot substitute for
    // one: it APPENDS to the set (src/data/asset-repo.ts:1546-1551) rather than
    // replacing within a namespace. So the panel's "edit" is POST-then-DELETE —
    // two requests, not atomic, add first so a failure between them leaves both
    // pairs rather than neither — and the edit form says so on screen. The remove
    // affordance exists only because DELETE does; nothing here is offered for a
    // method the spec does not declare.
    //
    // The panel must issue its own GET: `assetSchema` declares no
    // `externalIdentifiers` property (openapi.json .paths["/api/v1/assets/{id}"]
    // .get 200 schema, additionalProperties: false), which is precisely why the
    // sub-resource exists (src/routes/assets.ts:3293-3299). For the same reason the
    // POST's 200 asset body is NOT a read-back — the serializer strips the field —
    // so every write re-reads the sub-resource.
    //
    // Mounted between the review block and the action controls, and the
    // sub-resource path takes the ULID (`asset.id`) — GET/POST resolve with a
    // plain `repo.get` and no slug fallback (:3353, :3195).
    await mountAssetExternalIds({
      assetId: asset.id,
      anchorEl: actionsDiv,
      host: body,
      canChange: canChangeExternalIds(),
      apiFetch: apiFetch,
      confirmModal: confirmModal,
      showMsg: showMsg,
    });

    // ── Comments: add + read (issue #900) ──
    //
    // Contract, fetched before these calls were written (CLAUDE.md rule 7) and
    // cited in full in public/comments-panel.js. Note the real path: the issue
    // says `/comments`, but the comments collection is a SUB-RESOURCE of one
    // asset and no top-level `/comments` path exists.
    //   GET  /api/v1/assets/{id}/comments — 200 is a bare ARRAY of
    //        { id, assetId, body, createdAt } (all four `required`,
    //        additionalProperties false), 404 { error }. No query parameters at
    //        all, so the list is unpaged and the server's order — oldest first
    //        (listByAsset, src/data/comment-repo.ts:50-58) — is rendered as
    //        given. (openapi.json .paths["/api/v1/assets/{id}/comments"].get;
    //        src/routes/assets.ts:4798-4814)
    //   POST /api/v1/assets/{id}/comments — body REQUIRED and carries EXACTLY
    //        `body` (string, 1..4096 after trim); 201 = the created comment,
    //        404 { error }, plus an undeclared-but-real 400 from the body
    //        schema. (…].post; src/routes/assets.ts:4776-4793,
    //        commentBodySchema :1174-1176)
    //
    // Mounted directly below "Editorial review" and above the action row, with
    // the other editorial blocks: a comment is editorial commentary on the
    // asset, not a lifecycle operation.
    //
    // ADD + READ ONLY, and not as a scope decision to revisit: the path carries
    // only `post` and `get`, there is no `…/comments/{commentId}` path, and
    // `CommentRepository` declares only `create` + `listByAsset`
    // (src/data/comment-repo.ts:29-33). The panel also attributes no comment to
    // anyone, because `Comment` has no author field (:17-22) and the API has no
    // per-user identity to fill one with (src/auth/principal.ts:11-16).
    //
    // A successful add re-reads the sub-resource and rebuilds the block in
    // place — one request, no full detail re-render — because `id` and
    // `createdAt` are server-minted, so the returned list is the only truthful
    // one. The panel keeps its own in-memory draft per asset id so the detached
    // window's 5s self-poll cannot wipe a half-typed comment.
    //
    // Sub-resource paths take the ULID (`asset.id`): both handlers resolve the
    // parent with a plain `repo.get(request.params.id)` and no slug fallback
    // (src/routes/assets.ts:4786, :4807).
    await mountAssetComments({
      assetId: asset.id,
      anchorEl: actionsDiv,
      host: body,
      canAdd: canAddComment(),
      apiFetch: apiFetch,
      showMsg: showMsg,
      fmtDate: fmtDate,
    });

    // ── Export to a registered destination (issue #945) ──
    //
    // Contract, fetched before these calls were written (CLAUDE.md rule 7) and
    // cited in full in public/export-action.js:
    //   GET  /api/v1/export-destinations — no parameters; responses are exactly
    //        200 { destinations: [ { id, name, role, backend, bucket,
    //        accessKeyId, endpointUrl?, region?, publicBaseUrl?, pathTemplate?,
    //        hasSessionToken, deletable, createdAt, credentials } ] }
    //        (`destinationListSchema` / `destinationViewSchema`,
    //        src/routes/export-destinations.ts:125-127 / :95-123, handler :279-288)
    //        and 501 { error: 'not_configured' } (:236-239). The implicit
    //        OSC-managed default (id 'default') is ALWAYS in the 200 list
    //        (StorageBackendRegistry.list prepends defaultBackendView(),
    //        src/services/storage-backend-registry.ts:686-693), so "nothing is
    //        registered" is a list holding only that entry — which the module
    //        filters out, because the export call refuses it by name.
    //   POST /api/v1/assets/{id}/deliver — body REQUIRED, exactly
    //        { destination: string(1..256) }, additionalProperties: false
    //        (`deliverBodySchema`). Responses are exactly
    //        200 { assetId, status: 'delivered', destination: { id, name, role },
    //        bucket, objectKey, bytes, etag, deliveredAt }, 400 bad_request,
    //        404 not_found, 409 no_object | source_missing,
    //        422 backend_role | destination_unreachable | destination_unresolved
    //        | source_too_large, 501 not_configured, 502 delivery_failed,
    //        504 delivery_timeout. Re-verified after PR #1158 (issue #1131)
    //        merged, against openapi.json
    //        .paths["/api/v1/assets/{id}/deliver"].post as it now stands on main.
    //
    // The destination picker is built from the live 200 list and from nothing
    // else, so the submitted value is always an id the API just said it has.
    // When the list holds no usable destination, the block explains that plainly
    // instead of offering an empty picker and a submit button that could only
    // 400 (issue #945's third acceptance criterion).
    //
    // The success state may name the bucket and key because a 200 is
    // falsifiable: `status: 'delivered'` is sent only after the object was
    // re-read at the destination with the source's byte count. A 504 is reported
    // as an UNKNOWN outcome rather than as a failure, because the copy may still
    // complete store-side — the honesty rule this ticket's prerequisite
    // investigation (docs/findings/export-truthful-status-944.md) established
    // for the other export endpoint, applied here.
    //
    // The path takes the ULID (`asset.id`), which this pane holds even when it
    // was opened by slug.
    mountExportAction({
      assetId: asset.id,
      sourceName: asset.name,
      anchorEl: actionsDiv,
      host: body,
      canExport: canExportAsset(),
      apiFetch: apiFetch,
      wireCopyIds: wireCopyIdButtons,
    });

    // ── Delete protection: lock / unlock (issue #895) ──
    //
    // Contract, fetched before these calls were written (CLAUDE.md rule 7) and
    // cited in full in public/lock-detail.js:
    //   PUT  /api/v1/assets/{id}/lock — body REQUIRED ({} when empty), optional
    //        `reason` (<=1024) and `lockedBy` (<=256); 200 = the full asset,
    //        404 = { error }. (openapi.json .paths["/api/v1/assets/{id}/lock"].put;
    //        src/routes/assets.ts:5575-5601)
    //   DELETE /api/v1/assets/{id}/lock — no body, no query params; 200 = the
    //        full asset with `deleteLock` ABSENT, 404 = { error }.
    //        (…].delete; src/routes/assets.ts:5609-5623)
    // Both write paths re-render from the returned asset rather than patching
    // the view locally: that is the only way the UI learns the server-generated
    // `lockedAt`, and the only way a silently dropped body key becomes visible
    // (docs/ux/asset-lock-state-spec.md §4.4, gap H6).
    //
    // NOT implemented, because the contract does not support it: the issue's
    // "records the provenance entry format" criterion. The repo appends the
    // provenance entry itself — { at, by: 'user', op: 'lock'|'unlock',
    // detail: reason } (applyDeleteLock, src/data/asset-repo.ts:1076-1085) —
    // and nothing exposes it: `assetSchema` has no `provenance` property, so no
    // endpoint returns it, and neither lock handler emits an audit entry
    // (spec §9 gaps H4/H5). The client's only influence on it is the optional
    // `reason` it sends, which becomes `detail`. No history timeline is built
    // here and no copy claims one.
    //
    // The lock path takes the ULID (`asset.id`), which the detail pane holds
    // even when it was opened by slug.
    mountDeleteProtection({
      asset: asset,
      actionsRow: actionsDiv,
      // Lock sits first among the always-present actions because it gates the
      // destructive one: [Restore?] [Lock | Unlock] [Extract Metadata]
      // [Thumbnails] (spec §4.1).
      beforeEl: actionsDiv.querySelector('#btn-extract-meta'),
      canChange: canChangeDeleteLock(),
      fmtDate: fmtDate,
      apiFetch: apiFetch,
      openModal: openModal,
      confirmModal: confirmModal,
      showMsg: showMsg,
      messageHost: function () { return bodyEl.querySelector('#action-msg') || bodyEl; },
      onChanged: async function (updated, message) {
        // Keep the assets table's lock flag in step; harmless in the detached
        // detail window, which has no table.
        if (assetsTable) assetsTable.reload();
        await rerenderThenMsg(message, updated ? 'success' : 'error');
      },
    });

    // ── Rename: edit the asset's editorial title (issue #956) ──
    //
    // Contract, fetched before this call was written (CLAUDE.md rule 7) and
    // cited in full in public/asset-rename.js:
    //   PATCH /api/v1/assets/{id} — body carries EXACTLY `name`
    //        (`updateSchema.name = z.string().min(1).max(256).optional()`,
    //        src/routes/assets.ts:411, wired at :5532-5541); 200 = the full
    //        asset, 404 = { error }, 422 = { error } (the lifecycle state
    //        machine, which a name-only patch cannot trigger).
    // No API change is involved: this is the affordance for a field the route
    // already accepted and round-tripped.
    //
    // The rename is deliberately name-ONLY. `slug` is minted once at creation
    // (generateUniqueSlug, src/data/asset-repo.ts:1424) and neither update path
    // assigns it (InMemoryAssetRepository.update :1620-1701;
    // CouchAssetRepository.applyPatch, src/data/couch-asset-repo.ts:376-447 —
    // both copy the existing asset and assign only the keys the patch carries),
    // and object keys are derived from the ASSET ID, not the name
    // (sourceObjectKey, src/routes/asset-upload.ts:96-98). So id, slug and
    // stored files survive a rename untouched.
    //
    // The path param must be the ULID: PATCH /:id hands the raw param to
    // repo.update with no slug fallback, so a slug would 404. `asset.id` is the
    // ULID even when this pane was opened by slug.
    mountAssetRename({
      asset: asset,
      actionsRow: actionsDiv,
      // Sits after the lock control and before the pipeline actions:
      // [Restore?] [Lock | Unlock] [Rename] [Extract Metadata] [Thumbnails].
      beforeEl: actionsDiv.querySelector('#btn-extract-meta'),
      canChange: canRenameAsset(),
      apiFetch: apiFetch,
      openModal: openModal,
      showMsg: showMsg,
      messageHost: function () { return bodyEl.querySelector('#action-msg') || bodyEl; },
      onRenamed: async function (updated, message) {
        // The list and the search tier both project the same `name` field from
        // the live asset document, so one reload makes the new name appear in
        // whichever tier the table is currently showing. Harmless in the
        // detached detail window, which has no table.
        if (assetsTable) assetsTable.reload();
        // Re-read rather than patching the pane locally: the 200 carries the
        // full asset, and re-rendering from the server is the only way a
        // silently different stored value becomes visible.
        await rerenderThenMsg(message, updated ? 'success' : 'error');
      },
    });

    // ── Clip: cut an in/out window into a child asset (issue #793) ──
    //
    // Contract, fetched before this call was written (CLAUDE.md rule 7) and
    // cited in full in public/asset-clip.js:
    //   POST /api/v1/assets/{id}/clip — body REQUIRED, `startSeconds` +
    //        `endSeconds` (both numbers, `endSeconds > startSeconds` enforced by
    //        the schema's own refinement) and optional `outputName` (1..256);
    //        `additionalProperties: false`. 201 = the FULL child asset
    //        (`parentId` = this asset); 400 / 404 / 409 `no_object` / 501
    //        `not_configured` / 502 `clip_failed` are all { error, message? }.
    //        (openapi.json .paths["/api/v1/assets/{id}/clip"].post — the spec
    //        declares no operationId; clipBodySchema src/routes/assets.ts:734-746,
    //        handler app.post('/:id/clip') :5389-5464.)
    //
    // The in/out bound comes from the asset's OWN probed duration —
    // `technicalMetadata.durationSeconds` (technicalMetadataSchema,
    // src/routes/assets.ts:761-770), the same field the "Duration" row above
    // renders. The API does NOT bound the window itself, so this is a
    // client-side guard against asking for a window that cannot exist; when the
    // asset has no extracted metadata the dialog says the check could not be
    // made rather than inventing a limit.
    //
    // A 502 is reported as an outright failure. The pipeline only advances the
    // child to `ready` after VERIFYING the written object exists and is
    // non-empty, and marks it `failed` otherwise (src/pipeline/clip.ts:166-209,
    // the issue #786 honesty fix) — so a failed clip must never be reported as
    // a usable one, and even on a 201 the child's own `status` is read back
    // rather than assumed.
    //
    // The path takes the ULID (`asset.id`), which this pane holds even when it
    // was opened by slug: the handler passes the raw param to `repo.get` with no
    // slug fallback.
    mountAssetClip({
      asset: asset,
      actionsRow: actionsDiv,
      // Sits with the other produce-something actions:
      // [Restore?] [Lock | Unlock] [Rename] [Clip] [Extract Metadata] [Thumbnails].
      beforeEl: actionsDiv.querySelector('#btn-extract-meta'),
      canChange: canClipAsset(),
      apiFetch: apiFetch,
      openModal: openModal,
      messageHost: function () { return bodyEl.querySelector('#action-msg') || bodyEl; },
      // Where "Open clip" goes. In the main window it swaps this side panel
      // over to the child asset (the same move the job → asset link makes); in
      // the detached detail window there is no panel, so the anchor's own href
      // — a standalone detail URL for the child — carries the navigation.
      openAsset: function (childId) {
        const panel = document.getElementById('asset-detail');
        if (!panel) {
          window.location.href = detailWindowUrl('asset', childId);
          return;
        }
        switchTab('assets');
        showAssetDetail(childId, panel);
      },
      assetHref: function (childId) { return detailWindowUrl('asset', childId); },
      // The standalone detail window (detail.html, `body.detail-standalone`)
      // re-renders this whole body every DETAIL_POLL_INTERVAL_MS, which would
      // throw the outcome link away a few seconds after it appeared. There, the
      // clip is followed as soon as it is ready; in the main window the side
      // panel is not polled, so the link stays put until the operator uses it.
      navigateOnSuccess: document.body.classList.contains('detail-standalone'),
      onClipped: function () {
        // A successful clip adds an asset to the list; a failed one adds a
        // `failed` child record. Either way the table is now stale. Harmless in
        // the detached detail window, which has no table.
        if (assetsTable) assetsTable.reload();
      },
    });

    var restoreBtn = body.querySelector('#btn-restore-asset');
    if (restoreBtn) {
      // Latched once a 410 proves the asset is permanently unrecoverable (issue
      // #933). The control is removed from the DOM at that point, so this only
      // catches a dispatch from a reference that outlived it (a queued event, a
      // stored handle) — but a second POST for a tombstone can only ever earn a
      // second 410, so it must not be sent.
      var restoreRetired = false;
      restoreBtn.addEventListener('click', async function () {
        if (restoreRetired) return;
        actionMsg.innerHTML = '';
        var prevLabel = restoreBtn.textContent;
        restoreBtn.disabled = true;
        restoreBtn.textContent = 'Restoring…';
        try {
          var restored = await apiFetch(
            '/assets/' + encodeURIComponent(asset.id) + '/restore',
            { method: 'POST' }
          );
          // Keep the assets table in step with the lifecycle change; harmless in
          // the detached detail window, which has no table.
          if (assetsTable) assetsTable.reload();
          // Re-render so the status badge AND the appended `archived -> …`
          // statusHistory row both come from a fresh read of the asset.
          await rerenderThenMsg(
            'Restored — status is now “' + ((restored && restored.status) || 'unknown') + '”.',
            'success'
          );
          return;
        } catch (err) {
          if (isPurgedGone(err)) {
            // Terminal, and presented as such (issue #933): the document is a
            // tombstone, so this is not a failure to retry but a permanent fact
            // about the asset. Routed through the shared unrecoverable notice
            // instead of the red `.msg-error` box every transient failure uses,
            // and rendered PERSISTENTLY (showMsg auto-dismisses after 6s, which
            // would quietly erase the one outcome that never changes).
            //
            // The Restore control and its explanatory note are REMOVED, not
            // disabled: a greyed-out "Restore unavailable" button reads as "not
            // right now", and the note still promised a revival that can no
            // longer happen. With no control left there is no retry affordance
            // to mistake for one. See isPurgedGone/renderPurgedUnrecoverable
            // (app.js) for the 410 contract citations.
            restoreRetired = true;
            renderPurgedUnrecoverable(actionMsg, {
              id: 'restore-gone-notice',
              subject: quotedOrEmpty(asset.name, asset.slug, asset.id),
              serverMessage: err.message,
              retire: [restoreBtn, body.querySelector('#restore-note')],
            });
            if (assetsTable) assetsTable.reload();
            return;
          }
          if (err && err.status === 404) {
            // Either the id is unknown or the asset is no longer archived; the
            // API returns the same body for both (gap G1). Re-read and let the
            // refreshed view show whichever it is.
            await rerenderThenMsg(
              'Restore failed (404 not_found): the API reports nothing to restore — ' +
                'either this asset is no longer archived, or the id is unknown. ' +
                'The view has been re-read from the API.',
              'error'
            );
            return;
          }
          // Anything else (401/403 from the auth gate, transport failure, 5xx):
          // report the server's own message via the shared error pattern.
          showMsg(actionMsg, 'Restore failed: ' + err.message, 'error');
        } finally {
          // Only revive the control if this render is still on screen and the
          // button was not deliberately retired by the 410 path above.
          if (body.querySelector('#btn-restore-asset') === restoreBtn && restoreBtn.textContent === 'Restoring…') {
            restoreBtn.disabled = false;
            restoreBtn.textContent = prevLabel;
          }
        }
      });
    }

    body.querySelector('#btn-extract-meta').addEventListener('click', async function() {
      actionMsg.innerHTML = '';
      var extractBtn = body.querySelector('#btn-extract-meta');
      var prevLabel = extractBtn.textContent;
      extractBtn.disabled = true;
      extractBtn.textContent = wedgedDetail ? 'Re-driving…' : 'Extracting…';
      try {
        const r = await apiFetch('/assets/' + encodeURIComponent(id) + '/extract-metadata', { method: 'POST', body: JSON.stringify({}) });
        const pre = document.createElement('pre');
        pre.className = 'code-block mt8';
        pre.textContent = JSON.stringify(r, null, 2);
        // The re-drive path returns the settled status (200 { assetId, status });
        // report it so the operator sees processing -> ready (or a persistent
        // failure). Then re-render the detail so the status badge / wedged flag
        // reflect the change.
        if (wedgedDetail && r && r.status) {
          showMsg(actionMsg, 'Re-drive complete — status is now "' + r.status + '".', r.status === 'ready' ? 'success' : 'info');
        } else {
          showMsg(actionMsg, 'Metadata extraction complete.', 'success');
        }
        actionMsg.appendChild(pre);
        if (wedgedDetail) {
          await renderAssetDetailBody(id, bodyEl);
          return;
        }
      } catch (err) {
        showMsg(actionMsg, 'Error: ' + err.message, 'error');
      } finally {
        if (body.querySelector('#btn-extract-meta') === extractBtn) {
          extractBtn.disabled = false;
          extractBtn.textContent = prevLabel;
        }
      }
    });

    body.querySelector('#btn-thumbnails').addEventListener('click', async function() {
      actionMsg.innerHTML = '';
      thumbArea.innerHTML = '';
      // First fetch existing thumbnails; if none, extract at 0s, 25%, 50%, 75%
      try {
        var existing = await apiFetch('/assets/' + encodeURIComponent(id) + '/thumbnails');
        var existingThumbs = existing && existing.thumbnails ? existing.thumbnails : [];
        if (existingThumbs.length) {
          renderThumbnailStrip(thumbArea, id, existingThumbs.length);
          return;
        }
        // Extract using duration from technicalMetadata if available
        var dur = asset.technicalMetadata && asset.technicalMetadata.durationSeconds
          ? asset.technicalMetadata.durationSeconds : 10;
        var timecodes = [0, Math.round(dur * 0.25), Math.round(dur * 0.5), Math.round(dur * 0.75)];
        showMsg(actionMsg, 'Extracting thumbnails…', 'info');
        var r = await apiFetch('/assets/' + encodeURIComponent(id) + '/thumbnails',
          { method: 'POST', body: JSON.stringify({ timecodes: timecodes }) });
        actionMsg.innerHTML = '';
        // POST returns the object keys it just stored, and the runner replaces the
        // asset's whole `thumbnails` array with exactly that list
        // (src/pipeline/thumbnail.ts:164), so position i here is position i on the
        // asset — the index the presigned-URL route is keyed by.
        var extracted = r && r.thumbnails ? r.thumbnails : [];
        if (extracted.length) {
          renderThumbnailStrip(thumbArea, id, extracted.length);
        } else {
          showMsg(actionMsg, 'Thumbnails extracted.', 'success');
        }
      } catch (err) {
        showMsg(actionMsg, 'Error: ' + err.message, 'error');
      }
    });

    // Render `count` thumbnails for `assetId`, addressed by their position in the
    // asset's `thumbnails` array — the key both the listing route and the
    // presigned-URL route use (see public/thumbnail-url.js for the contract).
    //
    // The <img> elements are created up front, in order, but WITHOUT a src: the
    // API's thumbnail byte route sits behind the bearer gate and a browser's
    // <img> GET sends no Authorization header (issue #801). Each src is then
    // filled in from the presigned-URL endpoint over the authenticated apiFetch,
    // so the browser's GET to storage carries the signature in the URL itself.
    // Creating the elements first keeps the strip in index order regardless of
    // which signature is issued first; one whose URL cannot be issued falls back
    // to the authenticated byte route's bytes, and one that neither source can
    // resolve is dropped rather than left as a broken-image icon.
    function renderThumbnailStrip(container, assetId, count) {
      if (!count) return;
      var strip = document.createElement('div');
      strip.className = 'thumbnails';
      // The "Thumbnails" heading is added by the FIRST image that actually
      // resolves, not up front: an image that cannot be resolved removes itself,
      // so a heading written in advance can end up labelling an empty strip.
      var titleEl = document.createElement('div');
      titleEl.className = 'section-title mt12';
      titleEl.textContent = 'Thumbnails';
      function showTitle() {
        if (titleEl.parentNode) return;
        if (strip.parentNode === container) container.insertBefore(titleEl, strip);
        else container.appendChild(titleEl);
      }
      for (var i = 0; i < count; i++) {
        var img = document.createElement('img');
        img.alt = 'thumbnail';
        strip.appendChild(img);
        applyThumbnail(img, {
          apiFetch: apiFetch,
          assetId: assetId,
          index: i,
          onSuccess: showTitle,
          onFailure: (function(el) {
            return function() { el.remove(); };
          })(img)
        });
      }
      container.appendChild(strip);
    }

    return asset;
  } catch (err) {
    body.innerHTML = '';
    showMsg(body, 'Failed to load asset: ' + err.message, 'error');
    throw err;
  }
  }
}

// ─── JOBS TAB ────────────────────────────────────────────────────────────────
//
// The jobs table is composed from the shared ops-UI table primitive
// (public/ops-ui-table.js) + the URL-state contract (public/table-url-state.js)
// via public/jobs-table.js. app.js only owns the surrounding tab chrome (header,
// detail side panel, watch-folder footer, poll timer) and injects its fetch +
// formatting helpers into the table. Sort/filter/pagination/URL-state all live
// in the shared primitives — none of it is reinvented here (issue #370).

let jobsPollTimer = null;
// The live jobs-table instance for the current tab render (used by the poll
// timer and the in-panel cancel refresh).
let jobsTableInstance = null;

async function renderJobsTab(container) {
  // Layout: full-height table on the left, detail side panel on the right (hidden initially).
  const layout = document.createElement('div');
  layout.className = 'assets-layout';
  container.appendChild(layout);

  // ── Main (table) column ──
  const main = document.createElement('div');
  main.className = 'assets-main';
  layout.appendChild(main);

  const header = document.createElement('div');
  header.className = 'assets-main-header';
  header.innerHTML = [
    '<span class="section-title">Jobs</span>',
    '<div class="flex-gap">',
    '  <button id="jobs-refresh" class="btn-ghost" style="font-size:12px;padding:6px 12px;">Refresh</button>',
    '</div>',
  ].join('');
  main.appendChild(header);

  // ── Side detail panel (created on demand) ──
  const detailPanel = document.createElement('div');
  detailPanel.id = 'job-detail';
  detailPanel.className = 'assets-side';
  detailPanel.style.display = 'none';
  layout.appendChild(detailPanel);

  // ── Jobs table (shared primitive + URL-state contract) ──
  // The table owns sort/filter/pagination + URL sync; app.js injects the fetch
  // helper and the formatters, plus row-select and cancel callbacks that reuse
  // the existing detail panel and the existing DELETE /jobs/:id path.
  const jobsTable = createJobsTable({
    apiFetch,
    fmtDate,
    renderBadge,
    onSelect: function(jobId) {
      showJobDetail(jobId, detailPanel);
    },
    onCancel: function(jobId) {
      return apiFetch('/jobs/' + encodeURIComponent(jobId), { method: 'DELETE' }).then(function() {
        if (jobId && detailPanel.style.display !== 'none') showJobDetail(jobId, detailPanel);
      });
    },
    // A failed cancel from the table's own row button (issue #920). Reported
    // with the same primitive, and the same copy, as the cancel button inside
    // the detail panel, so one failure does not read two ways.
    onCancelError: function(err, jobId) {
      reportActionFailure(err, {
        action: 'Cancel job',
        detail: jobId ? 'Job ' + jobId + ' is unchanged.' : undefined,
      });
    },
  });
  jobsTableInstance = jobsTable;
  main.appendChild(jobsTable.el);

  header.querySelector('#jobs-refresh').addEventListener('click', function() {
    jobsTable.refresh();
  });

  // ── Background service status (watch folder) — compact footer in the main column ──
  const statusSection = document.createElement('div');
  statusSection.style.cssText = 'padding:8px 12px;border-top:1px solid var(--border,#333);font-size:13px;';
  const adminWrap = document.createElement('div');
  const adminLoader = loadingEl();
  adminWrap.appendChild(adminLoader);
  statusSection.appendChild(adminWrap);
  main.appendChild(statusSection);

  async function refreshWatchFolderStatus() {
    try {
      const status = await apiFetch('/admin/watch-folder/status');
      adminLoader.remove();
      adminWrap.innerHTML = '';

      const row = document.createElement('div');
      row.className = 'form-row';
      row.style.alignItems = 'center';

      const info = document.createElement('span');
      info.style.flex = '1';
      info.innerHTML =
        '<strong>Watch folder:</strong> ' +
        (status.enabled ? (status.running ? '🟢 running' : '🔴 stopped') : '⚪ not configured') +
        ' &nbsp;|&nbsp; processed: <strong>' + escHtml(String(status.processedCount)) + '</strong>';
      row.appendChild(info);

      if (status.enabled) {
        const btn = document.createElement('button');
        btn.className = 'btn-sm';
        btn.textContent = status.running ? 'Stop' : 'Start';
        btn.addEventListener('click', async function() {
          btn.disabled = true;
          try {
            await apiFetch('/admin/watch-folder/' + (status.running ? 'stop' : 'start'), { method: 'POST' });
            await refreshWatchFolderStatus();
          } catch (err) {
            showMsg(adminWrap, 'Error: ' + err.message, 'error');
            btn.disabled = false;
          }
        });
        row.appendChild(btn);
      }
      adminWrap.appendChild(row);
    } catch (err) {
      adminLoader.remove();
      showMsg(adminWrap, 'Failed: ' + err.message, 'error');
    }
  }
  refreshWatchFolderStatus();

  await jobsTable.refresh();

  // Auto-refresh the table (only the table, not the whole tab) every 5s. The
  // table re-fetches its bounded working window and re-applies the current
  // sort/filter/page client-side; `silent` avoids the loading flash.
  if (jobsPollTimer) clearInterval(jobsPollTimer);
  jobsPollTimer = setInterval(function() {
    if (jobsTable.el.isConnected) {
      jobsTable.refresh(true);
    } else {
      clearInterval(jobsPollTimer);
      jobsPollTimer = null;
    }
  }, DETAIL_POLL_INTERVAL_MS);
}

async function showJobDetail(id, detailPanel) {
  detailPanel.style.display = 'flex';
  detailPanel.innerHTML = [
    '<div class="detail-panel-header">',
    '  <h3>Job Detail</h3>',
    '  <div class="detail-panel-actions">',
    '    <button id="popout-job-detail" class="side-close-btn" aria-label="Open in new window" title="Open in new window">⧉</button>',
    '    <button id="close-job-detail" class="side-close-btn" aria-label="Close">×</button>',
    '  </div>',
    '</div>',
    '<div class="detail-panel-body" id="job-detail-body"></div>',
  ].join('');

  detailPanel.querySelector('#close-job-detail').addEventListener('click', function() {
    detailPanel.style.display = 'none';
    detailPanel.innerHTML = '';
    if (jobsTableInstance) jobsTableInstance.setSelected(null);
    if (jobsTableInstance && jobsTableInstance.el) {
      jobsTableInstance.el.querySelectorAll('tbody tr').forEach(function(r) { r.classList.remove('row-selected'); });
    }
  });

  detailPanel.querySelector('#popout-job-detail').addEventListener('click', function() {
    openDetailWindow('job', id);
  });

  const body = detailPanel.querySelector('#job-detail-body');
  // Embedded context: wire the asset-link navigation and cancel-refresh to the
  // main-window tab UI. In standalone mode these opts are omitted (see detail.js).
  await renderJobDetailBody(id, body, {
    onAssetLink: function(assetId) {
      switchTab('assets');
      const panel = document.getElementById('asset-detail');
      if (panel) showAssetDetail(assetId, panel);
    },
    afterCancel: function() {
      showJobDetail(id, detailPanel);
      if (jobsTableInstance) jobsTableInstance.refresh();
    },
  });
}

// Populate a job detail view into `bodyEl` from a freshly-fetched job.
// Reusable in the embedded side panel and the standalone detached window.
// `opts.onAssetLink(assetId)` handles the asset link click (embedded only);
// `opts.afterCancel()` runs after a successful in-panel cancel (embedded only).
// Clears `bodyEl` first so it is safe to call repeatedly (self-poll). Returns
// the fetched job (or throws if the fetch fails / 404s).
//
// CONTRACT: GET /api/v1/jobs/{id} — `jobSchema`, src/routes/jobs.ts:50-145
// (openapi.json:15658, path key "/api/v1/jobs/{id}", method `get`; the spec
// assigns this operation no operationId). Per-field grounding is inline at each
// row below; the encode-attempt fields (`encodeAttempts`, `encodeAttemptLog`)
// are grounded in public/job-attempts.js's header.
//
// Issue #963 shape: the panel LEADS with curated fields, then the encode-attempt
// history (only when the job was actually retried), and ends with the full
// record behind a collapsed "Raw" disclosure — it no longer dumps
// JSON.stringify(job) as the primary surface.
async function renderJobDetailBody(id, bodyEl, opts) {
  opts = opts || {};
  const body = bodyEl;
  // Read the raw-disclosure state BEFORE the container is cleared. The detached
  // window re-renders this body every DETAIL_POLL_INTERVAL_MS (public/detail.js
  // tick()), so without carrying the operator's own expansion across the
  // re-render the raw record would slam shut under them every 5 seconds.
  const rawWasOpen = rawDisclosureOpen(body);
  body.innerHTML = '';
  const loader = loadingEl();
  body.appendChild(loader);

  {
    try {
    const job = await apiFetch('/jobs/' + encodeURIComponent(id));
    loader.remove();

    const kvRows = [
      ['ID', '<span class="text-mono">' + escHtml(job.id) + '</span>'],
      ['Type', escHtml(job.type || '—')],
      ['Status', renderBadge(job.status)],
    ];
    // Asset row (issue #988): GET /api/v1/jobs/:id now resolves `assetName`
    // (OPTIONAL on the wire — src/routes/jobs.ts:62; absent when the asset has
    // been deleted), so the link reads as the asset's name when there is one.
    // The ULID stays on screen either way: it is the value every asset-id
    // endpoint accepts, and it is what a deleted asset degrades to.
    if (job.assetId) {
      const assetLinkHtml =
        '<a href="#" class="job-asset-link' + (job.assetName ? '' : ' text-mono') +
        '" data-asset-id="' + escHtml(job.assetId) + '" style="color:var(--accent)">' +
        escHtml(job.assetName || job.assetId) + '</a>';
      kvRows.push(['Asset',
        job.assetName
          ? assetLinkHtml + ' <span class="text-mono job-asset-id-inline">' + escHtml(job.assetId) + '</span>'
          : assetLinkHtml]);
    } else {
      kvRows.push(['Asset', '<span class="text-mono">—</span>']);
    }
    if (job.profile) kvRows.push(['Profile', escHtml(job.profile)]);
    if (job.progress != null) kvRows.push(['Progress', escHtml(job.progress + '%')]);
    // Bytes pulled, for a URL-pull ingest job (issue #963). `bytesTransferred`
    // is a REQUIRED number on the job (src/routes/jobs.ts:72; present in the
    // GET 200 `required` list, openapi.json:15802-15813) and `totalBytes` is
    // OPTIONAL (src/routes/jobs.ts:73) — absent when the source served no
    // content-length, which is why the "of N" half is conditional. Shown only
    // for the job type that transfers bytes: `type` is
    // 'ingest-url' | 'transcode' | 'package' (src/routes/jobs.ts:52 ->
    // JOB_TYPES, src/data/job-repo.ts:84).
    if (job.type === 'ingest-url' && job.bytesTransferred != null) {
      kvRows.push(['Transferred',
        escHtml(fmtBytes(job.bytesTransferred)) +
          (job.totalBytes != null
            ? ' <span class="text-muted">of ' + escHtml(fmtBytes(job.totalBytes)) + '</span>'
            : '')]);
    }
    kvRows.push(['Created', escHtml(fmtDate(job.createdAt))]);
    kvRows.push(['Updated', escHtml(fmtDate(job.updatedAt))]);
    if (job.error) {
      kvRows.push(['Error', '<span style="color:var(--error,#f87171)">' + escHtml(job.error) + '</span>']);
    }
    // Encore job id (issue #963). This is the handle the transcode job's
    // completion signal is correlated by — it is what an operator greps for in
    // the Encore instance's own logs — so it must be on screen and copyable,
    // not buried in the raw record. OPTIONAL on the wire and present only for
    // transcode jobs (src/routes/jobs.ts:80-81; openapi.json:15725, absent from
    // the GET 200 `required` list at openapi.json:15802-15813), so the row is
    // conditional. Rendered through the shared click-to-copy control
    // (public/copy-id.js via copyableFieldHtml) rather than a hover tooltip:
    // the value IS the visible text, and the button carries the aria-live
    // feedback.
    if (job.encoreJobId) {
      kvRows.push(['Encore Job ID',
        copyableFieldHtml(job.encoreJobId, 'Copy Encore job id')]);
    }
    if (job.encoreInstanceId) {
      // Placeholder value; resolved to a link (or plain text) after render once
      // the scaler status is fetched.
      kvRows.push(['Encore Instance',
        '<span id="job-encore-instance" class="text-mono">' + escHtml(job.encoreInstanceId) + '</span>']);
    }

    const kvDiv = document.createElement('div');
    kvDiv.className = 'kv-grid';
    kvDiv.innerHTML = kvRows.map(function(r) {
      return '<span class="kv-key">' + r[0] + '</span><span class="kv-val">' + r[1] + '</span>';
    }).join('');
    body.appendChild(kvDiv);
    // Bind the click-to-copy control(s) in the field list (currently the Encore
    // job id). Idempotent, so a re-render on the poll tick re-binds safely.
    wireCopyableFields(kvDiv);

    // Encode-attempt history (issue #963). Renders NOTHING when the job was
    // dispatched once: a single-attempt job has no history to compare and must
    // not get an empty section. When it was retried, the timeline is how a
    // rescued run (classified failure + backoff + a later success) is told apart
    // from a plain slow success without reading JSON.
    const attemptHistory = renderAttemptHistory(job, { fmtDate: fmtDate });
    if (attemptHistory) body.appendChild(attemptHistory);

    // Resolve the Encore instance to a clickable link via the scaler status.
    if (job.encoreInstanceId) {
      apiFetch('/scaler/status').then(function(status) {
        var match = null;
        (status && status.workspaces ? status.workspaces : []).some(function(ws) {
          var found = (ws.instances || []).filter(function(inst) {
            return inst.instanceId === job.encoreInstanceId;
          })[0];
          if (found) { match = found; return true; }
          return false;
        });
        var span = body.querySelector('#job-encore-instance');
        if (match && match.url && span) {
          var link = document.createElement('a');
          link.href = match.url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.className = 'text-mono';
          link.style.color = 'var(--accent)';
          link.textContent = job.encoreInstanceId;
          span.replaceWith(link);
        }
      }).catch(function() { /* leave plain-text instanceId on error */ });
    }

    // Clicking the asset link jumps to the Assets tab and opens that asset.
    // Only wired when the caller supplies onAssetLink (embedded main-window
    // context). In standalone mode the link stays inert (no tab UI to switch to).
    const assetLink = body.querySelector('.job-asset-link');
    if (assetLink && typeof opts.onAssetLink === 'function') {
      assetLink.addEventListener('click', function(e) {
        e.preventDefault();
        opts.onAssetLink(assetLink.dataset.assetId);
      });
    }

    // Transcode pipeline visualization. For transcode jobs, prefer showing the
    // PipelineExecution steps (which reflect the actual pipeline that was run).
    // Fall back to the legacy static diagram only if no execution is found.
    if (job && job.type === 'transcode') {
      let asset = null;
      let executions = [];
      if (job.assetId) {
        try {
          asset = await apiFetch('/assets/' + encodeURIComponent(job.assetId));
        } catch (_) { /* asset may be gone */ }
        try {
          executions = await apiFetch('/assets/' + encodeURIComponent(job.assetId) + '/executions');
        } catch (_) { /* executions endpoint may not be available */ }
      }
      // Find the execution whose transcode step matches this job id.
      var matchedExec = executions.find(function(ex) {
        return ex.steps && ex.steps.some(function(s) { return s.jobId === job.id; });
      });
      const pipelineTitle = document.createElement('div');
      pipelineTitle.className = 'section-title mt12';
      pipelineTitle.textContent = 'Pipeline';
      body.appendChild(pipelineTitle);
      if (matchedExec) {
        // Use renderExecutions-style: map PipelineExecution steps to pipeline nodes.
        var STATUS_MAP = { pending: 'pending', running: 'running', done: 'completed', failed: 'failed' };
        var nodes = [{ label: 'Upload', status: 'completed' }].concat(
          matchedExec.steps.map(function(s) {
            var detail;
            if (s.name === 'transcode' && s.status === 'running' && job.progress != null) detail = job.progress + '%';
            return { label: s.name, status: STATUS_MAP[s.status] || s.status, detail: detail };
          })
        );
        body.appendChild(renderPipeline(nodes));
      } else {
        body.appendChild(renderPipeline(buildTranscodePipeline(job, asset)));
      }
    }

    // Cancel button in the panel for running/pending jobs.
    if (job.status === 'running' || job.status === 'pending') {
      const actions = document.createElement('div');
      actions.className = 'mt12';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn-danger';
      cancelBtn.textContent = 'Cancel job';
      cancelBtn.addEventListener('click', async function() {
        cancelBtn.disabled = true;
        try {
          await apiFetch('/jobs/' + encodeURIComponent(job.id), { method: 'DELETE' });
          if (typeof opts.afterCancel === 'function') opts.afterCancel();
        } catch (err) {
          cancelBtn.disabled = false;
          reportActionFailure(err, {
            action: 'Cancel job',
            detail: 'Job ' + job.id + ' is unchanged.',
          });
        }
      });
      actions.appendChild(cancelBtn);
      body.appendChild(actions);
    }

    // The full server record, kept but demoted (issue #963). It is the only
    // view guaranteed complete when the API grows a field this panel does not
    // render yet, so it stays — behind a disclosure, COLLAPSED by default, so
    // the curated fields above are what the panel leads with. `rawWasOpen`
    // carries an operator's own expansion across the detached window's poll
    // re-render.
    body.appendChild(createRawDisclosure(job, {
      label: 'Raw job JSON',
      open: rawWasOpen,
      className: 'mt12',
    }));
    return job;
  } catch (err) {
    body.innerHTML = '';
    showMsg(body, 'Failed to load job: ' + err.message, 'error');
    throw err;
  }
  }
}

// ─── PIPELINE EXECUTION DETAIL ────────────────────────────────────────────────

// Marker class on the collapsed "Raw" disclosure (issue #964). One constant so
// the open-state preservation below, the CSS, and the DOM test all name the
// same element instead of restating the string.
const RAW_DISCLOSURE_CLASS = 'raw-disclosure';

// A collapsed-by-default disclosure holding the pretty-printed raw document.
// The curated view above it is the primary reading surface; the full object
// stays one click away rather than being the first thing an operator sees
// (issue #964).
//
// ACCESSIBILITY: native <details>/<summary> — keyboard-operable and exposed as
// a disclosure to assistive tech with no ARIA of our own, matching the existing
// disclosure idiom in renderCollectionAssetPicker(). The value is written with
// textContent, never interpolated into an HTML string.
//
// @param {unknown} value   object to serialise
// @param {boolean} [open]  restore a previously-expanded state (poll re-render)
// @returns {HTMLElement} detached <details>
function rawJsonDisclosure(value, open) {
  const details = document.createElement('details');
  details.className = RAW_DISCLOSURE_CLASS + ' mt12';
  if (open) details.open = true;

  const summary = document.createElement('summary');
  summary.textContent = 'Raw';
  details.appendChild(summary);

  const pre = document.createElement('pre');
  pre.className = 'code-block';
  pre.textContent = JSON.stringify(value, null, 2);
  details.appendChild(pre);

  return details;
}

// Fetch and render a single PipelineExecution (issue #193) into `bodyEl`.
// Contract: GET /api/v1/pipelines/:executionId — response `pipelineExecutionSchema`
// in src/routes/pipelines.ts:32-41 (id, assetId, assetName?, pipelineName,
// status [running|done|failed], steps[], createdAt, updatedAt), mirrored in
// openapi.json .paths["/api/v1/pipelines/{executionId}"].get 200. Each step, per
// `stepExecutionSchema` (src/routes/pipelines.ts:17-30): name, status
// [pending|running|done|failed|skipped], jobId?, encoreJobId?, error?,
// skipReason?, startedAt?, completedAt?, progress? — only `name` and `status`
// are required, so every other cell tolerates an absent value.
//
// The steps render as a per-step timeline (issue #964): one row per step with
// its job id, Encore job id, and start/completion timestamps, each
// identifier click-to-copy via the shared copy-id control. The full execution
// document is still here, behind the collapsed "Raw" disclosure at the bottom.
//
// All server-provided text is inserted via escHtml before interpolation. Returns
// the fetched execution so callers (detail.js) can derive the window title and
// decide whether to keep polling.
async function renderPipelineDetailBody(id, bodyEl) {
  const body = bodyEl;
  // detail.js tick() re-renders this body on every poll while the execution is
  // running. Carry the operator's Raw disclosure state across that refresh so a
  // poll does not snap an expanded dump shut under them.
  const prevRaw = typeof body.querySelector === 'function'
    ? body.querySelector('.' + RAW_DISCLOSURE_CLASS)
    : null;
  const rawWasOpen = !!(prevRaw && prevRaw.open);
  body.innerHTML = '';
  const loader = loadingEl();
  body.appendChild(loader);

  try {
    const exec = await apiFetch('/pipelines/' + encodeURIComponent(id));
    loader.remove();

    // Colour helper mirroring renderExecutions()'s per-status colouring.
    const stepColor = function(status) {
      return { running: 'var(--accent,#60a5fa)', pending: 'var(--text-muted,#9ca3af)', done: 'var(--success,#4ade80)', failed: 'var(--error,#f87171)' }[status] || '';
    };

    const kvRows = [
      ['ID', '<span class="text-mono">' + escHtml(exec.id) + '</span>'],
      ['Pipeline', escHtml(exec.pipelineName || '—')],
      ['Status', renderBadge(exec.status)],
    ];
    if (exec.assetId) {
      kvRows.push(['Asset', '<span class="text-mono">' + escHtml(exec.assetName || exec.assetId) + '</span>']);
    }
    kvRows.push(['Created', escHtml(fmtDate(exec.createdAt))]);
    kvRows.push(['Updated', escHtml(fmtDate(exec.updatedAt))]);

    const kvDiv = document.createElement('div');
    kvDiv.className = 'kv-grid';
    kvDiv.innerHTML = kvRows.map(function(r) {
      return '<span class="kv-key">' + r[0] + '</span><span class="kv-val">' + r[1] + '</span>';
    }).join('');
    body.appendChild(kvDiv);

    // Per-step timeline: status, progress, both job identifiers, timestamps, and
    // the FULL error text for failed steps (inline, not tooltip-only). All
    // fields escaped via escHtml.
    const stepsTitle = document.createElement('div');
    stepsTitle.className = 'section-title mt12';
    stepsTitle.textContent = 'Steps';
    body.appendChild(stepsTitle);

    const steps = Array.isArray(exec.steps) ? exec.steps : [];
    if (steps.length === 0) {
      const none = document.createElement('div');
      none.className = 'text-muted';
      none.textContent = 'No steps.';
      body.appendChild(none);
    } else {
      const rows = steps.map(function(s) {
        const cells = [];
        cells.push('<td>' + escHtml(s.name) + '</td>');
        // Status is never colour-ALONE: the word itself is the status (WCAG 1.4.1).
        cells.push('<td><span style="color:' + stepColor(s.status) + '">' + escHtml(s.status) + '</span></td>');
        cells.push('<td>' + (s.progress != null ? escHtml(s.progress + '%') : '—') + '</td>');
        // Both identifiers are click-to-copy via the shared control (copy-id.js):
        // tracing a run means pasting these into GET /jobs/{id} or the
        // transcoder's own API, and neither should have to be retyped. Both are
        // optional in stepExecutionSchema — copyableIdCellHtml() renders the
        // em-dash placeholder when the step has not reached that stage. The
        // column label mirrors the contract field name (`encoreJobId`) and the
        // "Encore Instance" row the job detail already shows.
        cells.push('<td>' + copyableIdCellHtml(s.jobId, 'Copy job id for step ' + s.name) + '</td>');
        cells.push('<td>' + copyableIdCellHtml(s.encoreJobId, 'Copy Encore job id for step ' + s.name) + '</td>');
        cells.push('<td>' + escHtml(fmtDate(s.startedAt)) + '</td>');
        cells.push('<td>' + escHtml(fmtDate(s.completedAt)) + '</td>');
        var row = '<tr class="step-row">' + cells.join('') + '</tr>';
        // Full error text on its own spanning row so long strings wrap and are
        // fully visible (acceptance criterion: not tooltip-only).
        if (s.error) {
          row += '<tr class="step-error-row"><td colspan="7" style="color:var(--error,#f87171);white-space:pre-wrap;word-break:break-word;">' + escHtml(s.error) + '</td></tr>';
        }
        return row;
      }).join('');

      const table = document.createElement('table');
      table.className = 'mini-table';
      table.id = 'pipeline-step-timeline';
      table.innerHTML =
        '<thead><tr>' +
        '<th>Step</th><th>Status</th><th>Progress</th><th>Job</th><th>Encore job</th><th>Started</th><th>Completed</th>' +
        '</tr></thead><tbody>' + rows + '</tbody>';
      body.appendChild(table);
      // Bind the copy buttons for every identifier cell just rendered.
      wireCopyIdButtons(table);
    }

    // Raw execution document — present, but collapsed behind a disclosure so the
    // timeline above is what an operator reads first (issue #964).
    body.appendChild(rawJsonDisclosure(exec, rawWasOpen));
    return exec;
  } catch (err) {
    body.innerHTML = '';
    showMsg(body, 'Failed to load pipeline execution: ' + err.message, 'error');
    throw err;
  }
}

// ─── COLLECTIONS TAB ─────────────────────────────────────────────────────────

// A collection hit clicked in the Search tab (issue #849). The Collections tab
// has no deep link, and switchTab() re-renders it from scratch with an async
// renderer, so stash the id here and let renderCollectionsTab open the detail
// panel once its list has loaded.
let pendingCollectionFocusId = null;

function openCollectionFromSearch(id) {
  pendingCollectionFocusId = id;
  switchTab('collections');
}

// Selector for every interactive control that may live INSIDE a collection row.
// A click or key press that lands on one of these is that control's own
// activation, never a row activation (issue #917) — so View/Delete can never
// double-trigger the detail panel.
const COLLECTION_ROW_CONTROL_SELECTOR = 'button, a, input, select, textarea, label, [role="button"]';

// Row activation for the collections list (issue #917). The whole row opens the
// detail panel, by pointer OR by keyboard, with the View button kept as a
// redundant explicit control.
//
// Accessibility notes:
//   - `tabindex="0"` on the `<tr>` puts the row in the tab order. We deliberately
//     do NOT put `role="button"` on the row: that would replace the row/cell
//     semantics a screen reader needs to read a 5-column table, and the cells
//     carry the only description of WHICH collection this is. The row keeps
//     `role="row"` and gains an action; the View button inside it remains the
//     named, unambiguous affordance for assistive tech.
//   - Enter and Space both activate, matching the platform convention for an
//     activatable widget. Space is `preventDefault`ed so activating a row does
//     not also scroll the page.
//   - Keydowns are only honoured when the row ITSELF has focus (`e.target === tr`).
//     Without that check, pressing Enter on the focused View button would bubble
//     a keydown to the row and open the detail panel twice.
function wireCollectionRowActivation(root, onOpen) {
  root.querySelectorAll('tr.coll-row').forEach(function(tr) {
    const id = tr.dataset.id;
    function activate() {
      root.querySelectorAll('tr.coll-row').forEach((r) => r.classList.remove('row-selected'));
      tr.classList.add('row-selected');
      onOpen(id);
    }
    tr.addEventListener('click', function(e) {
      if (e.target.closest(COLLECTION_ROW_CONTROL_SELECTOR)) return;
      activate();
    });
    tr.addEventListener('keydown', function(e) {
      if (e.target !== tr) return;
      if (e.key === 'Enter') {
        activate();
      } else if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        activate();
      }
    });
  });
}

async function renderCollectionsTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Collections';
  container.appendChild(title);

  // Create form
  const createSection = document.createElement('div');
  createSection.className = 'section';
  createSection.innerHTML = [
    '<div class="section-title">Create collection</div>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="coll-name">Name</label>',
    '    <input type="text" id="coll-name" placeholder="My collection" />',
    '  </div>',
    '  <button id="coll-create-btn">Create</button>',
    '</div>',
    '<div id="coll-create-msg"></div>',
  ].join('');
  container.appendChild(createSection);

  // List section
  const listSection = document.createElement('div');
  listSection.className = 'section';
  listSection.innerHTML = [
    '<div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">',
    '  <span>Collections</span>',
    '  <button id="coll-refresh" class="btn-ghost" style="font-size:12px;padding:4px 10px;">Refresh</button>',
    '</div>',
    '<div id="coll-list-wrap"></div>',
  ].join('');
  container.appendChild(listSection);

  const detailPanel = document.createElement('div');
  detailPanel.id = 'coll-detail';
  detailPanel.style.display = 'none';
  container.appendChild(detailPanel);

  async function loadCollections() {
    const wrap = listSection.querySelector('#coll-list-wrap');
    wrap.innerHTML = '';
    const loader = loadingEl();
    wrap.appendChild(loader);
    let collections = [];
    try {
      const res = await apiFetch('/collections');
      collections = Array.isArray(res) ? res : (res && (res.items || res.collections) ? (res.items || res.collections) : []);
    } catch (err) {
      loader.remove();
      showMsg(wrap, 'Failed: ' + err.message, 'error');
      return;
    }
    loader.remove();
    if (collections.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No collections.';
      wrap.appendChild(empty);
      return;
    }

    const rows = collections.map(function(c) {
      const assetCount = c.assets ? c.assets.length : (c.assetCount != null ? c.assetCount : '—');
      // Authoritative member count for the delete confirmation (issue #919):
      // GET /api/v1/collections returns `assetIds` (collectionSchema,
      // src/routes/collections.ts:80-91) — `assets` is only present on GET
      // /collections/{id} (collectionWithAssetsSchema, :96-98). Empty string when
      // neither is present, so the dialog degrades to count-free wording rather
      // than asserting a number it cannot know.
      const memberCount = Array.isArray(c.assetIds)
        ? c.assetIds.length
        : (Array.isArray(c.assets) ? c.assets.length : '');
      // Explicit delete-lock, carried alongside the member count because the
      // lock decides the delete outcome BEFORE emptiness does: DELETE
      // /api/v1/collections/{id} throws CollectionDeleteProtectedError on a
      // locked collection (src/routes/collections.ts:404-406) ahead of the
      // member check (:407-414), and `?force=true` is never consulted for it.
      // `deleteLock` is part of collectionSchema (collections.ts:80-91, field at
      // :90) and is
      // returned by GET /collections (:315-324), so the list already knows.
      const deleteLocked = !!(c.deleteLock && c.deleteLock.locked);
      // `coll-row` + `tabindex="0"`: the whole row activates the detail panel by
      // pointer or keyboard (issue #917). See wireCollectionRowActivation().
      return '<tr class="coll-row" data-id="' + escHtml(c.id) + '" tabindex="0">' +
        '<td class="cell-id">' + escHtml(c.id) + '</td>' +
        '<td>' + escHtml(c.name || '—') + '</td>' +
        '<td>' + escHtml(String(assetCount)) + '</td>' +
        '<td>' + escHtml(fmtDate(c.createdAt)) + '</td>' +
        '<td>' +
          '<button class="btn-ghost coll-view-btn" data-id="' + escHtml(c.id) + '" style="font-size:12px;padding:3px 8px;">View</button>' +
          '<button class="btn-danger coll-delete-btn" data-id="' + escHtml(c.id) + '" data-name="' + escHtml(c.name || '') + '" data-members="' + escHtml(String(memberCount)) + '" data-locked="' + (deleteLocked ? '1' : '') + '" style="font-size:12px;padding:3px 8px;margin-left:4px;">Delete</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    const tableWrap = document.createElement('div');
    tableWrap.className = 'table-wrap';
    tableWrap.innerHTML = '<table>' +
      '<thead><tr><th>ID</th><th>Name</th><th>Asset count</th><th>Created</th><th>Actions</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table>';
    wrap.appendChild(tableWrap);

    // Whole-row activation (issue #917). Bound alongside the View button, which
    // stays as a redundant explicit control; the row handler ignores events that
    // originate on any inner control, so the two cannot double-trigger.
    wireCollectionRowActivation(tableWrap, function(id) {
      showCollectionDetail(id, detailPanel, loadCollections);
    });

    tableWrap.querySelectorAll('.coll-view-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { showCollectionDetail(btn.dataset.id, detailPanel, loadCollections); });
    });
    tableWrap.querySelectorAll('.coll-delete-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        // Collection delete confirmation (issue #919). Impact wording verified
        // against DELETE /api/v1/collections/{id}
        // (src/routes/collections.ts:383-436), NOT assumed:
        //   - The handler calls `repo.delete(id)` only. There is NO cascade into
        //     assets: a collection stores a flat list of member ids
        //     (`assetIds`, src/data/collection-repo.ts:19-25), so deleting it
        //     removes the grouping, never the media.
        //   - It is audited as `collection.deleted` (collections.ts:418-433).
        //   - A delete-locked collection is REFUSED with 409 `delete_blocked` /
        //     reason `delete_protected` (collections.ts:404-406,
        //     CollectionDeleteProtectedError; envelope deleteBlockedSchema
        //     :62-70; handler mapping :257-265). This guard is HARD and runs
        //     FIRST — before the member check — and `?force=true` is never
        //     consulted for it, so a locked collection can never be deleted from
        //     here. The only way out is DELETE /collections/{id}/lock
        //     (collections.ts:478-491, "the only way to lift protection").
        //     Hence the lock branch below must not promise the delete lands.
        //   - A collection that still holds member ids is REFUSED with 409
        //     `delete_blocked` / reason `member_of_collection` unless
        //     `?force=true` (collections.ts:407-414, CollectionInUseError;
        //     ADR-020 decision 2 marks this block SOFT/overridable). This UI
        //     deliberately does not send `force`, so a non-empty collection is a
        //     no-op the operator is told about up front.
        //   - There is no restore path for a deleted collection (the router
        //     exposes no equivalent of the asset `/restore` route).
        const label = nameOrFallback(btn.dataset.name, 'this collection');
        const members = btn.dataset.members;
        const hasCount = members !== '' && members != null && !Number.isNaN(Number(members));
        const count = hasCount ? Number(members) : null;
        const locked = btn.dataset.locked === '1';
        // The delete outcome is NOT seeded unconditionally: in a refused branch
        // BOTH of its clauses are false. The lock guard throws
        // CollectionDeleteProtectedError BEFORE `repo.delete(id)` is reached
        // (collections.ts:404-406 vs :417), and the `collection.deleted` audit
        // emit sits AFTER the delete inside `if (existing)` (:418-433), so a
        // refused delete writes no audit entry either. Same construction as the
        // asset archive dialog above (app.js:1538-1539): refusal bullet first,
        // outcome only where the delete can actually land — or as an
        // "Otherwise …" clause when the branch cannot tell in advance.
        const affected = [];
        // Lock first: it mirrors the handler's guard order, and it is the only
        // refusal that holds whether or not the collection is empty.
        if (locked) {
          affected.push(
            'This collection is delete-locked, so the API will refuse the delete and nothing will change. ' +
            'The lock has to be cleared first (DELETE /collections/{id}/lock) — it cannot be forced.'
          );
        } else if (hasCount && count === 0) {
          affected.push('This collection is empty, so the delete will go through.');
          affected.push('The collection record and its list of members are deleted, and the deletion is recorded in the audit log.');
        } else if (hasCount) {
          affected.push(
            'This collection still holds ' + count + ' asset' + (count === 1 ? '' : 's') +
            ', so the API will refuse the delete and nothing will change. Remove its members first.'
          );
          affected.push('Otherwise — once its members are removed — the collection record and its list of members are deleted, and the deletion is recorded in the audit log.');
        } else {
          affected.push('If the collection still holds assets, the API refuses the delete and nothing changes — remove its members first.');
          affected.push('Otherwise the collection record and its list of members are deleted, and the deletion is recorded in the audit log.');
        }
        affected.push('There is no undo: unlike an archived asset, a deleted collection cannot be restored.');
        const ok = await confirmModal({
          title: 'Delete collection',
          subject: label,
          question: 'Delete collection "' + label + '"?',
          confirmLabel: 'Delete collection',
          affected: affected,
          unaffected: [
            'No assets are deleted. Every asset that was in this collection keeps its files, renditions and metadata.',
            'Those assets stay in any other collection they belong to, and any running or finished jobs are untouched.',
          ],
        });
        if (!ok) return;
        try {
          await apiFetch('/collections/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
          loadCollections();
        } catch (err) {
          // First call site for errorToast (issue #918), now routed through
          // reportActionFailure (issue #920) because this is the path that most
          // often carries a structured reason.
          //
          // DELETE /api/v1/collections/{id} (openapi.json) answers 204 | 404 |
          // 409. The 409 body is { error: 'delete_blocked', message, reason:
          // 'referenced_by_job'|'member_of_collection'|'delete_protected',
          // blockedBy } (deleteBlockedSchema, src/routes/collections.ts:62-70;
          // emitted at :262 and :275). apiFetch reduces that body to the server's
          // `message`, which for the in-use case is the internal sentence
          // `collection <id> is in use (N member asset(s))`
          // (src/data/collection-repo.ts:160) — so the reason is humanized here
          // and only falls back to that message when no reason is recognised.
          reportActionFailure(err, {
            action: 'Delete collection',
            detail: 'Collection "' + label + '" was not deleted.',
          });
        }
      });
    });
  }

  createSection.querySelector('#coll-create-btn').addEventListener('click', async function() {
    const name = createSection.querySelector('#coll-name').value.trim();
    const msgEl = createSection.querySelector('#coll-create-msg');
    msgEl.innerHTML = '';
    if (!name) { showMsg(msgEl, 'Name is required.', 'error'); return; }
    try {
      await apiFetch('/collections', { method: 'POST', body: JSON.stringify({ name: name }) });
      showMsg(msgEl, 'Collection created.', 'success');
      createSection.querySelector('#coll-name').value = '';
      loadCollections();
    } catch (err) {
      showMsg(msgEl, 'Error: ' + err.message, 'error');
    }
  });

  listSection.querySelector('#coll-refresh').addEventListener('click', loadCollections);
  await loadCollections();

  // Arrived here from a collection hit in the Search tab (issue #849): open that
  // collection's detail straight away, then clear the hand-off so a later manual
  // visit to this tab opens nothing.
  if (pendingCollectionFocusId) {
    const focusId = pendingCollectionFocusId;
    pendingCollectionFocusId = null;
    await showCollectionDetail(focusId, detailPanel, loadCollections);
  }
}

// ─── Collection asset picker (issue #915) ────────────────────────────────────
//
// Adding a member used to mean hand-typing a 26-character ULID, which is
// unusable now that the Assets table shows the slug in its ID column (#851).
// This picker searches assets by name, lets several be selected, and adds them
// in one interaction. The raw-id field stays as a fallback.
//
// Verified contract (CLAUDE.md rule 7):
//   - Search: GET /api/v1/search/ — src/routes/search.ts:260 (`app.get('/')`,
//     mounted at prefix `/api/v1/search`). Query params come from
//     `searchQuerySchema` (src/routes/search.ts:152-219): `q` — free text,
//     1..512 chars, matched case-insensitively against the asset's canonical
//     `name` (persisted at `descriptive.title`) and description
//     (src/routes/search.ts:154-164) — and `pageSize` (int, 1..MAX_PAGE_SIZE,
//     src/routes/search.ts:215). There is NO `type=asset` query parameter; the
//     response separates the two kinds instead, so "assets only" here means
//     reading the `assets` array of the envelope
//     `{ assets, collections, total, collectionTotal, page }`
//     (`searchResultSchema`, src/routes/search.ts:123-135). Asset hits are
//     `assetSchema.extend({ type: z.literal('asset') })`
//     (src/routes/search.ts:78-105, :127); the fields used below are `id`,
//     `name` and `status`. This projection carries no `slug`, so the picker
//     never claims to show one.
//   - Membership add: PUT /api/v1/collections/:id/assets/:assetId —
//     src/routes/collections.ts:492-531. Its schema declares `params:
//     z.object({ id: z.string(), assetId: z.string() })` and no body schema
//     (:497); responses are 200 | 404 | 422 (:498). There is no batch/multi
//     member endpoint on that router (the only other membership route is
//     DELETE /:id/assets/:assetId, :533), so "add several" is one PUT per
//     asset, issued from a single user interaction.
//   - Result truncation: the envelope's `total` is the count of matching ASSETS
//     across the WHOLE matched set, not the page in hand (`searchResultSchema`,
//     src/routes/search.ts:130 — "Count of matching ASSETS (unchanged
//     pagination contract)"; the page itself is `matched.slice(start, start +
//     pageSize)` against `total: matched.length`,
//     src/data/inmemory-search-repo.ts:53-57). So `total > assets.length` means
//     the list on screen is cut short, and the picker says so rather than
//     letting "not shown" read as "not there" (issue #949).
const ASSET_PICKER_DEBOUNCE_MS = 250;
const ASSET_PICKER_PAGE_SIZE = 20;

// Build the search request path for a picker query. `q` is the only filter:
// the picker's job is "find an asset by name", and `pageSize` bounds the list.
function assetPickerSearchPath(q) {
  const params = new URLSearchParams();
  params.set('q', q);
  params.set('pageSize', String(ASSET_PICKER_PAGE_SIZE));
  return '/search?' + params.toString();
}

// Asset hits only, normalised to what the picker renders. Collection hits
// arrive in their own array and are dropped here — a collection cannot be a
// member of a collection through this endpoint.
function assetPickerHits(res) {
  const hits = res && Array.isArray(res.assets) ? res.assets : [];
  return hits.map(function(a) {
    return {
      id: a && a.id != null ? String(a.id) : '',
      name: (a && a.name) || '',
      status: (a && a.status) || '',
    };
  }).filter(function(a) { return a.id !== ''; });
}

// Count of matching assets the search found in total, or null when the envelope
// does not say. Read separately from the hits so `assetPickerHits` keeps its
// one job (issue #949).
function assetPickerTotal(res) {
  return res && typeof res.total === 'number' ? res.total : null;
}

// The line above a truncated hit list. A one-page picker that shows 20 of 57
// matches and says nothing makes an asset that exists look like an asset that
// does not, and the operator has no way to tell which — so name the gap and say
// what to do about it. Empty string when everything that matched is on screen.
function assetPickerResultNote(shown, total) {
  if (total === null || total === undefined || total <= shown) return '';
  return 'Showing the first ' + shown + ' of ' + total +
    ' matching assets. Add a word from the name to narrow the search.';
}

// Add several assets to one collection. One PUT per asset (the contract has no
// batch route); resolves with the ids that landed and the ones that did not,
// so a partial failure is reported rather than swallowed.
async function addAssetsToCollection(collectionId, assetIds) {
  const added = [];
  const failed = [];
  for (const assetId of assetIds) {
    try {
      await apiFetch(
        '/collections/' + encodeURIComponent(collectionId) + '/assets/' + encodeURIComponent(assetId),
        { method: 'PUT', body: JSON.stringify({}) }
      );
      added.push(assetId);
    } catch (err) {
      failed.push({ id: assetId, message: err.message });
    }
  }
  return { added: added, failed: failed };
}

// "Added 3 assets." / "Added 2 of 3 assets. Failed: 01H… (asset not found)."
function addAssetsSummary(result) {
  const total = result.added.length + result.failed.length;
  if (result.failed.length === 0) {
    return 'Added ' + result.added.length + ' asset' + (result.added.length === 1 ? '' : 's') + '.';
  }
  const detail = result.failed.map(function(f) { return f.id + ' (' + f.message + ')'; }).join('; ');
  return 'Added ' + result.added.length + ' of ' + total + ' assets. Failed: ' + detail;
}

// ─── Assets-tab bulk "add to collection" (issue #916) ────────────────────────
//
// CONTRACT GROUNDING. This view issues NO new call of its own. The only write it
// performs is `addAssetsToCollection()` above (app.js — the one PUT-per-asset
// loop over `/collections/:id/assets/:assetId`), which is the exact function the
// collection-detail picker's "Add selected" button calls
// (`renderCollectionAssetPicker` -> `addAssetsToCollection`, app.js:4203+).
// Reusing that function — rather than re-issuing the PUT here — is what keeps the
// two entry points on one add-membership path, so the 404/422 handling and the
// partial-failure summary (`addAssetsSummary`) cannot drift between them.
//
// The verified backend contract behind that shared function:
//   - PUT /api/v1/collections/{id}/assets/{assetId} — src/routes/collections.ts:586-620
//     (`app.put('/:id/assets/:assetId', ...)`, declared at :587). Schema:
//     `params: z.object({ id: z.string(), assetId: z.string() })`, NO body schema,
//     `response: { 200: collectionSchema, 404: errorSchema, 422: errorSchema }`
//     (:589-592). Route header comment src/routes/collections.ts:18. Mirrored in
//     openapi.json at `.paths["/api/v1/collections/{id}/assets/{assetId}"].put`
//     (no operationId is emitted by the generator — the path+method IS the
//     identifier in this spec). 422 is `asset_not_found` for an asset that does
//     not resolve (:598-603); 404 is an unknown collection (:609-611).
//   - There is still NO batch/multi-member route on that router: its only other
//     membership route is DELETE `/:id/assets/:assetId`
//     (src/routes/collections.ts:625). So "add N assets" is N PUTs issued from
//     one user interaction, exactly as the detail picker does it.
//   - Collection list for the target picker: GET /api/v1/collections/ returns
//     `{ collections: [...] }` with each item requiring `id`, `name`, `assetIds`,
//     `createdAt`, `updatedAt` (openapi.json
//     `.paths["/api/v1/collections/"].get.responses["200"]`). Only `id` and `name`
//     are read here.

// Normalise whatever the collections list endpoint returned into `{ id, name }`
// options. Tolerant of the three envelope shapes the Collections tab already
// accepts (app.js:3901-3902) so the two readers cannot disagree about the wire.
function bulkCollectionOptions(res) {
  const list = Array.isArray(res)
    ? res
    : res && Array.isArray(res.collections)
      ? res.collections
      : res && Array.isArray(res.items)
        ? res.items
        : [];
  return list
    .map(function(c) {
      return { id: c && c.id != null ? String(c.id) : '', name: (c && c.name) || '' };
    })
    .filter(function(c) { return c.id !== ''; });
}

// The label on the bulk bar's primary button, and the bar's own live-region text.
// Kept pure so the wording is testable without a DOM round-trip.
function bulkAddButtonLabel(count) {
  if (count === 0) return 'Add to collection';
  return 'Add ' + count + ' asset' + (count === 1 ? '' : 's') + ' to collection';
}

function bulkSelectionSummary(selection) {
  const n = selection.length;
  if (n === 0) return 'No assets selected.';
  if (n === 1) return '1 asset selected: ' + selection[0].label + '.';
  return n + ' assets selected.';
}

// The bulk-action bar for the Assets tab. Returns
// `{ el, setSelection }` — a detached element plus the one function the table's
// `onSelectionChange` calls, which is the ONLY way this bar learns about the
// selection. `opts.onAdded()` fires after a run that added at least one
// membership; `opts.deselect(ids)` unticks just the ids a run consumed and
// `opts.clearSelection()` drops the whole selection.
//
// The bar submits the ids from the same local mirror it LABELS, so the button
// text and the requests can never disagree. The table's Map stays
// authoritative: whatever the run consumed is handed back to `opts.deselect()`
// so the mirror and the Map narrow together. Submitting `opts.getSelection()`
// directly would reintroduce exactly that split — after a partial failure the
// label would name the remaining assets while the click re-sent every id the
// table still held.
function renderAssetsBulkBar(opts) {
  opts = opts || {};
  const fetchFn = opts.apiFetch || apiFetch;

  const wrap = document.createElement('div');
  wrap.className = 'assets-bulk-bar';
  wrap.id = 'assets-bulk-bar';
  // The bar is a named region rather than a floating strip of controls, so a
  // screen-reader user can reach it directly and knows what it governs
  // (WCAG 2.1 AA — 1.3.1, 4.1.2).
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Bulk actions for selected assets');
  wrap.innerHTML = [
    '<div class="form-row">',
    '  <div class="grow" id="assets-bulk-count" aria-live="polite">No assets selected.</div>',
    '  <div class="form-field">',
    '    <label for="assets-bulk-collection">Target collection</label>',
    '    <select id="assets-bulk-collection" aria-describedby="assets-bulk-hint"></select>',
    '  </div>',
    '  <button id="assets-bulk-add-btn" disabled>Add to collection</button>',
    '  <button id="assets-bulk-clear-btn" class="btn-ghost" disabled>Clear selection</button>',
    '</div>',
    '<div class="form-hint" id="assets-bulk-hint">Tick assets in the table, pick an existing collection, then add them. Selection survives paging and filtering, so assets from more than one page can be added together.</div>',
    '<div id="assets-bulk-msg" aria-live="polite"></div>',
  ].join('');

  const countEl = wrap.querySelector('#assets-bulk-count');
  const selectEl = wrap.querySelector('#assets-bulk-collection');
  const addBtn = wrap.querySelector('#assets-bulk-add-btn');
  const clearBtn = wrap.querySelector('#assets-bulk-clear-btn');
  const msgEl = wrap.querySelector('#assets-bulk-msg');

  // The bar's mirror of the table's selection: fed by `setSelection()` from
  // `onSelectionChange`, seeded once from `opts.getSelection()` in case the bar
  // is mounted after rows were already ticked. Everything this bar renders AND
  // everything it submits reads from here, so the two cannot drift apart.
  let selection =
    typeof opts.getSelection === 'function' ? opts.getSelection() || [] : [];
  // Null until the list has been read; distinguishes "no collections exist" from
  // "not asked yet", which decide different disabled states.
  let collections = null;

  function refreshControls() {
    countEl.textContent = bulkSelectionSummary(selection);
    addBtn.textContent = bulkAddButtonLabel(selection.length);
    clearBtn.disabled = selection.length === 0;
    addBtn.disabled = selection.length === 0 || !selectEl.value;
  }

  function setSelection(next) {
    selection = Array.isArray(next) ? next : [];
    refreshControls();
  }

  // Populate the target picker. A failure is reported in the bar rather than
  // thrown: the table behind it is still usable, only this action is not.
  async function loadCollections() {
    try {
      collections = bulkCollectionOptions(await fetchFn('/collections'));
    } catch (err) {
      collections = [];
      showMsg(msgEl, 'Failed to load collections: ' + err.message, 'error');
    }
    selectEl.innerHTML =
      collections.length === 0
        ? '<option value="">No collections — create one in the Collections tab</option>'
        : '<option value="">Choose a collection…</option>' +
          collections
            .map(function(c) {
              return '<option value="' + escHtml(c.id) + '">' + escHtml(c.name || c.id) + '</option>';
            })
            .join('');
    refreshControls();
  }

  selectEl.addEventListener('change', refreshControls);

  clearBtn.addEventListener('click', function() {
    msgEl.innerHTML = '';
    if (typeof opts.clearSelection === 'function') opts.clearSelection();
    setSelection([]);
  });

  addBtn.addEventListener('click', async function() {
    const collectionId = selectEl.value;
    if (!collectionId) return;
    // Submit exactly what the bar is showing. `selection` is the mirror the
    // count and the button label are rendered from, so reading the ids from it
    // keeps the action and its own description in step — including on the retry
    // click after a partial failure, when the table may still hold ids this bar
    // has already reported as added.
    const ids = selection.map(function(s) { return typeof s === 'string' ? s : s.id; });
    if (ids.length === 0) return;

    const prev = addBtn.textContent;
    addBtn.disabled = true;
    addBtn.textContent = 'Adding…';
    msgEl.innerHTML = '';
    try {
      // THE shared add-membership path — identical call to the one the
      // collection-detail picker makes. No second implementation exists.
      const result = await addAssetsToCollection(collectionId, ids);
      const summary = addAssetsSummary(result);
      showMsg(msgEl, summary, result.failed.length === 0 ? 'success' : 'error');
      if (result.added.length > 0) {
        // Only the ids that landed leave the selection: a failed add stays
        // ticked so the operator can retry it without re-finding the row.
        // Narrow the OWNER of the selection first — the table's tick-boxes and
        // its Map — so the rows on screen stop showing assets this run already
        // consumed, and so the next tick anywhere in the table re-emits only
        // what is genuinely still outstanding. Falling back to
        // `clearSelection()` when every id landed keeps a consumer that offers
        // no per-id untick working as before.
        const landed = new Set(result.added);
        const remaining = selection.filter(function(s) { return !landed.has(s.id); });
        if (typeof opts.deselect === 'function') {
          opts.deselect(result.added);
        } else if (remaining.length === 0 && typeof opts.clearSelection === 'function') {
          opts.clearSelection();
        }
        setSelection(remaining);
        if (typeof opts.onAdded === 'function') opts.onAdded(collectionId, result);
      }
    } catch (err) {
      showMsg(msgEl, 'Failed to add to collection: ' + err.message, 'error');
    } finally {
      addBtn.textContent = selection.length === 0 ? bulkAddButtonLabel(0) : prev;
      refreshControls();
    }
  });

  refreshControls();
  void loadCollections();

  return { el: wrap, setSelection: setSelection, reloadCollections: loadCollections };
}

// The add-to-collection control: name search + multi-select, with the raw-id
// field kept behind a disclosure as a fallback. Returns a detached element;
// `onAdded()` (optional) fires after at least one membership add succeeds.
function renderCollectionAssetPicker(collectionId, opts) {
  opts = opts || {};
  const wrap = document.createElement('div');
  wrap.className = 'mt12';
  wrap.innerHTML = [
    '<div class="section-title">Add assets to collection</div>',
    '<div class="form-row mt8">',
    '  <div class="form-field grow">',
    '    <label for="add-asset-search">Find assets by name</label>',
    '    <input type="search" id="add-asset-search" placeholder="Type part of an asset name…"',
    '      role="combobox" aria-expanded="false" aria-controls="add-asset-results"',
    '      aria-describedby="add-asset-search-hint" autocomplete="off" />',
    '    <div class="form-hint" id="add-asset-search-hint">Matches the asset name and description. Tick every asset you want, then add them together.</div>',
    '  </div>',
    '  <button id="add-asset-search-btn">Search</button>',
    '</div>',
    '<div id="add-asset-results" class="checkbox-group mt8" role="group" aria-label="Matching assets"></div>',
    '<div class="form-row mt8">',
    '  <div class="grow" id="add-asset-selected" aria-live="polite">Nothing selected.</div>',
    '  <button id="add-asset-selected-btn" disabled>Add selected</button>',
    '</div>',
    '<details class="mt8" id="add-asset-fallback">',
    '  <summary>Add by asset ID instead</summary>',
    '  <div class="form-row mt8">',
    '    <div class="form-field grow">',
    '      <label for="add-asset-id">Asset ID</label>',
    '      <input type="text" id="add-asset-id" placeholder="Asset ID" />',
    '    </div>',
    '    <button id="add-asset-btn">Add</button>',
    '  </div>',
    // Issue #851: say which of the two asset handles this field takes. The
    // membership endpoint resolves the ULID only (src/routes/collections.ts
    // PUT /:id/assets/:assetId -> assets.get), so a slug is rejected here.
    '  <div class="text-muted" style="font-size:12px;margin-top:4px;">Takes the asset ID (26-character ULID), not the slug — copy it from the ID column in the Assets tab.</div>',
    '</details>',
    '<div id="add-asset-msg" aria-live="polite"></div>',
  ].join('');

  const searchInput = wrap.querySelector('#add-asset-search');
  const resultsEl = wrap.querySelector('#add-asset-results');
  const selectedEl = wrap.querySelector('#add-asset-selected');
  const selectedBtn = wrap.querySelector('#add-asset-selected-btn');
  const msgEl = wrap.querySelector('#add-asset-msg');

  // Selection survives re-searching: an asset ticked under one query stays
  // ticked when the result list is replaced by the next one.
  const selected = new Map();

  function renderSelected() {
    const ids = [...selected.keys()];
    selectedBtn.disabled = ids.length === 0;
    selectedBtn.textContent = ids.length === 0
      ? 'Add selected'
      : 'Add ' + ids.length + ' selected asset' + (ids.length === 1 ? '' : 's');
    if (ids.length === 0) {
      selectedEl.textContent = 'Nothing selected.';
      return;
    }
    selectedEl.innerHTML = ids.map(function(id) {
      return '<span class="tag add-asset-chip">' + escHtml(selected.get(id) || id) +
        ' <button type="button" class="btn-ghost add-asset-deselect" data-asset-id="' + escHtml(id) +
        '" aria-label="Remove ' + escHtml(selected.get(id) || id) + ' from selection">×</button></span>';
    }).join(' ');
    selectedEl.querySelectorAll('.add-asset-deselect').forEach(function(btn) {
      btn.addEventListener('click', function() {
        selected.delete(btn.dataset.assetId);
        // Untick the matching hit if it is still on screen. Matched by value in
        // a loop rather than an attribute selector so no id needs escaping.
        resultsEl.querySelectorAll('.add-asset-hit').forEach(function(box) {
          if (box.value === btn.dataset.assetId) box.checked = false;
        });
        renderSelected();
      });
    });
  }

  function renderHits(hits, total) {
    searchInput.setAttribute('aria-expanded', hits.length > 0 ? 'true' : 'false');
    if (hits.length === 0) {
      resultsEl.innerHTML = '<div class="empty">No assets match.</div>';
      return;
    }
    const note = assetPickerResultNote(hits.length, total);
    resultsEl.innerHTML = (note
      ? '<div class="form-hint" id="add-asset-results-note">' + escHtml(note) + '</div>'
      : '') + hits.map(function(hit) {
      return '<label class="checkbox-label">' +
        '<input type="checkbox" class="add-asset-hit" value="' + escHtml(hit.id) + '"' +
        (selected.has(hit.id) ? ' checked' : '') +
        ' data-asset-name="' + escHtml(hit.name || hit.id) + '" />' +
        '<span>' + escHtml(hit.name || '(untitled)') + '</span>' +
        (hit.status ? ' ' + renderBadge(hit.status) : '') +
        ' <span class="text-mono text-muted">' + escHtml(hit.id) + '</span>' +
        '</label>';
    }).join('');
    resultsEl.querySelectorAll('.add-asset-hit').forEach(function(box) {
      box.addEventListener('change', function() {
        if (box.checked) {
          selected.set(box.value, box.dataset.assetName);
        } else {
          selected.delete(box.value);
        }
        renderSelected();
      });
    });
  }

  let searchSeq = 0;
  async function runSearch() {
    const q = searchInput.value.trim();
    if (!q) {
      resultsEl.innerHTML = '';
      searchInput.setAttribute('aria-expanded', 'false');
      return;
    }
    const seq = ++searchSeq;
    resultsEl.innerHTML = '';
    const loader = loadingEl();
    resultsEl.appendChild(loader);
    try {
      const res = await apiFetch(assetPickerSearchPath(q));
      if (seq !== searchSeq) return; // a newer keystroke already won
      renderHits(assetPickerHits(res), assetPickerTotal(res));
    } catch (err) {
      if (seq !== searchSeq) return;
      resultsEl.innerHTML = '';
      showMsg(resultsEl, 'Search failed: ' + err.message, 'error');
    }
  }

  let debounceTimer = null;
  searchInput.addEventListener('input', function() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, ASSET_PICKER_DEBOUNCE_MS);
  });
  searchInput.addEventListener('keydown', function(ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (debounceTimer) clearTimeout(debounceTimer);
      runSearch();
    }
  });
  wrap.querySelector('#add-asset-search-btn').addEventListener('click', function() {
    if (debounceTimer) clearTimeout(debounceTimer);
    runSearch();
  });

  selectedBtn.addEventListener('click', async function() {
    const ids = [...selected.keys()];
    msgEl.innerHTML = '';
    if (ids.length === 0) { showMsg(msgEl, 'Select at least one asset.', 'error'); return; }
    selectedBtn.disabled = true;
    const result = await addAssetsToCollection(collectionId, ids);
    result.added.forEach(function(id) { selected.delete(id); });
    renderSelected();
    showMsg(msgEl, addAssetsSummary(result), result.failed.length === 0 ? 'success' : 'error');
    if (result.added.length > 0 && typeof opts.onAdded === 'function') opts.onAdded();
  });

  // Fallback: the original raw-id path, unchanged in behaviour.
  wrap.querySelector('#add-asset-btn').addEventListener('click', async function() {
    const assetId = wrap.querySelector('#add-asset-id').value.trim();
    msgEl.innerHTML = '';
    if (!assetId) { showMsg(msgEl, 'Asset ID required.', 'error'); return; }
    try {
      await apiFetch(
        '/collections/' + encodeURIComponent(collectionId) + '/assets/' + encodeURIComponent(assetId),
        { method: 'PUT', body: JSON.stringify({}) }
      );
      showMsg(msgEl, 'Asset added.', 'success');
      if (typeof opts.onAdded === 'function') opts.onAdded();
    } catch (err) {
      showMsg(msgEl, 'Error: ' + err.message, 'error');
    }
  });

  renderSelected();
  return wrap;
}

async function showCollectionDetail(id, detailPanel, onRefresh) {
  detailPanel.style.display = 'block';
  detailPanel.className = 'detail-panel';
  detailPanel.innerHTML = [
    '<div class="detail-panel-header">',
    '  <h3>Collection</h3>',
    '  <button id="close-coll-detail" class="btn-ghost" style="font-size:12px;padding:3px 8px;">Close</button>',
    '</div>',
    '<div class="detail-panel-body" id="coll-detail-body"></div>',
  ].join('');

  detailPanel.querySelector('#close-coll-detail').addEventListener('click', function() {
    detailPanel.style.display = 'none';
    detailPanel.innerHTML = '';
  });

  const body = detailPanel.querySelector('#coll-detail-body');
  const loader = loadingEl();
  body.appendChild(loader);

  try {
    const coll = await apiFetch('/collections/' + encodeURIComponent(id));
    loader.remove();
    const assets = coll.assets || [];

    const kvDiv = document.createElement('div');
    kvDiv.className = 'kv-grid';
    kvDiv.innerHTML = [
      '<span class="kv-key">ID</span><span class="kv-val text-mono">' + escHtml(coll.id) + '</span>',
      '<span class="kv-key">Name</span><span class="kv-val">' + escHtml(coll.name || '—') + '</span>',
      '<span class="kv-key">Created</span><span class="kv-val">' + escHtml(fmtDate(coll.createdAt)) + '</span>',
    ].join('');
    body.appendChild(kvDiv);

    // ── Rename: edit the collection's name (issue #928) ──
    //
    // Contract, fetched before this call was written (CLAUDE.md rule 7) and
    // cited in full in public/collection-rename.js:
    //   PATCH /api/v1/collections/{id} — body carries EXACTLY `name`
    //        (`updateBodySchema.name = z.string().min(1).max(256).optional()`,
    //        src/routes/collections.ts:224, inside a `.strict()` object at :229;
    //        wired at :389-410); 200 = the updated collection, 400 = { error },
    //        404 = { error }.
    // The `name` field on this body is the API change issue #928 lists as a
    // dependency; it landed in issue #926, so this is the affordance for a field
    // the route already accepts — no route, schema or response shape changes
    // here.
    //
    // Membership is untouched and UNSENDABLE: the body is `.strict()`, so
    // `assetIds` would be a 400 (collections.ts:207-215 — membership stays on
    // PUT/DELETE /:id/assets/:assetId), and `applyCollectionUpdate`
    // (src/data/collection-repo.ts:92-110) assigns only the keys the patch
    // carries and "never touches `assetIds` or `deleteLock`" (:90). The body is
    // built in one shared place (`renameRequestBody`, public/rename-dialog.js)
    // which returns `{ name }` and nothing else.
    //
    // Same component as the asset rename (public/rename-dialog.js), so the
    // dialog, the client-side bounds check, the no-op refusal and the 403/404
    // handling are shared rather than re-implemented.
    const collActionsDiv = document.createElement('div');
    collActionsDiv.className = 'mt12 flex-gap';
    body.appendChild(collActionsDiv);

    const collActionMsg = document.createElement('div');
    collActionMsg.id = 'coll-action-msg';
    collActionMsg.className = 'mt8';
    // Announced politely so an outcome that does not move focus still reaches
    // assistive technology (as the asset detail's #action-msg does).
    collActionMsg.setAttribute('aria-live', 'polite');
    body.appendChild(collActionMsg);

    const collRename = mountCollectionRename({
      collection: coll,
      actionsRow: collActionsDiv,
      canChange: canRenameCollection(),
      apiFetch: apiFetch,
      openModal: openModal,
      showMsg: showMsg,
      messageHost: function () {
        return detailPanel.querySelector('#coll-action-msg') ||
          detailPanel.querySelector('#coll-detail-body');
      },
      onRenamed: async function (updated, message) {
        // The collections list shows the name in its own column, so keep it in
        // step with the panel.
        if (typeof onRefresh === 'function') onRefresh();
        await rerenderCollectionThenMsg(message, updated ? 'success' : 'error');
      },
    });

    // Rename is the only action in this row today, so for a role that cannot
    // write (no control mounted) the row and its outcome area would be two empty
    // boxes with margins. Take them back out rather than leaving dead chrome
    // above the member list.
    if (!collRename.button) {
      collActionsDiv.remove();
      collActionMsg.remove();
    }

    // Add-asset control: searchable multi-select picker with the raw-id field
    // kept as a fallback (issue #915). Adding refreshes only the member list
    // below, so the picker keeps its "Added N assets." result and whatever the
    // operator still has selected instead of being torn down mid-interaction.
    body.appendChild(renderCollectionAssetPicker(id, { onAdded: refreshMembers }));

    // Asset list
    const membersHost = document.createElement('div');
    membersHost.id = 'coll-members';
    body.appendChild(membersHost);
    renderMembers(assets, membersHost);

  } catch (err) {
    body.innerHTML = '';
    showMsg(body, 'Failed: ' + err.message, 'error');
  }

  // Re-render the whole panel from the server, then report the outcome in the
  // freshly built #coll-action-msg (the re-render replaces the old one). A
  // rename is NOT patched into the view locally: the 200 carries the updated
  // collection, and re-reading is the only way a silently different stored value
  // becomes visible. When the re-read itself fails (e.g. the collection is gone,
  // the 404 path), showCollectionDetail has already written its own error into
  // the body and there is no action area, so the message is appended to the body
  // instead of being dropped.
  async function rerenderCollectionThenMsg(text, kind) {
    await showCollectionDetail(id, detailPanel, onRefresh);
    const host = detailPanel.querySelector('#coll-action-msg') ||
      detailPanel.querySelector('#coll-detail-body');
    if (host) showMsg(host, text, kind);
  }

  // Re-read the collection and redraw just the membership table.
  async function refreshMembers() {
    const host = detailPanel.querySelector('#coll-members');
    if (!host) return;
    try {
      const fresh = await apiFetch('/collections/' + encodeURIComponent(id));
      renderMembers(fresh.assets || [], host);
    } catch (err) {
      showMsg(host, 'Failed to refresh members: ' + err.message, 'error');
    }
    if (typeof onRefresh === 'function') onRefresh();
  }

  function renderMembers(assets, host) {
    host.innerHTML = '';
    const assetsDiv = document.createElement('div');
    assetsDiv.className = 'mt12';
    const assetsTitle = document.createElement('div');
    assetsTitle.className = 'section-title';
    assetsTitle.textContent = 'Assets (' + assets.length + ')';
    assetsDiv.appendChild(assetsTitle);

    if (assets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No assets in this collection.';
      assetsDiv.appendChild(empty);
    } else {
      // Issue #851: the "ID" column carries the ULID the membership endpoints
      // take, copyable straight into the add-asset field above. The slug gets
      // its own labelled column.
      //
      // Contract, precisely: PUT /collections/:id/assets/:assetId resolves the
      // asset with a plain `assets.get()` — no slug fallback, so a slug 422s
      // (src/routes/collections.ts:501-510). DELETE does not resolve the asset
      // at all; it removes by exact id, so a slug is a silent 200 no-op rather
      // than a rejection (src/routes/collections.ts:542-547). Either way the
      // ULID is the only value that works.
      //
      // The member objects here are full assets — GET /collections/:id sends
      // `{ ...collection, assets: liveAssets }` where liveAssets is `Asset[]`
      // (src/routes/collections.ts:342-346) — so `slug` is available, optional
      // per `slug?: string` on `Asset` (src/data/asset-repo.ts:455). The
      // response schema itself is `z.record(z.unknown())` passthrough
      // (collectionWithAssetsSchema, src/routes/collections.ts:96-98), so it
      // does not strip it.
      const rows = assets.map(function(a) {
        return '<tr>' +
          '<td>' + copyableIdCellHtml(a.id, 'Copy asset id') + '</td>' +
          '<td>' + slugCellHtml(a.slug) + '</td>' +
          '<td>' + escHtml(a.title || a.name || '—') + '</td>' +
          '<td>' + renderBadge(a.status) + '</td>' +
          '<td><button class="btn-danger remove-asset-btn" data-asset-id="' + escHtml(a.id) + '" style="font-size:12px;padding:3px 8px;">Remove</button></td>' +
          '</tr>';
      }).join('');
      const tableWrap = document.createElement('div');
      tableWrap.className = 'table-wrap';
      tableWrap.innerHTML = '<table>' +
        '<thead><tr><th>ID</th><th>Slug</th><th>Name</th><th>Status</th><th>Actions</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>';
      assetsDiv.appendChild(tableWrap);
      wireCopyIdButtons(tableWrap);

      tableWrap.querySelectorAll('.remove-asset-btn').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          try {
            await apiFetch('/collections/' + encodeURIComponent(id) + '/assets/' + encodeURIComponent(btn.dataset.assetId), { method: 'DELETE' });
            refreshMembers();
          } catch (err) {
            reportActionFailure(err, {
              action: 'Remove asset from collection',
              detail: 'Asset ' + btn.dataset.assetId + ' is still a member of this collection.',
            });
          }
        });
      });
    }
    host.appendChild(assetsDiv);
  }
}

// ─── SEARCH TAB ──────────────────────────────────────────────────────────────
//
// Verified contract (CLAUDE.md rule 7) — GET /api/v1/search:
//   src/routes/search.ts `searchResultSchema` (the 200 response schema) returns
//   `{ assets, collections, total, collectionTotal, page }`, all five required.
//   - `assets`:          asset hits, each stamped `type: 'asset'`
//                        (`assetSchema.extend({ type: z.literal('asset') })`,
//                        stamped in the route handler's return).
//   - `collections`:     collection hits (`collectionHitSchema`), each carrying
//                        `type: 'collection'` plus id / name / description? /
//                        tags? / custom? / createdAt / updatedAt (issue #561).
//   - `total`:           count of matching ASSETS only.
//   - `collectionTotal`: count of matching COLLECTIONS, reported separately.
//   Mirrored in openapi.json at "/api/v1/search/".get.responses.200 (same five
//   required properties; `type` is an enum of the single literal on each side).
// Note the asset hit contract has no `tags`/`mimeType` field, so those columns
// stay '—' for asset rows (pre-existing behaviour); collection hits do carry
// `tags`, which the shared Tags column renders.

// Flatten one search response into a single ordered row list plus both counts.
// Asset hits come first, then collection hits. Each row keeps the `type`
// discriminator the server already stamped on the hit — the kind is never
// inferred from which fields happen to be present (see hitType below).
function normaliseSearchResults(res) {
  const envelope = res && typeof res === 'object' && !Array.isArray(res) ? res : {};
  // `assets` is the contract field; `items`/`results` are tolerated only so an
  // older/proxied envelope still lists something rather than nothing.
  const assetHits = Array.isArray(res) ? res
    : (Array.isArray(envelope.assets) ? envelope.assets
      : (Array.isArray(envelope.items) ? envelope.items
        : (Array.isArray(envelope.results) ? envelope.results : [])));
  const collectionHits = Array.isArray(envelope.collections) ? envelope.collections : [];

  const rows = assetHits.map(function(a) { return { type: hitType(a, 'asset'), item: a }; })
    .concat(collectionHits.map(function(c) { return { type: hitType(c, 'collection'), item: c }; }));

  const assetTotal = typeof envelope.total === 'number' ? envelope.total : assetHits.length;
  const collectionTotal = typeof envelope.collectionTotal === 'number'
    ? envelope.collectionTotal
    : collectionHits.length;

  return { rows: rows, assetTotal: assetTotal, collectionTotal: collectionTotal, total: assetTotal + collectionTotal };
}

// Read the discriminator off a hit. The server stamps `type` on every hit, so
// it is authoritative. `fallback` is the array the hit arrived in, used only if
// a hit somehow lacks the field (e.g. an older server): still provenance, not a
// guess at the shape.
function hitType(hit, fallback) {
  const t = hit && hit.type;
  return t === 'asset' || t === 'collection' ? t : fallback;
}

// "3 results (2 assets, 1 collection)" — the reported count covers both kinds.
function searchResultSummary(counts) {
  const plural = function(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); };
  return plural(counts.total, 'result') +
    ' (' + plural(counts.assetTotal, 'asset') + ', ' + plural(counts.collectionTotal, 'collection') + ')';
}

// Build the results view for one search response. Pure: takes the already-fetched
// envelope, performs no network call, returns a detached element.
// `opts.onOpenAsset(id)` / `opts.onOpenCollection(id)` handle a row click.
function renderSearchResults(res, opts) {
  opts = opts || {};
  const counts = normaliseSearchResults(res);
  const wrap = document.createElement('div');

  if (counts.rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    // "No results." only when BOTH counts are genuinely zero (issue #849).
    empty.textContent = (counts.assetTotal === 0 && counts.collectionTotal === 0)
      ? 'No results.'
      : 'No results on this page.';
    wrap.appendChild(empty);
    return wrap;
  }

  const summary = document.createElement('div');
  summary.className = 'text-muted search-result-summary';
  summary.textContent = searchResultSummary(counts);
  wrap.appendChild(summary);

  // Issue #851: the ID column carries the identifier every id-taking endpoint
  // accepts, as copyable text rather than a hover-only `title` tooltip.
  //
  // No Slug column here: the search projection does not return one. Verified
  // against `assetSchema` in src/routes/search.ts:73-100 (the shape wrapped by
  // `searchResultSchema.assets`, :118-131) and the generated spec — openapi.json
  // .paths["/api/v1/search/"].get...assets.items.properties has no `slug`,
  // unlike the list item schema on GET /api/v1/assets/ which does. Fastify
  // serializes against that schema, so a slug would be stripped even if the
  // repository returned it. `collectionHitSchema` (the collection side of the
  // same envelope, issue #561 — src/routes/search.ts:107-119) has no slug either. Widening either projection is
  // an API-contract change owned outside this UI fix and is NOT tracked by an
  // issue yet — do not read this comment as a filed follow-up.
  const rows = counts.rows.map(function(row) {
    const isCollection = row.type === 'collection';
    const hit = row.item || {};
    const id = hit.id == null ? '' : String(hit.id);
    const label = hit.title || hit.name || '—';
    const link = '<a href="#" class="search-hit-link" data-hit-type="' + escHtml(row.type) + '"' +
      ' data-hit-id="' + escHtml(id) + '" style="color:var(--accent)">' + escHtml(label) + '</a>';
    return '<tr class="search-hit" data-hit-type="' + escHtml(row.type) + '" data-hit-id="' + escHtml(id) + '">' +
      '<td><span class="tag search-hit-type">' + (isCollection ? 'Collection' : 'Asset') + '</span></td>' +
      '<td>' + copyableIdCellHtml(id, isCollection ? 'Copy collection id' : 'Copy asset id') + '</td>' +
      '<td>' + link + '</td>' +
      '<td>' + (isCollection ? '<span class="text-muted">—</span>' : renderBadge(hit.status)) + '</td>' +
      '<td>' + renderTags(hit.tags) + '</td>' +
      '<td>' + (isCollection ? '<span class="text-muted">—</span>' : escHtml((hit.technicalMetadata && hit.technicalMetadata.containerFormat) || '—')) + '</td>' +
      '<td>' + escHtml(fmtDate(hit.createdAt)) + '</td>' +
      '</tr>';
  }).join('');

  const tableWrap = document.createElement('div');
  tableWrap.className = 'table-wrap mt8';
  tableWrap.innerHTML = '<table>' +
    '<thead><tr><th>Type</th><th>ID</th><th>Name</th><th>Status</th><th>Tags</th><th>Container</th><th>Created</th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table>';
  wrap.appendChild(tableWrap);
  // #851's click-to-copy behaviour for the ID cells rendered above. Idempotent
  // and DOM-only, so it stays inside this pure renderer.
  wireCopyIdButtons(tableWrap);

  tableWrap.querySelectorAll('.search-hit-link').forEach(function(link) {
    link.addEventListener('click', function(ev) {
      ev.preventDefault();
      const id = link.dataset.hitId;
      if (!id) return;
      if (link.dataset.hitType === 'collection') {
        if (typeof opts.onOpenCollection === 'function') opts.onOpenCollection(id);
      } else if (typeof opts.onOpenAsset === 'function') {
        opts.onOpenAsset(id);
      }
    });
  });

  return wrap;
}

// The format filter on the Search tab (issue #822). GET /api/v1/search's
// `mimeType` parameter matches the asset's extracted container format
// (src/data/search-repo.ts matchesMimeTypeFilter -> technicalMetadata
// .containerFormat), and now resolves common media MIME types onto that
// container family server-side. The field is therefore labelled for BOTH
// vocabularies, and its placeholder is a value that can actually match.
const SEARCH_FORMAT_LABEL = 'MIME type or container format';
const SEARCH_FORMAT_PLACEHOLDER = 'video/mp4';
const SEARCH_FORMAT_HINT =
  'Matches the extracted container format — "video/mp4", "mp4" and "mov" all match an MP4.';

// Scope copy for the Search tab (issue #913). This tab is the only one whose
// results include collections as well as assets — GET /api/v1/search/ returns
// `{ assets, collections, ... }` and stamps each hit with a `type`
// discriminator (verified: src/routes/search.ts collectionHitSchema
// `type: z.literal('collection')`; openapi.json "/api/v1/search/").
// Nothing in the UI said so, so the heading, the section title and the query
// hint now name both kinds. Copy only: the request this tab sends is unchanged.
const SEARCH_TAB_TITLE = 'Search everything';
const SEARCH_SECTION_TITLE = 'Search assets and collections';
const SEARCH_SCOPE_HINT =
  'Full-text search across the whole workspace: assets and collections both match on ' +
  'name, description and tags. Container format matches assets only.';

async function renderSearchTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = SEARCH_TAB_TITLE;
  container.appendChild(title);

  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = [
    '<div class="section-title">' + escHtml(SEARCH_SECTION_TITLE) + '</div>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="search-q">Query</label>',
    '    <input type="text" id="search-q" placeholder="Full-text search…"',
    '      aria-describedby="search-scope-hint" />',
    '    <div class="form-hint" id="search-scope-hint">' + escHtml(SEARCH_SCOPE_HINT) + '</div>',
    '  </div>',
    '  <div class="form-field">',
    '    <label for="search-tags">Tags (comma-separated)</label>',
    '    <input type="text" id="search-tags" placeholder="news,sports" />',
    '  </div>',
    '  <div class="form-field">',
    '    <label for="search-mime">' + escHtml(SEARCH_FORMAT_LABEL) + '</label>',
    '    <input type="text" id="search-mime" placeholder="' + escHtml(SEARCH_FORMAT_PLACEHOLDER) + '"',
    '      aria-describedby="search-mime-hint" />',
    '    <div class="form-hint" id="search-mime-hint">' + escHtml(SEARCH_FORMAT_HINT) + '</div>',
    '  </div>',
    '  <button id="search-btn">Search</button>',
    '</div>',
    '<div id="search-results" class="mt8"></div>',
  ].join('');
  container.appendChild(section);

  section.querySelector('#search-btn').addEventListener('click', async function() {
    const q = section.querySelector('#search-q').value.trim();
    const tags = section.querySelector('#search-tags').value.trim();
    const mime = section.querySelector('#search-mime').value.trim();
    const resultsEl = section.querySelector('#search-results');
    resultsEl.innerHTML = '';
    const loader = loadingEl();
    resultsEl.appendChild(loader);

    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tags) params.set('tags', tags);
    if (mime) params.set('mimeType', mime);

    try {
      const res = await apiFetch('/search?' + params.toString());
      loader.remove();
      // The empty state, the row builder and the copyable ID column (#851) all
      // live in renderSearchResults now, so this handler only fetches and hands
      // the envelope over.
      resultsEl.appendChild(renderSearchResults(res, {
        // Same "switch tab, then open the detail panel" move the job → asset
        // link makes (see showJobDetail's onAssetLink).
        onOpenAsset: function(id) {
          switchTab('assets');
          const panel = document.getElementById('asset-detail');
          if (panel) showAssetDetail(id, panel);
        },
        onOpenCollection: openCollectionFromSearch,
      }));
    } catch (err) {
      loader.remove();
      showMsg(resultsEl, 'Error: ' + err.message, 'error');
    }
  });
}

// ─── WEBHOOKS TAB ────────────────────────────────────────────────────────────

const WEBHOOK_EVENTS = ['asset.ready', 'transcode.complete', 'package.complete', 'asset.failed'];

// ─── PROFILES TAB ────────────────────────────────────────────────────────────

// Encore transcoding profiles (issue #84). Profiles are persisted in CouchDB
// and served to Encore via the public GET /api/v1/profiles/index.yml. This tab
// lets an operator list profiles, view their YAML, create new ones, seed the
// store from the default Encore index (bootstrap), and delete profiles.
async function renderProfilesTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Transcoding profiles';
  container.appendChild(title);

  // Create form.
  const createSection = document.createElement('div');
  createSection.className = 'section';
  createSection.innerHTML = [
    '<div class="section-title">Add profile</div>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="pf-name">Name</label>',
    '    <input type="text" id="pf-name" placeholder="program" />',
    '  </div>',
    '</div>',
    '<div class="form-field mt8 grow">',
    '  <label for="pf-yaml">Profile YAML</label>',
    '  <textarea id="pf-yaml" rows="8" placeholder="name: program&#10;description: ..." style="width:100%;font-family:monospace;"></textarea>',
    '</div>',
    '<button id="pf-create-btn" class="mt8">Create</button>',
    '<div id="pf-create-msg"></div>',
  ].join('');
  container.appendChild(createSection);

  // List + bootstrap.
  const listSection = document.createElement('div');
  listSection.className = 'section';
  listSection.innerHTML = [
    '<div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">',
    '  <span>Configured profiles</span>',
    '  <span>',
    '    <button id="pf-bootstrap" class="btn-ghost" style="font-size:12px;padding:4px 10px;">Bootstrap from default index</button>',
    '    <button id="pf-refresh" class="btn-ghost" style="font-size:12px;padding:4px 10px;">Refresh</button>',
    '  </span>',
    '</div>',
    '<div id="pf-bootstrap-msg"></div>',
    '<div id="pf-list-wrap"></div>',
    '<div id="pf-yaml-view"></div>',
  ].join('');
  container.appendChild(listSection);

  async function loadProfiles() {
    const wrap = listSection.querySelector('#pf-list-wrap');
    wrap.innerHTML = '';
    const loader = loadingEl();
    wrap.appendChild(loader);
    let items = [];
    try {
      const res = await apiFetch('/profiles');
      items = res && Array.isArray(res.items) ? res.items : [];
    } catch (err) {
      loader.remove();
      showMsg(wrap, 'Failed: ' + err.message, 'error');
      return;
    }
    loader.remove();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No profiles configured. Use Bootstrap to seed from the default Encore index.';
      wrap.appendChild(empty);
      return;
    }
    const rows = items.map(function(p) {
      return '<tr>' +
        '<td class="cell-id">' + escHtml(p.name) + '</td>' +
        '<td>' + escHtml(fmtDate(p.updatedAt)) + '</td>' +
        '<td>' +
        '<button class="btn-ghost pf-view-btn" data-name="' + escHtml(p.name) + '" style="font-size:12px;padding:3px 8px;">View YAML</button> ' +
        '<button class="btn-danger pf-delete-btn" data-name="' + escHtml(p.name) + '" style="font-size:12px;padding:3px 8px;">Delete</button>' +
        '</td>' +
        '</tr>';
    }).join('');
    const tableWrap = document.createElement('div');
    tableWrap.className = 'table-wrap';
    tableWrap.innerHTML = '<table>' +
      '<thead><tr><th>Name</th><th>Updated</th><th>Actions</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table>';
    wrap.appendChild(tableWrap);

    tableWrap.querySelectorAll('.pf-view-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        const view = listSection.querySelector('#pf-yaml-view');
        view.innerHTML = '';
        try {
          const p = await apiFetch('/profiles/' + encodeURIComponent(btn.dataset.name));
          const box = document.createElement('div');
          box.className = 'section';
          const pre = document.createElement('pre');
          pre.style.whiteSpace = 'pre-wrap';
          pre.style.fontFamily = 'monospace';
          // textContent — never innerHTML — so YAML content cannot inject markup.
          pre.textContent = p.yaml || '';
          const head = document.createElement('div');
          head.className = 'section-title';
          head.textContent = 'YAML — ' + p.name;
          box.appendChild(head);
          box.appendChild(pre);
          view.appendChild(box);
        } catch (err) {
          showMsg(view, 'Error: ' + err.message, 'error');
        }
      });
    });

    tableWrap.querySelectorAll('.pf-delete-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        // Profile delete confirmation (issue #919). The profile NAME is the
        // resource's own human-readable identifier — profiles are addressed by
        // name, not by an opaque id (DELETE /api/v1/profiles/{name},
        // src/routes/profiles.ts:300-312), so naming the subject here is the name.
        // Impact wording verified, NOT assumed:
        //   - The handler calls `repo.delete(name)` and answers 204. No cascade,
        //     no children check, no soft-delete/restore path exists.
        //   - The deleted name also leaves GET /api/v1/profiles/index.yml, the
        //     public index the transcoder instances read (profiles.ts:19-20,
        //     :127-...).
        //   - A transcode naming a profile the store does not know is NOT
        //     rejected here: unrunnableProfileReason / uncarriableColourReason
        //     both return undefined for an unknown name and the name is
        //     "forwarded verbatim" to the transcoder (src/routes/assets.ts:
        //     1757-1764 and :1777-1786), which then fails the job.
        //   - Built-in profiles are re-created by every bootstrap run, including
        //     on server start (ensureBuiltinProfiles,
        //     src/services/profile-bootstrap.ts:76-91; startup call
        //     src/main.ts:1762).
        const label = nameOrFallback(btn.dataset.name, 'this profile');
        const ok = await confirmModal({
          title: 'Delete profile',
          subject: label,
          question: 'Delete transcoding profile "' + label + '"?',
          confirmLabel: 'Delete profile',
          affected: [
            'The profile’s YAML is removed from the store and drops out of the profile index the transcoders read.',
            'New transcodes that name "' + label + '" are no longer checked here; they are handed to the transcoder as-is and fail there.',
            'There is no undo and no restore for a deleted profile — re-adding it means pasting its YAML back in.',
          ],
          unaffected: [
            'Jobs that already ran with this profile keep their results: renditions, packaged output and job history are untouched.',
            'Assets, collections and every other profile are left alone.',
            'Profiles that ship built-in with this API are re-created automatically on the next server start.',
          ],
        });
        if (!ok) return;
        try {
          await apiFetch('/profiles/' + encodeURIComponent(btn.dataset.name), { method: 'DELETE' });
          listSection.querySelector('#pf-yaml-view').innerHTML = '';
          loadProfiles();
        } catch (err) {
          reportActionFailure(err, {
            action: 'Delete profile',
            detail: 'Profile "' + label + '" was not deleted.',
          });
        }
      });
    });
  }

  createSection.querySelector('#pf-create-btn').addEventListener('click', async function() {
    const name = createSection.querySelector('#pf-name').value.trim();
    const yaml = createSection.querySelector('#pf-yaml').value;
    const msgEl = createSection.querySelector('#pf-create-msg');
    msgEl.innerHTML = '';
    if (!name) { showMsg(msgEl, 'Name is required.', 'error'); return; }
    if (!yaml.trim()) { showMsg(msgEl, 'YAML content is required.', 'error'); return; }
    try {
      await apiFetch('/profiles', { method: 'POST', body: JSON.stringify({ name: name, yaml: yaml }) });
      showMsg(msgEl, 'Profile created.', 'success');
      createSection.querySelector('#pf-name').value = '';
      createSection.querySelector('#pf-yaml').value = '';
      loadProfiles();
    } catch (err) {
      showMsg(msgEl, 'Error: ' + err.message, 'error');
    }
  });

  listSection.querySelector('#pf-bootstrap').addEventListener('click', async function() {
    const msgEl = listSection.querySelector('#pf-bootstrap-msg');
    msgEl.innerHTML = '';
    // Seed confirmation (issue #919). This is a bulk WRITE over the profile
    // store, so it gets the same treatment as the deletes. Impact wording
    // verified against POST /api/v1/profiles/bootstrap
    // (src/routes/profiles.ts:184-206) and bootstrapProfiles
    // (src/services/profile-bootstrap.ts:128-183), NOT assumed:
    //   - This UI sends NO `?force=true`, so `force` is false.
    //   - Built-ins are ensured on EVERY run, unconditionally and BEFORE the
    //     skip guard: `const builtinSeeded = await ensureBuiltinProfiles(...)`
    //     (profile-bootstrap.ts:148, helper at :75-91). So a built-in that is
    //     currently MISSING is re-created even on the skip path — the skip
    //     return carries that count: `{ seeded: 0, skipped: true, builtinSeeded }`
    //     (:159, field documented at :50-53). This run is therefore never a
    //     guaranteed no-op, which is why it is stated under "what this affects".
    //   - An existing profile whose name matches a built-in is left untouched by
    //     that step, so an operator edit to a built-in survives (:82-84).
    //   - With force false, if any NON-built-in profile already exists the
    //     REMOTE seed is skipped: no index fetch, no create, no update
    //     (countNonBuiltinProfiles :66-69, skip guard :150-160).
    //   - When the remote seed does run, an index entry whose name already
    //     exists is OVERWRITTEN via `repository.update(entry.name, yaml)`
    //     (loop :166-179, update at :171). Since the skip guard means the store
    //     then holds only built-ins, the profile that can be overwritten is an
    //     edited built-in.
    //   - An unreachable index is a 502 `bootstrap_failed` (profiles.ts:201-204),
    //     so nothing is half-written from a failed fetch of the index itself.
    // The subject is the profile index, named for what it is rather than by an id.
    const seedOk = await confirmModal({
      title: 'Seed transcoding profiles',
      subject: 'the default transcoding profile index',
      question: 'Seed transcoding profiles from the default profile index?',
      confirmLabel: 'Seed profiles',
      affected: [
        'Every profile named in the default index is fetched and stored, so the profile list and the index the transcoders read both grow.',
        'If the only profiles stored right now are the ones that ship built-in with this API, a built-in whose name also appears in the index is overwritten — including any edit you made to it.',
        'Any profile that ships built-in with this API and is currently missing is re-created, on every run — including the runs where the remote seed is skipped. So this is never a guaranteed no-op.',
      ],
      unaffected: [
        'Nothing is deleted. Profiles that are not named in the index stay exactly as they are.',
        'If any profile you or an earlier seed added is already stored, the remote seed is skipped and no profile from the index is fetched or overwritten.',
        'No assets, collections or jobs are touched, and jobs that already ran keep their results.',
      ],
    });
    if (!seedOk) return;
    try {
      const res = await apiFetch('/profiles/bootstrap', { method: 'POST' });
      if (res && res.skipped) {
        showMsg(msgEl, 'Profiles already exist — bootstrap skipped.', 'success');
      } else {
        showMsg(msgEl, 'Seeded ' + (res ? res.seeded : 0) + ' profile(s).', 'success');
      }
      loadProfiles();
    } catch (err) {
      showMsg(msgEl, 'Error: ' + err.message, 'error');
    }
  });

  listSection.querySelector('#pf-refresh').addEventListener('click', loadProfiles);
  await loadProfiles();
}

// ─── WEBHOOKS TAB ────────────────────────────────────────────────────────────

async function renderWebhooksTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Webhooks';
  container.appendChild(title);

  // Register form
  const registerSection = document.createElement('div');
  registerSection.className = 'section';
  // All labels are static strings — no dynamic content
  const checkboxes = WEBHOOK_EVENTS.map(function(ev) {
    return '<label class="checkbox-label">' +
      '<input type="checkbox" name="wh-event" value="' + escHtml(ev) + '" checked />' +
      ' ' + escHtml(ev) +
      '</label>';
  }).join('');

  registerSection.innerHTML = [
    '<div class="section-title">Register webhook</div>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="wh-url">Endpoint URL</label>',
    '    <input type="url" id="wh-url" placeholder="https://example.com/webhook" />',
    '  </div>',
    '</div>',
    '<div class="form-field mt8">',
    '  <label>Events</label>',
    '  <div class="checkbox-group">' + checkboxes + '</div>',
    '</div>',
    '<button id="wh-register-btn" class="mt8">Register</button>',
    '<div id="wh-register-msg"></div>',
  ].join('');
  container.appendChild(registerSection);

  // List
  const listSection = document.createElement('div');
  listSection.className = 'section';
  listSection.innerHTML = [
    '<div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">',
    '  <span>Registered webhooks</span>',
    '  <button id="wh-refresh" class="btn-ghost" style="font-size:12px;padding:4px 10px;">Refresh</button>',
    '</div>',
    '<div id="wh-list-wrap"></div>',
  ].join('');
  container.appendChild(listSection);

  async function loadWebhooks() {
    const wrap = listSection.querySelector('#wh-list-wrap');
    wrap.innerHTML = '';
    const loader = loadingEl();
    wrap.appendChild(loader);
    let webhooks = [];
    try {
      const res = await apiFetch('/webhooks');
      webhooks = Array.isArray(res) ? res : (res && (res.items || res.webhooks) ? (res.items || res.webhooks) : []);
    } catch (err) {
      loader.remove();
      showMsg(wrap, 'Failed: ' + err.message, 'error');
      return;
    }
    loader.remove();
    if (webhooks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No webhooks registered.';
      wrap.appendChild(empty);
      return;
    }
    const rows = webhooks.map(function(wh) {
      const evTags = (wh.events || []).map(function(e) { return '<span class="tag">' + escHtml(e) + '</span>'; }).join(' ');
      return '<tr>' +
        '<td class="cell-id">' + escHtml(wh.id) + '</td>' +
        '<td style="word-break:break-all;">' + escHtml(wh.url || wh.endpoint || '—') + '</td>' +
        '<td>' + evTags + '</td>' +
        '<td>' + escHtml(fmtDate(wh.createdAt)) + '</td>' +
        // `data-url` / `data-events` / `data-has-secret` feed the delete
        // confirmation (issue #919). A registration has NO name field — the
        // authoritative read shape is { id, url, events, hasSecret, createdAt }
        // (registrationBaseSchema, src/routes/webhooks.ts:43-49) — so its URL is
        // the human-readable identifier a dialog can name it by.
        '<td><button class="btn-danger wh-delete-btn" data-id="' + escHtml(wh.id) +
          '" data-url="' + escHtml(wh.url || wh.endpoint || '') +
          '" data-events="' + escHtml((wh.events || []).join(', ')) +
          '" data-has-secret="' + (wh.hasSecret ? 'true' : 'false') +
          '" style="font-size:12px;padding:3px 8px;">Delete</button></td>' +
        '</tr>';
    }).join('');
    const tableWrap = document.createElement('div');
    tableWrap.className = 'table-wrap';
    tableWrap.innerHTML = '<table>' +
      '<thead><tr><th>ID</th><th>URL</th><th>Events</th><th>Created</th><th>Actions</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table>';
    wrap.appendChild(tableWrap);

    tableWrap.querySelectorAll('.wh-delete-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        // Webhook delete confirmation (issue #919). Impact wording verified
        // against DELETE /api/v1/webhooks/{id}
        // (src/routes/webhooks.ts:143-158), NOT assumed:
        //   - The handler calls `repo.delete(id)` and is idempotent; 204 either
        //     way. No cascade, no restore path.
        //   - The registration is workspace-scoped, so only this workspace stops
        //     notifying that URL (router header :3-8).
        //   - A signing secret is never readable back: "There is deliberately no
        //     read-back path: a caller who loses a secret re-registers"
        //     (:25-26); the list shape has no `secret` field at all
        //     (listedRegistrationSchema, :59).
        const url = nameOrFallback(btn.dataset.url, 'this webhook');
        const events = btn.dataset.events || '';
        const affected = [
          'This workspace stops sending event notifications to ' + url + '.',
        ];
        if (events) {
          affected.push('The events it was subscribed to — ' + events + ' — are no longer delivered to that URL.');
        }
        if (btn.dataset.hasSecret === 'true') {
          affected.push('Its signing secret goes with it. Secrets cannot be read back, so re-registering means issuing a new one.');
        }
        affected.push('The delete takes effect immediately and cannot be undone.');
        const ok = await confirmModal({
          title: 'Delete webhook',
          subject: url,
          question: 'Stop sending events to ' + url + '?',
          detail: 'Registration id: ' + (btn.dataset.id || '—'),
          confirmLabel: 'Delete webhook',
          affected: affected,
          unaffected: [
            'Nothing that produces the events changes: assets, jobs and pipelines carry on exactly as before.',
            'Notifications already delivered are not recalled, and your other webhook registrations keep receiving events.',
            'The receiving service itself is untouched — this only removes the registration here.',
          ],
        });
        if (!ok) return;
        try {
          await apiFetch('/webhooks/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
          loadWebhooks();
        } catch (err) {
          reportActionFailure(err, {
            action: 'Delete webhook',
            detail: 'The registration for ' + url + ' is still in place.',
          });
        }
      });
    });
  }

  registerSection.querySelector('#wh-register-btn').addEventListener('click', async function() {
    const url = registerSection.querySelector('#wh-url').value.trim();
    const events = Array.from(registerSection.querySelectorAll('input[name="wh-event"]:checked')).map(function(cb) { return cb.value; });
    const msgEl = registerSection.querySelector('#wh-register-msg');
    msgEl.innerHTML = '';
    if (!url) { showMsg(msgEl, 'URL is required.', 'error'); return; }
    if (events.length === 0) { showMsg(msgEl, 'Select at least one event.', 'error'); return; }
    try {
      await apiFetch('/webhooks', { method: 'POST', body: JSON.stringify({ url: url, events: events }) });
      showMsg(msgEl, 'Webhook registered.', 'success');
      registerSection.querySelector('#wh-url').value = '';
      loadWebhooks();
    } catch (err) {
      showMsg(msgEl, 'Error: ' + err.message, 'error');
    }
  });

  listSection.querySelector('#wh-refresh').addEventListener('click', loadWebhooks);
  await loadWebhooks();
}

// ─── STORAGE TAB ─────────────────────────────────────────────────────────────

async function renderStorageTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Storage';
  container.appendChild(title);

  // ── Storage backends list view (issue #680) ──
  // Consolidated view of every configured backend before an operator manages
  // them. Calls GET /api/v1/storage/backends (src/routes/storage.ts:261-274)
  // and renders each backend's name, endpoint, bucket, region + a status badge.
  const backendsSection = document.createElement('div');
  backendsSection.className = 'section';
  backendsSection.innerHTML =
    '<div class="section-header">' +
    '  <div class="section-title">Storage backends</div>' +
    '  <button type="button" id="storage-add-backend-btn" class="btn-sm">Add backend</button>' +
    '</div>' +
    '<div id="storage-backend-form-mount"></div>' +
    '<div id="storage-backends-mount"></div>';
  container.appendChild(backendsSection);
  const backendsMount = backendsSection.querySelector('#storage-backends-mount');
  const formMount = backendsSection.querySelector('#storage-backend-form-mount');
  const addBtn = backendsSection.querySelector('#storage-add-backend-btn');

  // Cache of the last-fetched backend views so the edit form can pre-populate
  // its non-secret fields from the already-redacted list payload (issue #681)
  // without a second round-trip. The secret is never present here.
  let backendsById = {};

  // Show the add/edit form as a new mode of the Storage tab (issue #681). The
  // list stays mounted below; on success we close the form and reload the list
  // so the new/updated entry is visible (acceptance criterion).
  function openBackendForm(mode, backend) {
    formMount.innerHTML = '';
    addBtn.disabled = true;
    const form = renderStorageBackendForm(mode, backend);
    const msgEl = form.querySelector('[data-form-msg]');
    const testResultEl = form.querySelector('[data-test-result]');
    const submitBtn = form.querySelector('.storage-backend-submit');
    const testBtn = form.querySelector('.storage-backend-test');
    const cancelBtn = form.querySelector('.storage-backend-cancel');
    const isEdit = mode === 'edit';
    const backendId = isEdit && backend ? backend.id : null;

    function closeForm() {
      formMount.innerHTML = '';
      addBtn.disabled = false;
      addBtn.focus();
    }

    // Read the six field values off the rendered inputs.
    function readValues() {
      const out = {};
      form.querySelectorAll('.storage-backend-input').forEach(function(inp) {
        out[inp.dataset.field] = inp.value;
      });
      return out;
    }

    cancelBtn.addEventListener('click', closeForm);

    // Test connection (issue #681). POST /storage/backends/{id}/test-connection
    // requires an id + a secret to probe with (storage.ts:206-213, issue-679).
    // On add the backend has no id yet, so the operator must save first; we say
    // so inline rather than silently no-op.
    testBtn.addEventListener('click', async function() {
      testResultEl.textContent = '';
      testResultEl.className = 'storage-backend-test-result';
      const values = readValues();
      const secret = (values.secretAccessKey || '').trim();
      if (!backendId) {
        testResultEl.textContent =
          'Save the backend first, then use Test connection to probe it.';
        testResultEl.classList.add('is-info');
        return;
      }
      if (!secret) {
        testResultEl.textContent =
          'Enter the secret access key to test the connection.';
        testResultEl.classList.add('is-info');
        return;
      }
      testBtn.disabled = true;
      testResultEl.textContent = 'Testing…';
      try {
        // Shared probe helper (issue #683) — same call the per-row action uses.
        const result = await testStorageBackendConnection(backendId, secret);
        // Response contract: { status: 'connected' | 'unreachable', message }.
        const ok = result && result.status === 'connected';
        testResultEl.textContent =
          (ok ? 'Connected: ' : 'Unreachable: ') +
          (result && result.message ? result.message : (result && result.status) || 'unknown');
        testResultEl.classList.add(ok ? 'is-success' : 'is-failure');
      } catch (err) {
        testResultEl.textContent = 'Test failed: ' + err.message;
        testResultEl.classList.add('is-failure');
      } finally {
        testBtn.disabled = false;
      }
    });

    form.addEventListener('submit', async function(ev) {
      ev.preventDefault();
      if (msgEl) msgEl.textContent = '';
      const values = readValues();
      const result = validateStorageBackendForm(mode, values);
      const firstErr = applyStorageBackendFormErrors(form, result.errors);
      if (!result.valid) {
        if (firstErr) {
          const el = form.querySelector('.storage-backend-input[data-field="' + firstErr + '"]');
          if (el) el.focus();
        }
        return;
      }
      submitBtn.disabled = true;
      testBtn.disabled = true;
      try {
        if (isEdit) {
          await apiFetch('/storage/backends/' + encodeURIComponent(backendId), {
            method: 'PATCH',
            body: JSON.stringify(result.body),
          });
        } else {
          await apiFetch('/storage/backends', {
            method: 'POST',
            body: JSON.stringify(result.body),
          });
        }
        // Success: land back on the list with the new/updated entry visible.
        closeForm();
        await loadBackends();
        showMsg(
          backendsMount,
          isEdit ? 'Storage backend updated.' : 'Storage backend added.',
          'success'
        );
      } catch (err) {
        submitBtn.disabled = false;
        testBtn.disabled = false;
        if (msgEl) {
          msgEl.textContent = 'Error: ' + err.message;
          msgEl.className = 'storage-backend-form-msg is-failure';
        }
      }
    });

    formMount.appendChild(form);
    const firstInput = form.querySelector('.storage-backend-input');
    if (firstInput) firstInput.focus();
  }

  addBtn.addEventListener('click', function() {
    openBackendForm('add', null);
  });

  async function loadBackends() {
    backendsMount.innerHTML = '';
    const loader = loadingEl();
    backendsMount.appendChild(loader);
    let data;
    try {
      data = await apiFetch('/storage/backends');
    } catch (err) {
      loader.remove();
      // 501 = registry not configured; surface non-fatally so the buckets view
      // below still loads (src/routes/storage.ts:265-270).
      showMsg(backendsMount, 'Storage backends unavailable: ' + err.message, 'info');
      return;
    }
    loader.remove();
    backendsById = {};
    (data && Array.isArray(data.backends) ? data.backends : []).forEach(function(b) {
      if (b && b.id != null) backendsById[String(b.id)] = b;
    });
    const listEl = renderStorageBackendsList(data && data.backends);
    // Wire the Remove control only for deletable (non-default) backends. The
    // default's control is already disabled by the pure render (issue #680).
    // Clicking Remove opens a guarded confirmation dialog (issue #682); the
    // DELETE call is made ONLY on explicit confirmation inside that dialog.
    listEl.querySelectorAll('.storage-backend-delete').forEach(function(btn) {
      if (btn.disabled) return;
      btn.addEventListener('click', function() {
        const row = btn.closest('.storage-backend-row');
        const id = row && row.dataset.backendId;
        if (!id) return;
        const backend = backendsById[id] || { id: id };
        openStorageBackendRemoveDialog(backend, {
          onRemoved: function() {
            // Remove the entry from the rendered list immediately, without a
            // full reload (acceptance criterion). Drop the cache entry too so a
            // later edit/list stays consistent.
            if (row && row.parentNode) row.remove();
            delete backendsById[id];
            // If that was the last backend row, show the empty state the pure
            // render would produce for an empty array.
            if (!listEl.querySelector('.storage-backend-row')) {
              const table = listEl.querySelector('.storage-backends-table');
              if (table) table.remove();
              if (!listEl.querySelector('.empty')) {
                const empty = document.createElement('div');
                empty.className = 'empty';
                empty.textContent = 'No storage backends available.';
                listEl.appendChild(empty);
              }
            }
          },
        });
      });
    });
    // Inject an Edit control per editable (non-default) row (issue #681). The
    // default backend is immutable (PATCH returns 403, storage.ts issue-679), so
    // it gets no Edit button — we detect it via the row's is-default class the
    // list view already sets.
    listEl.querySelectorAll('.storage-backend-row').forEach(function(row) {
      if (row.classList.contains('is-default')) return;
      const id = row.dataset.backendId;
      if (!id) return;
      const actionsTd = row.querySelector('.storage-backend-actions');
      if (!actionsTd) return;
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn-sm storage-backend-edit';
      edit.textContent = 'Edit';
      edit.addEventListener('click', function() {
        openBackendForm('edit', backendsById[id] || { id: id });
      });
      actionsTd.insertBefore(edit, actionsTd.firstChild);
    });

    // Wire the per-row Test connection control (issue #683) for EVERY row,
    // default included. The secret was never persisted (ADR-017 D1), so an
    // external backend's probe needs the operator to re-supply it; we prompt for
    // it inline. The default is answered `connected` without a probe (registry
    // short-circuits on id 'default'), so we send a non-empty placeholder to
    // satisfy the required-field schema and never ask for a secret.
    listEl.querySelectorAll('.storage-backend-test-conn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const row = btn.closest('.storage-backend-row');
        const rowId = row && row.dataset.backendId;
        if (!rowId) return;
        const isDefault = row.classList.contains('is-default');
        if (isDefault) {
          runRowTest(row, rowId, STORAGE_TEST_DEFAULT_SECRET);
        } else {
          openRowTestSecretPrompt(row, rowId);
        }
      });
    });
    backendsMount.appendChild(listEl);
  }

  // Run a probe against one row and reflect the result inline (issue #683):
  // spinner while in flight, then Connected / Unreachable (+ message on failure
  // or timeout). Disables the row's Test button for the duration so a double
  // click can't launch two probes.
  async function runRowTest(row, backendId, secret) {
    const btn = row.querySelector('.storage-backend-test-conn');
    if (btn) btn.disabled = true;
    setStorageBackendRowProbing(row);
    try {
      const result = await testStorageBackendConnection(backendId, secret);
      applyStorageBackendRowTestResult(row, result);
    } catch (err) {
      // Network / HTTP failure or the client-side 10s timeout: render as an
      // Unreachable outcome carrying the error message (acceptance criterion).
      applyStorageBackendRowTestResult(row, {
        status: 'unreachable',
        message: err && err.message ? err.message : 'Connection test failed.',
      });
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // Prompt the operator for the secret to probe an external backend with, then
  // run the row test (issue #683). The secret is held only in memory for the
  // duration of the call (CLAUDE.md: never persist tokens) and is never written
  // back into the redacted list cache.
  function openRowTestSecretPrompt(row, backendId) {
    const cached = backendsById[backendId] || {};
    const name = cached.name ? String(cached.name) : backendId;
    openModal('Test connection', function(body, close) {
      body.classList.add('storage-test-dialog');

      const prompt = document.createElement('p');
      prompt.className = 'storage-test-prompt';
      prompt.textContent =
        'Re-enter the secret access key for "' + name +
        '" to probe its reachability. It is used only for this test and never stored.';
      body.appendChild(prompt);

      const label = document.createElement('label');
      label.className = 'form-field';
      label.textContent = 'Secret access key';
      const input = document.createElement('input');
      input.type = 'password';
      input.className = 'storage-test-secret';
      input.autocomplete = 'off';
      label.appendChild(input);
      body.appendChild(label);

      const errEl = document.createElement('div');
      errEl.className = 'storage-test-error';
      errEl.setAttribute('role', 'alert');
      errEl.style.display = 'none';
      body.appendChild(errEl);

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn-sm storage-test-cancel';
      cancelBtn.textContent = 'Cancel';
      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'btn-sm storage-test-run';
      runBtn.textContent = 'Test connection';
      actions.appendChild(cancelBtn);
      actions.appendChild(runBtn);
      body.appendChild(actions);

      cancelBtn.addEventListener('click', close);
      runBtn.addEventListener('click', function() {
        const secret = input.value.trim();
        if (!secret) {
          errEl.textContent = 'Enter the secret access key to test the connection.';
          errEl.style.display = '';
          input.focus();
          return;
        }
        close();
        runRowTest(row, backendId, secret);
      });
      input.focus();
    });
  }

  // Create-bucket form
  const createSection = document.createElement('div');
  createSection.className = 'section';
  createSection.innerHTML = [
    '<div class="section-title">Create bucket</div>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="bucket-name">Bucket name</label>',
    '    <input type="text" id="bucket-name" placeholder="my-bucket (3-63 chars, a-z 0-9 -)" />',
    '  </div>',
    '  <button id="bucket-create-btn">Create</button>',
    '</div>',
    '<div id="bucket-create-msg"></div>',
  ].join('');
  container.appendChild(createSection);

  // Bucket list section
  const bucketsSection = document.createElement('div');
  bucketsSection.className = 'section';
  bucketsSection.innerHTML = '<div class="section-title">Buckets</div><div id="buckets-wrap"></div>';
  container.appendChild(bucketsSection);

  // Browser panel (hidden until a bucket is selected)
  const browser = document.createElement('div');
  browser.id = 'storage-browser';
  browser.style.display = 'none';
  container.appendChild(browser);

  const bucketsWrap = bucketsSection.querySelector('#buckets-wrap');

  async function loadBuckets() {
    bucketsWrap.innerHTML = '';
    const loader = loadingEl();
    bucketsWrap.appendChild(loader);

    let buckets = [];
    try {
      buckets = await apiFetch('/storage/buckets');
    } catch (err) {
      loader.remove();
      showMsg(bucketsWrap, 'Failed to load buckets: ' + err.message, 'error');
      return;
    }
    loader.remove();

    if (!buckets || buckets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No buckets configured.';
      bucketsWrap.appendChild(empty);
      return;
    }

    const cards = document.createElement('div');
    cards.className = 'bucket-cards';
    buckets.forEach(function(b) {
      const card = document.createElement('div');
      card.className = 'bucket-card';
      const badgeCls = b.role === 'source' ? 'badge-pending' : (b.role === 'packaged' ? 'badge-ready' : 'badge-unknown');
      card.innerHTML =
        '<div class="bucket-card-name">📦 ' + escHtml(b.name) + '</div>' +
        '<span class="badge ' + badgeCls + '">' + escHtml(b.role) + '</span>';
      card.addEventListener('click', function() {
        cards.querySelectorAll('.bucket-card').forEach(function(c) { c.classList.remove('active'); });
        card.classList.add('active');
        openBucketBrowser(browser, b.name, '');
      });
      cards.appendChild(card);
    });
    bucketsWrap.appendChild(cards);
  }

  createSection.querySelector('#bucket-create-btn').addEventListener('click', async function() {
    const input = createSection.querySelector('#bucket-name');
    const name = input.value.trim();
    const msgEl = createSection.querySelector('#bucket-create-msg');
    msgEl.innerHTML = '';
    if (!name) { showMsg(msgEl, 'Bucket name is required.', 'error'); return; }
    if (!/^[a-zA-Z0-9-]{3,63}$/.test(name)) {
      showMsg(msgEl, 'Name must be 3-63 alphanumeric characters and hyphens.', 'error');
      return;
    }
    try {
      await apiFetch('/storage/buckets', { method: 'POST', body: JSON.stringify({ name: name }) });
      showMsg(msgEl, 'Bucket "' + name + '" created.', 'success');
      input.value = '';
      await loadBuckets();
    } catch (err) {
      showMsg(msgEl, 'Error: ' + err.message, 'error');
    }
  });

  await loadBackends();
  await loadBuckets();
}

async function renderWatchFolderToggle(wfEl, bucket) {
  wfEl.innerHTML = '';
  let status;
  try {
    status = await apiFetch('/storage/buckets/' + encodeURIComponent(bucket) + '/watch-folder');
  } catch (err) {
    // Watch-folder not configured (501) or other error — surface nothing
    // intrusive; the feature is optional.
    showMsg(wfEl, 'Watch folder unavailable: ' + err.message, 'info');
    return;
  }

  const btn = document.createElement('button');
  btn.className = 'btn-sm';
  const active = status.enabled && status.running;
  btn.textContent = active ? '⏹ Disable watch folder' : '▶ Enable watch folder';
  btn.addEventListener('click', async function() {
    btn.disabled = true;
    try {
      await apiFetch('/storage/buckets/' + encodeURIComponent(bucket) + '/watch-folder/toggle', { method: 'POST' });
      await renderWatchFolderToggle(wfEl, bucket);
    } catch (err) {
      showMsg(wfEl, 'Error: ' + err.message, 'error');
      btn.disabled = false;
    }
  });
  wfEl.appendChild(btn);
}

async function openBucketBrowser(browser, bucket, prefix) {
  browser.style.display = 'block';
  browser.className = 'section';
  browser.innerHTML = [
    '<div class="section-title">Bucket: ' + escHtml(bucket) + '</div>',
    '<div id="storage-watch-folder" class="mt8"></div>',
    '<div id="storage-breadcrumb" class="breadcrumb"></div>',
    '<div id="storage-objects"></div>',
  ].join('');

  // Watch-folder toggle for this bucket.
  const wfEl = browser.querySelector('#storage-watch-folder');
  renderWatchFolderToggle(wfEl, bucket);

  // Breadcrumb trail — each segment clickable, narrows the prefix.
  const crumb = browser.querySelector('#storage-breadcrumb');
  const segments = prefix.split('/').filter(Boolean);
  const rootLink = document.createElement('a');
  rootLink.href = '#';
  rootLink.className = 'crumb-seg';
  rootLink.textContent = '(root)';
  rootLink.addEventListener('click', function(e) { e.preventDefault(); openBucketBrowser(browser, bucket, ''); });
  crumb.appendChild(rootLink);
  let acc = '';
  segments.forEach(function(seg) {
    acc += seg + '/';
    const sep = document.createTextNode(' / ');
    crumb.appendChild(sep);
    const link = document.createElement('a');
    link.href = '#';
    link.className = 'crumb-seg';
    link.textContent = seg;
    const target = acc;
    link.addEventListener('click', function(e) { e.preventDefault(); openBucketBrowser(browser, bucket, target); });
    crumb.appendChild(link);
  });

  const objectsEl = browser.querySelector('#storage-objects');
  const loader = loadingEl();
  objectsEl.appendChild(loader);

  let data;
  try {
    const qs = new URLSearchParams();
    if (prefix) qs.set('prefix', prefix);
    data = await apiFetch('/storage/buckets/' + encodeURIComponent(bucket) + '/objects' + (qs.toString() ? '?' + qs.toString() : ''));
  } catch (err) {
    loader.remove();
    showMsg(objectsEl, 'Failed to list objects: ' + err.message, 'error');
    return;
  }
  loader.remove();

  const objects = (data && data.objects) || [];
  if (objects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No objects in this location.';
    objectsEl.appendChild(empty);
    return;
  }

  const rows = objects.map(function(o) {
    // Display only the portion of the key below the current prefix.
    const display = prefix && o.key.indexOf(prefix) === 0 ? o.key.slice(prefix.length) : o.key;
    if (o.isPrefix) {
      return '<tr>' +
        '<td><a href="#" class="storage-folder" data-prefix="' + escHtml(o.key) + '">📁 ' + escHtml(display) + '</a></td>' +
        '<td>—</td>' +
        '<td>—</td>' +
        '<td></td>' +
        '</tr>';
    }
    return '<tr>' +
      '<td>' + escHtml(display) + '</td>' +
      '<td>' + escHtml(fmtBytes(o.size)) + '</td>' +
      '<td>' + escHtml(fmtDate(o.lastModified)) + '</td>' +
      // `data-name` is the same prefix-relative filename the Name column shows —
      // the human-readable subject for the delete confirmation (issue #919). The
      // full workspace-local key stays on `data-key` because that is what the
      // request path is built from.
      '<td><button class="btn-danger storage-delete-btn" data-key="' + escHtml(o.key) + '" data-name="' + escHtml(display) + '" style="font-size:12px;padding:3px 8px;">Delete</button></td>' +
      '</tr>';
  }).join('');

  const tableWrap = document.createElement('div');
  tableWrap.className = 'table-wrap';
  tableWrap.innerHTML = '<table>' +
    '<thead><tr><th>Name</th><th>Size</th><th>Last modified</th><th>Actions</th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table>';
  objectsEl.appendChild(tableWrap);

  tableWrap.querySelectorAll('.storage-folder').forEach(function(link) {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      openBucketBrowser(browser, bucket, link.dataset.prefix);
    });
  });

  tableWrap.querySelectorAll('.storage-delete-btn').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      // Object delete confirmation (issue #919). Impact wording verified against
      // DELETE /api/v1/storage/buckets/{bucket}/objects/*
      // (src/routes/storage.ts:711-746), NOT assumed:
      //   - The handler calls `conns.storageClient.removeObject(bucket, localKey)`
      //     and answers 204. That is the ONLY thing it does: it touches no asset
      //     document, so an asset that references this object keeps pointing at a
      //     key that no longer exists.
      //   - Exactly one object is removed. There is no recursive/prefix variant
      //     on this route, so sibling objects under the same folder survive.
      //   - There is no soft delete and no restore path here — unlike an archived
      //     asset, a removed object is simply gone.
      const label = nameOrFallback(btn.dataset.name, btn.dataset.key, 'this object');
      const ok = await confirmModal({
        title: 'Delete object',
        subject: label,
        question: 'Delete the file "' + label + '" from bucket "' + bucket + '"?',
        detail: 'Full object key: ' + (btn.dataset.key || '—'),
        confirmLabel: 'Delete object',
        affected: [
          'This one object is removed from the bucket straight away. There is no soft delete and no undo — you would have to re-upload the file.',
          'Any asset that still references this object keeps its reference, so downloading, playing back or re-running a pipeline for that asset will fail until the file is put back.',
        ],
        unaffected: [
          'No asset record, rendition list or job is updated — this is a raw bucket operation, not an asset delete.',
          'Every other object in the bucket, including anything else in this folder, is left alone.',
        ],
      });
      if (!ok) return;
      try {
        const path = btn.dataset.key.split('/').map(encodeURIComponent).join('/');
        await apiFetch('/storage/buckets/' + encodeURIComponent(bucket) + '/objects/' + path, { method: 'DELETE' });
        openBucketBrowser(browser, bucket, prefix);
      } catch (err) {
        reportActionFailure(err, {
          action: 'Delete object',
          detail: '"' + label + '" is still in bucket "' + bucket + '".',
        });
      }
    });
  });
}

// ─── PROVISION TAB ───────────────────────────────────────────────────────────

async function renderProvisionTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Provision OSC Stack';
  container.appendChild(title);

  // Active operations — shown on load so in-progress ops survive tab switches / reloads.
  const opsSection = document.createElement('div');
  opsSection.className = 'section';
  const opsSectionTitle = document.createElement('div');
  opsSectionTitle.className = 'section-title';
  opsSectionTitle.textContent = 'Active operations';
  opsSection.appendChild(opsSectionTitle);
  const opsContent = document.createElement('div');
  opsSection.appendChild(opsContent);
  container.appendChild(opsSection);

  const activeOpIds = new Set();

  function renderOpRow(op) {
    const isDone = op.status === 'done';
    const isFailed = op.status === 'failed';
    const row = document.createElement('div');
    row.id = 'op-' + op.id;
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--border,#333);font-size:13px;';

    const icon = document.createElement('span');
    icon.style.cssText = 'min-width:16px;margin-top:1px;';
    icon.textContent = isDone ? '✓' : isFailed ? '✗' : '⟳';

    const body = document.createElement('div');
    const label = document.createElement('span');
    label.style.fontWeight = 'bold';
    label.textContent = op.type + ' ';
    const nameSpan = document.createElement('span');
    nameSpan.style.fontFamily = 'monospace';
    nameSpan.textContent = op.name;
    const statusSpan = document.createElement('span');
    statusSpan.style.cssText = 'margin-left:8px;opacity:.7;';
    statusSpan.textContent = op.status;
    body.appendChild(label);
    body.appendChild(nameSpan);
    body.appendChild(statusSpan);
    if (op.error) {
      const errEl = document.createElement('div');
      errEl.style.cssText = 'font-size:11px;opacity:.7;margin-top:2px;color:var(--color-danger,#f66);';
      errEl.textContent = op.error;
      body.appendChild(errEl);
    }

    row.appendChild(icon);
    row.appendChild(body);
    return row;
  }

  function upsertOpRow(op) {
    const existing = opsContent.querySelector('#op-' + op.id);
    const row = renderOpRow(op);
    if (existing) existing.replaceWith(row);
    else opsContent.prepend(row);
  }

  function pollOp(op) {
    if (activeOpIds.has(op.id)) return;
    activeOpIds.add(op.id);
    const tick = function() {
      apiFetch('/provision/operations/' + encodeURIComponent(op.id)).then(function(updated) {
        upsertOpRow(updated);
        if (updated.status !== 'done' && updated.status !== 'failed') {
          setTimeout(tick, 3000);
        } else {
          activeOpIds.delete(op.id);
          // Hide the section once no active ops remain.
          const row = opsContent.querySelector('#op-' + op.id);
          if (row) row.remove();
          if (!activeOpIds.size) opsSection.style.display = 'none';
        }
      }).catch(function() {
        setTimeout(tick, 5000);
      });
    };
    setTimeout(tick, 3000);
  }

  function refreshOpsSection() {
    apiFetch('/provision/operations').then(function(ops) {
      const active = (ops || []).filter(function(op) {
        return op.status === 'pending' || op.status === 'running';
      });
      opsSection.style.display = active.length ? '' : 'none';
      active.forEach(function(op) {
        upsertOpRow(op);
        pollOp(op);
      });
    }).catch(function() {});
  }
  opsSection.style.display = 'none';
  refreshOpsSection();

  // Stack list
  const listSection = document.createElement('div');
  listSection.className = 'section';
  const listContent = document.createElement('div');
  listContent.id = 'stacks-list';
  listContent.appendChild(loadingEl());
  listSection.innerHTML = '<div class="section-title">Provisioned stacks</div>';
  listSection.appendChild(listContent);
  container.appendChild(listSection);

  // Detail panel (hidden until a stack is clicked)
  const detailSection = document.createElement('div');
  detailSection.className = 'section';
  detailSection.style.display = 'none';
  detailSection.id = 'stack-detail';
  listSection.appendChild(detailSection);

  function showStackDetail(name) {
    detailSection.textContent = '';
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = 'Stack: ' + name;
    detailSection.appendChild(title);
    detailSection.appendChild(loadingEl());
    detailSection.style.display = 'block';
    apiFetch('/provision/' + encodeURIComponent(name)).then(function(data) {
      detailSection.textContent = '';
      const t2 = document.createElement('div');
      t2.className = 'section-title';
      t2.textContent = 'Stack: ' + name;
      detailSection.appendChild(t2);
      const table = document.createElement('table');
      Object.entries(data)
        .filter(function(e) { return e[0] !== 'services'; })
        .forEach(function(e) {
          const tr = document.createElement('tr');
          const kd = document.createElement('td');
          kd.style.cssText = 'color:var(--text-muted);white-space:nowrap;padding-right:16px';
          kd.textContent = e[0];
          const vd = document.createElement('td');
          vd.style.cssText = 'word-break:break-all;font-family:monospace;font-size:12px';
          vd.textContent = String(e[1]);
          tr.appendChild(kd);
          tr.appendChild(vd);
          table.appendChild(tr);
        });
      detailSection.appendChild(table);
    }).catch(function(err) {
      detailSection.textContent = '';
      const p = document.createElement('p');
      p.className = 'text-muted';
      p.textContent = err.message;
      detailSection.appendChild(p);
    });
  }

  function pollDeprovisionOp(opId, statusEl, rowEl) {
    apiFetch('/provision/operations/' + encodeURIComponent(opId)).then(function(op) {
      if (op.status === 'done') {
        statusEl.textContent = '✓ removed';
        statusEl.style.color = 'var(--color-success, #4caf50)';
        if (rowEl) rowEl.remove();
      } else if (op.status === 'failed') {
        statusEl.textContent = '✗ ' + (op.error || 'failed');
        statusEl.style.color = 'var(--color-danger, #f44)';
      } else {
        statusEl.textContent = op.status + '…';
        setTimeout(function() { pollDeprovisionOp(opId, statusEl, rowEl); }, 3000);
      }
    }).catch(function() {
      setTimeout(function() { pollDeprovisionOp(opId, statusEl, rowEl); }, 5000);
    });
  }

  apiFetch('/provision').then(function(names) {
    listContent.textContent = '';
    if (!names.length) {
      const p = document.createElement('p');
      p.className = 'text-muted';
      p.textContent = 'No stacks provisioned yet.';
      listContent.appendChild(p);
      return;
    }
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    ['Name', '', ''].forEach(function(h) {
      const th = document.createElement('th');
      th.textContent = h;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    names.forEach(function(name) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = name;

      const tdBtn = document.createElement('td');
      const detailBtn = document.createElement('button');
      detailBtn.className = 'btn-sm';
      detailBtn.textContent = 'Details';
      detailBtn.addEventListener('click', function() { showStackDetail(name); });
      tdBtn.appendChild(detailBtn);

      const tdRemove = document.createElement('td');
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-sm btn-danger';
      removeBtn.textContent = 'Remove';
      const statusSpan = document.createElement('span');
      statusSpan.style.cssText = 'margin-left:8px;font-size:12px;';
      removeBtn.addEventListener('click', async function() {
        // Stack removal confirmation (issue #919). This is the most destructive
        // action in the UI, so the wording is grounded line by line in the real
        // teardown, NOT assumed:
        //   - DELETE /api/v1/provision/{name} (src/routes/provision.ts:1578-1760)
        //     returns 202 and tears the stack down in the background.
        //   - The stack's static services are storage, database and queue
        //     (STACK_SERVICES, src/services/stack.ts:32-36); teardown order
        //     prepends the on-demand packager (TEARDOWN_ORDER, :120-123).
        //   - The store-backed path additionally tears down the auto-scaled
        //     transcoder instances first (scaler teardown, provision.ts:1650-1665)
        //     and any optional auto-subtitles / scene-detect instance recorded on
        //     the stack config (deprovisionStackFromConfig call, :1703-1719).
        //   - Because the object store and the database ARE stack services, every
        //     asset record and every stored file in this stack go with them.
        //   - The stored stack coordinates are deleted only after teardown
        //     succeeds; a failed teardown deliberately keeps them so a retry can
        //     finish the job (:1721-1743). Teardown is idempotent per service
        //     (teardownService probes first, src/services/deprovision.ts:56-74).
        const label = nameOrFallback(name, 'this stack');
        const ok = await confirmModal({
          title: 'Remove stack',
          subject: label,
          question: 'Remove stack "' + label + '" and destroy everything in it?',
          confirmLabel: 'Remove stack',
          affected: [
            'Every service instance in this stack is destroyed: its object storage, its database and its shared queue, plus any on-demand packager, auto-scaled transcoders and optional subtitle or scene-detection instances recorded for it.',
            'Because the storage and the database are part of the stack, all asset records and all media files held in this stack go with them. This cannot be undone and there is no restore.',
            'Removal runs in the background — the row shows its progress and it also appears under Active Operations.',
          ],
          unaffected: [
            'Other stacks and their services are left completely alone.',
            'This API keeps running, and its stored coordinates for the stack are cleared only once every instance is actually gone, so a partial failure can be retried safely.',
          ],
        });
        if (!ok) return;
        removeBtn.disabled = true;
        statusSpan.textContent = 'removing…';
        apiFetch('/provision/' + encodeURIComponent(name), { method: 'DELETE' }).then(function(res) {
          const opId = res && res.operationId;
          if (opId) {
            statusSpan.textContent = 'pending…';
            // Mirror into Active Operations so it survives tab switches.
            upsertOpRow({ id: opId, type: 'deprovision', name: name, status: 'pending' });
            pollOp({ id: opId, type: 'deprovision', name: name, status: 'pending' });
            pollDeprovisionOp(opId, statusSpan, tr);
          } else {
            statusSpan.textContent = '✓ removed';
            tr.remove();
          }
        }).catch(function(err) {
          statusSpan.textContent = '✗ ' + err.message;
          removeBtn.disabled = false;
        });
      });
      tdRemove.appendChild(removeBtn);
      tdRemove.appendChild(statusSpan);

      tr.appendChild(tdName);
      tr.appendChild(tdBtn);
      tr.appendChild(tdRemove);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    listContent.appendChild(table);
  }).catch(function(err) {
    listContent.textContent = '';
    const p = document.createElement('p');
    p.className = 'text-muted';
    p.textContent = err.message;
    listContent.appendChild(p);
  });

  // ── Optional services: Scene Detection card (issue #198) ──
  // Reuses the shared per-service endpoints under /optional-services/:key and
  // the pollOp / pollDeprovisionOp helpers defined above. The service key,
  // status shape (state: not-configured | configured | active), instance-name
  // env var, and the empty required-field set are all taken verbatim from the
  // backend registry — see src/services/optional-services.ts (key 'scene-detect',
  // fields: []) and src/routes/optional-services.ts (statusSchema). Degrades to a
  // disabled "not configured" state when SCENE_DETECT_INSTANCE_NAME is unset.
  const sceneSection = document.createElement('div');
  sceneSection.className = 'section';
  const sceneTitle = document.createElement('div');
  sceneTitle.className = 'section-title';
  sceneTitle.textContent = 'Scene Detection';
  sceneSection.appendChild(sceneTitle);
  const sceneBody = document.createElement('div');
  sceneBody.appendChild(loadingEl());
  sceneSection.appendChild(sceneBody);
  container.appendChild(sceneSection);

  const SCENE_DETECT_KEY = 'scene-detect';

  function renderSceneCard(status) {
    sceneBody.textContent = '';

    // Map the backend `state` onto a user-facing badge + description.
    const state = status && status.state;
    const isActive = state === 'active';
    const isConfigured = state === 'configured';
    const notConfigured = !state || state === 'not-configured';

    const badgeStatus = isActive
      ? 'active'
      : isConfigured
        ? 'pending'
        : 'unknown';

    const kv = document.createElement('div');
    kv.className = 'kv-grid';
    const rows = [
      ['Service', escHtml((status && status.displayName) || 'Scene Detect Media Function')],
      ['Status', renderBadge(badgeStatus)],
      ['Instance name',
        status && status.instanceName
          ? '<span class="text-mono">' + escHtml(status.instanceName) + '</span>'
          : '<span class="text-muted">—</span>'],
      ['Env var',
        '<span class="text-mono">' +
          escHtml((status && status.instanceNameEnvVar) || 'SCENE_DETECT_INSTANCE_NAME') +
          '</span>'],
    ];
    if (isActive && status.url) {
      rows.push(['URL', '<span class="text-mono">' + escHtml(status.url) + '</span>']);
    }
    kv.innerHTML = rows.map(function(r) {
      return '<span class="kv-key">' + r[0] + '</span><span class="kv-val">' + r[1] + '</span>';
    }).join('');
    sceneBody.appendChild(kv);

    const hint = document.createElement('p');
    hint.className = 'text-muted';
    hint.style.cssText = 'font-size:12px;margin-top:8px;';
    if (notConfigured) {
      hint.textContent = 'SCENE_DETECT_INSTANCE_NAME is not set. Provision an instance below, then set that environment variable to the instance name and restart to enable the scene-detect pipeline step.';
    } else if (isConfigured) {
      hint.textContent = 'Configured, but no live instance was found under the configured name. Re-provision to create it.';
    } else {
      hint.textContent = 'A live scene-detect instance is running and wired to the pipeline.';
    }
    sceneBody.appendChild(hint);

    // Controls: provision (when not active) and deprovision (when there is an
    // instance name to remove). When not-configured we still allow provisioning
    // a NEW instance (the operator sets the env var afterwards).
    const controls = document.createElement('div');
    controls.className = 'form-row';
    controls.style.marginTop = '8px';

    // Provision control — needs an instance name (^\w+$ per the backend schema).
    if (!isActive) {
      const field = document.createElement('div');
      field.className = 'form-field grow';
      const label = document.createElement('label');
      const inputId = 'scene-provision-name';
      label.setAttribute('for', inputId);
      label.textContent = 'Instance name';
      const input = document.createElement('input');
      input.type = 'text';
      input.id = inputId;
      input.placeholder = 'scenedetect';
      if (status && status.instanceName) input.value = status.instanceName;
      field.appendChild(label);
      field.appendChild(input);
      controls.appendChild(field);

      const provBtn = document.createElement('button');
      provBtn.textContent = 'Provision';
      provBtn.addEventListener('click', function() {
        const name = input.value.trim();
        if (!name) { showMsg(sceneMsg, 'Instance name is required.', 'error'); return; }
        provisionScene(name, provBtn);
      });
      controls.appendChild(provBtn);
    }

    // Deprovision control — only when an instance name is configured (the backend
    // removes the instance named by SCENE_DETECT_INSTANCE_NAME).
    if (status && status.instanceName) {
      const deprovBtn = document.createElement('button');
      deprovBtn.className = 'btn-danger';
      deprovBtn.textContent = 'Deprovision';
      deprovBtn.addEventListener('click', async function() {
        // Scene-detect deprovision confirmation (issue #919). Impact wording
        // verified against DELETE /api/v1/optional-services/{key}
        // (src/routes/optional-services.ts:316-380), NOT assumed:
        //   - The handler reads the instance name from the descriptor's
        //     instanceNameEnvVar (:336) and, after probing, calls
        //     `removeInstance(osc, serviceId, name, sat)` (:369). That is the only
        //     mutation: the env var is NOT cleared and no asset is touched.
        //   - It returns 202 + operationId; the removal runs in the background.
        //   - Teardown is idempotent: an already-absent instance resolves
        //     `not_found`, which is a success (:357-365).
        //   - `state` therefore falls back from `active` to `configured` — the env
        //     var is still set but no live instance exists under that name
        //     (statusSchema state docs, :50-58).
        //   - The subject's human-readable name is the registry displayName
        //     ('Scene Detect Media Function', src/services/optional-services.ts:86-88)
        //     plus the operator-chosen instance name; neither is an opaque id.
        const serviceLabel = nameOrFallback(status && status.displayName, 'Scene detection');
        const instanceLabel = nameOrFallback(status && status.instanceName, 'the configured instance');
        const envVar = nameOrFallback(
          status && status.instanceNameEnvVar,
          'SCENE_DETECT_INSTANCE_NAME'
        );
        const ok = await confirmModal({
          title: 'Deprovision scene detection',
          subject: serviceLabel,
          question: 'Deprovision ' + serviceLabel + ' instance "' + instanceLabel + '"?',
          confirmLabel: 'Deprovision',
          affected: [
            'The service instance is destroyed, so the scene-detection step stops running on any pipeline execution from now on.',
            'Removal runs in the background and the card will drop from "active" to "configured" — ' + envVar + ' keeps its value, it just no longer points at a live instance.',
            'Provisioning again creates a brand-new instance; nothing is carried over from this one.',
          ],
          unaffected: [
            'Keyframes and scene data already produced stay attached to the assets that hold them.',
            'No assets, collections or jobs are removed, and jobs already running finish as they are.',
            'The rest of the stack — storage, database, queue, transcoders — is untouched.',
          ],
        });
        if (!ok) return;
        deprovisionScene(deprovBtn);
      });
      controls.appendChild(deprovBtn);
    }

    sceneBody.appendChild(controls);

    const sceneMsg = document.createElement('div');
    sceneMsg.id = 'scene-msg';
    sceneMsg.className = 'mt8';
    sceneBody.appendChild(sceneMsg);
  }

  function refreshSceneCard() {
    apiFetch('/optional-services/' + encodeURIComponent(SCENE_DETECT_KEY))
      .then(renderSceneCard)
      .catch(function(err) {
        sceneBody.textContent = '';
        const p = document.createElement('p');
        p.className = 'text-muted';
        // Degrade gracefully: an unknown key / unreachable endpoint shows a
        // disabled notice rather than a hard error card.
        p.textContent = 'Scene detection is unavailable (' + err.message + ').';
        sceneBody.appendChild(p);
      });
  }

  function provisionScene(name, btn) {
    const sceneMsg = sceneBody.querySelector('#scene-msg');
    if (sceneMsg) sceneMsg.innerHTML = '';
    btn.disabled = true;
    btn.textContent = 'Provisioning…';
    apiFetch('/optional-services/' + encodeURIComponent(SCENE_DETECT_KEY) + '/provision', {
      method: 'POST',
      body: JSON.stringify({ name: name })
    }).then(function(res) {
      const opId = res && res.operationId;
      if (opId) {
        // Mirror into Active Operations and poll to completion, then refresh.
        upsertOpRow({ id: opId, type: 'provision', name: name, status: 'pending' });
        pollOp({ id: opId, type: 'provision', name: name, status: 'pending' });
        pollSceneOp(opId, btn, 'Provision');
      } else {
        btn.disabled = false;
        btn.textContent = 'Provision';
        refreshSceneCard();
      }
    }).catch(function(err) {
      if (sceneMsg) showMsg(sceneMsg, 'Error: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Provision';
    });
  }

  function deprovisionScene(btn) {
    const sceneMsg = sceneBody.querySelector('#scene-msg');
    if (sceneMsg) sceneMsg.innerHTML = '';
    btn.disabled = true;
    btn.textContent = 'Deprovisioning…';
    apiFetch('/optional-services/' + encodeURIComponent(SCENE_DETECT_KEY), { method: 'DELETE' })
      .then(function(res) {
        const opId = res && res.operationId;
        const name = (res && res.name) || '';
        if (opId) {
          upsertOpRow({ id: opId, type: 'deprovision', name: name, status: 'pending' });
          pollOp({ id: opId, type: 'deprovision', name: name, status: 'pending' });
          pollSceneOp(opId, btn, 'Deprovision');
        } else {
          btn.disabled = false;
          btn.textContent = 'Deprovision';
          refreshSceneCard();
        }
      }).catch(function(err) {
        if (sceneMsg) showMsg(sceneMsg, 'Error: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Deprovision';
      });
  }

  // Poll a scene-detect optional-service operation to a terminal state, then
  // re-render the card so the status/badge reflects the new instance state.
  function pollSceneOp(opId, btn, verb) {
    apiFetch('/provision/operations/' + encodeURIComponent(opId)).then(function(op) {
      if (op.status === 'done' || op.status === 'failed') {
        btn.disabled = false;
        btn.textContent = verb;
        const sceneMsg = sceneBody.querySelector('#scene-msg');
        if (op.status === 'failed' && sceneMsg) {
          showMsg(sceneMsg, op.error || (verb + ' failed'), 'error');
        }
        refreshSceneCard();
      } else {
        setTimeout(function() { pollSceneOp(opId, btn, verb); }, 3000);
      }
    }).catch(function() {
      setTimeout(function() { pollSceneOp(opId, btn, verb); }, 5000);
    });
  }

  refreshSceneCard();

  // Provision form
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = [
    '<div class="section-title">Provision a new stack</div>',
    '<p class="text-muted" style="font-size:13px;margin-bottom:12px;">Creates and configures OSC services for a named workspace.</p>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="prov-name">Stack name</label>',
    '    <input type="text" id="prov-name" placeholder="my-workspace" />',
    '  </div>',
    '  <button id="prov-btn">Provision Stack</button>',
    '</div>',
    '<div id="prov-msg"></div>',
  ].join('');
  container.appendChild(section);

  // Status lookup
  const statusSection = document.createElement('div');
  statusSection.className = 'section';
  statusSection.innerHTML = [
    '<div class="section-title">Check stack coordinates</div>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="prov-status-name">Stack name</label>',
    '    <input type="text" id="prov-status-name" placeholder="my-workspace" />',
    '  </div>',
    '  <button id="prov-status-btn" class="btn-ghost">Get Status</button>',
    '</div>',
    '<div id="prov-status-result" class="mt8"></div>',
  ].join('');
  container.appendChild(statusSection);

  section.querySelector('#prov-btn').addEventListener('click', async function() {
    const name = section.querySelector('#prov-name').value.trim();
    const msgEl = section.querySelector('#prov-msg');
    msgEl.innerHTML = '';
    if (!name) { showMsg(msgEl, 'Stack name is required.', 'error'); return; }
    const btn = section.querySelector('#prov-btn');
    btn.disabled = true;
    btn.textContent = 'Provisioning…';
    try {
      const result = await apiFetch('/provision', { method: 'POST', body: JSON.stringify({ name: name }) });
      const opId = result && result.operationId;

      // Show a live status bar that polls until done/failed.
      const statusBar = document.createElement('div');
      statusBar.className = 'mt8';
      msgEl.appendChild(statusBar);

      const updateBar = function(op) {
        const isDone = op.status === 'done';
        const isFailed = op.status === 'failed';
        const icon = isDone ? '✓' : isFailed ? '✗' : '…';
        const cls = isDone ? 'success' : isFailed ? 'error' : 'info';

        statusBar.textContent = '';
        const wrap = document.createElement('div');
        wrap.className = 'msg msg-' + cls;
        wrap.style.cssText = 'display:flex;align-items:center;gap:8px;';

        const iconEl = document.createElement('span');
        iconEl.style.fontSize = '16px';
        iconEl.textContent = icon;
        wrap.appendChild(iconEl);

        const body = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = op.status;
        body.appendChild(strong);
        body.appendChild(document.createTextNode(' — ' + op.name));
        if (op.error) {
          const errEl = document.createElement('span');
          errEl.style.cssText = 'display:block;font-size:12px;opacity:.8;';
          errEl.textContent = op.error;
          body.appendChild(errEl);
        }
        wrap.appendChild(body);
        statusBar.appendChild(wrap);
        if (isDone) {
          // Show stack coordinates inline once provisioning succeeds.
          apiFetch('/provision/' + encodeURIComponent(op.name)).then(function(coords) {
            const pre = document.createElement('pre');
            pre.className = 'code-block mt8';
            pre.textContent = JSON.stringify(coords, null, 2);
            msgEl.appendChild(pre);
          }).catch(function() {});
        }
      };

      if (opId) {
        // Mirror into the Active Operations section so it survives tab switches.
        upsertOpRow({ id: opId, type: 'provision', name: name, status: 'pending' });
        pollOp({ id: opId, type: 'provision', name: name, status: 'pending' });
        // Poll until terminal (also updates the inline status bar).
        const poll = async function() {
          try {
            const op = await apiFetch('/provision/operations/' + encodeURIComponent(opId));
            updateBar(op);
            if (op.status !== 'done' && op.status !== 'failed') {
              setTimeout(poll, 3000);
            } else {
              btn.disabled = false;
              btn.textContent = 'Provision Stack';
            }
          } catch (e) {
            // Keep polling on transient fetch errors.
            setTimeout(poll, 5000);
          }
        };
        updateBar({ status: 'pending', name: name });
        poll();
      } else {
        // Fallback: no operationId, show raw response.
        showMsg(msgEl, 'Provisioning started for "' + name + '".', 'success');
        btn.disabled = false;
        btn.textContent = 'Provision Stack';
      }
    } catch (err) {
      showMsg(msgEl, 'Error: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Provision Stack';
    }
  });

  statusSection.querySelector('#prov-status-btn').addEventListener('click', async function() {
    const name = statusSection.querySelector('#prov-status-name').value.trim();
    const resultEl = statusSection.querySelector('#prov-status-result');
    resultEl.innerHTML = '';
    if (!name) { showMsg(resultEl, 'Stack name is required.', 'error'); return; }
    const loader = loadingEl();
    resultEl.appendChild(loader);
    try {
      const data = await apiFetch('/provision/' + encodeURIComponent(name));
      loader.remove();

      const kvRows = [
        ['Name', escHtml(data && data.name ? data.name : name)],
        ['Status', renderBadge(data && data.status ? data.status : null)],
        ['Created', escHtml(fmtDate(data && data.createdAt ? data.createdAt : null))],
      ];

      const kvDiv = document.createElement('div');
      kvDiv.className = 'kv-grid';
      kvDiv.innerHTML = kvRows.map(function(r) {
        return '<span class="kv-key">' + r[0] + '</span><span class="kv-val">' + r[1] + '</span>';
      }).join('');
      resultEl.appendChild(kvDiv);

      const endpoints = (data && (data.endpoints || data.services)) ? (data.endpoints || data.services) : {};
      if (Object.keys(endpoints).length > 0) {
        const epTitle = document.createElement('div');
        epTitle.className = 'mt12 section-title';
        epTitle.textContent = 'Endpoints';
        resultEl.appendChild(epTitle);

        const epGrid = document.createElement('div');
        epGrid.className = 'kv-grid mt8';
        epGrid.innerHTML = Object.entries(endpoints).map(function(pair) {
          const k = pair[0], v = pair[1];
          return '<span class="kv-key">' + escHtml(k) + '</span>' +
            '<span class="kv-val text-mono">' + escHtml(typeof v === 'string' ? v : JSON.stringify(v)) + '</span>';
        }).join('');
        resultEl.appendChild(epGrid);
      }

      const pre = document.createElement('pre');
      pre.className = 'code-block mt12';
      pre.textContent = JSON.stringify(data, null, 2);
      resultEl.appendChild(pre);

    } catch (err) {
      loader.remove();
      showMsg(resultEl, 'Error: ' + err.message, 'error');
    }
  });

  // ── Scaler configuration ──
  const scalerSection = document.createElement('div');
  scalerSection.className = 'section';
  scalerSection.innerHTML = '<div class="section-title">Scaler Configuration</div>' +
    '<div id="scaler-config-body"></div>';
  container.appendChild(scalerSection);

  const scalerBody = scalerSection.querySelector('#scaler-config-body');
  scalerBody.appendChild(loadingEl());

  apiFetch('/scaler/config').then(function(cfg) {
    scalerBody.innerHTML = [
      '<div class="form-row">',
      '  <div class="form-field">',
      '    <label for="scaler-max">Max Instances</label>',
      '    <input type="number" id="scaler-max" min="1" max="20" value="' + escHtml(String(cfg.maxInstances)) + '" />',
      '  </div>',
      '  <div class="form-field">',
      '    <label for="scaler-min">Min Instances (0 = scale to zero when idle)</label>',
      '    <input type="number" id="scaler-min" min="0" max="10" value="' + escHtml(String(cfg.minInstances)) + '" />',
      '  </div>',
      '  <button id="scaler-save-btn" class="btn-ghost">Save</button>',
      '</div>',
      '<div id="scaler-config-msg" class="mt8"></div>',
    ].join('');

    scalerBody.querySelector('#scaler-save-btn').addEventListener('click', async function() {
      const btn = scalerBody.querySelector('#scaler-save-btn');
      const msgEl = scalerBody.querySelector('#scaler-config-msg');
      msgEl.innerHTML = '';
      const maxInstances = Number(scalerBody.querySelector('#scaler-max').value);
      const minInstances = Number(scalerBody.querySelector('#scaler-min').value);
      btn.disabled = true;
      try {
        const updated = await apiFetch('/scaler/config', {
          method: 'PATCH',
          body: JSON.stringify({ maxInstances: maxInstances, minInstances: minInstances })
        });
        scalerBody.querySelector('#scaler-max').value = updated.maxInstances;
        scalerBody.querySelector('#scaler-min').value = updated.minInstances;
        showMsg(msgEl, 'Scaler configuration saved.', 'success');
      } catch (err) {
        showMsg(msgEl, 'Error: ' + err.message, 'error');
      }
      btn.disabled = false;
    });
  }).catch(function(err) {
    scalerBody.innerHTML = '';
    const notice = document.createElement('p');
    notice.className = 'text-muted';
    notice.textContent = 'Scaler is not active — configuration unavailable (' + err.message + ').';
    scalerBody.appendChild(notice);
  });

  // ── Auto-subtitles optional service (issue #196) ──
  // Provisions the OPT-IN auto-subtitles service via the generic optional-service
  // endpoints (src/routes/optional-services.ts). This service is NOT part of the
  // fixed stack: it is discovered by the runtime from AUTO_SUBTITLES_INSTANCE_NAME.
  //   status:      GET    /api/v1/optional-services/auto-subtitles  -> statusSchema
  //   provision:   POST   /api/v1/optional-services/auto-subtitles/provision {name,openaikey,...}
  //                        -> 202 { operationId, key, name, status:'pending' }
  //   deprovision: DELETE /api/v1/optional-services/auto-subtitles
  //                        -> 202 { operationId, ... } | 400 when env var unset
  // Both async ops land in the SHARED operation store, so we reuse pollOp /
  // pollDeprovisionOp (which poll /provision/operations/:id) unchanged.
  const OPTIONAL_KEY = 'auto-subtitles';
  const subSection = document.createElement('div');
  subSection.className = 'section';
  const subTitle = document.createElement('div');
  subTitle.className = 'section-title';
  subTitle.textContent = 'Auto-subtitles (optional service)';
  subSection.appendChild(subTitle);
  const subBody = document.createElement('div');
  subBody.id = 'auto-subtitles-body';
  subBody.appendChild(loadingEl());
  subSection.appendChild(subBody);
  container.appendChild(subSection);

  function renderAutoSubtitles() {
    subBody.textContent = '';
    subBody.appendChild(loadingEl());
    apiFetch('/optional-services/' + OPTIONAL_KEY).then(function(status) {
      subBody.textContent = '';

      // Status line: active | configured | not-configured.
      const state = status && status.state;
      const badgeText = state === 'active' ? 'Active'
        : state === 'configured' ? 'Configured'
        : 'Not configured';
      // Reuse the existing badge palette (style.css): active -> ready (green),
      // configured -> pending (amber), not-configured -> unknown (neutral).
      const badgeCls = state === 'active' ? 'badge-ready'
        : state === 'configured' ? 'badge-pending'
        : 'badge-unknown';

      const kvDiv = document.createElement('div');
      kvDiv.className = 'kv-grid';
      const rows = [['Status', '<span class="badge ' + badgeCls + '">' + escHtml(badgeText) + '</span>']];
      if (status && status.instanceName) {
        rows.push(['Instance name', '<span class="text-mono">' + escHtml(status.instanceName) + '</span>']);
      }
      if (status && status.url) {
        rows.push(['URL', '<span class="text-mono">' + escHtml(status.url) + '</span>']);
      }
      rows.push(['Env var', '<span class="text-mono">' + escHtml((status && status.instanceNameEnvVar) || 'AUTO_SUBTITLES_INSTANCE_NAME') + '</span>']);
      kvDiv.innerHTML = rows.map(function(r) {
        return '<span class="kv-key">' + r[0] + '</span><span class="kv-val">' + r[1] + '</span>';
      }).join('');
      subBody.appendChild(kvDiv);

      // Graceful "not configured" guidance: the runtime has the pipeline step
      // disabled because AUTO_SUBTITLES_INSTANCE_NAME is unset. Provisioning here
      // creates the instance and returns the name the operator must set into that
      // env var (the runtime cannot mutate its own env for a future self).
      if (state === 'not-configured') {
        const hint = document.createElement('p');
        hint.className = 'text-muted';
        hint.style.cssText = 'font-size:13px;margin:8px 0;';
        hint.textContent = 'AUTO_SUBTITLES_INSTANCE_NAME is not set, so the auto-subtitles pipeline step is disabled. Provision an instance below, then set that env var to the returned instance name and redeploy to enable it.';
        subBody.appendChild(hint);
      }

      // Deprovision control — only meaningful when an instance name is configured.
      if (state === 'active' || state === 'configured') {
        const delRow = document.createElement('div');
        delRow.style.cssText = 'margin:8px 0;';
        const delBtn = document.createElement('button');
        delBtn.className = 'btn-sm btn-danger';
        delBtn.textContent = 'Deprovision';
        const delStatus = document.createElement('span');
        delStatus.style.cssText = 'margin-left:8px;font-size:12px;';
        delBtn.addEventListener('click', async function() {
          const nm = (status && status.instanceName) || OPTIONAL_KEY;
          // Auto-subtitles deprovision confirmation (issue #919). Same endpoint
          // and therefore the same verified semantics as the scene-detect card:
          // DELETE /api/v1/optional-services/{key}
          // (src/routes/optional-services.ts:316-380) probes then calls
          // `removeInstance` (:369) and nothing else — the instance-name env var
          // is left set, so `state` falls back from `active` to `configured`
          // (statusSchema state docs, :50-58). 202 + background operation.
          // Subtitle tracks already generated live on the asset document
          // (`subtitleTracks[].objectKey`, enumerated by the purge sweep at
          // src/pipeline/archived-asset-purge-sweep.ts step 4), so they survive
          // the instance being destroyed.
          // The human-readable subject is the registry displayName ('Subtitle
          // Generator', src/services/optional-services.ts:68-70) plus the
          // operator-chosen instance name.
          const serviceLabel = nameOrFallback(
            status && status.displayName,
            'Subtitle generation'
          );
          const envVar = nameOrFallback(
            status && status.instanceNameEnvVar,
            'AUTO_SUBTITLES_INSTANCE_NAME'
          );
          const ok = await confirmModal({
            title: 'Deprovision subtitle generation',
            subject: serviceLabel,
            question: 'Deprovision ' + serviceLabel + ' instance "' + nm + '"?',
            confirmLabel: 'Deprovision',
            affected: [
              'The service instance is destroyed, so the automatic-subtitle step stops running on any pipeline execution from now on.',
              'Removal runs in the background and the card will drop from "active" to "configured" — ' + envVar + ' keeps its value, it just no longer points at a live instance.',
              'Provisioning again creates a brand-new instance and needs its API key supplied afresh.',
            ],
            unaffected: [
              'Subtitle tracks already generated stay attached to their assets and keep playing back as before.',
              'No assets, collections or jobs are removed, and jobs already running finish as they are.',
              'The rest of the stack — storage, database, queue, transcoders — is untouched.',
            ],
          });
          if (!ok) return;
          delBtn.disabled = true;
          delStatus.textContent = 'removing…';
          apiFetch('/optional-services/' + OPTIONAL_KEY, { method: 'DELETE' }).then(function(res) {
            const opId = res && res.operationId;
            if (opId) {
              delStatus.textContent = 'pending…';
              // Mirror into Active Operations so it survives tab switches, and use
              // the shared deprovision poller (both poll /provision/operations/:id).
              opsSection.style.display = '';
              upsertOpRow({ id: opId, type: 'deprovision', name: nm, status: 'pending' });
              pollOp({ id: opId, type: 'deprovision', name: nm, status: 'pending' });
              pollDeprovisionOp(opId, delStatus, null);
              // Re-read the card once the op likely settled.
              setTimeout(renderAutoSubtitles, 4000);
            } else {
              delStatus.textContent = '✓ removed';
              setTimeout(renderAutoSubtitles, 500);
            }
          }).catch(function(err) {
            delStatus.textContent = '✗ ' + err.message;
            delBtn.disabled = false;
          });
        });
        delRow.appendChild(delBtn);
        delRow.appendChild(delStatus);
        subBody.appendChild(delRow);
      }

      // Provision form. `name` and `openaikey` are the required fields per the
      // registry (src/services/optional-services.ts fields). AWS fields are the
      // optional S3-upload pass-throughs — omitted here to keep the reference UI
      // minimal; the backend accepts them via passthrough if ever added.
      const form = document.createElement('div');
      form.style.cssText = 'margin-top:12px;';
      form.innerHTML = [
        '<div class="section-title" style="font-size:13px;">Provision auto-subtitles</div>',
        '<div class="form-row">',
        '  <div class="form-field grow">',
        '    <label for="asub-name">Instance name</label>',
        '    <input type="text" id="asub-name" placeholder="autosubtitles" />',
        '  </div>',
        '</div>',
        '<div class="form-row">',
        '  <div class="form-field grow">',
        '    <label for="asub-openaikey">OpenAI API key (required)</label>',
        '    <input type="password" id="asub-openaikey" autocomplete="off" placeholder="sk-…" />',
        '  </div>',
        '  <button id="asub-provision-btn">Provision</button>',
        '</div>',
        '<div id="asub-msg"></div>',
      ].join('');
      subBody.appendChild(form);

      form.querySelector('#asub-provision-btn').addEventListener('click', function() {
        const name = form.querySelector('#asub-name').value.trim();
        const openaikey = form.querySelector('#asub-openaikey').value;
        const msgEl = form.querySelector('#asub-msg');
        msgEl.innerHTML = '';
        if (!name) { showMsg(msgEl, 'Instance name is required.', 'error'); return; }
        if (!openaikey) { showMsg(msgEl, 'OpenAI API key is required.', 'error'); return; }
        const btn = form.querySelector('#asub-provision-btn');
        btn.disabled = true;
        btn.textContent = 'Provisioning…';
        apiFetch('/optional-services/' + OPTIONAL_KEY + '/provision', {
          method: 'POST',
          body: JSON.stringify({ name: name, openaikey: openaikey })
        }).then(function(res) {
          // Do not retain the key in the field once submitted.
          form.querySelector('#asub-openaikey').value = '';
          const opId = res && res.operationId;
          if (opId) {
            opsSection.style.display = '';
            upsertOpRow({ id: opId, type: 'provision', name: name, status: 'pending' });
            pollOp({ id: opId, type: 'provision', name: name, status: 'pending' });
            showMsg(msgEl, 'Provisioning started. Once done, set AUTO_SUBTITLES_INSTANCE_NAME=' + name + ' and redeploy.', 'success');
            setTimeout(renderAutoSubtitles, 4000);
          } else {
            showMsg(msgEl, 'Provisioning started for "' + name + '".', 'success');
          }
          btn.disabled = false;
          btn.textContent = 'Provision';
        }).catch(function(err) {
          showMsg(msgEl, 'Error: ' + err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Provision';
        });
      });
    }).catch(function(err) {
      // Degrade gracefully: if the optional-services endpoint is unreachable
      // (e.g. not wired in this deployment), show a neutral notice, not an error.
      subBody.textContent = '';
      const notice = document.createElement('p');
      notice.className = 'text-muted';
      notice.textContent = 'Auto-subtitles service status unavailable (' + err.message + ').';
      subBody.appendChild(notice);
    });
  }
  renderAutoSubtitles();

}

// Minimal CSS attribute-selector escaper for workspace IDs.
function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\\]\[]/g, '\\$&');
}

// ─── PIPELINES TAB ───────────────────────────────────────────────────────────

// Single source of truth for the built-in pipeline metadata shown in the UI
// (pipelines tab catalog bar + the execute dialog's pipeline selector). Kept in
// sync with the backend BUILT_IN_PIPELINES / PIPELINE_DESCRIPTIONS in
// src/pipeline/pipelines.ts. Adding a new entry here surfaces it automatically
// in the execute dialog, so there is no separate hardcoded option list to touch.
var PIPELINE_CATALOG = [
  {
    name: 'transcode',
    label: 'Transcode',
    description: 'Transcode the source file using the selected profile. Profile is chosen at execution time.',
    steps: ['transcode']
  },
  {
    name: 'abr-vod',
    label: 'ABR VOD',
    description: 'Transcode then package to HLS/DASH for streaming. Profile is chosen at execution time.',
    steps: ['transcode', 'package']
  },
  {
    name: 'package',
    label: 'Package',
    description: 'Package an already-transcoded asset to HLS/DASH without re-encoding. Use it to finish a run whose transcode succeeded but whose packaging failed. Requires an existing transcode whose job is still resolvable.',
    steps: ['package']
  },
  {
    name: 'ingest',
    label: 'Ingest',
    description: 'Extract technical metadata and generate thumbnail frames.',
    steps: ['extract-metadata', 'thumbnail']
  },
  {
    name: 'subtitles',
    label: 'Subtitles',
    description: 'Auto-generate a subtitle track from the audio using Whisper transcription and attach it to the asset.',
    steps: ['subtitles']
  },
  {
    name: 'scene-detect',
    label: 'Scene Detect',
    description: 'Detect scene/shot boundaries and keyframes and attach them to the asset for clip and trim workflows.',
    steps: ['scene-detect']
  },
  {
    name: 'full',
    label: 'Full',
    description: 'Full pipeline: metadata extraction, thumbnails, auto-subtitles, scene detection, transcode, and HLS/DASH packaging.',
    steps: ['extract-metadata', 'thumbnail', 'subtitles', 'scene-detect', 'transcode', 'package']
  }
];

// Pipelines whose steps include a transcode step, and therefore need the encode
// profile selector. Derived from PIPELINE_CATALOG so it stays correct as new
// pipelines are added (rather than a second hardcoded list to keep in sync).
var ENCODE_PIPELINES = PIPELINE_CATALOG
  .filter(function(p) { return p.steps.indexOf('transcode') !== -1; })
  .map(function(p) { return p.name; });

var STEP_ICONS = {
  'extract-metadata': '🔬',
  'thumbnail': '🖼',
  'transcode': '🎞',
  'package': '📦',
  'subtitles': '💬',
  'scene-detect': '🎬'
};

// ─── Optional pipeline step availability (issue #790) ────────────────────────
//
// The subtitles and scene-detect steps are OPT-IN: the runtime builds them from
// the ACTIVE stack record, NOT from boot-time env vars — the resolver activates
// them only when the stack was provisioned with an instance name
// (src/services/workspace-stack.ts:225-233, StackConfig.autoSubtitlesInstanceName
// / sceneDetectInstanceName). When the name is unset the step SILENTLY skips at
// run time (src/routes/assets.ts:1650 triggerSubtitles / :1678 triggerSceneDetect
// both return false and do nothing), so an operator who picks such a pipeline
// gets an execution that appears to run and produces nothing.
//
// The per-stack configured state is already on the wire: GET
// /api/v1/provision/:name returns the stored config (src/routes/provision.ts,
// storedConfigSchema) which carries BOTH the raw instance names and the derived
// boolean summary `options: { autoSubtitles, sceneDetect }`. That `options`
// object is attached ONLY when at least one optional service is active
// (provision.ts GET /:name handler), so a stack with neither omits it entirely —
// hence the fallback to the raw *InstanceName fields below. No new endpoint and
// no new OSC contract is needed for this view.
var OPTIONAL_STEP_CONFIG = {
  'subtitles': {
    // Name of the optional-service card that provisions this step, so the
    // explanation can point the operator at the right control.
    serviceLabel: 'auto-subtitles',
    // Derived boolean on the GET /provision/:name response (storedConfigSchema.options).
    optionsKey: 'autoSubtitles',
    // Raw stored field, used when `options` is absent (no optional service active).
    instanceField: 'autoSubtitlesInstanceName'
  },
  'scene-detect': {
    serviceLabel: 'scene-detect',
    optionsKey: 'sceneDetect',
    instanceField: 'sceneDetectInstanceName'
  }
};

// Resolve which optional steps the ACTIVE stack has configured.
// Returns a map of step name -> boolean. FAIL-OPEN: when there is no active
// stack, or the config read fails, every optional step is reported available so
// a transient read error never hides a working pipeline from the operator.
async function loadOptionalStepAvailability() {
  var availability = {};
  Object.keys(OPTIONAL_STEP_CONFIG).forEach(function(step) { availability[step] = true; });

  var stack = stackOverride || getActiveStack();
  if (!stack) return availability;

  var config;
  try {
    config = await apiFetch('/provision/' + encodeURIComponent(stack));
  } catch (e) {
    console.warn('GET /provision/' + stack + ' failed; optional pipeline steps left enabled', e);
    return availability;
  }
  if (!config || typeof config !== 'object') return availability;

  Object.keys(OPTIONAL_STEP_CONFIG).forEach(function(step) {
    var field = OPTIONAL_STEP_CONFIG[step];
    var derived = config.options && typeof config.options[field.optionsKey] === 'boolean'
      ? config.options[field.optionsKey]
      : null;
    availability[step] = derived !== null
      ? derived
      : (typeof config[field.instanceField] === 'string' && config[field.instanceField].length > 0);
  });
  return availability;
}

// The optional steps of `pipeline` that the active stack has NOT configured.
// A step with no entry in OPTIONAL_STEP_CONFIG is always required/available and
// is never reported here.
function unconfiguredOptionalSteps(pipeline, availability) {
  return pipeline.steps.filter(function(step) {
    return OPTIONAL_STEP_CONFIG[step] && availability[step] === false;
  });
}

// A pipeline is unrunnable only when EVERY one of its steps is an unconfigured
// optional step — selecting it could not do any work. A mixed pipeline (e.g.
// `full`) still performs its other steps, so it stays selectable and is instead
// labelled with the step that will be skipped.
function isPipelineUnavailable(pipeline, availability) {
  var blocked = unconfiguredOptionalSteps(pipeline, availability);
  return blocked.length > 0 && blocked.length === pipeline.steps.length;
}

// Short human label listing unconfigured steps, e.g.
// "scene-detect is not configured for this stack".
function notConfiguredText(steps) {
  return steps.join(', ') + (steps.length === 1 ? ' is' : ' are') + ' not configured for this stack';
}

// The optional-service card names behind a set of steps, for "provision X"
// guidance. Falls back to the step name for a step with no registered service.
function optionalServiceNames(steps) {
  return steps
    .map(function(step) {
      return (OPTIONAL_STEP_CONFIG[step] && OPTIONAL_STEP_CONFIG[step].serviceLabel) || step;
    })
    .join(', ');
}

var EXEC_STATUS_CLASS = {
  running: 'status-processing',
  done: 'status-ready',
  failed: 'status-failed'
};

var STEP_STATUS_CLASS = {
  pending: 'step-pending',
  running: 'step-running',
  done: 'step-done',
  failed: 'step-failed'
};

function renderStepChip(step, errorLineId) {
  var icon = STEP_ICONS[step.name] || '⚙';
  var label = icon + ' ' + step.name;
  if (step.status === 'running' && step.progress != null) {
    label += ' ' + step.progress + '%';
  }
  var cls = 'pipeline-exec-step ' + (STEP_STATUS_CLASS[step.status] || '');
  if (step.status === 'failed' && step.error) {
    // Accessible failure: the chip is a focusable button that assistive tech
    // announces via aria-label, and it toggles a visible inline error line
    // (aria-controls) so the reason is reachable by keyboard/touch — not just
    // the hover-only title tooltip (kept as an additional affordance).
    return '<span class="' + cls + '"' +
      ' role="button" tabindex="0"' +
      ' aria-expanded="false"' +
      (errorLineId ? ' aria-controls="' + escHtml(errorLineId) + '"' : '') +
      ' aria-label="' + escHtml(step.name + ' step failed: ' + step.error) + '"' +
      ' title="' + escHtml(step.error) + '">' + escHtml(label) + '</span>';
  }
  return '<span class="' + cls + '">' + escHtml(label) + '</span>';
}

function renderExecutionRow(exec) {
  var row = document.createElement('div');
  row.className = 'pipeline-exec-row';

  var meta = document.createElement('div');
  meta.className = 'pipeline-exec-meta';
  var statusCls = EXEC_STATUS_CLASS[exec.status] || '';
  var assetLabel = exec.assetName ? escHtml(exec.assetName) : escHtml(exec.assetId);
  meta.innerHTML =
    '<span class="pipeline-exec-name">' + escHtml(exec.pipelineName) + '</span>' +
    '<span class="asset-link" data-id="' + escHtml(exec.assetId) + '">' + assetLabel + '</span>' +
    '<span class="status-badge ' + statusCls + '">' + escHtml(exec.status) + '</span>' +
    '<span class="pipeline-exec-time">' + escHtml(exec.createdAt.slice(0, 16).replace('T', ' ')) + '</span>';
  row.appendChild(meta);

  var steps = document.createElement('div');
  steps.className = 'pipeline-exec-steps';
  // Unique-ish id prefix so aria-controls references stay unique per row.
  var rowKey = 'pxerr-' + (exec.id || Math.random().toString(36).slice(2));
  var errorLines = [];
  steps.innerHTML = exec.steps.map(function(s, i) {
    var arrow = i > 0 ? '<span class="pipeline-step-arrow">→</span>' : '';
    var errId = null;
    if (s.status === 'failed' && s.error) {
      errId = rowKey + '-' + i;
      errorLines.push({ id: errId, name: s.name, error: s.error });
    }
    return arrow + renderStepChip(s, errId);
  }).join('');
  row.appendChild(steps);

  // Inline, always-rendered failure reasons under the chip row. These are
  // visible without hover (touch-safe) and announced by screen readers via a
  // role="alert" live region; the failed chip toggles the .is-open state.
  if (errorLines.length > 0) {
    var errWrap = document.createElement('div');
    errWrap.className = 'pipeline-exec-errors';
    errWrap.innerHTML = errorLines.map(function(e) {
      return '<div class="pipeline-exec-error" id="' + escHtml(e.id) + '" role="alert">' +
        '<span class="pipeline-exec-error-step">' + escHtml(e.name) + '</span>' +
        '<span class="pipeline-exec-error-msg">' + escHtml(e.error) + '</span>' +
        '</div>';
    }).join('');
    row.appendChild(errWrap);

    // Wire each failed chip to expand/collapse its inline error line and to be
    // operable by keyboard (Enter/Space) as an accessible toggle button.
    var chips = steps.querySelectorAll('.pipeline-exec-step[aria-controls]');
    chips.forEach(function(chip) {
      var targetId = chip.getAttribute('aria-controls');
      var target = targetId ? errWrap.querySelector('#' + CSS.escape(targetId)) : null;
      var toggle = function() {
        if (!target) return;
        var open = target.classList.toggle('is-open');
        chip.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
      chip.addEventListener('click', toggle);
      chip.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
          ev.preventDefault();
          toggle();
        }
      });
    });
  }

  // Click on asset name navigates to asset detail.
  meta.querySelector('.asset-link').addEventListener('click', function() {
    switchTab('assets');
    var detail = document.getElementById('asset-detail');
    if (detail) showAssetDetail(exec.assetId, detail);
  });

  return row;
}

async function renderPipelinesTab(container) {
  var wrap = document.createElement('div');
  wrap.className = 'pipelines-wrap';

  // ── Compact catalog strip ──
  // Optional steps the ACTIVE stack has not configured are marked here too
  // (issue #790), so the catalog and the asset detail picker tell the same story.
  var stepAvailability = await loadOptionalStepAvailability();
  var catalogBar = document.createElement('div');
  catalogBar.className = 'pipeline-catalog-bar';
  PIPELINE_CATALOG.forEach(function(pipeline) {
    var pill = document.createElement('span');
    var blocked = unconfiguredOptionalSteps(pipeline, stepAvailability);
    var unavailable = isPipelineUnavailable(pipeline, stepAvailability);
    pill.className = 'pipeline-catalog-pill' + (unavailable ? ' is-unavailable' : '');
    pill.title = pipeline.description + '\nSteps: ' + pipeline.steps.join(' → ') +
      (blocked.length > 0
        ? '\n' + notConfiguredText(blocked) + (unavailable ? '.' : ', so that step is skipped.')
        : '');
    pill.innerHTML =
      '<span class="pipeline-catalog-pill-name">' + escHtml(pipeline.label) + '</span>' +
      '<span class="pipeline-catalog-pill-id">' + escHtml(pipeline.name) + '</span>' +
      (unavailable
        ? '<span class="pipeline-catalog-pill-note">not configured</span>'
        : '');
    catalogBar.appendChild(pill);
  });
  wrap.appendChild(catalogBar);

  // ── Executions ──
  var execHeader = document.createElement('div');
  execHeader.className = 'section-title mt16 mb12';
  execHeader.textContent = 'Pipeline Executions';
  wrap.appendChild(execHeader);

  var execList = document.createElement('div');
  execList.className = 'pipeline-exec-list';
  execList.textContent = 'Loading…';
  wrap.appendChild(execList);

  container.appendChild(wrap);

  var pollTimer = null;

  async function loadExecutions() {
    try {
      var data = await apiFetch('/pipelines?limit=50');
      var items = (data && data.items) ? data.items : [];
      execList.innerHTML = '';
      if (items.length === 0) {
        execList.textContent = 'No pipeline executions yet.';
      } else {
        items.forEach(function(exec) {
          execList.appendChild(renderExecutionRow(exec));
        });
      }
      // Poll while any execution is running.
      var anyRunning = items.some(function(e) { return e.status === 'running'; });
      if (anyRunning) {
        pollTimer = setTimeout(loadExecutions, 5000);
      }
    } catch (e) {
      execList.textContent = 'Failed to load executions.';
    }
  }

  await loadExecutions();

  // Stop polling when the tab is replaced.
  var observer = new MutationObserver(function() {
    if (!document.body.contains(wrap)) {
      if (pollTimer) clearTimeout(pollTimer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ─── TRANSCODERS TAB ───────────────────────────────────────────────────────────

// Coarse humanised duration for an elapsed span in ms ("47 seconds",
// "9 minutes", "2 hours", "3 days"). Same unit ladder the card's old
// relativeTime() helper used, minus the "ago" suffix: the row now names the
// quantity itself ("Running 9 minutes"), and "ago" only makes sense for a point
// in the past. A negative span (clock skew, or a timestamp written slightly
// ahead of this browser's clock) clamps to zero rather than reading "-3 seconds".
function humanDuration(ms) {
  const sec = Math.max(0, Math.floor(Number(ms) / 1000));
  if (sec < 60) return sec + ' second' + (sec === 1 ? '' : 's');
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' minute' + (min === 1 ? '' : 's');
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' hour' + (hr === 1 ? '' : 's');
  const day = Math.floor(hr / 24);
  return day + ' day' + (day === 1 ? '' : 's');
}

// The instance record's idle clock, mirroring the server's resolveIdleSince()
// (src/encore-scaler/scaler-loop.ts:128): `lastIdleAt` when it is a usable
// number, otherwise `readyAt`. Same order, same tolerance for a value that
// round-tripped as a numeric string — so the age this card shows is the age the
// reaping bound (isIdlePastTimeout, scaler-loop.ts:148) measures. Returns
// undefined when neither timestamp is usable, which is the case the scale-down
// path deliberately fails CLOSED on (unknown age => treated as aged).
function resolveIdleSince(inst) {
  const candidates = [inst && inst.lastIdleAt, inst && inst.readyAt];
  for (const candidate of candidates) {
    const epochMs = toEpochMs(candidate);
    if (epochMs !== undefined) return epochMs;
  }
  return undefined;
}

// One timestamp candidate as epoch ms, or undefined when it is not usable.
// Deliberately strict about the input type: a blanket Number() would turn `null`
// into 0 — the epoch — and render a record with a missing timestamp as an
// instance that has been busy since 1970 instead of as an unknown.
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

// The one duration row on a transcoder card, state-aware (issue #982).
//
// The row used to read "Last idle <X> ago" unconditionally. `lastIdleAt` is
// stamped when an instance's activeJobs last reached 0 (src/routes/internal.ts:202,
// src/pipeline/encore-callback-poller.ts:371) and is frozen while it is busy, so
// on a working instance that row counted upward away from an already-stale value
// and reset to zero the moment work finished — i.e. it looked like a countdown to
// reaping while running the opposite direction, sitting right next to an idle
// timeout.
//
// Busy (activeJobs > 0): "Running <duration>" from `lastIdleAt`. No record field
// is stamped at dispatch — the loop increments activeJobs without a timestamp
// (src/encore-scaler/scaler-loop.ts:433) — so this is the closest the payload can
// get, and it is an UPPER bound: it includes however long the instance sat idle
// between becoming free and being handed its current job. On a queue-fed pool
// that gap is at most a tick.
//
// Idle (activeJobs === 0): "Idle <duration>" from resolveIdleSince(), the exact
// quantity the reaping bound compares against idleTimeoutMs. A freshly spawned
// instance awaiting dispatch has lastIdleAt === readyAt (instance-pool.ts:471),
// so it reads "Idle 12 seconds" — true, and the same clock that will reap it.
//
// Returns { label, value, title }; value is '—' when no timestamp is usable.
function instanceActivity(inst, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const active = Number(inst && inst.activeJobs) || 0;
  if (active > 0) {
    const since = toEpochMs(inst && inst.lastIdleAt);
    if (since === undefined) {
      return {
        label: 'Running',
        value: '—',
        title: 'This instance is working, but its record carries no timestamp to measure from.',
      };
    }
    return {
      label: 'Running',
      value: humanDuration(now - since),
      title: 'Elapsed since this instance last became idle — its current work started within that window.',
    };
  }
  const idleSince = resolveIdleSince(inst);
  if (idleSince === undefined) {
    return {
      label: 'Idle',
      value: '—',
      title: 'No usable idle timestamp on this record; the scaler treats an unknown idle age as aged.',
    };
  }
  return {
    label: 'Idle',
    value: humanDuration(now - idleSince),
    title: 'Idle age — the value the scaler compares against the idle timeout before tearing this instance down.',
  };
}

// Per-instance job capacity, read from the status payload (issue #979).
//
// Contract: GET /api/v1/scaler/status -> `jobsPerInstance`
// (scalerStatusSchema, src/routes/scaler.ts), the server's own
// JOBS_PER_INSTANCE (src/encore-scaler/types.ts) — the count at which the scaler
// loop treats an instance as busy. This used to be inferred from the pool's
// highest observed activeJobs, which agreed with the truth only while the
// constant was 1: the card showed "the busiest thing seen in this pool", not the
// instance's capacity. Falls back to 1 (one job per instance, the scaler's own
// default) when talking to a server that predates the field, rather than
// resuming the guess.
function resolveJobsPerInstance(status) {
  const n = Number(status && status.jobsPerInstance);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

// ─── Instance lifecycle health (issue #980) ──────────────────────────────────
//
// The pill used to colour UTILISATION — idle `--success`, busy `--danger`. On a
// pool of on-demand instances that are billed while alive, that inverts the
// meaning of the colours: transcoding is the state being paid for, idle is the
// state costing money for nothing. "At capacity" was tautological on top of
// that — at a capacity of 1 it just means activeJobs >= 1, so every working
// instance was at capacity by construction and a normal encode rendered red for
// its whole run.
//
// What the pill colours now is lifecycle health: whether the instance is where
// the scaler's OWN rules say it should be.
//
//   transcoding  activeJobs > 0                          green  — paid work
//   draining     activeJobs === 0 && draining            gray   — deliberate
//   idle         idle age <= idleTimeoutMs + grace       gray   — warm hold
//   overdue      idle age >  idleTimeoutMs + grace       amber  — not reaped
//   stuck        idle age >  idleTimeoutMs * 3           red    — genuinely wrong
//
// Every threshold is derived from the `idleTimeoutMs` in the status payload —
// the bound the scaler is live-enforcing, changeable at runtime via PATCH
// /api/v1/scaler/config — so none of this goes stale when an operator retunes
// ENCORE_IDLE_TIMEOUT_MS.
//
// Pool-level saturation (work queued, every instance busy, pool at maxInstances)
// is the condition that IS actionable, but it is a property of the pool, not of
// any one instance, and is tracked separately in #981.

// Grace added to the idle bound before an idle instance counts as overdue. The
// scaler loop ticks every 10s, so an instance can legitimately sit a tick or two
// past its bound waiting to be picked up. 60s absorbs that jitter without
// masking a real failure to reap.
const IDLE_OVERDUE_GRACE_MS = 60_000;

// Multiple of the idle bound past which an idle instance is stuck rather than
// merely late: the bound itself plus two orphan-reap cycles.
const IDLE_STUCK_FACTOR = 3;

// Client-side mirror of the server's resolveIdleSince()
// (src/encore-scaler/scaler-loop.ts:128): the epoch ms an idle instance has been
// idle since. Prefers `lastIdleAt` (a real completion stamp) and falls back to
// `readyAt` (the moment it entered the pool ready for work), because
// `lastIdleAt` only advances when a job COMPLETES — a freshly spawned instance
// that has never been dispatched has no completion to key off, and without the
// `readyAt` fallback would read as infinitely old and render amber the instant
// it appeared.
//
// Returns undefined when neither field is usable. Callers must NOT guess an age
// from that: numeric strings are accepted (the record round-trips through JSON
// and may have been repaired out of band), anything else is not a timestamp.
//
// #980 and #982 arrived at this same mirror independently — the health pill
// needs the idle age to pick a colour, the duration row needs it to print a
// number — so it is ONE implementation (resolveIdleSince, above) under two
// names rather than two copies that can drift apart from each other and from
// scaler-loop.ts:128. The name is kept because both surfaces' tests and
// comments refer to it, and `instanceIdleSince` reads better at the health
// call site than the server-side spelling does.
const instanceIdleSince = resolveIdleSince;

// Coarse duration wording for the pill's explanatory text ("6 minutes").
//
// Deliberately NOT humanDuration() (above), which the #982 duration row uses.
// This one ROUNDS and tops out at hours, because the tooltip is prose comparing
// an age against a bound ("Idle 6 minutes — past the 5 minute idle bound") where
// the nearest unit reads better than a truncated one. humanDuration() FLOORS and
// carries on into days, because the row reports an elapsed clock and must not
// claim a minute that has not fully passed. Same ladder, different rounding on
// purpose; neither is a copy of the other's job.
function fmtDurationApprox(ms) {
  const sec = Math.max(0, Math.round(Number(ms) / 1000));
  if (sec < 60) return sec + ' second' + (sec === 1 ? '' : 's');
  const min = Math.round(sec / 60);
  if (min < 60) return min + ' minute' + (min === 1 ? '' : 's');
  const hr = Math.round(min / 60);
  return hr + ' hour' + (hr === 1 ? '' : 's');
}

// Lifecycle-health verdict for one instance: { cls, label, detail }.
//
// One function decides the colour AND the wording, so the dot and the text can
// never disagree — the class is not re-derived from the thresholds a second time.
//
// Contract (GET /api/v1/scaler/status, `instanceSchema` + `scalerStatusSchema`
// in src/routes/scaler.ts): instance = { instanceId, url, activeJobs,
// lastIdleAt?, readyAt?, draining? }; bound = top-level `idleTimeoutMs`.
function instanceHealth(inst, idleTimeoutMs, now) {
  const active = Number(inst && inst.activeJobs) || 0;
  const draining = !!(inst && inst.draining === true);
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();

  // Transcoding is green at ANY duration. This branch is also what makes the
  // idle maths below sound: `lastIdleAt` holds the PREVIOUS idle moment and does
  // not advance during a run, so on a busy instance it is stale by exactly the
  // length of the encode. Idle age is only ever evaluated at activeJobs === 0.
  if (active > 0) {
    return {
      cls: 'health-transcoding',
      label: 'transcoding',
      detail: draining
        ? 'Transcoding. Draining: finishing its in-flight work and taking no new jobs.'
        : 'Transcoding — doing the work this instance is billed for.',
    };
  }

  // A draining instance (#513, drain-don't-kill) has been selected for teardown
  // and deliberately held past its idle bound, so "past the bound" is not a
  // fault for it and must never be flagged amber or red.
  if (draining) {
    return {
      cls: 'health-draining',
      label: 'draining',
      detail: 'Selected for teardown and taking no new jobs. Not flagged for being past its idle bound.',
    };
  }

  const bound = Number(idleTimeoutMs);
  const idleSince = instanceIdleSince(inst);
  if (!Number.isFinite(bound) || bound <= 0 || idleSince === undefined) {
    // No usable bound, or no usable timestamp on the record: there is no
    // evidence of a lifecycle fault, so do not invent one. The server's own
    // scale-down path fails CLOSED on a missing stamp (isIdlePastTimeout,
    // src/encore-scaler/scaler-loop.ts:148), so such an instance still gets
    // reaped — its age simply is not diagnosable from this payload.
    return {
      cls: 'health-idle',
      label: 'idle',
      detail: 'Idle. Age not available from this payload.',
    };
  }

  const idleAge = at - idleSince;
  const boundText = fmtDurationApprox(bound);
  if (idleAge > bound * IDLE_STUCK_FACTOR) {
    return {
      cls: 'health-stuck',
      label: 'stuck',
      detail: 'Idle ' + fmtDurationApprox(idleAge) + ' — more than ' + IDLE_STUCK_FACTOR +
        '× the ' + boundText + ' idle bound. Teardown has failed; this is burning money.',
    };
  }
  if (idleAge > bound + IDLE_OVERDUE_GRACE_MS) {
    return {
      cls: 'health-overdue',
      label: 'overdue',
      detail: 'Idle ' + fmtDurationApprox(idleAge) + ' — past the ' + boundText +
        ' idle bound. Should already have been torn down.',
    };
  }
  return {
    cls: 'health-idle',
    label: 'idle',
    detail: 'Idle ' + fmtDurationApprox(idleAge) + ' — within the ' + boundText + ' idle bound.',
  };
}

async function renderTranscodersTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Transcoders';
  container.appendChild(title);

  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = [
    '<div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">',
    '  <span id="tc-summary">Encore scaler pool</span>',
    '  <button id="tc-refresh" class="btn-ghost" style="font-size:12px;padding:4px 10px;">Refresh</button>',
    '</div>',
    '<div id="tc-wrap"></div>',
  ].join('');
  container.appendChild(section);

  const summaryEl = section.querySelector('#tc-summary');
  const wrap = section.querySelector('#tc-wrap');

  async function load() {
    wrap.innerHTML = '';
    const loader = loadingEl();
    wrap.appendChild(loader);

    let status;
    try {
      status = await apiFetch('/scaler/status');
    } catch (err) {
      loader.remove();
      showMsg(wrap, 'Failed to load scaler status: ' + err.message, 'error');
      summaryEl.textContent = 'Encore scaler pool';
      return;
    }
    loader.remove();

    const workspaces = (status && status.workspaces) || [];
    const maxInstances = status && typeof status.maxInstances === 'number' ? status.maxInstances : 0;
    const scalerActive = !!(status && status.scalerActive);

    // Flatten every instance across returned workspaces into one grid, keeping a
    // reference to its owning workspaceId for context.
    const flatInstances = [];
    workspaces.forEach(function(ws) {
      (ws.instances || []).forEach(function(inst) {
        flatInstances.push({ inst: inst, workspaceId: ws.workspaceId });
      });
    });

    // Pool-capacity context using maxInstances from the response.
    summaryEl.textContent = flatInstances.length + ' of ' + maxInstances +
      ' instance' + (maxInstances === 1 ? '' : 's') + ' active';

    if (!scalerActive || flatInstances.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No active transcoder instances.';
      wrap.appendChild(empty);
      return;
    }

    const capacity = resolveJobsPerInstance(status);
    // The live idle bound every health threshold is measured against (#980),
    // taken from the payload (`idleTimeoutMs`, scalerStatusSchema in
    // src/routes/scaler.ts) rather than hardcoded here, so the colours follow
    // ENCORE_IDLE_TIMEOUT_MS / PATCH /scaler/config instead of drifting from it.
    const idleTimeoutMs = status && typeof status.idleTimeoutMs === 'number'
      ? status.idleTimeoutMs
      : undefined;
    // One clock for the whole grid, so two cards rendered from the same payload
    // cannot land on different sides of a threshold.
    const renderedAt = Date.now();

    const grid = document.createElement('div');
    grid.className = 'tc-grid';
    grid.innerHTML = flatInstances.map(function(f) {
      const inst = f.inst;
      const active = Number(inst.activeJobs) || 0;
      const health = instanceHealth(inst, idleTimeoutMs, renderedAt);
      // One state-aware duration row: running time while busy, idle age while
      // idle (issue #982). See instanceActivity(). Reads the same `renderedAt`
      // clock the health pill does, so the pill and the row on one card can
      // never be measured a few milliseconds apart.
      const activity = instanceActivity(inst, renderedAt);
      return [
        '<div class="tc-card">',
        '  <div class="tc-card-head">',
        '    <span class="tc-id text-mono">' + escHtml(inst.instanceId) + '</span>',
        '    <span class="tc-card-head-right">',
        // Utilisation is still worth reporting — it is just not a health signal,
        // so it renders as neutral text instead of a traffic light (#980).
        '      <span class="tc-load text-mono" title="Active jobs of this instance’s job capacity.">' +
        escHtml(String(active)) + ' / ' + escHtml(String(capacity)) + '</span>',
        // The state name is VISIBLE text, not a tooltip: the meaning of the
        // colour has to be readable without hovering (and without colour vision).
        '      <span class="tc-health ' + health.cls + '" title="' + escHtml(health.detail) + '">',
        '        <span class="tc-dot"></span>' + escHtml(health.label),
        '      </span>',
        '    </span>',
        '  </div>',
        '  <div class="tc-row">',
        '    <a href="' + escHtml(inst.url) + '" target="_blank" rel="noopener" class="text-mono tc-url">' + escHtml(inst.url) + '</a>',
        '  </div>',
        '  <div class="tc-meta">',
        '    <span class="text-muted">Workspace</span> <span class="text-mono">' + escHtml(f.workspaceId) + '</span>',
        '  </div>',
        '  <div class="tc-meta tc-activity" title="' + escHtml(activity.title) + '">',
        '    <span class="text-muted">' + escHtml(activity.label) + '</span> ' + escHtml(activity.value),
        '  </div>',
        '</div>',
      ].join('');
    }).join('');
    wrap.appendChild(grid);
  }

  section.querySelector('#tc-refresh').addEventListener('click', load);
  await load();
}

// ─── Logs tab ────────────────────────────────────────────────────────────────
// The logs table itself (cursor paging, time-range + message filters, order
// toggle, URL-state sync) lives entirely in the shared primitive composed by
// public/logs-table.js (issue #371). app.js only owns the surrounding tab chrome
// (header + Refresh button) and injects its fetch + date formatter. Unlike the
// jobs tab there is NO auto-poll: logs are append-only and cursor-paged, so a
// background poll would fight the operator's in-flight cursor page; Refresh is
// explicit instead.

let logsTableInstance = null;

async function renderLogsTab(container) {
  const layout = document.createElement('div');
  layout.className = 'assets-layout';
  container.appendChild(layout);

  const main = document.createElement('div');
  main.className = 'assets-main';
  layout.appendChild(main);

  const header = document.createElement('div');
  header.className = 'assets-main-header';
  header.innerHTML = [
    '<span class="section-title">Logs</span>',
    '<div class="flex-gap">',
    '  <button id="logs-refresh" class="btn-ghost" style="font-size:12px;padding:6px 12px;">Refresh</button>',
    '</div>',
  ].join('');
  main.appendChild(header);

  const logsTable = createLogsTable({ apiFetch, fmtDate });
  logsTableInstance = logsTable;
  main.appendChild(logsTable.el);

  header.querySelector('#logs-refresh').addEventListener('click', function () {
    logsTable.reload();
  });
}

// ─── Audit tab ───────────────────────────────────────────────────────────────
// A cross-cutting view over the audit log (issue #987). The per-asset trail on
// the asset detail panel answers "what happened to THIS asset"; it is left
// exactly as it was. This tab answers the questions that span resources — what
// was archived, every failed job, a collection's deletion history, system vs
// operator activity — by driving the same query endpoint with its real filters.
//
// All filtering and paging is server-side (GET /api/v1/audit accepts
// targetType/targetId/origin/principalId/action/from/to + limit/offset —
// src/routes/audit.ts:62-72), so the table lives entirely in the shared
// primitive composed by public/audit-table.js. app.js owns only the chrome
// (header + Refresh). No auto-poll: the log is append-only and offset-paged, so
// a background poll would shift the page under the operator.

let auditTableInstance = null;

async function renderAuditTab(container) {
  const layout = document.createElement('div');
  layout.className = 'assets-layout';
  container.appendChild(layout);

  const main = document.createElement('div');
  main.className = 'assets-main';
  layout.appendChild(main);

  const header = document.createElement('div');
  header.className = 'assets-main-header';
  header.innerHTML = [
    '<span class="section-title">Audit</span>',
    '<div class="flex-gap">',
    '  <button id="audit-refresh" class="btn-ghost" style="font-size:12px;padding:6px 12px;">Refresh</button>',
    '</div>',
  ].join('');
  main.appendChild(header);

  const auditTable = createAuditTable({ apiFetch, fmtDate });
  auditTableInstance = auditTable;
  main.appendChild(auditTable.el);

  header.querySelector('#audit-refresh').addEventListener('click', function () {
    auditTable.reload();
  });
}

// ─── Tab renderer registry ───────────────────────────────────────────────────

TAB_RENDERERS['assets'] = renderAssetsTab;
TAB_RENDERERS['jobs'] = renderJobsTab;
TAB_RENDERERS['logs'] = renderLogsTab;
TAB_RENDERERS['audit'] = renderAuditTab;
TAB_RENDERERS['transcoders'] = renderTranscodersTab;
TAB_RENDERERS['pipelines'] = renderPipelinesTab;
TAB_RENDERERS['profiles'] = renderProfilesTab;
TAB_RENDERERS['collections'] = renderCollectionsTab;
TAB_RENDERERS['search'] = renderSearchTab;
TAB_RENDERERS['webhooks'] = renderWebhooksTab;
TAB_RENDERERS['storage'] = renderStorageTab;
TAB_RENDERERS['provision'] = renderProvisionTab;

// ─── Exports for the standalone detached detail window (detail.js) ────────────
// These are re-used by detail.js via ES module import so the standalone page
// shares the exact same renderer + helper logic (no duplication / divergence).
export {
  // Exported so the UI fetch-path auth test (issue #741) can drive the real
  // apiFetch() against a gated router, catching future drift between the gate
  // and the UI's credential handling alongside test/workspace-acl.test.ts.
  apiFetch,
  isAssetWedged,
  filterWedgedAssets,
  renderAssetDetailBody,
  renderAssetFiles,
  renderJobDetailBody,
  renderPipelineDetailBody,
  openDetailWindow,
  setActiveStack,
  setStackOverride,
  getActiveStack,
  DETAIL_POLL_INTERVAL_MS,
  // Storage-backend list view (issue #680). Exported so a DOM/unit test can
  // exercise the pure render + role gate without a network call.
  renderStorageBackendsList,
  storageBackendStatus,
  isDefaultStorageBackend,
  getClientRole,
  setClientRole,
  canManageStorage,
  // Client-side mirror of the ADR-018 write gate for PATCH /assets/{id}
  // (issue #956). Exported so a DOM/unit test can assert the Rename control is
  // offered to exactly the roles that hold `write`.
  canRenameAsset,
  // Client-side mirror of the same ADR-018 write gate for
  // PATCH /collections/{id} (issue #928). Exported so a DOM/unit test can assert
  // the collection Rename control is offered to exactly the roles that hold
  // `write` — and to no others.
  canRenameCollection,
  // Collection detail panel (issue #928). Exported so a DOM test can drive the
  // REAL panel — the same code path the Collections tab opens — against the real
  // collections router, and assert the rename affordance end to end.
  showCollectionDetail,
  // Client-side mirror of the ADR-018 write+delete gate for the external-ids
  // sub-resource (issue #908). Exported so a DOM/unit test can assert the
  // add/edit/remove controls are offered to exactly the roles that hold both
  // `write` and `delete`, and that a viewer still sees the list.
  canChangeExternalIds,
  // Client-side mirror of the ADR-018 write gate for POST /assets/{id}/clip
  // (issue #793). Exported so a DOM/unit test can assert the Clip control is
  // offered to exactly the roles that hold `write`.
  canClipAsset,
  // Standalone detail URL builder (issue #793). Exported so a DOM/unit test can
  // assert a cross-asset link points at the right resource and stack.
  detailWindowUrl,
  // Add/edit storage-backend form (issue #681). Exported so a DOM/unit test can
  // exercise the pure render + validation without a network call.
  renderStorageBackendForm,
  validateStorageBackendForm,
  applyStorageBackendFormErrors,
  STORAGE_SECRET_PLACEHOLDER,
  // Remove-with-confirmation flow (issue #682). Exported so a DOM/unit test can
  // exercise the confirmation dialog + the 409 in-use message formatter.
  openStorageBackendRemoveDialog,
  describeBackendInUse,
  // Destructive-action confirmation primitive (issue #919). Exported so a
  // DOM/unit test can assert the dialog names its subject, states both impact
  // lists, and resolves true/false on exactly one route per action.
  confirmModal,
  nameOrFallback,
  // Action-failure dialog primitive (issue #918). Exported so a DOM/unit test can
  // assert it renders in app styling, announces via role="alert", and dismisses
  // through every openModal route.
  errorToast,
  openModal,
  // App-styled action-failure reporting (issue #920). Exported so a DOM/unit
  // test can assert a structured `reason` becomes operator-facing copy and that
  // an unknown/absent one falls back to the server message.
  reportActionFailure,
  humanizeErrorReason,
  ACTION_FAILURE_REASON_COPY,
  // Permanently-unrecoverable outcome (issue #933). Exported so a DOM/unit test
  // can assert that a 410 `gone` is told apart from a retryable failure, that the
  // notice is visually distinct from `.msg-error`, that it survives (no
  // auto-dismiss), and that the control which led there is removed rather than
  // disabled. Shared, so any other caller of a route with a tombstone 410 reports
  // it the same way.
  isPurgedGone,
  renderPurgedUnrecoverable,
  PURGED_UNRECOVERABLE_LABEL,
  // Title-first failure dialog + the shape normaliser behind it (issue #952).
  // Exported so a DOM/unit test can assert both primitives delegate to openModal
  // and that a structured `reason` wins over the developer-facing server message.
  errorModal,
  resolveFailureText,
  // Per-row test-connection action (issue #683). Exported so a DOM/unit test can
  // exercise the shared probe helper + the pure spinner/result row renderers
  // without a live probe.
  testStorageBackendConnection,
  setStorageBackendRowProbing,
  applyStorageBackendRowTestResult,
  STORAGE_TEST_CONNECTION_TIMEOUT_MS,
  STORAGE_TEST_DEFAULT_SECRET,
  // Exported so the add -> list -> edit -> list integration test can drive the
  // real Storage-tab flow against a stubbed fetch (issue #681).
  renderStorageTab,
  // Search results view (issue #849). Exported so a DOM/unit test can exercise
  // the pure envelope flattening + row rendering (asset AND collection hits,
  // marked by the server's `type` discriminator) without a network call.
  normaliseSearchResults,
  searchResultSummary,
  renderSearchResults,
  // Searchable multi-select asset picker for collection membership (issue
  // #915). Exported so a DOM test can drive the real picker against the real
  // search + collections routers: find by name, tick several hits, add them in
  // one interaction, and fall back to the raw-id field.
  renderCollectionAssetPicker,
  assetPickerSearchPath,
  assetPickerHits,
  addAssetsToCollection,
  addAssetsSummary,
  ASSET_PICKER_DEBOUNCE_MS,
  // Assets-tab bulk add-to-collection (issue #916). Exported so a DOM test can
  // drive the real bar and assert it goes through the SAME addAssetsToCollection
  // path as the collection-detail picker — one PUT per selected asset against
  // PUT /api/v1/collections/{id}/assets/{assetId} — plus the pure label/summary
  // wording and the collection-envelope normaliser.
  renderAssetsBulkBar,
  bulkCollectionOptions,
  bulkAddButtonLabel,
  bulkSelectionSummary,
  // Truncation disclosure on the hit list (issue #949). Exported so a unit test
  // can pin the "showing N of M" wording and the no-note case without going
  // through a search round trip.
  assetPickerTotal,
  assetPickerResultNote,
  ASSET_PICKER_PAGE_SIZE,
  // Whole-row activation on the collections list (issue #917). Exported so a
  // DOM test can assert a click anywhere on the row opens the detail, that the
  // View/Delete buttons do not double-trigger it, and that the row is reachable
  // and activatable by keyboard.
  wireCollectionRowActivation,
  COLLECTION_ROW_CONTROL_SELECTOR,
  renderCollectionsTab,
  // Exported so a DOM/unit test can drive the real Assets-tab upload flow —
  // including the raw streaming PUT at app.js:1298 that bypasses apiFetch — and
  // assert it presents the UI-scoped Authorization header (issue #740).
  renderAssetsTab,
  // Exported so a parity test can assert this hand-maintained catalog still
  // agrees with the backend's BUILT_IN_PIPELINES / PIPELINE_DESCRIPTIONS
  // (issue #739) — the pipeline picker and the execute enum must not drift.
  PIPELINE_CATALOG,
  // Search-tab format filter (issue #822). Exported so a DOM/unit test can
  // drive the real Search tab against a stubbed fetch and assert the field's
  // own placeholder is a value the API can match.
  renderSearchTab,
  SEARCH_FORMAT_LABEL,
  SEARCH_FORMAT_PLACEHOLDER,
  // Search-tab scope copy (issue #913). Exported so a DOM/unit test can assert
  // the tab says it covers collections as well as assets.
  SEARCH_TAB_TITLE,
  SEARCH_SECTION_TITLE,
  SEARCH_SCOPE_HINT,
  // Per-instance capacity is read from the wire, not inferred (issue #979).
  // Exported so a DOM/unit test can assert the card reports the server's
  // `jobsPerInstance`.
  resolveJobsPerInstance,
  // The instance pill colours LIFECYCLE HEALTH, not utilisation (issue #980).
  // Exported so a DOM/unit test can pin the two traps that make the naive
  // version wrong: `lastIdleAt` is stale while an instance is busy, and a
  // draining instance is deliberately past its idle bound.
  instanceHealth,
  instanceIdleSince,
  IDLE_OVERDUE_GRACE_MS,
  IDLE_STUCK_FACTOR,
  // The transcoder card's one duration row is state-aware (issue #982): running
  // time while an instance is busy, idle age — the quantity the reaping bound
  // uses — while it is not. Exported so a unit test can pin both branches, the
  // shared duration formatting, and the idle-clock fallback that mirrors the
  // server's resolveIdleSince().
  humanDuration,
  resolveIdleSince,
  instanceActivity,
  renderTranscodersTab,
  // Exported so a DOM/unit test can prove every rendered tab button is
  // routable — i.e. present in the allowlist AND backed by a renderer — and
  // that an unroutable one is reported rather than silently dropped (#823).
  TABS,
  TAB_RENDERERS,
  TAB_KEY,
  switchTab,
  setupTabs,
  auditTabWiring,
  reportTabWiring,
};

// ─── Boot ────────────────────────────────────────────────────────────────────
// Guard: only spin up the full tab UI on the main ops page. When detail.js
// imports the renderers above, this module's top-level code still executes, so
// we must NOT boot the tab UI in that context. The main page sets
// window.__OPS_MAIN__ before importing app.js; as a defensive fallback we also
// require the tab bar to be present in the DOM.
if (typeof window !== 'undefined' && window.__OPS_MAIN__ === true && document.querySelector('.tab-bar')) {
  setupTabs();
  switchTab(localStorage.getItem(TAB_KEY) || 'assets');
  initStackSelector();
}
