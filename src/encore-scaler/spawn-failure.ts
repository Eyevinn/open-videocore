// Spawn-failure bookkeeping (#1071): make a scale-up that CANNOT spawn visible.
//
// Why this exists: the scale-up gate (scaler-loop.ts tick step 3) calls
// spawnInstance(), which retries transient OSC errors and then throws. That
// throw used to be caught only by the interval wrapper, which logged
// "[encore-scaler] tick error" and waited for the next tick. Nothing recorded
// the failure anywhere an operator could see it, so a scaler that would not
// grow presented identically to a scaler that was simply at its cap:
// `instances: 1, queueDepth: 1` in GET /scaler/status either way. Telling "my
// cap is 1" from "OSC is refusing to create the instance" required pod logs.
//
// The failure is therefore recorded as pool state, in the scaler's own Valkey,
// under keys.spawnFailure(workspaceId) — one record per workspace, because the
// thing that failed is the workspace's scale-up, not any instance (there is no
// instance; that is the whole problem). GET /scaler/status reads it back per
// workspace.
//
// REDACTION. The recorded message is operator-facing and leaves the process, so
// it is scrubbed before it is ever written: OSC error text can quote the request
// body we sent (which carries the workspace's object-storage credentials), the
// bearer token, or instance/ingress URLs. redactSpawnFailureMessage() strips
// known literal secrets, every URL, every NETWORK LOCATION (IP or DNS name,
// with or without a port), every auth-scheme header value, every `name: value`
// pair whose NAME reads like a credential, every credential-named field whose
// value is merely SPACE-separated, and JWT-shaped blobs, then strips HTML markup
// (#1071: an OSC gateway timeout is answered with a whole HTML error page, which
// the SDK hands us as the error message) and truncates. Over-redaction is the
// intended failure mode: an operator needs the SHAPE of the failure ("403 from
// the orchestrator", "timed out waiting for ... to report running"), not the
// secret inside it.
//
// The network-location pass matters because GET /scaler/status is deliberately
// UNAUTHENTICATED (src/routes/scaler.ts) and this record is served there, so the
// message is public (#1071 review finding 2). A spawn failure is frequently a
// transport failure, and those name internal topology directly rather than as a
// URL the URL pass would catch:
//   "getaddrinfo ENOTFOUND cache-7f3a.internal.example.net"
//   "connect ECONNREFUSED 10.42.3.17:6379"
//   "endpoint store-a1b2.svc.cluster.local:9000 unreachable"
// None of those carry a scheme, and a literal-secret match on the configured
// `redis://10.42.3.17:6379` does not cover the bare `10.42.3.17:6379` inside an
// ECONNREFUSED either, so both are handled structurally here.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - keys.spawnFailure(workspaceId) / SpawnFailureRecord — defined in
//     src/encore-scaler/types.ts alongside the rest of the Valkey key schema.
//   - redis.set(key, value, 'PX', ms) / redis.get / redis.del — the exact
//     ioredis overloads already used for keys.partialVisibilityDropPasses in
//     src/encore-scaler/scaler-loop.ts (reconcile's admitPartialVisibilityDrop).
//   - EncoreScalerConfig.redisUrl / .s3Config (EncoreS3Config.accessKeyId,
//     .secretAccessKey, .endpoint) — src/encore-scaler/types.ts; these are the
//     values spawnInstance() puts in the createInstance request body
//     (src/encore-scaler/instance-pool.ts), so they are exactly what an OSC
//     error that echoes the request can leak back.

import type { Redis } from 'ioredis';
import { keys, type EncoreScalerConfig, type SpawnFailureRecord } from './types.js';

// How long a spawn-failure record lives if nothing overwrites or clears it.
// Every new failure rewrites the key with a fresh TTL, so this only expires a
// record that has gone quiet for a day — by which point "the last spawn failed"
// is history, not an operational signal. A successful spawn clears it outright.
export const SPAWN_FAILURE_TTL_MS = 24 * 60 * 60_000;

// Upper bound on the recorded message. OSC/orchestrator errors can carry a wall
// of upstream text; the status endpoint is a dashboard, not a log sink.
export const SPAWN_FAILURE_MESSAGE_MAX_LENGTH = 400;

// What a scrubbed value is replaced with.
export const REDACTED = '[redacted]';

// Shortest literal secret worth substring-matching. A very short "secret" (the
// object-storage access key id is often a 5-character word) would otherwise
// match innocuous substrings all over the message. 4 keeps the known-credential
// pass useful while refusing to turn the message into confetti; anything
// shorter than this is not a credential worth leaking anyway.
const MIN_LITERAL_SECRET_LENGTH = 4;

// How much of the message the PATTERN passes are allowed to see.
//
// Every pass below is a scan over the whole string, and the thrown value here is
// routinely a whole upstream HTML error page (@osaas/client-core puts
// `response.text()` straight into the message). The output is capped at
// SPAWN_FAILURE_MESSAGE_MAX_LENGTH regardless, so there is nothing to gain from
// pattern-matching megabytes — and something to lose: this process is
// single-threaded, so a pathological input holds up the scaler loop and every
// HTTP request with it (#1071 review finding: 'a-'.repeat(20000) took 2.8s).
//
// The clamp is applied AFTER the literal-secret pass, never before. The literal
// pass must see the FULL string, or a known credential that straddles the clamp
// boundary — or sits beyond it — would survive into a later record, and the
// clamp would have turned a bounded cost into a leak.
export const REDACTION_INPUT_MAX_LENGTH = 4_096;

// NOTE ON THESE PATTERNS. Every quantifier that can run over a long stretch of
// input is BOUNDED. An unbounded greedy run followed by a required character
// (`[a-z0-9+.-]*:`) is re-tried at every offset under /g, which is quadratic:
// the review measured 20k chars at 178ms, 80k at 2.9s on exactly that shape.
// The bounds below are all comfortably larger than the real thing they describe
// (a URL scheme, a DNS label, a field name), so they cost nothing in matching
// power — but they turn each attempt into constant work.

// Any absolute URL, whatever the scheme. Dropped wholesale rather than reduced
// to a host: instance and ingress URLs are themselves capability-ish (they are
// the endpoints an operator's token addresses) and a URL can carry userinfo or
// a pre-signed query string. The scheme is bounded: the longest registered IANA
// scheme is well under 30 characters.
const URL_PATTERN = /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s"'<>\\]+/gi;

// A bare NETWORK LOCATION: an IPv4 literal, a bracketed IPv6 literal, or a
// dotted DNS name — each with an optional `:port` (#1071 review finding 2).
// Candidates are matched broadly here and then filtered in
// isNetworkLocation() below, because the shape overlaps with things an operator
// genuinely needs to keep reading (a version string, a file reference).
//
// Each DNS label is bounded at its REAL limit (RFC 1035: 63 octets, so 61
// between the required first and last characters). Unbounded, the inner run was
// the quadratic shape described above — a long hyphenated token made every
// offset re-scan to the end of the string.
const NETWORK_LOCATION_PATTERN =
  /(?:\[[0-9A-Fa-f:]{3,}\]|\b[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)(?::\d{1,5})?/g;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// Extensions of things this system actually names in error text. Only consulted
// for a candidate with NO port, so `store.example:9000` is still a host even if
// something is one day called `example`.
const FILE_SUFFIXES = new Set([
  'conf',
  'csv',
  'html',
  'js',
  'json',
  'log',
  'm3u8',
  'md',
  'mp4',
  'mpd',
  'sh',
  'ts',
  'txt',
  'xml',
  'yaml',
  'yml'
]);

// Does a NETWORK_LOCATION_PATTERN candidate really name a host?
//
// Kept deliberately narrow in one direction only: a candidate that is NOT a
// host must survive, because this pass runs over the only diagnostic text the
// operator gets. Three shapes are therefore excluded:
//   - a dotted number (`1.18.0`, `0.24.0`) — an upstream version, and nginx's
//     own 504 page ends with one;
//   - a name whose last label is not at least two letters (`e.g`, `v1.2`), which
//     cannot be a TLD or a Kubernetes-style suffix;
//   - a port-less FILE NAME (`profiles.yaml`, `manifest.m3u8`). A file name is
//     not topology, and "failed to load [redacted]" is a materially worse
//     answer to "why can this workspace not grow" than the file name is a leak.
// An IPv4 literal is always a host. Everything else that looks like
// `label.label[.label]` is treated as one, including single-label-plus-TLD and
// `.internal` / `.svc.cluster.local` forms.
//
// NOT matched: a single-label `host:port` such as `cache:6379`. That shape is
// indistinguishable from `status:504` / `httpCode:502` by inspection, and
// redacting the status out of a spawn failure would defeat the point of the
// record. It is instead covered by the literal pass: spawnFailureSecrets()
// derives the host and host:port of every URL-shaped secret the spawn held
// (see below), which is where a single-label internal name comes from in
// practice.
function isNetworkLocation(candidate: string): boolean {
  const hasPort = /:\d{1,5}$/.test(candidate);
  const host = candidate.replace(/:\d{1,5}$/, '');
  if (host.startsWith('[')) return true; // bracketed IPv6
  if (IPV4.test(host)) return true;
  if (/^[\d.]+$/.test(host)) return false; // dotted version number
  const labels = host.split('.');
  const last = (labels[labels.length - 1] ?? '').toLowerCase();
  if (!hasPort && FILE_SUFFIXES.has(last)) return false;
  return /^[A-Za-z]{2,}$/.test(last);
}

// `Authorization: Bearer <token>` and friends, in whatever casing.
const AUTH_SCHEME_PATTERN = /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

// A `name: value` / `name=value` pair whose NAME reads like a credential. This
// is what catches an OSC error that echoes back the createInstance request body
// (s3SecretAccessKey, s3AccessKeyId, RedisUrl, ...) without us having to know
// every field name in advance.
const SENSITIVE_FIELD_PATTERN =
  /("?[A-Za-z0-9_.-]{0,64}(?:secret|token|password|passwd|credential|authorization|accesskey|apikey|key)[A-Za-z0-9_.-]{0,64}"?)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]&]+)/gi;

// The same credential-ish NAME followed only by WHITESPACE (#1071 review
// suggestion 5): `x-api-key abc123DEFghi456 rejected`, or a header/env name
// echoed with its value in a log line. The separator-less form needs a stricter
// test on the VALUE, or "secret not found" would redact the word "not" and the
// message would stop being readable. A space-separated value therefore only
// counts as a credential when it could not be ordinary prose:
//   - >= 12 characters of credential alphabet containing BOTH a letter and a
//     digit (an access key id, a hex/base62 token), or
//   - >= 20 characters of pure base64/base64url alphabet (a secret access key,
//     which can be all letters).
// Anything shorter or wordlike survives, and only the single whitespace-adjacent
// token is consumed, so trailing diagnostic text ("rejected") is kept.
const SENSITIVE_FIELD_SPACED_PATTERN =
  /("?[A-Za-z0-9_.-]{0,64}(?:secret|token|password|passwd|credential|authorization|accesskey|apikey|key)[A-Za-z0-9_.-]{0,64}"?)(\s+)((?=[A-Za-z0-9._~+/=-]*[A-Za-z])(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,}|[A-Za-z0-9+/=_-]{20,})(?![A-Za-z0-9._~+/=-])/gi;

// A JWT-shaped blob, for a bare token that appears with no label at all.
const JWT_PATTERN = /\beyJ[A-Za-z0-9._-]{10,}/g;

// An HTML/XML-ish tag. OSC's gateway answers a timed-out createInstance with a
// whole HTML error page, not JSON, and @osaas/client-core puts that page's text
// in the error message verbatim (lib/fetch.js defaultErrorFactory, non-JSON
// branch) — so the recorded message was literally
// "<html> <head><title>504 Gateway Time-out</title></head> ...". Tags are
// stripped rather than entity-escaped: the markup carries no diagnostic value
// (the readable text "504 Gateway Time-out nginx" survives), it makes the 400
// character budget go much further, and the operator-facing text is readable
// again ("504 Gateway Time-out ... nginx").
//
// A stray `<` or `>` left over from a non-markup message is deliberately kept
// AS-IS: this record is served as JSON (GET /scaler/status), where an angle
// bracket is an ordinary character and entity-encoding it would only corrupt
// legitimate error text like `expected <n> profiles`. Escaping for a particular
// rendering context belongs to whatever does that rendering, not to the stored
// value.
//
// The length bound matters for cost, not for matching: `<[^>]*>` is the same
// quadratic shape as the rest once the input contains unmatched `<` (measured:
// 9.8s on '<'.repeat(160_000)), because every `<` restarts a scan to the end of
// the string. 2048 characters is far longer than any tag in an error page —
// over-long "tags" are not stripped and stay in the text as literal angle
// brackets, which the record already tolerates (it is JSON, not markup).
const HTML_TAG_PATTERN = /<[^>]{0,2048}>/g;

// Characters that can END the kept prefix when the input is clamped.
//
// A SECRET IS ONLY SAFE FROM THE STRUCTURAL PASSES WHILE IT IS INTACT. Cutting
// the input at a fixed offset can land in the middle of one, and the dangling
// fragment then defeats every pass that would have caught it: a truncated JWT no
// longer ends where JWT_PATTERN expects, a truncated host is no longer a dotted
// name, and an access key shortened below the spaced-credential pattern's
// 12-character threshold stops looking like a credential at all. The fragment is
// then published, in the clear, on an unauthenticated endpoint. Measured on the
// previous fixed-offset clamp, sliding a payload across the boundary behind a
// markup-only prefix: 7 leaking offsets for an access key id, 10 for an internal
// hostname, 11 for a JWT.
//
// So the cut is moved back to the last delimiter, and whatever followed it is
// dropped whole. Whitespace is the obvious delimiter; the quote, bracket and
// punctuation characters are here because an error body is often one long
// unspaced run of markup or JSON, and each of them reliably ENDS a token — a
// value can continue past `/`, `:`, `@`, `=` or `-`, which is exactly why those
// are NOT in this set. `=` in particular is excluded deliberately: keeping
// `key=` and dropping the value is the right outcome, and that is what happens,
// because the cut moves back past `key=` to the delimiter before it.
const CLAMP_DELIMITERS = new Set([
  ' ', '\t', '\n', '\r', '\f', '\v',
  '"', "'", '<', '>', '`',
  ',', ';', '{', '}', '(', ')', '[', ']'
]);

// Cut `text` to at most `max` characters WITHOUT splitting a token.
//
// Linear: at most one backward scan over the kept prefix. A run with no
// delimiter at all in the first `max` characters leaves nothing — deliberately.
// Publishing the first 4 KB of one unbroken token is exactly the leak this
// function exists to prevent, and an error body with no delimiter in 4 KB has no
// readable diagnostic in it either.
function clampToTokenBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  while (end > 0 && !CLAMP_DELIMITERS.has(text[end - 1] as string)) end -= 1;
  return text.slice(0, end);
}

// What the record says when the thrown value carried no text at all.
const NO_MESSAGE = 'spawn failed with no error message';

// Scrub an arbitrary thrown value down to something safe to serve over HTTP.
//
// `secrets` are literal values the caller KNOWS were in play for this spawn
// (the object-storage credentials, the Valkey URL, the service access tokens it
// minted). They are removed first, so even a mangled or partially-quoted echo
// of one is gone before the pattern passes run.
export function redactSpawnFailureMessage(
  error: unknown,
  secrets: Iterable<string | undefined> = []
): string {
  let text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error === undefined || error === null
          ? ''
          : String(error);

  for (const secret of secrets) {
    if (typeof secret !== 'string') continue;
    const literal = secret.trim();
    if (literal.length < MIN_LITERAL_SECRET_LENGTH) continue;
    // split/join rather than a RegExp so the secret is never treated as a
    // pattern (a credential can legitimately contain regex metacharacters).
    text = text.split(literal).join(REDACTED);
  }

  // Only now is the input clamped. The literal pass above has already seen the
  // WHOLE string, so a known credential is gone wherever it sat — including one
  // that straddles this boundary or lies entirely beyond it. From here on the
  // passes are structural guesses at an unknown-shaped message, and running them
  // over an arbitrarily large upstream error page buys nothing the 400-character
  // output could keep, while costing the single-threaded process real time.
  text = clampToTokenBoundary(text, REDACTION_INPUT_MAX_LENGTH);

  text = text.replace(URL_PATTERN, REDACTED);
  // After URLs (whose host is already gone with the whole URL) and before the
  // field passes, so a bare host that appears as a field VALUE is caught by
  // whichever pass reaches it first.
  text = text.replace(NETWORK_LOCATION_PATTERN, (match) =>
    isNetworkLocation(match) ? REDACTED : match
  );
  text = text.replace(AUTH_SCHEME_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  text = text.replace(
    SENSITIVE_FIELD_PATTERN,
    (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`
  );
  text = text.replace(
    SENSITIVE_FIELD_SPACED_PATTERN,
    (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`
  );
  text = text.replace(JWT_PATTERN, REDACTED);

  // Markup last, so every secret-bearing pattern above still sees the original
  // text (an href or a form value inside a tag is redacted before the tag that
  // held it is removed).
  text = text.replace(HTML_TAG_PATTERN, ' ');

  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > SPAWN_FAILURE_MESSAGE_MAX_LENGTH) {
    text = `${text.slice(0, SPAWN_FAILURE_MESSAGE_MAX_LENGTH - 1).trimEnd()}…`;
  }
  return text === '' ? NO_MESSAGE : text;
}

// The literal credentials a spawn for this config could leak back through an
// OSC error, plus whatever short-lived tokens the caller minted along the way.
export function spawnFailureSecrets(
  config: Pick<EncoreScalerConfig, 'redisUrl' | 's3Config'>,
  extra: Iterable<string | undefined> = []
): string[] {
  const secrets: Array<string | undefined> = [
    config.redisUrl,
    config.s3Config?.endpoint,
    config.s3Config?.accessKeyId,
    config.s3Config?.secretAccessKey,
    ...extra
  ];
  const literals = secrets.filter(
    (s): s is string => typeof s === 'string' && s.trim() !== ''
  );
  return [...literals, ...literals.flatMap(derivedUrlLiterals)];
}

// The pieces of a URL-shaped secret that can appear in an error WITHOUT the
// scheme that made it a URL (#1071 review finding 2).
//
// A transport failure quotes the authority on its own: a configured
// `redis://10.42.3.17:6379` comes back as `connect ECONNREFUSED 10.42.3.17:6379`,
// which the literal pass misses because the literal still has its scheme. The
// host, the host:port and any userinfo are therefore added as literals in their
// own right. This is what covers the single-label internal name
// (`cache:6379`) that the structural network-location pass deliberately leaves
// alone. Not a URL => no derived literals.
function derivedUrlLiterals(secret: string): string[] {
  let url: URL;
  try {
    url = new URL(secret);
  } catch {
    return [];
  }
  const derived = [url.host, url.hostname];
  // Userinfo is a credential in its own right, and `URL` is the only thing that
  // can reliably separate it from the host.
  if (url.password) derived.push(decodeURIComponent(url.password));
  if (url.username) derived.push(decodeURIComponent(url.username));
  return derived.filter((value) => value !== '');
}

// Read the workspace's last recorded spawn failure.
//
// TOTAL: never throws and never rejects. This is read by GET /scaler/status,
// where one unreadable or junk key must not take down the whole status
// response, and by recordSpawnFailure() itself to carry the consecutive count
// forward.
export async function readSpawnFailure(
  redis: Pick<Redis, 'get'>,
  workspaceId: string
): Promise<SpawnFailureRecord | undefined> {
  let raw: string | null;
  try {
    raw = await redis.get(keys.spawnFailure(workspaceId));
  } catch {
    return undefined;
  }
  if (!raw) return undefined;

  let parsed: Partial<SpawnFailureRecord>;
  try {
    parsed = JSON.parse(raw) as Partial<SpawnFailureRecord>;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;

  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  // Without a usable timestamp the record cannot be reasoned about ("is this
  // failure current or from last week?"), so it is treated as absent.
  if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return undefined;

  return {
    at: parsed.at,
    attempts: num(parsed.attempts, 0),
    consecutiveFailures: num(parsed.consecutiveFailures, 1),
    message: typeof parsed.message === 'string' ? parsed.message : NO_MESSAGE
  };
}

// Record a failed scale-up for `workspaceId`, carrying the consecutive-failure
// count forward from any previous record so a one-off transient failure is
// distinguishable from a scaler that has been unable to grow for an hour.
// Returns the record as written.
export async function recordSpawnFailure(
  redis: Pick<Redis, 'get' | 'set'>,
  workspaceId: string,
  failure: {
    // How many create attempts the failed spawn actually made before it gave up.
    attempts: number;
    error: unknown;
    secrets?: Iterable<string | undefined>;
  }
): Promise<SpawnFailureRecord> {
  const previous = await readSpawnFailure(redis, workspaceId);
  const attempts = Math.max(0, Math.trunc(failure.attempts) || 0);
  const record: SpawnFailureRecord = {
    at: Date.now(),
    attempts,
    consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
    message: redactSpawnFailureMessage(failure.error, failure.secrets ?? [])
  };
  await redis.set(
    keys.spawnFailure(workspaceId),
    JSON.stringify(record),
    'PX',
    SPAWN_FAILURE_TTL_MS
  );
  return record;
}

// Drop the workspace's spawn-failure record. Called on a successful spawn so a
// recovered scaler stops reporting a failure it has since grown past.
export async function clearSpawnFailure(
  redis: Pick<Redis, 'del'>,
  workspaceId: string
): Promise<void> {
  await redis.del(keys.spawnFailure(workspaceId));
}
