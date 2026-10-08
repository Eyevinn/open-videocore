// Workspace-scoped search router (issue #10).
//
// GET /api/v1/search?q=&tags=&mimeType=&tamsFlowId=&tamsTimerange=&page=&pageSize=
// — full-text + metadata search over the caller's assets. Behind `authenticate`,
// so each handler runs with a validated request.workspaceId and the search repo
// scopes every query to that workspace. `tags` may be repeated or comma-separated.
//
// TAMS address lookup (issue #168, epic #116): `tamsFlowId` (a flow UUID) and
// `tamsTimerange` (ADR-008 TAI grammar) let a caller find an asset by its TAMS
// address. The addressing is projected into the search index from the asset's
// `structural.tams` block, so the index stays disposable/replayable (rebuildable
// from asset state alone). A malformed value is a 400 at the boundary.
//
// Free-form operator metadata (issue #12) is filtered with `metadata.<key>=<value>`
// query params (e.g. ?metadata.genre=documentary&metadata.language=sv). Each pair
// is an exact-match (string) filter; an asset matches when it carries all of them.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WorkspaceAccessError } from '../data/guard.js';
import { TamsFlowIdSchema, TamsTimerangeSchema } from '../data/asset-document.js';
import { ASSET_STATUSES, type Asset } from '../data/asset-repo.js';
// Per-asset retention window on the read contract (issue #1034). This endpoint
// serves archived assets (`?status=archived` below), and the deprecated alias
// `GET /api/v1/assets/search` — which advertises THIS endpoint as its
// `successor-version` — already carries `retention` on its hits, so the window
// is projected here too rather than leaving the successor poorer than the alias
// it replaces. Shape and projection are the SAME shared definitions the assets
// router uses (src/data/asset-retention.ts), not a parallel declaration.
import {
  assetRetentionWindow,
  AssetRetentionWindowSchema,
  type AssetRetentionWindow
} from '../data/asset-retention.js';
// Boot/fallback resolution of the archived-asset retention window from the
// environment (12-factor), used when the router is wired without a live getter —
// identical to src/routes/assets.ts.
import { archiveRetentionMsFromEnv } from './retention.js';
import {
  CreatedFromSchema,
  CreatedToSchema,
  resolveCreatedRange
} from '../data/created-range.js';
import {
  MAX_PAGE_SIZE,
  isUnmatchableMimeTypeFilter,
  supportedMimeTypeFilters,
  type SearchRepository
} from '../data/search-repo.js';
import { authGate } from '../auth/middleware.js';

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

const transitionSchema = z.object({
  at: z.string(),
  from: z.string().nullable(),
  to: z.string()
});

const audioTrackSchema = z.object({
  index: z.number(),
  codec: z.string(),
  channels: z.number(),
  sampleRateHz: z.number()
});

const technicalMetadataSchema = z.object({
  codec: z.string(),
  width: z.number(),
  height: z.number(),
  durationSeconds: z.number(),
  bitrateBps: z.number(),
  containerFormat: z.string(),
  audioTracks: z.array(audioTrackSchema),
  extractedAt: z.string()
});

const manifestUrlsSchema = z.object({
  hls: z.string().optional(),
  dash: z.string().optional()
});

const renditionSchema = z.object({
  id: z.string(),
  label: z.string(),
  width: z.number(),
  height: z.number(),
  objectKey: z.string(),
  codec: z.string().optional(),
  bitrateBps: z.number().optional()
});

const assetSchema = z.object({
  id: z.string(),
  // Canonical editorial title of the asset (issue #347) — the same single
  // documented location for title as GET /assets/:id. Whether a client set the
  // title through the ingest `title` field or the legacy `name` alias, it is
  // persisted to `descriptive.title` and surfaced here as `name`.
  name: z
    .string()
    .describe(
      'Canonical editorial title of the asset (persisted at ' +
        '`descriptive.title`). The free-text `q` parameter matches against ' +
        'this field regardless of whether the client set the title through ' +
        'the ingest `title` field or the legacy `name` alias.'
    ),
  description: z.string().optional(),
  status: z.string(),
  parentId: z.string().optional(),
  objectKey: z.string().optional(),
  statusHistory: z.array(transitionSchema),
  technicalMetadata: technicalMetadataSchema.nullish(),
  technicalMetadataError: z.string().optional(),
  manifestUrls: manifestUrlsSchema.optional(),
  packagingError: z.string().optional(),
  renditions: z.array(renditionSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
  // Per-asset retention window (issue #1034). Derived, read-only, and present
  // ONLY while `status === 'archived'` — the same optional member, from the same
  // shared schema, that `assetSchema` in src/routes/assets.ts publishes, so a
  // caller reading an archived asset gets the identical shape from the asset
  // read, the asset list, the deprecated `/assets/search` alias and this
  // canonical search endpoint.
  retention: AssetRetentionWindowSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

// A collection projected into the search surface (issue #561). Carries a
// `type: 'collection'` discriminator so a client can tell collection hits apart
// from asset hits (asset hits carry `type: 'asset'`), plus the descriptive
// projection from issue #559 (description/tags/custom). Collections have no
// technical or TAMS metadata, so only descriptive fields are surfaced.
const collectionHitSchema = z.object({
  type: z.literal('collection'),
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  custom: z.record(z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const searchResultSchema = z.object({
  // Asset hits, each stamped with `type: 'asset'` so the discriminator is
  // symmetric with collection hits (issue #561). The rest of the asset shape is
  // unchanged, so existing clients that ignore `type` keep working.
  assets: z.array(assetSchema.extend({ type: z.literal('asset') })),
  // Collection hits, surfaced distinctly from asset hits (issue #561).
  collections: z.array(collectionHitSchema),
  // Count of matching ASSETS (unchanged pagination contract).
  total: z.number(),
  // Count of matching COLLECTIONS (issue #561), reported separately from `total`.
  collectionTotal: z.number(),
  page: z.number()
});

// `tags` accepts repeated query params (?tags=a&tags=b) or a comma-separated
// list (?tags=a,b). Normalised to a trimmed, non-empty string array.
const tagsSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const raw = Array.isArray(v) ? v : [v];
    const flattened = raw
      .flatMap((s) => s.split(','))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return flattened.length > 0 ? flattened : undefined;
  });

const searchQuerySchema = z
  .object({
    q: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        'Case-insensitive free-text query matched against the asset title ' +
          '(the canonical `name` field, persisted at `descriptive.title`) and ' +
          'description. Matches title whether the client set it through the ' +
          'ingest `title` field or the legacy `name` alias (issue #347).'
      ),
    tags: tagsSchema,
    mimeType: z
      .string()
      // Trim BEFORE the length check so a whitespace-only value is a 400 rather
      // than a filter the matcher has to interpret (it would otherwise pass
      // `.min(1)` and the repo would have to decide what a blank filter means).
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe(
        'Container-format filter, matched against the probe-extracted ' +
          '`technicalMetadata.containerFormat`. Accepts either a bare container ' +
          'token (`mp4`, `mov`, `webm`, `matroska`) or a common media MIME type ' +
          '(`video/mp4`), which is resolved onto the ffprobe container family it ' +
          'names — so `video/mp4` matches an asset stored as `mov,mp4,m4a` ' +
          '(issue #822). Matching is case-insensitive and per family token. A ' +
          'MIME-shaped value that neither maps to a container family nor names a ' +
          'content type this API accepts on upload can never match any asset, ' +
          'and is rejected with 400 `unsupported_mime_type` rather than silently ' +
          'returning an empty result set.'
      ),
    // Lifecycle status (issue #833). Reuses the SAME enum the assets endpoint
    // accepts — `ASSET_STATUSES` from data/asset-repo.ts, which is what
    // `openapi.json` -> `paths./api/v1/assets/.get.parameters[name=status]`
    // renders as `enum: [uploading, processing, ready, failed, archived]` —
    // rather than re-declaring the list, so the two surfaces cannot drift. The
    // match is exact and is applied independently of `q`.
    status: z
      .enum(ASSET_STATUSES)
      .optional()
      .describe(
        'Exact-match lifecycle status filter, identical in accepted values and ' +
          'match semantics to `GET /api/v1/assets/?status=`. Applied ' +
          'independently of `q`, so the same status answers the same asset set ' +
          'with or without a free-text term. Asset-only: supplying it excludes ' +
          'all collection hits, since a collection has no lifecycle status.'
      ),
    // Inclusive created-at range (issue #833). Shared grammar/semantics with
    // `GET /api/v1/assets/` (data/created-range.ts).
    from: CreatedFromSchema.optional(),
    to: CreatedToSchema.optional(),
    // TAMS address lookup (issue #168, epic #116). Reuse the field validation
    // from the asset model (asset-document.ts) rather than re-declaring it:
    // `tamsFlowId` is a single flow UUID and `tamsTimerange` the ADR-008 TAI
    // grammar. A malformed value fails here at the boundary (400) before any
    // repo call, matching the ADR-010 query contract.
    tamsFlowId: TamsFlowIdSchema.optional(),
    tamsTimerange: TamsTimerangeSchema.optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional()
  })
  // Allow `metadata.<key>=<value>` filter params through (issue #12); extracted
  // from the raw query below since their key names are dynamic.
  .passthrough();

// Pull `metadata.<key>=<value>` pairs out of the raw query object into a flat
// metadata filter. Only the first value is used when a key is repeated.
function extractMetadataFilter(
  query: Record<string, unknown>
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('metadata.')) {
      continue;
    }
    const field = key.slice('metadata.'.length);
    if (field.length === 0) {
      continue;
    }
    out[field] = Array.isArray(value) ? value[0] : value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

type SearchRouterOptions = {
  repository: SearchRepository;
  // The EFFECTIVE instance-global archived-asset retention window, in ms, read
  // as a GETTER so every request sees the live value PATCH
  // /api/v1/retention/config hot-swaps (issue #1034). main.ts binds it to the
  // same `archiveRetentionMs` instance global the purge loop ticks on and the
  // assets router reads, so the window this endpoint reports, the window
  // /api/v1/assets reports, and the window the sweep enforces are ONE value.
  // Optional: when omitted it falls back to `archiveRetentionMsFromEnv()`,
  // evaluated per call — the SAME env var main.ts boots from. Used only to
  // derive the read-only `retention` member of an archived asset hit.
  retentionMs?: () => number;
};

export const searchRouter: FastifyPluginAsync<SearchRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository;

  // Live read of the effective archived-asset retention window (issue #1034),
  // mirroring src/routes/assets.ts: called per request so the derived
  // `retention` member reflects a hot-swapped PATCH /api/v1/retention/config.
  const retentionMsNow = opts.retentionMs ?? archiveRetentionMsFromEnv;

  // Attach the derived, read-only retention window to an asset hit. A no-op for
  // any asset that is not `archived`: assetRetentionWindow returns undefined and
  // the hit simply carries no `retention` member (the field is optional).
  function withRetentionWindow(asset: Asset): Asset & { retention?: AssetRetentionWindow } {
    const retention = assetRetentionWindow(asset, retentionMsNow());
    return retention ? { ...asset, retention } : asset;
  }

  // 401 presence gate (issue #711): reject anonymous requests to this
  // workspace-scoped router. Plugin-scoped so it does not affect public routers.
  // See src/routes/assets.ts for the full rationale.
  app.addHook('preHandler', authGate(app));

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof WorkspaceAccessError) {
      return reply.code(err.statusCode).send({ error: 'forbidden', message: err.message });
    }
    throw err;
  });

  app.get(
    '/',
    {
      schema: {
        tags: ['search'],
        summary: 'Search assets and collections',
        description:
          'The single canonical search endpoint. Combines an exact-filter tier ' +
          '(`tags`, `mimeType`, `metadata.<key>`, `tamsFlowId`, `tamsTimerange`) with a ' +
          'free-text tier (`q`, matched case-insensitively over name and description). ' +
          'All filters are ANDed; omit them all to list every asset and collection in ' +
          'the workspace. Both assets AND collections are searched (issue #561): a ' +
          "collection matches on its `name`/`description`/`tags` and its open `custom` " +
          'bag (via `metadata.<key>`). Asset-only filters (`mimeType`, `tamsFlowId`, ' +
          '`tamsTimerange`) never match a collection. Asset hits and collection hits ' +
          'are returned in separate arrays and each carries a `type` discriminator ' +
          "(`'asset'` | `'collection'`) so they are unambiguously distinguishable. " +
          '`mimeType` filters on the extracted container format and accepts either ' +
          'a container token (`mp4`) or a common media MIME type (`video/mp4`), ' +
          'which is resolved onto the container family it names (issue #822). ' +
          'Results are paginated via `page`/`pageSize` and returned as ' +
          '`{ assets, collections, total, collectionTotal, page }`. The ' +
          'exact-filter tier also carries `status` (exact lifecycle match, ' +
          'asset-only) and an inclusive created-at range `from`/`to` (issue ' +
          '#833); both are applied to the whole matched set before pagination, ' +
          'so they narrow `total` and every page rather than the page in hand. ' +
          'Results are ALWAYS CURRENT and there is no reindex step (issue #929): ' +
          'this endpoint reads the stored assets and collections per request ' +
          'rather than consulting a separately maintained index, so an edit made ' +
          'through `PATCH /api/v1/assets/{id}` or `PATCH /api/v1/collections/{id}` ' +
          '— a rename included — is reflected by the next search with nothing ' +
          'called in between. An asset hit that is `archived` additionally ' +
          'carries the derived read-only `retention` window (issue #1034) — ' +
          '`archivedAt`/`purgeAfter`/`retentionMs`, identical in shape and ' +
          'meaning to the member on `GET /api/v1/assets/{id}` — so ' +
          '`?status=archived` answers "when may this be purged?" without a ' +
          'second call. The member is absent on every non-archived hit.',
        querystring: searchQuerySchema,
        response: { 200: searchResultSchema, 400: errorSchema }
      }
    },
    async (request, reply) => {
      const { q, tags, mimeType, status, from, to, tamsFlowId, tamsTimerange, page, pageSize } =
        request.query;
      // Reject a `mimeType` that can never match any asset here (issue #822):
      // MIME-shaped, no container family resolves it, AND it is not a content
      // type this API accepts on upload. The filter compares against ffprobe's
      // format_name, which never contains `/`, so such a value would return an
      // empty page indistinguishable from "no assets match"; failing at the
      // boundary names the problem instead. A type the API DOES ingest is
      // excluded from this gate — a real asset can carry it, so it gets an
      // ordinary result rather than being called unsupported.
      if (mimeType !== undefined && isUnmatchableMimeTypeFilter(mimeType)) {
        return reply.code(400).send({
          error: 'unsupported_mime_type',
          message:
            `Unsupported mimeType filter "${mimeType}". This filter matches the ` +
            'container format extracted from the media, so it accepts a container ' +
            'token (e.g. "mp4", "mov", "webm", "matroska") or one of these MIME ' +
            `types: ${supportedMimeTypeFilters().join(', ')}.`
        });
      }
      const metadata = extractMetadataFilter(request.query as Record<string, unknown>);
      // An inverted range is a caller mistake, not an empty result (issue #833).
      const created = resolveCreatedRange({ from, to });
      if (!created.ok) {
        return reply.code(400).send({ error: 'invalid_created_range', message: created.message });
      }
      const result = await repo.search({
        q,
        tags,
        mimeType,
        metadata,
        status,
        ...created.range,
        tamsFlowId,
        tamsTimerange,
        page,
        pageSize
      });
      // Stamp the `type: 'asset'` discriminator on each asset hit so the shape is
      // symmetric with collection hits (issue #561). Collection hits already
      // carry `type: 'collection'` from the projection (toCollectionHit).
      // Each hit also carries the derived `retention` window while it is
      // archived (issue #1034) — same helper, same shape as the assets router,
      // so `?status=archived` here answers with the same retention detail the
      // deprecated `GET /api/v1/assets/search` alias returns.
      return {
        ...result,
        assets: result.assets.map((a) => ({ ...withRetentionWindow(a), type: 'asset' as const }))
      };
    }
  );
};
