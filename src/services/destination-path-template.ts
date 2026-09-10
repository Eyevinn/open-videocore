// Optional per-destination path templating for export destinations (issue #574,
// parent #531/#524, ADR-018).
//
// A static delivery prefix per destination is not always enough: operators often
// want packaged output keyed by date or asset id UNDER a destination bucket
// (issue #531 flagged this as an explicit open question — static prefix vs.
// templated prefix). This module adds an OPTIONAL, purely-additive path template
// that is rendered at JOB TIME (when the post-package relocation resolves a named
// destination, StorageBackendRegistry.resolveDestinationBucket) into the key
// prefix appended under the destination bucket.
//
// ADDITIVE CONTRACT: when a destination carries no template, resolution is
// UNCHANGED (the bare `<bucket>/` form the #573 resolver already produced). The
// template only ever adds a prefix; it never rewrites the bucket.
//
// SUPPORTED TOKENS (rendered at job time):
//   {date}     — the job date in UTC, `YYYY-MM-DD` (e.g. 2026-09-10)
//   {year}     — the job year in UTC, `YYYY`
//   {month}    — the job month in UTC, zero-padded `MM`
//   {day}      — the job day-of-month in UTC, zero-padded `DD`
//   {assetId}  — the asset id the job runs against
//
// ESCAPING: a literal brace is written doubled — `{{` renders `{` and `}}`
// renders `}`. Any single `{token}` whose name is not in the supported set is
// REJECTED at destination-registration time (InvalidPathTemplateError -> 400),
// so an operator can never register a template that would silently mis-key
// output. An unbalanced or empty brace (`{`, `}`, `{}`) is likewise rejected.

// The tokens a path template may reference. Kept as a const map so the renderer
// and the registration-time validator share ONE source of truth — a token added
// here is accepted by both automatically.
export const PATH_TEMPLATE_TOKENS = ['date', 'year', 'month', 'day', 'assetId'] as const;
export type PathTemplateToken = (typeof PATH_TEMPLATE_TOKENS)[number];

function isKnownToken(name: string): name is PathTemplateToken {
  return (PATH_TEMPLATE_TOKENS as readonly string[]).includes(name);
}

// Thrown when a destination is registered with a path template that references an
// unknown token or contains an unbalanced/empty brace. Carries the offending
// token (when identifiable) so the router can surface a clear, machine-readable
// 4xx without ever echoing a secret — a path template is non-secret operator
// config. Mirrors the statusCode-carrying error convention in
// storage-backend-registry.ts (UnknownDestinationBackendError etc.).
export class InvalidPathTemplateError extends Error {
  readonly statusCode = 400;
  readonly token?: string;
  constructor(message: string, token?: string) {
    super(message);
    this.name = 'InvalidPathTemplateError';
    if (token !== undefined) this.token = token;
  }
}

// Context the renderer substitutes for tokens at job time. Every field is
// optional so a template that references a token the caller did not supply fails
// loudly (see renderPathTemplate) rather than silently emitting an empty segment.
export type PathTemplateContext = {
  assetId?: string;
  // The job time used for the date tokens. Defaults to now() at render time.
  now?: Date;
};

// Scan a template into a flat token stream, validating brace/escape structure as
// it goes. Shared by validatePathTemplate (registration time) and
// renderPathTemplate (job time) so the two can never disagree on what is valid.
// Throws InvalidPathTemplateError on any structural problem or unknown token.
type Segment = { literal: string } | { token: PathTemplateToken };

function parseTemplate(template: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  const n = template.length;
  while (i < n) {
    const ch = template[i];
    if (ch === '{') {
      // Escaped literal open-brace: `{{` -> `{`.
      if (template[i + 1] === '{') {
        segments.push({ literal: '{' });
        i += 2;
        continue;
      }
      // A token: read up to the next `}`.
      const end = template.indexOf('}', i + 1);
      if (end === -1) {
        throw new InvalidPathTemplateError(
          'unterminated "{" in path template; write "{{" for a literal brace'
        );
      }
      const name = template.slice(i + 1, end);
      if (name.length === 0) {
        throw new InvalidPathTemplateError('empty "{}" token in path template');
      }
      if (!isKnownToken(name)) {
        throw new InvalidPathTemplateError(
          `unknown path template token "{${name}}"; supported tokens are ${PATH_TEMPLATE_TOKENS.map(
            (t) => `{${t}}`
          ).join(', ')}`,
          name
        );
      }
      segments.push({ token: name });
      i = end + 1;
      continue;
    }
    if (ch === '}') {
      // Escaped literal close-brace: `}}` -> `}`.
      if (template[i + 1] === '}') {
        segments.push({ literal: '}' });
        i += 2;
        continue;
      }
      throw new InvalidPathTemplateError(
        'unescaped "}" in path template; write "}}" for a literal brace'
      );
    }
    segments.push({ literal: ch });
    i += 1;
  }
  return segments;
}

// Validate a path template at destination-registration time. Rejects unknown
// tokens and malformed braces with InvalidPathTemplateError (statusCode 400) so
// an operator learns immediately, before the destination is ever persisted
// (issue #574: "reject unknown tokens at destination-registration time with a
// clear 4xx"). A template that parses cleanly returns normally.
export function validatePathTemplate(template: string): void {
  parseTemplate(template);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Render a validated path template into a key prefix at job time. Substitutes
// each supported token from the context; throws InvalidPathTemplateError if a
// referenced token has no value in the context (e.g. {assetId} with no assetId),
// so a job never silently writes output to a mis-keyed path with an empty
// segment. The returned prefix carries NO leading slash and NO trailing slash —
// the caller composes `<bucket>/<prefix>/`.
export function renderPathTemplate(template: string, context: PathTemplateContext): string {
  const segments = parseTemplate(template);
  const now = context.now ?? new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const values: Record<PathTemplateToken, string | undefined> = {
    date: `${year}-${pad2(month)}-${pad2(day)}`,
    year: String(year),
    month: pad2(month),
    day: pad2(day),
    assetId: context.assetId
  };
  let out = '';
  for (const seg of segments) {
    if ('literal' in seg) {
      out += seg.literal;
    } else {
      const value = values[seg.token];
      if (value === undefined || value === '') {
        throw new InvalidPathTemplateError(
          `path template token "{${seg.token}}" has no value in this job's context`,
          seg.token
        );
      }
      out += value;
    }
  }
  // Normalise: trim any leading/trailing slashes so the caller controls the
  // exact `<bucket>/<prefix>/` join. Collapse duplicate internal slashes the
  // template may have introduced (e.g. a trailing "/" before an empty tail).
  return out.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
}
