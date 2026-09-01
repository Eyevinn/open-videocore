# Investigation 478 — why `asset-upload.ts` routes are absent from `openapi.json`

Status: diagnosis complete (no production code changed — see issue #479 for the fix).

## Summary

The seven `asset-upload.ts` routes are absent from the generated `openapi.json`
because the router is registered inside a runtime `if (storageAvailable)` guard,
and `storageAvailable` evaluates `false` in the spec-generation environment (no
`MINIO_URL` and no parameter store). Since the plugin is never registered, its
routes are never added to Fastify's route tree, and the `@fastify/swagger` plugin
— which builds the OpenAPI document purely from the routes that were registered —
has nothing to emit for them. Every other router in `src/routes/` registers
unconditionally, so they always reach the spec.

## Confirmed mechanism (root cause)

Cause **(a): conditional `storageAvailable` registration.** Specifically:

- `src/main.ts:412` computes
  `const storageAvailable = Boolean(process.env['MINIO_URL']) || Boolean(paramStore);`
- `src/main.ts:1282-1289` registers the upload router only when that flag is true:

  ```ts
  if (storageAvailable) {
    await app.register(assetUploadRouter, {
      prefix: '/api/v1/assets',
      repository: assetRepository,
      storageFor,
      onObjectStored
    });
  }
  ```

- `scripts/generate-openapi.sh:12` boots the server with
  `node --env-file-if-exists="$ROOT/.env" ...`. When `.env` is absent the process
  starts with no storage variables, so `process.env['MINIO_URL']` is unset. The
  parameter store also resolves to `undefined` without
  `PARAMETER_STORE_API_KEY` (`src/main.ts:208-221`), so `paramStore` is falsy.
  Both operands of the OR at line 412 are therefore false and
  `storageAvailable === false`.

With the flag false, `app.register(assetUploadRouter, ...)` is never called, the
seven routes are never added to the route tree, and `@fastify/swagger` (registered
at `src/main.ts:133-160` with `transform: jsonSchemaTransform`) produces a document
without them. Swagger's document is derived from registered routes at the moment
`/api-docs/json` is served — it cannot include routes that were never registered.

## Why the other routers DO appear

`assetsRouter` — which shares the same `/api/v1/assets` prefix — is registered
**unconditionally** at `src/main.ts:1184` (`await app.register(assetsRouter, assetRouterOptions);`).
It does not gate on storage; instead it degrades a single option:
`storageFor: storageAvailable ? storageFor : undefined` (`src/main.ts:1165`). The
router object is always registered, so all of its routes always reach the spec even
when storage is absent. Every other router (`jobsRouter` 1192, `pipelinesRouter`
1202, `searchRouter` 1403, `webhooksRouter` 1406, `collectionsRouter` 1410,
`storageRouter` 1420, etc.) follows this same unconditional-register pattern. The
upload router is the only one wrapped in an `if` guard, which is the single
registration difference that explains the omission.

## Ruled-out causes

- **(b) Missing route schemas — ruled out.** All seven handlers in
  `src/routes/asset-upload.ts` carry a `schema:` block:
  `app.put` (line 134, `schema` at 139), `app.post` upload-url (172, schema 174),
  `app.post` multipart/initiate (189, schema 193), `app.get` part-url (210, schema
  214), `app.post` complete (241, schema 245), `app.delete` (268, schema 272),
  `app.post` upload-complete (290, schema 294). Schemas are present, so this is not
  a "route silently skipped for lack of a schema" case.
- **(c) Plugin encapsulation / type-provider scope — ruled out.**
  `assetUploadRouter` is a standard
  `FastifyPluginAsync<AssetUploadRouterOptions>` using
  `fastify.withTypeProvider<ZodTypeProvider>()` (`src/routes/asset-upload.ts:101-107`),
  identical to `assetsRouter` (`src/routes/assets.ts:13-14` import the same
  `FastifyPluginAsync` and `ZodTypeProvider`). When the guard is satisfied the
  routes DO appear (see reproduction), so encapsulation is not the blocker.
- **(d) Routes registered after the spec is captured — ruled out.** The
  registration `await`s during boot (`src/main.ts:1282`), well before the server
  begins serving `/api-docs/json`. Ordering is not the issue; the block simply
  never runs.

## Reproduction

Booting the server (with the two unrelated provision prerequisites
`MINIO_ROOT_PASSWORD` / `COUCHDB_ADMIN_PASSWORD` set so `provisionRouter` at
`src/routes/provision.ts:399` does not abort boot) and scraping
`/api-docs/json` in two configurations:

| Configuration            | Total paths | Upload paths present |
| ------------------------ | ----------: | -------------------- |
| No `MINIO_URL` (as CI)   |          73 | 0 (none)             |
| `MINIO_URL` set          |          80 | 7                    |

The delta is exactly the seven upload routes, and nothing else:

```
POST   /api/v1/assets/{id}/multipart/initiate
DELETE /api/v1/assets/{id}/multipart/{uploadId}
POST   /api/v1/assets/{id}/multipart/{uploadId}/complete
GET    /api/v1/assets/{id}/multipart/{uploadId}/part-url
PUT    /api/v1/assets/{id}/upload
POST   /api/v1/assets/{id}/upload-complete
POST   /api/v1/assets/{id}/upload-url
```

Setting `MINIO_URL` flips `storageAvailable` to true, the `if` block runs, and all
seven routes appear with their schemas intact — confirming the guard is the sole
determinant.

## Recommended fix direction for #479 (not implemented here)

The goal for #479 is to make the OpenAPI document describe the API's full surface
regardless of the runtime storage configuration, while keeping the *runtime*
behaviour (upload paths only functional when storage is reachable). Options, in
rough order of preference:

1. **Register the router unconditionally and gate at the handler level** —
   mirror the `assetsRouter` pattern: always call
   `app.register(assetUploadRouter, ...)`, and inside the handlers respond `501`
   (or `503`) when `storageFor` / storage is unavailable, exactly as the sibling
   asset routes already degrade. This makes the routes always visible in the spec
   with no behavioural regression when storage is absent. This is the most
   consistent with the rest of `src/main.ts`.
2. **Register the router but pass a nullable `storageFor`** and let the existing
   error handling surface the unavailable state, analogous to
   `storageFor: storageAvailable ? storageFor : undefined` at `src/main.ts:1165`.
3. **Spec-generation-only override** — have `scripts/generate-openapi.sh` boot with
   a flag that forces all routers to register for documentation purposes. This is
   the least preferred: it diverges the documented surface from the runtime surface
   and adds a spec-only code path.

Whichever path #479 takes, the fix should also regenerate `openapi.json` so the
seven paths are committed, and ideally add a guard in CI/QA that fails if the
generated spec is missing known route groups.

## Evidence index (file:line)

- `src/main.ts:133-160` — `@fastify/swagger` registration with `jsonSchemaTransform`.
- `src/main.ts:208-221` — `paramStore` resolution; `undefined` without `PARAMETER_STORE_API_KEY`.
- `src/main.ts:412` — `storageAvailable` computation.
- `src/main.ts:1165` — `assetsRouter` degrades `storageFor` instead of skipping registration.
- `src/main.ts:1184` — `assetsRouter` registered unconditionally.
- `src/main.ts:1282-1289` — `assetUploadRouter` registered only inside `if (storageAvailable)`.
- `src/routes/asset-upload.ts:101-107` — router plugin/type-provider signature.
- `src/routes/asset-upload.ts:134,172,189,210,241,268,290` — the seven route handlers, each with a `schema:` block.
- `scripts/generate-openapi.sh:12` — server boot with `--env-file-if-exists` (no storage env in CI).
