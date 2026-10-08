/**
 * open-videocore ops dashboard — export-action.js
 *
 * The "Export" block on the asset detail view (issue #945, broken out of #796):
 * pick one of the export destinations this deployment has registered, trigger
 * the export, and read the outcome truthfully.
 *
 * Copy and visual treatment follow the interaction spec written for the
 * prerequisite design ticket #911 — `docs/design/export-action-states.md`
 * (§1 vocabulary, §2 in progress, §3 succeeded, §4 failed, §5 not available),
 * which lands with that ticket's own branch (`issue-911/export-action-states`).
 * That spec was written BEFORE a destination-carrying endpoint existed and said
 * so explicitly: its §0 note "Named export destinations are a different
 * contract" ends with *"If a future ticket wires the export action to accept a
 * named `destination` …, this document's §4 state needs a second variant for
 * 'destinations registry configured but nothing registered'"*. Issue #1131 is
 * that ticket, so this module implements the spec's shape against the
 * destination endpoint and adds the two states the spec deferred:
 * "no destinations are registered" and "the destination list could not be
 * read".
 *
 * Everything operator-visible is written with `textContent` / `createElement`.
 * No server string ever reaches `innerHTML` — including a 502/504 `message`,
 * which is third-party-derived text.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from route source and the generated spec in this repo. Nothing is taken
 * from issue text.
 *
 *   Read — `GET /api/v1/export-destinations`
 *     Handler: `app.get('/')`, src/routes/export-destinations.ts:279-288,
 *       mounted at prefix `/api/v1/export-destinations` (src/main.ts:2448-2449);
 *       `openapi.json .paths["/api/v1/export-destinations/"].get`.
 *     No parameters. Responses: exactly `200` and `501`.
 *       200 = `destinationListSchema` (export-destinations.ts:125-127):
 *         `{ destinations: DestinationView[] }`.
 *         `DestinationView` = `destinationViewSchema` (:95-123):
 *           `{ id, name, role: 'source'|'packaged'|'both'|'archive',
 *              backend: 'external', bucket, accessKeyId, endpointUrl?,
 *              region?, publicBaseUrl?, pathTemplate?, hasSessionToken,
 *              deletable, createdAt,
 *              credentials: { accessKeyId, secretAccessKey: '***redacted***',
 *                             sessionToken?: '***redacted***' } }`.
 *         The list is ALREADY filtered server-side to the two output-serving
 *         roles (`isExportDestination`, :174-176), so no role filtering is
 *         strictly needed here; the client filter below is defence only.
 *       501 = `{ error: 'not_configured', message: 'export destinations are not
 *         configured' }` (:236-239, sent at :283) — no storage-backend registry
 *         (and therefore no credential store) on this deployment.
 *     THE IMPLICIT OSC-MANAGED DEFAULT IS ALWAYS IN THIS LIST.
 *       `StorageBackendRegistry.list` unconditionally prepends
 *       `defaultBackendView()` (src/services/storage-backend-registry.ts:686-693
 *       and :138-153): `{ id: 'default', name: 'OSC-managed default',
 *       role: 'both', deletable: false }`, and role `'both'` passes the
 *       destinations view's own filter. So `200 { destinations: [] }` is NOT
 *       reachable while the registry is wired — "nothing is registered" shows up
 *       as a list containing ONLY that default entry. It is filtered out of the
 *       picker here because the export endpoint REFUSES it by name (below): it
 *       is the store the asset already lives in, not somewhere to export to.
 *       Its id is `DEFAULT_BACKEND_ID = 'default'`
 *       (storage-backend-registry.ts:57), mirrored as
 *       `OSC_MANAGED_DEFAULT_ID` below.
 *
 *   Write — `POST /api/v1/assets/{id}/deliver` (issue #1131, PR #1158 — merged)
 *     Handler: `app.post('/:id/deliver', …)`, src/routes/assets.ts (the
 *       "Deliver an EXISTING asset to a registered export destination" block).
 *       Re-verified after #1158 merged, against the generated spec now on main:
 *       `openapi.json .paths["/api/v1/assets/{id}/deliver"].post`. The shape
 *       below is that entry, not an anticipated one. This module's tests still
 *       stub the endpoint; nothing here requires a live backend.
 *     parameters: exactly one — path `id` (string, required). No query params.
 *     requestBody: `required: true`, `application/json`, schema
 *       `{ destination: string(minLength 1, maxLength 256) }` — the ONLY
 *       property, `additionalProperties: false` (`deliverBodySchema`). The value
 *       is the stable id OR the human name of a registered output-role
 *       destination; this module always sends the id it read from the list.
 *     responses: exactly `200, 400, 404, 409, 422, 501, 502, 504`.
 *       200 = `deliverResultSchema`:
 *         `{ assetId, status: 'delivered', destination: { id, name,
 *            role: 'packaged'|'both' }, bucket, objectKey, bytes, etag,
 *            deliveredAt }`.
 *         `status` has the single literal value `'delivered'` and is sent ONLY
 *         after the object was re-read at the destination with the source's byte
 *         count, so a 200 cannot mean "submitted" or "probably". The success
 *         state below therefore names the verified coordinates — and still
 *         checks the literal, rather than treating any 2xx as a success.
 *       400 = `errorSchema` `{ error: 'bad_request', message }` — the reference
 *         names no registered destination, or names the OSC-managed default.
 *       404 = `{ error: 'not_found' }` — unknown/foreign asset; existence is
 *         deliberately not distinguished from "not yours".
 *       409 = `{ error: 'no_object', message: 'asset has no stored source object
 *         to process' }` (`NO_SOURCE_OBJECT_ERROR`,
 *         src/pipeline/source-object.ts:31/37, via the shared
 *         `requireSourceObject`), or `{ error: 'source_missing', message }` —
 *         the document named an object the source bucket does not have, so there
 *         was nothing to copy.
 *       422 = `{ error: 'backend_role' | 'destination_unreachable' |
 *         'destination_unresolved' | 'source_too_large', message }` — refusals
 *         decided BEFORE any bytes moved. `destination_unreachable` is the
 *         common one in practice: a destination registered at its own
 *         `endpointUrl` cannot be delivered to from here, because its secret
 *         access key is stored write-only in OSC per-service secrets and cannot
 *         be read back (`destinationEndpointRefusal`,
 *         src/pipeline/asset-delivery.ts) — the endpoint refuses rather than
 *         copying to a same-named bucket on our own store and reporting a
 *         success for bytes the operator never received.
 *       501 = `{ error: 'not_configured', message }` — no storage-backend
 *         registry, or no object storage, on this deployment.
 *       502 = `{ error: 'delivery_failed', message }` — the copy failed, or the
 *         store reported success and the object is not actually there
 *         (`copy_failed` / `not_landed`, `DELIVERY_FAILURE_RESPONSE`).
 *       504 = `{ error: 'delivery_timeout', message }` — the delivery did not
 *         settle within the bound, so the outcome is GENUINELY UNKNOWN. This is
 *         the one case that must be reported as neither success nor clean
 *         failure; `EXPORT_COPY.unsettled` + `unsettledAdvice` below say exactly
 *         that, and the module never falls back to "export failed" for it.
 *     The honesty rule applied to all of the above — report what was verified,
 *       and never derive an outcome from "the call returned without throwing" —
 *       is the one `docs/findings/export-truthful-status-944.md` (issue #944,
 *       this ticket's stated prerequisite) established for the other export
 *       endpoint.
 *
 *   Authorisation — the role×action matrix `MATRIX` (src/auth/authorize.ts:54-58:
 *     `viewer { read: true, write: false }`, editor/admin all true) with the
 *     action derived by `methodToAction` (:79-92: POST -> `write`), applied by
 *     `resourceAuthorizationPreHandler('asset')` (:126, registered in
 *     src/routes/assets.ts). A `viewer` is refused the POST with 403
 *     `AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role'` (:99) — but may
 *     still READ the destinations list, so the list is fetched for every role and
 *     the picker is simply not offered to a `viewer`. `canExport` is the caller's
 *     client-role mirror; the 403 path below runs regardless, because the server
 *     is the authority. (403 is not in the route's declared response map because
 *     the preHandler sends it ahead of the handler.)
 *
 *   NOT rendered, because the contract does not support it:
 *
 *   1. A CONTAINER-FORMAT PICKER. `deliverBodySchema` has exactly one property
 *      (above): this endpoint moves the bytes that already exist, so there is no
 *      format, profile or output name to choose. Re-wrapping into another
 *      container is a DIFFERENT contract — `POST /:id/export`
 *      (`exportBodySchema` = `{ targetFormat, outputName?, asVersion? }`), which
 *      in turn has no destination field and always writes to the workspace's own
 *      storage. The two are not conflated here.
 *   2. A PROGRESS BAR OR PERCENTAGE. The endpoint awaits the copy and the
 *      response IS the outcome; there is no job id, no poll route and no
 *      partial-progress signal, so §2's busy state is deliberately
 *      indeterminate.
 *   3. A LINK TO A NEW ASSET. A delivery creates NO asset — it copies an
 *      existing object to another bucket. The success state names the verified
 *      bucket/key instead, which is what the response actually carries.
 *   4. A DOWNLOAD LINK AT THE DESTINATION. The response carries no URL, and a
 *      destination's `publicBaseUrl` is optional operator config that this
 *      endpoint does not claim the delivered object is reachable under. Guessing
 *      one would be inventing a location.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The id of the implicit OSC-managed default backend, mirroring
 * `DEFAULT_BACKEND_ID` (src/services/storage-backend-registry.ts:57).
 *
 * It is always present in `GET /api/v1/export-destinations` and the export
 * endpoint refuses it with a 400 ("the platform-managed default store the asset
 * already lives in, not an export destination"), so it must never reach the
 * picker.
 */
export const OSC_MANAGED_DEFAULT_ID = 'default';

/**
 * The destination roles that can receive an export: the output-serving roles.
 *
 * Mirrors `isExportDestination` (src/routes/export-destinations.ts:174-176) and
 * the export endpoint's own role refusal (422 `backend_role`). The listing
 * endpoint already applies this filter, so this is defence in depth only.
 */
export const DELIVERABLE_ROLES = Object.freeze(['packaged', 'both']);

/**
 * The remaining two members of the declared role enum
 * (`destinationViewSchema.role`, src/routes/export-destinations.ts:98):
 * read/cold storage, which the export endpoint refuses with a 422
 * `backend_role`.
 *
 * The filter below excludes THESE rather than keeping only
 * `DELIVERABLE_ROLES`, so a role value added to the server's enum in future is
 * still offered: the listing endpoint has already decided the entry is a
 * destination, and the API is the authority on its own vocabulary. Excluding
 * the two known-bad values keeps the defence where it is actually needed.
 */
export const NON_DELIVERABLE_ROLES = Object.freeze(['source', 'archive']);

/** `GET`/`POST` paths, relative to the UI's `/api/v1` base (`apiFetch`). */
export const DESTINATIONS_PATH = '/export-destinations';

/**
 * The asset-scoped export path. Takes the ULID: sub-resource routes do not
 * resolve slugs.
 *
 * @param {string} assetId
 * @returns {string}
 */
export function exportPathFor(assetId) {
  return '/assets/' + encodeURIComponent(String(assetId)) + '/deliver';
}

/**
 * Operator-visible copy.
 *
 * `docs/design/export-action-states.md` §1 pins the vocabulary: the action is
 * "Export" (never the pipeline's internal "deliver"/"re-wrap" names), and the
 * asset being exported is the "source" (never "original"/"parent").
 */
export const EXPORT_COPY = Object.freeze({
  heading: 'Export',
  /** Explains what the action does, where the output goes, and what a success means. */
  intro:
    'Export copies this asset’s stored file to one of the export destinations ' +
    'registered on this deployment. The file is copied as-is — nothing is ' +
    're-encoded. The result is reported only after the object has been re-read ' +
    'at the destination.',
  destinationLabel: 'Destination',
  destinationHint:
    'Destinations registered on this deployment. The platform-managed default ' +
    'store is not listed: it is where this asset already lives.',
  submit: 'Export',
  busy: 'Exporting…',
  loading: 'Loading destinations…',
  /** §2 — in progress. */
  inProgress: function (destination) {
    return 'Exporting to ' + destinationLabel(destination) + '…';
  },
  /** §3 — succeeded (200, `status: 'delivered'`). The verified coordinates follow. */
  succeeded: function (destination) {
    return 'Exported to ' + destinationLabel(destination) + '.';
  },
  /** §3 — labels for the verified facts the 200 body carries. */
  factBucket: 'Bucket',
  factObjectKey: 'Object key',
  factBytes: 'Size',
  factEtag: 'ETag',
  factDeliveredAt: 'Verified at',
  /** §4 — failed (502). The server's own sentence follows, verbatim. */
  failed: function (destination) {
    return 'Export to ' + destinationLabel(destination) + ' failed:';
  },
  /** §4 (new variant) — refused before any bytes moved (422). */
  refused: function (destination) {
    return 'Export to ' + destinationLabel(destination) + ' was refused:';
  },
  /**
   * §4 (new variant) — 504. The outcome is genuinely unknown, so this must read
   * as neither a success nor a clean failure.
   */
  unsettled: function (destination) {
    return 'Export to ' + destinationLabel(destination) + ' did not settle:';
  },
  unsettledAdvice:
    'The outcome is unknown — the copy may still complete at the destination. ' +
    'Check the destination bucket before exporting again.',
  /** §4 table — 400: the picker offered a destination the API does not have. */
  errUnknownDestination:
    'That destination is no longer registered. The list has been reloaded.',
  /** §4 table — 404. Does not narrow which of "gone" or "not yours". */
  errNotFound: 'This asset no longer exists.',
  /** §4 table — 409 `no_object`. Prefers naming the asset over the generic sentence. */
  errNoObject: function (sourceName) {
    return (sourceName && String(sourceName).trim()
      ? String(sourceName).trim()
      : 'This asset') + ' has no stored file to export.';
  },
  /**
   * Transport failure — no HTTP status at all. Mirrors the house wording used
   * for the same case by the review-state block (`REVIEW_COPY.errNetwork`,
   * public/review-state.js), which is the convention for "the request never
   * landed, so nothing changed".
   */
  errNetwork: 'Could not reach the API. Nothing was exported.',
  /**
   * A 2xx whose body does not carry the one terminal value the contract
   * declares. Reported rather than assumed, because "the call returned" is not
   * evidence that an object landed.
   */
  errUnconfirmed: function (status) {
    return (
      'The API answered without confirming the export' +
      (status ? ' (status “' + String(status) + '”)' : '') +
      '. Check the destination before assuming anything landed.'
    );
  },
  /**
   * 403 from `resourceAuthorizationPreHandler`. Not an export outcome — the
   * request never reached the handler. Wording mirrors the house precedent for
   * the identical gate on the review-state and lock blocks.
   */
  errForbidden:
    'Your role cannot export this asset. Ask an editor or administrator.',
  /** Pre-emptive mirror of the same gate, so a doomed control is not offered. */
  readOnly:
    'Your role can see this asset but cannot export it. Ask an editor or ' +
    'administrator.',
  /** §5 — no destination storage configured at all (501). */
  notConfiguredLabel: 'Export not available',
  notConfiguredTitle: 'Export is not available on this deployment',
  notConfiguredBody:
    'This deployment has no export destination storage configured. Ask an ' +
    'operator to configure it before this action can be used here.',
  /** Prefix for the server's own 501 sentence, when it carries one. */
  notConfiguredDetailPrefix: 'The API reported: ',
  /**
   * §5 second variant (the one the design spec deferred until a destination
   * endpoint existed): destination storage IS configured, but no destination has
   * been registered, so there is nowhere to export to. Distinct from the 501
   * above, because the operator action that fixes it is different.
   */
  noDestinationsLabel: 'No destinations',
  noDestinationsTitle: 'No export destinations are registered',
  noDestinationsBody:
    'This deployment has export destination storage configured but no ' +
    'destination registered, so there is nowhere to export to. An operator can ' +
    'register one with POST /api/v1/export-destinations; it will appear here.',
  noDestinationsDefaultNote:
    'The platform-managed default store is not an export destination — it is ' +
    'where this asset already lives.',
  /**
   * The list itself could not be read (anything other than a 200 or the 501
   * above). NOT reported as "no destinations are registered": we do not know
   * that, and claiming it would be the same class of false statement this
   * feature exists to avoid.
   */
  unreadableLabel: 'Destinations unavailable',
  unreadableTitle: 'Could not load the export destinations',
  unreadableBody:
    'The destination list could not be read, so no destination can be offered. ' +
    'This says nothing about whether destinations are registered.',
  retry: 'Retry',
});

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * The display label for a destination: its operator-chosen `name`, falling back
 * to its stable `id`.
 *
 * Accepts either a destination view or a plain string (the label already
 * resolved), so the copy helpers can be called with whichever the caller holds.
 *
 * @param {unknown} destination
 * @returns {string}
 */
export function destinationLabel(destination) {
  if (destination == null) return '';
  if (typeof destination === 'string') return destination;
  const d = /** @type {{ name?: unknown, id?: unknown }} */ (destination);
  if (typeof d.name === 'string' && d.name.trim()) return d.name.trim();
  if (typeof d.id === 'string' && d.id.trim()) return d.id.trim();
  return '';
}

/**
 * The destinations from a `GET /api/v1/export-destinations` 200 body that this
 * action may offer.
 *
 * Two exclusions, each for a reason the export endpoint itself enforces:
 *   - the implicit OSC-managed default (`id === 'default'`), which the endpoint
 *     refuses with a 400 because it is the store the asset already lives in. It
 *     is ALWAYS in the list (see CONTRACT GROUNDING), so without this filter the
 *     picker's first entry would be a guaranteed 400;
 *   - an entry whose `role` is one of the two read/cold roles
 *     (`NON_DELIVERABLE_ROLES`), which the endpoint refuses with a 422
 *     `backend_role`. The listing endpoint already filters these out, so this
 *     only fires if that ever changes.
 * An entry whose `role` is absent or is a value this build has not heard of is
 * KEPT: the API is the authority on its own vocabulary, and the listing endpoint
 * has already decided the entry is a destination.
 *
 * Anything without a usable `id` is dropped — there would be nothing to send.
 *
 * @param {unknown} body the parsed 200 body, or an array of views
 * @returns {Array<object>}
 */
export function deliverableDestinations(body) {
  const list = Array.isArray(body)
    ? body
    : body && Array.isArray(/** @type {{destinations?: unknown}} */ (body).destinations)
      ? /** @type {{destinations: Array<unknown>}} */ (body).destinations
      : [];
  return list.filter(function (entry) {
    if (!entry || typeof entry !== 'object') return false;
    const d = /** @type {{ id?: unknown, role?: unknown }} */ (entry);
    if (typeof d.id !== 'string' || d.id.trim() === '') return false;
    if (d.id === OSC_MANAGED_DEFAULT_ID) return false;
    if (typeof d.role === 'string' && NON_DELIVERABLE_ROLES.includes(d.role)) return false;
    return true;
  });
}

/**
 * The non-secret coordinates of a destination, as fact/value pairs for the
 * detail line under the picker.
 *
 * Only fields the view actually declares are shown, and only non-secret ones:
 * `bucket`, `pathTemplate` (operator config, echoed by design), `endpointUrl`
 * and `role`. The `credentials` object is never read — its `secretAccessKey` is
 * the fixed redaction marker, and echoing a marker would only suggest there is
 * a secret here to look at.
 *
 * @param {object} destination
 * @returns {Array<{ label: string, value: string }>}
 */
export function describeDestination(destination) {
  const d = /** @type {Record<string, unknown>} */ (destination || {});
  const facts = [];
  const push = function (label, value) {
    if (typeof value === 'string' && value.trim()) facts.push({ label, value: value.trim() });
  };
  push('Bucket', /** @type {string} */ (d['bucket']));
  push('Path template', /** @type {string} */ (d['pathTemplate']));
  push('Endpoint', /** @type {string} */ (d['endpointUrl']));
  push('Role', /** @type {string} */ (d['role']));
  push('Id', /** @type {string} */ (d['id']));
  return facts;
}

/**
 * Build the request body for `POST /api/v1/assets/{id}/deliver`.
 *
 * Exactly the one declared property and no others — the schema is
 * `additionalProperties: false`, so an invented key would be a 400. The value is
 * the destination's stable `id` (the endpoint also accepts its name; the id is
 * sent because it cannot be ambiguous).
 *
 * @param {string} destinationId
 * @returns {{ destination: string }}
 */
export function buildDeliverBody(destinationId) {
  return { destination: String(destinationId) };
}

/**
 * Human-readable byte count for the verified size in a 200 body. Decimal units,
 * matching the house `formatBytes` convention in public/app.js.
 *
 * @param {unknown} bytes
 * @returns {string}
 */
export function formatDeliveredBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return bytes + ' B';
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value = value / 1000;
    unit += 1;
  }
  return (value < 10 ? value.toFixed(1) : Math.round(value)) + ' ' + units[unit];
}

/**
 * Classify a thrown `apiFetch` error from the EXPORT request into the state this
 * block should enter.
 *
 * `apiFetch` (public/app.js) attaches `err.status` and the parsed `err.body`,
 * and sets `err.message` to `body.message || body.error || 'HTTP <status>'` —
 * so for a 502/504 `err.message` IS the server's `message` field verbatim, which
 * is what §4 requires the UI to print.
 *
 * `notConfigured` is keyed on the status AND on the `error` code, because the
 * 501 condition is reachable from two call sites with different `message` text
 * (no registry; no object storage).
 *
 * @param {{status?: number, body?: {error?: string, message?: string}, message?: string}} err
 * @param {{destination?: unknown, sourceName?: string}} [ctx]
 * @returns {{ kind: string, message: string, detail?: string, notConfigured: boolean,
 *             forbidden: boolean, unsettled: boolean, staleList: boolean }}
 */
export function classifyExportError(err, ctx) {
  const e = err || {};
  const c = ctx || {};
  const status = typeof e.status === 'number' ? e.status : undefined;
  const code = e.body && typeof e.body.error === 'string' ? e.body.error : '';
  const serverMessage = typeof e.message === 'string' ? e.message : '';
  const dest = c.destination;
  const base = {
    notConfigured: false,
    forbidden: false,
    unsettled: false,
    staleList: false,
  };

  if (status === 501 || code === 'not_configured') {
    return Object.assign({}, base, {
      kind: 'not-configured',
      message: EXPORT_COPY.notConfiguredTitle,
      // The server's own sentence, shown as supporting detail rather than as
      // the headline: the headline must name the condition (acceptance
      // criterion), and the API's wording names internal machinery.
      detail: serverMessage,
      notConfigured: true,
    });
  }
  if (status === 403) {
    return Object.assign({}, base, {
      kind: 'forbidden',
      message: EXPORT_COPY.errForbidden,
      forbidden: true,
    });
  }
  if (status === 400) {
    // The picker offered something the API does not have (removed between the
    // list and the click). The list is reloaded by the caller, so say so.
    return Object.assign({}, base, {
      kind: 'unknown-destination',
      message: EXPORT_COPY.errUnknownDestination,
      detail: serverMessage,
      staleList: true,
    });
  }
  if (status === 404) {
    return Object.assign({}, base, {
      kind: 'not-found',
      message: EXPORT_COPY.errNotFound,
    });
  }
  if (code === 'no_object') {
    return Object.assign({}, base, {
      kind: 'no-object',
      message: EXPORT_COPY.errNoObject(c.sourceName),
    });
  }
  if (status === 409) {
    // `source_missing`: the document named an object the bucket does not have.
    // The server's sentence says which, so it is printed verbatim.
    return Object.assign({}, base, {
      kind: 'source-missing',
      message: EXPORT_COPY.failed(dest) + ' ' + serverMessage,
    });
  }
  if (status === 422) {
    // Refused before any bytes moved — a destination this API cannot write to or
    // verify, a non-output role, or an over-size source. All caller-actionable,
    // and none of them mean a partial copy happened.
    return Object.assign({}, base, {
      kind: 'refused',
      message: EXPORT_COPY.refused(dest) + ' ' + serverMessage,
    });
  }
  if (status === 504 || code === 'delivery_timeout') {
    // The one outcome that is neither success nor clean failure. Never collapse
    // this into "failed": the copy may still complete store-side.
    return Object.assign({}, base, {
      kind: 'unsettled',
      message:
        EXPORT_COPY.unsettled(dest) +
        ' ' +
        serverMessage +
        ' ' +
        EXPORT_COPY.unsettledAdvice,
      unsettled: true,
    });
  }
  if (status === 502 || code === 'delivery_failed') {
    // §4: print the server's sentence, never a generic "Export failed".
    return Object.assign({}, base, {
      kind: 'failed',
      message: EXPORT_COPY.failed(dest) + ' ' + serverMessage,
    });
  }
  if (status === undefined) {
    return Object.assign({}, base, {
      kind: 'network',
      message: EXPORT_COPY.errNetwork,
    });
  }
  // Any other status: report what the API said rather than inventing a cause.
  return Object.assign({}, base, {
    kind: 'other',
    message: EXPORT_COPY.failed(dest) + ' ' + (serverMessage || 'HTTP ' + status),
  });
}

/**
 * Classify a thrown `apiFetch` error from the DESTINATION LIST request.
 *
 * The list has exactly two declared responses, so there are exactly two states:
 * the deployment has no destination storage (501), or we could not read the list
 * (anything else, including a transport failure). The second is deliberately NOT
 * folded into "no destinations are registered" — we do not know that.
 *
 * @param {{status?: number, body?: {error?: string, message?: string}, message?: string}} err
 * @returns {{ notConfigured: boolean, message: string }}
 */
export function classifyDestinationsError(err) {
  const e = err || {};
  const status = typeof e.status === 'number' ? e.status : undefined;
  const code = e.body && typeof e.body.error === 'string' ? e.body.error : '';
  const serverMessage = typeof e.message === 'string' ? e.message : '';
  if (status === 501 || code === 'not_configured') {
    return { notConfigured: true, message: serverMessage };
  }
  return { notConfigured: false, message: serverMessage };
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * The shared shape for the three standing-state blocks below: an uppercase label
 * row, a title, a body, and optional extra lines.
 *
 * Deliberately NOT a `.msg-error` (none of these is something that just failed
 * and might work on retry) and NOT `.msg-unrecoverable` (that component's copy
 * and `data-outcome="unrecoverable"` semantics belong to the 410 tombstone and
 * talk about purging). It borrows that component's SHAPE through its own
 * `.msg-not-configured` class and carries its own `data-outcome` value, so a
 * test or a future view can tell them apart without matching on prose.
 */
function standingState(outcome, label, title, body, extras) {
  const block = el('div', 'msg msg-not-configured');
  block.setAttribute('data-outcome', outcome);
  // Programmatically focusable WITHOUT entering the tab order, so the mount can
  // move focus here when this state replaces a form the operator had just
  // submitted — otherwise the control they activated disappears and the
  // explanation is never announced. Nothing inside it is interactive (the
  // unreadable state adds its own button, which is a tab stop in its own
  // right), so the block itself is not a tab stop (WCAG 2.4.3).
  block.setAttribute('tabindex', '-1');
  block.setAttribute('role', 'status');
  block.appendChild(el('span', 'not-configured-label', label));
  block.appendChild(el('span', 'not-configured-title', title));
  block.appendChild(el('span', 'not-configured-body', body));
  (extras || []).forEach(function (line) {
    if (line) block.appendChild(el('span', 'not-configured-detail', line));
  });
  return block;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * §5 — "export is not available on this deployment" (a 501 from either call).
 *
 * PURE: no fetch, no listeners. No picker and no submit button are rendered in
 * this state: greying out live controls would imply "temporarily disabled",
 * which contradicts the explanation.
 *
 * @param {string} [serverMessage] the 501 body's `message`, if one was seen
 * @returns {HTMLElement}
 */
export function renderExportNotConfigured(serverMessage) {
  const detail = serverMessage == null ? '' : String(serverMessage).trim();
  return standingState(
    'not-configured',
    EXPORT_COPY.notConfiguredLabel,
    EXPORT_COPY.notConfiguredTitle,
    EXPORT_COPY.notConfiguredBody,
    [detail ? EXPORT_COPY.notConfiguredDetailPrefix + detail : '']
  );
}

/**
 * §5 second variant — destination storage is configured, but nothing is
 * registered (a 200 whose only entries are ones this action may not use).
 *
 * This is issue #945's "if no destinations are configured, the UI explains that
 * plainly instead of presenting an empty or failing action": no empty `<select>`,
 * no submit button that could only 400.
 *
 * @returns {HTMLElement}
 */
export function renderNoDestinations() {
  return standingState(
    'no-destinations',
    EXPORT_COPY.noDestinationsLabel,
    EXPORT_COPY.noDestinationsTitle,
    EXPORT_COPY.noDestinationsBody,
    [EXPORT_COPY.noDestinationsDefaultNote]
  );
}

/**
 * The list could not be read. Says only that, and offers a retry — the one
 * state here that a retry can change.
 *
 * @param {string} [serverMessage]
 * @returns {HTMLElement}
 */
export function renderDestinationsUnreadable(serverMessage) {
  const detail = serverMessage == null ? '' : String(serverMessage).trim();
  const block = standingState(
    'destinations-unreadable',
    EXPORT_COPY.unreadableLabel,
    EXPORT_COPY.unreadableTitle,
    EXPORT_COPY.unreadableBody,
    [detail ? EXPORT_COPY.notConfiguredDetailPrefix + detail : '']
  );
  const retry = el('button', 'btn-ghost export-retry', EXPORT_COPY.retry);
  retry.type = 'button';
  retry.id = 'btn-export-destinations-retry';
  block.appendChild(retry);
  return block;
}

/**
 * Build the whole Export block for one render.
 *
 * PURE: no fetch, no listeners — `mountExportAction` wires what it returns.
 *
 * THE GATE on `destination`: one `<option>` per entry of the live list and by no
 * other route — no free-text field — so the submitted value is always an id the
 * API just said it has.
 *
 * ACCESSIBILITY: a real `<form>` (so Enter submits), the select bound to a
 * visible `<label for>`, the message host an `aria-live="polite"` region so an
 * outcome that does not move focus is still announced (WCAG 2.1 AA 4.1.3), and
 * the submit control described by the intro text so it announces what it does.
 *
 * @param {{ destinations?: Array<object>, canExport?: boolean, loading?: boolean,
 *           notConfigured?: boolean, notConfiguredMessage?: string,
 *           unreadable?: boolean, unreadableMessage?: string }} [opts]
 * @returns {{ block: HTMLElement, form: HTMLElement|null, destinationSelect: HTMLElement|null,
 *             submitBtn: HTMLElement|null, retryBtn: HTMLElement|null,
 *             detailHost: HTMLElement|null, msgHost: HTMLElement }}
 */
export function renderExportBlock(opts) {
  const o = opts || {};
  const destinations = Array.isArray(o.destinations) ? o.destinations : [];

  const block = el('div', 'mt12 export-block');
  block.id = 'export-action';
  // `.section-title` is the house heading for a detail-panel block (cf. "Status
  // history" in public/app.js and "Editorial review" in public/review-state.js).
  block.appendChild(el('div', 'section-title', EXPORT_COPY.heading));

  const intro = el('div', 'mt8 text-muted export-intro', EXPORT_COPY.intro);
  intro.id = 'export-intro';
  intro.style.fontSize = '12px';
  block.appendChild(intro);

  const msgHost = el('div', 'mt8 export-msg');
  msgHost.id = 'export-msg';
  msgHost.setAttribute('aria-live', 'polite');

  const bare = function (extra) {
    block.appendChild(msgHost);
    return Object.assign(
      {
        block,
        form: null,
        destinationSelect: null,
        submitBtn: null,
        retryBtn: null,
        detailHost: null,
        msgHost,
      },
      extra || {}
    );
  };

  if (o.notConfigured) {
    // §5: the form is not rendered at all in this state.
    block.appendChild(renderExportNotConfigured(o.notConfiguredMessage));
    return bare();
  }

  if (o.unreadable) {
    const notice = renderDestinationsUnreadable(o.unreadableMessage);
    block.appendChild(notice);
    return bare({ retryBtn: notice.querySelector('#btn-export-destinations-retry') });
  }

  if (o.loading) {
    const pending = el('div', 'mt8 text-muted export-loading', EXPORT_COPY.loading);
    pending.id = 'export-loading';
    pending.setAttribute('role', 'status');
    pending.style.fontSize = '12px';
    block.appendChild(pending);
    return bare();
  }

  if (o.canExport === false) {
    // Pre-emptive mirror of the role matrix: a `viewer` holds `read` but not
    // `write`, so the POST would be a guaranteed 403. Explaining the absence
    // beats offering a control that cannot work.
    const roleNote = el('div', 'mt8 export-role-note', EXPORT_COPY.readOnly);
    roleNote.id = 'export-role-note';
    roleNote.style.fontSize = '12px';
    block.appendChild(roleNote);
    return bare();
  }

  if (destinations.length === 0) {
    // §5 second variant — explained plainly, with no empty picker and no
    // submit button that could only fail.
    block.appendChild(renderNoDestinations());
    return bare();
  }

  const form = el('form', 'mt8 export-form');
  form.id = 'export-form';
  // Nothing here navigates; the handler always preventDefault()s. `novalidate`
  // keeps the browser's own bubble out of the way so every refusal is reported
  // in the one aria-live region.
  form.setAttribute('novalidate', 'novalidate');

  const row = el('div', 'export-field');
  const labelEl = el('label', 'export-field-label', EXPORT_COPY.destinationLabel);
  labelEl.setAttribute('for', 'export-destination');
  const select = el('select', 'export-destination-select');
  select.id = 'export-destination';
  select.name = 'destination';
  destinations.forEach(function (dest) {
    const option = el('option', null, destinationLabel(dest));
    // The value is the stable id, which is what the request carries.
    option.value = String(dest.id);
    select.appendChild(option);
  });
  const hint = el('div', 'export-field-hint', EXPORT_COPY.destinationHint);
  hint.id = 'export-destination-hint';
  const detailHost = el('div', 'export-destination-detail');
  detailHost.id = 'export-destination-detail';
  select.setAttribute('aria-describedby', hint.id + ' ' + detailHost.id);
  row.appendChild(labelEl);
  row.appendChild(select);
  row.appendChild(hint);
  row.appendChild(detailHost);
  form.appendChild(row);

  const submitBtn = el('button', 'btn-ghost export-submit', EXPORT_COPY.submit);
  submitBtn.id = 'btn-export-asset';
  submitBtn.type = 'submit';
  submitBtn.setAttribute('aria-describedby', intro.id);
  const actions = el('div', 'mt8 flex-gap export-actions');
  actions.appendChild(submitBtn);
  form.appendChild(actions);

  block.appendChild(form);
  return Object.assign(bare(), { form, destinationSelect: select, submitBtn, detailHost });
}

/**
 * Fill the detail line under the picker with the selected destination's
 * non-secret coordinates.
 *
 * PURE apart from writing into `host`. Every value goes in as `textContent`.
 *
 * @param {HTMLElement|null} host
 * @param {object|undefined} destination
 */
export function renderDestinationDetail(host, destination) {
  if (!host) return;
  while (host.firstChild) host.removeChild(host.firstChild);
  if (!destination) return;
  describeDestination(destination).forEach(function (fact) {
    const line = el('span', 'export-fact');
    line.appendChild(el('span', 'export-fact-label', fact.label));
    line.appendChild(el('span', 'export-fact-value text-mono', fact.value));
    host.appendChild(line);
  });
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Whether a 501 has already been seen in this page session, and the sentence it
 * carried.
 *
 * §5 asks for the unavailable state to be detected ahead of the click. The
 * destination list IS that probe — it declares the same 501 the export call
 * does — so this block always opens in the right state rather than discovering
 * it on submit. The memo makes a 501 from the EXPORT call stick too: the first
 * one anywhere in the session means every later render opens in the §5 state
 * instead of offering the form again.
 */
let notConfiguredSeen = false;
let notConfiguredMessage = '';

/**
 * Test seam: forget the session-level 501 memo above.
 *
 * Module state would otherwise leak between test cases in one module registry.
 * Not called by the application.
 */
export function resetExportAvailability() {
  notConfiguredSeen = false;
  notConfiguredMessage = '';
}

/**
 * Render the "Export" block, load the live destination list, and wire the form.
 *
 * The block is inserted before `anchorEl` when given, else appended to `host`.
 *
 * @param {object} opts
 * @param {string}      opts.assetId   the ULID. Sub-resource routes do not
 *                                     resolve slugs, and `asset.id` is the ULID
 *                                     even when the pane was opened by slug
 * @param {string}      [opts.sourceName] the source asset's `name`, used by the
 *                                     409 copy
 * @param {HTMLElement} [opts.host]    container to append to
 * @param {HTMLElement} [opts.anchorEl] element to insert before, inside its parent
 * @param {boolean}     [opts.canExport] client-role mirror of the role matrix
 * @param {Function}    opts.apiFetch
 * @param {(root: ParentNode) => void} [opts.wireCopyIds] house click-to-copy wiring
 * @param {(result: object) => any}    [opts.onExported] called with the 200 body
 * @returns {{ block: HTMLElement|null, reload: () => Promise<void> }}
 */
export function mountExportAction(opts) {
  const o = opts || {};
  const apiFetch = o.apiFetch;
  const path = exportPathFor(o.assetId);

  let rendered = null;
  let placed = false;
  /** The live list, as last read. */
  let destinations = [];
  let unreadable = false;
  let unreadableMessage = '';
  let loading = true;

  function place(block) {
    if (!placed) {
      if (o.anchorEl && o.anchorEl.parentNode) {
        o.anchorEl.parentNode.insertBefore(block, o.anchorEl);
      } else if (o.host) {
        o.host.appendChild(block);
      }
      placed = true;
      return;
    }
    if (rendered && rendered.block && rendered.block.parentNode) {
      rendered.block.parentNode.replaceChild(block, rendered.block);
    }
  }

  /**
   * Replace — not append to — the message region. §2/§3/§4 all say the outcome
   * REPLACES the in-progress message, so a stale "Exporting…" can never sit
   * next to the result that contradicts it. This is also why the house
   * `showMsg` helper is not used here: it appends and self-removes after 6s,
   * and it writes `textContent` only, so it cannot carry §3's fact list. The
   * `.msg .msg-<kind>` classes it applies ARE reused, so the visual treatment
   * is the house one.
   */
  function setMsg(kind) {
    const host = rendered ? rendered.msgHost : null;
    if (!host) return null;
    while (host.firstChild) host.removeChild(host.firstChild);
    const msg = el('div', 'msg msg-' + kind);
    host.appendChild(msg);
    return msg;
  }

  function selectedDestination() {
    if (!rendered || !rendered.destinationSelect) return undefined;
    const id = rendered.destinationSelect.value;
    for (let i = 0; i < destinations.length; i++) {
      if (String(destinations[i].id) === String(id)) return destinations[i];
    }
    return undefined;
  }

  function draw() {
    const next = renderExportBlock({
      destinations: destinations,
      canExport: o.canExport !== false,
      loading: loading,
      notConfigured: notConfiguredSeen,
      notConfiguredMessage: notConfiguredMessage,
      unreadable: unreadable,
      unreadableMessage: unreadableMessage,
    });
    place(next.block);
    rendered = next;
    if (next.form) {
      next.form.addEventListener('submit', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        void submit();
      });
    }
    if (next.destinationSelect) {
      next.destinationSelect.addEventListener('change', function () {
        renderDestinationDetail(rendered.detailHost, selectedDestination());
      });
      renderDestinationDetail(next.detailHost, selectedDestination());
    }
    if (next.retryBtn) {
      next.retryBtn.addEventListener('click', function () {
        void load();
      });
    }
  }

  /**
   * Load the live destination list.
   *
   * Called on mount and by the retry control. The list is re-read rather than
   * cached across asset views, because the acceptance criterion is the
   * CURRENTLY configured destinations.
   */
  async function load() {
    if (notConfiguredSeen) {
      loading = false;
      draw();
      return;
    }
    if (!loading) {
      // A retry (or a reload after a stale-list 400): show the pending state
      // again. On the first load the block is already in it, so it is not
      // re-rendered for nothing.
      loading = true;
      unreadable = false;
      unreadableMessage = '';
      draw();
    }
    let body;
    try {
      body = await apiFetch(DESTINATIONS_PATH);
    } catch (err) {
      const c = classifyDestinationsError(err);
      loading = false;
      if (c.notConfigured) {
        notConfiguredSeen = true;
        notConfiguredMessage = c.message || '';
      } else {
        // NOT reported as "no destinations are registered" — we do not know
        // that, and saying so would be the false statement this feature exists
        // to avoid.
        unreadable = true;
        unreadableMessage = c.message || '';
      }
      draw();
      return;
    }
    destinations = deliverableDestinations(body);
    loading = false;
    draw();
  }

  /** §3 — the success block: the outcome sentence plus the verified coordinates. */
  function reportSuccess(label, result) {
    const msg = setMsg('success');
    if (!msg) return;
    const r = /** @type {Record<string, unknown>} */ (result || {});
    // Prefer the destination name the SERVER resolved (`destination.name` on the
    // 200 body) over the client's label: it comes from the record the bytes
    // actually went to.
    const serverDest = r['destination'];
    const resolvedLabel =
      serverDest && typeof serverDest === 'object'
        ? destinationLabel(serverDest) || label
        : label;
    msg.appendChild(el('div', 'export-result-line', EXPORT_COPY.succeeded(resolvedLabel)));

    const facts = [];
    if (typeof r['bucket'] === 'string') {
      facts.push({ label: EXPORT_COPY.factBucket, value: String(r['bucket']), copy: false });
    }
    if (typeof r['objectKey'] === 'string') {
      facts.push({
        label: EXPORT_COPY.factObjectKey,
        value: String(r['objectKey']),
        // The one value a developer wants to paste into a client or an
        // `aws s3` call, so it gets the house click-to-copy affordance.
        copy: true,
      });
    }
    const bytes = formatDeliveredBytes(r['bytes']);
    if (bytes) facts.push({ label: EXPORT_COPY.factBytes, value: bytes, copy: false });
    if (typeof r['etag'] === 'string' && r['etag']) {
      facts.push({ label: EXPORT_COPY.factEtag, value: String(r['etag']), copy: false });
    }
    if (typeof r['deliveredAt'] === 'string' && r['deliveredAt']) {
      facts.push({
        label: EXPORT_COPY.factDeliveredAt,
        value: String(r['deliveredAt']),
        copy: false,
      });
    }

    const list = el('div', 'export-result-facts');
    facts.forEach(function (fact) {
      const line = el('div', 'export-fact');
      line.appendChild(el('span', 'export-fact-label', fact.label));
      line.appendChild(el('span', 'export-fact-value text-mono', fact.value));
      if (fact.copy) {
        // Same click-to-copy convention the rest of the UI uses
        // (public/copy-id.js). Built with DOM rather than that module's HTML
        // helper so no string concatenation reaches innerHTML here.
        const copyBtn = el('button', 'copy-id-btn', 'Copy');
        copyBtn.type = 'button';
        copyBtn.setAttribute('data-copy-id', fact.value);
        copyBtn.setAttribute('aria-live', 'polite');
        copyBtn.setAttribute('aria-label', 'Copy exported object key ' + fact.value);
        line.appendChild(copyBtn);
      }
      list.appendChild(line);
    });
    msg.appendChild(list);
    if (typeof o.wireCopyIds === 'function') o.wireCopyIds(list);
  }

  function reportError(text, kind) {
    const msg = setMsg(kind || 'error');
    if (msg) msg.textContent = text;
  }

  async function submit() {
    if (!rendered || !rendered.form) return;
    const dest = selectedDestination();
    const ref = rendered.destinationSelect.value;
    if (!ref) {
      // Defensive: the picker is only rendered with at least one entry.
      reportError(EXPORT_COPY.noDestinationsTitle);
      return;
    }
    const label = destinationLabel(dest) || ref;

    const controls = [rendered.submitBtn, rendered.destinationSelect];
    const prevLabel = rendered.submitBtn.textContent;
    // §2: disable the submit control AND the picker for the duration. There is
    // nothing to interrupt (no job id, no cancel contract), and a second submit
    // in flight would start a second, unrelated copy.
    controls.forEach(function (c) { c.disabled = true; });
    rendered.submitBtn.textContent = EXPORT_COPY.busy;
    reportError(EXPORT_COPY.inProgress(label), 'info');

    let result;
    try {
      result = await apiFetch(path, {
        method: 'POST',
        body: JSON.stringify(buildDeliverBody(ref)),
      });
    } catch (err) {
      const c = classifyExportError(err, { destination: label, sourceName: o.sourceName });
      if (c.notConfigured) {
        // §5: this is the deployment's standing state, so the form stops being
        // offered for the rest of the session rather than being re-enabled.
        notConfiguredSeen = true;
        notConfiguredMessage = c.detail || '';
        draw();
        // The control the operator just activated no longer exists. Move focus
        // to the explanation that replaced it, so the reason is announced and
        // focus is not stranded on a removed element (WCAG 2.4.3 / 4.1.3).
        const notice = rendered && rendered.block
          ? rendered.block.querySelector('[data-outcome="not-configured"]')
          : null;
        if (notice && typeof notice.focus === 'function') notice.focus();
        return;
      }
      // The inputs stay as the operator left them — nothing about a 502/504
      // says the destination choice was wrong — and the action stays retryable.
      controls.forEach(function (ctl) { ctl.disabled = false; });
      rendered.submitBtn.textContent = prevLabel;
      if (c.forbidden) {
        // A control known to fail stops being offered for the rest of this view
        // of the asset (the lock and review blocks' 403 rule).
        if (rendered.form && rendered.form.parentNode) {
          rendered.form.parentNode.removeChild(rendered.form);
        }
        // Focus moves to the explanation, because the control that had focus is
        // gone (WCAG 2.4.3). The message is in the aria-live region either way.
        const msg = setMsg('error');
        if (msg) {
          msg.textContent = c.message;
          msg.setAttribute('tabindex', '-1');
          if (typeof msg.focus === 'function') msg.focus();
        }
        return;
      }
      // The 504 outcome is unknown, not failed: it gets the warning treatment
      // rather than the error one, so it does not read as a settled failure.
      reportError(c.message, c.unsettled ? 'warn' : 'error');
      if (c.staleList) {
        // The API no longer has the destination the picker offered. Re-read the
        // list so the stale entry stops being offered — but keep the message,
        // which `load()`'s re-render would otherwise drop.
        const text = c.message;
        await load();
        reportError(text);
      }
      return;
    }

    controls.forEach(function (c) { c.disabled = false; });
    rendered.submitBtn.textContent = prevLabel;
    const status = result && typeof result === 'object'
      ? /** @type {{status?: unknown}} */ (result).status
      : undefined;
    if (status !== 'delivered') {
      // The contract declares exactly one terminal value for a 200. Anything
      // else is reported as unconfirmed rather than celebrated: "the call
      // returned" is not evidence that an object landed.
      reportError(EXPORT_COPY.errUnconfirmed(typeof status === 'string' ? status : ''));
      return;
    }
    reportSuccess(label, result);
    if (typeof o.onExported === 'function') await o.onExported(result);
  }

  draw();
  void load();
  return {
    get block() {
      return rendered ? rendered.block : null;
    },
    reload: load,
  };
}
