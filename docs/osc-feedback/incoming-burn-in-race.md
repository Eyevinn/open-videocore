# OSC friction — burn-in vs fire-and-forget subtitle-generation race (issue #389)

**Logged by:** surface-backend-api (claude-opus-4-8)
**Date:** 2026-08-22
**Related:** #387 (ADR-014), #388 (burn-in implementation), #389 (this race close)
**Prior log:** docs/osc-feedback/incoming-burn-in-contract.md (items 1 + 2)

## Context

Issue #389 closes the race where a burn-in-opted transcode could dispatch
against a caption sidecar that had been NAMED (a resolvable object key) but whose
bytes had not yet LANDED in the workspace object store — because subtitle
generation runs fire-and-forget from ingest and its completion callback may not
have arrived when the transcode is submitted. The fix verifies the resolved
object actually exists (and is non-empty) via `WorkspaceStorage.statObject`
(src/data/storage.ts:92-102) before dispatch, failing the submission with a clear
409 `burn_in_source_not_available` otherwise.

Two OSC-service assumptions surfaced during this work and are logged here per the
OSC-friction rule (CLAUDE.md #6).

## Friction 1 — `/transcribe/s3` wire shape is still unverified against a stable contract

- Issue #389's implementer note and ADR-014 (open dependency 3) both flag that
  the `/transcribe/s3` (Subtitle-Generator) body diverges between the external
  doc (`{ url, language, format, bucket, key }`, source: docs.osaas.io
  Subtitle-Generator) and our in-repo runner (`{ url, format, outputKey }`,
  src/pipeline/osc-auto-subtitles.ts:59-69). The `key` field is described as
  caller-controlled.
- **This issue deliberately does NOT depend on the service's output/callback
  state.** It checks the ACTUAL S3 object key against the workspace object store,
  not generation-request state, precisely because the fire-and-forget callback
  may not have landed and the wire shape carries no stability guarantee. So the
  divergence does not block #389, but it remains unverified: if the service ever
  writes to a key other than the `outputKey`/`objectKey` we compute
  (subtitle-generator.ts:101-103), our existence check would correctly report the
  sidecar as absent and a caller would see a 409 for a sidecar that "exists"
  under a different key. That would be a service/contract mismatch, not a bug in
  this enforcement.
- **Ask for OSC:** publish a stable, versioned contract for the
  Subtitle-Generator `/transcribe/s3` request AND response, and pin whether the
  service writes to exactly the caller-supplied `key`/`outputKey` (no
  service-side key rewriting/suffixing). Until then we treat the in-repo computed
  key as authoritative (ADR-014 C3) and gate dispatch on its real presence.

## Friction 2 — object-store presence/HEAD semantics are inferred, not contract-guaranteed

- The existence check relies on `WorkspaceStorage.statObject` returning
  `undefined` for a NotFound object and `{ size, etag }` otherwise
  (src/data/storage.ts:92-102), which maps to MinIO `statObject` throwing a
  `code === 'NotFound'` error. This is the same presence plumbing the rest of the
  routes use, but the exact error `code` string for a missing object on the OSC
  MinIO deployment is an inferred contract, not a documented one.
- **Empty-object semantics:** we treat a zero-length object as not-available
  (same 409), because an empty sidecar burns no captions. This assumes the OSC
  object store reports `size: 0` for a truncated/aborted upload rather than
  omitting the object entirely — both are handled (absent OR empty), so the
  guarantee holds either way, but the size reporting for a partially-written
  object is not contract-guaranteed.
- **Ask for OSC:** confirm the MinIO NotFound error `code` string and the
  size-reporting behaviour for a zero-length / interrupted upload on the OSC
  deployment, so the presence check does not depend on inferred error shapes.

## Guarantee that holds regardless

Whichever way the two ambiguities above resolve, the observable guarantee is
preserved: a burn-in rendition is NEVER dispatched unless a non-empty object
exists at the resolved key at submit time. Absent/empty/partial => clear 409,
no Encore submit.
