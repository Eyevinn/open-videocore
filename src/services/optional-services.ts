// Registry of OPTIONAL, opt-in OSC services (issue #195).
//
// These are long-lived service instances that are NOT part of the core
// provisioned stack (STACK_SERVICES in stack.ts). Each is provisioned on its
// own — auto-subtitles needs an OpenAI key; scene-detect needs nothing beyond a
// name — and the runtime discovers the live instance from a per-service
// instance-name environment variable (see main.ts):
//   - AUTO_SUBTITLES_INSTANCE_NAME → eyevinn-auto-subtitles
//   - SCENE_DETECT_INSTANCE_NAME   → eyevinn-function-scenes
//
// This module is the single source of truth for that mapping so the
// optional-services route (per-service status/provision/deprovision) and #187 /
// #188 provision-card UIs share ONE contract. Adding a new optional service is a
// single registry entry here.
//
// Contract sources (do NOT guess field names):
//   - get-service-schema for `eyevinn-auto-subtitles` (fetched by orchestrator
//     2026-07-12): required `name` (^\w+$) and `openaikey` (SECRET); optional
//     awsAccessKeyId / awsSecretAccessKey (SECRET) / awsRegion / s3Endpoint. No
//     config update support (delete + create to change config).
//   - get-service-schema for `eyevinn-function-scenes` (fetched by orchestrator
//     2026-07-12): required `name` ONLY. No secret.
//   - AUTO_SUBTITLES_SERVICE_ID / SCENE_DETECT_SERVICE_ID imported from stack.ts.

import {
  AUTO_SUBTITLES_SERVICE_ID,
  SCENE_DETECT_SERVICE_ID
} from './stack.js';

// A single config field accepted by an optional service's provision request.
//   name     — the createInstance body key (verbatim from get-service-schema).
//   secret   — true when the value must be stored as an OSC secret (saveSecret)
//              and referenced as {{secrets.<name>}} in the createInstance body,
//              never echoed in any response.
//   required — true when the field must be present in the provision request.
export type OptionalServiceField = {
  name: string;
  secret: boolean;
  required: boolean;
};

// A single optional-service descriptor. `key` is the URL-safe id used on the
// route (/api/v1/optional-services/:key); it is deliberately NOT the OSC
// serviceId (which contains no path-hostile chars but is an implementation
// detail #187/#188 should not have to know).
export type OptionalServiceDescriptor = {
  key: string;
  serviceId: string;
  // Human-readable label (matches the OSC catalog display name).
  displayName: string;
  // The environment variable the RUNTIME (main.ts) reads to discover the
  // provisioned instance name. The status endpoint reports the SAME source of
  // truth so a card never disagrees with what the pipeline actually wired.
  instanceNameEnvVar: string;
  // The config fields accepted by POST /:key/provision, in body order.
  fields: OptionalServiceField[];
};

// The registry. Two entries today; both #187 and #188 consume the same
// endpoints by keying on `key`.
export const OPTIONAL_SERVICES: readonly OptionalServiceDescriptor[] = [
  {
    key: 'auto-subtitles',
    serviceId: AUTO_SUBTITLES_SERVICE_ID,
    displayName: 'Subtitle Generator',
    instanceNameEnvVar: 'AUTO_SUBTITLES_INSTANCE_NAME',
    fields: [
      // openaikey is the SECRET: stored via saveSecret, referenced as
      // {{secrets.<name>}}; never echoed in a response.
      { name: 'openaikey', secret: true, required: true },
      // Optional pass-throughs for the service's own /transcribe/s3 upload path.
      // awsSecretAccessKey is ALSO a secret when supplied. None are required for
      // the core provision flow (get-service-schema for eyevinn-auto-subtitles).
      { name: 'awsAccessKeyId', secret: false, required: false },
      { name: 'awsSecretAccessKey', secret: true, required: false },
      { name: 'awsRegion', secret: false, required: false },
      { name: 's3Endpoint', secret: false, required: false }
    ]
  },
  {
    key: 'scene-detect',
    serviceId: SCENE_DETECT_SERVICE_ID,
    displayName: 'Scene Detect Media Function',
    instanceNameEnvVar: 'SCENE_DETECT_INSTANCE_NAME',
    // get-service-schema for eyevinn-function-scenes: required `name` ONLY, no
    // secret. `name` is supplied by the provision request path, not a field.
    fields: []
  }
] as const;

export function findOptionalService(
  key: string
): OptionalServiceDescriptor | undefined {
  return OPTIONAL_SERVICES.find((s) => s.key === key);
}
