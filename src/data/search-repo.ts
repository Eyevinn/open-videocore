// Asset search repository (issue #10).
//
// Abstracts full-text + metadata search behind a workspace-scoped interface,
// mirroring the AssetRepository split: an in-memory implementation for tests /
// local dev (filters the InMemoryAssetRepository) and a CouchDB implementation
// using Mango queries (see couch-search-repo.ts). Both apply the workspace
// partition so a query can only ever reach the caller's own assets.

import type { Asset, AssetStatus } from './asset-repo.js';
import type { Collection } from './collection-repo.js';
import { withinCreatedRange } from './created-range.js';
import { isAcceptedUploadContentType, normaliseContentType } from './media-types.js';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface SearchQuery {
  // Free-text query matched against name/description (case-insensitive).
  q?: string;
  // Asset tags; an asset matches when it carries all requested tags.
  tags?: string[];
  // Container format filter (issue #822). Matched against the probe-extracted
  // `technicalMetadata.containerFormat`, which ffprobe reports as a
  // comma-separated family ("mov,mp4,m4a"). Accepts either a bare container
  // token ("mp4") or a common media MIME type ("video/mp4"), which is resolved
  // onto that family — the parameter is named `mimeType` on the wire, so it now
  // accepts what its name claims instead of silently matching nothing.
  mimeType?: string;
  // Free-form metadata filter (issue #12). An asset matches when, for every
  // key/value pair given here, its `metadata` carries that exact value
  // (strict equality on top-level keys).
  metadata?: Record<string, unknown>;
  // TAMS address lookup (issue #168, TAMS bridge epic #116). The index projects
  // the asset's machine-derived TAMS addressing (structural.tams, asset-
  // document.ts) so an asset can be looked up by its TAMS address. Both are
  // single-valued QUERY fields, matching the ADR-010 query contract:
  //   - tamsFlowId: a SINGLE flow UUID; an asset matches when this id is a
  //     MEMBER of its tamsFlowIds[] set (a source carries many flows, ADR-008,
  //     but a query addresses one flow at a time — ADR-010).
  //   - tamsTimerange: the canonical TAI timerange string, matched by EQUALITY.
  // The match is derived purely from the asset document, so the index stays
  // disposable/replayable: it can be rebuilt from asset state with no side
  // channel (issue #168 acceptance criterion).
  tamsFlowId?: string;
  tamsTimerange?: string;
  // Lifecycle status (issue #833). EXACT match on the asset's `status`, the
  // identical semantics `GET /api/v1/assets/` already has via
  // `ListOptions.status` (asset-repo.ts) -> `state` Mango mirror
  // (couch-asset-repo.ts buildSelector). Asset-only: collections have no
  // lifecycle state, so setting it excludes every collection hit.
  status?: AssetStatus;
  // Inclusive created-at range (issue #833), already normalised to canonical UTC
  // instants by the route (created-range.ts). Applies to assets AND collections
  // (both carry a `createdAt`), and — like every other filter here — is applied
  // to the whole matched set before the page slice, so it narrows `total` too.
  createdFrom?: string;
  createdTo?: string;
  page?: number;
  pageSize?: number;
}

// A collection projected into the search surface (issue #561). Mirrors the
// asset-hit shape but carries only the descriptive projection (name +
// description/tags/custom from issue #559) — collections have no technical or
// TAMS metadata. The projection is derived purely from the collection document,
// so it stays disposable/rebuildable from the document store exactly like the
// asset projection (couch-search-repo.ts): there is no side-channel state.
export interface CollectionHit {
  // Discriminator so collection hits are unambiguously distinguishable from
  // asset hits in the combined response (issue #561 acceptance criterion).
  type: 'collection';
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  custom?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult {
  assets: Asset[];
  // Collection hits, surfaced distinctly from asset hits (issue #561). Present
  // as an empty array when nothing matches, so the field is always shaped the
  // same way regardless of backend or query.
  collections: CollectionHit[];
  total: number;
  page: number;
  // Count of matching COLLECTIONS (issue #561). `total` continues to count
  // matching ASSETS so the pre-existing asset pagination contract is unchanged;
  // collection paging is reported separately here.
  collectionTotal: number;
}

export interface SearchRepository {
  search(query: SearchQuery): Promise<SearchResult>;
}

// Project a stored collection into a search hit (issue #561). Pure and derived
// only from the collection document, so the collection projection is disposable
// and rebuildable from the document store — the same property the asset
// projection guarantees (couch-search-repo.ts fromDoc). The `type` discriminator
// is stamped here so every collection hit is distinguishable from an asset hit.
export function toCollectionHit(collection: Collection): CollectionHit {
  return {
    type: 'collection',
    id: collection.id,
    name: collection.name,
    description: collection.description,
    tags: collection.tags,
    custom: collection.custom,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt
  };
}

// Collection tags (issue #559/#561). Read defensively — `tags` is optional and
// additive on the Collection type (collection-repo.ts), mirroring assetTags().
export function collectionTags(collection: Collection): string[] {
  const tags = collection.tags;
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
}

// Match a collection against the shared SearchQuery (issue #561), mirroring
// matchesQuery() for assets so collection and asset search rules stay in
// lockstep:
//   - `q` matches case-insensitively over the collection name and description.
//   - `tags` requires ALL requested tags (AND semantics), like assets.
//   - `metadata.<key>=<value>` matches against the open `custom` bag (issue #559
//     ADR-005 typed-core + open-`custom`), the collection analogue of the asset
//     `descriptive.custom` -> `asset.metadata` projection.
//   - Asset-only filters (mimeType, tamsFlowId, tamsTimerange) can never match a
//     collection (collections carry no technical/TAMS metadata), so any of those
//     being set excludes all collections — a query that addresses assets by
//     container/TAMS is not asking for collections.
export function matchesCollectionQuery(collection: Collection, query: SearchQuery): boolean {
  // `status` joins the asset-only filters (issue #833): a collection has no
  // lifecycle state, so a query that asks for one is not asking for collections.
  if (query.mimeType || query.tamsFlowId || query.tamsTimerange || query.status) {
    return false;
  }
  // The created-at range (issue #833) is NOT asset-only — a collection carries a
  // `createdAt` of its own, so the range applies to it on the same terms.
  if (!withinCreatedRange(collection.createdAt, query)) {
    return false;
  }
  if (query.q) {
    const q = query.q.toLowerCase();
    const inName = collection.name.toLowerCase().includes(q);
    const inDescription = collection.description?.toLowerCase().includes(q) ?? false;
    if (!inName && !inDescription) {
      return false;
    }
  }
  if (query.tags && query.tags.length > 0) {
    const tags = collectionTags(collection);
    if (!query.tags.every((t) => tags.includes(t))) {
      return false;
    }
  }
  if (query.metadata) {
    const custom = collection.custom ?? {};
    for (const [key, value] of Object.entries(query.metadata)) {
      if (custom[key] !== value) {
        return false;
      }
    }
  }
  return true;
}

// Tags are stored as an optional, loosely-typed field on the asset document.
// They are not part of the core Asset lifecycle, so we read them defensively.
export function assetTags(asset: Asset): string[] {
  const tags = asset.tags;
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
}

// The raw container format the `mimeType` filter matches against: the value
// extracted by the probe (issue #6), read from
// `Asset.technicalMetadata.containerFormat` (asset-repo.ts:312).
export function assetContainerFormat(asset: Asset): string | undefined {
  return asset.technicalMetadata?.containerFormat;
}

// The container format split into its family tokens.
//
// ffprobe reports `format.format_name` as a COMMA-SEPARATED format family, and
// the extractor stores that string verbatim
// (src/pipeline/metadata-extractor.ts:125 `containerFormat: format.format_name`)
// — so a real MP4 is persisted as `mov,mp4,m4a,3gp,3g2,mj2` and a WebM as
// `matroska,webm` (asserted in test/metadata-extraction.test.ts:128,189).
// Comparing the whole string by equality therefore missed the very values an
// operator would type ("mp4"), so we match per token. Tokens are lower-cased;
// comparison is case-insensitive throughout.
export function assetContainerFormatTokens(asset: Asset): string[] {
  const raw = assetContainerFormat(asset);
  if (!raw) {
    return [];
  }
  return raw
    .toLowerCase()
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// MIME type -> container-format family (issue #822).
//
// The `mimeType` filter is documented and labelled as a MIME type but compares
// against the probe's container format, which is NEVER a MIME type: `video/mp4`
// could not match anything, and the failure was silent (an empty result set).
// Rather than rename the parameter out from under existing callers, we map the
// common media MIME types onto the container family tokens ffprobe actually
// emits, so the filter accepts what it claims AND keeps accepting bare
// container values ("mp4", "webm") as before.
//
// Each entry lists the format_name tokens that legitimately carry that MIME
// type. The mov/mp4/m4a family is one ffprobe format, so `video/mp4` and
// `video/quicktime` both address it (issue #822: "video/mp4 matches an asset
// whose containerFormat is mp4 or mov"). For the same reason `video/3gpp` and
// `video/3gpp2` address it too: the probe output captured in
// test/osc-ffprobe.test.ts:18 ("Input #0, mov,mp4,m4a,3gp,3g2,mj2") shows
// ffprobe reports ONE family string for all of them, so the `3gp`/`3g2` tokens
// are not separable from `mp4`/`mov` after the fact. `video/3gpp` is an accepted
// upload content type (UPLOAD_CONTENT_TYPES), so it has to resolve here rather
// than be told it is unsupported.
const MIME_TYPE_CONTAINER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'video/mp4': ['mp4', 'mov', 'm4v', 'm4a', '3gp', '3g2', 'mj2', 'isom', 'mp42'],
  'application/mp4': ['mp4', 'mov', 'm4v', 'm4a'],
  'audio/mp4': ['mp4', 'mov', 'm4a'],
  'video/3gpp': ['3gp', '3g2', 'mp4', 'mov', 'm4a'],
  'video/3gpp2': ['3g2', '3gp', 'mp4', 'mov'],
  'video/quicktime': ['mov', 'mp4', 'qt'],
  'video/webm': ['webm', 'matroska'],
  'audio/webm': ['webm', 'matroska'],
  'video/x-matroska': ['matroska', 'mkv', 'webm'],
  'video/x-msvideo': ['avi'],
  'video/mp2t': ['mpegts', 'ts'],
  'video/mpeg': ['mpeg', 'mpegvideo', 'mpegts'],
  'video/ogg': ['ogg', 'ogv'],
  'audio/ogg': ['ogg', 'oga'],
  'video/x-flv': ['flv'],
  'audio/mpeg': ['mp3'],
  'audio/aac': ['aac', 'adts'],
  'audio/flac': ['flac'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/vnd.wave': ['wav']
};

// A filter value is MIME-shaped when it carries the `type/subtype` separator.
// A container format token never contains `/` (it comes from ffprobe's
// format_name), so a MIME-shaped value can only ever match through the alias
// map above.
export function isMimeTypeShaped(value: string): boolean {
  return value.includes('/');
}

// The container tokens a MIME-shaped filter value addresses, or undefined when
// the value is not a recognised MIME type. Parameters are dropped before lookup
// (e.g. `video/mp4; codecs="avc1.42E01E"`).
export function containerAliasesForMimeType(value: string): readonly string[] | undefined {
  return MIME_TYPE_CONTAINER_ALIASES[normaliseContentType(value)];
}

// Every MIME type the filter can resolve, sorted — surfaced in the 400 message
// so a caller that used an unsupported one is told what IS accepted.
export function supportedMimeTypeFilters(): string[] {
  return Object.keys(MIME_TYPE_CONTAINER_ALIASES).sort();
}

// True when the value can never match ANY asset in this system, which is what
// makes it worth rejecting at the boundary rather than answering with an empty
// page (issue #822 acceptance criterion 3). Three conditions, all required:
//
//   1. it is MIME-shaped — a bare container token like `avi` may simply match
//      nothing today and match tomorrow, so it is a legitimate empty result;
//   2. no alias maps it onto a container family; AND
//   3. it is not a content type this API accepts on upload
//      (UPLOAD_CONTENT_TYPES, data/media-types.ts).
//
// Condition 3 is the one that keeps the claim above honest. An accepted upload
// type CAN be carried by a real asset, so rejecting it would be telling an
// operator that a format this product ingests is unsupported vocabulary — and
// would turn a request that used to answer 200 into a hard error. Such a value
// falls through to an ordinary (possibly empty) result instead. Deriving this
// from the shared array rather than restating it means registering a new upload
// type cannot leave a stale rejection behind.
export function isUnmatchableMimeTypeFilter(value: string): boolean {
  const trimmed = value.trim();
  return (
    isMimeTypeShaped(trimmed) &&
    containerAliasesForMimeType(trimmed) === undefined &&
    !isAcceptedUploadContentType(trimmed)
  );
}

// Match one asset against the `mimeType` filter (issue #822). Accepts either a
// MIME type (mapped onto the container family) or a bare container token, and
// matches per token so the comma-separated ffprobe family string is handled.
export function matchesMimeTypeFilter(asset: Asset, filter: string): boolean {
  const value = filter.trim().toLowerCase();
  if (value.length === 0) {
    // A blank filter is NOT "no filter": returning true here would silently turn
    // `?mimeType=%20` into a request for every asset — the same class of
    // wrong-but-plausible answer issue #822 is about, inverted. The route
    // schema trims and rejects a blank value (400) before reaching here, so this
    // is belt-and-braces for any other caller of the matcher.
    return false;
  }
  const tokens = assetContainerFormatTokens(asset);
  if (tokens.length === 0) {
    return false;
  }
  const aliases = containerAliasesForMimeType(value);
  if (aliases) {
    return aliases.some((alias) => tokens.includes(alias));
  }
  if (isMimeTypeShaped(value)) {
    // A MIME type with no alias cannot be compared against a container token.
    // Where it is also not an accepted upload type the route has already
    // rejected it (isUnmatchableMimeTypeFilter); where it IS one — e.g. an
    // `image/*` still, or `application/octet-stream` — it reaches here and
    // matches nothing, because no MIME type is recoverable from format_name.
    return false;
  }
  // Bare container value. Match a single family token ("mp4" against
  // "mov,mp4,m4a"), or the whole stored string ("mov,mp4,m4a" verbatim) so a
  // caller that already filters on the exact persisted value keeps working.
  return tokens.includes(value) || assetContainerFormat(asset)?.toLowerCase() === value;
}

// TAMS flow ids projected onto the asset for address lookup (issue #168). Read
// defensively — the field is optional/additive (present only on assets bridged
// into a TAMS, epic #116) and predates by no schema bump (asset-repo.ts).
export function assetTamsFlowIds(asset: Asset): string[] {
  const ids = asset.tamsFlowIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

export function clampPage(page?: number): number {
  if (page === undefined || Number.isNaN(page)) {
    return 1;
  }
  return Math.max(1, Math.floor(page));
}

export function clampPageSize(pageSize?: number): number {
  if (pageSize === undefined || Number.isNaN(pageSize)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
}

// Shared in-memory matcher used by the in-memory repo and as the CouchDB
// fallback when the text index is unavailable. Keeps match semantics identical
// across backends.
export function matchesQuery(asset: Asset, query: SearchQuery): boolean {
  // Exact-filter tier first, and deliberately INDEPENDENT of `q` (issue #833
  // acceptance criterion: a status filter answers the same set whether or not
  // free text is supplied). Exact match on `Asset.status`, the same comparison
  // `InMemoryAssetRepository.list` makes for `GET /api/v1/assets/?status=`.
  if (query.status && asset.status !== query.status) {
    return false;
  }
  if (!withinCreatedRange(asset.createdAt, query)) {
    return false;
  }
  if (query.q) {
    const q = query.q.toLowerCase();
    const inName = asset.name.toLowerCase().includes(q);
    const inDescription = asset.description?.toLowerCase().includes(q) ?? false;
    if (!inName && !inDescription) {
      return false;
    }
  }
  if (query.tags && query.tags.length > 0) {
    const tags = assetTags(asset);
    if (!query.tags.every((t) => tags.includes(t))) {
      return false;
    }
  }
  // Container/MIME filter (issue #822). Delegated so both backends share one
  // definition of "matches": MIME types map onto the ffprobe container family,
  // bare container values match a single family token.
  if (query.mimeType) {
    if (!matchesMimeTypeFilter(asset, query.mimeType)) {
      return false;
    }
  }
  if (query.metadata) {
    const md = asset.metadata ?? {};
    for (const [key, value] of Object.entries(query.metadata)) {
      if (md[key] !== value) {
        return false;
      }
    }
  }
  // TAMS address lookup (issue #168). A query addresses one flow by a single
  // UUID; the asset matches when that id is a MEMBER of its projected flow set.
  if (query.tamsFlowId) {
    if (!assetTamsFlowIds(asset).includes(query.tamsFlowId)) {
      return false;
    }
  }
  // Canonical timerange is matched by exact equality (ADR-010).
  if (query.tamsTimerange) {
    if (asset.tamsTimerange !== query.tamsTimerange) {
      return false;
    }
  }
  return true;
}
