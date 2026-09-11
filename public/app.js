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

// ─── API fetch helper ────────────────────────────────────────────────────────

const API_BASE = window.location.origin + '/api/v1';

async function apiFetch(path, options = {}) {
  const stack = stackOverride || getActiveStack();
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(stack ? { 'X-Stack-Name': stack } : {}),
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
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return res.json();
  }
  return null;
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
function openModal(title, buildBody) {
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

  function close() {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
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
function openDetailWindow(type, id) {
  const params = 'type=' + encodeURIComponent(type) +
    '&id=' + encodeURIComponent(id) +
    '&stack=' + encodeURIComponent(getActiveStack());
  window.open('detail.html?' + params, '_blank', 'width=680,height=800,noopener');
}

// ─── Tab switching ────────────────────────────────────────────────────────────

const TABS = ['assets', 'jobs', 'transcoders', 'pipelines', 'profiles', 'collections', 'search', 'webhooks', 'storage', 'provision'];
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

function switchTab(name) {
  if (!TABS.includes(name)) return;
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
  assetsTable = createAssetsTable({
    apiFetch,
    renderBadge,
    renderTags,
    fmtDate,
    isAssetWedged,
    onRowClick: function (id) {
      showAssetDetail(id, detailPanel);
    },
    onDelete: async function (id) {
      if (!confirm('Archive asset ' + id + '?')) return false;
      try {
        await apiFetch('/assets/' + encodeURIComponent(id), { method: 'DELETE' });
        return true;
      } catch (err) {
        alert('Error: ' + err.message);
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
        alert('Re-drive failed: ' + err.message);
        return false;
      }
    },
  });
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
        try {
          const asset = await apiFetch('/assets', {
            method: 'POST',
            body: JSON.stringify({ name: file.name })
          });
          const assetId = asset.id;
          showMsg(uploadProgress, 'Uploading ' + file.name + ' (' + Math.round(file.size / 1024 / 1024 * 10) / 10 + ' MB)…', 'info');
          // Stream the file through the API (avoids CORS on MinIO presigned URLs).
          const uploadRes = await fetch('/api/v1/assets/' + encodeURIComponent(assetId) + '/upload', {
            method: 'PUT',
            body: file,
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
              'Content-Length': String(file.size),
              'X-Stack-Name': getActiveStack()
            }
          });
          if (!uploadRes.ok) {
            const err = await uploadRes.json().catch(() => ({}));
            throw new Error(err.message || err.error || 'Upload failed: HTTP ' + uploadRes.status);
          }
          close();
          if (assetsTable) assetsTable.reload();
        } catch (err) {
          showMsg(uploadProgress, 'Error: ' + err.message, 'error');
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
  await renderAssetDetailBody(id, body);
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
async function renderAssetDetailBody(id, bodyEl) {
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
      ['ID', '<span class="text-mono">' + escHtml(asset.slug || asset.id) + '</span>'],
    ];
    // When a human-friendly slug is present, keep the raw ULID visible too so it
    // stays discoverable in the detail pane. If there is no slug, the "ID" row
    // above already shows the ULID — avoid a duplicate/empty row.
    if (asset.slug) {
      kvRows.push(['ULID', '<span class="text-mono text-muted">' + escHtml(asset.id) + '</span>']);
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
      ['Tags', renderTags(asset.tags)],
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

    // Build the pipeline options from the shared catalog so future built-in
    // pipelines appear automatically. Each option label shows the pipeline id
    // plus its ordered step list, e.g. "subtitles (subtitles)".
    var pipelineOptions = PIPELINE_CATALOG.map(function(p) {
      var stepSummary = p.steps.join(' + ');
      return '<option value="' + escHtml(p.name) + '">' +
        escHtml(p.name + ' (' + stepSummary + ')') + '</option>';
    }).join('');

    const runDiv = document.createElement('div');
    runDiv.className = 'mt12 flex-gap';
    runDiv.innerHTML = [
      '<select id="pipeline-select" class="input">',
      pipelineOptions,
      '</select>',
      '<select id="profile-select" class="input" title="Encode profile (for pipelines with a transcode step)">',
      encodeProfiles.map(function(p) { return '<option value="' + escHtml(p) + '">' + escHtml(p) + '</option>'; }).join(''),
      '</select>',
      '<button id="btn-run-pipeline" class="btn-ghost">Run Pipeline</button>',
    ].join('');
    body.appendChild(runDiv);

    // Show/hide profile selector based on whether chosen pipeline has a transcode step.
    var pipelineSel = runDiv.querySelector('#pipeline-select');
    var profileSel = runDiv.querySelector('#profile-select');
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
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'mt12 flex-gap';
    actionsDiv.innerHTML = [
      '<button id="btn-extract-meta" class="' + (wedgedDetail ? 'btn-primary' : 'btn-ghost') + '">' +
        (wedgedDetail ? 'Re-drive extraction' : 'Extract Metadata') + '</button>',
      '<button id="btn-thumbnails" class="btn-ghost">Thumbnails</button>',
    ].join('');
    body.appendChild(actionsDiv);

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
        var existingUrls = existing && existing.thumbnails ? existing.thumbnails : [];
        if (existingUrls.length) {
          renderThumbnailStrip(thumbArea, existingUrls);
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
        var urls = r && r.thumbnails ? r.thumbnails : [];
        if (urls.length) {
          renderThumbnailStrip(thumbArea, urls);
        } else {
          showMsg(actionMsg, 'Thumbnails extracted.', 'success');
        }
      } catch (err) {
        showMsg(actionMsg, 'Error: ' + err.message, 'error');
      }
    });

    function renderThumbnailStrip(container, urls) {
      var titleEl = document.createElement('div');
      titleEl.className = 'section-title mt12';
      titleEl.textContent = 'Thumbnails';
      container.appendChild(titleEl);
      var strip = document.createElement('div');
      strip.className = 'thumbnails';
      urls.forEach(function(u) {
        var img = document.createElement('img');
        img.src = u;
        img.alt = 'thumbnail';
        strip.appendChild(img);
      });
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
async function renderJobDetailBody(id, bodyEl, opts) {
  opts = opts || {};
  const body = bodyEl;
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
    if (job.assetId) {
      kvRows.push(['Asset ID',
        '<a href="#" class="job-asset-link text-mono" data-asset-id="' + escHtml(job.assetId) + '" style="color:var(--accent)">' + escHtml(job.assetId) + '</a>']);
    } else {
      kvRows.push(['Asset ID', '<span class="text-mono">—</span>']);
    }
    if (job.profile) kvRows.push(['Profile', escHtml(job.profile)]);
    if (job.progress != null) kvRows.push(['Progress', escHtml(job.progress + '%')]);
    kvRows.push(['Created', escHtml(fmtDate(job.createdAt))]);
    kvRows.push(['Updated', escHtml(fmtDate(job.updatedAt))]);
    if (job.error) {
      kvRows.push(['Error', '<span style="color:var(--error,#f87171)">' + escHtml(job.error) + '</span>']);
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
          alert('Error: ' + err.message);
        }
      });
      actions.appendChild(cancelBtn);
      body.appendChild(actions);
    }

    const pre = document.createElement('pre');
    pre.className = 'code-block mt12';
    pre.textContent = JSON.stringify(job, null, 2);
    body.appendChild(pre);
    return job;
  } catch (err) {
    body.innerHTML = '';
    showMsg(body, 'Failed to load job: ' + err.message, 'error');
    throw err;
  }
  }
}

// ─── PIPELINE EXECUTION DETAIL ────────────────────────────────────────────────
// Fetch and render a single PipelineExecution (issue #193) into `bodyEl`.
// Contract: GET /api/v1/pipelines/:executionId — response `pipelineExecutionSchema`
// in src/routes/pipelines.ts (id, assetId, assetName?, pipelineName, status
// [running|done|failed], steps[], createdAt, updatedAt). Each step (per
// stepExecutionSchema): name, status [pending|running|done|failed], jobId?,
// encoreJobId?, error?, startedAt?, completedAt?, progress?.
//
// All server-provided text is inserted via escHtml before interpolation. Returns
// the fetched execution so callers (detail.js) can derive the window title and
// decide whether to keep polling.
async function renderPipelineDetailBody(id, bodyEl) {
  const body = bodyEl;
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

    // Per-step list: status, progress, timestamps, and the FULL error text for
    // failed steps (inline, not tooltip-only). All fields escaped via escHtml.
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
        cells.push('<td><span style="color:' + stepColor(s.status) + '">' + escHtml(s.status) + '</span></td>');
        cells.push('<td>' + (s.progress != null ? escHtml(s.progress + '%') : '—') + '</td>');
        cells.push('<td>' + (s.jobId ? '<span class="text-mono">' + escHtml(s.jobId) + '</span>' : '—') + '</td>');
        cells.push('<td>' + escHtml(fmtDate(s.startedAt)) + '</td>');
        cells.push('<td>' + escHtml(fmtDate(s.completedAt)) + '</td>');
        var row = '<tr>' + cells.join('') + '</tr>';
        // Full error text on its own spanning row so long strings wrap and are
        // fully visible (acceptance criterion: not tooltip-only).
        if (s.error) {
          row += '<tr class="step-error-row"><td colspan="6" style="color:var(--error,#f87171);white-space:pre-wrap;word-break:break-word;">' + escHtml(s.error) + '</td></tr>';
        }
        return row;
      }).join('');

      const table = document.createElement('table');
      table.className = 'mini-table';
      table.innerHTML =
        '<thead><tr>' +
        '<th>Step</th><th>Status</th><th>Progress</th><th>Job</th><th>Started</th><th>Completed</th>' +
        '</tr></thead><tbody>' + rows + '</tbody>';
      body.appendChild(table);
    }

    const pre = document.createElement('pre');
    pre.className = 'code-block mt12';
    pre.textContent = JSON.stringify(exec, null, 2);
    body.appendChild(pre);
    return exec;
  } catch (err) {
    body.innerHTML = '';
    showMsg(body, 'Failed to load pipeline execution: ' + err.message, 'error');
    throw err;
  }
}

// ─── COLLECTIONS TAB ─────────────────────────────────────────────────────────

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
      return '<tr data-id="' + escHtml(c.id) + '">' +
        '<td class="cell-id">' + escHtml(c.id) + '</td>' +
        '<td>' + escHtml(c.name || '—') + '</td>' +
        '<td>' + escHtml(String(assetCount)) + '</td>' +
        '<td>' + escHtml(fmtDate(c.createdAt)) + '</td>' +
        '<td>' +
          '<button class="btn-ghost coll-view-btn" data-id="' + escHtml(c.id) + '" style="font-size:12px;padding:3px 8px;">View</button>' +
          '<button class="btn-danger coll-delete-btn" data-id="' + escHtml(c.id) + '" style="font-size:12px;padding:3px 8px;margin-left:4px;">Delete</button>' +
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

    tableWrap.querySelectorAll('.coll-view-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { showCollectionDetail(btn.dataset.id, detailPanel, loadCollections); });
    });
    tableWrap.querySelectorAll('.coll-delete-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        if (!confirm('Delete collection ' + btn.dataset.id + '?')) return;
        try {
          await apiFetch('/collections/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
          loadCollections();
        } catch (err) {
          alert('Error: ' + err.message);
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

    // Add asset form
    const addDiv = document.createElement('div');
    addDiv.className = 'mt12';
    addDiv.innerHTML = [
      '<div class="section-title">Add asset to collection</div>',
      '<div class="form-row mt8">',
      '  <div class="form-field grow">',
      '    <input type="text" id="add-asset-id" placeholder="Asset ID" />',
      '  </div>',
      '  <button id="add-asset-btn">Add</button>',
      '</div>',
      '<div id="add-asset-msg"></div>',
    ].join('');
    body.appendChild(addDiv);

    addDiv.querySelector('#add-asset-btn').addEventListener('click', async function() {
      const assetId = addDiv.querySelector('#add-asset-id').value.trim();
      const msgEl = addDiv.querySelector('#add-asset-msg');
      msgEl.innerHTML = '';
      if (!assetId) { showMsg(msgEl, 'Asset ID required.', 'error'); return; }
      try {
        await apiFetch('/collections/' + encodeURIComponent(id) + '/assets/' + encodeURIComponent(assetId), { method: 'PUT', body: JSON.stringify({}) });
        showMsg(msgEl, 'Asset added.', 'success');
        showCollectionDetail(id, detailPanel, onRefresh);
      } catch (err) {
        showMsg(msgEl, 'Error: ' + err.message, 'error');
      }
    });

    // Asset list
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
      const rows = assets.map(function(a) {
        return '<tr>' +
          '<td class="cell-id" title="' + escHtml(a.id) + '">' + escHtml(a.slug || a.id) + '</td>' +
          '<td>' + escHtml(a.title || a.name || '—') + '</td>' +
          '<td>' + renderBadge(a.status) + '</td>' +
          '<td><button class="btn-danger remove-asset-btn" data-asset-id="' + escHtml(a.id) + '" style="font-size:12px;padding:3px 8px;">Remove</button></td>' +
          '</tr>';
      }).join('');
      const tableWrap = document.createElement('div');
      tableWrap.className = 'table-wrap';
      tableWrap.innerHTML = '<table>' +
        '<thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Actions</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>';
      assetsDiv.appendChild(tableWrap);

      tableWrap.querySelectorAll('.remove-asset-btn').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          try {
            await apiFetch('/collections/' + encodeURIComponent(id) + '/assets/' + encodeURIComponent(btn.dataset.assetId), { method: 'DELETE' });
            showCollectionDetail(id, detailPanel, onRefresh);
          } catch (err) {
            alert('Error: ' + err.message);
          }
        });
      });
    }
    body.appendChild(assetsDiv);

  } catch (err) {
    body.innerHTML = '';
    showMsg(body, 'Failed: ' + err.message, 'error');
  }
}

// ─── SEARCH TAB ──────────────────────────────────────────────────────────────

async function renderSearchTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Search';
  container.appendChild(title);

  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = [
    '<div class="section-title">Search assets</div>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="search-q">Query</label>',
    '    <input type="text" id="search-q" placeholder="Full-text search…" />',
    '  </div>',
    '  <div class="form-field">',
    '    <label for="search-tags">Tags (comma-separated)</label>',
    '    <input type="text" id="search-tags" placeholder="news,sports" />',
    '  </div>',
    '  <div class="form-field">',
    '    <label for="search-mime">MIME type</label>',
    '    <input type="text" id="search-mime" placeholder="video/mp4" />',
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
      const assets = Array.isArray(res) ? res :
        (res && (res.items || res.results || res.assets) ? (res.items || res.results || res.assets) : []);
      loader.remove();
      if (assets.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No results.';
        resultsEl.appendChild(empty);
        return;
      }
      const rows = assets.map(function(a) {
        return '<tr>' +
          '<td class="cell-id" title="' + escHtml(a.id) + '">' + escHtml(a.slug || a.id) + '</td>' +
          '<td>' + escHtml(a.title || a.name || '—') + '</td>' +
          '<td>' + renderBadge(a.status) + '</td>' +
          '<td>' + renderTags(a.tags) + '</td>' +
          '<td>' + escHtml(a.mimeType || '—') + '</td>' +
          '<td>' + escHtml(fmtDate(a.createdAt)) + '</td>' +
          '</tr>';
      }).join('');
      const tableWrap = document.createElement('div');
      tableWrap.className = 'table-wrap';
      tableWrap.innerHTML = '<table>' +
        '<thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Tags</th><th>MIME type</th><th>Created</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>';
      resultsEl.appendChild(tableWrap);
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
        if (!confirm('Delete profile ' + btn.dataset.name + '?')) return;
        try {
          await apiFetch('/profiles/' + encodeURIComponent(btn.dataset.name), { method: 'DELETE' });
          listSection.querySelector('#pf-yaml-view').innerHTML = '';
          loadProfiles();
        } catch (err) {
          alert('Error: ' + err.message);
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
    if (!confirm('Seed profiles from the default Encore profile index?')) return;
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
        '<td><button class="btn-danger wh-delete-btn" data-id="' + escHtml(wh.id) + '" style="font-size:12px;padding:3px 8px;">Delete</button></td>' +
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
        if (!confirm('Delete webhook ' + btn.dataset.id + '?')) return;
        try {
          await apiFetch('/webhooks/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
          loadWebhooks();
        } catch (err) {
          alert('Error: ' + err.message);
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
      '<td><button class="btn-danger storage-delete-btn" data-key="' + escHtml(o.key) + '" style="font-size:12px;padding:3px 8px;">Delete</button></td>' +
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
      if (!confirm('Delete object ' + btn.dataset.key + '?')) return;
      try {
        const path = btn.dataset.key.split('/').map(encodeURIComponent).join('/');
        await apiFetch('/storage/buckets/' + encodeURIComponent(bucket) + '/objects/' + path, { method: 'DELETE' });
        openBucketBrowser(browser, bucket, prefix);
      } catch (err) {
        alert('Error: ' + err.message);
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
      removeBtn.addEventListener('click', function() {
        if (!confirm('Remove stack "' + name + '"? This will destroy all OSC services in the stack.')) return;
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
      deprovBtn.addEventListener('click', function() {
        if (!confirm('Deprovision the scene-detect instance "' + status.instanceName + '"?')) return;
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
        delBtn.addEventListener('click', function() {
          const nm = (status && status.instanceName) || OPTIONAL_KEY;
          if (!confirm('Deprovision the auto-subtitles instance "' + nm + '"? This destroys the OSC instance.')) return;
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
  var catalogBar = document.createElement('div');
  catalogBar.className = 'pipeline-catalog-bar';
  PIPELINE_CATALOG.forEach(function(pipeline) {
    var pill = document.createElement('span');
    pill.className = 'pipeline-catalog-pill';
    pill.title = pipeline.description + '\nSteps: ' + pipeline.steps.join(' → ');
    pill.innerHTML =
      '<span class="pipeline-catalog-pill-name">' + escHtml(pipeline.label) + '</span>' +
      '<span class="pipeline-catalog-pill-id">' + escHtml(pipeline.name) + '</span>';
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

// Human-readable relative time for a lastIdleAt epoch-ms value ("X minutes ago").
function relativeTime(epochMs) {
  if (epochMs == null || isNaN(epochMs)) return '—';
  const diffMs = Date.now() - Number(epochMs);
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return sec + ' second' + (sec === 1 ? '' : 's') + ' ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' minute' + (min === 1 ? '' : 's') + ' ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' hour' + (hr === 1 ? '' : 's') + ' ago';
  const day = Math.floor(hr / 24);
  return day + ' day' + (day === 1 ? '' : 's') + ' ago';
}

// Derive per-instance job capacity from the pool records rather than hardcoding.
// The scaler treats an instance as "busy" at JOBS_PER_INSTANCE (=1) but that
// constant is not on the wire; instead we infer capacity as the highest
// activeJobs observed across the pool, floored at 1 so a fully-idle pool still
// reports a sane capacity of 1.
function deriveInstanceCapacity(instances) {
  let cap = 1;
  (instances || []).forEach(function(inst) {
    const a = Number(inst.activeJobs) || 0;
    if (a > cap) cap = a;
  });
  return cap;
}

// Green (idle) / amber (partial) / red (at capacity) load class for an instance.
function loadClass(activeJobs, capacity) {
  const a = Number(activeJobs) || 0;
  if (a <= 0) return 'load-idle';
  if (a >= capacity) return 'load-full';
  return 'load-partial';
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

    const capacity = deriveInstanceCapacity(flatInstances.map(function(f) { return f.inst; }));

    const grid = document.createElement('div');
    grid.className = 'tc-grid';
    grid.innerHTML = flatInstances.map(function(f) {
      const inst = f.inst;
      const active = Number(inst.activeJobs) || 0;
      const cls = loadClass(active, capacity);
      const label = active <= 0 ? 'idle' : (active >= capacity ? 'at capacity' : 'partial');
      return [
        '<div class="tc-card">',
        '  <div class="tc-card-head">',
        '    <span class="tc-id text-mono">' + escHtml(inst.instanceId) + '</span>',
        '    <span class="tc-load ' + cls + '" title="' + escHtml(label) + '">',
        '      <span class="tc-dot"></span>' + escHtml(String(active)) + ' / ' + escHtml(String(capacity)),
        '    </span>',
        '  </div>',
        '  <div class="tc-row">',
        '    <a href="' + escHtml(inst.url) + '" target="_blank" rel="noopener" class="text-mono tc-url">' + escHtml(inst.url) + '</a>',
        '  </div>',
        '  <div class="tc-meta">',
        '    <span class="text-muted">Workspace</span> <span class="text-mono">' + escHtml(f.workspaceId) + '</span>',
        '  </div>',
        '  <div class="tc-meta">',
        '    <span class="text-muted">Last idle</span> ' + escHtml(relativeTime(inst.lastIdleAt)),
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

// ─── Tab renderer registry ───────────────────────────────────────────────────

TAB_RENDERERS['assets'] = renderAssetsTab;
TAB_RENDERERS['jobs'] = renderJobsTab;
TAB_RENDERERS['logs'] = renderLogsTab;
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
