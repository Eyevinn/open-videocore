# OSC friction — on-demand packager provisioning (epic #226, issues #244–#246)

**Date:** 2026-07-13
**Reporter:** surface-infra agent
**Context:** Implementing lazy (on-demand) provisioning of `eyevinn-encore-packager`.

## What I needed

CLAUDE.md rule 7 and the epic's acceptance criteria require fetching the live
`get-service-schema` for `eyevinn-encore-packager` (and, if a paired
callback-listener is required and NOT auto-scaler-managed, discovering its
serviceId via `list-available-services` and fetching that schema too) before
writing the on-demand `create-service-instance` call.

## Friction

In the execution context available to this agent, the OSC MCP tools
(`get-service-schema`, `list-available-services`) could not be loaded:

- `ToolSearch` (the documented mechanism to select/enable
  `mcp__OSC__get-service-schema` and `mcp__OSC__list-available-services`)
  returned: *"No such tool available: ToolSearch. ToolSearch exists but is not
  enabled in this context."*
- No OSC MCP tool was directly invokable.
- The `@osaas/client-core` SDK ships no generated per-service schema/types for
  the packager (`node_modules/@osaas` contains only `client-core`), so the live
  contract was not reachable offline either.

## How I stayed contract-grounded anyway (no invented fields)

I did NOT invent any field name. The authoritative `create-service-instance`
config body for `eyevinn-encore-packager` already exists in the repository,
contract-verified when the *eager* provisioning path was written, at:

`src/routes/provision.ts:575-584` — the `provision('eyevinn-encore-packager', {...})`
call, with these exact fields:

- `RedisUrl` (Valkey connection string)
- `RedisQueue` (`'encore-packager:jobs'` — must match `packagerQueueKey()` in
  `src/pipeline/osc-packager-queue.ts`)
- `OutputFolder` (`s3://<packagedBucket>/`)
- `PersonalAccessToken` (OSC PAT, as a `{{secrets.*}}` ref)
- `AwsAccessKeyId` (`'admin'`)
- `AwsSecretAccessKey` (MinIO root password, as a `{{secrets.*}}` ref)
- `S3EndpointUrl` (MinIO endpoint)
- `CallbackUrl` (optional; `<publicBaseUrl>/api/v1/internal`)

The on-demand ensure-step reuses this exact field set (same source of truth),
so no field name is guessed. When the OSC MCP becomes reachable in a future
session, re-verify this body against the live `get-service-schema` and reconcile
any drift.

## Callback-listener note

The packager's callback in the eager path is delivered via the `CallbackUrl`
HTTP callback (to `/api/v1/internal`), NOT via a separately provisioned
`eyevinn-encore-callback-listener` instance. The `eyevinn-encore-callback-listener`
that IS provisioned in this system is the Encore (transcode) listener, spawned
per-Encore-instance by the auto-scaler (see `src/encore-scaler/instance-pool.ts`
and ADR-006) — it is NOT the packager's listener. Therefore the on-demand
packager does NOT need a separately provisioned callback-listener: it uses the
HTTP `CallbackUrl`. No double-provisioning is performed.

## Requested capability

A read-only way to fetch a service's provisioning JSON schema from within
constrained agent contexts (e.g. an offline snapshot committed alongside the
SDK, or MCP tools reliably available), so contract-grounding does not depend on
ToolSearch being enabled.
