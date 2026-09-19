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

import { ENCODE_COMPLETION_EVENT_TYPE } from '../pipeline/encode-completion-event.js';

// The event types open-videocore emits. A registration subscribes to a
// non-empty subset of these; an event is delivered only to registrations whose
// `events` list contains its type.
//
// `encode.completed` (issue #693, ADR-022) is the billing-oriented completion
// event delivered over this same outbound-webhook transport. It references
// ENCODE_COMPLETION_EVENT_TYPE (the #691 canonical constant) rather than a
// duplicated literal so the subscribable event name and the emitted event name
// can never drift — a mismatch would silently drop deliveries because the
// dispatcher matches on the exact `type` string (ADR-022 Consequences,
// webhook-dispatcher.ts:80).
export const WEBHOOK_EVENT_TYPES = [
  'asset.ready',
  'asset.failed',
  'transcode.complete',
  'transcode.failed',
  'package.complete',
  'package.failed',
  ENCODE_COMPLETION_EVENT_TYPE
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export type WebhookRegistration = {
  id: string;
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
  create(input: CreateWebhookInput): Promise<WebhookRegistration>;
  list(): Promise<WebhookRegistration[]>;
  delete(id: string): Promise<void>;
}

// Thrown when a repository is handed a CreateWebhookInput whose `events` is not
// an array. The HTTP boundary already enforces `events: z.array(...).min(1)`
// (routes/webhooks.ts createBodySchema), so this only fires for a programmatic
// mis-call — surfacing a clear contract violation instead of a cryptic
// `TypeError: input.events is not iterable` from a spread on a non-iterable.
export class InvalidWebhookEventsError extends Error {
  constructor() {
    super('webhook `events` must be an array of event-type strings');
    this.name = 'InvalidWebhookEventsError';
  }
}

// Single source of truth for how both repository tiers coerce the subscribed
// event list, so the in-memory and CouchDB paths handle the identical input
// shape (acceptance criterion, issue #714). Returns a defensive copy.
export function normalizeWebhookEvents(events: CreateWebhookInput['events']): string[] {
  if (!Array.isArray(events)) {
    throw new InvalidWebhookEventsError();
  }
  return [...events];
}
