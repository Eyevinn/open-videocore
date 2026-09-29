/**
 * open-videocore ops dashboard — review-state.js
 *
 * The "Editorial review" block on the asset detail view (issue #901, broken out
 * of #792): the current editorial review state, rendered DISTINCTLY from the
 * lifecycle `status` badge (#134), plus a transition control that offers
 * EXACTLY the moves the API says are legal from the current state — no more.
 *
 * The state machine is NOT reimplemented here. The set of offered moves is the
 * `allowedTransitions` array returned by `GET /api/v1/assets/{id}/review-state`
 * (issue #897), which the API computes from the same table its 422 gate
 * validates against. This module never derives, filters or extends that graph;
 * it renders one control per advertised move and can send nothing else.
 *
 * Everything operator-visible here is written with `textContent` /
 * `createElement`. No server string ever reaches `innerHTML` — including a
 * review state the client does not recognise, which is rendered verbatim as
 * text rather than guessed at or dropped.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's generated spec and route source on this branch, plus the
 * contract note written for the prerequisite. Nothing is taken from issue text.
 *
 *   Read — `openapi.json .paths["/api/v1/assets/{id}/review-state"].get`
 *     parameters: exactly one — path `id` (string, required). No query params.
 *     responses: exactly `200` and `404`.
 *     200 schema: `{ reviewState: <enum>, allowedTransitions: <enum>[] }`,
 *       `required: ["reviewState","allowedTransitions"]`,
 *       `additionalProperties: false`; enum =
 *       `draft | in-review | approved | rejected`.
 *       `allowedTransitions` description, verbatim: "The review states this
 *       asset may move to next, from its current `reviewState`. Every value
 *       listed here is accepted by POST /assets/{id}/review-state; every state
 *       NOT listed (other than `reviewState` itself) is refused with 422. The
 *       current state is never listed … May be empty, which means the state is
 *       terminal."
 *     404 schema: `{ error: string, message?: string }`, required `["error"]`.
 *     Source of truth: `app.get('/:id/review-state', …)`,
 *       src/routes/assets.ts:5437-5457 — `response: { 200: reviewStateReadSchema,
 *       404: errorSchema }` (:5442), body built at :5453-5456 from
 *       `asset.reviewState ?? 'draft'` and `allowedReviewTransitions(current)`.
 *     `reviewStateReadSchema`: src/routes/assets.ts:223-241.
 *
 *   Write — `openapi.json .paths["/api/v1/assets/{id}/review-state"].post`
 *     requestBody: `required: true`, `application/json`, schema
 *       `{ reviewState: <enum> }`, `required: ["reviewState"]`,
 *       `additionalProperties: false`.
 *     parameters: one path param `id` (string, required). No query params.
 *     responses: exactly `200` (the FULL asset — same schema as
 *       `GET /api/v1/assets/{id}`), `404` and `422` (`{ error, message? }`).
 *     Source of truth: `app.post('/:id/review-state', …)`,
 *       src/routes/assets.ts:5470-5484 — body
 *       `z.object({ reviewState: reviewStateSchema })` (:5475),
 *       `response: { 200: assetSchema, 404: errorSchema, 422: errorSchema }`.
 *     The 422 body is `{ error: 'invalid_review_transition', message: … }`
 *       (src/routes/assets.ts:2663-2664, mapping `InvalidReviewTransitionError`,
 *       src/data/asset-repo.ts:772-777).
 *
 *   The graph itself — `ALLOWED_REVIEW_TRANSITIONS`, src/data/asset-repo.ts:88-93,
 *     read by BOTH `isValidReviewTransition()` (:95-100, the 422 gate) and
 *     `allowedReviewTransitions()` (:114-116, what the read advertises), so the
 *     enforced and advertised graphs cannot drift. Documented in full in
 *     docs/findings/review-state-contract-897.md §1.
 *     For labelling only (§ "Action labels" below) the pairs are:
 *       draft → in-review; in-review → approved|rejected;
 *       approved → in-review; rejected → in-review.
 *     Nothing anywhere in this module DECIDES from that list — see the note on
 *     `transitionLabel`.
 *
 *   State vocabulary — `ASSET_REVIEW_STATES`, src/data/asset-repo.ts:62
 *     (`['draft','in-review','approved','rejected']`); persisted as
 *     `reviewState: z.enum(ASSET_REVIEW_STATES).default('draft')`,
 *     src/data/asset-document.ts:322. Absent means `draft` everywhere
 *     (the read route resolves it at src/routes/assets.ts:5453).
 *
 *   Two axes, not one — `reviewState` is INDEPENDENT of the lifecycle `status`
 *     (`uploading|processing|ready|failed|archived`, `ASSET_STATUSES`
 *     src/data/asset-repo.ts:28). They share no vocabulary and moving one never
 *     moves the other (src/data/asset-repo.ts:55-61). Hence a separate block,
 *     its own badge class, and an explicit sentence saying so — never a second
 *     pill in the same row as the lifecycle badge.
 *
 *   Authorisation — the ADR-018 role×action matrix `MATRIX`
 *     (src/auth/authorize.ts:54-58: `viewer { read: true, write: false }`,
 *     editor/admin all true), applied by `resourceAuthorizationPreHandler('asset')`
 *     (src/auth/authorize.ts:126, registered src/routes/assets.ts:1718) with the
 *     action derived by `methodToAction` (:79-93): GET → `read`, POST → `write`.
 *     So a `viewer` may READ the state and its legal moves but is refused the
 *     POST with 403 `AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role'`
 *     (src/auth/authorize.ts:99). `canChange` is the caller's client-role
 *     mirror; the 403 path below runs regardless, because the server is the
 *     authority.
 *
 *   NOT rendered, because the contract has nothing to render:
 *     a review history or an actor. The asset stores only the current
 *     `reviewState` — there is no `reviewedBy`, no `reviewedAt`, no
 *     per-transition trail (unlike lifecycle `statusHistory`), and the handler
 *     emits no audit entry (docs/findings/review-state-contract-897.md §6, gaps
 *     G1/G2). So this block shows the current state only and never claims a
 *     trail.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────
//
// Display labels for the four states in `ASSET_REVIEW_STATES`
// (src/data/asset-repo.ts:62). A state NOT in this map is still rendered — as
// its raw wire value — so a server that grows a fifth state degrades to honest
// text rather than to a blank or a guess.

export const REVIEW_STATE_LABEL = Object.freeze({
  draft: 'Draft',
  'in-review': 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
});

/** The wire vocabulary this client recognises (src/data/asset-repo.ts:62). */
export const REVIEW_STATES = Object.freeze(['draft', 'in-review', 'approved', 'rejected']);

// ─── Copy deck ───────────────────────────────────────────────────────────────

export const REVIEW_COPY = Object.freeze({
  heading: 'Editorial review',
  /** The label in front of the badge — the state is never carried by colour or
   *  position alone (WCAG 1.4.1). */
  stateKey: 'Review state',
  /** Says outright what #134 asks the layout to make obvious. */
  axisNote:
    'Editorial approval. This is a separate axis from the lifecycle status ' +
    'above — moving one never moves the other.',
  /** Shown when the state has outgoing moves; the moves themselves are buttons. */
  movesIntro: 'Moves allowed from here:',
  /** `allowedTransitions: []` — the contract says an empty array means terminal. */
  terminal: 'No further review moves are possible from this state.',
  /** The read failed or returned something unusable. */
  unavailable: 'Review state unavailable.',
  unavailableDetail:
    'The API did not return a usable review state for this asset, so no review ' +
    'actions are offered.',
  /** Role gate (pre-emptive mirror of the 403 below). */
  readOnly:
    'Your role can see the review state but cannot change it. Ask an editor or ' +
    'administrator.',
  busySuffix: '…',
  errForbidden:
    'Your role cannot change the review state of this asset. Ask an editor or ' +
    'administrator.',
  errNotFound: 'This asset no longer exists.',
  /** 422 — the advertised set went stale between the read and the click. */
  errStale:
    'That move is no longer allowed — this asset’s review state changed since ' +
    'this panel was loaded. The allowed moves have been re-read from the API.',
  errNetwork: 'Could not reach the API. The review state was not changed.',
  errRefresh: 'Could not re-read the review state from the API.',
});

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Display label for a review state. Unknown values pass through verbatim (as
 * text) rather than being mapped to "unknown" — the API is the authority on the
 * vocabulary, and a state this build has not heard of is still a real state.
 *
 * @param {unknown} state
 * @returns {string}
 */
export function reviewStateLabel(state) {
  if (typeof state !== 'string' || state === '') return '—';
  return REVIEW_STATE_LABEL[state] || state;
}

/**
 * Read the `GET /:id/review-state` 200 body defensively.
 *
 * Both properties are `required` in the schema, so the happy path is trivial;
 * this exists so a malformed/garbled response produces "unavailable" (no
 * controls) instead of a control set derived from a half-read payload.
 *
 * `usable` is false unless `reviewState` is a non-empty string AND
 * `allowedTransitions` is an array. An EMPTY array is usable — the contract
 * gives it a meaning (terminal state), which is not the same as missing.
 *
 * The returned `allowedTransitions` keeps the server's order and drops only:
 *   - non-string entries (not a state the POST could accept), and
 *   - the current state (never advertised per the contract; if it ever were, a
 *     button for it would be a no-op — see the self-transition note in
 *     docs/findings/review-state-contract-897.md §1).
 * Nothing is ADDED, ever.
 *
 * @param {unknown} payload
 * @returns {{ reviewState: string|null, allowedTransitions: string[], usable: boolean }}
 */
export function normaliseReviewRead(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const state = typeof p.reviewState === 'string' && p.reviewState !== '' ? p.reviewState : null;
  const listed = Array.isArray(p.allowedTransitions) ? p.allowedTransitions : null;
  if (state === null || listed === null) {
    return { reviewState: state, allowedTransitions: [], usable: false };
  }
  const allowed = listed.filter(function (t) {
    return typeof t === 'string' && t !== '' && t !== state;
  });
  return { reviewState: state, allowedTransitions: allowed, usable: true };
}

/**
 * Button label for a move, PRESENTATION ONLY.
 *
 * This map does not decide anything: which buttons exist is decided solely by
 * the server's `allowedTransitions` (see `renderReviewBlock`). A pair missing
 * from the map still gets a button — with the generic label — so a graph the
 * API grows later is offered, not suppressed, by this client.
 *
 * @param {string} from  current review state
 * @param {string} to    the advertised next state
 * @returns {string}
 */
export function transitionLabel(from, to) {
  if (to === 'approved') return 'Approve';
  if (to === 'rejected') return 'Reject';
  if (to === 'in-review') {
    if (from === 'draft') return 'Submit for review';
    if (from === 'rejected') return 'Resubmit for review';
    if (from === 'approved') return 'Re-open for review';
    return 'Send to review';
  }
  return 'Move to “' + reviewStateLabel(to) + '”';
}

/**
 * Sentence reporting a completed move, for the block's live region.
 *
 * @param {string} to
 * @returns {string}
 */
export function transitionResultMessage(to) {
  return 'Review state is now “' + reviewStateLabel(to) + '”.';
}

/**
 * Classify a failed `POST /:id/review-state`.
 *
 * The declared failures are 404 and 422; 401/403 come from the auth gate and are
 * not declared on this operation (same undeclared-status class as the lock
 * routes). `stale` is the interesting one: a 422 here can only mean the state
 * moved underneath this panel, because the only moves it can send are ones the
 * API advertised — so the answer is to re-read, not to blame the operator.
 *
 * @param {{status?: number, message?: string, body?: any}} err  an apiFetch rejection
 * @returns {{kind: 'forbidden'|'not-found'|'stale'|'other', message: string, refresh: boolean}}
 */
export function classifyReviewError(err) {
  const e = err || {};
  if (e.status === 403 || e.status === 401) {
    return { kind: 'forbidden', message: REVIEW_COPY.errForbidden, refresh: false };
  }
  if (e.status === 404) {
    return { kind: 'not-found', message: REVIEW_COPY.errNotFound, refresh: false };
  }
  if (e.status === 422) {
    return { kind: 'stale', message: REVIEW_COPY.errStale, refresh: true };
  }
  return { kind: 'other', message: REVIEW_COPY.errNetwork, refresh: false };
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * The review-state badge.
 *
 * Deliberately NOT the `.badge` family used by the lifecycle status: a different
 * class, a different shape and its own palette, always preceded by the words
 * "Review state" (`REVIEW_COPY.stateKey`), so the two axes cannot be mistaken for
 * one another in any rendering — including monochrome (WCAG 1.4.1). The label is
 * set with `textContent`.
 *
 * @param {string} state
 * @returns {HTMLElement}
 */
export function renderReviewBadge(state) {
  const known = REVIEW_STATES.indexOf(state) !== -1;
  const badge = el(
    'span',
    'review-badge review-badge--' + (known ? state : 'unknown'),
    reviewStateLabel(state)
  );
  badge.setAttribute('data-review-state', typeof state === 'string' ? state : '');
  return badge;
}

/**
 * Build the whole block for one read of the sub-resource. PURE: no fetch, no
 * listeners — `mountReviewState` wires the buttons it returns.
 *
 * THE GATE. One button is created per entry of `read.allowedTransitions` and by
 * no other route. There is no state picker, no free-text field and no
 * "other state" affordance, so a move the API did not advertise has no control
 * to originate from: an illegal transition is not discouraged here, it is
 * unrepresentable. Each button carries its target in `data-target` AND in the
 * closure `mountReviewState` binds, and the submit path re-checks membership of
 * the list that is currently on screen before sending.
 *
 * @param {{reviewState: string|null, allowedTransitions: string[], usable: boolean}} read
 * @param {{canChange?: boolean}} [opts]
 * @returns {{ block: HTMLElement, noteId: string, buttons: HTMLElement[], msgHost: HTMLElement }}
 */
export function renderReviewBlock(read, opts) {
  const o = opts || {};
  const r = read || { usable: false, allowedTransitions: [] };

  const block = el('div', 'mt12 review-block');
  block.id = 'review-state';
  // `.section-title` is the house heading for a detail-panel block (cf. "Status
  // history", public/app.js, and "Delete protection", public/lock-detail.js).
  block.appendChild(el('div', 'section-title', REVIEW_COPY.heading));

  const note = el('div', 'mt8 text-muted review-state-note');
  note.id = 'review-state-note';
  note.style.fontSize = '12px';

  const msgHost = el('div', 'mt8 review-msg');
  msgHost.id = 'review-msg';
  // A state change that does not move focus is still announced.
  msgHost.setAttribute('aria-live', 'polite');

  const buttons = [];

  if (!r.usable) {
    // The read failed or came back unusable. An action whose precondition is
    // unknown is not offered — the same rule the lock block applies to an
    // unknown lock state.
    note.appendChild(el('div', 'review-state-line', REVIEW_COPY.unavailable));
    note.appendChild(el('div', 'review-axis-note', REVIEW_COPY.unavailableDetail));
    block.appendChild(note);
    block.appendChild(msgHost);
    return { block, noteId: note.id, buttons, msgHost };
  }

  const line = el('div', 'review-state-line');
  line.appendChild(el('span', 'review-state-key', REVIEW_COPY.stateKey + ':'));
  line.appendChild(document.createTextNode(' '));
  line.appendChild(renderReviewBadge(r.reviewState));
  note.appendChild(line);
  note.appendChild(el('div', 'review-axis-note', REVIEW_COPY.axisNote));

  const terminal = r.allowedTransitions.length === 0;
  if (terminal) {
    note.appendChild(el('div', 'review-moves-note', REVIEW_COPY.terminal));
  } else if (!o.canChange) {
    // Pre-emptive mirror of the ADR-018 matrix: a viewer holds `read` but not
    // `write`, so the POST would be a guaranteed 403. Explaining the absence
    // beats offering a control that cannot work — and the state itself stays
    // fully visible.
    const roleNote = el('div', 'review-role-note', REVIEW_COPY.readOnly);
    roleNote.id = 'review-role-note';
    note.appendChild(roleNote);
  } else {
    note.appendChild(el('div', 'review-moves-note', REVIEW_COPY.movesIntro));
  }

  block.appendChild(note);

  if (!terminal && o.canChange) {
    const actions = el('div', 'mt8 flex-gap review-actions');
    actions.id = 'review-actions';
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', 'Review state transitions');
    r.allowedTransitions.forEach(function (target) {
      const btn = el('button', 'btn-ghost review-transition', transitionLabel(r.reviewState, target));
      btn.type = 'button';
      btn.id = 'btn-review-' + target;
      btn.setAttribute('data-target', target);
      // Points at the state text above so the control announces what it acts on.
      btn.setAttribute('aria-describedby', note.id);
      actions.appendChild(btn);
      buttons.push(btn);
    });
    block.appendChild(actions);
  }

  block.appendChild(msgHost);
  return { block, noteId: note.id, buttons, msgHost };
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Render the "Editorial review" block and wire its transition controls.
 *
 * Reads `GET /api/v1/assets/{id}/review-state` — never the `reviewState` field
 * on the asset read — because only the sub-resource carries the legal moves, and
 * gating on anything else would mean re-deriving the graph client-side. After a
 * successful move the sub-resource is re-read (the allowed set changes with the
 * state) and the block is rebuilt from that answer.
 *
 * The block is inserted before `anchorEl` when given, else appended to `host`.
 *
 * @param {object} opts
 * @param {string}      opts.assetId    the ULID (the route does not resolve slugs
 *                                      on sub-resources; `asset.id` is the ULID
 *                                      even when the pane was opened by slug)
 * @param {HTMLElement} [opts.host]     container to append to
 * @param {HTMLElement} [opts.anchorEl] element to insert before, inside its parent
 * @param {boolean}     [opts.canChange] client-role mirror of the ADR-018 matrix
 * @param {Function}    opts.apiFetch
 * @param {Function}    [opts.showMsg]  house message renderer (host, text, kind)
 * @param {(asset: object, to: string) => any} [opts.onChanged] called with the
 *        FULL asset the POST returns, after the block has re-read itself
 * @returns {Promise<{ block: HTMLElement, refresh: () => Promise<void>, read: () => object }>}
 */
export async function mountReviewState(opts) {
  const o = opts || {};
  const apiFetch = o.apiFetch;
  const base = '/assets/' + encodeURIComponent(String(o.assetId)) + '/review-state';

  // The single source of truth for what this block may send: the most recent
  // server answer. Never edited locally.
  let current = { reviewState: null, allowedTransitions: [], usable: false };
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
      return;
    }
    if (rendered && rendered.block && rendered.block.parentNode) {
      rendered.block.parentNode.replaceChild(block, rendered.block);
    }
  }

  function report(text, kind) {
    if (!rendered) return;
    if (typeof o.showMsg === 'function') {
      o.showMsg(rendered.msgHost, text, kind || 'error');
      return;
    }
    const msg = el('div', 'msg msg-' + (kind || 'error'), text);
    rendered.msgHost.appendChild(msg);
  }

  function draw(read) {
    current = read;
    const next = renderReviewBlock(read, { canChange: o.canChange !== false });
    place(next.block);
    rendered = next;
    next.buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        apply(btn.getAttribute('data-target'), btn);
      });
    });
  }

  async function refresh(quiet) {
    let read;
    try {
      read = normaliseReviewRead(await apiFetch(base));
    } catch (err) {
      read = { reviewState: null, allowedTransitions: [], usable: false };
      draw(read);
      if (!quiet) {
        report(err && err.status === 404 ? REVIEW_COPY.errNotFound : REVIEW_COPY.errRefresh, 'error');
      }
      return;
    }
    draw(read);
  }

  async function apply(target, btn) {
    // Re-check against the set currently on screen. The button could only have
    // been created from an advertised move, so this can fail exactly once — on a
    // click that lands after a refresh changed the set — and then it refuses to
    // send rather than posting a move the API no longer advertises.
    if (!current.usable || current.allowedTransitions.indexOf(target) === -1) {
      await refresh(true);
      report(REVIEW_COPY.errStale, 'error');
      return;
    }
    const label = btn.textContent;
    const siblings = rendered ? rendered.buttons : [btn];
    siblings.forEach(function (b) {
      b.disabled = true;
    });
    btn.textContent = label + REVIEW_COPY.busySuffix;
    try {
      // Body is exactly the one declared property; the POST returns the FULL
      // asset (see CONTRACT GROUNDING).
      const updated = await apiFetch(base, {
        method: 'POST',
        body: JSON.stringify({ reviewState: target }),
      });
      // Re-read: the legal moves change with the state, and the sub-resource —
      // not the returned asset — is what advertises them.
      await refresh(true);
      report(transitionResultMessage(target), 'success');
      if (typeof o.onChanged === 'function') {
        await o.onChanged(updated, target);
      }
    } catch (err) {
      const c = classifyReviewError(err);
      if (c.refresh) {
        await refresh(true);
      } else {
        siblings.forEach(function (b) {
          b.disabled = false;
        });
        if (btn.textContent === label + REVIEW_COPY.busySuffix) btn.textContent = label;
        if (c.kind === 'forbidden' && rendered) {
          // A control known to fail stops being offered for the rest of this
          // view of the asset (the lock block's 403 rule).
          const actions = rendered.block.querySelector('#review-actions');
          if (actions && actions.parentNode) actions.parentNode.removeChild(actions);
          rendered.buttons = [];
        }
      }
      report(c.message, 'error');
    }
  }

  await refresh(true);
  return {
    get block() {
      return rendered ? rendered.block : null;
    },
    refresh: function () {
      return refresh(false);
    },
    read: function () {
      return current;
    },
  };
}
