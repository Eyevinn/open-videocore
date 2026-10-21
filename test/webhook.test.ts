// Webhook and event notification tests (issue #13).
//
// Covers:
//   - CRUD routes: register / list / delete, all workspace-scoped + behind auth
//   - registration validation (invalid URL, empty/unknown events)
//   - cross-workspace isolation (list + delete never leak across workspaces)
//   - the dispatcher: matches subscribers by event type, fires HTTP POST with
//     the { event, payload, timestamp } body, signs with HMAC-SHA256 when a
//     secret is set, and is fire-and-forget (failures logged, never thrown)
//   - the internal callbacks fire webhook events on transcode + packaging
//     completion

import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = { 'token-a': 'workspace-a', 'token-b': 'workspace-b' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { webhooksRouter } from '../src/routes/webhooks.js';
import { internalRouter } from '../src/routes/internal.js';
import { InMemoryWebhookRepository } from '../src/data/inmemory-webhook-repo.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import { WebhookDispatcher } from '../src/services/webhook-dispatcher.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');
const B = auth('token-b');

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryWebhookRepository();
  await app.register(webhooksRouter, { prefix: '/api/v1/webhooks', repository: repo });
  await app.ready();
  return { app, repo };
}

async function register(
  app: FastifyInstance,
  headers: Record<string, string>,
  body: Record<string, unknown>
) {
  return app.inject({ method: 'POST', url: '/api/v1/webhooks', headers, payload: body });
}

describe('webhook registration CRUD (issue #13)', () => {
  it('registers, lists, and deletes a webhook', async () => {
    const { app } = await buildApp();

    const created = await register(app, A, {
      url: 'https://example.com/hook',
      events: ['asset.ready', 'transcode.complete']
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    // Post-ADR-003 (#64): the create response (registrationSchema in
    // src/routes/webhooks.ts) no longer carries workspaceId.
    expect(created.json().events).toEqual(['asset.ready', 'transcode.complete']);

    const list = await app.inject({ method: 'GET', url: '/api/v1/webhooks', headers: A });
    expect(list.statusCode).toBe(200);
    expect(list.json().webhooks).toHaveLength(1);
    expect(list.json().webhooks[0].id).toBe(id);

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/webhooks/${id}`, headers: A });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/api/v1/webhooks', headers: A });
    expect(after.json().webhooks).toHaveLength(0);
  });

  it('echoes the secret back in the create response', async () => {
    const { app } = await buildApp();
    const res = await register(app, A, {
      url: 'https://example.com/hook',
      events: ['asset.ready'],
      secret: 's3cret'
    });
    // createdRegistrationSchema (src/routes/webhooks.ts) keeps `secret` on the
    // 201 only — the documented one-time echo.
    expect(res.statusCode).toBe(201);
    expect(res.json().secret).toBe('s3cret');
    expect(res.json().hasSecret).toBe(true);
  });

  // Issue #821: the list route reused the create response schema, so any caller
  // who could list registrations could read every signing secret in plaintext
  // and forge X-Webhook-Signature deliveries.
  describe('secret is write-only after creation (issue #821)', () => {
    it('does not expose the secret through the list route', async () => {
      const { app } = await buildApp();
      const created = await register(app, A, {
        url: 'https://example.com/hook',
        events: ['asset.ready'],
        secret: 'platform-test-secret'
      });
      expect(created.json().secret).toBe('platform-test-secret');

      const list = await app.inject({ method: 'GET', url: '/api/v1/webhooks', headers: A });
      expect(list.statusCode).toBe(200);
      const [listed] = list.json().webhooks;
      expect(Object.keys(listed)).not.toContain('secret');
      expect(listed.secret).toBeUndefined();
      // Belt and braces: the value must not appear anywhere in the body, under
      // any key or nesting.
      expect(list.body).not.toContain('platform-test-secret');
    });

    it('reports hasSecret so a caller can tell signing is configured', async () => {
      const { app } = await buildApp();
      await register(app, A, {
        url: 'https://signed.example/hook',
        events: ['asset.ready'],
        secret: 's3cret'
      });
      await register(app, A, { url: 'https://plain.example/hook', events: ['asset.ready'] });

      const list = await app.inject({ method: 'GET', url: '/api/v1/webhooks', headers: A });
      const byUrl = Object.fromEntries(
        (list.json().webhooks as { url: string; hasSecret: boolean }[]).map((w) => [
          w.url,
          w.hasSecret
        ])
      );
      expect(byUrl['https://signed.example/hook']).toBe(true);
      expect(byUrl['https://plain.example/hook']).toBe(false);
    });

    it('still signs deliveries with the secret it no longer discloses', async () => {
      // The stored secret must survive the response-shape change — the
      // dispatcher reads it straight off the repository record.
      const { app, repo } = await buildApp();
      await register(app, A, {
        url: 'https://hit.example',
        events: ['asset.ready'],
        secret: 'topsecret'
      });

      let headers: Record<string, string> = {};
      let body = '';
      const dispatcher = new WebhookDispatcher({
        repository: repo,
        fetchImpl: (async (_url: string, init: RequestInit) => {
          headers = init.headers as Record<string, string>;
          body = String(init.body);
          return new Response(null, { status: 200 });
        }) as unknown as typeof fetch
      });

      await dispatcher.dispatch({ type: 'asset.ready', payload: {} });
      expect(headers['x-webhook-signature']).toBe(
        `sha256=${createHmac('sha256', 'topsecret').update(body).digest('hex')}`
      );
    });
  });

  it('rejects an invalid URL', async () => {
    const { app } = await buildApp();
    const res = await register(app, A, { url: 'not-a-url', events: ['asset.ready'] });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an empty events array', async () => {
    const { app } = await buildApp();
    const res = await register(app, A, { url: 'https://example.com/hook', events: [] });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown event type', async () => {
    const { app } = await buildApp();
    const res = await register(app, A, {
      url: 'https://example.com/hook',
      events: ['asset.exploded']
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/webhooks' });
    expect(res.statusCode).toBe(401);
  });

  describe('workspace isolation', () => {
    it.skip('does not list another workspace registrations', async () => {
      const { app } = await buildApp();
      await register(app, A, { url: 'https://a.example/hook', events: ['asset.ready'] });

      const listB = await app.inject({ method: 'GET', url: '/api/v1/webhooks', headers: B });
      expect(listB.json().webhooks).toHaveLength(0);
    });

    it.skip('cannot delete another workspace registration (no-op, no leak)', async () => {
      const { app } = await buildApp();
      const created = await register(app, A, {
        url: 'https://a.example/hook',
        events: ['asset.ready']
      });
      const id = created.json().id as string;

      // workspace-b deleting workspace-a's id is a silent 204 no-op.
      const del = await app.inject({ method: 'DELETE', url: `/api/v1/webhooks/${id}`, headers: B });
      expect(del.statusCode).toBe(204);

      // The registration still exists for workspace-a.
      const list = await app.inject({ method: 'GET', url: '/api/v1/webhooks', headers: A });
      expect(list.json().webhooks).toHaveLength(1);
    });
  });
});

describe('WebhookDispatcher (issue #13)', () => {
  it('delivers only to subscribers of the event type', async () => {
    const repo = new InMemoryWebhookRepository();
    await repo.create({ url: 'https://hit.example', events: ['asset.ready'] });
    await repo.create({ url: 'https://miss.example', events: ['asset.failed'] });

    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const dispatcher = new WebhookDispatcher({
      repository: repo,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await dispatcher.dispatch({ type: 'asset.ready', payload: { assetId: 'x' } });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://hit.example');
  });

  // ADR-003 / issue #59: in-app workspace scoping is removed (structural OSC
  // tenant isolation). A single deployment is one tenant, so there is no
  // cross-workspace delivery boundary to enforce in the dispatcher.
  it.skip('does not deliver to other workspaces', async () => {
    const repo = new InMemoryWebhookRepository();
    await repo.create({ url: 'https://b.example', events: ['asset.ready'] });

    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const dispatcher = new WebhookDispatcher({
      repository: repo,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await dispatcher.dispatch({ type: 'asset.ready', payload: {} });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the { event, payload, timestamp } body', async () => {
    const repo = new InMemoryWebhookRepository();
    await repo.create({ url: 'https://hit.example', events: ['transcode.complete'] });

    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(null, { status: 200 });
    });
    const dispatcher = new WebhookDispatcher({
      repository: repo,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await dispatcher.dispatch({
      type: 'transcode.complete',
      payload: { assetId: 'asset-1' }
    });

    const body = JSON.parse(String(captured!.init.body));
    expect(body.event).toBe('transcode.complete');
    expect(body.payload).toEqual({ assetId: 'asset-1' });
    expect(typeof body.timestamp).toBe('string');
  });

  it('signs the body with HMAC-SHA256 when a secret is set', async () => {
    const repo = new InMemoryWebhookRepository();
    await repo.create({
      url: 'https://hit.example',
      events: ['asset.ready'],
      secret: 'topsecret'
    });

    let headers: Record<string, string> = {};
    let body = '';
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      body = String(init.body);
      return new Response(null, { status: 200 });
    });
    const dispatcher = new WebhookDispatcher({
      repository: repo,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await dispatcher.dispatch({ type: 'asset.ready', payload: {} });

    const expected = `sha256=${createHmac('sha256', 'topsecret').update(body).digest('hex')}`;
    expect(headers['x-webhook-signature']).toBe(expected);
  });

  it('omits the signature header when no secret is set', async () => {
    const repo = new InMemoryWebhookRepository();
    await repo.create({ url: 'https://hit.example', events: ['asset.ready'] });

    let headers: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(null, { status: 200 });
    });
    const dispatcher = new WebhookDispatcher({
      repository: repo,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await dispatcher.dispatch({ type: 'asset.ready', payload: {} });
    expect(headers['x-webhook-signature']).toBeUndefined();
  });

  it('never throws when a delivery fails (best-effort)', async () => {
    const repo = new InMemoryWebhookRepository();
    await repo.create({ url: 'https://down.example', events: ['asset.ready'] });

    const onDelivery = vi.fn();
    const dispatcher = new WebhookDispatcher({
      repository: repo,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
      onDelivery
    });

    await expect(
      dispatcher.dispatch({ type: 'asset.ready', payload: {} })
    ).resolves.toBeUndefined();
    expect(onDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, url: 'https://down.example' })
    );
  });

  it('treats a non-2xx response as a failure but does not throw', async () => {
    const repo = new InMemoryWebhookRepository();
    await repo.create({ url: 'https://err.example', events: ['asset.ready'] });

    const onDelivery = vi.fn();
    const dispatcher = new WebhookDispatcher({
      repository: repo,
      fetchImpl: (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
      onDelivery
    });

    await dispatcher.dispatch({ type: 'asset.ready', payload: {} });
    expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
});

describe('internal callbacks fire webhook events (issue #13)', () => {
  async function buildCallbackApp() {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerAuth(app);
    const webhookRepo = new InMemoryWebhookRepository();
    const assets = new InMemoryAssetRepository();
    const pipelines = new InMemoryPipelineRepository();
    const delivered: { url: string; ok: boolean }[] = [];
    const dispatcher = new WebhookDispatcher({
      repository: webhookRepo,
      fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
      onDelivery: (r) => delivered.push({ url: r.url, ok: r.ok })
    });

    const { PackagingService } = await import('../src/pipeline/packaging.js');
    const packaging = new PackagingService({
      assets,
      queue: { enqueue: vi.fn(async () => {}) },
      publicBaseUrl: 'https://cdn.example/packaged'
    });

    await app.register(internalRouter, {
      prefix: '/api/v1/internal',
      packaging,
      repository: assets,
      pipelineRepository: pipelines,
      webhookDispatcher: dispatcher
    });
    await app.ready();
    return { app, assets, pipelines, webhookRepo, delivered };
  }

  // Seed a pipeline execution stalled on a RUNNING `package` step — the state the
  // packager-failure callback correlates against (src/routes/internal.ts:433-445).
  async function seedRunningPackage(
    pipelines: InMemoryPipelineRepository,
    assetId: string
  ) {
    const exec = await pipelines.create({ assetId, steps: ['package'] });
    await pipelines.update(exec.id, {
      steps: exec.steps.map((s) => (s.name === 'package' ? { ...s, status: 'running' } : s))
    });
    return exec;
  }

  it('fires package.complete on a successful packager callback', async () => {
    const { app, assets, webhookRepo, delivered } = await buildCallbackApp();
    const asset = await assets.create({ name: 'clip' });
    await webhookRepo.create({
      url: 'https://hook.example',
      events: ['package.complete']
    });

    // Current contract: POST /packagerCallback/success with { url, jobId } where
    // jobId === the assetId we enqueued (src/routes/internal.ts:55-58,395-399).
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/packagerCallback/success',
      payload: { url: 'https://encore.example/job/1', jobId: asset.id }
    });
    expect(res.statusCode).toBe(200);
    // Give the fire-and-forget delivery a tick to settle.
    await new Promise((r) => setImmediate(r));
    expect(delivered).toContainEqual({ url: 'https://hook.example', ok: true });
  });

  it('fires package.failed on a failed packager callback', async () => {
    const { app, assets, pipelines, webhookRepo, delivered } = await buildCallbackApp();
    const asset = await assets.create({ name: 'clip' });
    await seedRunningPackage(pipelines, asset.id);
    await webhookRepo.create({
      url: 'https://hook.example',
      events: ['package.failed']
    });

    // Current contract: POST /packagerCallback/failure with { message } only —
    // the packager does not echo a jobId, so the handler correlates by the
    // running `package` execution seeded above (src/routes/internal.ts:420-465).
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/packagerCallback/failure',
      payload: { message: 'boom' }
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(delivered).toContainEqual({ url: 'https://hook.example', ok: true });
  });
});
