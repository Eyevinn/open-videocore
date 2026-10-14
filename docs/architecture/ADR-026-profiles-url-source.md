# ADR-026: Source of the Encore `profilesUrl` — derived app base URL vs. object-store-served profiles

**Status:** PROPOSED 2026-10-04 — decision record only; no product code changes in this PR
**Date:** 2026-10-04 (catalog facts re-confirmed live 2026-10-08; renumbered from the
draft's ADR-025 after `ADR-025-audit-scope-boundary.md` merged to `main` on 2026-10-05)
**Author agent:** architect
**Issue:** #1102 — *ADR deciding whether `profilesUrl` stays derived from the public base URL or moves to object-store-served profiles*. Supersedes the open question left by #284; adopts the direction of the **now-closed** #110, which this ADR's follow-up implementation issues (§5) supersede as the live tracking work. Sibling: #1103 (make the reachability probe continuous) — this ADR re-scopes #1103, see [D4](#d4--1103-is-re-scoped-the-probe-must-follow-the-resolved-tier). Related: #84 (profile store), #219/#283 (no OSC self-URL), #315 (parameter-store profiles URL), #337 (self-signed cert on the self-probe), #199/#859/#200 (anonymous-read packaged bucket), #991 (in-cluster object-store endpoint), ADR-003, `ADR-021-external-s3-endpoint-source-and-packaged.md`, ADR-023.

**Citation style.** Code is cited as **file path + symbol name**, without line
numbers: this branch merges `main` but will keep drifting behind it until merge,
and a record whose whole method is citation-grounding must not land with stale
line numbers. Every symbol named below was re-verified by `grep` against this
branch after merging `main` (2026-10-08).

---

## Summary of the decision

**Move the Encore `profilesUrl` to an object-store-served profile index — the
direction of the now-closed #110.**
The app's own `/api/v1/profiles/index.yml` is **demoted from primary to
fallback** — it stays in the resolver, but a healthy provisioned stack no longer
depends on it. #110 and #284 are both closed; they are cited throughout as the
two *designs*, and the live tracking work is §5's follow-up issues, not either
closed issue.

The deciding fact is not performance or cost, it is *whether the property the
current design depends on is expressible in any OSC contract*:

| | Derived app base URL (#284, today) | Object-store-served (#110, decided) |
|---|---|---|
| Property depended on | `/api/v1/profiles` is exempt from the OSC SSO auth gate | a named bucket is anonymous-read, and/or is reachable in-cluster |
| Is that property settable through an OSC API? | **No** — no tool or field in the catalog sets HTTP auth behaviour for an app ([C3](#c3--no-osc-contract-can-declare-read-or-guarantee-an-auth-exempt-http-path-for-an-app)) | **Yes** — `set-storage-bucket-public`, and the S3 `setBucketPolicy` this codebase already calls in production ([C4](#c4--osc-does-expose-a-first-class-public-read-capability--at-bucket-granularity), [C6](#c6--this-codebase-already-ships-an-anonymous-read-bucket-in-production)) |
| Is it readable/assertable? | **No** — only inferable by probing and observing a 401 | **Yes** — the policy is readable from the object store, and the index object is a GET away |
| Who can change it without telling us? | the platform, at the orchestrator level | nobody outside this app's own provisioning code |
| Observed failure | a customer 401 on `/api/v1/profiles/index.yml` that later cleared on its own | none in this product; the sibling anonymous-read bucket has been in production since #199 |

A dependency that cannot be set, read, or asserted through any contract is not an
architecture — it is a standing wager on an out-of-band platform configuration.
The 401-that-cleared-itself is that wager being lost and then won again, with no
signal either way. Object storage replaces it with a property this app owns.

A second, independent fact settles it for catalog deployments specifically:
the live `eyevinn-open-videocore` service manifest **still exposes no config key
for `PUBLIC_BASE_URL` or `ENCORE_PROFILES_URL_OVERRIDE`** ([C9](#c9--on-a-catalog-deploy-the-env-var-tiers-of-todays-resolver-are-unreachable)),
so on a one-click catalog deploy the two highest tiers of today's resolver cannot
be set **at all**. The object-store URL is derived by the app from the stack it
provisions itself — no env var, no manifest key, nothing for an operator to
type — so it is the only option that is reachable on a catalog deploy without
waiting on an OSC manifest change.

---

## 1. Context — what happens today

### 1.1 How `profilesUrl` is derived

Each Encore instance the auto-scaler spawns is a **separate OSC container** that
HTTP-GETs its configured `profilesUrl` with Java's `UrlResource` — a plain,
unauthenticated GET that cannot present a bearer token. The URL it is handed is
resolved at boot by a four-tier precedence chain:

- `src/services/public-base-url.ts` — `resolveEncoreProfilesUrl(defaultProfilesUrl, paramStoreProfilesUrl)`:
  1. `ENCORE_PROFILES_URL_OVERRIDE` (direct override);
  2. **derived local index** — `` `${base}${LOCAL_PROFILES_INDEX_PATH}` ``,
     where `base` comes from `resolvePublicBaseUrl()` (which today returns
     only the `PUBLIC_BASE_URL` env override) and
     `LOCAL_PROFILES_INDEX_PATH = '/api/v1/profiles/index.yml'`;
  3. a full index URL persisted in the parameter store under
     `StackConfig.encoreProfilesUrl` — `STACK_ENCORE_PROFILES_URL_FIELD`,
     read by `resolveEncoreProfilesUrlFromParamStore`;
  4. the remote default seed index.
- `src/main.ts` — `const publicBaseUrl = resolvePublicBaseUrl();`, then the
  tier-3 parameter-store read (skipped entirely when tier 1 or 2 is set), then
  `const encoreScalerProfilesUrl = resolveEncoreProfilesUrl(encoreProfilesUrl, paramStoreProfilesUrl);`
- `src/main.ts` — `encoreProfilesUrl`, the tier-4 remote default
  (`ENCORE_PROFILES_URL`, defaulting to the public `encore-test-profiles`
  index).
- `src/main.ts` — `profilesUrl: encoreScalerProfilesUrl` on the scaler
  config; `src/encore-scaler/instance-pool.ts` spells it onto the OSC
  create body as `instanceBody['profilesUrl']`.
- `src/main.ts` — when none of tiers 1–3 resolve, the
  `'profiles URL unresolved to local store …'` warning is logged and Encore
  uses the remote default index.

So in a normal OSC deployment with `PUBLIC_BASE_URL` set, **tier 2 wins** and
Encore is pointed at this app's own public URL.

### 1.2 What serves that path

`src/routes/profiles.ts` (`profilesRouter`) registers `GET /index.yml`, which
renders the Encore-format index **live from CouchDB** — `name: <name>/yaml`
lines for every runnable profile, with an `x-profile-count` response header —
and `GET /:name/yaml`, which returns one profile's raw YAML. Both are
unauthenticated *inside the app*: the header comment on `profilesRouter`
(*"This whole router is unauthenticated by design …"*) records that this is
deliberate because OSC terminates auth at the edge (ADR-003), and
the global `preHandler` in `src/main.ts` only resolves stack connections and
never rejects. **The only thing that can reject Encore's fetch is the OSC auth
gate at the platform edge.**

### 1.3 The failure this ADR exists to remove

`docs/osc-feedback/incoming-08-login-wall-blocks-encore-profile-fetch.md`
records the original incident: every transcode failed with
`java.io.IOException: Server returned HTTP response code: 401 for URL: .../api/v1/profiles/index.yml`.
On 2026-07-08 OSC said they would make `/api/v1/profiles` publicly accessible
for this app, and that log explicitly notes the promise was **left
unconfirmed**.

#284 shipped a boot-time confirmation instead of a fix:

- `src/services/profiles-reachability.ts` —
  `checkProfilesIndexReachable({ profilesIndexUrl, usingLocalIndex, log, fetchImpl })`
  issues one unauthenticated GET, exactly as Encore would, and classifies the
  result against the `ReachabilityOutcome` union as `{ ok: true }` /
  `kind: 'auth-wall'` (401 or 403) / `kind: 'unreachable'`. It is **non-fatal by
  design** (stated in its doc comment) and logs a hard error rather than
  aborting boot. Its first statement after picking a fetch is the short-circuit
  `if (!profilesIndexUrl || !usingLocalIndex) return undefined;`, and its
  `auth-wall` message names the path and the issue explicitly: *"Confirm the OSC
  platform has made /api/v1/profiles publicly accessible for this app (issue
  #284)"*.
- `src/services/profiles-reachability.ts` — `nodeSelfProbeFetch`, the
  default probe, relaxes TLS verification for this one self-call via a
  per-request `node:https` agent (`selfProbeHttpsAgent`), because the app's own
  public URL serves a self-signed certificate from inside the cluster (#337).
- `src/main.ts` — the single call site, fired **once**, after the
  server is listening: `void checkProfilesIndexReachable({ profilesIndexUrl: encoreScalerProfilesUrl, usingLocalIndex: Boolean(publicBaseUrl), log: app.log })`.

That is a **one-shot** check. The customer-reported 401 on
`/api/v1/profiles/index.yml` that cleared on its own is precisely the case a
one-shot boot check cannot catch: the gate can change state at any time after
boot, in either direction, with no signal. While it is closed, Encore's fetch
401s and Encore **silently falls back to its built-in/remote default profiles** —
so transcodes either fail or quietly run with profiles the operator never chose.

#1103 proposes making the probe continuous. That is a better detector of a
failure we should not be exposed to at all.

---

## 2. Verified contracts (cited before the decision)

**How the live contract was fetched (2026-10-04; re-confirmed 2026-10-08).**
Every catalog fact below comes from a live query made while writing this ADR, by
the method ADR-023 §2.1 records:

- `POST $OSC_MCP_URL` (`https://mcp.osaas.io/mcp`) with
  `Authorization: Bearer $OSC_ACCESS_TOKEN` and
  `Accept: application/json, text/event-stream`. `initialize` →
  `serverInfo: { name: 'osc-remote-mcp', version: '8.13.0' }` on 2026-10-04,
  **`version: '8.14.1'` on the 2026-10-08 re-confirmation**. C1, C2, C4 and C9
  were re-fetched at 8.14.1 and are unchanged except for the
  `set-storage-bucket-public` / `list-objects-on-bucket` description wording
  recorded in C4.
- Read-only catalog calls dispatched through the `osc_call_tool` envelope
  (`{ name, args }`), per its live `tools/list` input schema.
- Full per-category tool schemas read from the scoped surfaces the live
  `get-mcp-help` description documents: `POST https://mcp.osaas.io/mcp/category/{apps,instances,storage,pages}`
  → `tools/list`.
- Service-API contracts cross-checked against the live service OpenAPI
  documents at `https://api-<serviceId>.auto.prod-se.osaas.io/docs/json` and
  against the live subscription catalog
  `GET https://catalog.svc.prod.osaas.io/mysubscriptions`
  (header `x-pat-jwt: Bearer <PAT>`, per
  the `x-pat-jwt` header set in `node_modules/@osaas/client-core/lib/context.js`).

### C1 — `profilesUrl` is a bare URL string on the `encore` service; there is no companion credential, header, or token field

Live `get-service-schema` (`serviceId: "encore"`, `verbosity: "detailed"`,
2026-10-04), verbatim from `structuredContent.configOptions`:

```json
{ "name": "name",              "type": "string", "required": true, "regexValidator": "^\\w+$" }
{ "name": "profilesUrl",       "type": "string", "description": "URL pointing to list of transcoding profiles" }
{ "name": "s3AccessKeyId",     "type": "string", "sensitive": true }
{ "name": "s3SecretAccessKey", "type": "string", "sensitive": true }
{ "name": "s3SessionToken",    "type": "string", "sensitive": true }
{ "name": "s3Region",          "type": "string" }
{ "name": "s3Endpoint",        "type": "string" }
```

`profilesUrl` is the only profile-related field. There is **no**
`profilesAuthHeader`, `profilesToken`, or credential pairing of any kind — so a
bearer-token or SigV4-signed profile fetch is **not expressible in the service
contract**, independent of what Encore's `UrlResource` can do. Any solution must
therefore make the index reachable by an **unauthenticated GET of a plain URL**.

### C2 — OSC models Encore's object-store dependency as `routing: INTERNAL`, and `encore` does not support in-place config updates

Same live `get-service-schema` response, `structuredContent`:

```json
"serviceAssociations": [
  { "parameter": "s3Endpoint", "serviceId": "minio-minio", "protocol": "http", "routing": "INTERNAL" }
],
"supportsUpdate": false
```

Two consequences:

1. **`routing: INTERNAL`** — the platform's own dependency model expects an
   Encore instance to reach the object store **in-cluster**, not through the
   public ingress. A profiles URL served from the object store can therefore
   travel a path OSC itself sanctions and that never meets the public edge or
   the SSO auth gate.
2. **`supportsUpdate: false`** — a live Encore instance's `profilesUrl` cannot
   be repointed; changing it requires delete + recreate. This rules out any
   design that depends on **rotating** the URL handed to a running instance
   (notably a short-lived presigned URL on a long-lived instance), and is the
   reason [D3](#d3--serve-the-index-anonymous-read-not-presigned) rejects
   presigned URLs.

### C3 — No OSC contract can declare, read, or guarantee an auth-exempt HTTP path for an app

This is the load-bearing negative finding, and it was checked three ways.

**(a) The `apps` tool surface has no auth field at all.** The live
`POST https://mcp.osaas.io/mcp/category/apps` → `tools/list` returns **34 tools**
(`submit-open-source-repository`, `list-my-apps`, `get-my-app`, `create-my-app`,
`delete-my-app`, `restart-my-app`, `enable-app-ha`, `disable-app-ha`,
`setup-git-repo`, `update-my-app-config`, `update-my-app-analytics`,
`update-my-app-source-ref`, `diagnose-my-app`, `get-my-app-logs`,
`wait-for-app-ready`, `get-runtime-limits`, the Agentic-SDLC and
git-credential/stage-prod families, …). The complete live `create-my-app` input
schema is:

```json
{ "name", "type", "gitHubUrl", "gitUrl", "gitCredential", "gitHubToken",
  "gitToken", "configService", "configApiKey", "analyticsService",
  "liveChatService", "subPath", "entryPoint" }
```
(`required: ["name","type"]`, `additionalProperties: false`)

There is **no** `publicPaths`, `authExemptPaths`, `disableAuth`, `publicAccess`,
or equivalent — not on create, and not on any `update-my-app-*` tool
(`update-my-app-config` binds only a parameter store; the others cover
analytics, source ref, GitHub token, and the .NET entrypoint). Scanning every
one of the 34 input schemas for `auth|public|login|exempt|allowlist|unauthenticated`
matches only `update-my-app-github-token` (a git PAT) and `enable-agentic-sdlc`
(the word "public" in prose). The same holds in the typed SDK:
`CreateMyAppBody = { name, type, gitHubUrl, gitHubToken?, configService? }`
and `MyApp = { id, name, type, gitHubUrl, url, appDns?, tenantId, buildStatus? }`
— `node_modules/@osaas/client-core/lib/myapp.d.ts` (`CreateMyAppBody`, `MyApp`).

**(b) The one public-access toggle that exists explicitly excludes HTTP.** Live
`set-instance-public-access` description (`mcp/category/instances` → `tools/list`,
2026-10-04), verbatim:

> "Toggle **TCP-level** public network exposure for an existing service
> instance. This controls NodePort allocation for services that expose raw TCP
> ports (databases like Postgres, Redis, MariaDB, ClickHouse). … **NOTE: This
> tool does NOT control HTTP-level access.** Services that expose an HTTP web UI
> (e.g. Keycloak, catalog UIs, other IdPs) are routed through a shared
> per-orchestrator ingress with the OSC SSO auth gate. **HTTP access and the SSO
> auth gate are configured at the orchestrator level and cannot be toggled per
> instance with this tool.**"

Input schema: `{ serviceId, name, publicAccess: boolean }`,
`required: ["serviceId","name","publicAccess"]`. Instance-granular, TCP-only.
The SSO auth gate is stated to be **orchestrator-level** configuration — i.e.
outside the tenant's contract surface entirely, let alone path-scoped.

**(c) `publicAccess` is readable but never writable, and is not path-aware.**
`GET /internal-endpoint/{id}` on the live `minio-minio` service OpenAPI
(`https://api-minio-minio.auto.prod-se.osaas.io/docs/json`) returns
`{ serviceDns: string, ports: Array<{name,port,protocol}>, publicAccess: boolean }`
(all three `required`), matching
`InternalEndpointInfo` in `node_modules/@osaas/client-core/lib/core.d.ts`.
It is an **output-only** boolean about the whole instance. No input anywhere in
that document accepts it, and nothing in it is path-scoped.

**Conclusion.** The 2026-07-08 assurance that `/api/v1/profiles` would be made
publicly accessible is real, but it is an orchestrator-side configuration with
**no API to set it, no API to read it, and no event when it changes**. Option
#284 depends on it permanently. Logged as an OSC capability gap in the **agents
repo** (a separate repository, so it is not part of this PR's diff) at
`eng-open-videocore-agents/docs/osc-feedback/incoming-profiles-url-public-path-exemption.md`,
written and pushed 2026-10-08 on the agents-repo branch
`osc-feedback/profiles-url-public-path-exemption` (awaiting merge there) — that
repo is where the `osc-feedback` agent consolidates submissions. It carries forward both this gap and the unreported
`getInternalEndpoint` → `ports: []` gap named in C7.

### C4 — OSC *does* expose a first-class public-read capability — at bucket granularity

Live `POST https://mcp.osaas.io/mcp/category/storage` → `tools/list`
(2026-10-04; re-fetched 2026-10-08 at osc-remote-mcp 8.14.1) includes:

- **`set-storage-bucket-public`** — description **in full**, verbatim: *"Make a
  storage bucket publicly readable on the web. Use after create-storage-bucket
  to serve static files. To publish a static site with a proper public URL, use
  create-my-page instead."*
  Input schema: `{ bucketName: string, instanceName?: string }`,
  `required: ["bucketName"]`. `instanceName`: *"Optional MinIO instance name.
  Defaults to the shared workspace mcpstorage instance."*
- `create-storage-bucket` — `{ bucketName, instanceName? }`, where
  `instanceName` is documented (8.14.1) as *"Optional MinIO instance name to
  provision the bucket on … Provide a dedicated instance name (e.g. the name of
  your minio-minio service instance) to isolate buckets."*
- `upload-object-to-bucket` — `{ bucketName, objectKey, contentBase64, contentType, instanceName? }`.
- `list-objects-on-bucket` — `{ bucketName, recursive, maxKeys?, continuationToken?, instanceName? }`,
  now prefixed *"Managed OSC storage only … This tool does NOT support
  user-deployed minio-minio service instances; use get-service-endpoints on
  those instances instead."*

Two honest qualifications, both recorded rather than argued around:

1. The third sentence of `set-storage-bucket-public` **steers static-site
   publishing to My Page** (C8), not to a public bucket. It is weighed against
   that in [D5](#d5--alternatives-considered-and-rejected); the profile index is
   not a static *site*, it is one machine-fetched object served by exact key,
   and the My Page rejection rests on naming/publish/lifecycle properties that
   the steer does not change.
2. The 8.14.1 `list-objects-on-bucket` caveat shows the managed-storage tool
   family is at least partly scoped to **managed** OSC storage rather than a
   tenant's own `minio-minio` instance. **D3 therefore does not depend on these
   MCP tools at all** — it applies the policy through the S3 API
   (`setBucketPolicy`) that this codebase already calls against its own instance
   in production (C6). C4's role in the argument is narrower than "we will call
   this tool": it is evidence that **public read is a capability OSC exposes and
   documents at bucket granularity**, which is precisely what C3 shows it does
   not expose at app-path granularity. That asymmetry is the whole argument, and
   it survives both qualifications.

### C5 — The object store itself carries no public/bucket configuration at create time; public read is an S3-API operation

Live `get-service-schema` (`serviceId: "minio-minio"`, `verbosity: "detailed"`,
2026-10-04) — config options are exactly `name` (required, `^\w+$`),
`RootUser` (optional), `RootPassword` (optional, sensitive). The live service
OpenAPI agrees: `POST /minioinstance` accepts a body of only
`{ name (required), RootUser, RootPassword }`
(`https://api-minio-minio.auto.prod-se.osaas.io/docs/json`), and
`list-available-services` (`category: "storage"`) reports
**`minio (minio-minio) … Required config: name`**.

There is therefore **no provisioning-time bucket or public-access field**.
Public read is applied *after* creation, through the S3 API — which this
codebase already does (C6) — or through `set-storage-bucket-public` (C4).

### C6 — This codebase already ships an anonymous-read bucket in production

The #110 shape is not new infrastructure; it is the pattern already in
production for packaged media:

- `src/routes/provision.ts` — step *1d* (*"Apply an anonymous (public)
  read-only bucket policy …"*), issue #199: a `GetObject`-only
  anonymous policy is applied to `PACKAGED_BUCKET` and **only** that bucket
  (`SOURCE_BUCKET` stays private). The policy is built as the `packagedPolicy`
  constant — `{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::<packaged>/*'] }`
  — with no `ListBucket` and no write, so objects are readable by exact key and
  the bucket is not browsable. Applied with
  `minioClient.setBucketPolicy(PACKAGED_BUCKET, packagedPolicy)`, documented
  there as idempotent so re-provision converges, and best-effort with
  retry/backoff so a policy failure cannot fail a re-provision.
- `src/routes/assets.ts` — the delivery layer relies on exactly that:
  a provisioned stack's own object-store endpoint "**IS** the public origin for
  its packaged bucket, so a zero-config stack advertises absolute, anonymously
  fetchable manifest URLs", *"sound precisely because this codebase applies the
  anonymous-read policy to the packaged bucket when it provisions the stack"*.
- Bucket names: the `SOURCE_BUCKET = 'openvideocore-source'` /
  `PACKAGED_BUCKET = 'openvideocore-packaged'` constants in `provision.ts`.

**This is live evidence that the object store's public origin is not behind the
SSO auth gate**: HLS/DASH players fetch manifests and segments from it
anonymously today, in this same product, in the shipped `public` delivery mode
(#200/#859).

### C7 — An in-cluster object-store URL is already derived, probed and used for the Encore hand-off

`src/services/internal-minio-endpoint.ts` already resolves the object store's
**in-cluster** endpoint for the server-to-transcoder hand-off, with findings
verified live against prod-se (read-only, 2026-09-29/30 — see the module header
comment in `internal-minio-endpoint.ts`):

- the in-cluster form is `http://<service>.minio-minio.svc.cluster.local:8080`
  (the `DEFAULT_INTERNAL_PORT = 8080` constant; Service port 80 has nothing
  behind it and must not be used);
- a plain `GET http://<service>.minio-minio.svc.cluster.local:8080/minio/health/live`
  from a pod in the transcoder namespace returned **200 in 23 ms**, and the only
  NetworkPolicies in the cluster cover neither workload;
- `getInternalEndpoint` returns `ports: []` for a running object-store instance,
  so `selectInternalPort` falls back to `DEFAULT_INTERNAL_PORT` (recorded in the
  same module header; note that the friction file that comment names,
  `docs/osc-feedback/incoming-issue991-minio-internal-port-not-exposed.md`, does
  **not** exist in either repo — the finding was recorded only in that code
  comment, and the agents-repo gap log written with this ADR, 
  `incoming-profiles-url-public-path-exemption.md`, now carries it forward);
- the resolver is **opt-out** (`ENCORE_S3_INTERNAL_ENDPOINT=off`), **probed**
  before use (`makeInternalEndpointProbe`), and **fail-soft** back to the stored
  public endpoint (`makeInternalEndpointResolver`,
  `resolveInternalEndpointSettings` in `internal-minio-endpoint.ts`), and it
  never throws or fails startup;
- its existing consumer is `resolveEncoreS3Config`
  (`src/services/encore-s3-config.ts`), i.e. the Encore hand-off path.

So the reusable, already-hardened seam for pointing Encore at an in-cluster
object-store URL **exists**, and the implementation does not have to re-derive
it.

### C8 — A third OSC-native public static host exists (recorded, not chosen)

Live `POST https://mcp.osaas.io/mcp/category/pages` → `tools/list`: `create-my-page`
(*"the name becomes the subdomain: a page named "my-docs" is served at
`https://my-docs.pages.osaas.io/`. Names are globally unique (not
per-workspace)"*), `upload-my-page-files`, `get-my-page-upload-urls`,
`publish-my-page`, `set-my-page-auth` (*"Enable or update HTTP Basic Auth"*),
`remove-my-page-auth` (*"After disabling, the page is publicly accessible
without credentials"*).

Note the contrast with C3: for My Page, public-without-credentials is an
**explicit, API-controlled, documented default**. It is nevertheless rejected in
[D5](#d5--alternatives-considered-and-rejected) — globally unique names, a
separate publish step, and no relation to the stack's own storage identity.

### C9 — On a catalog deploy, the env-var tiers of today's resolver are UNREACHABLE

Live `get-service-schema` (`serviceId: "eyevinn-open-videocore"`,
`verbosity: "detailed"`, 2026-10-04) — the complete set of config options is:

```
name (required), OscAccessToken (required, sensitive),
ParameterStoreApiKey (required), ParameterStore (required),
MinioRootPassword (required, sensitive), CouchdbAdminPassword (required, sensitive),
EncoreMaxInstances, EncoreMinInstances, EncoreIdleTimeoutMs, TrustRoleHeader
```
with `structuredContent.supportsUpdate: false`.

There is **no `PublicBaseUrl` key and no `EncoreProfilesUrlOverride` key** — the
two manifest keys requested on 2026-08-19 in
`docs/osc-feedback/incoming-issue285-manifest-profiles-url-override.md` have not
landed. That log states the consequence plainly: *"even though the app already
consumes these env vars correctly, an OSC operator has no reachable way to set
them — so an explicit profiles-URL override is unreachable via the catalog, and
a single-click deploy cannot point Encore at the local operator-managed profile
store."*

Mapped onto the resolver in §1.1, for a catalog-deployed stack:

| Tier | Reachable on a catalog deploy? |
|---|---|
| 1 `ENCORE_PROFILES_URL_OVERRIDE` | **No** — no manifest key |
| 2 derived `${PUBLIC_BASE_URL}/api/v1/profiles/index.yml` | **No** — no manifest key |
| 3 parameter-store `StackConfig.encoreProfilesUrl` | Yes, but it is an operator-**typed** URL with no publisher behind it |
| 4 remote default seed index | Yes — and it discards every operator-managed profile |

So the #284 design is not merely *fragile* on a catalog deploy — its two
operative tiers are **unsettable**, and the only operator-managed path that
works is a hand-typed URL pointing at content nothing maintains. An
object-store index needs **neither** key: the app already holds the stack's
object-store coordinates — the `StackConfig.minioEndpoint` and
`StackConfig.services: { serviceId: string; instanceName: string }[]` fields of
the `StackConfig` type in `src/services/param-store.ts`, the same two
fields `internal-minio-endpoint.ts` resolves the in-cluster endpoint from —
because it provisioned them itself. (`StackConfig.encoreProfilesUrl?` is on the
same type.)

---

## 3. Decision

### D1 — The object store becomes the PRIMARY source of the Encore profile index (#110)

For a provisioned stack, the profile index and the per-profile YAML documents are
**published as objects** into a dedicated bucket, and `profilesUrl` points at
that bucket's `index.yml`. Encore's unauthenticated `UrlResource` GET (C1) then
resolves against an origin whose reachability this app configures and can read
back (C4, C5, C6) — instead of against an orchestrator-level auth-gate exemption
no contract can express (C3).

- Bucket: a **new, dedicated** `openvideocore-profiles`, created alongside the
  existing `SOURCE_BUCKET`/`PACKAGED_BUCKET` constants in
  `src/routes/provision.ts`. Dedicated, not a prefix
  on `openvideocore-packaged`, so the profiles policy and the media policy stay
  independently auditable and a profile object can never collide with a packaged
  key.
- Objects: `index.yml` plus one `<name>.yml` per runnable profile. The index keeps
  the Encore-format `name: <relative>` mapping already emitted by the
  `GET /index.yml` handler in `src/routes/profiles.ts`, with the relative target
  changed from `<name>/yaml` to `<name>.yml` so it resolves correctly against a
  bucket base URL.
- `GET /api/v1/profiles/index.yml` and `GET /api/v1/profiles/:name/yaml`
  (both in `profilesRouter`) **stay exactly as they are**. They remain the
  human/monitoring surface — including the `x-profile-count` header contract from
  #460 — and the fallback source for deployments without
  object storage (D2). Nothing about their body or status contract changes.

### D2 — The derived app base URL is DEMOTED to a fallback, not deleted

`resolveEncoreProfilesUrl` (`src/services/public-base-url.ts`) gains one
new tier, inserted **above** the derived local index:

| Tier | Source | Status |
|---|---|---|
| 1 | `ENCORE_PROFILES_URL_OVERRIDE` | unchanged |
| **2 (new)** | **published object-store index URL**, when the publisher reports the index in sync | **new primary** |
| 3 | derived `` `${PUBLIC_BASE_URL}${LOCAL_PROFILES_INDEX_PATH}` `` | demoted from primary to fallback |
| 4 | parameter-store `StackConfig.encoreProfilesUrl` (#315) | unchanged (`STACK_ENCORE_PROFILES_URL_FIELD`, `resolveEncoreProfilesUrlFromParamStore`) |
| 5 | remote default seed index | unchanged (`encoreProfilesUrl` / `ENCORE_PROFILES_URL` in `src/main.ts`) |

**The resolver must also report which tier it chose** — see D4: the boot probe's
scope and its error wording both depend on it, so the resolved tier becomes part
of the function's return rather than something the call site re-derives from
`Boolean(publicBaseUrl)`.

Demoted rather than removed, for three reasons, all grounded above:

1. The env-override path (`MINIO_URL`/`COUCHDB_URL`) and the in-memory/local-dev
   path have no provisioned object store — `src/routes/assets.ts`
   already records that the stack-endpoint derivation "returns undefined for the
   env-override and in-memory paths". Those deployments must keep working.
2. The publisher can be out of sync (a failed write, a stack provisioned before
   this change). Falling back to the live-rendered app route is strictly better
   than falling back to the remote default index, which silently discards every
   operator-managed profile.
3. `supportsUpdate: false` (C2) means a mistake cannot be corrected on a running
   Encore instance, so an unavailable primary must degrade to *something
   operator-managed*, at spawn time, not to a stale instance.

Note that on a catalog deploy tiers 1 and 3 are unsettable anyway (C9), so for
those deployments this change converts the profile store from "reachable only by
hand-typing a URL into the parameter store" into "works by default". The #285
manifest-key ask stays open and still worth having — it is the only way to point
Encore at a *third-party* index — but the product no longer depends on it.

**The URL for tier 2 is resolved in this order**, reusing C7's hardened seam:

1. the **in-cluster** endpoint from `makeInternalEndpointResolver`
   (`src/services/internal-minio-endpoint.ts`) — probed before use and
   fail-soft by construction — giving
   `http://<service>.minio-minio.svc.cluster.local:8080/openvideocore-profiles/index.yml`.
   This is the preferred form: it matches the `routing: INTERNAL` the platform
   itself models for Encore→object store (C2) and **never touches the public
   edge or the auth gate**;
2. otherwise the stack's stored **public** object-store origin
   (`StackConfig.minioEndpoint`), i.e.
   `https://<endpoint>/openvideocore-profiles/index.yml` — which is anonymously
   readable because of D3, by the same mechanism that already serves packaged
   manifests (C6).

### D3 — Serve the index anonymous-read, not presigned

Apply a `GetObject`-only anonymous policy to `openvideocore-profiles`, as a
**verbatim re-use of the shape already shipped** for the packaged bucket — the
`packagedPolicy` constant and its `setBucketPolicy` call in
`src/routes/provision.ts`: `Principal: { AWS: ['*'] }`,
`Action: ['s3:GetObject']`, `Resource: ['arn:aws:s3:::openvideocore-profiles/*']`,
no `ListBucket`, no write; `setBucketPolicy` is idempotent so re-provision
converges; best-effort with the same retry/backoff so it cannot fail a
re-provision.

Presigned URLs are rejected on two independent grounds, both already recorded:

- `supportsUpdate: false` on `encore` (C2) means a presigned `profilesUrl` cannot
  be refreshed on a running instance, so the design would carry a hard expiry
  cliff with no repair path short of delete + recreate.
- `docs/osc-feedback/incoming-minio-presigned-blocked.md` records that presigned
  GET URLs return **403 through the public reverse proxy**, regardless of bucket
  policy — so the public fallback in D2 could not use them at all.

**Exposure accepted, explicitly.** Anonymous read means the operator's transcode
profile YAML is publicly readable by exact key at the stack's public
object-store origin. That is accepted: the objects are encoder configuration
(codec, bitrate ladder, container settings), not customer media and not
credentials; the policy grants no `ListBucket`, so the bucket is not enumerable;
and it is a strictly **narrower** exposure than the anonymous-read packaged
bucket this product already ships (C6), which serves actual media. The source
bucket's privacy is untouched. Anything a profile YAML must never contain
(credentials, signed URLs) is already true today — `index.yml` and
`/:name/yaml` are served unauthenticated by `profilesRouter` right now.

### D4 — #1103 is RE-SCOPED: the probe must follow the resolved tier

#1103 as written asks for **continuous** probing of
`${PUBLIC_BASE_URL}/api/v1/profiles/index.yml` to detect the auth gate closing.
Under D1/D2 that path is no longer the primary source, so monitoring it on an
interval monitors a fallback. **The periodic-probe scope in #1103 is therefore
rejected** — but #1103 is *not* closed as a no-op, because D1/D2 force a change
at exactly the call site it names. It is re-scoped to the probe correction below,
or, if the orchestrator prefers to keep #1103 strictly about periodicity, closed
and the correction folded into the D1 implementation issue. Either way **the
correction is mandatory and ships with D1/D2 — the probe cannot be left
unchanged.**

**Why "change nothing" is not available.** `checkProfilesIndexReachable` is
handed only a resolved URL plus a boolean, and the call site in `src/main.ts`
computes that boolean from the *old* tier layout:

```ts
void checkProfilesIndexReachable({
  profilesIndexUrl: encoreScalerProfilesUrl,
  usingLocalIndex: Boolean(publicBaseUrl),
  log: app.log
})
```

while the function itself short-circuits on
`if (!profilesIndexUrl || !usingLocalIndex) return undefined;` and, on 401/403,
logs *"Confirm the OSC platform has made /api/v1/profiles publicly accessible
for this app (issue #284)"*. Left alone under D1/D2 that misbehaves in two ways,
in opposite directions:

1. **`PUBLIC_BASE_URL` set and the new tier 2 winning** — `encoreScalerProfilesUrl`
   is the *bucket* URL, but `usingLocalIndex` is still `true`. The probe fires at
   the object store and, on any 401/403/non-OK, reports it with auth-wall / issue
   #284 wording that is simply wrong for an object-store origin, while the tier-3
   app path it is supposed to be vouching for is never checked.
2. **A catalog deploy** — C9 shows `PUBLIC_BASE_URL` cannot be set at all, so
   `usingLocalIndex` is `false` and the probe is **skipped entirely**. The new
   primary gets no boot check whatsoever.

In neither case does it guard tier 3, which is what the "stays as it is" reading
would need it to do.

**The required change (ships with D1/D2):**

- Pass the **resolved tier** explicitly instead of inferring it from
  `Boolean(publicBaseUrl)`. `resolveEncoreProfilesUrl` returns the tier it chose
  (D2), and the call site hands that to the probe — replacing the
  `usingLocalIndex: boolean` parameter with the tier (or an equivalent
  discriminated `origin: 'object-store' | 'app-path' | 'param-store' | 'remote-default'`).
- **Scope the message to the origin that was actually probed.** The
  auth-wall/issue-#284 wording stays for the `app-path` origin, where it is
  accurate. An `object-store` origin gets its own wording (bucket, key, policy,
  in-cluster vs public endpoint) and must not mention the login wall.
- **Probe the object-store primary too**, so the catalog deploy in case 2 keeps a
  boot check. This is the **publish verification** the primary needs anyway: the
  published `index.yml` is fetchable and its profile count matches the store.
  Cheap, non-fatal, and it probes an origin this app controls rather than an
  exemption it does not.
- Keep every existing property of the probe: **one-shot**, **non-fatal**, the
  scoped `nodeSelfProbeFetch` TLS relaxation for the self-call (#337), and the
  `ReachabilityOutcome` return shape its tests assert against. The re-scoping
  changes *which origin is probed and how a failure is described*, not the
  probe's lifecycle or its cost.

No *periodic* probe is introduced. The reason #1103's interval is unnecessary
under D1/D2 is structural, not budgetary: the object-store origin's reachability
is a property this app sets and can re-assert at publish time, so there is no
out-of-band actor to watch for.

### D5 — Alternatives considered and rejected

- **Keep #284 and make the probe continuous (#1103 alone).** Rejected. It
  improves detection of a dependency C3 shows cannot be set, read, or asserted
  through any OSC contract. Detection is not the problem — the customer 401
  *was* detected, by the customer. The exposure is the problem.
- **Keep #284 and ask OSC for a guaranteed public path.** Rejected as the
  *primary* plan; pursued in parallel as feedback (logged in the agents repo at
  `eng-open-videocore-agents/docs/osc-feedback/incoming-profiles-url-public-path-exemption.md`,
  branch `osc-feedback/profiles-url-public-path-exemption`, not yet submitted to
  OSC — it goes out with the weekly consolidation).
  C3(b) states the auth gate is configured at the **orchestrator level**, so
  this is a platform roadmap item with no tenant-side lever and no date. #285 is
  the precedent for how long such an ask can sit: requested 2026-08-19, still
  absent from the live manifest on 2026-10-04 and again on 2026-10-08 (C9). The
  architecture must not block on it.
- **Authenticate Encore's profile fetch.** Not expressible: `profilesUrl` is a
  bare string with no companion credential field anywhere in the live `encore`
  schema (C1), and Encore's `UrlResource` sends no custom headers
  (`incoming-08-login-wall-blocks-encore-profile-fetch.md`).
- **A My Page static site (C8).** Rejected. Page names are **globally unique,
  not per-workspace**, which is a cross-tenant naming collision risk for a
  per-stack artefact; it requires a separate `publish-my-page` step after every
  profile change; and it introduces a resource with no relationship to the
  stack's storage identity or teardown. The object store is already provisioned,
  already policy-managed by this codebase, and already torn down with the stack.
  Noted against this: the live `set-storage-bucket-public` description itself
  steers static-site publishing to `create-my-page` (C4). That steer is about
  serving a *site* at a proper public URL — it does not speak to a single
  machine-fetched object, and it does not change the globally-unique-name,
  separate-publish-step or no-teardown-relationship properties on which this
  rejection rests. Recorded so the trade-off is visible rather than silently
  resolved.
- **Pin `StackConfig.encoreProfilesUrl` (#315) to a hand-written object URL.**
  Rejected as the answer: it is an operator-typed string with no publisher, so
  the objects behind it would never be written or kept in sync — and C9 shows it
  is currently the *only* reachable operator-managed tier on a catalog deploy,
  which is exactly the state this ADR is fixing. It stays as tier 4 — the escape
  hatch for an external index — which is what it was designed for
  (`resolveEncoreProfilesUrlFromParamStore` and its doc comment in
  `public-base-url.ts`).

---

## 4. Consequences

**Positive:**

- The primary profile path no longer depends on any property outside this app's
  own contract surface. The customer-observed 401 class of failure is removed
  rather than monitored.
- In the preferred in-cluster form (D2), the profile fetch never reaches the
  public edge at all — matching the `routing: INTERNAL` OSC itself models for
  Encore→object store (C2) — so it is also unaffected by edge TLS, the
  self-signed-cert problem that forced the TLS relaxation in
  `nodeSelfProbeFetch`/`selfProbeHttpsAgent` (#337), and public ingress latency.
- **A catalog deploy gets operator-managed profiles by default.** Today it
  cannot have them at all without hand-typing a parameter-store URL, because the
  manifest exposes no key for either env-var tier (C9). This change makes the
  profile store work without any OSC manifest change, and removes the product's
  dependency on #285 landing.
- Nothing new is invented: the bucket policy is the shipped `#199` policy (C6),
  the endpoint resolution is the shipped probed/fail-soft resolver (C7), and the
  index format is the one the `GET /index.yml` handler in `profiles.ts` already
  emits.
- The app's `/api/v1/profiles` surface and its `x-profile-count` monitoring
  contract (#460) are untouched.
- #1103's periodic probe is retired before it is built (D4) — but the probe's
  existing call site is corrected rather than left mis-scoped.

**Negative / trade-offs:**

- **Profile updates stop being instantaneous.** Today `GET /index.yml` renders
  live from CouchDB (the handler in `profiles.ts`), so a profile edit is visible to the
  next Encore fetch immediately. With D1 a profile write must also be
  **published** as objects, which introduces a window — and a possible
  divergence — between the store and the bucket. Mitigations are mandatory in
  the implementation issue: publish on every mutation (create/update/delete/
  bootstrap), a reconcile sweep that republishes from the store, and
  publish-verification (D4). Encore instances are spawned per workload and read
  `profilesUrl` at startup, so the practical requirement is only that publish
  completes before the next spawn — not that it is synchronous with the edit.
- **One more provisioning step and one more bucket** per stack, each a
  best-effort step that must not fail an otherwise-healthy re-provision — the
  same constraint the step-*1d* policy block in `provision.ts` already lives
  with.
- **Operator profile YAML becomes anonymously readable by exact key** at the
  public object-store origin, where today it is readable only through an app
  path that is *supposed* to be gated. Accepted and bounded in D3.
- **The resolver grows a fifth tier.** `resolveEncoreProfilesUrl` is already a
  four-tier chain; a fifth increases the number of states an operator must reason
  about. Mitigated by logging the **resolved tier and URL** at boot (the same
  resolved tier D4 needs), and by keeping the existing
  `'profiles URL unresolved to local store …'` warning in `src/main.ts` for the
  nothing-resolved case.
- **Pre-existing stacks** have no profiles bucket until re-provisioned. They fall
  through to tier 3, i.e. exactly today's behaviour — so the change is
  back-compatible, but the benefit only lands after a re-provision. The
  implementation issue must make this explicit in the release note.

---

## 5. Follow-up implementation issues to file

1. **`feat: publish the Encore profile index to a dedicated object-store bucket and make it the primary profilesUrl`** — D1, D2, D3. The substance of the closed #110, which this ADR adopts and these issues supersede as the tracking work.
2. **`feat: provision an anonymous-read openvideocore-profiles bucket as part of stack provisioning`** — the provisioning half of D3, split out because it changes `src/routes/provision.ts` and the teardown path rather than the profiles/resolver path.
3. **`fix: scope the profiles reachability probe to the resolved profilesUrl tier`** — D4, re-scoping #1103 (reject its periodic-probe scope; correct the mis-scoped call site and extend the boot check to the object-store primary). Must ship with issue 1, since D2's new tier is what mis-scopes the existing call site.

Exact titles and bodies are handed to the orchestrator with this ADR. **This ADR
files no issues itself.**

---

## 6. Out of scope

- Implementing the publisher, the bucket, the policy, or the resolver tier — D1's
  and D2's implementation issues own those (`surface-data-pipeline` /
  `surface-infra` / `surface-backend-api`).
- Changing the `/api/v1/profiles` HTTP contract in any way, including the
  `x-profile-count` header (#460) and the `{}`-for-empty body (#459).
- Profile content concerns: runnability filtering (#286), colour-signalling
  validation, and the built-in profile seed set (#385).
- Any change to the source or packaged bucket policies (#199) or to delivery
  mode (#200/#201/#859/#860).
- The external-endpoint capability gap for source/packaged storage —
  `ADR-021-external-s3-endpoint-source-and-packaged.md`.

---

## 7. Acceptance mapping (issue #1102)

| #1102 asks for | Where |
|---|---|
| Introspect the live OSC catalog + relevant service schemas; cite contract source and exact fields | §2 (C1–C9), each with the live query that produced it and the exact field names |
| Compare the two approaches on reliability, operational cost, profile update flow, fit with OSC | Summary table (reliability/assertability), §4 Negative (operational cost, update flow), C2/C4/C6/C7 (fit with OSC) |
| Write `docs/architecture/ADR-NNN-profiles-url-source.md` with a decision and consequences | this file (`ADR-026-profiles-url-source.md`); decision §3, consequences §4 |
| Log any partial/missing OSC capability, e.g. a way to guarantee a public path exemption | written 2026-10-08 in the agents repo at `eng-open-videocore-agents/docs/osc-feedback/incoming-profiles-url-public-path-exemption.md`, pushed on branch `osc-feedback/profiles-url-public-path-exemption` (separate repository, so not in this PR's diff) |
| If the decision is #284, the probe must become continuous; if #110, open an implementation issue and mark the probe work obsolete | decision is the **#110 direction** → D4 rejects #1103's periodic scope and re-scopes it to the required call-site correction; §5 lists the implementation issues |

---

## 8. References

- Issues: #1102 (this ADR), #110 (object-store-served profiles — **CLOSED**;
  direction adopted here and superseded by §5's issues), #284 (derived base URL
  + boot probe — **CLOSED**; demoted to a fallback here), #1103 (**OPEN**;
  periodic probe rejected, re-scoped by D4), #84, #219, #283, #315, #337, #459,
  #460, #199, #200, #201, #859, #860, #991.
- ADRs: ADR-003 (auth terminated at the edge),
  `ADR-021-external-s3-endpoint-source-and-packaged.md` (external S3 endpoint
  blocker — the same "pin the platform gap with verified contracts" method; note
  that `ADR-021-audit-log-retention.md` shares the number and is **not** the one
  meant here), ADR-023 §2.1 (the live-MCP introspection method reused in §2).
- OSC catalog (live, 2026-10-04, re-confirmed 2026-10-08 at osc-remote-mcp
  8.14.1 for C1/C2/C4/C9, via `https://mcp.osaas.io/mcp` +
  `/mcp/category/{apps,instances,storage,pages}`):
  `get-service-schema(serviceId: "encore", verbosity: "detailed")` →
  `profilesUrl`, `serviceAssociations[0].routing = "INTERNAL"`,
  `supportsUpdate: false`;
  `get-service-schema(serviceId: "minio-minio", verbosity: "detailed")` →
  `name`/`RootUser`/`RootPassword`;
  `get-service-schema(serviceId: "eyevinn-open-videocore", verbosity: "detailed")`
  → 10 config options, none of them a public-base-URL or profiles-URL key
  (C9), `supportsUpdate: false`;
  `list-available-services(category: "storage")` → `minio (minio-minio)`,
  required config `name`;
  `set-instance-public-access` (TCP-only; SSO auth gate is orchestrator-level);
  `set-storage-bucket-public`, `create-storage-bucket`,
  `upload-object-to-bucket`; `create-my-app` (34-tool `apps` surface, no auth
  field); the My Page tool family.
- OSC service OpenAPI (live): `https://api-minio-minio.auto.prod-se.osaas.io/docs/json`
  — `POST /minioinstance` body `{ name, RootUser, RootPassword }`;
  `GET /internal-endpoint/{id}` → `{ serviceDns, ports, publicAccess }`.
  Subscription catalog: `GET https://catalog.svc.prod.osaas.io/mysubscriptions`
  (header `x-pat-jwt: Bearer <PAT>`).
- SDK: `node_modules/@osaas/client-core/lib/core.d.ts`
  (`InternalEndpointInfo`, `getInternalEndpoint`),
  `lib/myapp.d.ts` (`MyApp`, `CreateMyAppBody`),
  `lib/context.js` (`x-pat-jwt` header), package version 0.24.0.
- Code (verified contracts — **symbol names, no line numbers**; each `grep`-verified
  on this branch after merging `main`, 2026-10-08):
  - `src/services/public-base-url.ts` — `resolvePublicBaseUrl`,
    `LOCAL_PROFILES_INDEX_PATH`, `resolveEncoreProfilesUrl` (the precedence
    chain, including the `${base}${LOCAL_PROFILES_INDEX_PATH}` derivation),
    `STACK_ENCORE_PROFILES_URL_FIELD`,
    `resolveEncoreProfilesUrlFromParamStore`.
  - `src/main.ts` — `encoreProfilesUrl` / `ENCORE_PROFILES_URL` (remote
    default), `publicBaseUrl`, the parameter-store tier read,
    `encoreScalerProfilesUrl`, the `'profiles URL unresolved to local store …'`
    warning, `profilesUrl: encoreScalerProfilesUrl` on the scaler config, and
    the one-shot `checkProfilesIndexReachable(...)` call site after
    `app.listen`.
  - `src/routes/profiles.ts` — `profilesRouter` (header comment: *"This whole
    router is unauthenticated by design …"*), the `'/index.yml'` route and its
    `x-profile-count` header, the `'/:name/yaml'` route.
  - `src/services/profiles-reachability.ts` — `selfProbeHttpsAgent` +
    `nodeSelfProbeFetch` (scoped TLS relaxation), `ReachabilityOutcome`,
    `checkProfilesIndexReachable` (non-fatal by design per its doc comment; the
    `!profilesIndexUrl || !usingLocalIndex` short-circuit; the `auth-wall`
    401/403 branch).
  - `src/encore-scaler/instance-pool.ts` —
    `instanceBody['profilesUrl']` on the OSC create body.
  - `src/routes/provision.ts` — `SOURCE_BUCKET` / `PACKAGED_BUCKET`, the step
    *1d* comment (*"Apply an anonymous (public) read-only bucket policy …"*),
    the `packagedPolicy` JSON and `setBucketPolicy(PACKAGED_BUCKET, packagedPolicy)`.
  - `src/routes/assets.ts` — the comment block recording that the stack's own
    object-store endpoint *"IS the public origin for"* its packaged bucket, and
    the *"env-override and in-memory paths"* exclusion.
  - `src/services/internal-minio-endpoint.ts` — module header (live-verified
    in-cluster derivation, 2026-09-29/30), `DEFAULT_INTERNAL_PORT`,
    `INTERNAL_HEALTH_PATH`, `selectInternalPort`, `makeInternalEndpointProbe`,
    `makeInternalEndpointResolver`, `resolveInternalEndpointSettings`; consumer
    `resolveEncoreS3Config` in `src/services/encore-s3-config.ts`.
  - `src/services/param-store.ts` — the `StackConfig` type's `minioEndpoint`,
    `services`, and `encoreProfilesUrl?` fields.
- OSC feedback — in this repo, `docs/osc-feedback/`:
  `incoming-issue285-manifest-profiles-url-override.md` (no manifest key for
  `PUBLIC_BASE_URL` / `ENCORE_PROFILES_URL_OVERRIDE`, still true live — C9),
  `incoming-app-self-url-discovery.md` (#219/#283: no runtime self-URL),
  `incoming-presigned-get-thumbnails.md` / `incoming-presigned-playback-segments.md`
  (presigned-GET friction).
- OSC feedback — in the agents repo, `eng-open-videocore-agents/docs/osc-feedback/`:
  `incoming-08-login-wall-blocks-encore-profile-fetch.md` (the original 401 +
  the unconfirmed 2026-07-08 assurance), `incoming-minio-presigned-blocked.md`
  (presigned GET 403 through the public reverse proxy),
  `incoming-profiles-url-public-path-exemption.md` (written 2026-10-08 with this
  ADR: the C3 capability gap, plus the `getInternalEndpoint` → `ports: []` gap
  C7 found recorded only in a code comment).
