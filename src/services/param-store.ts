// OSC parameter store client (issue #31, ADR-002).
//
// After a stack is provisioned we persist its non-secret connection
// coordinates to the OSC parameter store (the `eyevinn-app-config-svc`
// service) so the API can reconnect to a named stack at runtime without the
// caller re-supplying every endpoint. Deprovision (#29) also reads the stored
// `services` list to know what to tear down.
//
// The @osaas/client-core SDK does not (as of 2026-06-01) expose parameter-store
// helpers — the store is itself an OSC service instance exposing an HTTP
// key/value API guarded by an API key. We therefore talk to it over HTTP here,
// mirroring the narrow-interface + HTTP-impl pattern used by EncoreClient
// (pipeline/encore-client.ts). The friction is logged to
// docs/osc-feedback/incoming-issue31-param-store.md.
//
// SECURITY: only non-secret connection coordinates are stored. Passwords and
// password-bearing connection strings must never be written here — callers are
// responsible for stripping credentials before handing values to storeStackConfig
// (see stripCredentials).

// Non-secret coordinates for one storage role (source or packaged), persisted
// so downstream routes and deprovision can resolve which backend a stack uses
// without re-reading the request body (issue #211). NO secret values here:
// accessKeyId, secretAccessKey and sessionToken are NEVER stored — they belong
// in OSC secrets and are wired into services by the follow-up sub-issue (#212).
//   backend 'minio'    — the provisioned per-stack MinIO instance (default,
//                        zero-config). bucket is the on-MinIO bucket name;
//                        endpointUrl/region are omitted (the MinIO endpoint is
//                        already recorded as minioEndpoint).
//   backend 'external' — an operator-supplied S3-compatible object store. bucket
//                        is the external bucket; endpointUrl is present for
//                        non-AWS S3-compatible stores; region is optional.
//   publicBaseUrl      — OPTIONAL operator-supplied public origin fronting the
//                        bucket (e.g. a CDN origin). When present it OVERRIDES
//                        the URL derived from endpointUrl/region + bucket for the
//                        emitted delivery/manifest host (issue #213). NON-SECRET:
//                        a plain origin URL, never carries credentials. Only
//                        meaningful for the 'external' backend; ignored for
//                        'minio' (which is API-proxied and never emits a public
//                        object URL).
export type StorageBackendConfig = {
  backend: 'minio' | 'external';
  bucket: string;
  endpointUrl?: string;
  region?: string;
  publicBaseUrl?: string;
};

// The connection coordinates persisted for a provisioned stack. Every value is
// a host/URL/endpoint or a bucket name — NO passwords, NO credential-bearing
// connection strings. See the storage list in issue #31.
export type StackConfig = {
  // Lifecycle state of the stored config (issue #106). A partial-failure write
  // persists 'failed' (or 'provisioning') so the resolver never treats a stack
  // that never finished provisioning as live/connectable — it only builds real
  // connections for 'ready'. Optional for back-compat: configs written before
  // this field existed have no `status` and MUST be read as 'ready' so already
  // provisioned live stacks keep working (see isReadyStack).
  //
  // TEARDOWN states (issue #1210). A stack whose DELETE is running or left
  // services behind MUST stay in the listing — its stored config is the only
  // record of what is still to remove — but it must not read as a live stack:
  //   'deleting'      — a teardown is in flight for this stack.
  //   'delete_failed' — a teardown finished with at least one service NOT
  //                     removed (StackTeardownResult.status === 'failed'); the
  //                     entry is deliberately retained so a retried DELETE can
  //                     re-read services[] and finish the job.
  // Both are non-ready, so isReadyStack (and therefore the resolver) skips
  // them exactly like 'provisioning'/'failed'. The entry is only deleted once
  // every service is confirmed gone.
  status?:
    | 'provisioning'
    | 'ready'
    | 'failed'
    | 'deleting'
    | 'delete_failed';
  // When this stack was first recorded, as an ISO-8601 instant (issue #1165).
  // Stamped ONCE, by the first write that creates the stack's key (the
  // 'provisioning' marker, or the final 'ready' write when the marker could not
  // be written), and PRESERVED verbatim by every later write to the same stack —
  // status transitions, the packager-inventory update (main.ts), and the partial
  // 'failed' write all carry the original value forward.
  //
  // This is the ONLY ordering key for the stack listing. The config service's
  // list endpoint does not specify an order (param-store.ts:359-361
  // ConfigObjectList), so before #1165 the listing order — and therefore the
  // no-X-Stack-Name default stack, which is the FIRST listed stack — changed
  // whenever a stack was added. Ordering by this field makes the listing
  // creation-ordered and the default stable.
  //
  // Optional for back-compat, mirroring `status?`: a stack provisioned before
  // #1165 carries no value here. Absence means "created before this deployment
  // recorded creation times" — it is not an unknown instant, but it is also not
  // a position: such a stack necessarily predates every stack stamped by a
  // later build, so compareStackCreationOrder sorts unstamped stacks first and
  // separates them from each other by name.
  //
  // What that does and does not guarantee, precisely (see
  // compareStackCreationOrder):
  //   - A deployment with ONE pre-existing stack keeps that stack as its
  //     default: it is the only unstamped entry, so it stays at index 0.
  //   - A deployment with SEVERAL pre-existing stacks does NOT necessarily keep
  //     its previous default. Those stacks have no recorded instant to order
  //     them by, so they sort by name, and the no-X-Stack-Name default becomes
  //     the name-first one. If the store happened to list a different stack
  //     first before the upgrade, the default moves once, at upgrade.
  //
  // Two mechanisms close that gap; neither invents a creation time:
  //   - DEFAULT_STACK_NAME (see resolvePinnedStackName) lets an operator pin
  //     the default explicitly, which overrides ordering entirely.
  //   - backfillCreatedAt() stamps a legacy stack with LEGACY_STACK_CREATED_AT
  //     — an explicit "created before creation times were recorded" marker that
  //     orders exactly as absence does, so the key becomes persisted and stable
  //     instead of being re-derived from absence on every listing.
  createdAt?: string;
  minioEndpoint: string;
  // CouchDB host/URL only — no embedded password.
  couchdbUrl: string;
  redisUrl: string;
  sourceBucket: string;
  packagedBucket: string;
  // Optional pipeline services activated by provisioning rather than env vars
  // (issue #215, data-model foundation for #216/#217/#218). These are opt-in
  // consumers and deliberately NOT part of STACK_SERVICES. Optional for
  // back-compat, mirroring `status?`/isReadyStack: configs written before these
  // fields existed have no value here and MUST still load without error.
  autoSubtitlesInstanceName?: string;
  sceneDetectInstanceName?: string;
  // Operator-supplied FULL Encore profiles-index URL (issue #315). When set,
  // scaler-spawned Encore instances fetch their transcode profiles from this
  // exact URL (used DIRECTLY, never re-derived), resolved at boot via
  // resolveEncoreProfilesUrlFromParamStore (services/public-base-url.ts). This
  // lets custom profiles work WITHOUT adding a new OSC manifest env-var key.
  // NON-SECRET: a plain index URL, never carries credentials. Optional for
  // back-compat, mirroring the fields above: configs written before this field
  // existed have no value here and MUST still load without error, and an unset
  // value falls through to the remote default index (byte-identical to today).
  encoreProfilesUrl?: string;
  // The object store's PER-STACK access key id (issue #1094). NON-SECRET: an
  // identifier, like a username — the same classification the #212 external
  // credential mapping gives `accessKeyId`
  // (services/external-storage-credentials.ts:33). The matching SECRET access
  // key is NEVER stored here (nor anywhere else at rest): it is derived from
  // this id plus the deployment seed by resolveObjectStoreCredential
  // (services/object-store-credentials.ts) and persisted as an OSC secret for
  // the services that consume it by reference.
  //
  // Optional for back-compat, mirroring `status?` / the fields above: a stack
  // provisioned BEFORE #1094 carries no value here, and its absence is the
  // signal to use the legacy process-global `admin` + deployment-password
  // credential (removed, with the stacks migrated, by #1096). Present means the
  // stack's object store was created with its own credential.
  objectStoreAccessKeyId?: string;
  // The Valkey queue key this stack's on-demand packager consumes. Every
  // packager listens on the same shared Valkey, so a packager provisioned for a
  // non-first stack gets its own key (packagerQueueForStack) — otherwise any
  // stack's packager could pop another stack's job and read the wrong object
  // store. Recorded when the packager is created so producers enqueue onto
  // exactly the key it was built with. Optional for back-compat: a packager
  // provisioned before this field existed consumes the shared default key, and
  // an unset value keeps enqueueing there.
  packagerQueue?: string;
  // Per-role storage backend metadata (issue #211). Optional for back-compat:
  // configs written before this field existed have no `storage`, in which case
  // both roles are the default per-stack MinIO backend (sourceBucket /
  // packagedBucket on minioEndpoint). Present when the operator supplied an
  // external S3-compatible store for either role. NON-SECRET coordinates only —
  // credentials are stored as OSC secrets by #212, never here.
  storage?: {
    source: StorageBackendConfig;
    packaged: StorageBackendConfig;
  };
  // The OSC instances that make up the stack, for deprovision (#29).
  services: { serviceId: string; instanceName: string }[];
};

// True when a stored config represents a fully provisioned, connectable stack.
// Back-compat: a missing `status` (config written before issue #106) is treated
// as 'ready' so existing live stacks keep resolving. Only 'ready' (or absent)
// stacks are connected; 'provisioning'/'failed' are skipped by the resolver but
// remain readable for deprovision cleanup (they still carry services[]). The
// teardown states 'deleting'/'delete_failed' (issue #1210) are skipped for the
// same reason and for the same purpose: the entry survives so a retried DELETE
// still knows which services are left.
export function isReadyStack(config: StackConfig): boolean {
  return config.status === undefined || config.status === 'ready';
}

// Narrow interface so the provision/read routes can be tested without a live
// parameter store. The HTTP implementation is makeHttpParamStore.
export interface ParamStore {
  // Persist all coordinates for one named stack, scoped to a workspace.
  storeStackConfig(
    workspaceId: string,
    name: string,
    config: StackConfig
  ): Promise<void>;
  // Read back the coordinates for a named stack, or undefined if none stored.
  loadStackConfig(
    workspaceId: string,
    name: string
  ): Promise<StackConfig | undefined>;
  // Remove the stored coordinates for a named stack (deprovision, #29). Must be
  // idempotent: deleting an already-absent entry resolves without error.
  deleteStackConfig(workspaceId: string, name: string): Promise<void>;
  // List all stack names persisted for a workspace.
  //
  // ORDERING IS PART OF THIS CONTRACT (issue #1165). The returned array MUST be
  // in CREATION ORDER: oldest stack first, newly created stacks appended last.
  // Three resolution paths in WorkspaceStackResolver take element [0] as the
  // workspace default stack for a request with no X-Stack-Name header
  // (resolve(), resolveStackName(), resolveStackConfig()), so an unstable order
  // silently reassigns the default — and the Encore profile index that follows
  // it — every time a stack is provisioned.
  //
  // Implementations MUST order with compareStackCreationOrder (below) rather
  // than returning the store's own iteration order: the config service's list
  // endpoint specifies no order (see CONFIG_LIST_PAGE_LIMIT's contract note).
  listStackNames(workspaceId: string): Promise<string[]>;
}

// One entry in a stack listing, before ordering: the stack name plus the
// `createdAt` read off its stored config (absent for a pre-#1165 stack).
export type StackListingEntry = { name: string; createdAt?: string };

// Parse a `createdAt` into a comparable epoch, or undefined when it is absent or
// not a usable instant. A malformed value is treated exactly like an absent one
// (pre-#1165 / legacy) rather than throwing — a corrupt timestamp must not make
// the whole listing unorderable.
function createdAtEpoch(createdAt?: string): number | undefined {
  if (typeof createdAt !== 'string' || createdAt.length === 0) return undefined;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Total, deterministic order over a stack listing (issue #1165).
//
// The order, in precedence:
//   1. Unstamped before stamped. A config with no usable `createdAt` was
//      written by an earlier build, so it predates every stack a later build
//      stamped. This is the rule that keeps a deployment's original default
//      stack at index 0 when a new stack is provisioned — the reported bug,
//      where adding a second stack to a deployment that had one moved the
//      default to the new stack.
//   2. `createdAt` ascending among stamped stacks, so a newly provisioned stack
//      sorts last and is appended to the listing instead of landing in the
//      middle. LEGACY_STACK_CREATED_AT is the lowest representable stamp, so a
//      backfilled legacy stack sorts with the unstamped ones.
//   3. Name ascending as the final tiebreak. Needed for two legacy stacks (no
//      distinct instant to separate them) and for two stacks stamped inside the
//      same millisecond. Without it the order would fall back to the store's
//      unspecified iteration order and the default could still move.
//
// Scope, stated honestly: this makes the order a FUNCTION OF THE RECORDS, so it
// is stable against adding, removing and re-listing stacks. It does NOT
// reconstruct the pre-upgrade order of several stacks that were never stamped —
// rule 3 orders those by name, so a deployment with more than one pre-existing
// stack can see its no-header default change once, at upgrade. An operator who
// needs a specific stack to stay the default sets DEFAULT_STACK_NAME, which
// takes precedence over all three rules (resolvePinnedStackName /
// orderStackNamesByCreation).
//
// Pure and side-effect free so both the HTTP client and any other ParamStore
// implementation can share one ordering rule and cannot drift apart.
export function compareStackCreationOrder(
  a: StackListingEntry,
  b: StackListingEntry
): number {
  const ae = createdAtEpoch(a.createdAt);
  const be = createdAtEpoch(b.createdAt);
  if (ae === undefined && be !== undefined) return -1;
  if (ae !== undefined && be === undefined) return 1;
  if (ae !== undefined && be !== undefined && ae !== be) return ae - be;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// Explicit "created before this deployment recorded creation times" marker
// (issue #1165 review, blocking finding 1).
//
// Used to BACKFILL a legacy stack that carries no `createdAt`. It is the epoch
// instant, so it compares lower than any real provision stamp and a backfilled
// stack keeps exactly the position absence gave it (rule 1 above), with the name
// tiebreak still separating legacy stacks from each other. Backfilling does not
// claim to know when the stack was created — it records that the creation time
// is unknown-and-early, which is the only true statement available: the config
// service stores no creation metadata of its own (ConfigObject = { key, value,
// secret? }, see the contract cited on makeHttpParamStore), so there is no
// source to recover a real instant from.
export const LEGACY_STACK_CREATED_AT = '1970-01-01T00:00:00.000Z';

// True when a stamp is the legacy backfill marker rather than a real creation
// instant. Callers that want to distinguish "created early" from "creation time
// unknown" (diagnostics, operator tooling) use this instead of string equality.
export function isLegacyCreatedAt(createdAt?: string): boolean {
  return createdAtEpoch(createdAt) === 0;
}

// The operator-pinned default stack (issue #1165 review, blocking finding 1).
//
// DEFAULT_STACK_NAME names the stack that must be element 0 of the listing, and
// therefore the stack a request with no X-Stack-Name header is routed to. It
// exists because ordering alone cannot preserve the default for a deployment
// that already had SEVERAL unstamped stacks before creation times were recorded
// — there is no stored instant to reconstruct their original order from. Pinning
// is an explicit operator statement, so it needs no inference.
//
// Config via env var, 12-factor; unset/blank means "no pin, use creation order".
// Trimmed because a trailing newline in a deployment's env block is a common and
// otherwise silent way for the pin to stop matching a stack name.
export function resolvePinnedStackName(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const raw = env['DEFAULT_STACK_NAME'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Order a listing with compareStackCreationOrder and project it to names.
// Does not mutate the input.
//
// `pinnedStackName` (DEFAULT_STACK_NAME) hoists one stack to index 0 and leaves
// every other stack in creation order behind it. A pin naming a stack that is
// NOT in the listing is ignored rather than fabricating an entry: the stack may
// be deprovisioned or not yet provisioned, and dropping the pin silently is
// wrong in the other direction only if it changes the order, which it cannot.
export function orderStackNamesByCreation(
  entries: StackListingEntry[],
  pinnedStackName?: string
): string[] {
  const ordered = [...entries].sort(compareStackCreationOrder).map((e) => e.name);
  if (pinnedStackName === undefined) return ordered;
  const pinnedIndex = ordered.indexOf(pinnedStackName);
  if (pinnedIndex <= 0) return ordered;
  return [
    pinnedStackName,
    ...ordered.slice(0, pinnedIndex),
    ...ordered.slice(pinnedIndex + 1)
  ];
}

// Read the `createdAt` off a raw stored config value, for ordering purposes
// only. Returns undefined for anything that is not JSON carrying a string
// `createdAt` — an unparseable value simply orders as a legacy (unstamped)
// stack, which is the safe direction: it never promotes an unknown record ahead
// of an established default by accident, because the name tiebreak still
// applies.
export function createdAtFromStoredValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const createdAt = (parsed as Record<string, unknown>)['createdAt'];
  return typeof createdAt === 'string' ? createdAt : undefined;
}

// Key under which a stack's config blob is stored. Namespaced by workspace so
// two tenants may use the same stack name without collision, and prefixed with
// `openvideocore/` so open-videocore keys are distinguishable from any other
// consumer of a shared store.
export function stackConfigKey(workspaceId: string, name: string): string {
  return `openvideocore/${workspaceId}/${name}`;
}

// Strip any embedded userinfo (user:password@) from a URL-shaped connection
// string, leaving scheme://host[:port][/path]. Used to guarantee that no
// password is ever persisted. Non-URL strings are returned unchanged.
export function stripCredentials(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    // Not a parseable URL — fall back to a regex strip of a userinfo segment.
    return connectionString.replace(/(^[a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
  }
}

// True if a connection string carries embedded userinfo (user[:password]@).
// Distinct from stripCredentials' round-trip — that also normalises the URL
// (e.g. adds a trailing slash), which is not a credential leak.
export function hasCredentials(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return url.username !== '' || url.password !== '';
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^@/]*@/i.test(connectionString);
  }
}

// Defensive assertion: throw if any value in the config still carries an
// embedded credential. Called before writing so a regression upstream cannot
// silently leak a password into the store.
function assertNoCredentials(config: StackConfig): void {
  for (const key of [
    'couchdbUrl',
    'redisUrl',
    'minioEndpoint'
  ] as const) {
    if (hasCredentials(config[key])) {
      throw new Error(
        `refusing to store credential-bearing value for "${key}" in the parameter store`
      );
    }
  }

  // Defence-in-depth for the storage backend metadata (issue #211): the
  // StorageBackendConfig type intentionally has no secret fields, but a
  // regression upstream could spread a raw request block (which DOES carry
  // accessKeyId/secretAccessKey/sessionToken) into it. Reject any such key so a
  // credential can never reach the store, and strip userinfo from endpointUrl.
  if (config.storage) {
    const SECRET_KEYS = ['accessKeyId', 'secretAccessKey', 'sessionToken'];
    for (const role of ['source', 'packaged'] as const) {
      const block = config.storage[role] as Record<string, unknown>;
      for (const secretKey of SECRET_KEYS) {
        if (secretKey in block) {
          throw new Error(
            `refusing to store secret field "${secretKey}" for storage role "${role}" in the parameter store`
          );
        }
      }
      if (
        typeof block['endpointUrl'] === 'string' &&
        hasCredentials(block['endpointUrl'])
      ) {
        throw new Error(
          `refusing to store credential-bearing endpointUrl for storage role "${role}" in the parameter store`
        );
      }
    }
  }
}

// Minimal structured logger surface, compatible with Fastify's / pino's
// `log.level(obj, msg)` shape (mirrors DispatcherLogger in
// webhook-dispatcher.ts and TamsConfigLogger in tams/tams-config.ts). Injected
// so both the read/write-path diagnostics (issue #415, info/warn) and the retry
// attempts (issue #421, debug/warn/error) are observable without coupling to a
// concrete logger. ALL methods are optional so a caller/test can wire only the
// levels it cares about (e.g. `{ debug }`); the client fills the gaps with a
// no-op via the resolved logger below.
export type ParamStoreLogger = {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
};

// Back-compat alias for the issue #415 diagnostic-logger name still referenced
// by callers (e.g. paramStoreFromEnv). Same shape as ParamStoreLogger.
export type ParamStoreDiagLog = ParamStoreLogger;

// A fully-populated logger the client can call unconditionally: every method is
// present so the issue #415 diagnostic call sites (diag.info/diag.warn) and the
// issue #421 retry call sites (diag.debug/diag.error) never guard for undefined.
type ResolvedParamStoreLogger = Required<ParamStoreLogger>;

// Tuning knobs for the bounded retry-with-backoff around the param-store HTTP
// round-trip (issue #421). Defaults are conservative so a request-scoped
// preHandler resolve cannot hang: at most RETRY attempts and RETRY_MAX_ELAPSED
// wall-clock across all of them, jittered exponential backoff between tries.
export type ParamStoreRetryConfig = {
  // Total number of attempts including the first (so `3` = 1 try + 2 retries).
  attempts?: number;
  // Base backoff in ms; delay grows exponentially: base * 2^(attempt-1).
  baseDelayMs?: number;
  // Hard cap on any single backoff delay.
  maxDelayMs?: number;
  // Hard cap on total wall-clock spent across all attempts+backoffs. Once this
  // budget is exhausted we stop retrying even if attempts remain, so a
  // preHandler cannot hang beyond it.
  maxElapsedMs?: number;
};

export type HttpParamStoreConfig = {
  // Base URL of the eyevinn-app-config-svc instance, resolved at runtime from
  // PARAMETER_STORE_INSTANCE_NAME via the OSC SDK (getInstance().url).
  baseUrl: string;
  // ConfigApiKey set on the eyevinn-app-config-svc instance (PARAMETER_STORE_API_KEY).
  apiKey: string;
  // OSC service access token for the eyevinn-app-config-svc service. Required
  // by OSC's reverse proxy (Authorization: Bearer). Refreshed by the caller.
  getOscToken: () => Promise<string>;
  // Injectable fetch for tests; defaults to global fetch.
  fetch?: typeof globalThis.fetch;
  // Per-request timeout in milliseconds. All external OSC calls must be bounded.
  timeoutMs?: number;
  // OPTIONAL logger. Carries the issue #415 read/write-path diagnostics
  // (info/warn: the EXACT key written and the EXACT key read, plus the outcome,
  // so a write-vs-read mismatch in the self-provisioning flow is determinable
  // from the logs) AND the issue #421 retry observability (debug per retry, warn
  // on non-retryable, error on exhaustion). Defaults to a no-op: no behaviour
  // change when unset.
  log?: ParamStoreLogger;
  // Optional retry tuning (issue #421). Omitted keys fall back to DEFAULT_RETRY.
  retry?: ParamStoreRetryConfig;
  // Injectable sleep for tests, so backoff waits can be advanced deterministically
  // without real timers. Defaults to a real setTimeout-based delay.
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 10_000;

// Retry defaults (issue #421). 3 attempts total (1 + 2 retries), exponential
// backoff from 100ms capped at 2s per wait, and a 6s total wall-clock budget so
// the whole retry loop stays well under a reasonable preHandler timeout.
const DEFAULT_RETRY: Required<ParamStoreRetryConfig> = {
  attempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  maxElapsedMs: 6_000
};

// Marker error thrown when the param-store returns a definitive HTTP status
// that must NOT be retried (4xx auth/config). Carries the status so callers can
// still surface a precise message. Retryable 5xx are thrown as plain errors.
export class NonRetryableParamStoreError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'NonRetryableParamStoreError';
    this.status = status;
  }
}

// Classify a thrown failure as retryable. Retryable: network/timeout/TLS blips
// (fetch rejects: AbortError from the timeout, ECONNRESET, self-signed-cert /
// TLS errors) and server-side 5xx. Non-retryable: 4xx auth/config, signalled by
// NonRetryableParamStoreError, which must never be retried (a hard auth failure
// will not self-correct and retrying only delays the caller). Unknown thrown
// values default to retryable — a transient blip is the more likely cause of an
// unexpected rejection than a permanent condition, and the attempt cap bounds it.
function isRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableParamStoreError) return false;
  return true;
}

// Full-jitter exponential backoff: pick a random delay in [0, capped-exp) so
// concurrent callers do not synchronise their retries (thundering herd).
function backoffDelay(attempt: number, cfg: Required<ParamStoreRetryConfig>): number {
  const exp = cfg.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exp, cfg.maxDelayMs);
  return Math.floor(Math.random() * capped);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Page size requested from the config service's list endpoint, and the ONLY
// bound on how much of the key space a single list call can observe.
//
// 100 is not an arbitrary choice: it is the schema maximum the service enforces
// on `limit`. Contract verified (CLAUDE.md rule 7) against the service's own
// source — Eyevinn/app-config-svc, `src/api_config.ts` on `main`
// (commit c1538c0e88), route `GET /config` registered under the `/api/v1`
// prefix:
//
//   PageQuery = Type.Object({
//     match:  Type.Optional(Type.String()),
//     offset: Type.Optional(Type.Number({ minimum: 0 })),
//     limit:  Type.Optional(Type.Number({ minimum: 1, maximum: 100 }))   // ← cap
//   })
//   ConfigObjectList = { offset: number; limit: number; total: number;
//                        items: ConfigObject[]; skippedKeys?: number }
//   ConfigObject     = { key: string; value: string; secret?: boolean }
//
// Requesting more than 100 is rejected by schema validation, so a store holding
// more than 100 keys CANNOT be enumerated by one call. The service does accept
// an `offset`, so a paginating consumer is possible — this client does not
// paginate today, which is why every caller of a list method must treat a full
// page as "possibly truncated". See
// docs/osc-feedback/incoming-issue804-config-svc-list-pagination.md.
export const CONFIG_LIST_PAGE_LIMIT = 100 as const;

// HTTP-backed parameter store client for eyevinn-app-config-svc.
//
// SMOKE TEST CONFIRMED (2026-06-01) — real API contract:
//   POST   /api/v1/config          { key, value }  → 200 { key, value }  (create or overwrite)
//   GET    /api/v1/config/{key}    →  200 { key, value } | 404 { reason }
//   PUT    /api/v1/config/{key}    { value }        → 200 { key, value } | 404
//   DELETE /api/v1/config/{key}    → 200 { message } | 404 { reason }
//
// Auth: OSC SAT in `Authorization: Bearer <sat>` (reverse proxy) +
//       `x-api-key: <ConfigApiKey>` (app layer).
//
// Keys containing `/` are encoded with encodeURIComponent so the
// `openvideocore/<workspaceId>/<name>` namespace survives as a single segment.
export function makeHttpParamStore(config: HttpParamStoreConfig): ParamStore {
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = config.baseUrl.replace(/\/$/, '');
  // Single resolved logger used for BOTH the issue #415 read/write-path
  // diagnostics (diag.info/diag.warn) and the issue #421 retry observability
  // (diag.debug/diag.error). Each supplied method overrides the corresponding
  // no-op, so a caller that wires only some levels (e.g. `{ debug }`) still lets
  // the client call every method unconditionally. Defaults to the full no-op
  // when no logger is supplied.
  // Call THROUGH the supplied logger rather than spreading it (issue #438).
  // Spreading a live pino instance copies its per-level methods as detached
  // function references; pino's internal LOG then throws because `this[writeSym]`
  // is undefined off the instance, masking the real failure. Invoking src?.<level>
  // keeps `this` bound to the source logger, and the optional chaining preserves
  // the no-op-when-unset semantics the client relies on per method.
  const src = config.log;
  const diag: ResolvedParamStoreLogger = {
    info: (obj, msg) => src?.info?.(obj, msg),
    warn: (obj, msg) => src?.warn?.(obj, msg),
    debug: (obj, msg) => src?.debug?.(obj, msg),
    error: (obj, msg) => src?.error?.(obj, msg)
  };
  const sleep = config.sleep ?? realSleep;
  const retry: Required<ParamStoreRetryConfig> = {
    ...DEFAULT_RETRY,
    ...config.retry
  };

  function configUrl(key?: string): string {
    const path = key ? `/${encodeURIComponent(key)}` : '';
    return `${base}/api/v1/config${path}`;
  }

  async function withTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  // Bounded retry-with-backoff around a single param-store round-trip (issue
  // #421). `op` runs one full attempt (headers + fetch + status handling) and
  // either resolves, throws a retryable error (network/timeout/TLS/5xx), or
  // throws a NonRetryableParamStoreError (4xx). We retry retryable failures with
  // full-jitter exponential backoff up to `attempts` tries AND `maxElapsedMs`
  // wall-clock, whichever comes first. On exhaustion the last error propagates
  // to the caller (workspace-stack resolve()'s catch, where issue #420's
  // last-known-good fallback then takes over) rather than being swallowed here.
  async function withRetry<T>(label: string, op: () => Promise<T>): Promise<T> {
    const start = Date.now();
    let lastErr: unknown;
    for (let attempt = 1; attempt <= retry.attempts; attempt++) {
      try {
        return await op();
      } catch (err) {
        lastErr = err;
        const elapsed = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        if (!isRetryable(err)) {
          diag.warn(
            { op: label, attempt, elapsedMs: elapsed, error: message },
            'param-store call failed with a non-retryable error; not retrying'
          );
          throw err;
        }
        const isLastAttempt = attempt >= retry.attempts;
        // Compute the next backoff, but never sleep past the wall-clock budget.
        const delay = backoffDelay(attempt, retry);
        const budgetExhausted = elapsed + delay >= retry.maxElapsedMs;
        if (isLastAttempt || budgetExhausted) {
          diag.error(
            {
              op: label,
              attempt,
              attempts: retry.attempts,
              elapsedMs: elapsed,
              error: message
            },
            'param-store call exhausted retries; handing off to fallback'
          );
          throw err;
        }
        diag.debug(
          { op: label, attempt, nextDelayMs: delay, elapsedMs: elapsed, error: message },
          'param-store call failed; retrying after backoff'
        );
        await sleep(delay);
      }
    }
    // Unreachable: the loop always returns or throws, but satisfy the type checker.
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async function buildHeaders(): Promise<Record<string, string>> {
    const sat = await config.getOscToken();
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${sat}`,
      'x-api-key': config.apiKey
    };
  }

  return {
    async storeStackConfig(workspaceId, name, stackConfig) {
      assertNoCredentials(stackConfig);
      const key = stackConfigKey(workspaceId, name);
      const value = JSON.stringify(stackConfig);
      // POST creates or overwrites — confirmed idempotent in smoke test.
      const h = await buildHeaders();
      const res = await withTimeout((signal) =>
        doFetch(configUrl(), {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ key, value }),
          signal
        })
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // WRITE-PATH diagnostic (issue #415): the exact key we attempted to
        // write and the store's rejection. If this fires, the config never
        // reached the store — the defect is on the write side.
        diag.warn(
          { op: 'storeStackConfig', workspaceId, name, key, status: res.status },
          'param-store write failed'
        );
        throw new Error(`parameter store write failed: ${res.status} ${text}`.trim());
      }
      // WRITE-PATH diagnostic (issue #415): records the EXACT key persisted so it
      // can be compared byte-for-byte against the key a later read derives. A
      // written key that no read ever matches pins the defect to the read side.
      diag.info(
        { op: 'storeStackConfig', workspaceId, name, key, status: res.status },
        'param-store write ok'
      );
    },

    async loadStackConfig(workspaceId, name) {
      const key = stackConfigKey(workspaceId, name);
      // Wrap the read round-trip in bounded retry-with-backoff (issue #421) and
      // thread the issue #415 read-path diagnostics through inside the op so a
      // spurious miss / key mismatch is still logged on the attempt that
      // resolves. 4xx/malformed-value throw NonRetryableParamStoreError so the
      // retry loop stops immediately; 5xx/network/timeout are retried.
      return withRetry('loadStackConfig', async () => {
        const h = await buildHeaders();
        const res = await withTimeout((signal) =>
          doFetch(configUrl(key), { method: 'GET', headers: h, signal })
        );
        if (res.status === 404) {
          // READ-PATH diagnostic (issue #415): the EXACT key we looked up
          // returned a miss. Compare this key to the 'param-store write ok' key
          // for the same stack: if the store logged a successful write of THIS
          // key, the value is present and the miss is spurious; if the written
          // key DIFFERS (e.g. a namespace / stack-name mismatch), the defect is a
          // read-side key derivation bug — not a failed write.
          diag.warn(
            { op: 'loadStackConfig', workspaceId, name, key, status: 404 },
            'param-store read miss'
          );
          return undefined;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const msg = `parameter store read failed: ${res.status} ${text}`.trim();
          diag.warn(
            { op: 'loadStackConfig', workspaceId, name, key, status: res.status },
            'param-store read failed'
          );
          // 4xx (auth/config) will not self-correct — do not retry (issue #421).
          if (res.status >= 400 && res.status < 500) {
            throw new NonRetryableParamStoreError(msg, res.status);
          }
          throw new Error(msg);
        }
        const body = (await res.json().catch(() => ({}))) as { value?: string };
        if (typeof body.value !== 'string' || body.value.length === 0) {
          // READ-PATH diagnostic (issue #415): the key resolved (200) but carried
          // no value — a stored-empty / partial-write signature distinct from a
          // key mismatch (which would 404 above).
          diag.warn(
            { op: 'loadStackConfig', workspaceId, name, key, status: res.status, empty: true },
            'param-store read returned empty value'
          );
          return undefined;
        }
        // READ-PATH diagnostic (issue #415): the EXACT key that resolved to a
        // stored config. A hit here for the same key the write logged confirms
        // the round-trip works and moves the investigation elsewhere.
        diag.info(
          { op: 'loadStackConfig', workspaceId, name, key, status: res.status },
          'param-store read hit'
        );
        try {
          return JSON.parse(body.value) as StackConfig;
        } catch {
          // A malformed stored value is not a transient blip — do not retry.
          throw new NonRetryableParamStoreError(
            `parameter store value for "${key}" is not valid JSON`,
            200
          );
        }
      });
    },

    async deleteStackConfig(workspaceId, name) {
      const key = stackConfigKey(workspaceId, name);
      const h = await buildHeaders();
      const res = await withTimeout((signal) =>
        doFetch(configUrl(key), { method: 'DELETE', headers: h, signal })
      );
      // 404 = already gone — idempotent success.
      if (res.status === 404 || res.ok) return;
      const text = await res.text().catch(() => '');
      throw new Error(`parameter store delete failed: ${res.status} ${text}`.trim());
    },

    async listStackNames(workspaceId) {
      const prefix = `openvideocore/${workspaceId}/`;
      // The app-config-svc list endpoint returns { offset, limit, total, items }
      // (ConfigObjectList). CONFIG_LIST_PAGE_LIMIT is the schema maximum for
      // `limit`, so this single page is also the most one call can observe; a
      // store holding more keys than that is silently truncated here.
      // This GET is the stack-resolver refresh round-trip (issue #421): wrap it
      // in bounded retry-with-backoff so a boot-time TLS blip or timeout does not
      // turn into a full storage outage for the instance.
      return withRetry('listStackNames', async () => {
        const h = await buildHeaders();
        const res = await withTimeout((signal) =>
          doFetch(`${base}/api/v1/config?limit=${CONFIG_LIST_PAGE_LIMIT}`, { method: 'GET', headers: h, signal })
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const msg = `parameter store list failed: ${res.status} ${text}`.trim();
          // 4xx (auth/config) will not self-correct — do not retry (issue #421).
          if (res.status >= 400 && res.status < 500) {
            throw new NonRetryableParamStoreError(msg, res.status);
          }
          throw new Error(msg);
        }
        // `items` carries the VALUE alongside the key — ConfigObject =
        // { key: string; value: string; secret?: boolean } (contract cited on
        // CONFIG_LIST_PAGE_LIMIT, verified against Eyevinn/app-config-svc
        // src/api_config.ts @ c1538c0e88). So the `createdAt` that orders the
        // listing (issue #1165) comes out of THIS SAME page: ordering costs no
        // extra round-trip and adds no per-stack GET.
        const body = (await res.json()) as {
          items?: { key: string; value?: string }[];
        };
        // The service specifies NO order on `items`, which is the whole of
        // #1165: taking its order through meant the first-listed stack — the
        // no-X-Stack-Name default — changed whenever a stack was added, and a
        // new stack could land in the middle. Impose the creation order
        // explicitly instead, with DEFAULT_STACK_NAME overriding it when an
        // operator has pinned the default (read per call, not captured at
        // construction, so the pin applies to an already-built store).
        return orderStackNamesByCreation(
          (body.items ?? [])
            .filter((item) => item.key.startsWith(prefix))
            .map((item) => ({
              name: item.key.slice(prefix.length),
              createdAt: createdAtFromStoredValue(item.value)
            })),
          resolvePinnedStackName()
        );
      });
    }
  };
}

// Generic namespaced key/value view over the SAME eyevinn-app-config-svc HTTP
// contract makeHttpParamStore uses (issue #547). The storage-backend registry
// (ADR-017 D1.3: "only the non-secret registration record is persisted to the
// parameter store") needs to persist arbitrary non-secret JSON records keyed by
// workspace, distinct from the per-stack StackConfig blobs. This narrow store
// exposes exactly get/set/delete/list over the config service's REST surface,
// reusing the verified smoke-tested contract documented on makeHttpParamStore:
//   POST   /api/v1/config          { key, value }  → 200
//   GET    /api/v1/config/{key}    → 200 { key, value } | 404
//   DELETE /api/v1/config/{key}    → 200 | 404
//   GET    /api/v1/config?limit=N  → 200 { offset, limit, total, items: [{ key, value }] }
// SECURITY: callers MUST NOT write secret material here — same discipline as the
// StackConfig path (assertNoCredentials). The registry writes only non-secret
// records; the access key + secret go to OSC secrets via saveSecret.
export interface ConfigKvStore {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
  // List { key, value } pairs whose key begins with `prefix`.
  //
  // BOUNDED, NOT EXHAUSTIVE. The implementation fetches a single page of at
  // most CONFIG_LIST_PAGE_LIMIT entries (the service's schema maximum for
  // `limit`) and filters by prefix client-side, so the result is a subset, not
  // a guaranteed-complete enumeration. Callers that draw a conclusion from an
  // EMPTY result ("nothing matches") must account for truncation: a returned
  // count equal to CONFIG_LIST_PAGE_LIMIT means the page was full and matches
  // may have been cut off. See scanStaleNamespacedStacks in workspace-stack.ts.
  listByPrefix(prefix: string): Promise<Array<{ key: string; value: string }>>;
}

// Build a ConfigKvStore over the same HTTP config service. Shares the auth +
// timeout conventions of makeHttpParamStore; kept as a separate small factory so
// the widely-used ParamStore interface stays unchanged.
export function makeHttpConfigKvStore(config: HttpParamStoreConfig): ConfigKvStore {
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = config.baseUrl.replace(/\/$/, '');

  function configUrl(key?: string): string {
    const path = key ? `/${encodeURIComponent(key)}` : '';
    return `${base}/api/v1/config${path}`;
  }

  async function buildHeaders(): Promise<Record<string, string>> {
    const sat = await config.getOscToken();
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${sat}`,
      'x-api-key': config.apiKey
    };
  }

  async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async set(key, value) {
      const h = await buildHeaders();
      const res = await withTimeout((signal) =>
        doFetch(configUrl(), {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ key, value }),
          signal
        })
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`config kv write failed: ${res.status} ${text}`.trim());
      }
    },

    async get(key) {
      const h = await buildHeaders();
      const res = await withTimeout((signal) =>
        doFetch(configUrl(key), { method: 'GET', headers: h, signal })
      );
      if (res.status === 404) return undefined;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`config kv read failed: ${res.status} ${text}`.trim());
      }
      const body = (await res.json().catch(() => ({}))) as { value?: string };
      return typeof body.value === 'string' ? body.value : undefined;
    },

    async delete(key) {
      const h = await buildHeaders();
      const res = await withTimeout((signal) =>
        doFetch(configUrl(key), { method: 'DELETE', headers: h, signal })
      );
      // 404 = already gone — idempotent success (mirrors deleteStackConfig).
      if (res.status === 404 || res.ok) return;
      const text = await res.text().catch(() => '');
      throw new Error(`config kv delete failed: ${res.status} ${text}`.trim());
    },

    async listByPrefix(prefix) {
      const h = await buildHeaders();
      const res = await withTimeout((signal) =>
        doFetch(`${base}/api/v1/config?limit=${CONFIG_LIST_PAGE_LIMIT}`, { method: 'GET', headers: h, signal })
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`config kv list failed: ${res.status} ${text}`.trim());
      }
      const body = (await res.json()) as { items?: Array<{ key: string; value?: string }> };
      return (body.items ?? [])
        .filter((item) => item.key.startsWith(prefix) && typeof item.value === 'string')
        .map((item) => ({ key: item.key, value: item.value as string }));
    }
  };
}

// ---------------------------------------------------------------------------
// Scaler runtime config (issue #1077 — write side; issue #1078 — boot read side)
// ---------------------------------------------------------------------------
//
// PATCH /api/v1/scaler/config used to mutate only module-scope values in
// routes/scaler.ts, so an operator's change was lost on the next restart. The
// values are now persisted here, and this block is the CONTRACT the boot-load
// side (#1078) reads. Do not change the key or the value shape without changing
// both sides.
//
// SCOPE: instance-global, NOT per-stack and NOT per-workspace. The scaler pool
// ceiling/idle timeout are deployment-wide (main.ts reads them once from
// ENCORE_MAX_INSTANCES / ENCORE_IDLE_TIMEOUT_MS at main.ts:887,897 and the
// WorkspaceEncoreScalerRegistry applies them across every workspace via
// setMaxInstances/setIdleTimeoutMs), and the scaler config route is deliberately
// unauthenticated — it has no workspace or stack name in scope. They are
// therefore NOT fields on StackConfig (which is keyed per workspace+stack by
// stackConfigKey) but one dedicated key, written through the same
// eyevinn-app-config-svc HTTP contract via ConfigKvStore.
//
// KEY: `openvideocore/scalerconfig` — ONE segment after the shared
// `openvideocore/` prefix. That is deliberate: the stale-namespace scan in
// services/workspace-stack.ts (scanStaleNamespacedStacks, `segments.length !== 2`)
// only considers two-segment keys as candidate stack configs, so a single-segment
// key can never be mistaken for one and needs no entry in
// RESERVED_KEY_SEGMENTS.
//
// VALUE: a JSON object carrying ALL THREE fields, always written as a complete
// snapshot (never a partial patch), so one read yields a complete config:
//   {"maxInstances":3,"minInstances":0,"idleTimeoutMs":300000}
// Non-secret by construction: three integers, no credentials, nothing
// workspace-identifying.
export const SCALER_CONFIG_KEY = 'openvideocore/scalerconfig' as const;

// The persisted scaler runtime config. Every field is REQUIRED in the stored
// blob — the writer always sends a full snapshot (see SCALER_CONFIG_KEY), so the
// reader never has to merge a partial record.
export type ScalerRuntimeConfig = {
  // Upper bound on Encore instances per workspace pool.
  maxInstances: number;
  // Instances kept warm (0 = scale to zero when idle).
  minInstances: number;
  // Idle time in ms before an idle instance is torn down.
  idleTimeoutMs: number;
};

// The authoritative range of each scaler config field, in ONE place so the
// three readers of it cannot drift:
//   - routes/scaler.ts `scalerConfigSchema` — request validation (400) AND, via
//     `scalerConfigResponseSchema`, the 200 response schema of GET/PATCH
//     /api/v1/scaler/config, so a value outside these bounds cannot be
//     SERIALIZED either: it fails response validation (500).
//   - services/scaler-boot-config.ts `resolveScalerBootConfig` — clamps a
//     persisted record into these bounds at boot (#1078 review finding 8), so a
//     record written under older/looser bounds cannot make the config endpoint
//     unserializable or push the scaler loops past the documented ceiling.
//   - this file's `parseScalerRuntimeConfig`, which deliberately does NOT apply
//     them (see below).
export const SCALER_CONFIG_BOUNDS = {
  maxInstances: { min: 1, max: 20 },
  minInstances: { min: 0, max: 10 },
  // Lower bound only: a near-zero idle timeout thrashes the spawn/destroy cycle.
  idleTimeoutMs: { min: 10_000 }
} as const;

// Parse a stored scaler-config blob, returning undefined for anything that is
// not a usable config so a caller (boot load, #1078) can fall back to its env
// defaults instead of throwing.
//
// The check is STRUCTURAL plus a minimal sanity floor, NOT the full range check
// in SCALER_CONFIG_BOUNDS above, which is applied at WRITE time by the route.
// Re-applying the full range here would mean that tightening a bound later
// silently discards a previously-valid persisted value at boot — so the reader
// only rejects values that are not usable integers at all, and the boot path
// CLAMPS what it reads into the bounds (resolveScalerBootConfig) instead of
// dropping the whole record.
export function parseScalerRuntimeConfig(raw: string): ScalerRuntimeConfig | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const asInt = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) ? value : undefined;
  const maxInstances = asInt(record['maxInstances']);
  const minInstances = asInt(record['minInstances']);
  const idleTimeoutMs = asInt(record['idleTimeoutMs']);
  if (maxInstances === undefined || minInstances === undefined || idleTimeoutMs === undefined) {
    return undefined;
  }
  // Sanity floor only: a pool cap below 1 could never run a job, and negative
  // warm-instance / idle values are nonsense rather than policy.
  if (maxInstances < 1 || minInstances < 0 || idleTimeoutMs < 0) return undefined;
  return { maxInstances, minInstances, idleTimeoutMs };
}

// Durable store for the instance-global scaler runtime config. Narrow on
// purpose: the PATCH route only needs `save`, and the boot path (#1078) only
// needs `load`, so each side can be tested with a one-method stub.
export interface ScalerConfigStore {
  // Persist a COMPLETE config snapshot. Rejects (throws) when the write did not
  // land durably — the PATCH route turns that into a non-2xx and leaves the live
  // values untouched, so the API never reports a value it did not persist.
  save(config: ScalerRuntimeConfig): Promise<void>;
  // Read the persisted config, or undefined when nothing is stored (or the
  // stored blob is unusable — see parseScalerRuntimeConfig).
  load(): Promise<ScalerRuntimeConfig | undefined>;
}

// Build a ScalerConfigStore over the generic ConfigKvStore (same
// eyevinn-app-config-svc HTTP contract as every other persisted record). Mirrors
// the ParamStoreBackendRecordStore idiom in services/storage-backend-registry.ts
// (`this.kv.set(key, JSON.stringify(record))`): a JSON blob under one key, and a
// failed write propagates as a thrown error from ConfigKvStore.set
// (param-store.ts `config kv write failed: <status> <body>`).
export function makeScalerConfigStore(kv: ConfigKvStore): ScalerConfigStore {
  return {
    async save(config) {
      // Normalised to exactly the three contract fields so no extra key can
      // leak into the stored blob from a caller's wider object.
      const snapshot: ScalerRuntimeConfig = {
        maxInstances: config.maxInstances,
        minInstances: config.minInstances,
        idleTimeoutMs: config.idleTimeoutMs
      };
      await kv.set(SCALER_CONFIG_KEY, JSON.stringify(snapshot));
    },
    async load() {
      const raw = await kv.get(SCALER_CONFIG_KEY);
      if (!raw) return undefined;
      return parseScalerRuntimeConfig(raw);
    }
  };
}

export const PARAM_STORE_SERVICE_ID = 'eyevinn-app-config-svc' as const;

// OSC instance name must be alphanumeric-only (OSC constraint).
const DEFAULT_PARAM_STORE_INSTANCE_NAME = 'ovcconfig';

// Resolve the eyevinn-app-config-svc instance's public URL from its name via
// the OSC SDK. Contract (node_modules/@osaas/client-core/lib/core.d.ts:56):
//   getInstance(context, serviceId, name, token): Promise<any>  → { url }
// This is the same pattern the provision route uses (routes/provision.ts:150,
// instanceUrl). We never hardcode the OSC URL scheme.
export interface ParamStoreUrlResolver {
  getServiceAccessToken(serviceId: string): Promise<string>;
  getInstance(
    serviceId: string,
    name: string,
    sat: string
  ): Promise<{ url?: string } | undefined>;
}

// Module-level in-memory cache of the resolved base URL, keyed by instance
// name, so we resolve it once at startup rather than on every request.
const resolvedBaseUrlCache = new Map<string, string>();

async function resolveParamStoreBaseUrl(
  resolver: ParamStoreUrlResolver,
  instanceName: string
): Promise<string | undefined> {
  const cached = resolvedBaseUrlCache.get(instanceName);
  if (cached) return cached;
  const sat = await resolver.getServiceAccessToken(PARAM_STORE_SERVICE_ID);
  const instance = await resolver.getInstance(
    PARAM_STORE_SERVICE_ID,
    instanceName,
    sat
  );
  const url = instance?.url;
  if (typeof url !== 'string' || url.length === 0) return undefined;
  resolvedBaseUrlCache.set(instanceName, url);
  return url;
}

// Build a ParamStore from the environment. Requires PARAMETER_STORE_API_KEY;
// the base URL is resolved at runtime from PARAMETER_STORE_INSTANCE_NAME (or
// the default) via the OSC SDK and cached in memory. Returns undefined when
// unconfigured or when the instance URL cannot be resolved (provision route
// will surface a 501).
export async function paramStoreFromEnv(
  resolver: ParamStoreUrlResolver,
  getOscToken: () => Promise<string>,
  // OPTIONAL diagnostic logger (issue #415). Threaded into the HTTP client so
  // production emits the exact written/read key pairs used to determine whether
  // a StackConfig persistence failure is on the write or read path. Optional so
  // existing callers/tests are unaffected (defaults to the client's no-op).
  log?: ParamStoreDiagLog
): Promise<ParamStore | undefined> {
  const apiKey = process.env['PARAMETER_STORE_API_KEY'];
  if (!apiKey) return undefined;
  const instanceName =
    process.env['PARAMETER_STORE_INSTANCE_NAME'] ??
    DEFAULT_PARAM_STORE_INSTANCE_NAME;
  const baseUrl = await resolveParamStoreBaseUrl(resolver, instanceName);
  if (!baseUrl) return undefined;
  return makeHttpParamStore({ baseUrl, apiKey, getOscToken, ...(log ? { log } : {}) });
}

// Build a generic ConfigKvStore from the environment, resolving the same
// eyevinn-app-config-svc instance paramStoreFromEnv uses (issue #547). Returns
// undefined when the store is unconfigured or the instance URL is unresolvable,
// exactly like paramStoreFromEnv — callers then fall back to the in-memory store
// (or surface a 501).
export async function configKvStoreFromEnv(
  resolver: ParamStoreUrlResolver,
  getOscToken: () => Promise<string>
): Promise<ConfigKvStore | undefined> {
  const apiKey = process.env['PARAMETER_STORE_API_KEY'];
  if (!apiKey) return undefined;
  const instanceName =
    process.env['PARAMETER_STORE_INSTANCE_NAME'] ??
    DEFAULT_PARAM_STORE_INSTANCE_NAME;
  const baseUrl = await resolveParamStoreBaseUrl(resolver, instanceName);
  if (!baseUrl) return undefined;
  return makeHttpConfigKvStore({ baseUrl, apiKey, getOscToken });
}

const VALKEY_SERVICE_ID = 'valkey-io-valkey';

export interface OscInstanceApi {
  getServiceAccessToken(serviceId: string): Promise<string>;
  getInstance(
    serviceId: string,
    name: string,
    sat: string
  ): Promise<{ name?: string } | undefined>;
  createInstance(
    serviceId: string,
    sat: string,
    body: Record<string, unknown>
  ): Promise<{ name?: string }>;
  // Readiness wait for an instance this module just created. NOT
  // @osaas/client-core's waitForInstanceReady: main.ts fulfils this with the
  // bounded waitForInstanceReadyBounded (src/services/instance-readiness.ts,
  // issue #1055), so a Valkey that never reports `running` gives up at a
  // deadline instead of hanging the startup bootstrap forever. The rejection is
  // caught by the warn-and-continue handler at the end of ensureParameterStore.
  waitForInstanceReady(serviceId: string, name: string): Promise<void>;
  getPortsForInstance(
    serviceId: string,
    name: string,
    sat: string
  ): Promise<Array<{ externalIp: string; externalPort: number; internalPort: number }>>;
}

export type EnsureParameterStoreOptions = {
  osc: OscInstanceApi;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
};

// Idempotently ensure the eyevinn-app-config-svc instance exists on first
// startup (issue #35). Any OSC failure is logged as a warning and swallowed.
export async function ensureParameterStore(
  opts: EnsureParameterStoreOptions
): Promise<boolean> {
  const apiKey = process.env['PARAMETER_STORE_API_KEY'];
  if (!apiKey) return false;

  const name =
    process.env['PARAMETER_STORE_INSTANCE_NAME'] ??
    DEFAULT_PARAM_STORE_INSTANCE_NAME;

  try {
    const sat = await opts.osc.getServiceAccessToken(PARAM_STORE_SERVICE_ID);
    const existing = await opts.osc.getInstance(PARAM_STORE_SERVICE_ID, name, sat);
    if (existing) return true;

    // Provision a dedicated Valkey for the config service so it is never
    // shared with the pipeline queue. Named "${name}redis" (alphanumeric only).
    const valkeyName = `${name}redis`;
    const valkeySat = await opts.osc.getServiceAccessToken(VALKEY_SERVICE_ID);
    let valkeyPorts: Array<{ externalIp: string; externalPort: number; internalPort: number }>;
    const existingValkey = await opts.osc.getInstance(VALKEY_SERVICE_ID, valkeyName, valkeySat);
    if (existingValkey) {
      opts.log.info(`config Valkey "${valkeyName}" already exists`);
      valkeyPorts = await opts.osc.getPortsForInstance(VALKEY_SERVICE_ID, valkeyName, valkeySat);
    } else {
      await opts.osc.createInstance(VALKEY_SERVICE_ID, valkeySat, { name: valkeyName });
      opts.log.info(`config Valkey "${valkeyName}" created, waiting for ready…`);
      await opts.osc.waitForInstanceReady(VALKEY_SERVICE_ID, valkeyName);
      valkeyPorts = await opts.osc.getPortsForInstance(VALKEY_SERVICE_ID, valkeyName, valkeySat);
    }

    const port = valkeyPorts.find((p) => p.internalPort === 6379) ?? valkeyPorts[0];
    if (!port) throw new Error(`no ports returned for Valkey instance "${valkeyName}"`);
    const redisUrl = `redis://${port.externalIp}:${port.externalPort}`;

    await opts.osc.createInstance(PARAM_STORE_SERVICE_ID, sat, {
      name,
      ConfigApiKey: apiKey,
      RedisUrl: redisUrl
    });
    opts.log.info(`parameter store instance "${name}" created with dedicated Valkey`);
    return true;
  } catch (err) {
    opts.log.warn(
      `parameter store auto-bootstrap skipped: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }
}
