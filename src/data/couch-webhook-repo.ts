// CouchDB-backed webhook registration repository (issue #13).
//
// Implements WebhookRepository on top of WorkspaceCouch, reusing the same
// workspace partition + ownership re-check as the asset and job repositories.
// Registrations are stored as documents with resourceType 'webhook' inside the
// caller's partition, so an id from another workspace resolves to undefined
// (existence is not leaked) and is never read or deleted cross-workspace.

import type { StoredDoc, StackCouch } from './couchdb.js';
import {
  normalizeWebhookEvents,
  type CreateWebhookInput,
  type WebhookRegistration,
  type WebhookRepository
} from './webhook-repo.js';

const RESOURCE_TYPE = 'webhook';

export type CouchFactory = () => StackCouch;

export class CouchWebhookRepository implements WebhookRepository {
  constructor(private readonly couchFor: CouchFactory) {}

  async create(input: CreateWebhookInput): Promise<WebhookRegistration> {
    const couch = this.couchFor();
    const now = new Date().toISOString();
    const localId = `webhook-${cryptoId()}`;
    const registration: WebhookRegistration = {
      id: localId,
      url: input.url,
      events: normalizeWebhookEvents(input.events),
      secret: input.secret,
      createdAt: now
    };
    await couch.put(localId, toDoc(registration));
    return registration;
  }

  async list(): Promise<WebhookRegistration[]> {
    const couch = this.couchFor();
    const docs = await couch.find({ resourceType: RESOURCE_TYPE }, { limit: 1000 });
    return docs
      .map(fromDoc)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async delete(id: string): Promise<void> {
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return;
    }
    await couch.remove(id);
  }
}

function toDoc(registration: WebhookRegistration): Record<string, unknown> {
  return {
    resourceType: RESOURCE_TYPE,
    localId: registration.id,
    url: registration.url,
    events: registration.events,
    secret: registration.secret,
    createdAt: registration.createdAt
  };
}

function fromDoc(doc: StoredDoc): WebhookRegistration {
  return {
    id: String(doc['localId'] ?? stripPartition(doc._id)),
    url: String(doc['url'] ?? ''),
    events: (doc['events'] as string[] | undefined) ?? [],
    secret: doc['secret'] as string | undefined,
    createdAt: String(doc['createdAt'] ?? '')
  };
}

function stripPartition(id: string): string {
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
