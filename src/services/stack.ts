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
//   packaging  — Encore packager (consumes queue, writes packaged output)
//
// Encore and its paired callback listener are NOT part of the provisioned
// stack: the auto-scaler spawns each Encore instance together with a dedicated
// callback listener pointing at that exact instance, and tears both down on
// scale-down (ADR-006).
export const STACK_SERVICES = [
  { serviceId: 'minio-minio', role: 'storage' },
  { serviceId: 'apache-couchdb', role: 'database' },
  { serviceId: 'valkey-io-valkey', role: 'queue' },
  { serviceId: 'eyevinn-encore-packager', role: 'packaging' }
] as const;

export type StackService = (typeof STACK_SERVICES)[number];

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

// Teardown order is the reverse of provision order: consumers are removed
// before the producers they depend on (packager -> queue -> database ->
// storage). This avoids tearing a producer out from under a still-running
// consumer.
export const TEARDOWN_ORDER: readonly StackService[] = [...STACK_SERVICES].reverse();
