import { describe, it, expect, vi, beforeEach } from 'vitest';

import { makeHttpEncoreClient } from './encore-client.js';

// Minimal Response builder for the injected fetch fake.
function makeRes(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
    async json() {
      return body ? JSON.parse(body) : {};
    }
  } as unknown as Response;
}

const BASE = 'https://encore.example.io/';
const TOKEN = 'test-sat';
const JOB_ID = 'job-uuid-123';

describe('makeHttpEncoreClient.cancel', () => {
  let doFetch: ReturnType<typeof vi.fn>;
  let getToken: () => Promise<string>;

  beforeEach(() => {
    doFetch = vi.fn();
    getToken = async () => TOKEN;
  });

  function client() {
    return makeHttpEncoreClient({
      baseUrl: BASE,
      getToken,
      fetch: doFetch as unknown as typeof globalThis.fetch
    });
  }

  it('200: POSTs to /encoreJobs/{id}/cancel with Bearer header and no body', async () => {
    doFetch.mockResolvedValue(makeRes(200));

    await expect(client().cancel(JOB_ID)).resolves.toBeUndefined();

    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0];
    // Trailing slash on baseUrl is stripped before the path is appended.
    expect(url).toBe(`https://encore.example.io/encoreJobs/${JOB_ID}/cancel`);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBeUndefined();
  });

  it('404: already-gone job is an idempotent no-op (no throw)', async () => {
    doFetch.mockResolvedValue(makeRes(404));
    await expect(client().cancel(JOB_ID)).resolves.toBeUndefined();
  });

  it('409: terminal/non-cancellable job is an idempotent no-op (no throw)', async () => {
    doFetch.mockResolvedValue(makeRes(409));
    await expect(client().cancel(JOB_ID)).resolves.toBeUndefined();
  });

  it('500: throws with the status and response text', async () => {
    doFetch.mockResolvedValue(makeRes(500, 'boom'));
    await expect(client().cancel(JOB_ID)).rejects.toThrow(/Encore job cancellation failed: 500 boom/);
  });
});
