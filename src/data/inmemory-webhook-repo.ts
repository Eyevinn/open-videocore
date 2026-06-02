// In-memory webhook registration repository (issue #13).
//
// Local dev / test backend. Applies the SAME workspace namespacing and
// ownership guards as the CouchDB layer so behaviour is identical regardless of
// backend: registrations are keyed by `<workspaceId>:<localId>` and reads/lists
// are confined to the caller's workspace.

// ADR-003/#59: workspace guard removed (structural OSC isolation).
import type {
  CreateWebhookInput,
  WebhookRegistration,
  WebhookRepository
} from './webhook-repo.js';

export class InMemoryWebhookRepository implements WebhookRepository {
  // Keyed by fully namespaced id `<workspaceId>:<localId>`.
  private readonly store = new Map<string, WebhookRegistration>();
  private counter = 0;

  async create(workspaceId: string, input: CreateWebhookInput): Promise<WebhookRegistration> {
    const now = new Date().toISOString();
    const localId = `webhook-${++this.counter}`;
    const registration: WebhookRegistration = {
      id: localId,
      workspaceId,
      url: input.url,
      events: [...input.events],
      secret: input.secret,
      createdAt: now
    };
    this.store.set(localId, registration);
    return { ...registration };
  }

  async list(workspaceId: string): Promise<WebhookRegistration[]> {
    return [...this.store.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((w) => ({ ...w }));
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    const key = id;
    const existing = this.store.get(key);
    if (!existing) {
      // A foreign / unknown id is indistinguishable from a miss: existence is
      // not leaked across workspaces.
      return;
    }
    // Defence in depth: re-check ownership even though the key is namespaced.
    this.store.delete(key);
  }
}
