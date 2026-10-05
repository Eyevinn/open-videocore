/**
 * open-videocore ops dashboard — search-filter-params.js
 *
 * The REQUEST GRAMMAR for the structured (exact-filter) tier of
 * GET /api/v1/search/ — tags and free-form operator metadata — plus the plain
 * text grammar the ops-UI filter controls type them in (issue #947).
 *
 * One module so the Assets tab filter bar and the Search tab cannot fork the
 * grammar between them: both the acceptance criteria for #947 ("behavior matches
 * the equivalent Search tab filters for the same GET /api/v1/search/
 * parameters") and the consolidation this is broken out of (#826) depend on the
 * two surfaces building the SAME query from the same typed text.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetch the contract before the call)
 *
 * Endpoint: GET /api/v1/search/ — openapi.json path key "/api/v1/search/".
 *
 *   tags   openapi.json .paths["/api/v1/search/"].get.parameters[name="tags"]
 *          -> schema { anyOf: [ {type:"string"}, {type:"array", items:{type:"string"}} ] }.
 *          Source: `tagsSchema`, src/routes/search.ts:139-150 — "`tags` accepts
 *          repeated query params (?tags=a&tags=b) or a comma-separated list
 *          (?tags=a,b). Normalised to a trimmed, non-empty string array."
 *          This module emits the COMMA-SEPARATED form (one `tags` param), which
 *          is the form the server flattens on `s.split(',')` and the form the
 *          Search tab already sends (public/app.js `search-tags` ->
 *          params.set('tags', tags)).
 *          Match semantics: ALL requested tags must be present — AND, not OR
 *          (src/data/search-repo.ts:378-382, `query.tags.every(...)`), and the
 *          comparison is exact/case-sensitive (`tags.includes(t)`).
 *
 *   metadata.<key>=<value>
 *          Free-form operator metadata (issue #12). NOT a fixed parameter, so it
 *          is absent from openapi.json's parameter list by construction: the key
 *          names are dynamic and `searchQuerySchema` carries `.passthrough()`
 *          (src/routes/search.ts:219) precisely so these reach the handler.
 *          Grammar and semantics are declared at src/routes/search.ts:14-16 —
 *          "Free-form operator metadata (issue #12) is filtered with
 *          `metadata.<key>=<value>` query params (e.g.
 *          ?metadata.genre=documentary&metadata.language=sv). Each pair is an
 *          exact-match (string) filter; an asset matches when it carries all of
 *          them." — and extracted by `extractMetadataFilter`,
 *          src/routes/search.ts:223-238 (prefix `metadata.`, empty key skipped,
 *          first value used when a key repeats).
 *          Match semantics: strict equality per pair, ANDed
 *          (src/data/search-repo.ts:392-399, `md[key] !== value`). The query
 *          string only ever delivers STRINGS, so a metadata field stored as a
 *          number or boolean cannot be matched through this filter — that is a
 *          server-side typing property, not something a client can paper over,
 *          and the control's hint says so rather than pretending otherwise.
 *
 * Both filters are applied to the WHOLE matched set before pagination
 * (src/data/search-repo.ts:49-54), so they narrow `total` and every page — no
 * client-side narrowing is needed or wanted (issue #834).
 *
 * This module is PURE: no DOM, no network, no window. It is the vocabulary the
 * controls and the fetch layer share.
 */

// The one comma-separated `tags` param (verified above).
export const TAGS_PARAM = 'tags';

// The dynamic metadata filter prefix (verified above: src/routes/search.ts:228).
export const METADATA_PARAM_PREFIX = 'metadata.';

// The separator for BOTH typed grammars. Comma for tags because that is the
// server's own list separator for this param; comma for metadata pairs so one
// filter bar does not ask an operator to remember two separators.
const SEPARATOR = ',';

// The pair separator inside one metadata segment. `=` mirrors the query param it
// becomes (`metadata.genre=documentary`), so what is typed reads like what is
// sent. Split on the FIRST `=` only, so a value may contain one.
const PAIR_SEPARATOR = '=';

/**
 * Parse typed tag text into the trimmed, de-duped, order-preserving tag list the
 * server's `tagsSchema` would itself produce from the comma-separated form.
 * De-duping is ours, not the server's: a repeated tag is a no-op for an AND
 * match, and sending it twice would only make a shared URL noisier.
 *
 * @param {string} text e.g. 'news, sports'
 * @returns {string[]}  e.g. ['news', 'sports']
 */
export function parseTagsFilterText(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const raw of text.split(SEPARATOR)) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * Render a tag list back into the control's text form. Round-trips
 * parseTagsFilterText (whitespace around separators is not meaningful).
 *
 * @param {string[]} tags
 * @returns {string}
 */
export function formatTagsFilterText(tags) {
  if (!Array.isArray(tags)) return '';
  return tags
    .filter((t) => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim())
    .join(SEPARATOR + ' ');
}

/**
 * Parse typed metadata text into exact-match pairs, plus the segments that could
 * not be understood.
 *
 * Reported rather than silently dropped: `genre` on its own, or `genre=`, is an
 * operator part-way through expressing a filter, and a filter bar that quietly
 * ignores half its input is a filter bar that lies about what the table is
 * showing. The caller surfaces `ignored` next to the control (see
 * public/assets-table.js) so the difference between "not filtered on that yet"
 * and "filtered and found nothing" stays visible.
 *
 * Later pairs win on a repeated key, matching the "first value used" collapse
 * the server performs per param name (src/routes/search.ts:235) — either way one
 * key carries one value, and resolving it here keeps the request honest about
 * which one.
 *
 * @param {string} text e.g. 'genre=documentary, language=sv'
 * @returns {{ entries: Record<string,string>, ignored: string[] }}
 */
export function parseMetadataFilterText(text) {
  const entries = {};
  const ignored = [];
  if (typeof text !== 'string') return { entries, ignored };
  for (const raw of text.split(SEPARATOR)) {
    const segment = raw.trim();
    if (!segment) continue;
    const at = segment.indexOf(PAIR_SEPARATOR);
    const key = at >= 0 ? segment.slice(0, at).trim() : '';
    const value = at >= 0 ? segment.slice(at + PAIR_SEPARATOR.length).trim() : '';
    // An empty key would be dropped by the server's own extractor
    // (src/routes/search.ts:232) and an empty value would filter for the empty
    // string — neither is what a half-typed segment means.
    if (!key || !value) {
      ignored.push(segment);
      continue;
    }
    entries[key] = value;
  }
  return { entries, ignored };
}

/**
 * Render a metadata filter map back into the control's text form. Round-trips
 * parseMetadataFilterText for every pair that grammar can express.
 *
 * @param {Record<string,string>} entries
 * @returns {string}
 */
export function formatMetadataFilterText(entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return '';
  return Object.keys(entries)
    .filter((k) => k.trim().length > 0 && String(entries[k]).trim().length > 0)
    .map((k) => k.trim() + PAIR_SEPARATOR + String(entries[k]).trim())
    .join(SEPARATOR + ' ');
}

/**
 * Write the structured filter tier onto a URLSearchParams bound for
 * GET /api/v1/search/. Mutates and returns `params` so it composes with the
 * caller's q/status/from/to/page/pageSize.
 *
 * Nothing is written for an empty filter: an absent param is the server's "no
 * filter", while `tags=` would be a filter the normaliser then has to discard
 * (src/routes/search.ts:148).
 *
 * @param {URLSearchParams} params
 * @param {{ tags?: string[], metadata?: Record<string,string> }} filter
 * @returns {URLSearchParams} the same instance
 */
export function applySearchFilterParams(params, filter) {
  const f = filter || {};
  const tags = Array.isArray(f.tags) ? f.tags.filter((t) => typeof t === 'string' && t.length) : [];
  if (tags.length) {
    // One comma-separated param, the form the server flattens and the form the
    // Search tab already sends.
    params.set(TAGS_PARAM, tags.join(SEPARATOR));
  }
  const metadata = f.metadata && typeof f.metadata === 'object' ? f.metadata : {};
  for (const key of Object.keys(metadata)) {
    const value = metadata[key];
    if (!key || value === undefined || value === null || String(value).length === 0) continue;
    params.set(METADATA_PARAM_PREFIX + key, String(value));
  }
  return params;
}

/**
 * True when either structured filter carries something the server would act on.
 * The Assets tab uses this to decide which backend tier can answer the view at
 * all: GET /api/v1/assets/ accepts NO tags/metadata params (verified —
 * openapi.json .paths["/api/v1/assets/"].get.parameters is exactly
 * limit/offset/status/parentId/from/to), so a tag or metadata filter can only be
 * honoured by GET /api/v1/search/.
 *
 * @param {{ tags?: string[], metadata?: Record<string,string> }} filter
 * @returns {boolean}
 */
export function hasStructuredFilter(filter) {
  const f = filter || {};
  if (Array.isArray(f.tags) && f.tags.length) return true;
  return !!(f.metadata && typeof f.metadata === 'object' && Object.keys(f.metadata).length > 0);
}
