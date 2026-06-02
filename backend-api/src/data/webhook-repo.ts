// Webhook registration repository (issue #13).
//
// Abstracts webhook-registration persistence behind a workspace-scoped
// interface. Integrators register an HTTP endpoint to receive event
// notifications (asset/job lifecycle changes) so they never have to poll. Two
// implementations are provided and share identical workspace namespacing and
// ownership semantics:
//   - InMemoryWebhookRepository (inmemory-webhook-repo.ts): local dev / tests.
//   - CouchWebhookRepository (couch-webhook-repo.ts): production, backed by
//     WorkspaceCouch (partitioned, ownership-aware) per ADR-001.
//
// A registration's `secret`, when set, is used to sign each delivery with an
// HMAC-SHA256 over the JSON body (see services/webhook-dispatcher.ts).

// The event types open-videocore emits. A registration subscribes to a
// non-empty subset of these; an event is delivered only to registrations whose
// `events` list contains its type.
export const WEBHOOK_EVENT_TYPES = [
  'asset.ready',
  'asset.failed',
  'transcode.complete',
  'transcode.failed',
  'package.complete',
  'package.failed'
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export type WebhookRegistration = {
  id: string;
  workspaceId: string;
  url: string;
  events: string[];
  // Optional shared secret. When set, deliveries are signed with an
  // HMAC-SHA256 of the request body in the X-Webhook-Signature header. Never
  // returned in plaintext over the API beyond the immediate create response.
  secret?: string;
  createdAt: string;
};

export type CreateWebhookInput = {
  url: string;
  events: string[];
  secret?: string;
};

export interface WebhookRepository {
  create(workspaceId: string, input: CreateWebhookInput): Promise<WebhookRegistration>;
  list(workspaceId: string): Promise<WebhookRegistration[]>;
  delete(workspaceId: string, id: string): Promise<void>;
}
