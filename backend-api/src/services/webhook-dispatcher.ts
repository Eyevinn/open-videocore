// Webhook event dispatcher (issue #13).
//
// Fires HTTP POST notifications to a workspace's registered webhook endpoints
// when an asset or job lifecycle event occurs, so integrators never have to
// poll. Delivery is best-effort and fire-and-forget:
//   - `dispatch(...)` resolves immediately after looking up matching
//     registrations; the actual HTTP POSTs run detached.
//   - A delivery failure (network error, timeout, non-2xx) is logged and
//     swallowed; it must NEVER crash the API or fail the originating request.
//   - Each delivery attempt has a 5-second timeout.
//
// When a registration carries a `secret`, the request body is signed with an
// HMAC-SHA256 and the lowercase hex digest is sent in the X-Webhook-Signature
// header (prefixed `sha256=`), so the receiver can verify authenticity.

import { createHmac } from 'node:crypto';
import type { WebhookRepository } from '../data/webhook-repo.js';

// Per-delivery HTTP timeout. A slow or hung receiver must not pin a delivery
// task open indefinitely.
const DELIVERY_TIMEOUT_MS = 5_000;

export type WebhookEvent = {
  type: string;
  payload: unknown;
};

// Minimal logger surface (compatible with Fastify's logger). Injected so
// delivery friction is observable without coupling to a concrete logger.
export type DispatcherLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const noopLogger: DispatcherLogger = { warn: () => {}, error: () => {} };

export type WebhookDispatcherDeps = {
  repository: WebhookRepository;
  log?: DispatcherLogger;
  // Injected for tests so deliveries can be asserted without a live receiver.
  // Defaults to the global fetch.
  fetchImpl?: typeof fetch;
  // Test observability hook fired after each delivery attempt settles.
  onDelivery?: (result: { url: string; ok: boolean; error?: string }) => void;
};

export class WebhookDispatcher {
  private readonly repository: WebhookRepository;
  private readonly log: DispatcherLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly onDelivery?: (result: { url: string; ok: boolean; error?: string }) => void;

  constructor(deps: WebhookDispatcherDeps) {
    this.repository = deps.repository;
    this.log = deps.log ?? noopLogger;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.onDelivery = deps.onDelivery;
  }

  // Fire-and-forget. Looks up the workspace's registrations subscribed to the
  // event type and POSTs the signed body to each. Returns once the lookup is
  // done; deliveries run detached. Never throws into the caller.
  //
  // Returns a promise that resolves when all delivery attempts have settled.
  // Callers SHOULD NOT await it on the request hot path (fire-and-forget); it
  // is exposed so tests can deterministically wait for delivery to complete.
  dispatch(workspaceId: string, event: WebhookEvent): Promise<void> {
    return this.deliver(workspaceId, event).catch((err) => {
      // The lookup itself failed (e.g. CouchDB unreachable). Best-effort: log
      // and swallow so the originating request is never affected.
      this.log.error(
        { err: errMessage(err), workspaceId, eventType: event.type },
        'webhook dispatch lookup failed'
      );
    });
  }

  private async deliver(workspaceId: string, event: WebhookEvent): Promise<void> {
    const registrations = await this.repository.list(workspaceId);
    const matching = registrations.filter((r) => r.events.includes(event.type));
    if (matching.length === 0) {
      return;
    }

    const body = JSON.stringify({
      event: event.type,
      payload: event.payload,
      timestamp: new Date().toISOString()
    });

    await Promise.all(
      matching.map((registration) =>
        this.post(registration.url, body, registration.secret).then(
          () => this.onDelivery?.({ url: registration.url, ok: true }),
          (err) => {
            const message = errMessage(err);
            this.log.warn(
              { url: registration.url, eventType: event.type, err: message },
              'webhook delivery failed'
            );
            this.onDelivery?.({ url: registration.url, ok: false, error: message });
          }
        )
      )
    );
  }

  private async post(url: string, body: string, secret?: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'user-agent': 'open-videocore-webhooks/1'
      };
      if (secret) {
        const signature = createHmac('sha256', secret).update(body).digest('hex');
        headers['x-webhook-signature'] = `sha256=${signature}`;
      }
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });
      if (!res.ok) {
        throw new Error(`receiver responded ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
