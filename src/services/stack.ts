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
export const STACK_SERVICES = [
  { serviceId: 'minio-minio', role: 'storage' },
  { serviceId: 'apache-couchdb', role: 'database' },
  { serviceId: 'valkey-io-valkey', role: 'queue' }
] as const;

// The Encore packager consumes the shared Valkey queue and writes CMAF output
// to the packaged bucket. It is NOT in STACK_SERVICES (see above): it is
// provisioned on demand at first packaging execution (issue #244) and torn down
// on deprovision (issue #246). Exported here as the single source of truth for
// its serviceId so the on-demand ensure/teardown paths never hardcode the
// string (mirrors the FFPROBE_SERVICE_ID / AUTO_SUBTITLES_SERVICE_ID pattern).
export const PACKAGER_SERVICE_ID = 'eyevinn-encore-packager' as const;

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

// eyevinn-function-scenes ("Scene Detect Media Function"): the serverless media
// function used by the OPTIONAL scene/shot-detection pipeline step (issue #115).
// It produces keyframe + scene-boundary metadata for the clip/trim workflows.
// Like eyevinn-auto-subtitles it is a resolvable instance called over HTTP at its
// instance URL (see pipeline/osc-scene-detect.ts), NOT an ephemeral job like
// eyevinn-ffmpeg-s3. It is NOT part of the long-lived provisioned stack above — it
// is an opt-in consumer function, provisioned separately — so it is exported
// separately rather than added to STACK_SERVICES (mirrors the FFPROBE_SERVICE_ID
// and AUTO_SUBTITLES_SERVICE_ID treatment).
//
// Contract source: get-service-schema for `eyevinn-function-scenes`.
// create-service-instance config: required `name` (string) ONLY — it is a
// serverless media function. NOTE: get-service-schema exposes ONLY this
// provisioning config, NOT the runtime endpoint's request/response wire shape;
// that un-verified wire shape is isolated in pipeline/osc-scene-detect.ts behind
// the injected SceneDetector interface.
export const SCENE_DETECT_SERVICE_ID = 'eyevinn-function-scenes' as const;

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
  role: 'packaging'
};

export const TEARDOWN_ORDER: readonly StackService[] = [
  TEARDOWN_ONLY_PACKAGER,
  ...[...STACK_SERVICES].reverse()
];
