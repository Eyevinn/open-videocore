// Spec/route parity check (issue #480).
//
// Prevents an entire router from silently dropping out of the generated
// openapi.json (as happened with the asset-upload router, see #478/#479) by
// comparing the set of routes Fastify actually registers against the set of
// operations (method+path pairs) present in the generated spec.
//
// The comparison is intentionally SET-based, not count-based: the failure lists
// the specific method+path pairs that are missing from (or extra in) the spec,
// so the divergence is actionable rather than "73 != 80".
//
// Both sides are normalised to the same canonical form and the same set of
// non-documented framework/util routes is excluded from BOTH sides, so the
// comparison is apples-to-apples.

// A canonical operation is "METHOD path" with the path in OpenAPI style
// ({param}) and no trailing slash. e.g. "POST /api/v1/assets/{id}/upload-url".
export type Operation = string;

// Routes that are deliberately absent from the OpenAPI document: framework/util
// endpoints and the swagger UI's own static assets. Excluded from BOTH sides so
// a real, documented route is never masked by them. Matched against the
// canonical OpenAPI-style path (see toCanonicalPath).
const EXCLUDED_PATH_PREFIXES = [
  '/health',
  '/healthz',
  '/api-docs', // swagger UI + /api-docs/json spec endpoint
  '/ui', // static web UI mount (/ui and /ui/*)
];

// HTTP methods that Fastify auto-registers and that @fastify/swagger does not
// emit as documented operations. HEAD is auto-added alongside GET; OPTIONS is
// added by CORS. Excluding them on the route side keeps parity with the spec,
// which only carries the "real" verbs.
const EXCLUDED_METHODS = new Set(['HEAD', 'OPTIONS']);

// Fastify wildcard/star mounts (e.g. the static plugin's "/ui/*") are not
// documented operations either.
function isExcludedPath(canonicalPath: string): boolean {
  if (canonicalPath.includes('*')) return true;
  return EXCLUDED_PATH_PREFIXES.some(
    (prefix) => canonicalPath === prefix || canonicalPath.startsWith(prefix + '/')
  );
}

// Normalise a path to the OpenAPI canonical form used for comparison:
//   - Fastify ":param" segments -> OpenAPI "{param}"
//   - drop any trailing slash (except the root "/")
export function toCanonicalPath(path: string): string {
  const openapiStyle = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  if (openapiStyle.length > 1 && openapiStyle.endsWith('/')) {
    return openapiStyle.slice(0, -1);
  }
  return openapiStyle;
}

// A single route as reported by Fastify's onRoute hook. `method` may be a single
// verb or an array of verbs; url is in Fastify ":param" style.
export type RegisteredRoute = { method: string | string[]; url: string };

// Reduce Fastify's registered routes to the set of canonical operations that
// SHOULD appear in the OpenAPI document, applying the shared exclusions.
export function routesToOperations(routes: RegisteredRoute[]): Set<Operation> {
  const ops = new Set<Operation>();
  for (const route of routes) {
    const canonicalPath = toCanonicalPath(route.url);
    if (isExcludedPath(canonicalPath)) continue;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const upper = method.toUpperCase();
      if (EXCLUDED_METHODS.has(upper)) continue;
      ops.add(`${upper} ${canonicalPath}`);
    }
  }
  return ops;
}

// The relevant slice of an OpenAPI document: paths -> { method: operation }.
type OpenApiDoc = {
  paths?: Record<string, Record<string, unknown>>;
};

const OPENAPI_METHODS = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'head',
  'options',
  'trace',
]);

// Reduce an OpenAPI document to the set of canonical operations it declares,
// applying the SAME exclusions as the route side.
export function specToOperations(doc: OpenApiDoc): Set<Operation> {
  const ops = new Set<Operation>();
  const paths = doc.paths ?? {};
  for (const [rawPath, pathItem] of Object.entries(paths)) {
    const canonicalPath = toCanonicalPath(rawPath);
    if (isExcludedPath(canonicalPath)) continue;
    for (const method of Object.keys(pathItem)) {
      const lower = method.toLowerCase();
      if (!OPENAPI_METHODS.has(lower)) continue;
      const upper = lower.toUpperCase();
      if (EXCLUDED_METHODS.has(upper)) continue;
      ops.add(`${upper} ${canonicalPath}`);
    }
  }
  return ops;
}

export type ParityResult = {
  ok: boolean;
  // Registered on the app but absent from the spec — the failure mode #480
  // guards against (a router silently dropping out of openapi.json).
  missingFromSpec: Operation[];
  // Present in the spec but not registered on the app — a stale spec that
  // advertises routes that no longer exist.
  extraInSpec: Operation[];
};

// Compare the two operation sets and return the SET DIFFERENCE in both
// directions, sorted for stable, readable output.
export function compareOperations(
  registered: Set<Operation>,
  spec: Set<Operation>
): ParityResult {
  const missingFromSpec = [...registered].filter((op) => !spec.has(op)).sort();
  const extraInSpec = [...spec].filter((op) => !registered.has(op)).sort();
  return {
    ok: missingFromSpec.length === 0 && extraInSpec.length === 0,
    missingFromSpec,
    extraInSpec,
  };
}

// Render a human-readable report for the CLI / test failure message.
export function formatParityReport(result: ParityResult): string {
  const lines: string[] = [];
  if (result.missingFromSpec.length > 0) {
    lines.push(
      `${result.missingFromSpec.length} registered route(s) MISSING from openapi.json:`
    );
    for (const op of result.missingFromSpec) lines.push(`  - ${op}`);
  }
  if (result.extraInSpec.length > 0) {
    lines.push(
      `${result.extraInSpec.length} operation(s) in openapi.json with NO registered route:`
    );
    for (const op of result.extraInSpec) lines.push(`  + ${op}`);
  }
  if (lines.length === 0) {
    lines.push('spec/route parity OK: every registered route is documented.');
  }
  return lines.join('\n');
}
