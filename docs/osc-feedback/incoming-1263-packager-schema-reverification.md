# OSC friction — packager service schema still not re-verifiable (issue #1263)

**Date:** 2026-11-04
**Reporter:** surface-backend-api agent
**Context:** Issue #1263 (encrypting packaging runner port). Part 4 of the issue
asked for a re-verification of the `eyevinn-encore-packager` create-service
config body against the live service schema, because the port's capability
answer (`NO_ENCRYPTION_CAPABILITY`, `src/pipeline/packaging.ts`) asserts that
the service exposes no encryption field anywhere.

This is the follow-up to
`incoming-epic226-ondemand-packager-schema.md` (epic #226, 2026-07-13), which
recorded the same blocker four months earlier. It is still open.

## What I needed

CLAUDE.md rule 7: fetch the live contract before asserting anything about it.
Concretely, the `get-service-schema` answer for `eyevinn-encore-packager`, to
confirm two claims:

1. the create-service config field set hardcoded in
   `src/services/packager-provisioning.ts` has not drifted; and
2. the service still exposes **no** encryption-related config field, which is
   what makes "this deployment's packaging runner cannot encrypt" an honest
   capability answer rather than an assumption.

## Friction

Neither route to the schema worked from the authoring context:

- **MCP route.** The OSC MCP service-schema tool was not invokable. The tool
  set available to this agent is file and shell tools only; the documented
  discovery/dispatch path (search for the tool, then call it through the
  dispatcher) returns *"No such tool available"* for the schema tool in this
  context. Same symptom class as epic #226 recorded in July, so this is not a
  transient outage — the schema tool is simply not reachable from a
  surface-agent context.
- **Direct catalog API route.** `GET https://catalog.svc.prod.osaas.io/service/<serviceId>`
  exists (an unknown path answers `404`, this one does not) but rejects the
  access token available in the environment with
  `401 {"error":"invalid authorization header"}` for every header form tried
  (`Authorization: Bearer <token>`, `Authorization: <token>`, `x-pat`,
  `x-jwt`). There is no documented, stable, publicly described auth contract
  for reading a service's config schema out of band of the MCP tool, so there
  is no second source to fall back on.

Net effect: an agent that is *required* to verify a contract before writing a
call has no reachable way to read the authoritative schema of an OSC service.

## Impact

- Nothing was changed on a guess: the create body in
  `src/services/packager-provisioning.ts` was left exactly as contract-verified
  when written, and the only verification possible was a static
  cross-reconciliation between the two in-repo code paths that name the
  service's fields, now pinned as
  `test/packager-create-body-field-reconciliation.test.ts`.
- The "no encryption support" capability answer therefore rests on reading the
  service's own published source (its config module and its queue listener),
  not on the catalog schema. That is weaker evidence than the schema: a config
  field added upstream would not be noticed until a release diff.
- Every future agent touching an OSC service config body pays the same cost and
  is pushed toward either guessing or stalling.

## What would fix it

Either of:

1. Make the service-schema read available to any context that already holds a
   valid OSC access token — e.g. a documented, token-authenticated HTTP read of
   a service's config schema, so verification does not depend on a specific
   agent tool set being enabled.
2. Publish each service's config schema as a versioned artefact alongside the
   service (checked into its repo, or served at a stable unauthenticated URL),
   so it can be fetched, diffed and pinned in CI.

Option 2 is the more useful of the two: it would let a consumer *pin* the schema
and fail its own build on upstream drift, which is what contract-first actually
needs.
