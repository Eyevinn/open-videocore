/**
 * open-videocore ops dashboard — editorial-tags.js
 *
 * The "Tags" control on the asset detail view (issue #899, broken out of #792):
 * the asset's `descriptive.tags` list, with ADD and REMOVE. Nothing else — no
 * rename, no bulk edit, no taxonomy lookup, because the API offers no operation
 * for any of those (see "NOT implemented" below).
 *
 * Placement, ordering and copy follow the editorial-panel design spec
 * (docs/design/editorial-panel-layout.md §3, §5.2, §8, §9 — issue #898). This
 * module is the Tags sub-section of that panel; it is mounted today in the slot
 * the panel will occupy (immediately before the detail pane's action row,
 * directly after the review block), so when the panel container lands the group
 * moves into it by passing `host`/`headingClass` and nothing else changes.
 *
 * Everything operator-visible is written with `textContent` / `createElement`.
 * No server string reaches `innerHTML` — including a tag this build cannot
 * remove (see the un-removable tag note), which is still rendered verbatim
 * rather than hidden, because it is real data.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's generated spec and route/repository source on this
 * branch. Nothing is taken from issue text.
 *
 *   Read — the tag list comes from the asset read the detail pane ALREADY has;
 *     this module issues no GET of its own.
 *     `openapi.json .paths["/api/v1/assets/{id}"].get.responses["200"]`
 *       …schema.properties.tags = { "type": "array", "items": { "type": "string" } }
 *       and `tags` is NOT in that schema's `required`
 *       (= ["id","name","status","statusHistory","createdAt","updatedAt"]),
 *       `additionalProperties: false`.
 *     Source of truth: `assetSchema` → `tags: z.array(z.string()).optional()`,
 *       src/routes/assets.ts:914 — "Absent until the first tag is set."
 *     ABSENT, not `[]`, when empty:
 *       `tags: doc.descriptive.tags && doc.descriptive.tags.length > 0
 *                ? doc.descriptive.tags : undefined`,
 *       src/data/asset-document.ts:692. So `undefined` and `[]` must render
 *       identically — `normaliseTagList()` collapses them.
 *     Persisted at `descriptive.tags: z.array(z.string()).default([])`,
 *       src/data/asset-document.ts:288 (the user-writable `descriptive`
 *       namespace, NOT system-owned `administrative`), written from the flat
 *       asset at src/data/asset-document.ts:458 (`tags: asset.tags ?? []`).
 *
 *   Add — `openapi.json .paths["/api/v1/assets/{id}/tags"].post`
 *     The spec declares no `operationId` for any path (verified: no
 *     `operationId` key anywhere in openapi.json), so the operation is cited by
 *     method + path.
 *     requestBody: `required: true`, `application/json`, schema
 *       `{ tags: { type: array, items: { type: string, minLength: 1,
 *       maxLength: 128 }, minItems: 1, maxItems: 128 } }`,
 *       `required: ["tags"]`, `additionalProperties: false`.
 *     parameters: exactly one — path `id` (string, required). No query params.
 *     responses: exactly `200` and `404`. The 200 is the FULL ASSET (same
 *       schema as `GET /api/v1/assets/{id}`), not a tag list.
 *     Source of truth: `app.post('/:id/tags', …)`, src/routes/assets.ts:5466-5487
 *       — body `z.object({ tags: z.array(tagSchema).min(1).max(128) })` (:5471),
 *       `response: { 200: assetSchema, 404: errorSchema }` (:5472).
 *     APPEND + DEDUPE, server-side:
 *       `normalizeTags([...(asset.tags ?? []), ...request.body.tags])` (:5480).
 *       `normalizeTags` is a `Set<string>` over the RAW values, first-seen order
 *       preserved (src/data/asset-repo.ts:1297-1307) — so dedupe is
 *       exact-string: "News" and "news" are two tags, " news" and "news" are two
 *       tags. Hence the client trims (below) and never folds case.
 *     One request per ENTRY, not per tag: the body takes an array, so a
 *       comma-separated entry of five tags is one round trip.
 *
 *   Remove — `openapi.json .paths["/api/v1/assets/{id}/tags/{tag}"].delete`
 *     parameters: path `id` (string, required) and path `tag`
 *       (string, `minLength: 1`, required). No body, no query params.
 *     responses: exactly `200` (the FULL ASSET) and `404`.
 *     Source of truth: `app.delete('/:id/tags/:tag', …)`,
 *       src/routes/assets.ts:5493-5514 — params
 *       `z.object({ id: z.string(), tag: z.string().min(1) })` (:5497),
 *       `response: { 200: assetSchema, 404: errorSchema }` (:5498), filter at
 *       :5506. Removing an absent tag is a server-side NO-OP that still answers
 *       200, so a double click is harmless.
 *
 *   Both writes return the full asset, so both re-render this group FROM THE
 *     RESPONSE rather than patching the pill list locally. That is the only way
 *     the client observes the server's dedupe and ordering (the rule the lock
 *     and review blocks already follow).
 *
 *   Validation caps — `const tagSchema = z.string().min(1).max(128)`,
 *     src/routes/assets.ts:393, and `const tagsSchema = z.array(tagSchema).max(128)`,
 *     :394. NO `.trim()`, no charset restriction, no case folding — in pointed
 *     contrast to `commentBodySchema`, which does trim (:1174-1176). The caps are
 *     write-side only: `assetSchema.tags` is a bare `z.array(z.string())` (:914),
 *     so a response may legitimately carry values this client would refuse to
 *     send, and such values are rendered, never hidden.
 *     A cap breach is an UNDECLARED zod 400 (`…tags.post.responses` is exactly
 *     ["200","404"]), which is why both caps are enforced pre-submit here with
 *     specific copy instead of being left to the server's generic rejection.
 *
 *   Authorisation — the ADR-018 role×action matrix `MATRIX`
 *     (src/auth/authorize.ts:54-58: `viewer { read: true, write: false,
 *     delete: false }`, editor/admin all true), applied by
 *     `resourceAuthorizationPreHandler('asset')` (src/auth/authorize.ts:126,
 *     registered src/routes/assets.ts:1748 — router-scoped, so it covers both
 *     tag sub-resources) with the action derived by `methodToAction` (:79-93).
 *     POST → `write`; DELETE → `delete`. ADD AND REMOVE ARE THEREFORE TWO
 *     DIFFERENT ACTIONS, and this module takes two capability flags (`canAdd`,
 *     `canRemove`) rather than one: today `editor`/`admin` hold both so nothing
 *     is observable, but a future role holding `write` without `delete` could
 *     add tags it cannot remove. A refusal is 403
 *     `AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role'`
 *     (src/auth/authorize.ts:99); the flags are a client-side MIRROR only and
 *     the 403 path below runs regardless, because the server is the authority.
 *
 *   Sub-resource paths take the ULID — `resolveAsset(idOrSlug)`
 *     (src/routes/assets.ts:3371-3378) has exactly one caller, `GET /:id`
 *     (:3407). Both tag routes call `repo.get(request.params.id)` directly
 *     (:5476, :5502), so the caller must pass `asset.id`, never the route
 *     parameter the pane was opened with (which may be a slug) — a slug would
 *     404 and look like a missing asset.
 *
 *   NOT implemented, because the contract has no operation for it:
 *     - renaming a tag (no PUT/PATCH on either tag path; `openapi.json` exposes
 *       exactly `post` on …/tags and `delete` on …/tags/{tag});
 *     - replacing the whole list from here (PATCH /assets/{id} does that —
 *       `updateSchema.tags`, src/routes/assets.ts:421, "On PATCH this REPLACES
 *       the tag list wholesale" :420 — but wholesale replacement is not the
 *       add/remove control this ticket scopes);
 *     - any tag taxonomy, suggestion or usage count: there is no tags
 *       collection resource in the spec to read one from.
 *
 *   KNOWN API GAP — an un-removable tag (gap T1,
 *     docs/design/editorial-panel-layout.md §10). `tagSchema` restricts no
 *     characters, but removal addresses the tag as a single PATH SEGMENT
 *     (`DELETE /:id/tags/:tag`). A tag containing `/`, `?`, `#` or a literal `%`
 *     is not reliably addressable even percent-encoded. Mitigated in both
 *     directions: those four characters are refused in the INPUT, pre-submit,
 *     by name; and a tag that already carries one is still rendered with its
 *     remove button `disabled` and an explanatory title. The real fix is
 *     server-side (restrict the charset on write, or take the tag in a body).
 */

// ─── Contract-derived limits ────────────────────────────────────────────────
//
// Mirrors of write-side server validation, enforced pre-submit because the
// server's rejection is an undeclared 400 (see CONTRACT GROUNDING).

/** `tagSchema = z.string().min(1).max(128)` (src/routes/assets.ts:393). */
export const TAG_MAX_LENGTH = 128;

/** `tagsSchema = z.array(tagSchema).max(128)` (src/routes/assets.ts:394). */
export const TAG_MAX_COUNT = 128;

/**
 * Characters that make a tag un-addressable by `DELETE /:id/tags/:tag`
 * (gap T1). Refused in the input; tolerated on read.
 */
export const TAG_UNSAFE_CHARS = Object.freeze(['/', '?', '#', '%']);

/** Pills shown before the list discloses (design spec §3: 12 ≈ three rows). */
export const TAG_OVERFLOW_LIMIT = 12;

/** Show the remaining budget only once it is nearly gone (design spec §5.2). */
export const TAG_SLOTS_WARN_AT = TAG_MAX_COUNT - 16;

// ─── Copy deck (docs/design/editorial-panel-layout.md §9) ───────────────────

export const TAGS_COPY = Object.freeze({
  heading: 'Tags',
  empty: 'No tags yet.',
  inputLabel: 'Add a tag',
  inputPlaceholder: 'add a tag…',
  addButton: 'Add',
  /** Second press after a case-clash note — the operator's choice is honoured. */
  addAnywayButton: 'Add anyway',
  helper: 'Separate several tags with commas. Tags are case-sensitive.',
  overflowOpen: function (n) {
    return 'Show all ' + n + ' tags';
  },
  overflowClose: 'Show fewer tags',
  nearCap: function (left) {
    return left + ' of ' + TAG_MAX_COUNT + ' tag slots left.';
  },
  tooLong: function (tag) {
    var head = tag.slice(0, 24);
    return (
      'A tag can be at most ' +
      TAG_MAX_LENGTH +
      ' characters. “' +
      head +
      (tag.length > 24 ? '…' : '') +
      '” is ' +
      tag.length +
      '.'
    );
  },
  capReached:
    'This asset already has ' +
    TAG_MAX_COUNT +
    ' tags, the maximum. Remove one before adding another.',
  capWouldExceed: function (left, adding) {
    return (
      'Only ' +
      left +
      ' of ' +
      TAG_MAX_COUNT +
      ' tag slots are left and this entry has ' +
      adding +
      ' new tags. Remove a tag or add fewer.'
    );
  },
  badCharacter:
    'A tag can’t contain / ? # or %. Those characters can’t be carried in the ' +
    'URL used to remove a tag again.',
  caseClash: function (existing, typed) {
    return (
      'This asset already has a tag “' +
      existing +
      '”. Tags are case-sensitive, so “' +
      typed +
      '” would be a second tag.'
    );
  },
  /** Not in the design spec's deck: the entry held nothing sendable. */
  nothingToAdd: 'Type a tag before pressing Add.',
  allPresent: 'This asset already has every tag in that entry.',
  unremovable:
    'This tag can’t be removed from here because it contains a character the ' +
    'remove URL can’t carry.',
  removeLabel: function (tag) {
    return 'Remove tag ' + tag;
  },
  readOnlyAdd:
    'Your role can see the tags but cannot add one. Ask an editor or ' +
    'administrator.',
  readOnlyRemove:
    'Your role can see the tags but cannot remove one. Ask an editor or ' +
    'administrator.',
  readOnly:
    'Your role can see the tags but cannot change them. Ask an editor or ' +
    'administrator.',
  busySuffix: '…',
  added: function (n) {
    return n === 1 ? 'Added 1 tag.' : 'Added ' + n + ' tags.';
  },
  removed: function (tag) {
    return 'Removed the tag “' + tag + '”.';
  },
  addFailed: function (n) {
    return (
      'Could not add ' + (n === 1 ? 'that tag' : 'those tags') + '. The tag list is unchanged.'
    );
  },
  removeFailed: function (tag) {
    return 'Could not remove “' + tag + '”. The tag list is unchanged.';
  },
  errForbiddenAdd:
    'Your role cannot add tags to this asset. Ask an editor or administrator.',
  errForbiddenRemove:
    'Your role cannot remove tags from this asset. Ask an editor or administrator.',
  errNotFound: 'This asset no longer exists.',
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Read the asset's `tags` defensively.
 *
 * The field is ABSENT when empty (src/data/asset-document.ts:692) and the read
 * schema puts no cap on it (src/routes/assets.ts:914), so `undefined`, `[]` and
 * a garbled payload must all collapse to the same empty list. Server ORDER IS
 * PRESERVED — first-seen order from `normalizeTags`
 * (src/data/asset-repo.ts:1297-1307). Never sorted client-side: a sort would
 * make a newly added tag jump away from the end of the list, where the
 * operator's eye already is.
 *
 * @param {unknown} tags
 * @returns {string[]}
 */
export function normaliseTagList(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.filter(function (t) {
    return typeof t === 'string' && t !== '';
  });
}

/**
 * Whether `DELETE /:id/tags/:tag` can address this tag at all (gap T1).
 *
 * @param {string} tag
 * @returns {boolean}
 */
export function isTagRemovable(tag) {
  if (typeof tag !== 'string' || tag === '') return false;
  return !TAG_UNSAFE_CHARS.some(function (c) {
    return tag.indexOf(c) !== -1;
  });
}

/**
 * Turn one operator entry into the exact `tags` array to POST.
 *
 * The server does NOT trim (`tagSchema`, src/routes/assets.ts:393) and dedupes
 * on the raw string (src/data/asset-repo.ts:1300), so an untrimmed " news" would
 * be stored as a tag permanently distinct from "news" — invisible to the person
 * who typed it. Hence: trim every token, drop the empties. But nothing is
 * lowercased, folded or rewritten: silently altering an operator's text is worse
 * than letting `News` and `news` coexist, and the search index matches what was
 * stored. A case collision is REPORTED (`clashes`) for the caller to confirm,
 * never auto-resolved.
 *
 * Tokens already present verbatim are dropped: the server would dedupe them, so
 * sending them is a pointless write.
 *
 * PURE: no DOM, no fetch.
 *
 * @param {string} raw        the raw input value (comma-separated)
 * @param {string[]} existing the tag list currently on the asset
 * @returns {{ tags: string[], duplicates: string[],
 *             clashes: Array<{typed: string, existing: string}>,
 *             error: string|null }}
 */
export function parseTagEntry(raw, existing) {
  const present = normaliseTagList(existing);
  const empty = { tags: [], duplicates: [], clashes: [], error: null };

  const tokens = String(raw == null ? '' : raw)
    .split(',')
    .map(function (t) {
      return t.trim();
    })
    .filter(function (t) {
      return t !== '';
    });

  if (tokens.length === 0) {
    return { ...empty, error: TAGS_COPY.nothingToAdd };
  }

  // Un-addressable characters: refuse the whole entry rather than silently
  // dropping one token, so the operator sees exactly what was rejected.
  const bad = tokens.find(function (t) {
    return !isTagRemovable(t);
  });
  if (bad) {
    return { ...empty, error: TAGS_COPY.badCharacter };
  }

  const long = tokens.find(function (t) {
    return t.length > TAG_MAX_LENGTH;
  });
  if (long) {
    return { ...empty, error: TAGS_COPY.tooLong(long) };
  }

  // Exact-string, first-seen dedupe WITHIN the entry — same rule as the
  // server's `normalizeTags`.
  const seen = new Set();
  const tags = [];
  const duplicates = [];
  tokens.forEach(function (t) {
    if (seen.has(t)) return;
    seen.add(t);
    if (present.indexOf(t) !== -1) {
      duplicates.push(t);
      return;
    }
    tags.push(t);
  });

  if (tags.length === 0) {
    return { tags: [], duplicates: duplicates, clashes: [], error: TAGS_COPY.allPresent };
  }

  if (present.length >= TAG_MAX_COUNT) {
    return { ...empty, duplicates: duplicates, error: TAGS_COPY.capReached };
  }
  if (present.length + tags.length > TAG_MAX_COUNT) {
    return {
      ...empty,
      duplicates: duplicates,
      error: TAGS_COPY.capWouldExceed(TAG_MAX_COUNT - present.length, tags.length),
    };
  }

  // Case-only collisions, reported in input order against the first matching
  // existing tag. Not an error: the entry is sendable, the caller just confirms.
  const clashes = [];
  tags.forEach(function (t) {
    const lower = t.toLowerCase();
    const hit = present.find(function (p) {
      return p !== t && p.toLowerCase() === lower;
    });
    if (hit) clashes.push({ typed: t, existing: hit });
  });

  return { tags: tags, duplicates: duplicates, clashes: clashes, error: null };
}

/**
 * Classify a failed tag write.
 *
 * Both operations declare only 200 and 404; 401/403 come from the router-scoped
 * auth gate and are undeclared on them (the same undeclared-status class as the
 * lock and review routes). `action` distinguishes the two authorisation actions
 * (POST → `write`, DELETE → `delete`), so the 403 copy names the right one.
 *
 * @param {{status?: number}} err  an apiFetch rejection
 * @param {'add'|'remove'} action
 * @param {{count?: number, tag?: string}} [subject]
 * @returns {{kind: 'forbidden'|'not-found'|'other', message: string}}
 */
export function classifyTagError(err, action, subject) {
  const e = err || {};
  const s = subject || {};
  if (e.status === 403 || e.status === 401) {
    return {
      kind: 'forbidden',
      message: action === 'add' ? TAGS_COPY.errForbiddenAdd : TAGS_COPY.errForbiddenRemove,
    };
  }
  if (e.status === 404) {
    return { kind: 'not-found', message: TAGS_COPY.errNotFound };
  }
  return {
    kind: 'other',
    message:
      action === 'add' ? TAGS_COPY.addFailed(s.count || 1) : TAGS_COPY.removeFailed(s.tag || ''),
  };
}

// ─── DOM helpers ────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Build the Tags group for one tag list. PURE DOM: no fetch, no listeners —
 * `mountEditorialTags` wires the controls it returns.
 *
 * `undefined` and `[]` render identically (the contract's empty state). Order is
 * the server's; the list is never sorted here.
 *
 * @param {string[]|undefined} tags
 * @param {{ canAdd?: boolean, canRemove?: boolean, expanded?: boolean,
 *           headingClass?: string, inputValue?: string, note?: string,
 *           confirming?: boolean }} [opts]
 * @returns {{ block: HTMLElement, list: HTMLElement,
 *             removeButtons: HTMLElement[], toggle: HTMLElement|null,
 *             input: HTMLElement|null, addBtn: HTMLElement|null,
 *             noteHost: HTMLElement, msgHost: HTMLElement }}
 */
export function renderTagsGroup(tags, opts) {
  const o = opts || {};
  const list = normaliseTagList(tags);
  const canAdd = o.canAdd !== false;
  const canRemove = o.canRemove !== false;
  const full = list.length >= TAG_MAX_COUNT;

  const block = el('div', 'mt12 editorial-tags');
  block.id = 'editorial-tags';
  block.appendChild(el('div', o.headingClass || 'section-title', TAGS_COPY.heading));

  const pills = el('div', 'mt8 tag-list');
  pills.id = 'editorial-tag-list';
  const removeButtons = [];
  let toggle = null;

  if (list.length === 0) {
    // Shown, never hidden: an empty group plus an input is how an operator
    // learns tagging exists (design spec §3).
    pills.appendChild(el('span', 'text-muted tags-empty', TAGS_COPY.empty));
  } else {
    const overflowing = list.length > TAG_OVERFLOW_LIMIT && !o.expanded;
    const shown = overflowing ? list.slice(0, TAG_OVERFLOW_LIMIT) : list;
    shown.forEach(function (tag) {
      const pill = el('span', 'tag tag-editable');
      pill.appendChild(el('span', 'tag-text', tag));
      if (canRemove) {
        const btn = el('button', 'tag-remove', '×');
        btn.type = 'button';
        // An "×" alone announces as "times" — name the subject (WCAG 2.4.6).
        btn.setAttribute('aria-label', TAGS_COPY.removeLabel(tag));
        btn.setAttribute('data-tag', tag);
        if (isTagRemovable(tag)) {
          removeButtons.push(btn);
        } else {
          // Gap T1: real data, so it is rendered — but it cannot be addressed.
          btn.disabled = true;
          btn.title = TAGS_COPY.unremovable;
          btn.setAttribute('data-unremovable', 'true');
        }
        pill.appendChild(btn);
      }
      pills.appendChild(pill);
    });
    if (list.length > TAG_OVERFLOW_LIMIT) {
      toggle = el(
        'button',
        'btn-ghost tag-overflow-toggle',
        o.expanded ? TAGS_COPY.overflowClose : TAGS_COPY.overflowOpen(list.length)
      );
      toggle.type = 'button';
      toggle.id = 'btn-tags-overflow';
      toggle.setAttribute('aria-expanded', o.expanded ? 'true' : 'false');
      toggle.setAttribute('aria-controls', pills.id);
    }
  }

  block.appendChild(pills);
  if (toggle) block.appendChild(toggle);

  const noteHost = el('div', 'mt8 tag-note');
  noteHost.id = 'editorial-tags-note';
  // A pre-submit note that does not move focus is still announced.
  noteHost.setAttribute('aria-live', 'polite');

  const msgHost = el('div', 'mt8 tag-msg');
  msgHost.id = 'editorial-tags-msg';
  msgHost.setAttribute('aria-live', 'polite');

  let input = null;
  let addBtn = null;

  if (canAdd) {
    const row = el('div', 'mt8 flex-gap tag-input-row');
    row.id = 'tag-input-row';
    const label = el('label', 'tag-input-label', TAGS_COPY.inputLabel);
    label.setAttribute('for', 'tag-add-input');
    input = document.createElement('input');
    input.type = 'text';
    input.id = 'tag-add-input';
    input.className = 'tag-add-input';
    input.placeholder = TAGS_COPY.inputPlaceholder;
    input.setAttribute('maxlength', String(TAG_MAX_LENGTH * 8));
    if (o.inputValue) input.value = o.inputValue;
    addBtn = el('button', 'btn-ghost', o.confirming ? TAGS_COPY.addAnywayButton : TAGS_COPY.addButton);
    addBtn.type = 'button';
    addBtn.id = 'btn-add-tags';
    // The cap is enforced pre-submit: at 128 the write could only be rejected,
    // by an UNDECLARED 400, so it is not offered. The input keeps its text.
    if (full) addBtn.disabled = true;
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(addBtn);
    block.appendChild(row);

    const help = el('div', 'tag-help text-muted', TAGS_COPY.helper);
    help.id = 'editorial-tags-help';
    block.appendChild(help);
    input.setAttribute('aria-describedby', help.id + ' ' + noteHost.id);
  } else if (canRemove) {
    block.appendChild(el('div', 'mt8 tag-role-note', TAGS_COPY.readOnlyAdd));
  } else {
    // Neither action: one sentence, not two.
    block.appendChild(el('div', 'mt8 tag-role-note', TAGS_COPY.readOnly));
  }

  if (canAdd && !canRemove) {
    block.appendChild(el('div', 'tag-role-note', TAGS_COPY.readOnlyRemove));
  }

  if (full && canAdd) {
    noteHost.appendChild(el('div', 'tag-note-line', TAGS_COPY.capReached));
  } else if (o.note) {
    noteHost.appendChild(el('div', 'tag-note-line', o.note));
  } else if (canAdd && list.length >= TAG_SLOTS_WARN_AT) {
    noteHost.appendChild(el('div', 'tag-note-line', TAGS_COPY.nearCap(TAG_MAX_COUNT - list.length)));
  }

  block.appendChild(noteHost);
  block.appendChild(msgHost);

  return {
    block: block,
    list: pills,
    removeButtons: removeButtons,
    toggle: toggle,
    input: input,
    addBtn: addBtn,
    noteHost: noteHost,
    msgHost: msgHost,
  };
}

// ─── Mount ──────────────────────────────────────────────────────────────────

/**
 * Render the Tags group and wire its add/remove controls.
 *
 * No GET of its own: the list arrives on `opts.tags`, from the asset read the
 * detail pane already holds. Both writes answer with the FULL asset, so the
 * group is redrawn from `updated.tags` — never from local state, which is the
 * only way the server's dedupe and ordering become visible. It never calls the
 * detail renderer: that would rebuild the whole pane and discard the input.
 *
 * The group is inserted before `anchorEl` when given, else appended to `host`.
 *
 * @param {object} opts
 * @param {string}      opts.assetId    the ULID — sub-resources do not resolve
 *                                      slugs (see CONTRACT GROUNDING)
 * @param {string[]}    [opts.tags]     `asset.tags` as read (may be absent)
 * @param {HTMLElement} [opts.host]
 * @param {HTMLElement} [opts.anchorEl]
 * @param {boolean}     [opts.canAdd]    mirror of `write` (POST …/tags)
 * @param {boolean}     [opts.canRemove] mirror of `delete` (DELETE …/tags/{tag})
 * @param {string}      [opts.headingClass]
 * @param {Function}    opts.apiFetch
 * @param {Function}    [opts.showMsg]  house message renderer (host, text, kind)
 * @param {(asset: object) => any} [opts.onChanged] called with the FULL asset a
 *        write returns, after the group has redrawn
 * @returns {{ block: HTMLElement|null, tags: () => string[] }}
 */
export function mountEditorialTags(opts) {
  const o = opts || {};
  const apiFetch = o.apiFetch;
  const base = '/assets/' + encodeURIComponent(String(o.assetId)) + '/tags';

  /** The most recent SERVER answer. Never edited locally. */
  let current = normaliseTagList(o.tags);
  let canAdd = o.canAdd !== false;
  let canRemove = o.canRemove !== false;
  let expanded = false;
  let rendered = null;
  let placed = false;
  let busy = false;
  /** The exact input value whose case clash the operator already accepted. */
  let acknowledged = null;

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
    rendered.msgHost.appendChild(el('div', 'msg msg-' + (kind || 'error'), text));
  }

  /**
   * Redraw the group. `state.inputValue` carries the operator's un-submitted
   * text across a redraw — a failed write never discards their input.
   */
  function draw(state) {
    const s = state || {};
    const next = renderTagsGroup(current, {
      canAdd: canAdd,
      canRemove: canRemove,
      expanded: expanded,
      headingClass: o.headingClass,
      inputValue: s.inputValue,
      note: s.note,
      confirming: s.confirming,
    });
    place(next.block);
    rendered = next;

    next.removeButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        remove(btn.getAttribute('data-tag'), btn);
      });
    });

    if (next.toggle) {
      next.toggle.addEventListener('click', function () {
        expanded = !expanded;
        draw({ inputValue: next.input ? next.input.value : undefined });
        // Focus follows the control the operator just pressed.
        const t = rendered && rendered.toggle;
        if (t) t.focus();
      });
    }

    if (next.input) {
      next.input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          add();
        }
      });
      // Editing the text withdraws a case-clash acknowledgement: the confirmed
      // entry and the one about to be sent must be the same string.
      next.input.addEventListener('input', function () {
        if (acknowledged !== null && next.input.value !== acknowledged) {
          acknowledged = null;
          if (next.addBtn) next.addBtn.textContent = TAGS_COPY.addButton;
        }
      });
    }
    if (next.addBtn) {
      next.addBtn.addEventListener('click', function () {
        add();
      });
    }

    if (s.focus === 'input' && next.input) {
      next.input.focus();
    } else if (s.focus === 'remove' && next.removeButtons.length > 0) {
      // After a removal, land on the pill that took the removed one's place —
      // or the last pill when it was the last one.
      const idx = Math.min(s.focusIndex == null ? 0 : s.focusIndex, next.removeButtons.length - 1);
      next.removeButtons[idx].focus();
    } else if (s.focus === 'remove' && next.input) {
      next.input.focus();
    }
  }

  /** POST …/tags — one request for the whole entry (the body takes an array). */
  async function add() {
    if (busy || !rendered || !rendered.input) return;
    const raw = rendered.input.value;
    const parsed = parseTagEntry(raw, current);

    if (parsed.error) {
      draw({ inputValue: raw, note: parsed.error });
      if (rendered.input) rendered.input.focus();
      return;
    }

    // A case-only collision is the operator's call, not this client's: it is
    // reported once, and a second press sends the entry unchanged.
    if (parsed.clashes.length > 0 && acknowledged !== raw) {
      acknowledged = raw;
      draw({
        inputValue: raw,
        note: TAGS_COPY.caseClash(parsed.clashes[0].existing, parsed.clashes[0].typed),
        confirming: true,
      });
      if (rendered.addBtn) rendered.addBtn.focus();
      return;
    }

    const btn = rendered.addBtn;
    const label = btn ? btn.textContent : '';
    busy = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = label + TAGS_COPY.busySuffix;
    }
    rendered.input.disabled = true;

    try {
      const updated = await apiFetch(base, {
        method: 'POST',
        body: JSON.stringify({ tags: parsed.tags }),
      });
      // Redraw from the response: the server merges + dedupes
      // (src/routes/assets.ts:5480), so only its answer is authoritative.
      current = normaliseTagList(updated && updated.tags);
      acknowledged = null;
      busy = false;
      // Focus returns to the input so several tags can be added in sequence.
      draw({ inputValue: '', focus: 'input' });
      report(TAGS_COPY.added(parsed.tags.length), 'success');
      if (typeof o.onChanged === 'function') await o.onChanged(updated);
    } catch (err) {
      busy = false;
      const c = classifyTagError(err, 'add', { count: parsed.tags.length });
      if (c.kind === 'forbidden') {
        // A control known to fail stops being offered for the rest of this view
        // of the asset (the rule the lock and review blocks set). Removal is a
        // DIFFERENT action, so it is left alone.
        canAdd = false;
        draw({});
      } else {
        // The rejected entry stays in the input, so nothing is retyped.
        draw({ inputValue: raw, focus: 'input' });
      }
      report(c.message, 'error');
    }
  }

  /** DELETE …/tags/{tag} — no confirm: a tag is one click to re-add. */
  async function remove(tag, btn) {
    if (busy || typeof tag !== 'string' || tag === '') return;
    if (!isTagRemovable(tag)) return; // gap T1 — the button is disabled anyway
    const keepInput = rendered && rendered.input ? rendered.input.value : undefined;
    const index = rendered ? rendered.removeButtons.indexOf(btn) : -1;
    busy = true;
    if (btn) btn.disabled = true;
    try {
      const updated = await apiFetch(base + '/' + encodeURIComponent(tag), { method: 'DELETE' });
      current = normaliseTagList(updated && updated.tags);
      busy = false;
      draw({ inputValue: keepInput, focus: 'remove', focusIndex: index < 0 ? 0 : index });
      report(TAGS_COPY.removed(tag), 'success');
      if (typeof o.onChanged === 'function') await o.onChanged(updated);
    } catch (err) {
      busy = false;
      const c = classifyTagError(err, 'remove', { tag: tag });
      if (c.kind === 'forbidden') {
        canRemove = false;
        draw({ inputValue: keepInput });
      } else {
        if (btn) btn.disabled = false;
      }
      report(c.message, 'error');
    }
  }

  draw({});

  return {
    get block() {
      return rendered ? rendered.block : null;
    },
    tags: function () {
      return current.slice();
    },
  };
}
