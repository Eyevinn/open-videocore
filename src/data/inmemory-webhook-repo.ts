// In-memory webhook registration repository (issue #13).
//
// Local dev / test backend. Applies the SAME workspace namespacing and
// ownership guards as the CouchDB layer so behaviour is identical regardless of
// backend: registrations are keyed by `<workspaceId>:<localId>` and reads/lists
// are confined to the caller's workspace.

// ADR-003/#59: workspace guard removed (structural OSC isolation).
import {
  normalizeWebhookEvents,
  type CreateWebhookInput,
  type WebhookRegistration,
  type WebhookRepository
} from './webhook-repo.js';

export class InMemoryWebhookRepository implements WebhookRepository {
  private readonly store = new Map<string, WebhookRegistration>();
  private counter = 0;

  async create(input: CreateWebhookInput): Promise<WebhookRegistration> {
    const now = new Date().toISOString();
    const localId = `webhook-${++this.counter}`;
    const registration: WebhookRegistration = {
      id: localId,
      url: input.url,
      events: normalizeWebhookEvents(input.events),
      secret: input.secret,
      createdAt: now
    };
    this.store.set(localId, registration);
    return { ...registration };
  }

  async list(): Promise<WebhookRegistration[]> {
    return [...this.store.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((w) => ({ ...w }));
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}
