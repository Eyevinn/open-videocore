# Contract gap — issue #162 references ADR-003 as "OSC auth-wall delegation"

**Date:** 2026-07-10
**Surface:** backend-api
**Issue:** #162 (feat: define read-only TAMS gateway client interface and
configuration surface; sub-task of #151, epic #116)
**Related contract:** ADR-008 (pinned #150 contract), ADR-001, ADR-003

## What we needed

Issue #162 instructs deriving the config surface's OSC access-token threading
"per ADR-003 OSC auth-wall delegation".

## Friction / gap

The `ADR-003` present in this repo is **"Delivery and CDN integration"**
(`docs/architecture/ADR-001-osc-stack.md`, follow-up ADR list line 165), not an
OSC auth-wall delegation ADR, and no standalone `ADR-003-*` auth-wall file
exists (`docs/architecture/` contains only ADR-001, ADR-007, ADR-008). So the
ADR-003 citation in the issue does not resolve to an auth-wall document here.

## How it was resolved (no guessing)

The auth model is nonetheless pinned by the actual contracts, so no shape was
invented:

- **ADR-008 "Authentication" (lines 117-122):** behind the OSC ingress gate the
  gateway leaves `API_TOKEN` unset and lets the OSC gate authenticate callers;
  the read client "should therefore reach the instance through the OSC
  auth-wall / delegated OSC service token ... not via a TAMS-specific
  `API_TOKEN`."
- **ADR-001 open question 2 (RESOLVED 2026-06-01):** "Gated behind OSC
  login-wall. `OSC_ACCESS_TOKEN` is the operator's credential; open-videocore
  calls OSC APIs on their behalf."

The config surface (`TamsGatewayClientConfig.oscAccessToken`) was derived from
these two sections. The existing OSC client convention (Bearer SAT at the edge,
e.g. `src/pipeline/osc-scene-detect.ts`) matches.

## Recommendation

Update issue #162 (and any sibling issues) to cite ADR-008 "Authentication"
and/or ADR-001 open question 2 for the auth-wall delegation instead of ADR-003,
or author a dedicated auth-wall ADR and renumber. Low severity — the correct
contract was reachable — but the stale reference should be corrected to avoid a
future author dead-ending on a missing ADR-003.
