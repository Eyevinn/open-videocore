# Vendored service contracts

Machine-readable contracts for the OSC services this API calls, copied here
**byte-identically** from their upstream source and pinned to a commit. They exist
because the OSC catalog publishes only a service's *provisioning* config
(`get-service-schema` → the fields needed to create an instance), never the runtime
request/response shape — so there is nothing else a contract test can be written
against. See the friction log in the agents repo,
`docs/osc-feedback/incoming-catalog-no-machine-readable-runtime-contract.md`.

A snapshot here is the input to a test, not documentation: the test diffs the
contract our code has recorded against the snapshot, so a refresh that changes
anything material fails CI and has to be dealt with deliberately.

| File | Upstream | Pinned commit | Consumed by |
|---|---|---|---|
| `eyevinn-function-scenes-api.json` | [`Eyevinn/function-scenes`](https://github.com/Eyevinn/function-scenes) `api.json` — the OpenAPI 3.0 document the function serves at `/api/docs/` | `492a18f23e253194c27800563ea0c96bef187aef` (`master` HEAD on 2026-09-26) | `src/pipeline/function-scenes-contract.ts`, `test/scene-detect-contract.test.ts` |

## Refreshing a snapshot

```bash
curl -sS -o docs/contracts/eyevinn-function-scenes-api.json \
  https://raw.githubusercontent.com/Eyevinn/function-scenes/<sha>/api.json
npx vitest run test/scene-detect-contract.test.ts
```

Update the pinned commit in the table above **and** in
`FUNCTION_SCENES_CONTRACT_SOURCE` (`src/pipeline/function-scenes-contract.ts`) in
the same change. If the test now fails, the service has changed under us: fix the
recorded contract and the call together — do not relax the test.

Keep the file exactly as upstream serves it (no reformatting), so a refresh diff
shows only what the service actually changed.
