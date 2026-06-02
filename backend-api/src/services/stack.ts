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
//   transcode  — Encore (transcoding engine; depends on storage)
//   transcode  — Encore callback listener (bridges Encore -> queue)
//   packaging  — Encore packager (consumes queue, writes packaged output)
export const STACK_SERVICES = [
  { serviceId: 'minio-minio', role: 'storage' },
  { serviceId: 'apache-couchdb', role: 'database' },
  { serviceId: 'valkey-io-valkey', role: 'queue' },
  { serviceId: 'encore', role: 'transcode' },
  { serviceId: 'eyevinn-encore-callback-listener', role: 'transcode' },
  { serviceId: 'eyevinn-encore-packager', role: 'packaging' }
] as const;

export type StackService = (typeof STACK_SERVICES)[number];

// eyevinn-ffmpeg-s3: the ephemeral ffprobe/ffmpeg runner used by the technical
// metadata extraction pipeline (issue #6). It is NOT part of the long-lived
// provisioned stack above — it is invoked per-extraction as an ephemeral job
// against a presigned MinIO object URL — so it is exported separately rather
// than added to STACK_SERVICES.
export const FFPROBE_SERVICE_ID = 'eyevinn-ffmpeg-s3' as const;

// Teardown order is the reverse of provision order: consumers are removed
// before the producers they depend on (packager -> callback listener -> encore
// -> queue -> database -> storage). This avoids tearing a producer out from
// under a still-running consumer.
export const TEARDOWN_ORDER: readonly StackService[] = [...STACK_SERVICES].reverse();
