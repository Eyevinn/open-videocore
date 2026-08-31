// Tests for GET /api/v1/logs (issue #473).
//
// Builds the logsRouter over a real in-memory LogStore, exactly as
// provision.deprovision.test.ts builds provisionRouter over a real
// OperationStore, and drives it with app.inject(). Covers the acceptance
// criteria: cursor paging with NO offset drift on newly appended entries,
// newest-first default + reversal, and from/to/q server-side filtering.

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';
import { logsRouter } from './logs.js';
import { LogStore } from '../services/log-store.js';

async function buildApp(logStore: LogStore) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(logsRouter, { prefix: '/api/v1/logs', logStore });
  await app.ready();
  return app;
}

type LogItem = {
  seq: number;
  timestamp: string;
  message: string;
  level?: string;
  category?: string;
};
type LogPage = { items: LogItem[]; nextCursor: string | null };

// Deterministic, strictly-increasing ISO timestamps so ordering assertions are
// stable regardless of wall-clock.
function ts(i: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
}

let store: LogStore;

beforeEach(() => {
  store = new LogStore();
});

describe('GET /api/v1/logs — envelope + record shape', () => {
  it('returns an { items, nextCursor } envelope with timestamp + message records', async () => {
    store.append({ message: 'hello', level: 'info', category: 'ingest', timestamp: ts(1) });
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LogPage;
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('nextCursor');
    expect(body.items[0]).toMatchObject({
      message: 'hello',
      level: 'info',
      category: 'ingest',
      timestamp: ts(1)
    });
    expect(typeof body.items[0].seq).toBe('number');
    await app.close();
  });
});

describe('GET /api/v1/logs — sort order', () => {
  it('defaults to newest-first', async () => {
    for (let i = 1; i <= 3; i++) store.append({ message: `m${i}`, timestamp: ts(i) });
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs' });
    const body = res.json() as LogPage;
    expect(body.items.map((r) => r.message)).toEqual(['m3', 'm2', 'm1']);
    await app.close();
  });

  it('reverses to oldest-first with order=asc', async () => {
    for (let i = 1; i <= 3; i++) store.append({ message: `m${i}`, timestamp: ts(i) });
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?order=asc' });
    const body = res.json() as LogPage;
    expect(body.items.map((r) => r.message)).toEqual(['m1', 'm2', 'm3']);
    await app.close();
  });
});

describe('GET /api/v1/logs — cursor paging (no offset drift)', () => {
  it('walks the whole stream via nextCursor without gaps or repeats', async () => {
    for (let i = 1; i <= 5; i++) store.append({ message: `m${i}`, timestamp: ts(i) });
    const app = await buildApp(store);

    const p1 = (await app.inject({ method: 'GET', url: '/api/v1/logs?limit=2' })).json() as LogPage;
    expect(p1.items.map((r) => r.message)).toEqual(['m5', 'm4']);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = (
      await app.inject({ method: 'GET', url: `/api/v1/logs?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}` })
    ).json() as LogPage;
    expect(p2.items.map((r) => r.message)).toEqual(['m3', 'm2']);
    expect(p2.nextCursor).not.toBeNull();

    const p3 = (
      await app.inject({ method: 'GET', url: `/api/v1/logs?limit=2&cursor=${encodeURIComponent(p2.nextCursor!)}` })
    ).json() as LogPage;
    expect(p3.items.map((r) => r.message)).toEqual(['m1']);
    expect(p3.nextCursor).toBeNull();
    await app.close();
  });

  it('does NOT drift when new entries are appended between page fetches', async () => {
    // Newest-first over an append-only stream: this is exactly the offset-drift
    // hazard #371 calls out. With offset paging, appending after page 1 would
    // shift every offset and re-show an already-seen row. With a seq cursor,
    // page 2 must resume strictly after page 1's boundary regardless of appends.
    for (let i = 1; i <= 3; i++) store.append({ message: `m${i}`, timestamp: ts(i) });
    const app = await buildApp(store);

    const p1 = (await app.inject({ method: 'GET', url: '/api/v1/logs?limit=2' })).json() as LogPage;
    expect(p1.items.map((r) => r.message)).toEqual(['m3', 'm2']);

    // Two new entries land at the head of the newest-first stream.
    store.append({ message: 'm4', timestamp: ts(4) });
    store.append({ message: 'm5', timestamp: ts(5) });

    const p2 = (
      await app.inject({ method: 'GET', url: `/api/v1/logs?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}` })
    ).json() as LogPage;
    // Page 2 continues from where page 1 ended — m1 only. No re-showing of m2/m3
    // and no leakage of the newly appended m4/m5 into an already-anchored page.
    expect(p2.items.map((r) => r.message)).toEqual(['m1']);
    expect(p2.nextCursor).toBeNull();
    await app.close();
  });
});

describe('GET /api/v1/logs — server-side filters', () => {
  it('filters by from/to time range', async () => {
    for (let i = 1; i <= 5; i++) store.append({ message: `m${i}`, timestamp: ts(i) });
    const app = await buildApp(store);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/logs?from=${encodeURIComponent(ts(2))}&to=${encodeURIComponent(ts(4))}`
    });
    const body = res.json() as LogPage;
    // Inclusive range [ts(2), ts(4)], newest-first.
    expect(body.items.map((r) => r.message)).toEqual(['m4', 'm3', 'm2']);
    await app.close();
  });

  it('filters by free-text q on message (case-insensitive)', async () => {
    store.append({ message: 'transcode started', timestamp: ts(1) });
    store.append({ message: 'INGEST started', timestamp: ts(2) });
    store.append({ message: 'transcode done', timestamp: ts(3) });
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?q=TRANSCODE' });
    const body = res.json() as LogPage;
    expect(body.items.map((r) => r.message)).toEqual(['transcode done', 'transcode started']);
    await app.close();
  });

  it('combines q with cursor paging', async () => {
    for (let i = 1; i <= 4; i++) store.append({ message: `keep ${i}`, timestamp: ts(i) });
    store.append({ message: 'drop', timestamp: ts(5) });
    const app = await buildApp(store);
    const p1 = (await app.inject({ method: 'GET', url: '/api/v1/logs?q=keep&limit=2' })).json() as LogPage;
    expect(p1.items.map((r) => r.message)).toEqual(['keep 4', 'keep 3']);
    const p2 = (
      await app.inject({ method: 'GET', url: `/api/v1/logs?q=keep&limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}` })
    ).json() as LogPage;
    expect(p2.items.map((r) => r.message)).toEqual(['keep 2', 'keep 1']);
    expect(p2.nextCursor).toBeNull();
    await app.close();
  });
});

describe('GET /api/v1/logs — validation', () => {
  it('rejects limit above the bound', async () => {
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?limit=9999' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('treats a garbage cursor as the first page rather than erroring', async () => {
    for (let i = 1; i <= 2; i++) store.append({ message: `m${i}`, timestamp: ts(i) });
    const app = await buildApp(store);
    const res = await app.inject({ method: 'GET', url: '/api/v1/logs?cursor=not-a-real-cursor' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LogPage;
    expect(body.items.map((r) => r.message)).toEqual(['m2', 'm1']);
    await app.close();
  });
});
