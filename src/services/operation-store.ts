import { randomUUID } from 'crypto';

export type OperationStatus = 'pending' | 'running' | 'done' | 'failed';
export type OperationType = 'provision' | 'deprovision';

export type Operation = {
  id: string;
  type: OperationType;
  name: string;             // stack name
  status: OperationStatus;
  startedAt: number;        // epoch ms
  completedAt?: number;
  result?: unknown;         // final success payload (stack coords for provision, teardown result for deprovision)
  error?: string;           // set on failure
};

export class OperationStore {
  private readonly ops = new Map<string, Operation>();

  create(type: OperationType, name: string): Operation {
    const op: Operation = { id: randomUUID(), type, name, status: 'pending', startedAt: Date.now() };
    this.ops.set(op.id, op);
    return op;
  }

  update(id: string, patch: Partial<Omit<Operation, 'id'>>): void {
    const existing = this.ops.get(id);
    if (existing) Object.assign(existing, patch);
  }

  get(id: string): Operation | undefined {
    return this.ops.get(id);
  }

  list(): Operation[] {
    return [...this.ops.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
}
