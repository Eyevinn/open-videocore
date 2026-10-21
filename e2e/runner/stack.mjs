// Make sure the instance has a provisioned stack before the suite runs.
//
// A fresh instance has no backing storage: ingest answers 500 "object storage is not configured for this stack"
// (seen on the first complete cycle, 2026-10-08), and /health reports resolver mode "no-storage". The product's own
// way to get one is POST /api/v1/provision/, which creates the stack's OSC services (MinIO, CouchDB, Valkey; Encore
// and the packager are started later, on demand, by the auto-scaler / first packaging step). With no X-Stack-Name
// header the resolver uses the FIRST listed stack as the default (src/services/workspace-stack.ts), so one provisioned
// stack is all the suite needs.
//
// Contract, openapi.json v1.5.0:
//   GET  /api/v1/provision/                  200 string[] of stack names; 501 when provisioning is unsupported
//   GET  /api/v1/provision/{name}            200 {status: provisioning|ready|failed|degraded, reason?{code,capability,message}};
//                                            404 when absent; 501/502 otherwise
//   POST /api/v1/provision/ {name}           202 {operationId, name, status: "pending"}; 400
//   GET  /api/v1/provision/operations/{id}   200 {status: pending|running|done|failed, error?}
// reason.code "packaging_capability_missing" / capability "packaging" is the lazily provisioned packager and is
// expected on a stack that has not packaged anything yet.
import { poll } from '../lib/poll.mjs';

const lazyOnly = (s) => s.status === 'degraded' && s.reason?.capability === 'packaging';

/**
 * @param {{ request(method: string, path: string, opts?: any): Promise<{ status: number, body: any, text: string }> }} client
 * @param {{ name?: string, timeoutMs?: number, pollMs?: number, sleep?: Function, now?: Function }} [opts]
 * @returns {Promise<{ name: string, provisioned: boolean }>} provisioned = true when this call created the stack
 */
export async function ensureStack(client, { name = 'e2e', timeoutMs = 20 * 60_000, pollMs = 10_000, sleep, now = Date.now } = {}) {
  const pollOpts = { timeoutMs, intervalMs: pollMs, sleep, now };
  const status = async () => {
    const r = await client.request('GET', `/api/v1/provision/${encodeURIComponent(name)}`);
    if (r.status === 404) return undefined;
    if (r.status !== 200) throw new Error(`GET /api/v1/provision/${name} returned HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    return r.body;
  };
  const settle = (s) => {
    if (s.status === 'ready' || lazyOnly(s)) return s;
    if (s.status === 'failed' || s.status === 'degraded') {
      throw new Error(`stack ${name} is ${s.status}: ${s.reason?.code ?? ''} ${s.reason?.message ?? ''}`.trim());
    }
    return undefined; // provisioning
  };

  let current = await status();
  let provisioned = false;
  if (!current) {
    const created = await client.request('POST', '/api/v1/provision/', { json: { name } });
    if (created.status === 501) throw new Error('this instance does not support provisioning (HTTP 501)');
    if (created.status !== 202 || !created.body?.operationId) throw new Error(`POST /api/v1/provision/ returned HTTP ${created.status}: ${created.text.slice(0, 200)}`);
    provisioned = true;
    const op = await poll(async () => {
      const r = await client.request('GET', `/api/v1/provision/operations/${encodeURIComponent(created.body.operationId)}`);
      if (r.status !== 200) throw new Error(`GET provision operation returned HTTP ${r.status}`);
      return r.body.status === 'done' || r.body.status === 'failed' ? r.body : undefined;
    }, { ...pollOpts, what: `provision operation ${created.body.operationId}` });
    if (op.status === 'failed') throw new Error(`provisioning stack ${name} failed: ${String(op.error ?? 'no error given').slice(0, 300)}`);
  }
  await poll(async () => {
    const s = await status();
    return s ? settle(s) : undefined;
  }, { ...pollOpts, what: `stack ${name} to become ready` });
  return { name, provisioned };
}
