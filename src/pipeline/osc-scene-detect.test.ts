// Behavioural tests for the OSC eyevinn-function-scenes runner (issue #798).
//
// These pin the runner to the contract confirmed in #797 from the service's own
// source, `Eyevinn/function-scenes` @ 492a18f23e253194c27800563ea0c96bef187aef:
//   - `api.json` `paths./api/v1.post`, request model `#/model/request`
//     (`required: ["medialocator"]`), response `#/model/createJobResponse`
//     (`thumbnails`, `status`), and `#/model/job.state` enum
//     `created|running|completed|failed|cancelled`.
//   - `index.js` — `server.post("/api/v1")` reading `req.body.medialocator` (:45)
//     and replying `{ thumbnails: `${BASE_PATH}/api/v1/${id}/thumbnails`,
//     status: `${BASE_PATH}/api/v1/${id}/status` }` (:47-50);
//     `server.get("/api/v1/:id/status")` (:78) returning `job.getStatus()`.
//
// Every call is driven through an injected `fetchImpl` with millisecond poll knobs,
// so nothing here sleeps or touches the network. Sibling precedent for this shape:
// osc-ffprobe.test.ts.

import { describe, it, expect, vi } from 'vitest';
import {
  makeOscSceneDetector,
  sceneRequestBody,
  resolveAgainstInstance,
  DEFAULT_SCENE_DETECT_PATH,
  BOUNDARIES_UNAVAILABLE_REASON,
  type OscSceneApi
} from './osc-scene-detect.js';

const INSTANCE_URL = 'https://scenes.example.osaas.io';
const PRESIGNED = 'https://minio.example/bucket/a.mp4?X-Amz-Signature=abc';

type Call = { url: string; init: RequestInit };

/**
 * Build a fake `fetch` that answers the create-job POST with `created`, then
 * serves the queued status payloads in order for each status GET.
 */
function fakeFetch(opts: {
  created?: unknown;
  createStatus?: number;
  statuses?: Array<{ status?: number; body?: unknown }>;
}) {
  const calls: Call[] = [];
  const statuses = [...(opts.statuses ?? [])];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init: init ?? {} });
    if ((init?.method ?? 'GET') === 'POST') {
      return new Response(JSON.stringify(opts.created ?? {}), {
        status: opts.createStatus ?? 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    // Status poll. Repeat the last queued entry once the queue drains so the
    // poll-budget test can spin.
    const next = statuses.length > 1 ? statuses.shift()! : (statuses[0] ?? { body: {} });
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' }
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function fakeApi(fetchImpl: typeof fetch, overrides: Partial<OscSceneApi> = {}): OscSceneApi {
  return {
    context: {
      getServiceAccessToken: vi.fn(async () => 'sat-token')
    } as unknown as OscSceneApi['context'],
    getInstance: vi.fn(async () => ({ url: INSTANCE_URL })) as unknown as OscSceneApi['getInstance'],
    instanceName: 'scenes-1',
    fetchImpl,
    requestTimeoutMs: 1_000,
    pollIntervalMs: 1,
    pollTimeoutMs: 1_000,
    ...overrides
  };
}

describe('sceneRequestBody — api.json #/model/request', () => {
  it('names the source-URL field `medialocator` and nothing else', () => {
    // `required: ["medialocator"]` is the single declared property, and the handler
    // reads exactly `req.body.medialocator` (index.js:45).
    expect(sceneRequestBody(PRESIGNED)).toEqual({ medialocator: PRESIGNED });
  });
});

describe('makeOscSceneDetector — create-then-poll job API', () => {
  it('POSTs the presigned URL as `medialocator` to /api/v1', async () => {
    const { impl, calls } = fakeFetch({
      created: { thumbnails: '/api/v1/1/thumbnails', status: '/api/v1/1/status' },
      statuses: [{ body: { id: 1, state: 'completed' } }]
    });
    await makeOscSceneDetector(fakeApi(impl))(PRESIGNED);

    expect(DEFAULT_SCENE_DETECT_PATH).toBe('/api/v1');
    const create = calls[0]!;
    // NOT `/` — that is the healthcheck, and POSTing it is what produced the 405.
    expect(create.url).toBe(`${INSTANCE_URL}/api/v1`);
    expect(create.init.method).toBe('POST');
    expect(JSON.parse(create.init.body as string)).toEqual({ medialocator: PRESIGNED });
    const headers = create.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBe('Bearer sat-token');
  });

  it('follows the returned `status` URL verbatim, including under a BASE_PATH', async () => {
    // index.js:49 builds `${BASE_PATH}/api/v1/${id}/status`. Resolving the returned
    // value — rather than rebuilding `/api/v1/{id}/status` — is what keeps a
    // BASE_PATH deployment working.
    const { impl, calls } = fakeFetch({
      created: {
        thumbnails: '/scenes/api/v1/7/thumbnails',
        status: '/scenes/api/v1/7/status'
      },
      statuses: [{ body: { id: 7, state: 'completed' } }]
    });
    await makeOscSceneDetector(fakeApi(impl))(PRESIGNED);

    expect(calls[1]!.url).toBe(`${INSTANCE_URL}/scenes/api/v1/7/status`);
    expect(calls[1]!.init.method).toBe('GET');
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer sat-token'
    );
  });

  it('polls created -> running -> completed and resolves', async () => {
    const { impl, calls } = fakeFetch({
      created: { thumbnails: '/api/v1/1/thumbnails', status: '/api/v1/1/status' },
      statuses: [
        { body: { id: 1, state: 'created' } },
        { body: { id: 1, state: 'running' } },
        { body: { id: 1, state: 'completed' } }
      ]
    });
    const result = await makeOscSceneDetector(fakeApi(impl))(PRESIGNED);

    // 1 create + 3 status polls.
    expect(calls).toHaveLength(4);
    expect(result.scenes).toBeUndefined();
    expect(result.cuts).toBeUndefined();
  });

  it.each(['failed', 'cancelled'])('rejects when the job ends in state "%s"', async (state) => {
    const { impl } = fakeFetch({
      created: { thumbnails: '/api/v1/1/thumbnails', status: '/api/v1/1/status' },
      statuses: [{ body: { id: 1, state } }]
    });
    await expect(makeOscSceneDetector(fakeApi(impl))(PRESIGNED)).rejects.toThrow(
      `scene-detect job ended in state "${state}"`
    );
  });

  it('rejects on a non-2xx status poll and surfaces the restify error body', async () => {
    // index.js:55 — InternalServerError serialised as `{ code, message }`.
    const { impl } = fakeFetch({
      created: { thumbnails: '/api/v1/1/thumbnails', status: '/api/v1/1/status' },
      statuses: [{ status: 500, body: { code: 'InternalServer', message: 'boom' } }]
    });
    await expect(makeOscSceneDetector(fakeApi(impl))(PRESIGNED)).rejects.toThrow(
      'scene-detect status poll failed: HTTP 500 (InternalServer: boom)'
    );
  });

  it('rejects when a status payload carries no `state`', async () => {
    const { impl } = fakeFetch({
      created: { thumbnails: '/api/v1/1/thumbnails', status: '/api/v1/1/status' },
      statuses: [{ body: { id: 1 } }]
    });
    await expect(makeOscSceneDetector(fakeApi(impl))(PRESIGNED)).rejects.toThrow(
      'scene-detect status response carried no job state'
    );
  });

  it('rejects when the create response carries no status endpoint', async () => {
    const { impl } = fakeFetch({ created: { thumbnails: '/api/v1/1/thumbnails' } });
    await expect(makeOscSceneDetector(fakeApi(impl))(PRESIGNED)).rejects.toThrow(
      'scene-detect function returned no job status endpoint'
    );
  });

  it('rejects a non-2xx create response', async () => {
    const { impl } = fakeFetch({
      createStatus: 400,
      created: { code: 'InvalidContent', message: 'Missing Request Body' }
    });
    await expect(makeOscSceneDetector(fakeApi(impl))(PRESIGNED)).rejects.toThrow(
      'scene-detect function failed: HTTP 400 (InvalidContent: Missing Request Body)'
    );
  });

  it('gives up when the job never reaches a terminal state inside the poll budget', async () => {
    const { impl } = fakeFetch({
      created: { thumbnails: '/api/v1/1/thumbnails', status: '/api/v1/1/status' },
      statuses: [{ body: { id: 1, state: 'running' } }]
    });
    const api = fakeApi(impl, { pollIntervalMs: 1, pollTimeoutMs: 25 });
    await expect(makeOscSceneDetector(api)(PRESIGNED)).rejects.toThrow(
      /did not reach a terminal state within .*last state: running/s
    );
  });

  it('rejects when the instance has no resolvable URL', async () => {
    const { impl } = fakeFetch({});
    const api = fakeApi(impl, {
      getInstance: vi.fn(async () => ({})) as unknown as OscSceneApi['getInstance']
    });
    await expect(makeOscSceneDetector(api)(PRESIGNED)).rejects.toThrow(
      'scene-detect instance "scenes-1" has no resolvable URL'
    );
  });
});

describe('resolveAgainstInstance — credential is pinned to the instance origin', () => {
  it('resolves a relative reference against the instance URL', () => {
    expect(resolveAgainstInstance(INSTANCE_URL, '/api/v1/1/status')).toBe(
      `${INSTANCE_URL}/api/v1/1/status`
    );
  });

  it('refuses an absolute, off-origin reference rather than sending the token there', async () => {
    // `new URL(ref, base)` ignores the base for an absolute ref; without the origin
    // check a server-controlled value could redirect the Bearer header off-host.
    expect(() => resolveAgainstInstance(INSTANCE_URL, 'https://attacker.example/steal')).toThrow(
      /off-origin endpoint reference/
    );

    const { impl, calls } = fakeFetch({
      created: { thumbnails: '/api/v1/1/thumbnails', status: 'https://attacker.example/steal' }
    });
    await expect(makeOscSceneDetector(fakeApi(impl))(PRESIGNED)).rejects.toThrow(
      /off-origin endpoint reference/
    );
    // Only the create POST went out; no credentialed poll reached the other host.
    expect(calls).toHaveLength(1);
  });
});

describe('a completed job reports the boundary gap explicitly (#798)', () => {
  it('returns boundariesUnavailable instead of an empty (zero-scene) result', async () => {
    // eyevinn-function-scenes exposes keyframe images only; cut times go to a
    // job-local time.txt no endpoint serves (lib/scene_detect_job.js execute()).
    // Reporting `{}` here would be normalized to `sceneCount: 0`, i.e. "this video
    // has no cuts" — a wrong answer for every input.
    const { impl } = fakeFetch({
      created: { thumbnails: '/api/v1/1/thumbnails', status: '/api/v1/1/status' },
      statuses: [{ body: { id: 1, state: 'completed' } }]
    });
    const result = await makeOscSceneDetector(fakeApi(impl))(PRESIGNED);

    expect(result.boundariesUnavailable?.reason).toBe(BOUNDARIES_UNAVAILABLE_REASON);
    expect(result.boundariesUnavailable?.reason).toMatch(/keyframe images only/);
  });
});
