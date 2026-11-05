// DRM configuration admin surface (issue #1296, parent #1262).
//
//   GET /api/v1/drm/config — read the stack's non-secret DRM coordinates plus a
//     credential STATUS indicator (`credentials: 'configured' | 'missing'`).
//   PUT /api/v1/drm/config — set the non-secret coordinates (writes the
//     per-stack parameter store).
//   POST /api/v1/drm/config/test — dry-run a key request against the stored
//     coordinates with a THROWAWAY `contentId` (issue #1297), answering
//     `{ ok, systems, latencyMs, error? }` where `error` is an `errorCode`
//     enum member and nothing else.
//
// All three routes are `501 not_configured` while `DRM_ENABLED` is off
// (ADR-008 D9).
//
// CONTRACT SOURCES verified before writing a single call (CLAUDE.md rule 7).
// Every DRM behaviour below is DELEGATED to the #1295 model; nothing is
// restated or reimplemented here:
//   - ADR-008 §9 "API surface" (docs/architecture/ADR-008-drm-protection.md:366-374)
//     — the two method+path pairs, "Non-secret fields only; credential presence
//     reported as `credentials: "configured" | "missing"`, never values", and
//     "Rejects any body field that looks like a credential (`400 invalid_field`)".
//   - ADR-008 §5.2 (ADR-008-drm-protection.md:175-215) — the field list this
//     surface accepts, and "credentials ... are operator environment variables
//     and never enter the parameter store, the HTTP response, or a log line".
//   - ADR-008 D5 / D6 / D9 (lines 121, 122, 125) — credentials are env vars,
//     config is per STACK (no `workspaceId`), `DRM_ENABLED` default false.
//   - src/drm/drm-config.ts (#1295) — `drmGateClosed`,
//     `DRM_NOT_CONFIGURED_STATUS`, `DRM_NOT_CONFIGURED_PAYLOAD`,
//     `validateDrmStackConfig`, `DrmConfigValidationFailure`,
//     `loadDrmStackConfig`, `storeDrmStackConfig`, `toDrmConfigView`,
//     `DRM_PROVIDER_KINDS`, `DRM_SPEKE_VERSIONS`, `DRM_CREDENTIAL_STATUSES`,
//     `CPIX_AUTH_MODES`.
//   - src/types/drm.ts — `PROTECTION_SCHEMES`, `TRACK_TYPE_GROUPS`.
//   - src/services/workspace-stack.ts — `STACK_CONFIG_NAMESPACE` (the constant
//     deployment namespace every stack config is keyed under) and
//     `WorkspaceStackResolver.resolveStackName` (workspace-stack.ts:1251, "the
//     single source of truth for which stack does this request belong to").
//   - src/services/request-stack-context.ts — `requestStackNameFromHeaders`
//     (the validated `X-Stack-Name` boundary read).
//   - src/services/param-store.ts — `ParamStore`, and `StackConfig.drm`
//     (param-store.ts:194) plus its `assertNoDrmCredentials` write-path guard.
//   - src/auth/middleware.ts — `authGate`.
//   - Route/response-schema conventions: src/routes/export-destinations.ts
//     (notConfiguredPayload / permissive 4xx envelope) and
//     src/routes/retention.ts, src/routes/usage.ts, src/routes/scaler.ts
//     (`tags: ['admin']`, the tag declared in src/main.ts's swagger block).
//
// NO SECRET EVER CROSSES THIS SURFACE. The 200 body is built exclusively by
// `toDrmConfigView` (which projects the stored block down to the twelve
// allowlisted coordinates and appends the two-value status string), and the
// response schema below is a CLOSED `z.object` — so the serialiser strips
// anything the projection somehow let through. The handler never reads a
// credential env var itself and never echoes a submitted value in an error:
// the 400 body carries field NAMES and reasons, exactly as
// `DrmConfigValidationError` is defined.
//
// WHY THE REQUEST SCHEMA IS OPEN AND THE RESPONSE SCHEMA IS CLOSED. The
// allow-list in `validateDrmStackConfig` is the single authority on which
// fields are acceptable, and ADR-008 §9 requires a credential-shaped field to
// be answered `400 invalid_field`. A `z.object()` request body would STRIP an
// unknown key (so `clientSecret` would silently vanish instead of being
// refused) and a `.strict()` one would reject it with the serialiser's generic
// validation envelope (so the required `invalid_field` code would never be
// emitted). The body schema is therefore `.passthrough()` with deliberately
// unconstrained value types — every field-name and every enum/URL decision is
// made by the #1295 validator, which is also what the parameter-store boundary
// enforces. The RESPONSE schema is closed, which is where closure actually
// buys something: it is the boundary a secret would have to cross.

import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CPIX_AUTH_MODES,
  DRM_CREDENTIAL_STATUSES,
  DRM_NOT_CONFIGURED_PAYLOAD,
  DRM_NOT_CONFIGURED_STATUS,
  DRM_PROVIDER_KINDS,
  DRM_SPEKE_VERSIONS,
  DRM_STACK_CONFIG_FIELD_NAMES,
  DrmConfigValidationFailure,
  drmGateClosed,
  loadDrmStackConfig,
  storeDrmStackConfig,
  toDrmConfigView,
  validateDrmStackConfig,
  type DrmConfigValidationError,
  type DrmStackConfig
} from '../drm/drm-config.js';
import { CpixProvider } from '../drm/cpix-provider.js';
import { ClearKeyDevProvider } from '../drm/clearkey-dev-provider.js';
import { isKeyProviderError } from '../drm/key-provider-error.js';
import { resolveDrmSystemIds } from '../drm/key-provider.js';
import type {
  DrmSystemId,
  KeyProvider,
  KeyRequest,
  TrackTypeGroup
} from '../drm/key-provider.js';
import { DRM_STEP_DEADLINE_MS, zeroContentKeys } from '../pipeline/packaging.js';
import { DRM_ERROR_CODES, PROTECTION_SCHEMES, TRACK_TYPE_GROUPS } from '../types/drm.js';
import type { DrmErrorCode } from '../types/drm.js';
import { STACK_CONFIG_NAMESPACE } from '../services/workspace-stack.js';
import { requestStackNameFromHeaders } from '../services/request-stack-context.js';
import { authGate } from '../auth/middleware.js';
import type { ParamStore } from '../services/param-store.js';

// The minimal slice of `WorkspaceStackResolver` this router needs
// (workspace-stack.ts:1251). Declared structurally — like
// `CachedStackResolver` in request-stack-context.ts — so a unit test can drive
// the routes without constructing live CouchDB/object-store clients.
export type DrmStackNameResolver = {
  resolveStackName(requestedStackName?: string): Promise<string | undefined>;
};

export type DrmConfigRouterOptions = {
  // The per-stack parameter store (ADR-008 D5/D6: coordinates are non-secret
  // and live next to the other stack coordinates). Absent when
  // PARAMETER_STORE_API_KEY is unset — then there is nowhere to read or write a
  // DRM config, so both routes answer 501, mirroring the /storage/backends and
  // /export-destinations degradation (routes/export-destinations.ts:278-281).
  paramStore?: ParamStore;
  // Resolves WHICH stack this request addresses. Absent on a deployment with no
  // resolver wired; then no stack can be addressed and both routes answer 404.
  stackResolver?: DrmStackNameResolver;
  // Builds the #1261 client for a stored configuration, for the dry-run route
  // only (issue #1297). Injected seam: production leaves it unset and gets
  // `defaultKeyProviderFactory` below, a unit test passes a stub so no network
  // call and no credential are needed. The factory is given the NON-SECRET
  // coordinates only — the adapter reads its own credential env vars at call
  // time (cpix-provider.ts `options.env`), so no credential passes through this
  // router (ADR-008 D5).
  createKeyProvider?: DrmKeyProviderFactory;
};

export type DrmKeyProviderFactory = (config: DrmStackConfig) => KeyProvider;

// `error: 'invalid_field'` is the code ADR-008 §9 names for a rejected body
// field. Exported so a test asserts the wire value rather than a copy of it.
export const DRM_INVALID_FIELD_ERROR = 'invalid_field' as const;

// No stack to hold a DRM config (nothing provisioned), or no DRM config stored
// on the resolved stack yet. Distinct from the 501: DRM is enabled and the
// surface works — there is simply nothing there yet.
export const DRM_CONFIG_NOT_FOUND_ERROR = 'not_found' as const;

const errorSchema = z.object({ error: z.string(), message: z.string() });

// The 400 body: the ADR-008 §9 code plus the field names and reasons
// `validateDrmStackConfig` returned. NEVER a submitted value (ADR-008 §10).
//
// Kept permissive (`.passthrough()`, optional members) for the same reason
// routes/export-destinations.ts:161-173 keeps its 400 permissive: the
// serialiser must also be able to emit the generic request-validation envelope
// fastify-type-provider-zod mints for a body that is not an object at all,
// otherwise a 400 would turn into a 500.
const invalidFieldSchema = z
  .object({
    error: z.string(),
    message: z.string().optional(),
    fields: z
      .array(z.object({ field: z.string(), reason: z.string() }))
      .optional()
  })
  .passthrough();

// The READ view (ADR-008 §9 `GET /api/v1/drm/config`), i.e. `DrmConfigView`
// (drm-config.ts:596): the twelve non-secret coordinates of §5.2 plus the
// derived credential STATUS.
//
// CLOSED on purpose (`additionalProperties: false`, which a plain `z.object`
// emits — see the generated /api/v1/admin/watch-folder/status schema): this is
// the boundary a credential would have to cross to leave the process, so the
// serialiser is the last of three independent gates (allow-list validation on
// write, `projectDrmStackConfig` in `toDrmConfigView`, this schema on read).
//
// Enum members are the SHARED membership lists, never retyped strings, so the
// published contract cannot drift from what the validator accepts.
const drmConfigViewSchema = z.object({
  enabled: z.boolean(),
  providerKind: z.enum(DRM_PROVIDER_KINDS),
  providerId: z.string(),
  label: z.string().optional(),
  keyServerUrl: z.string().optional(),
  spekeVersion: z.enum(DRM_SPEKE_VERSIONS).optional(),
  authMode: z.enum(CPIX_AUTH_MODES).optional(),
  scheme: z.enum(PROTECTION_SCHEMES).optional(),
  systems: z.array(z.string()).optional(),
  licenceUrls: z.record(z.string(), z.string()).optional(),
  certificateUrls: z.record(z.string(), z.string()).optional(),
  trackGroups: z.array(z.enum(TRACK_TYPE_GROUPS)).optional(),
  // The ONLY thing this surface says about a credential (ADR-008 §9). A
  // two-value string union, so there is structurally nowhere for a value to
  // hide.
  credentials: z.enum(DRM_CREDENTIAL_STATUSES)
});

// The WRITE body. Open by construction (see the file header): unknown keys must
// REACH the handler so the allow-list can refuse them with `invalid_field`, and
// value constraints are deliberately absent here so every enum/URL/required
// decision is made in exactly one place — `validateDrmStackConfig`.
const drmConfigBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    providerKind: z.string().optional(),
    providerId: z.string().optional(),
    label: z.string().optional(),
    keyServerUrl: z.string().optional(),
    spekeVersion: z.string().optional(),
    authMode: z.string().optional(),
    scheme: z.string().optional(),
    systems: z.array(z.string()).optional(),
    licenceUrls: z.record(z.string(), z.string()).optional(),
    certificateUrls: z.record(z.string(), z.string()).optional(),
    trackGroups: z.array(z.string()).optional(),
    // Accepted so a client can PUT back the body it just GET from this surface
    // (drm-config.ts `DRM_CONFIG_VIEW_ONLY_FIELD_NAMES`): a status value
    // round-trips and is stripped before persistence, a non-status value under
    // that name is refused 400.
    credentials: z.string().optional()
  })
  .passthrough()
  .describe(
    `Non-secret DRM coordinates (ADR-008 §5.2). Allowed fields: ${DRM_STACK_CONFIG_FIELD_NAMES.join(
      ', '
    )}. 'enabled', 'providerKind' and 'providerId' are required, and 'keyServerUrl' is required when providerKind is 'cpix'. Any other field — in particular a credential-shaped one — is rejected with 400 invalid_field; credentials are operator environment variables and are never stored here.`
  );

// Single spelling of the 400 body, so the handler path and the defence-in-depth
// error-handler path cannot disagree.
function invalidFieldBody(errors: DrmConfigValidationError[]): {
  error: typeof DRM_INVALID_FIELD_ERROR;
  message: string;
  fields: DrmConfigValidationError[];
} {
  return {
    error: DRM_INVALID_FIELD_ERROR,
    // Field names and reasons only — never a submitted value (ADR-008 §10).
    message: `invalid DRM configuration: ${errors
      .map((e) => `${e.field} ${e.reason}`)
      .join('; ')}`,
    fields: errors
  };
}

// ---------------------------------------------------------------------------
// Dry-run key request (ADR-008 §9 `POST /api/v1/drm/config/test`, issue #1297)
// ---------------------------------------------------------------------------

// The result shape, verbatim from ADR-008 §9's table row:
// "`{ ok, systems[], latencyMs, error? }`; the response **never** contains key
// material".
//
// CLOSED `z.object` AND a closed `error` enum, which is the whole defence here:
// `error` can only serialise as one of `DRM_ERROR_CODES` (src/types/drm.ts), so
// there is structurally nowhere for a provider message, a response body, a
// credential or a key byte to travel — a handler bug that tried to send one
// would be stripped by the serialiser rather than leak. `systems` carries
// registered common-encryption system IDS (public registry values, never
// secrets), and `latencyMs` a duration.
const drmConfigTestResultSchema = z.object({
  ok: z.boolean(),
  systems: z.array(z.string()),
  latencyMs: z.number().int().nonnegative(),
  error: z.enum(DRM_ERROR_CODES).optional()
});

// ADR-008 §5.2's example values, which `toDrmConfigView` already uses as its
// `authMode` fallback — so the status this surface reports and the mode the
// dry-run authenticates with cannot disagree.
const DEFAULT_SPEKE_VERSION = '2.0' as const;
const DEFAULT_AUTH_MODE = 'basic' as const;
// The single-key profile group (ADR-008 D3), the same default
// `resolveTrackGroups` applies on the real packaging path
// (src/pipeline/packaging.ts `DEFAULT_TRACK_GROUP`).
const DEFAULT_TRACK_GROUP: TrackTypeGroup = 'SD';
// CMAF scheme default (ADR-008 D3).
const DEFAULT_SCHEME = 'cbcs' as const;

// Build the #1261 client for a stored configuration. One adapter per PROTOCOL
// (ADR-008 D1), selected by `providerKind`:
//   - `cpix`         — src/drm/cpix-provider.ts `CpixProvider`
//   - `clearkey-dev` — src/drm/clearkey-dev-provider.ts `ClearKeyDevProvider`
//
// Only the coordinates the adapter needs in order to SEND a request are passed.
// The licence/certificate URLs are deliberately omitted: they are overlay
// configuration the adapter stamps onto returned signalling (ADR-008 §5.2
// "configuration, not response data"), and a dry-run reports reachability, not
// signalling content. Credentials are not passed at all — `CpixProvider` reads
// its own env vars at call time.
export function defaultKeyProviderFactory(config: DrmStackConfig): KeyProvider {
  if (config.providerKind === 'clearkey-dev') {
    // Throws `ClearKeyDevNotAllowedError` in a production process
    // (clearkey-dev-provider.ts, ADR-008 §10/Q5) — caught by the handler and
    // reported as `drm_not_configured`.
    return new ClearKeyDevProvider({
      id: config.providerId,
      ...(config.systems && config.systems.length > 0 ? { systemIds: config.systems } : {})
    });
  }
  // `keyServerUrl` is required for `cpix` by `validateDrmStackConfig`, so a
  // stored config without one is a config that was never valid; the empty
  // string makes `CpixProvider`'s constructor refuse it as
  // `drm_not_configured` rather than letting `undefined` reach `new URL`.
  return new CpixProvider({
    id: config.providerId,
    keyServerUrl: config.keyServerUrl ?? '',
    spekeVersion: config.spekeVersion ?? DEFAULT_SPEKE_VERSION,
    authMode: config.authMode ?? DEFAULT_AUTH_MODE
  });
}

// Map a thrown failure to an `errorCode` and NOTHING else. Same one-line
// classification the packaging step makes (`classifyKeyAcquisitionError`,
// src/pipeline/packaging.ts): `KeyProviderError.errorCode` when the adapter
// classified it (src/drm/key-provider-error.ts), else the unreachable class.
// The thrown MESSAGE is never read, so no provider text, credential or key byte
// can reach the response or a log line (ADR-008 §10).
function testErrorCode(err: unknown): DrmErrorCode {
  return isKeyProviderError(err) ? err.errorCode : 'key_provider_unreachable';
}

export const drmConfigRouter: FastifyPluginAsync<DrmConfigRouterOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // 401 presence gate, attached FIRST (the same hook, from the same module,
  // that routes/storage.ts and routes/export-destinations.ts attach). Unlike
  // the other `tags: ['admin']` routers — which are deliberately
  // unauthenticated status/toggle endpoints — this surface decides WHERE this
  // deployment fetches content keys from, so an anonymous caller must not be
  // able to read or repoint it. Plugin-scoped and lazy: `authGate` resolves
  // `app.authenticate` at request time and no-ops when `registerAuth` was never
  // called, so a unit test that builds this router in isolation is unaffected.
  app.addHook('preHandler', authGate(app));

  // Uniform 501 payloads. The DRM_ENABLED one is the shared constant from
  // #1295 (drm-config.ts `DRM_NOT_CONFIGURED_PAYLOAD`), reused verbatim rather
  // than restated so every DRM route answers a flag-off deployment identically.
  // The no-store one keeps the same machine-readable `error` and says WHICH
  // piece is missing, exactly as export-destinations.ts does for its two 501s.
  const noParamStorePayload = {
    error: DRM_NOT_CONFIGURED_PAYLOAD.error,
    message:
      'the parameter store is not configured on this deployment; DRM configuration cannot be read or written'
  };

  const notFoundPayload = (stackName?: string) => ({
    error: DRM_CONFIG_NOT_FOUND_ERROR,
    message: stackName
      ? `no DRM configuration stored for stack "${stackName}"`
      : 'no provisioned stack to hold a DRM configuration'
  });

  // Which stack this request addresses (ADR-008 D6: DRM config is per stack,
  // using the scoping `StackConfig` already has). The client-supplied
  // `X-Stack-Name` is read through the validated boundary helper, then handed
  // to the resolver, which returns the name verbatim only when a config exists
  // for it and otherwise falls back to the workspace default — so an
  // unroutable header can never become a parameter-store key here.
  const resolveStack = async (headers: {
    [key: string]: string | string[] | undefined;
  }): Promise<string | undefined> => {
    const resolver = opts.stackResolver;
    if (!resolver) return undefined;
    return resolver.resolveStackName(requestStackNameFromHeaders(headers));
  };

  // Defence in depth: `storeDrmStackConfig` re-validates through
  // `assertValidDrmStackConfig`, so a body that somehow reached the store path
  // without passing the handler's own check still surfaces as the ADR-008 §9
  // `400 invalid_field` rather than a 500. The failure carries field names and
  // reasons only.
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof DrmConfigValidationFailure) {
      return reply.code(400).send(invalidFieldBody(err.errors));
    }
    throw err;
  });

  // Read the stack's DRM configuration (ADR-008 §9).
  //   200 — the non-secret coordinates + `credentials: configured | missing`
  //   404 — no provisioned stack, or no DRM config stored on it yet
  //   501 — DRM_ENABLED off, or no parameter store configured
  app.get(
    '/config',
    {
      schema: {
        tags: ['admin'],
        description:
          "Read this stack's non-secret DRM configuration. Credential presence is reported as `credentials: \"configured\" | \"missing\"`; a credential VALUE is never returned (ADR-008 §9).",
        response: {
          200: drmConfigViewSchema,
          404: errorSchema,
          [DRM_NOT_CONFIGURED_STATUS]: errorSchema
        }
      }
    },
    async (request, reply) => {
      // Flag gate FIRST: no parameter-store read, no env read, no I/O at all on
      // a flag-off deployment (drm-config.ts `drmGateClosed`).
      if (drmGateClosed(reply)) return;
      const paramStore = opts.paramStore;
      if (!paramStore) {
        return reply.code(DRM_NOT_CONFIGURED_STATUS).send(noParamStorePayload);
      }
      const stackName = await resolveStack(request.headers);
      if (!stackName) return reply.code(404).send(notFoundPayload());
      const drm = await loadDrmStackConfig(
        paramStore,
        STACK_CONFIG_NAMESPACE,
        stackName
      );
      if (!drm) return reply.code(404).send(notFoundPayload(stackName));
      // `toDrmConfigView` projects to the allowlisted coordinates and appends
      // the credential STATUS. This is the only thing this route ever sends.
      return reply.code(200).send(toDrmConfigView(drm));
    }
  );

  // Set the stack's non-secret DRM configuration (ADR-008 §9).
  //   200 — the stored configuration, as the read view
  //   400 — `invalid_field`: a credential-shaped field, an unknown field, a
  //         non-https `keyServerUrl`, a bad enum value, a missing required field
  //   404 — no provisioned stack to write to
  //   501 — DRM_ENABLED off, or no parameter store configured
  app.put(
    '/config',
    {
      schema: {
        tags: ['admin'],
        description:
          "Set this stack's non-secret DRM configuration. Fields are validated against an allow-list: any other field — in particular a credential-shaped one — and a non-https `keyServerUrl` are rejected with `400 invalid_field`. Credentials are operator environment variables and are never accepted, stored or returned here (ADR-008 §5.2, D5).",
        body: drmConfigBodySchema,
        response: {
          200: drmConfigViewSchema,
          400: invalidFieldSchema,
          404: errorSchema,
          [DRM_NOT_CONFIGURED_STATUS]: errorSchema
        }
      }
    },
    async (request, reply) => {
      if (drmGateClosed(reply)) return;
      const paramStore = opts.paramStore;
      if (!paramStore) {
        return reply.code(DRM_NOT_CONFIGURED_STATUS).send(noParamStorePayload);
      }
      // Validate BEFORE resolving a stack or touching the store: a body that
      // tried to write a credential must be refused without any I/O, and
      // without the submitted value reaching a log line or a lookup key.
      const errors = validateDrmStackConfig(request.body);
      if (errors.length > 0) {
        return reply.code(400).send(invalidFieldBody(errors));
      }
      const candidate = request.body as unknown as DrmStackConfig;
      const stackName = await resolveStack(request.headers);
      if (!stackName) return reply.code(404).send(notFoundPayload());
      // Persists the PROJECTED block only (derived view fields such as
      // `credentials` are dropped), read-modify-write so the stack's other
      // coordinates survive (drm-config.ts `storeDrmStackConfig`).
      await storeDrmStackConfig(
        paramStore,
        STACK_CONFIG_NAMESPACE,
        stackName,
        candidate
      );
      // Echo the stored configuration through the SAME view builder the read
      // route uses, so GET and PUT cannot disagree about what is stored or
      // about the credential status.
      return reply.code(200).send(toDrmConfigView(candidate));
    }
  );

  // Dry-run a key request against the stored coordinates (ADR-008 §9, issue
  // #1297).
  //   200 — `{ ok, systems, latencyMs, error? }`; `ok: false` with an
  //         `errorCode` is a SUCCESSFUL test that reports a failing provider,
  //         so the operator sees WHICH failure class occurred rather than a
  //         5xx with no classification
  //   404 — no provisioned stack, or no DRM config stored on it yet
  //   501 — DRM_ENABLED off, or no parameter store configured
  app.post(
    '/config/test',
    {
      schema: {
        tags: ['admin'],
        description:
          "Dry-run a key request against this stack's stored DRM coordinates, using a throwaway content id that belongs to no asset. Reports whether the provider answered, which common-encryption system ids it signalled, and how long it took. On failure `error` carries a machine-readable error code only; no key material, provider message or credential is ever returned (ADR-008 §9, §10).",
        response: {
          200: drmConfigTestResultSchema,
          404: errorSchema,
          [DRM_NOT_CONFIGURED_STATUS]: errorSchema
        }
      }
    },
    async (request, reply) => {
      // Flag gate FIRST — a flag-off deployment must not build a provider, read
      // a credential env var or open a socket (ADR-008 D9).
      if (drmGateClosed(reply)) return;
      const paramStore = opts.paramStore;
      if (!paramStore) {
        return reply.code(DRM_NOT_CONFIGURED_STATUS).send(noParamStorePayload);
      }
      const stackName = await resolveStack(request.headers);
      if (!stackName) return reply.code(404).send(notFoundPayload());
      const config = await loadDrmStackConfig(
        paramStore,
        STACK_CONFIG_NAMESPACE,
        stackName
      );
      if (!config) return reply.code(404).send(notFoundPayload(stackName));

      // THROWAWAY content id (ADR-008 §9 "a throwaway `contentId`"). A real
      // `KeyRequest.contentId` is an asset id (key-provider.ts:74-77) and is
      // what makes a re-package reuse the same kids; a test must therefore
      // never borrow one, or it would mint or re-request keys bound to real
      // content. A random, clearly-labelled id belongs to no asset, so nothing
      // this route does can affect a stored `AssetDrm` — and this route writes
      // no asset state at all.
      const systems: DrmSystemId[] = resolveDrmSystemIds(config.systems);
      const keyRequest: KeyRequest = {
        contentId: `drm-config-test-${randomUUID()}`,
        systems,
        scheme: config.scheme ?? DEFAULT_SCHEME,
        // Single-key profile: one group, so a dry-run asks for the smallest
        // real request rather than the stack's full key set (ADR-008 D3).
        trackGroups: [config.trackGroups?.[0] ?? DEFAULT_TRACK_GROUP]
      };

      const started = Date.now();
      const elapsed = () => Math.max(0, Date.now() - started);
      const createProvider = opts.createKeyProvider ?? defaultKeyProviderFactory;

      // Provider CONSTRUCTION is inside the try: both adapters validate at
      // construction time (a non-https `keyServerUrl`, an unknown auth mode,
      // `clearkey-dev` in a production process), and those are exactly the
      // misconfigurations an operator runs this route to discover. They surface
      // as `ok: false` with an error code, not as a 500.
      let provider: KeyProvider;
      try {
        provider = createProvider(config);
      } catch (err) {
        return reply
          .code(200)
          .send({ ok: false, systems: [], latencyMs: elapsed(), error: testErrorCode(err) });
      }

      // Bounded like every other external call: the ADR-008 §12 whole-step
      // deadline, reused from the packaging step
      // (src/pipeline/packaging.ts `DRM_STEP_DEADLINE_MS`) so a dry-run cannot
      // outlive a real key request. `acquire`'s `signal` is mandatory
      // (key-provider.ts:158-161).
      const signal = AbortSignal.timeout(DRM_STEP_DEADLINE_MS);
      let acquired: Awaited<ReturnType<KeyProvider['acquire']>>;
      try {
        acquired = await provider.acquire(keyRequest, signal);
      } catch (err) {
        // ERROR CODE ONLY. The thrown message is not read, not logged and not
        // sent (ADR-008 §10).
        return reply
          .code(200)
          .send({ ok: false, systems: [], latencyMs: elapsed(), error: testErrorCode(err) });
      }
      const latencyMs = elapsed();

      // The keys this dry-run minted are of no use to anyone: they are bound to
      // a content id no asset has. Zero the bytes in place immediately and keep
      // only the SYSTEM IDS the provider signalled, so no key or key id is held
      // past this statement, let alone serialised (ADR-008 D4/§10; reuses
      // `zeroContentKeys`, src/pipeline/packaging.ts).
      const signalled = Object.keys(acquired.signalling.pssh ?? {});
      zeroContentKeys(acquired.keys);

      // `systems` = the ids the provider actually SIGNALLED, not the ids that
      // were asked for, so an operator comparing the two sees a provider that
      // is reachable but silent about a configured system. It is reported as
      // the provider answered rather than intersected with the request,
      // because `clearkey-dev` legitimately answers for the clear-key system
      // id whatever was requested (clearkey-dev-provider.ts: "`req.systems` is
      // deliberately IGNORED for signalling").
      return reply.code(200).send({
        ok: signalled.length > 0,
        systems: signalled,
        latencyMs,
        // A reachable provider that signalled NO system returned a document
        // this deployment cannot package with — the same failure class the
        // adapter raises for an unusable answer (ADR-008 §12).
        ...(signalled.length > 0
          ? {}
          : { error: 'key_provider_invalid_response' as const })
      });
    }
  );
};
