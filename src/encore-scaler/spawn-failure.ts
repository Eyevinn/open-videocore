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
// known literal secrets, every URL, every auth-scheme header value, every
// `name: value` pair whose NAME reads like a credential, and JWT-shaped blobs,
// then strips HTML markup (#1071: an OSC gateway timeout is answered with a
// whole HTML error page, which the SDK hands us as the error message) and
// truncates. Over-redaction is the intended failure mode: an operator
// needs the SHAPE of the failure ("403 from the orchestrator", "timed out
// waiting for ... to report running"), not the secret inside it.
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

// Any absolute URL, whatever the scheme. Dropped wholesale rather than reduced
// to a host: instance and ingress URLs are themselves capability-ish (they are
// the endpoints an operator's token addresses) and a URL can carry userinfo or
// a pre-signed query string.
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\]+/gi;

// `Authorization: Bearer <token>` and friends, in whatever casing.
const AUTH_SCHEME_PATTERN = /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

// A `name: value` / `name=value` pair whose NAME reads like a credential. This
// is what catches an OSC error that echoes back the createInstance request body
// (s3SecretAccessKey, s3AccessKeyId, RedisUrl, ...) without us having to know
// every field name in advance.
const SENSITIVE_FIELD_PATTERN =
  /("?[A-Za-z0-9_.-]*(?:secret|token|password|passwd|credential|authorization|accesskey|apikey|key)[A-Za-z0-9_.-]*"?)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]&]+)/gi;

// A JWT-shaped blob, for a bare token that appears with no label at all.
const JWT_PATTERN = /\beyJ[A-Za-z0-9._-]{10,}/g;

// An HTML/XML-ish tag. OSC's gateway answers a timed-out createInstance with a
// whole HTML error page, not JSON, and @osaas/client-core puts that page's text
// in the error message verbatim (lib/fetch.js defaultErrorFactory, non-JSON
// branch) — so the recorded message was literally
// "<html> <head><title>504 Gateway Time-out</title></head> ...". Tags are
// stripped rather than entity-escaped: the markup carries no diagnostic value
// (the readable text "504 Gateway Time-out nginx" survives), it makes the 400
// character budget go much further, and nothing that reaches an operator's
// browser, terminal or log viewer can then be interpreted as markup.
const HTML_TAG_PATTERN = /<[^>]*>/g;

// Any stray angle bracket left after tag-stripping (an unclosed "<", a bare
// ">"). Replaced with their HTML entities so the stored message is inert
// wherever it is rendered, while still showing the operator a character was
// there. The spawn-failure record is served by GET /scaler/status and goes
// straight into dashboards.
const STRAY_ANGLE_BRACKETS: Array<[RegExp, string]> = [
  [/</g, '&lt;'],
  [/>/g, '&gt;']
];

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

  text = text.replace(URL_PATTERN, REDACTED);
  text = text.replace(AUTH_SCHEME_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  text = text.replace(
    SENSITIVE_FIELD_PATTERN,
    (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`
  );
  text = text.replace(JWT_PATTERN, REDACTED);

  // Markup last, so every secret-bearing pattern above still sees the original
  // text (an href or a form value inside a tag is redacted before the tag that
  // held it is removed).
  text = text.replace(HTML_TAG_PATTERN, ' ');
  for (const [pattern, entity] of STRAY_ANGLE_BRACKETS) {
    text = text.replace(pattern, entity);
  }

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
  return secrets.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
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
