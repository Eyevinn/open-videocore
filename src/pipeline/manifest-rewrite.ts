// Manifest child-reference rewriting for proxied delivery (issue #340).
//
// When packaged output is delivered through the authorized proxy route
// (`GET /api/v1/assets/:id/stream/*`, src/routes/assets.ts, added in issue
// #339), a player fetches the master manifest through the proxy and then
// resolves the child references it contains. Those children — variant
// playlists, the audio group, CMAF init + media segments, and DASH
// BaseURL/SegmentTemplate targets — must ALSO be fetched back through the same
// proxy prefix, or playback fails: a reference that is absolute (rooted at the
// object-store bucket) or a full object-store URL escapes the proxy entirely
// (issue #333 calls this out explicitly).
//
// The proxy serves an object at `<proxyBase>/<relative>`, where `<relative>` is
// the object's path RELATIVE to the asset's packaged prefix
// (`packaged/<id>/...`, src/pipeline/packaging.ts outputPrefix). This module
// rewrites the references inside an `.m3u8` or `.mpd` so each one becomes an
// absolute proxy URL of that shape.
//
// It NEVER mutates stored bytes: the route reads the stored manifest, runs this
// text transform, and sends the rewritten text on the proxied response only.
// Media segment bytes are passed through untouched by the caller (this module
// is only invoked for `.m3u8`/`.mpd`).

// The rewrite context the route supplies for one manifest fetch.
export type ManifestRewriteContext = {
  // Absolute-or-relative URL prefix up to and including `<id>/stream` (NO
  // trailing slash), such that `<proxyBase>/<relative>` is a proxy URL for the
  // object at `<relative>` within the packaged prefix. Built by the route from
  // assetsBaseUrl() + proxyStreamPrefix(id).
  proxyBase: string;
  // The requested manifest's own path RELATIVE to the packaged prefix, e.g.
  // `index.m3u8` (master at the prefix root) or `audio/audio.m3u8` (a nested
  // variant). Used to resolve a child reference that is itself relative to the
  // manifest's directory, so it maps to the correct proxy path.
  manifestRelativePath: string;
  // The asset's packaged prefix (`packaged/<id>`), used to recognise and strip
  // references that were emitted as absolute paths rooted at the prefix or the
  // bucket. src/pipeline/packaging.ts outputPrefix.
  packagedPrefix: string;
  // The packaged bucket name, used to recognise a reference emitted as an
  // absolute path or full URL that includes the bucket segment
  // (`/<bucket>/packaged/<id>/...`). src/pipeline/packaging.ts packagedBucket.
  packagedBucket: string;
};

// True when the wildcard path names an HLS/DASH manifest (case-insensitive).
// The route calls this to decide whether to run the text transform below; every
// other object (segments, init files) is streamed through byte-for-byte.
export function isManifestPath(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return lower.endsWith('.m3u8') || lower.endsWith('.mpd');
}

// The directory portion of a prefix-relative path (no trailing slash), or '' at
// the root. `audio/audio.m3u8` -> `audio`; `index.m3u8` -> ''.
function dirOf(relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, '');
  const slash = clean.lastIndexOf('/');
  return slash < 0 ? '' : clean.slice(0, slash);
}

// Collapse `a/b/../c` and `./` segments in a POSIX-style path. Used after
// joining a manifest's directory with a relative child reference so the result
// is a clean path within the packaged prefix. Leading `..` that would escape the
// root are dropped (the proxy route rejects `..` anyway).
function normalizeJoin(dir: string, ref: string): string {
  const parts = (dir ? `${dir}/${ref}` : ref).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

// Map a single child reference (as written in the manifest) to the path it must
// take within the packaged prefix, then return the absolute proxy URL for it.
// Returns the reference UNCHANGED when it must not be rewritten:
//   - empty / whitespace
//   - a fragment or query-only value
//   - an absolute URL to a DIFFERENT host that is not the object store (a CDN or
//     third-party the operator deliberately referenced) — left as-is
//   - a `data:` URI
// Recognised forms that ARE rewritten:
//   - relative to the manifest's own directory (`seg-1.m4s`, `../v/pl.m3u8`)
//   - root-absolute rooted at the bucket (`/<bucket>/packaged/<id>/...`)
//   - root-absolute rooted at the packaged prefix (`/packaged/<id>/...`)
//   - a full object-store URL whose path contains the packaged prefix
export function rewriteReference(ref: string, ctx: ManifestRewriteContext): string {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return ref;
  // A pure fragment or query has no path to proxy.
  if (trimmed.startsWith('#') || trimmed.startsWith('?')) return ref;
  if (/^data:/i.test(trimmed)) return ref;

  const withinPrefix = resolveWithinPrefix(trimmed, ctx);
  if (withinPrefix === undefined) {
    // Not a reference into this asset's packaged output — leave it untouched so
    // an operator-supplied external URL (CDN, third-party subtitle) is preserved.
    return ref;
  }
  // Preserve a trailing slash (a directory reference, e.g. a DASH <BaseURL>),
  // which is significant for relative resolution on the player side.
  const trailing = /\/$/.test(trimmed) && withinPrefix.length > 0 ? '/' : '';
  const base = ctx.proxyBase.replace(/\/+$/, '');
  return `${base}/${withinPrefix}${trailing}`;
}

// Resolve a child reference to its path RELATIVE to the packaged prefix, or
// undefined when the reference does not point into this asset's packaged output.
function resolveWithinPrefix(
  ref: string,
  ctx: ManifestRewriteContext
): string | undefined {
  const prefix = ctx.packagedPrefix.replace(/^\/+|\/+$/g, '');
  const bucketPrefix = `${ctx.packagedBucket.replace(/^\/+|\/+$/g, '')}/${prefix}`;

  // Full URL (scheme://host/path...). Strip to its path and see if it lands in
  // the packaged prefix (with or without the bucket segment). A full URL that
  // does NOT contain the prefix is treated as an intentional external reference.
  const asUrl = tryParseUrl(ref);
  if (asUrl) {
    const path = asUrl.pathname.replace(/^\/+/, '');
    return stripToWithinPrefix(path, prefix, bucketPrefix);
  }

  // Root-absolute path (`/...`): rooted at the store, not the manifest. Strip a
  // leading bucket or prefix segment to recover the prefix-relative path.
  if (ref.startsWith('/')) {
    const path = ref.replace(/^\/+/, '');
    return stripToWithinPrefix(path, prefix, bucketPrefix);
  }

  // Otherwise it is relative to the manifest's own directory. Join and normalise
  // so `../v/pl.m3u8` from `audio/audio.m3u8` resolves to `v/pl.m3u8`.
  return normalizeJoin(dirOf(ctx.manifestRelativePath), ref);
}

// Given a store path (no leading slash) that may be rooted at the bucket or the
// packaged prefix, return the portion AFTER the packaged prefix, or undefined
// when the path does not fall under the prefix at all.
function stripToWithinPrefix(
  path: string,
  prefix: string,
  bucketPrefix: string
): string | undefined {
  if (path === bucketPrefix || path.startsWith(`${bucketPrefix}/`)) {
    return path.slice(bucketPrefix.length).replace(/^\/+/, '');
  }
  if (path === prefix || path.startsWith(`${prefix}/`)) {
    return path.slice(prefix.length).replace(/^\/+/, '');
  }
  return undefined;
}

function tryParseUrl(value: string): URL | undefined {
  try {
    // A bare `//host/path` protocol-relative URL parses only with a base; treat
    // it as a full URL by supplying a dummy scheme so its host is skipped.
    if (value.startsWith('//')) {
      return new URL(`https:${value}`);
    }
    return new URL(value);
  } catch {
    return undefined;
  }
}

// Rewrite an HLS playlist (`.m3u8`), master or variant. Two reference kinds:
//   1. URI attributes inside tag lines, e.g.
//        #EXT-X-MEDIA:...,URI="audio/audio.m3u8"
//        #EXT-X-MAP:URI="init.mp4"
//        #EXT-X-I-FRAME-STREAM-INF:...,URI="iframe/pl.m3u8"
//      -> the quoted URI value is rewritten in place.
//   2. Bare URI lines (a line that is not blank and not a `#` tag): a variant
//      playlist path in the master, or a segment path in a variant.
//      -> the whole line is rewritten.
// Every other line (tags without a URI, comments, blank lines) passes through.
export function rewriteHlsManifest(body: string, ctx: ManifestRewriteContext): string {
  const lines = body.split(/\n/);
  const out = lines.map((line) => {
    // Preserve a trailing \r so CRLF manifests round-trip unchanged.
    const cr = line.endsWith('\r') ? '\r' : '';
    const content = cr ? line.slice(0, -1) : line;

    if (content.length === 0) return line;

    if (content.startsWith('#')) {
      // Rewrite any URI="..." attribute on a tag line (EXT-X-MEDIA, EXT-X-MAP,
      // EXT-X-I-FRAME-STREAM-INF, EXT-X-KEY, etc.). Multiple attributes on one
      // line are handled by the global regex.
      const rewritten = content.replace(
        /URI="([^"]*)"/g,
        (_m, uri: string) => `URI="${rewriteReference(uri, ctx)}"`
      );
      return rewritten + cr;
    }

    // A bare, non-tag, non-blank line is a playlist/segment URI.
    return rewriteReference(content, ctx) + cr;
  });
  return out.join('\n');
}

// Rewrite a DASH manifest (`.mpd`). Targets the reference-bearing attributes the
// packager emits:
//   - <BaseURL>...</BaseURL>                     (element text)
//   - SegmentTemplate media="..."                (attribute)
//   - SegmentTemplate initialization="..."       (attribute)
//   - SegmentURL media="..." / mediaRange kept   (attribute)
//   - <Initialization sourceURL="..."/>          (attribute)
// The DASH `$Number$`/`$Time$`/`$RepresentationID$` template variables are left
// intact — they are path-internal, and the proxy prefix is prepended ahead of
// them (the template still resolves per segment on the player side, now against
// the proxy path). Namespaces/other XML are untouched (pure text transform).
export function rewriteDashManifest(body: string, ctx: ManifestRewriteContext): string {
  let out = body;

  // <BaseURL>value</BaseURL> — element text. A DASH BaseURL is resolved against
  // the manifest URL, so a relative BaseURL of `./` or a bucket-absolute one
  // both get normalised to the proxy path.
  out = out.replace(
    /(<BaseURL[^>]*>)([\s\S]*?)(<\/BaseURL>)/g,
    (_m, open: string, value: string, close: string) =>
      `${open}${rewriteDashTemplateValue(value, ctx)}${close}`
  );

  // Reference-bearing attributes. Each is a quoted string that may contain DASH
  // `$...$` template variables, which rewriteDashTemplateValue preserves.
  const attrs = ['media', 'initialization', 'sourceURL'];
  for (const attr of attrs) {
    const re = new RegExp(`(\\b${attr}=)"([^"]*)"`, 'g');
    out = out.replace(
      re,
      (_m, prefix: string, value: string) =>
        `${prefix}"${rewriteDashTemplateValue(value, ctx)}"`
    );
  }

  return out;
}

// Rewrite a DASH attribute/BaseURL value that may embed `$Number$`-style
// template variables. The variables are placeholders the player substitutes per
// segment; they must survive the rewrite verbatim. We split the value on the
// `$...$` tokens, rewrite only the literal path portions, and re-join.
function rewriteDashTemplateValue(value: string, ctx: ManifestRewriteContext): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  // Isolate the template tokens (including the `$$` literal-dollar escape) so
  // they pass through untouched.
  const tokens = value.split(/(\$[^$]*\$|\$\$)/);
  // A path that contains template variables cannot be parsed as a whole URL, so
  // rewrite the reference formed by stripping the variables to a placeholder,
  // then restore the variables at the same offsets. Simpler + robust approach:
  // rewrite the FIRST literal chunk (which carries the directory/host portion)
  // and leave later chunks (filename patterns) as-is, because the proxy path is
  // a prefix.
  //
  // Find the first non-template chunk that carries the path root.
  for (let i = 0; i < tokens.length; i++) {
    const chunk = tokens[i];
    if (chunk.length === 0) continue;
    if (/^\$[^$]*\$$|^\$\$$/.test(chunk)) continue; // a template token
    // The first literal chunk holds the path leading up to any template var.
    // Rewrite it, then stop: subsequent literal chunks are within the same file
    // reference (e.g. an extension) and the rewritten prefix already carries the
    // directory.
    const rewritten = rewriteReference(chunk, ctx);
    if (rewritten === chunk) {
      // Not a reference into our packaged output — leave the whole value alone.
      return value;
    }
    tokens[i] = rewritten;
    return tokens.join('');
  }
  return value;
}

// Dispatch to the HLS or DASH rewriter based on the manifest's extension. The
// route calls this after reading the stored manifest text; a non-manifest path
// never reaches here (guarded by isManifestPath).
export function rewriteManifest(
  relativePath: string,
  body: string,
  ctx: ManifestRewriteContext
): string {
  if (relativePath.toLowerCase().endsWith('.mpd')) {
    return rewriteDashManifest(body, ctx);
  }
  return rewriteHlsManifest(body, ctx);
}
