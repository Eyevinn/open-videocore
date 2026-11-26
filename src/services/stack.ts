// Single source of truth for the set of OSC services that make up an
// open-videocore stack. Both provision (POST) and deprovision (DELETE) derive
// the instance set from this list.
//
// A stack has no separately persisted state: every instance in a stack shares
// the same instance name (the stack name). To enumerate a stack's instances we
// combine this service list with the stack name. To remove a stack we remove
// every instance with that name across these services.

// The stack's services in PROVISION (creation) order. Producers come first,
// consumers last — storage and the queue are created before the engines that
// depend on them.
//
// Roles (for documentation / friction logging):
//   storage    — MinIO (S3-compatible object storage)
//   database   — CouchDB (document metadata store)
//   queue      — Valkey (Redis-compatible coordination backbone)
//
// Encore and its paired callback listener are NOT part of the provisioned
// stack: the auto-scaler spawns each Encore instance together with a dedicated
// callback listener pointing at that exact instance, and tears both down on
// scale-down (ADR-006).
//
// The Encore packager (eyevinn-encore-packager) is ALSO no longer part of the
// provisioned stack (epic #226 / issue #243): it is provisioned LAZILY, on the
// first pipeline execution that includes a packaging step, and torn down on
// stack deprovision (and optionally when idle). See PACKAGER_SERVICE_ID and the
// on-demand ensure step (issues #244–#246). Removing it from STACK_SERVICES
// means a freshly provisioned stack creates NO packager instance and mints no
// packager secrets/tokens until packaging is actually used — the shared queue
// (valkey-io-valkey), database and storage are unaffected.
// The object-store serviceId. Exported as its own constant (rather than only
// living inline in STACK_SERVICES below) because two other paths need to match
// on it by identity rather than by position: the deprovision ordering, and the
// #991 in-cluster endpoint lookup, which finds the stack's object-store
// instance name in `StackConfig.services` (services/param-store.ts) to call
// `getInternalEndpoint(context, serviceId, instanceName, token)`. On the
// platform the Kubernetes namespace an instance runs in is named after its
// serviceId, so this string is also the object store's namespace.
export const OBJECT_STORE_SERVICE_ID = 'minio-minio' as const;

// The queue (Valkey) serviceId. Exported as its own constant for the same
// reason as OBJECT_STORE_SERVICE_ID above: paths that must match this service
// BY IDENTITY rather than by position in STACK_SERVICES. The teardown reporting
// in routes/provision.ts uses it to read what a run established about the
// stack's queue instance specifically (issue #1213) — the stack's scaler state,
// its callback completions and its packaging hand-off all live on this store,
// so "is it still there?" decides what background work may stay bound to it.
export const QUEUE_SERVICE_ID = 'valkey-io-valkey' as const;

export const STACK_SERVICES = [
  { serviceId: OBJECT_STORE_SERVICE_ID, role: 'storage' },
  { serviceId: 'apache-couchdb', role: 'database' },
  { serviceId: QUEUE_SERVICE_ID, role: 'queue' }
] as const;

// The Encore packager consumes the shared Valkey queue and writes CMAF output
// to the packaged bucket. It is NOT in STACK_SERVICES (see above): it is
// provisioned on demand at first packaging execution (issue #244) and torn down
// on deprovision (issue #246). Exported here as the single source of truth for
// its serviceId so the on-demand ensure/teardown paths never hardcode the
// string (mirrors the FFPROBE_SERVICE_ID / AUTO_SUBTITLES_SERVICE_ID pattern).
export const PACKAGER_SERVICE_ID = 'eyevinn-encore-packager' as const;

// The human-readable role reported for the packager in a teardown result. The
// on-demand packager is torn down from TWO places — the static TEARDOWN_ORDER
// below (store-less path) and teardownOnDemandPackager (the ground-truth
// reconciliation used when it is absent from the stored services[]). Both fold
// into the SAME per-service result list, so the role must be identical in both
// or the merged entry would be incoherent. Exported as one constant rather than
// repeating the literal (issue #1056).
export const PACKAGER_TEARDOWN_ROLE = 'packaging' as const;

// A stack service descriptor: the OSC serviceId plus its human-readable role.
// This is a structural supertype of the STACK_SERVICES entries (which narrow to
// literal serviceId/role via `as const`). It is deliberately widened to string
// so descriptors that are NOT provision-time members can still be modelled —
// e.g. the teardown-only Encore packager below and the synthetic entries built
// from the stored config in deprovision.ts (orderStoredServices). Consumers only
// read serviceId/role as strings, so the widening is safe.
export type StackService = { serviceId: string; role: string };

// eyevinn-ffmpeg-s3: the ephemeral ffprobe/ffmpeg runner used by the technical
// metadata extraction pipeline (issue #6). It is NOT part of the long-lived
// provisioned stack above — it is invoked per-extraction as an ephemeral job
// against a presigned MinIO object URL — so it is exported separately rather
// than added to STACK_SERVICES.
export const FFPROBE_SERVICE_ID = 'eyevinn-ffmpeg-s3' as const;

// eyevinn-auto-subtitles ("Subtitle Generator"): the Whisper-based transcription
// service used by the OPTIONAL auto-subtitles pipeline step (issue #114). Unlike
// eyevinn-ffmpeg-s3 (an ephemeral job runner), this is a LONG-LIVED service
// instance called over HTTP at its instance URL (see pipeline/osc-auto-subtitles.ts).
// It is NOT part of the long-lived provisioned stack above — it is an opt-in
// consumer service, provisioned/configured separately (it needs an OpenAI key) —
// so it is exported separately rather than added to STACK_SERVICES (mirrors the
// FFPROBE_SERVICE_ID treatment).
//
// Contract source: get-service-schema for `eyevinn-auto-subtitles`.
// create-service-instance config: required `name` (^\w+$) and `openaikey`;
// optional awsAccessKeyId/awsSecretAccessKey/awsRegion/s3Endpoint. Exposes a
// `/transcribe/s3` endpoint for S3 sources; does NOT support config updates.
export const AUTO_SUBTITLES_SERVICE_ID = 'eyevinn-auto-subtitles' as const;

// NOTE (issue #1193): there is no scene-detection SERVICE ID here any more. The
// OPTIONAL scene/shot-detection step (issue #115) runs as an ephemeral
// FFPROBE_SERVICE_ID job (pipeline/osc-scene-detect-ffmpeg-s3.ts) decided by
// ADR-027 D1, so the slot needs no long-lived instance, no provisioning and no
// teardown obligation. The dedicated media function that previously held the
// slot could not return cut timecodes through any documented endpoint
// (docs/investigations/797-function-scenes-runtime-contract.md) and was retired
// with its lazy-provisioning wiring in #1193.

// Teardown order is the reverse of provision order: consumers are removed
// before the producers they depend on (packager -> queue -> database ->
// storage). This avoids tearing a producer out from under a still-running
// consumer.
//
// The on-demand Encore packager (PACKAGER_SERVICE_ID) is provisioned LAZILY and
// so is deliberately absent from STACK_SERVICES (issue #243) — but it MUST still
// be torn down on deprovision (issue #246), and BEFORE the shared Valkey queue
// and storage it consumes. It has no corresponding provision-time entry, so we
// prepend it here as a teardown-only consumer at the head of the order rather
// than adding it to STACK_SERVICES (which would re-provision it eagerly and make
// stack-readiness demand a packager instance). Teardown is idempotent — a stack
// that never ran packaging has no packager instance, and teardownService reports
// that serviceId as not_found (a success), so this is safe whether or not
// packaging ever executed. role 'packaging' matches the pre-#243 provision entry.
const TEARDOWN_ONLY_PACKAGER: StackService = {
  serviceId: PACKAGER_SERVICE_ID,
  role: PACKAGER_TEARDOWN_ROLE
};

export const TEARDOWN_ORDER: readonly StackService[] = [
  TEARDOWN_ONLY_PACKAGER,
  ...[...STACK_SERVICES].reverse()
];
