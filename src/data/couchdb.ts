// CouchDB access.
//
// Tenant isolation is structural (ADR-003 / issue #59): OSC provisions a
// dedicated CouchDB instance per deploying tenant, so this database belongs to
// exactly one tenant. There is NO workspace partitioning, NO per-document
// workspaceId stamp, and NO workspaceId predicate on queries. Documents use a
// flat id (the resource's local id).

import nano from 'nano';
import type { DocumentScope, ServerScope } from 'nano';

export type StoredDoc = {
  _id: string;
  _rev?: string;
  resourceType: string;
  [key: string]: unknown;
};

// Class name retained for call-site compatibility; it no longer carries any
// workspace identity. The first constructor argument is the deployment context
// key, kept only so the existing per-stack factory signature stays stable.
export class WorkspaceCouch {
  private readonly db: DocumentScope<StoredDoc>;

  constructor(_contextId: string, server: ServerScope, dbName: string) {
    this.db = server.use<StoredDoc>(dbName);
  }

  async put(localId: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    const doc: StoredDoc = {
      ...body,
      _id: localId,
      resourceType: String(body['resourceType'] ?? 'asset')
    };
    const res = await this.db.insert(doc);
    return { id: res.id, rev: res.rev };
  }

  async get(localId: string): Promise<StoredDoc | undefined> {
    try {
      return await this.db.get(localId);
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  async list(opts: { limit?: number; skip?: number } = {}): Promise<StoredDoc[]> {
    const result = await this.db.list({
      include_docs: true,
      limit: opts.limit ?? 50,
      skip: opts.skip ?? 0
    });
    const docs: StoredDoc[] = [];
    for (const row of result.rows) {
      const doc = row.doc as StoredDoc | undefined;
      if (doc && !doc._id.startsWith('_design/')) {
        docs.push(doc);
      }
    }
    return docs;
  }

  async find(
    selector: Record<string, unknown>,
    opts: { limit?: number; skip?: number } = {}
  ): Promise<StoredDoc[]> {
    const result = await this.db.find({
      selector: selector as nano.MangoSelector,
      limit: opts.limit ?? 50,
      skip: opts.skip ?? 0
    });
    return result.docs;
  }

  async count(selector: Record<string, unknown>): Promise<number> {
    const result = await this.db.find({
      selector: selector as nano.MangoSelector,
      fields: ['_id'],
      limit: COUNT_CAP
    });
    return result.docs.length;
  }

  async remove(localId: string): Promise<void> {
    const existing = await this.get(localId);
    if (!existing || !existing._rev) {
      return;
    }
    await this.db.destroy(existing._id, existing._rev);
  }
}

const COUNT_CAP = 10_000;

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { statusCode?: number }).statusCode === 404 ||
      (err as { status?: number }).status === 404)
  );
}

export function couchServer(url: string): ServerScope {
  return nano(url);
}
