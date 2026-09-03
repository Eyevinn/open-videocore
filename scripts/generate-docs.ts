// Generate the multi-page static docs site at public/docs/ from the
// committed openapi.json (issue: CI-generated API reference docs).
//
// This is the single source for every page under public/docs/ — nobody
// should hand-edit files there directly. Guides, the introduction, the data
// model, installation, and authentication pages are hand-authored prose
// templates living in this script; the API reference section (one page per
// resource group, ~100 endpoints) is generated straight from openapi.json's
// paths/parameters/schemas, so it can never drift from the real contract.
//
// Usage:
//   tsx scripts/generate-docs.ts [path/to/openapi.json]
//
// Run automatically by .github/workflows/update-openapi.yml right after
// openapi.json itself is regenerated, and committed together with it.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
const OUT_DIR = join(ROOT, 'public/docs');
const SPEC_PATH = process.argv[2] ?? join(ROOT, 'openapi.json');

mkdirSync(OUT_DIR, { recursive: true });

type JsonSchema = Record<string, any>;
type Operation = Record<string, any>;

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
const paths: Record<string, Record<string, Operation>> = spec.paths;

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===========================================================================
// 1. API reference data — grouping, descriptions, extraction from the spec
// ===========================================================================

const GROUP_RULES: [string, string[]][] = [
  ['health', ['/health', '/healthz']],
  ['provisioning', ['/api/v1/provision']],
  ['optional-services', ['/api/v1/optional-services']],
  ['profiles', ['/api/v1/profiles']],
  ['assets', ['/api/v1/assets']],
  ['jobs', ['/api/v1/jobs']],
  ['pipelines', ['/api/v1/pipelines']],
  ['encore', ['/api/v1/encore']],
  ['scaler', ['/api/v1/scaler']],
  ['retention', ['/api/v1/retention']],
  ['logs', ['/api/v1/logs']],
  ['search', ['/api/v1/search']],
  ['webhooks', ['/api/v1/webhooks']],
  ['collections', ['/api/v1/collections']],
  ['storage', ['/api/v1/storage']],
  ['admin', ['/api/v1/admin']],
  ['internal', ['/api/v1/internal']],
  ['ui', ['/ui']]
];

const GROUP_META: Record<string, [string, string]> = {
  health: ['Health', 'Liveness probes.'],
  provisioning: [
    'Provisioning',
    "Provision and tear down a workspace's full OSC media stack (object storage, metadata store, queue)."
  ],
  'optional-services': ['Optional services', 'Discover and provision add-on OSC services for a workspace.'],
  profiles: [
    'Profiles',
    'Transcoding profiles served to the transcoder via the public, unauthenticated index.yml endpoint.'
  ],
  assets: [
    'Assets',
    'Asset lifecycle, ingest, upload, transcode, package, thumbnails, tracks, tags, delivery.'
  ],
  jobs: ['Jobs', 'Background job status for asynchronous asset operations.'],
  pipelines: ['Pipelines', 'Multi-step pipeline execution records.'],
  encore: ['Transcoder jobs', 'Direct transcoding job submission and status, bypassing the asset pipeline.'],
  scaler: ['Auto-scaler', 'Runtime configuration and status of the transcoder instance auto-scaler.'],
  retention: ['Retention', 'Soft-delete / retention window configuration.'],
  logs: ['Logs', 'Structured application log query.'],
  search: ['Search', 'Full-text and metadata search across assets.'],
  webhooks: ['Webhooks', 'HTTP event notification registrations.'],
  collections: ['Collections', 'Named groups for organising assets.'],
  storage: ['Storage', 'Object storage bucket and watch-folder management.'],
  admin: ['Admin', 'Watch-folder poller control.'],
  internal: [
    'Internal callbacks',
    'Called by the transcoder and packager services — not for direct client use.'
  ],
  ui: ['Ops UI', 'Built-in browser dashboard.']
};

// Hand-written per-endpoint descriptions. The spec has no operation-level
// summary/description fields, so these are authored here, grounded in each
// operation's own request/response schema (verified against openapi.json).
const DESCRIPTIONS: Record<string, string> = {
  'GET /health': 'Liveness probe that also reports service identity.',
  'GET /healthz': 'Minimal liveness probe.',
  'POST /api/v1/provision/':
    'Provision a full OSC media stack (object storage, metadata store, queue) for a new workspace. Asynchronous — returns an operation to poll.',
  'GET /api/v1/provision/': 'List provisioned stacks.',
  'GET /api/v1/provision/{name}': 'Get a provisioned stack by name.',
  'DELETE /api/v1/provision/{name}': 'Deprovision (tear down) a stack and its backing OSC service instances.',
  'GET /api/v1/provision/operations': 'List provisioning operations.',
  'GET /api/v1/provision/operations/{id}': "Get a single provisioning operation's status.",
  'GET /api/v1/optional-services/':
    "List optional add-on services and each one's provisioning state for the workspace.",
  'GET /api/v1/optional-services/{key}': "Get a single optional service's provisioning state.",
  'DELETE /api/v1/optional-services/{key}': 'Deprovision an optional service.',
  'POST /api/v1/optional-services/{key}/provision': 'Provision an optional service on demand.',
  'GET /api/v1/profiles/': 'List transcoding profiles (names for the picker, plus full items).',
  'POST /api/v1/profiles/': 'Create a transcoding profile from raw transcoder-format YAML.',
  'GET /api/v1/profiles/index.yml':
    'Public, unauthenticated profile index consumed by transcoder instances at transcode time.',
  'POST /api/v1/profiles/bootstrap':
    'Seed the profile store from the default transcoder test-profiles index. Pass `?force=true` to re-seed over existing profiles.',
  'GET /api/v1/profiles/{name}': 'Get a single profile.',
  'PUT /api/v1/profiles/{name}': "Replace a profile's YAML.",
  'DELETE /api/v1/profiles/{name}': 'Delete a profile.',
  'GET /api/v1/profiles/{name}/yaml': "Get a profile's raw YAML body.",
  'POST /api/v1/assets/': 'Create an asset record.',
  'GET /api/v1/assets/': 'List workspace assets.',
  'POST /api/v1/assets/ingest-url': 'Ingest a video from a public URL into a new asset.',
  'GET /api/v1/assets/search':
    'Deprecated legacy free-text-only search alias. Use the canonical Search endpoint instead.',
  'GET /api/v1/assets/by-tams-address': "Look up an asset by its TAMS flow/timerange address.",
  'GET /api/v1/assets/{id}': 'Get a single asset.',
  'PATCH /api/v1/assets/{id}': 'Update asset fields.',
  'DELETE /api/v1/assets/{id}': 'Delete an asset.',
  'GET /api/v1/assets/{id}/versions': "List an asset's version history.",
  'GET /api/v1/assets/{id}/delivery':
    'Get playback URLs for an asset (HLS/DASH manifests and/or presigned source download).',
  'GET /api/v1/assets/{id}/stream/{*}': 'Proxy-stream a packaged HLS/DASH manifest or media segment.',
  'GET /api/v1/assets/{id}/files': 'List the source and derived media files stored for an asset.',
  'POST /api/v1/assets/{id}/extract-metadata':
    "Extract technical metadata (codec, resolution, duration, bitrate) from the asset's source file.",
  'POST /api/v1/assets/{id}/transcode': 'Submit an ABR transcoding job for the asset.',
  'POST /api/v1/assets/{id}/package': "Submit an HLS/DASH packaging job for the asset's transcoded renditions.",
  'POST /api/v1/assets/{id}/execute':
    'Run a multi-step pipeline execution (e.g. transcode + package) against the asset.',
  'GET /api/v1/assets/{id}/executions': 'List pipeline executions for an asset.',
  'GET /api/v1/assets/{id}/executions/{execId}': 'Get a single pipeline execution.',
  'GET /api/v1/assets/{id}/pipelines': 'List pipeline definitions available to run against the asset.',
  'POST /api/v1/assets/{id}/comments': 'Add a review comment to an asset.',
  'GET /api/v1/assets/{id}/comments': 'List review comments on an asset.',
  'POST /api/v1/assets/{id}/thumbnails': 'Extract poster frame thumbnails at one or more timecodes.',
  'GET /api/v1/assets/{id}/thumbnails': 'List extracted thumbnails.',
  'POST /api/v1/assets/{id}/export': 'Re-wrap the asset into a different container format without re-encoding.',
  'POST /api/v1/assets/{id}/clip': 'Clip a time segment of the asset into a new child asset.',
  'GET /api/v1/assets/{id}/thumbnails/{index}': 'Get a single extracted thumbnail.',
  'PUT /api/v1/assets/{id}/metadata': "Replace an asset's free-form metadata.",
  'GET /api/v1/assets/{id}/tracks': "List an asset's audio and subtitle tracks.",
  'POST /api/v1/assets/{id}/audio-tracks': 'Add an audio track to an asset.',
  'DELETE /api/v1/assets/{id}/audio-tracks/{trackId}': 'Remove an audio track.',
  'POST /api/v1/assets/{id}/subtitle-tracks': 'Add a subtitle track to an asset.',
  'DELETE /api/v1/assets/{id}/subtitle-tracks/{trackId}': 'Remove a subtitle track.',
  'POST /api/v1/assets/{id}/tags': 'Add a tag to an asset.',
  'DELETE /api/v1/assets/{id}/tags/{tag}': 'Remove a tag from an asset.',
  'POST /api/v1/assets/{id}/review-state':
    "Transition an asset's editorial review state (draft / in-review / approved / rejected).",
  'POST /api/v1/assets/{id}/restore': "Restore a soft-deleted asset within its retention window.",
  'GET /api/v1/jobs/': 'List background jobs.',
  'DELETE /api/v1/jobs/{id}': 'Cancel or delete a job.',
  'GET /api/v1/jobs/{id}': 'Get a job.',
  'GET /api/v1/pipelines/': 'List pipeline executions across all assets.',
  'DELETE /api/v1/pipelines/{executionId}': 'Delete a pipeline execution record.',
  'GET /api/v1/pipelines/{executionId}': 'Get a pipeline execution.',
  'POST /api/v1/encore/encoreJobs':
    'Submit a transcoding job directly to the transcoder, bypassing the asset pipeline.',
  'GET /api/v1/encore/encoreJobs/{id}': "Get a transcoder job's status directly from the transcoder.",
  'POST /api/v1/internal/packagerCallback/success':
    'Packager success callback. Invoked by the packager service, not for direct client use.',
  'POST /api/v1/internal/packagerCallback/failure':
    'Packager failure callback. Invoked by the packager service, not for direct client use.',
  'POST /api/v1/internal/encore-callback':
    'Transcoder job progress/completion callback. Invoked by the transcoder, not for direct client use.',
  'PUT /api/v1/assets/{id}/upload': 'Direct upload of source media for an asset.',
  'POST /api/v1/assets/{id}/upload-url': "Get a presigned single-part upload URL for an asset's source media.",
  'POST /api/v1/assets/{id}/multipart/initiate': 'Initiate a multipart upload for large source media.',
  'GET /api/v1/assets/{id}/multipart/{uploadId}/part-url': 'Get a presigned URL for one multipart upload part.',
  'POST /api/v1/assets/{id}/multipart/{uploadId}/complete': 'Complete a multipart upload.',
  'DELETE /api/v1/assets/{id}/multipart/{uploadId}': 'Abort a multipart upload.',
  'POST /api/v1/assets/{id}/upload-complete': 'Finalize a completed direct or presigned upload.',
  'GET /api/v1/admin/watch-folder/status': 'Watch-folder poller status.',
  'POST /api/v1/admin/watch-folder/start': 'Start the watch-folder ingest poller.',
  'POST /api/v1/admin/watch-folder/stop': 'Stop the watch-folder ingest poller.',
  'GET /api/v1/scaler/status':
    'Current transcoder instance pool status (effective `maxInstances`, `idleTimeoutMs`).',
  'PATCH /api/v1/scaler/config':
    'Update auto-scaler configuration at runtime (`maxInstances`, `minInstances`, `idleTimeoutMs`).',
  'GET /api/v1/scaler/config': 'Get auto-scaler configuration.',
  'GET /api/v1/retention/config': 'Get the soft-delete retention window configuration.',
  'PATCH /api/v1/retention/config': 'Update the soft-delete retention window configuration.',
  'GET /api/v1/logs/': 'Query structured application logs.',
  'GET /api/v1/search/':
    'Full-text and metadata search across assets (canonical). Combines exact filters (`tags`, `mimeType`, `metadata.<key>`, `tamsFlowId`, `tamsTimerange`) with free-text `q`, all ANDed, paginated.',
  'POST /api/v1/webhooks/': 'Register a webhook.',
  'GET /api/v1/webhooks/': 'List webhooks.',
  'DELETE /api/v1/webhooks/{id}': 'Delete a webhook.',
  'POST /api/v1/collections/': 'Create a collection.',
  'GET /api/v1/collections/': 'List collections.',
  'GET /api/v1/collections/{id}': 'Get a collection.',
  'DELETE /api/v1/collections/{id}': 'Delete a collection.',
  'PUT /api/v1/collections/{id}/assets/{assetId}': 'Add an asset to a collection.',
  'DELETE /api/v1/collections/{id}/assets/{assetId}': 'Remove an asset from a collection.',
  'GET /api/v1/storage/buckets': 'List object storage buckets.',
  'POST /api/v1/storage/buckets': 'Create a bucket.',
  'GET /api/v1/storage/buckets/{bucket}/watch-folder': 'Get watch-folder status for a bucket.',
  'POST /api/v1/storage/buckets/{bucket}/watch-folder/toggle': 'Toggle watch-folder ingest for a bucket.',
  'GET /api/v1/storage/buckets/{bucket}/objects': 'List objects in a bucket.',
  'DELETE /api/v1/storage/buckets/{bucket}/objects/{*}': 'Delete an object from a bucket.',
  'GET /ui': 'Built-in ops dashboard for managing assets, jobs, profiles, and buckets.'
};

function groupFor(path: string): string {
  for (const [key, prefixes] of GROUP_RULES) {
    for (const prefix of prefixes) {
      if (path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix)) {
        return key;
      }
    }
  }
  return 'other';
}

const METHOD_ORDER: Record<string, number> = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4 };
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function slug(method: string, path: string): string {
  let s = `${method.toLowerCase()}-${path}`;
  s = s.replace(/[{}*/]/g, '-');
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
  return s;
}

type Endpoint = [string, string, Operation]; // method, path, operation

const groups = new Map<string, Endpoint[]>();
for (const [key] of GROUP_RULES) groups.set(key, []);
groups.set('other', []);

for (const [path, methods] of Object.entries(paths)) {
  const key = groupFor(path);
  for (const [method, op] of Object.entries(methods)) {
    if (HTTP_METHODS.includes(method.toLowerCase())) {
      groups.get(key)!.push([method.toUpperCase(), path, op]);
    }
  }
}
for (const eps of groups.values()) {
  eps.sort((a, b) => {
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return (METHOD_ORDER[a[0]] ?? 9) - (METHOD_ORDER[b[0]] ?? 9);
  });
}

function exampleForSchema(schema: JsonSchema | undefined, depth = 0): any {
  if (depth > 4 || !schema || typeof schema !== 'object') return null;
  if ('example' in schema) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const t = schema.type;
  if (t === 'object' || schema.properties) {
    const props = schema.properties ?? {};
    const required = new Set<string>(schema.required ?? []);
    const keys = [...Object.keys(props).filter((k) => required.has(k)), ...Object.keys(props).filter((k) => !required.has(k))];
    const out: Record<string, any> = {};
    for (const k of keys.slice(0, 12)) {
      out[k] = exampleForSchema(props[k], depth + 1);
    }
    return out;
  }
  if (t === 'array') {
    const item = exampleForSchema(schema.items, depth + 1);
    return item !== null ? [item] : [];
  }
  if (t === 'string') {
    if (schema.format === 'uri') return 'https://example.com/video.mp4';
    if (schema.format === 'date-time') return '2026-09-03T12:00:00.000Z';
    return 'string';
  }
  if (t === 'integer' || t === 'number') return 0;
  if (t === 'boolean') return true;
  if (t === undefined && 'additionalProperties' in schema) return {};
  return null;
}

function firstSuccessResponse(op: Operation): [string | null, any] {
  const responses = op.responses ?? {};
  for (const code of ['200', '201', '202', '204']) {
    if (responses[code]) return [code, responses[code]];
  }
  for (const [code, resp] of Object.entries(responses)) {
    if (code.startsWith('2')) return [code, resp];
  }
  return [null, null];
}

function renderParamsTable(params: any[] | undefined): string {
  if (!params || !params.length) return '';
  const rows = params
    .map((p) => {
      const name = esc(p.name ?? '');
      const loc = esc(p.in ?? '');
      const required = p.required ? 'required' : 'optional';
      const schema = p.schema ?? {};
      const enumVals = schema.enum;
      const typeStr = esc(schema.type ?? 'string') + (enumVals ? ` (${enumVals.join(', ')})` : '');
      return `<tr><td><code>${name}</code></td><td><span class="tag-${loc}">${loc}</span></td><td>${typeStr}</td><td>${required}</td></tr>`;
    })
    .join('');
  return `<table class="params"><thead><tr><th>Name</th><th>In</th><th>Type</th><th>Required</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderJsonBlock(label: string, obj: any): string {
  if (obj === null || obj === undefined) return '';
  const txt = JSON.stringify(obj, null, 2);
  return `<div class="code-block"><div class="code-label">${esc(label)}</div><pre><code>${esc(txt)}</code></pre></div>`;
}

function renderCurlBlock(label: string, txt: string): string {
  return `<div class="code-block"><div class="code-label">${esc(label)}</div><pre><code>${esc(txt)}</code></pre></div>`;
}

function renderPropertyNotes(schema: JsonSchema | undefined): string {
  if (!schema || !schema.properties) return '';
  const notes = Object.entries(schema.properties as Record<string, any>).filter(([, v]) => v?.description);
  if (!notes.length) return '';
  const items = notes.map(([k, v]) => `<li><code>${esc(k)}</code> — ${esc(v.description)}</li>`).join('');
  return `<div class="field-notes"><strong>Field notes</strong><ul>${items}</ul></div>`;
}

function fileForGroup(key: string): string {
  return `ref-${key}.html`;
}

const groupOrder = GROUP_RULES.map(([k]) => k).filter((k) => (groups.get(k) ?? []).length > 0);

// ===========================================================================
// 2. Guides — task-oriented pages (hand-authored, grounded in the endpoints
//    above; kept in this script so a single generator owns the whole site).
// ===========================================================================

function refEx(method: string, path: string, extra = ''): string {
  return `<code>${method} ${esc(path)}</code>${extra ? ' — ' + extra : ''}`;
}

const GUIDES: { slug: string; title: string; blurb: string }[] = [
  {
    slug: 'guide-ingest',
    title: 'Ingesting media',
    blurb:
      'Get source video into open-videocore: from a URL, direct upload, presigned/multipart upload, or an object storage watch-folder.'
  },
  {
    slug: 'guide-transcode-package',
    title: 'Transcoding & packaging',
    blurb: 'Turn source media into an ABR ladder and package it as HLS/DASH — as separate steps, or chained in one pipeline.'
  },
  {
    slug: 'guide-metadata-search',
    title: 'Metadata, tags & search',
    blurb: 'Attach descriptive and technical metadata, tag assets, and find them again with full-text and filtered search.'
  },
  {
    slug: 'guide-thumbnails-clips-export',
    title: 'Thumbnails, clips & export',
    blurb: 'Extract poster frames, cut a sub-segment into a new asset, and re-wrap into a different container.'
  },
  {
    slug: 'guide-delivery',
    title: 'Delivery & playback',
    blurb: 'Get a playable URL for an asset — proxied HLS/DASH manifests or a presigned source download.'
  },
  {
    slug: 'guide-organizing',
    title: 'Organizing: collections & webhooks',
    blurb: 'Group related assets into collections, and get HTTP notifications when asset and job state changes.'
  },
  {
    slug: 'guide-operating',
    title: 'Operating a workspace',
    blurb: 'Provision a workspace\'s backing stack, tune the transcoder auto-scaler, manage storage buckets, and configure retention.'
  }
];

const GUIDE_BODIES: Record<string, string> = {
  'guide-ingest': `
<p>Every asset starts as a record, then gets its source media attached to it one of four ways. Pick the one that matches where your video already lives.</p>

<h2 id="create">1. Create the asset record</h2>
<p>An asset always starts as a record you create explicitly, or one created for you by the ingest-from-URL shortcut below.</p>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/assets \\\n  -H "Content-Type: application/json" \\\n  -d \'{"title": "Keynote recording", "description": "Opening keynote, main stage"}\'')}
<p>See ${refEx('POST', '/api/v1/assets/', 'full field list')} in the <a href="ref-assets.html#post-api-v1-assets">Assets reference</a>.</p>

<h2 id="url">2. Ingest from a public URL</h2>
<p>If the source file is already reachable over HTTP(S), skip the manual create step — this creates the asset and starts the download in one call:</p>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/assets/ingest-url \\\n  -H "Content-Type: application/json" \\\n  -d \'{"sourceUrl": "https://example.com/video.mp4", "title": "Keynote recording"}\'')}
<p>This returns a <a href="data-model.html#job">Job</a> of type <code>ingest-url</code>. Poll ${refEx('GET', '/api/v1/jobs/{id}')} until <code>status</code> is <code>done</code>; the job's <code>assetId</code> is the asset to work with next.</p>

<h2 id="direct-upload">3. Direct upload (small files)</h2>
<p>For files you already have locally and that are small enough to send in one request:</p>
${renderCurlBlock('Request', 'curl -X PUT https://<your-instance>/api/v1/assets/<id>/upload \\\n  -H "Content-Type: video/mp4" \\\n  --data-binary @video.mp4')}

<h2 id="presigned">4. Presigned upload (browser / large single-part)</h2>
<p>To upload directly to object storage from a browser or client without proxying bytes through the API, get a presigned URL first, upload to it, then tell the API the upload finished:</p>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/assets/<id>/upload-url\n# -> { "url": "https://...", ... } — PUT your file bytes to that URL, then:\ncurl -X POST https://<your-instance>/api/v1/assets/<id>/upload-complete')}

<h2 id="multipart">5. Multipart upload (large files)</h2>
<p>For files too large for a single PUT, initiate a multipart upload, request a presigned URL per part, upload each part directly to storage, then complete:</p>
<ol>
  <li>${refEx('POST', '/api/v1/assets/{id}/multipart/initiate')}</li>
  <li>${refEx('GET', '/api/v1/assets/{id}/multipart/{uploadId}/part-url', 'once per part')}</li>
  <li>${refEx('POST', '/api/v1/assets/{id}/multipart/{uploadId}/complete')}</li>
  <li>If something goes wrong: ${refEx('DELETE', '/api/v1/assets/{id}/multipart/{uploadId}', 'abort')}</li>
</ol>

<h2 id="watch-folder">6. Watch-folder ingest</h2>
<p>Point open-videocore at an object storage bucket and it will pick up new files automatically, without any per-file API call:</p>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/storage/buckets/<bucket>/watch-folder/toggle \\\n  -H "Content-Type: application/json" \\\n  -d \'{"enabled": true}\'')}
<p>See <a href="ref-storage.html">Storage reference</a> for bucket listing and the poller's own start/stop controls in <a href="ref-admin.html">Admin</a>.</p>

<div class="callout">Every path above ends at the same place: an <a href="data-model.html#asset">Asset</a> with <code>status</code> moving from <code>uploading</code> to <code>processing</code> to <code>ready</code> (or <code>failed</code>). Watch that field, or an <a href="guide-organizing.html#webhooks">asset.ready / asset.failed webhook</a>, rather than polling the job directly once the source file has landed.</div>
`,
  'guide-transcode-package': `
<p>Once an asset has source media, generating a streamable ABR ladder is a two-stage pipeline: transcode, then package. You can run either stage alone, or chain both in one call.</p>

<h2 id="profiles">1. Pick a transcoding profile</h2>
<p>Profiles describe the output rendition ladder (resolutions, bitrates, codecs) and are stored per workspace. A fresh workspace has none until you seed the defaults:</p>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/profiles/bootstrap')}
<p>List what's available with ${refEx('GET', '/api/v1/profiles/')}, or add your own with ${refEx('POST', '/api/v1/profiles/', 'raw YAML body')}. See the full shape in the <a href="ref-profiles.html">Profiles reference</a>.</p>

<h2 id="transcode">2. Submit a transcode job</h2>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/assets/<id>/transcode \\\n  -H "Content-Type: application/json" \\\n  -d \'{"profile": "<profile-name>"}\'')}
<p>This returns a <a href="data-model.html#job">Job</a> of type <code>transcode</code>. Poll ${refEx('GET', '/api/v1/jobs/{id}')} for <code>status</code>, <code>progress</code>, and — once done — <code>renditionAssetIds</code>, the child assets holding each rendition.</p>
<div class="callout">The first transcode submitted to an idle workspace pays a cold-start cost while the auto-scaler spins up a transcoder instance (roughly 60–120s). See <a href="guide-operating.html#scaler">Operating a workspace &rarr; auto-scaler</a> to trade that off against standing cost with a warm floor.</div>

<h2 id="package">3. Package into HLS/DASH</h2>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/assets/<id>/package')}
<p>The packager is provisioned lazily on a workspace's first packaging job and reused afterwards — the very first call on a fresh workspace pays a similar cold-start cost to the transcoder's. Once done, manifest URLs are attached to the asset; fetch them with the <a href="guide-delivery.html">Delivery guide</a>.</p>

<h2 id="pipeline">4. Or: run both as one pipeline</h2>
<p>To avoid manually sequencing the two calls above and polling each job in turn, run them as a single pipeline execution:</p>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/assets/<id>/execute \\\n  -H "Content-Type: application/json" \\\n  -d \'{"pipeline": "transcode-and-package", "profile": "<profile-name>"}\'')}
<p>Poll ${refEx('GET', '/api/v1/assets/{id}/executions/{execId}')} for a single <code>status</code> covering every step. See <a href="ref-pipelines.html">Pipelines reference</a> for the execution shape, and ${refEx('GET', '/api/v1/assets/{id}/pipelines')} to list which pipeline names are available to run.</p>
`,
  'guide-metadata-search': `
<p>Assets carry two kinds of metadata — technical (read off the file itself) and free-form (whatever your application wants to attach) — plus tags, and both feed the same search endpoint.</p>

<h2 id="technical">1. Extract technical metadata</h2>
<p>Codec, resolution, duration, and bitrate are not known until you ask for them:</p>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/assets/<id>/extract-metadata')}
<p>Results land on the asset's <code>technicalMetadata</code> field (see the <a href="data-model.html#asset">Asset</a> entity).</p>

<h2 id="freeform">2. Attach free-form metadata</h2>
${renderCurlBlock('Request', 'curl -X PUT https://<your-instance>/api/v1/assets/<id>/metadata \\\n  -H "Content-Type: application/json" \\\n  -d \'{"key-value": "pairs specific to your application"}\'')}
<p>This is a full replace, not a merge — see ${refEx('PUT', '/api/v1/assets/{id}/metadata')} in the <a href="ref-assets.html">Assets reference</a>.</p>

<h2 id="tags">3. Tag assets</h2>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/assets/<id>/tags \\\n  -H "Content-Type: application/json" \\\n  -d \'{"tag": "keynote"}\'')}
<p>Remove one with ${refEx('DELETE', '/api/v1/assets/{id}/tags/{tag}')}.</p>

<h2 id="search">4. Search</h2>
<p>One endpoint covers both free text and exact filters, ANDed together and paginated:</p>
${renderCurlBlock('Request', 'curl "https://<your-instance>/api/v1/search?q=keynote&tags=stage-a&page=1&pageSize=20"')}
<p>Exact-filter fields: <code>tags</code>, <code>mimeType</code>, <code>metadata.&lt;key&gt;</code>, <code>tamsFlowId</code>, <code>tamsTimerange</code>. Free text (<code>q</code>) matches over name and description. Full shape in the <a href="ref-search.html">Search reference</a>.</p>
<div class="callout warn"><code>GET /api/v1/assets/search</code> is a deprecated, free-text-only alias kept for backward compatibility — new integrations should use <code>/api/v1/search</code> above.</div>

<h2 id="tracks">5. Audio and subtitle tracks</h2>
<p>List an asset's tracks with ${refEx('GET', '/api/v1/assets/{id}/tracks')}; add or remove one with ${refEx('POST', '/api/v1/assets/{id}/audio-tracks')} / ${refEx('POST', '/api/v1/assets/{id}/subtitle-tracks')} and their <code>DELETE</code> counterparts. See the <a href="ref-assets.html">Assets reference</a> for the full set.</p>
`,
  'guide-thumbnails-clips-export': `
<h2 id="thumbnails">Poster frame thumbnails</h2>
<p>Extract one or more poster frames at arbitrary timecodes:</p>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/assets/<id>/thumbnails \\\n  -H "Content-Type: application/json" \\\n  -d \'{"timecodes": ["00:00:05", "00:01:30"]}\'')}
<p>List them with ${refEx('GET', '/api/v1/assets/{id}/thumbnails')}, or fetch one by index with ${refEx('GET', '/api/v1/assets/{id}/thumbnails/{index}')}.</p>

<h2 id="clip">Clip a segment</h2>
<p>Cut a time range out of an asset into a new, independent child asset — the source is untouched:</p>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/assets/<id>/clip \\\n  -H "Content-Type: application/json" \\\n  -d \'{"startTime": "00:02:00", "endTime": "00:02:30"}\'')}

<h2 id="export">Export / re-wrap</h2>
<p>Change container format (e.g. MP4 → MOV) without re-encoding the essence:</p>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/assets/<id>/export \\\n  -H "Content-Type: application/json" \\\n  -d \'{"format": "mov"}\'')}
<p>Both clip and export return a job — poll it the same way as a transcode job. Full request/response shapes in the <a href="ref-assets.html">Assets reference</a>.</p>
`,
  'guide-delivery': `
<p>Once an asset is packaged (or if you just need the source back), one endpoint resolves the right URL for playback.</p>

<h2 id="delivery">Get playback URLs</h2>
${renderCurlBlock('Request', 'curl https://<your-instance>/api/v1/assets/<id>/delivery')}
<p>Depending on the asset's state, this returns HLS/DASH manifest URLs (proxy-streamed through the API), a presigned source download, or both. See <a href="../../docs/architecture/ADR-003-delivery-and-stream-url-contract.md">ADR-003</a> in the repository for the full contract this endpoint follows.</p>

<h2 id="stream">Streaming manifests and segments</h2>
<p>Manifest URLs returned above point back at:</p>
${renderCurlBlock('Path', 'GET /api/v1/assets/{id}/stream/*')}
<p>This proxy-streams the packaged HLS/DASH manifest and its media segments, so player requests never need direct access to the underlying object storage bucket or its credentials.</p>
`,
  'guide-organizing': `
<h2 id="collections">Collections</h2>
<p>A collection is a named, flat group of assets — useful for shows, campaigns, or any grouping that doesn't belong on the asset record itself.</p>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/collections \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name": "Q3 keynotes"}\'')}
<p>Add and remove assets with ${refEx('PUT', '/api/v1/collections/{id}/assets/{assetId}')} / ${refEx('DELETE', '/api/v1/collections/{id}/assets/{assetId}')}. Full shape in the <a href="ref-collections.html">Collections reference</a>.</p>

<h2 id="webhooks">Webhooks</h2>
<p>Register an HTTP endpoint to be notified as assets and jobs change state, instead of polling:</p>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/webhooks \\\n  -H "Content-Type: application/json" \\\n  -d \'{"url": "https://your-app.example.com/hooks/videocore", "events": ["asset.ready", "transcode.complete", "package.complete"]}\'')}
<p>Available events: <code>asset.ready</code>, <code>asset.failed</code>, <code>transcode.complete</code>, <code>transcode.failed</code>, <code>package.complete</code>, <code>package.failed</code>. Pass a <code>secret</code> to have deliveries signed. Full shape in the <a href="ref-webhooks.html">Webhooks reference</a>.</p>
`,
  'guide-operating': `
<p>Day-to-day asset operations don't need any of this — it's for the person standing up and tuning a workspace. For first-time setup, see <a href="installation.html">Installation</a>.</p>

<h2 id="provision">Provision a workspace stack</h2>
<p>One call stands up a workspace's object storage, metadata store, and queue. The transcoder and packager are <em>not</em> included — both are provisioned lazily, the first time they're actually needed.</p>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/provision \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name": "mystack"}\'')}
<p>This is asynchronous — poll ${refEx('GET', '/api/v1/provision/operations/{id}')} for <code>status</code>. Tear a stack down with ${refEx('DELETE', '/api/v1/provision/{name}')}. Full shape in the <a href="ref-provisioning.html">Provisioning reference</a>.</p>

<h2 id="scaler">Tune the transcoder auto-scaler</h2>
<p>The auto-scaler keeps a per-workspace pool of transcoder instances and scales it on demand. By default it scales to zero when idle, trading standing cost for cold-start latency on the first job of a burst.</p>
${renderCurlBlock('Request', 'curl -X PATCH https://<your-instance>/api/v1/scaler/config \\\n  -H "Content-Type: application/json" \\\n  -d \'{"minInstances": 1, "maxInstances": 3, "idleTimeoutMs": 300000}\'')}
<p>Set <code>minInstances</code> to 1 or more for production and latency-sensitive workloads, so the first job of a burst never pays the cold start. See ${refEx('GET', '/api/v1/scaler/status')} for the pool's live state and the <a href="ref-scaler.html">Auto-scaler reference</a> for every field.</p>

<h2 id="optional-services">Optional services</h2>
<p>Add-on capabilities beyond the core stack are provisioned per workspace, on demand:</p>
${renderCurlBlock('Request', 'curl -X POST https://<your-instance>/api/v1/optional-services/<key>/provision')}
<p>List what's available and each one's state with ${refEx('GET', '/api/v1/optional-services/')}. Full shape in the <a href="ref-optional-services.html">Optional services reference</a>.</p>

<h2 id="storage">Storage buckets</h2>
<p>Browse and manage the object storage buckets backing a workspace with ${refEx('GET', '/api/v1/storage/buckets')}, list what's inside one with ${refEx('GET', '/api/v1/storage/buckets/{bucket}/objects')}, and toggle watch-folder ingest per bucket — see the <a href="guide-ingest.html#watch-folder">Ingesting media</a> guide and the <a href="ref-storage.html">Storage reference</a>.</p>

<h2 id="retention">Retention</h2>
<p>Deleted assets are soft-deleted and recoverable within a configurable window:</p>
${renderCurlBlock('Request', 'curl https://<your-instance>/api/v1/retention/config')}
<p>Restore an asset within that window with ${refEx('POST', '/api/v1/assets/{id}/restore')}. Full shape in the <a href="ref-retention.html">Retention reference</a>.</p>
`
};

// ===========================================================================
// 3. Shared shell (CSS/JS/nav)
// ===========================================================================

const STATIC_PAGES: [string, string][] = [
  ['introduction.html', 'Introduction'],
  ['data-model.html', 'Data model'],
  ['installation.html', 'Installation'],
  ['authentication.html', 'Authentication & errors']
];

const CSS = `
:root{
  --bg:#ffffff; --bg-side:#f6f7f9; --bg-code:#1e2530; --text:#1c2128; --text-dim:#5b6572;
  --border:#e3e6ea; --accent:#1e3a8a; --accent-soft:#eef1fb;
  --get:#2563eb; --post:#16a34a; --put:#d97706; --patch:#7c3aed; --delete:#dc2626;
  --code-text:#d6e0ff;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  color:var(--text); background:var(--bg); font-size:15px; line-height:1.6;
}
a{color:var(--accent); text-decoration:none}
a:hover{text-decoration:underline}
code, pre{font-family:"SF Mono",Menlo,Consolas,monospace; font-size:13px}
code{background:var(--accent-soft); padding:1px 5px; border-radius:4px; color:#1e3a8a}
.layout{display:flex; min-height:100vh}
.sidebar{
  width:290px; flex:0 0 290px; background:var(--bg-side); border-right:1px solid var(--border);
  height:100vh; position:sticky; top:0; overflow-y:auto; padding:0 0 40px;
}
.brand{padding:22px 20px 14px; border-bottom:1px solid var(--border); display:block}
.brand .logo{font-size:19px; font-weight:700; letter-spacing:-0.01em; color:var(--text)}
.brand .logo span{color:var(--accent)}
.brand .version{font-size:12px; color:var(--text-dim); margin-top:2px}
.search-box{padding:12px 16px}
.search-box input{width:100%; padding:8px 10px; border:1px solid var(--border); border-radius:6px; font-size:13px; background:#fff}
.nav-top{padding:10px 8px 4px}
.nav-top-link{display:block; padding:7px 12px; border-radius:6px; font-size:13.5px; color:var(--text); font-weight:600}
.nav-top-link:hover{background:var(--accent-soft); text-decoration:none}
.nav-top-link.active{background:var(--accent); color:#fff}
.nav-section-label{padding:16px 16px 4px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--text-dim); border-top:1px solid var(--border); margin-top:8px}
.nav-guides{padding:2px 8px 6px}
.nav-guide-link{display:block; padding:6px 12px; border-radius:6px; font-size:13px; color:var(--text)}
.nav-guide-link:hover{background:var(--accent-soft); text-decoration:none}
.nav-guide-link.active{background:var(--accent-soft); font-weight:700; color:var(--accent)}
.nav-group{}
.nav-group-title{width:100%; display:flex; justify-content:space-between; align-items:center; text-align:left; background:none; border:none; padding:8px 16px; font-size:12.5px; font-weight:700; color:var(--text)}
.nav-group-title:hover{background:var(--accent-soft); text-decoration:none}
.nav-group-title.active{color:var(--accent)}
.group-title-right{display:flex; align-items:center; gap:6px}
.nav-group-title .count{font-weight:500; background:var(--border); color:var(--text-dim); border-radius:10px; font-size:11px; padding:0 7px}
.chevron{background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:11px;padding:2px 4px}
.nav-group-items{display:flex; flex-direction:column; padding:0 8px 6px}
.nav-group-items.collapsed{display:none}
.nav-endpoint{display:flex; align-items:center; gap:8px; padding:4px 8px; border-radius:5px; font-size:12px; color:var(--text); white-space:nowrap; overflow:hidden}
.nav-endpoint:hover{background:var(--accent-soft); text-decoration:none}
.nav-endpoint.hl{background:var(--accent-soft); font-weight:600}
.nav-path{overflow:hidden; text-overflow:ellipsis; font-family:"SF Mono",Menlo,Consolas,monospace; font-size:11px; color:var(--text-dim)}
.badge{display:inline-block; font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; color:#fff; min-width:42px; text-align:center; letter-spacing:.02em; flex:0 0 auto}
.badge-GET{background:var(--get)} .badge-POST{background:var(--post)} .badge-PUT{background:var(--put)} .badge-PATCH{background:var(--patch)} .badge-DELETE{background:var(--delete)}
.main{flex:1; min-width:0; padding:48px 56px 120px; max-width:860px}
.main h1{font-size:30px; margin:0 0 6px}
.main h2{font-size:21px; margin-top:38px; padding-bottom:8px; border-bottom:1px solid var(--border); scroll-margin-top:20px}
.main h3{font-size:16px}
.lede{color:var(--text-dim); font-size:16.5px; margin-top:0}
.hero-links{margin:18px 0 40px; display:flex; gap:10px; flex-wrap:wrap}
.hero-links a{border:1px solid var(--border); padding:7px 14px; border-radius:7px; font-size:13.5px; font-weight:600; color:var(--text)}
.hero-links a:hover{background:var(--accent-soft); text-decoration:none; border-color:var(--accent)}
.crumb{font-size:12.5px; color:var(--text-dim); margin-bottom:6px}
.crumb a{color:var(--text-dim)}
.group-blurb{color:var(--text-dim); margin-top:-6px}
.card-grid{display:grid; grid-template-columns:repeat(auto-fill, minmax(230px,1fr)); gap:14px; margin:20px 0}
.card{border:1px solid var(--border); border-radius:10px; padding:16px 18px; display:block; color:var(--text)}
.card:hover{border-color:var(--accent); background:var(--accent-soft); text-decoration:none}
.card .card-title{font-weight:700; font-size:14.5px; display:flex; align-items:center; justify-content:space-between}
.card .card-count{font-size:11px; color:var(--text-dim); background:var(--border); border-radius:10px; padding:0 7px}
.card .card-desc{color:var(--text-dim); font-size:13px; margin-top:6px}
.steps{counter-reset:step; list-style:none; padding:0; margin:0}
.steps > li{counter-increment:step; position:relative; padding:0 0 28px 40px; border-left:2px solid var(--border); margin-left:14px}
.steps > li:last-child{border-color:transparent; padding-bottom:0}
.steps > li::before{content:counter(step); position:absolute; left:-15px; top:0; width:28px; height:28px; background:var(--accent); color:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:700}
.steps h3{margin:0 0 6px}
.steps p{margin:6px 0}
.code-block{margin:12px 0; border-radius:8px; overflow:hidden; border:1px solid #2a3242}
.code-label{background:#161b24; color:#8b96a8; font-size:11px; padding:6px 12px; font-family:"SF Mono",Menlo,Consolas,monospace; letter-spacing:.02em; text-transform:uppercase}
.code-block pre{margin:0; background:var(--bg-code); color:var(--code-text); padding:14px; overflow-x:auto}
.code-block code{background:none; color:inherit; padding:0}
table.params, table.env, table.model{width:100%; border-collapse:collapse; margin:10px 0 18px; font-size:13.5px}
table.params th, table.params td, table.env th, table.env td, table.model th, table.model td{text-align:left; padding:7px 10px; border-bottom:1px solid var(--border); vertical-align:top}
table.params th, table.env th, table.model th{color:var(--text-dim); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.03em}
.tag-path{color:#7c3aed; font-weight:600} .tag-query{color:#2563eb; font-weight:600} .tag-header{color:#d97706; font-weight:600}
.endpoint{border:1px solid var(--border); border-radius:10px; padding:20px 22px; margin-bottom:22px; scroll-margin-top:24px}
.endpoint h3{margin:0 0 8px; font-size:16px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; border:none; padding:0}
.endpoint h3 .path{background:none; padding:0; color:var(--text); font-size:14.5px}
.endpoint-desc{color:var(--text-dim); margin:0 0 4px}
.endpoint h4{font-size:12.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--text-dim); margin:18px 0 6px; border:none}
.field-notes{background:var(--bg-side); border-radius:8px; padding:10px 14px; margin:8px 0 4px; font-size:13px}
.field-notes ul{margin:6px 0 0; padding-left:18px}
.field-notes li{margin-bottom:4px}
.callout{background:var(--accent-soft); border-left:3px solid var(--accent); padding:12px 16px; border-radius:0 8px 8px 0; margin:14px 0; font-size:14px}
.callout.warn{background:#fff7ed; border-left-color:#d97706}
.entity-card{border:1px solid var(--border); border-radius:10px; padding:18px 20px; margin-bottom:24px; scroll-margin-top:24px}
.entity-card h3{margin-top:0}
.rel-diagram{font-family:"SF Mono",Menlo,Consolas,monospace; font-size:12.5px; background:var(--bg-side); border:1px solid var(--border); border-radius:10px; padding:18px; overflow-x:auto; white-space:pre; line-height:1.5; margin:16px 0 28px}
footer.doc-footer{border-top:1px solid var(--border); margin-top:60px; padding-top:20px; color:var(--text-dim); font-size:13px}
.pager{display:flex; justify-content:space-between; margin-top:50px; padding-top:20px; border-top:1px solid var(--border)}
.pager a{border:1px solid var(--border); border-radius:8px; padding:10px 16px; font-size:13.5px; font-weight:600; color:var(--text)}
.pager a:hover{border-color:var(--accent); background:var(--accent-soft); text-decoration:none}
.pager .dir{display:block; font-size:11px; color:var(--text-dim); font-weight:500; text-transform:uppercase; letter-spacing:.04em}
@media (max-width: 900px){ .sidebar{position:static; width:100%; height:auto; flex:none} .layout{flex-direction:column} .main{padding:32px 20px} }
`;

const JS = `
document.querySelectorAll('.chevron').forEach(function(btn){
  btn.addEventListener('click', function(e){
    e.preventDefault();
    var target = document.getElementById(btn.dataset.toggle);
    target.classList.toggle('collapsed');
  });
});
var searchInput = document.getElementById('nav-search');
if (searchInput) {
  searchInput.addEventListener('input', function(){
    var q = searchInput.value.trim().toLowerCase();
    document.querySelectorAll('.nav-group').forEach(function(group){
      var anyVisible = false;
      group.querySelectorAll('.nav-endpoint').forEach(function(a){
        var match = !q || a.textContent.toLowerCase().indexOf(q) !== -1;
        a.style.display = match ? '' : 'none';
        if (match) anyVisible = true;
      });
      var items = group.querySelector('.nav-group-items');
      if (q) items.classList.remove('collapsed');
      group.style.display = (q && !anyVisible) ? 'none' : '';
    });
  });
}
var navLinks = document.querySelectorAll('.nav-endpoint');
var sections = Array.prototype.slice.call(document.querySelectorAll('.endpoint'));
if (sections.length) {
  window.addEventListener('scroll', function(){
    var y = window.scrollY + 80;
    var current = null;
    sections.forEach(function(s){ if (s.offsetTop <= y) current = s; });
    navLinks.forEach(function(a){ a.classList.remove('hl'); });
    if (current) {
      var link = document.querySelector('.nav-endpoint[href$="#' + current.id + '"]');
      if (link) link.classList.add('hl');
    }
  }, {passive:true});
}
`;

function renderNav(activeFile: string): string {
  const staticItems = STATIC_PAGES.map(
    ([fname, label]) => `<a href="${fname}" class="nav-top-link${fname === activeFile ? ' active' : ''}">${esc(label)}</a>`
  ).join('');

  const guideItems = GUIDES.map((g) => {
    const fname = g.slug + '.html';
    return `<a href="${fname}" class="nav-guide-link${fname === activeFile ? ' active' : ''}">${esc(g.title)}</a>`;
  }).join('');

  const groupBlocks = GROUP_RULES.map(([key]) => {
    const ops = groups.get(key) ?? [];
    if (!ops.length) return '';
    const [title] = GROUP_META[key] ?? [key, ''];
    const fname = fileForGroup(key);
    const isActive = fname === activeFile;
    const navItems = ops
      .map(([method, path]) => {
        const sid = slug(method, path);
        return `<a href="${fname}#${sid}" class="nav-endpoint" data-method="${method}"><span class="badge badge-${method}">${method}</span><span class="nav-path">${esc(path)}</span></a>`;
      })
      .join('');
    return `
<div class="nav-group">
  <a class="nav-group-title${isActive ? ' active' : ''}" href="${fname}">
    <span>${esc(title)}</span>
    <span class="group-title-right"><span class="count">${ops.length}</span><button class="chevron" type="button" data-toggle="group-${key}" aria-label="toggle">&#9662;</button></span>
  </a>
  <div class="nav-group-items${isActive ? '' : ' collapsed'}" id="group-${key}">${navItems}</div>
</div>
`;
  }).join('');

  const agenticFname = 'agentic-examples.html';
  return `
    <div class="nav-top">${staticItems}</div>
    <div class="nav-section-label">Guides</div>
    <div class="nav-guides">${guideItems}</div>
    <div class="nav-section-label">Agentic examples</div>
    <div class="nav-guides"><a href="${agenticFname}" class="nav-guide-link${agenticFname === activeFile ? ' active' : ''}">Agentic examples</a></div>
    <div class="nav-section-label">API reference</div>
    ${groupBlocks}
`;
}

// Canonical public URL of the published docs site (see .github/workflows/publish-docs.yml).
// Used for canonical links, Open Graph/Twitter tags, JSON-LD, sitemap.xml, and llms.txt.
const SITE_URL = 'https://videocore.pages.osaas.io';
const SITE_NAME = 'open-videocore documentation';
const OG_IMAGE_URL = `${SITE_URL}/og-image.png`;
const SITE_DESCRIPTION =
  'Headless, API-first media asset management middleware for ingesting, transcoding, packaging, searching, and delivering video — running entirely on Open Source Cloud.';

function canonicalUrl(fname: string): string {
  return fname === 'index.html' ? `${SITE_URL}/` : `${SITE_URL}/${fname}`;
}

// Collected while pages are generated, then flushed to sitemap.xml / llms.txt /
// llms-full.txt once every page has been written (see the bottom of this file).
const pageIndex: { fname: string; title: string; description: string; section: string; bodyHtml: string }[] = [];

function pageShell(
  title: string,
  description: string,
  activeFile: string,
  bodyHtml: string,
  prev?: [string, string],
  next?: [string, string]
): string {
  const nav = renderNav(activeFile);
  let pager = '';
  if (prev || next) {
    const prevHtml = prev
      ? `<a href="${prev[0]}"><span class="dir">&larr; Previous</span>${esc(prev[1])}</a>`
      : '<span></span>';
    const nextHtml = next
      ? `<a href="${next[0]}" style="text-align:right"><span class="dir">Next &rarr;</span>${esc(next[1])}</a>`
      : '<span></span>';
    pager = `<div class="pager">${prevHtml}${nextHtml}</div>`;
  }
  const url = canonicalUrl(activeFile);
  const fullTitle = activeFile === 'index.html' ? title : `${title} · open-videocore docs`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: title,
    description,
    url,
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: `${SITE_URL}/` },
    breadcrumb: {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Docs', item: `${SITE_URL}/` },
        ...(activeFile === 'index.html' ? [] : [{ '@type': 'ListItem', position: 2, name: title, item: url }])
      ]
    }
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<link rel="icon" href="data:,">
<meta property="og:type" content="${activeFile === 'index.html' ? 'website' : 'article'}">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${OG_IMAGE_URL}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="open-videocore — API-first media asset management on Open Source Cloud">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${OG_IMAGE_URL}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>${CSS}</style>
<script defer src="https://umami-eyevinn.users.osaas.io/script.js" data-website-id="41cc05c2-445c-4fd2-a89c-4ec1b183089f"></script>
</head>
<body>
<div class="layout">
  <nav class="sidebar">
    <a class="brand" href="index.html">
      <div class="logo">open<span>videocore</span></div>
      <div class="version">Documentation &middot; v${esc(spec.info?.version ?? '1.0.0')}</div>
    </a>
    <div class="search-box"><input type="search" id="nav-search" placeholder="Filter endpoints&hellip;" autocomplete="off"></div>
    ${nav}
  </nav>
  <main class="main">
    ${bodyHtml}
    ${pager}
    <footer class="doc-footer">The API reference is generated from <code>openapi.json</code>, committed in the open-videocore repository. Interactive, always-current reference docs are also served at <code>/api-docs</code> on any running instance.</footer>
  </main>
</div>
<script>${JS}</script>
</body>
</html>
`;
}

function write(
  fname: string,
  title: string,
  description: string,
  body: string,
  prev?: [string, string],
  next?: [string, string],
  section = 'Reference'
) {
  writeFileSync(join(OUT_DIR, fname), pageShell(title, description, fname, body, prev, next));
  pageIndex.push({ fname, title, description, section, bodyHtml: body });
}

// ===========================================================================
// 4. Reference group pages
// ===========================================================================

function renderGroupPage(key: string): string {
  const ops = groups.get(key) ?? [];
  const [title, blurb] = GROUP_META[key] ?? [key, ''];
  const items = ops
    .map(([method, path, op]) => {
      const sid = slug(method, path);
      const desc = DESCRIPTIONS[`${method} ${path}`] ?? '';
      const paramsHtml = renderParamsTable(op.parameters);

      let reqHtml = '';
      if (op.requestBody) {
        for (const [ctype, cval] of Object.entries(op.requestBody.content ?? {})) {
          const schema = (cval as any).schema;
          reqHtml += renderJsonBlock(`Request body (${ctype})`, exampleForSchema(schema));
          reqHtml += renderPropertyNotes(schema);
        }
      }

      let respHtml = '';
      const [code, resp] = firstSuccessResponse(op);
      if (resp) {
        const content = resp.content ?? {};
        if (Object.keys(content).length) {
          for (const [ctype, cval] of Object.entries(content)) {
            const schema = (cval as any).schema;
            respHtml += renderJsonBlock(`Response ${code} (${ctype})`, exampleForSchema(schema));
            respHtml += renderPropertyNotes(schema);
          }
        } else {
          respHtml += `<div class="code-block"><div class="code-label">Response ${code}</div><pre><code>(no body)</code></pre></div>`;
        }
      }

      return `
<article class="endpoint" id="${sid}">
  <h3><span class="badge badge-${method}">${method}</span> <code class="path">${esc(path)}</code></h3>
  <p class="endpoint-desc">${esc(desc)}</p>
  ${paramsHtml ? `<h4>Parameters</h4>${paramsHtml}` : ''}
  ${reqHtml ? `<h4>Request</h4>${reqHtml}` : ''}
  ${respHtml ? `<h4>Response</h4>${respHtml}` : ''}
</article>
`;
    })
    .join('');

  return `
    <div class="crumb"><a href="api-reference.html">API reference</a> / ${esc(title)}</div>
    <h1>${esc(title)}</h1>
    <p class="lede">${esc(blurb)}</p>
    ${items}
    `;
}

groupOrder.forEach((key, idx) => {
  const prev: [string, string] =
    idx > 0 ? [fileForGroup(groupOrder[idx - 1]), GROUP_META[groupOrder[idx - 1]][0]] : ['api-reference.html', 'API reference'];
  const next: [string, string] | undefined =
    idx < groupOrder.length - 1 ? [fileForGroup(groupOrder[idx + 1]), GROUP_META[groupOrder[idx + 1]][0]] : undefined;
  write(fileForGroup(key), GROUP_META[key][0], GROUP_META[key][1], renderGroupPage(key), prev, next, 'API reference');
});

const totalEndpoints = groupOrder.reduce((sum, k) => sum + (groups.get(k)?.length ?? 0), 0);

const refCards = groupOrder
  .map(
    (k) =>
      `<a class="card" href="${fileForGroup(k)}"><div class="card-title">${esc(GROUP_META[k][0])}<span class="card-count">${
        groups.get(k)!.length
      }</span></div><div class="card-desc">${esc(GROUP_META[k][1])}</div></a>`
  )
  .join('');

const apiReferenceDescription = `Every open-videocore REST API endpoint (${totalEndpoints} across ${groupOrder.length} resource groups), generated straight from the committed openapi.json.`;

write(
  'api-reference.html',
  'API reference',
  apiReferenceDescription,
  `
<div class="crumb"><a href="index.html">Docs</a> / API reference</div>
<h1>API reference</h1>
<p class="lede">Every endpoint, grouped by resource, generated straight from the committed <code>openapi.json</code> (${totalEndpoints} endpoints across ${groupOrder.length} groups). If you're looking for how to accomplish something rather than a single endpoint's exact shape, start with the <a href="index.html#guides">guides</a> instead — each one links back to the relevant endpoints here.</p>
<div class="card-grid">${refCards}</div>
`,
  ['agentic-examples.html', 'Agentic examples'],
  undefined,
  'API reference'
);

// ===========================================================================
// 5. Guide pages
// ===========================================================================

GUIDES.forEach((g, idx) => {
  const fname = g.slug + '.html';
  const prev: [string, string] = idx > 0 ? [GUIDES[idx - 1].slug + '.html', GUIDES[idx - 1].title] : ['data-model.html', 'Data model'];
  const next: [string, string] =
    idx < GUIDES.length - 1 ? [GUIDES[idx + 1].slug + '.html', GUIDES[idx + 1].title] : ['agentic-examples.html', 'Agentic examples'];
  const body = `
    <div class="crumb"><a href="index.html">Docs</a> / Guides / ${esc(g.title)}</div>
    <h1>${esc(g.title)}</h1>
    <p class="lede">${esc(g.blurb)}</p>
    ${GUIDE_BODIES[g.slug]}
    `;
  write(fname, g.title, g.blurb, body, prev, next, 'Guides');
});

// ===========================================================================
// 5b. Agentic examples — example prompts for an AI agent driving OVC
// ===========================================================================
// Grounded in the same endpoints documented in the guides above; each
// example names the real calls an agent would make, not a hypothetical
// convenience layer. This is also why it's worth a section of its own: the
// REST API + committed openapi.json contract is enough for a general-purpose
// coding/assistant agent to drive directly from a plain-language prompt, no
// bespoke SDK or plugin required — point it at your instance and describe
// the outcome.

const AGENTIC_EXAMPLES_DESCRIPTION =
  'Example prompts for driving open-videocore from an AI agent — send a large file for review, build a highlights collection, get notified on completion — with the real API calls each one makes.';

const agenticExamplesBody = `
<p>open-videocore is a plain REST API with a committed <a href="api-reference.html"><code>openapi.json</code></a> — that's enough for a general-purpose AI coding agent (Claude Code, or any assistant you've given your instance URL and a token to) to drive it directly from a natural-language prompt. No bespoke SDK, plugin, or custom tool required: give the agent your instance URL, point it at the guides or the raw endpoints, and describe the outcome you want.</p>
<div class="callout">Each example below assumes the agent already knows your instance URL (<code>https://&lt;your-instance&gt;</code>) and has your <a href="authentication.html">bearer token</a> available — as an environment variable, a secret store, or pasted into the conversation the same way you'd hand it any other API credential.</div>

<h2 id="review-link">Send a large file for review</h2>
<p><strong>Scenario:</strong> you have a large video file on your own machine and need someone else to review it, without emailing a multi-gigabyte attachment or waiting on a slow file-sharing upload.</p>
<div class="code-block"><div class="code-label">Prompt</div><pre><code>I have a 4.2 GB video file at ~/Desktop/keynote-final.mp4 that Jana needs to
review by Friday. Upload it to my open-videocore instance at
https://&lt;your-instance&gt;, wait until it's ready, package it for streaming,
and give me a playback link I can send her.</code></pre></div>
<p>What the agent does, mapped to the real calls:</p>
<ol>
  <li>${refEx('POST', '/api/v1/assets/', 'create the asset record')}</li>
  <li>Because the file is large, a <a href="guide-ingest.html#multipart">multipart upload</a>: ${refEx('POST', '/api/v1/assets/{id}/multipart/initiate')} → ${refEx('GET', '/api/v1/assets/{id}/multipart/{uploadId}/part-url', 'per part')} → ${refEx('POST', '/api/v1/assets/{id}/multipart/{uploadId}/complete')}</li>
  <li>Poll ${refEx('GET', '/api/v1/assets/{id}')} until <code>status</code> leaves <code>uploading</code></li>
  <li>${refEx('POST', '/api/v1/assets/{id}/execute', "run the transcode-and-package pipeline")} (see <a href="guide-transcode-package.html">Transcoding &amp; packaging</a>), then poll the execution</li>
  <li>${refEx('GET', '/api/v1/assets/{id}/delivery')} for the playback URL (see <a href="guide-delivery.html">Delivery &amp; playback</a>)</li>
</ol>
<p>If the agent also has messaging tools connected, the same prompt can end with "...and send Jana a Slack message with the link" — the video handling is exactly the same either way.</p>

<h2 id="highlights-collection">Build a highlights collection from tagged clips</h2>
<p><strong>Scenario:</strong> pull every clip that matches a tag into one collection for an editor, without hand-searching the library.</p>
<div class="code-block"><div class="code-label">Prompt</div><pre><code>Find all assets tagged "goal" from this week's match footage on my
open-videocore instance and put them in a new collection called
"Matchday highlights" for the editing team.</code></pre></div>
<p>What the agent does:</p>
<ol>
  <li>${refEx('GET', '/api/v1/search', 'filter by tags=goal, see Metadata, tags & search')} (<a href="guide-metadata-search.html#search">guide</a>)</li>
  <li>${refEx('POST', '/api/v1/collections/', 'create "Matchday highlights"')}</li>
  <li>${refEx('PUT', '/api/v1/collections/{id}/assets/{assetId}', 'once per matching asset')} (see <a href="guide-organizing.html#collections">Organizing: collections &amp; webhooks</a>)</li>
</ol>

<h2 id="notify-on-ready">Get notified when uploads finish processing</h2>
<p><strong>Scenario:</strong> stop manually checking whether ingested files have finished processing.</p>
<div class="code-block"><div class="code-label">Prompt</div><pre><code>Turn on watch-folder ingest for the "raw-uploads" bucket on my
open-videocore instance, and register a webhook so we get pinged whenever
an asset finishes processing or fails.</code></pre></div>
<p>What the agent does:</p>
<ol>
  <li>${refEx('POST', '/api/v1/storage/buckets/{bucket}/watch-folder/toggle', '{"enabled": true}')} (see <a href="guide-ingest.html#watch-folder">Ingesting media</a>)</li>
  <li>${refEx('POST', '/api/v1/webhooks/', 'events: ["asset.ready", "asset.failed"]')} (see <a href="guide-organizing.html#webhooks">Organizing: collections &amp; webhooks</a>)</li>
</ol>
`;

write(
  'agentic-examples.html',
  'Agentic examples',
  AGENTIC_EXAMPLES_DESCRIPTION,
  `
    <div class="crumb"><a href="index.html">Docs</a> / Agentic examples</div>
    <h1>Agentic examples</h1>
    <p class="lede">${esc(AGENTIC_EXAMPLES_DESCRIPTION)}</p>
    ${agenticExamplesBody}
    `,
  [GUIDES[GUIDES.length - 1].slug + '.html', GUIDES[GUIDES.length - 1].title],
  ['api-reference.html', 'API reference'],
  'Agentic examples'
);

// ===========================================================================
// 6. Introduction
// ===========================================================================

const introductionBody = `
<div class="crumb"><a href="index.html">Docs</a> / Introduction</div>
<h1>Introduction</h1>
<p class="lede">What open-videocore is, how it's put together, and the ideas you need before your first API call.</p>

<h2 id="what-it-is">What open-videocore is</h2>
<p>open-videocore is headless, API-first media asset management (MAM) middleware. It doesn't do any media processing itself — it orchestrates OSC services that do (a transcoder, a packager, object storage, a metadata store) behind one small, versioned REST API. You call one API; open-videocore routes the work to the right backing services and tracks the result as an asset.</p>
<p>Each <strong>workspace</strong> — a named stack you provision once — owns its own object storage, metadata store, and queue. Nothing is shared across workspaces at the data layer; the middleware resolves the right backing services for each request from a parameter store, so there are no static connection strings to manage per workspace.</p>

<h2 id="rest-basics">REST basics</h2>
<ul>
  <li><strong>Base URL.</strong> Every endpoint in this documentation is relative to your instance's public URL: <code>https://&lt;your-instance&gt;</code>.</li>
  <li><strong>JSON everywhere.</strong> Request and response bodies are JSON (<code>Content-Type: application/json</code>), except raw media bytes on upload endpoints and YAML on profile endpoints.</li>
  <li><strong>Versioning.</strong> The entire API is namespaced under <code>/api/v1</code>. There is no separate per-resource version.</li>
  <li><strong>Collection roots and the trailing slash.</strong> A collection root like <code>POST /api/v1/assets</code> is served both with and without a trailing slash — both reach the same handler. This documentation uses whichever form the spec emits internally; either works at runtime.</li>
</ul>

<h2 id="identifiers">Identifiers</h2>
<p>Every entity — asset, job, collection, webhook, profile, provisioning operation — has an opaque string <code>id</code> (or, for profiles, a unique <code>name</code>) assigned by the server on creation. IDs are not guessable and should be treated as opaque tokens, not parsed.</p>

<h2 id="timestamps">Timestamps</h2>
<p>Entity timestamps (<code>createdAt</code>, <code>updatedAt</code>, and each asset's <code>statusHistory[].at</code>) are ISO&nbsp;8601 date-time strings in UTC, e.g. <code>2026-09-03T12:00:00.000Z</code>. Job progress timestamps (<code>startedAt</code>, <code>completedAt</code> on a provisioning operation) are Unix epoch milliseconds — check the field's type in the <a href="api-reference.html">reference</a> before assuming one or the other.</p>

<h2 id="async">Synchronous vs. asynchronous work</h2>
<p>Reads and small writes (create a collection, add a tag, update metadata) respond immediately. Anything that touches media or infrastructure — ingest, transcode, package, clip, export, provisioning — is asynchronous: the triggering call returns a <a href="data-model.html#job">Job</a> or <a href="data-model.html#provisioning-operation">Provisioning Operation</a> immediately, and you poll its own <code>GET</code> endpoint for completion. See each capability's guide for the exact job type it returns.</p>

<h2 id="where-next">Where to go next</h2>
<div class="card-grid">
  <a class="card" href="data-model.html"><div class="card-title">Data model</div><div class="card-desc">The core entities — Asset, Job, Pipeline Execution, Profile, Collection — and how they relate.</div></a>
  <a class="card" href="installation.html"><div class="card-title">Installation</div><div class="card-desc">Launch an instance on Open Source Cloud.</div></a>
  <a class="card" href="guide-ingest.html"><div class="card-title">Ingesting media</div><div class="card-desc">Your first API calls once an instance is running.</div></a>
</div>
`;

// ===========================================================================
// 7. Data model
// ===========================================================================

const dataModelBody = `
<div class="crumb"><a href="index.html">Docs</a> / Data model</div>
<h1>Data model</h1>
<p class="lede">The entities open-videocore manages, the fields on each (pulled directly from the response schemas in <code>openapi.json</code>), and how they relate.</p>

<div class="rel-diagram">Workspace (provisioned Stack)
 └─ owns object storage + metadata store + queue
 │
 ├─ Asset ── created by ingest / upload, the unit everything else hangs off
 │    ├─ Job(s)            (transcode, ingest-url — async work on this asset)
 │    ├─ Pipeline Execution (chains multiple steps, e.g. transcode + package)
 │    ├─ Thumbnails, audio/subtitle tracks, tags, free-form metadata
 │    └─ child Assets       (renditions from transcode, clips, exports)
 │
 ├─ Collection ──── named group of Asset ids
 ├─ Profile ─────── transcoding rendition ladder, referenced by transcode Jobs
 ├─ Webhook ─────── HTTP callback subscribed to Asset/Job lifecycle events
 └─ Optional Service ── add-on OSC service, provisioned per workspace on demand</div>

<div class="entity-card" id="asset">
  <h3>Asset</h3>
  <p>The central entity. Represents one piece of media through its whole lifecycle — from an empty record through upload, processing, and (optionally) packaging.</p>
  <table class="model">
    <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
    <tbody>
      <tr><td><code>id</code></td><td>string</td><td>Opaque identifier.</td></tr>
      <tr><td><code>name</code></td><td>string</td><td>Canonical editorial title. Set on ingest via <code>title</code> (or the legacy <code>name</code> alias); persisted at <code>descriptive.title</code>.</td></tr>
      <tr><td><code>status</code></td><td>enum</td><td><code>uploading</code> · <code>processing</code> · <code>ready</code> · <code>failed</code> · <code>archived</code></td></tr>
      <tr><td><code>reviewState</code></td><td>enum</td><td><code>draft</code> · <code>in-review</code> · <code>approved</code> · <code>rejected</code></td></tr>
      <tr><td><code>parentId</code> / <code>versionOfAssetId</code> / <code>versionGroupId</code></td><td>string</td><td>Links a clip, rendition, or version back to its source asset.</td></tr>
      <tr><td><code>statusHistory</code></td><td>array</td><td>Every status transition, with a timestamp.</td></tr>
      <tr><td><code>technicalMetadata</code></td><td>object</td><td>Codec, resolution, duration, bitrate — populated by <a href="guide-metadata-search.html#technical">extract-metadata</a>.</td></tr>
      <tr><td><code>manifestUrls</code></td><td>object</td><td>Populated once packaging completes.</td></tr>
      <tr><td><code>renditions</code></td><td>array</td><td>References to child assets produced by transcoding.</td></tr>
      <tr><td><code>thumbnails</code>, <code>audioTracks</code>, <code>subtitleTracks</code>, <code>tags</code></td><td>array</td><td>See the <a href="guide-thumbnails-clips-export.html">thumbnails</a> and <a href="guide-metadata-search.html">metadata</a> guides.</td></tr>
      <tr><td><code>metadata</code></td><td>object</td><td>Free-form, application-defined key-value data.</td></tr>
      <tr><td><code>createdAt</code> / <code>updatedAt</code></td><td>string (date-time)</td><td></td></tr>
    </tbody>
  </table>
  <p>Full request/response shapes: <a href="ref-assets.html">Assets reference</a>.</p>
</div>

<div class="entity-card" id="job">
  <h3>Job</h3>
  <p>One unit of asynchronous work against an asset — ingest or transcode. Created by the endpoint that starts the work; polled until it settles.</p>
  <table class="model">
    <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
    <tbody>
      <tr><td><code>id</code></td><td>string</td><td></td></tr>
      <tr><td><code>type</code></td><td>enum</td><td><code>ingest-url</code> · <code>transcode</code></td></tr>
      <tr><td><code>status</code></td><td>enum</td><td><code>pending</code> · <code>queued</code> · <code>running</code> · <code>done</code> · <code>failed</code> · <code>cancelled</code></td></tr>
      <tr><td><code>assetId</code></td><td>string</td><td>The asset this job is working on.</td></tr>
      <tr><td><code>progress</code></td><td>number</td><td></td></tr>
      <tr><td><code>bytesTransferred</code> / <code>totalBytes</code></td><td>number</td><td>Ingest download progress.</td></tr>
      <tr><td><code>renditionAssetIds</code></td><td>array</td><td>Child assets created by a completed transcode job.</td></tr>
      <tr><td><code>interrupted</code> / <code>interruptionReason</code></td><td>boolean / enum</td><td>Set when the job was interrupted by an infrastructure event (e.g. auto-scaler scale-down) rather than a media failure, and is being retried.</td></tr>
      <tr><td><code>createdAt</code> / <code>updatedAt</code></td><td>string (date-time)</td><td></td></tr>
    </tbody>
  </table>
  <p>Full shape: <a href="ref-jobs.html">Jobs reference</a>.</p>
</div>

<div class="entity-card" id="pipeline-execution">
  <h3>Pipeline Execution</h3>
  <p>Tracks a multi-step run (for example, transcode then package) against one asset as a single unit, rather than making the caller sequence and poll individual jobs.</p>
  <table class="model">
    <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
    <tbody>
      <tr><td><code>id</code></td><td>string</td><td></td></tr>
      <tr><td><code>assetId</code> / <code>assetName</code></td><td>string</td><td></td></tr>
      <tr><td><code>pipelineName</code></td><td>string</td><td>Which pipeline definition was run.</td></tr>
      <tr><td><code>status</code></td><td>enum</td><td><code>running</code> · <code>done</code> · <code>failed</code></td></tr>
      <tr><td><code>steps</code></td><td>array</td><td>Per-step status within the execution.</td></tr>
    </tbody>
  </table>
  <p>Full shape: <a href="ref-pipelines.html">Pipelines reference</a>.</p>
</div>

<div class="entity-card" id="profile">
  <h3>Profile</h3>
  <p>A named transcoding rendition ladder, stored as raw YAML and served to the transcoder via the public <code>index.yml</code> endpoint. Seeded from a default set on bootstrap; extendable per workspace.</p>
  <table class="model">
    <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
    <tbody>
      <tr><td><code>name</code></td><td>string</td><td>Primary key.</td></tr>
      <tr><td><code>yaml</code></td><td>string</td><td>Raw transcoder-format profile definition.</td></tr>
      <tr><td><code>runnable</code></td><td>boolean</td><td></td></tr>
    </tbody>
  </table>
  <p>Full shape: <a href="ref-profiles.html">Profiles reference</a>.</p>
</div>

<div class="entity-card" id="collection">
  <h3>Collection</h3>
  <table class="model">
    <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
    <tbody>
      <tr><td><code>id</code> / <code>name</code></td><td>string</td><td></td></tr>
      <tr><td><code>assetIds</code></td><td>array</td><td>Member asset ids.</td></tr>
      <tr><td><code>assets</code></td><td>array</td><td>Expanded member asset summaries (on <code>GET</code>).</td></tr>
    </tbody>
  </table>
  <p>Full shape: <a href="ref-collections.html">Collections reference</a>.</p>
</div>

<div class="entity-card" id="webhook">
  <h3>Webhook</h3>
  <table class="model">
    <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
    <tbody>
      <tr><td><code>id</code></td><td>string</td><td></td></tr>
      <tr><td><code>url</code></td><td>string (uri)</td><td>Delivery target.</td></tr>
      <tr><td><code>events</code></td><td>array</td><td><code>asset.ready</code> · <code>asset.failed</code> · <code>transcode.complete</code> · <code>transcode.failed</code> · <code>package.complete</code> · <code>package.failed</code></td></tr>
      <tr><td><code>secret</code></td><td>string</td><td>Used to sign deliveries, if set.</td></tr>
    </tbody>
  </table>
  <p>Full shape: <a href="ref-webhooks.html">Webhooks reference</a>.</p>
</div>

<div class="entity-card" id="stack">
  <h3>Stack (provisioned workspace)</h3>
  <table class="model">
    <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
    <tbody>
      <tr><td><code>status</code></td><td>enum</td><td><code>provisioning</code> · <code>ready</code> · <code>failed</code> · <code>degraded</code></td></tr>
      <tr><td><code>minioEndpoint</code> / <code>couchdbUrl</code> / <code>redisUrl</code></td><td>string</td><td>Backing service endpoints for this workspace.</td></tr>
      <tr><td><code>sourceBucket</code> / <code>packagedBucket</code></td><td>string</td><td></td></tr>
      <tr><td><code>services</code></td><td>array</td><td>Backing OSC service instances that make up this stack.</td></tr>
    </tbody>
  </table>
  <p>Full shape: <a href="ref-provisioning.html">Provisioning reference</a>.</p>
</div>

<div class="entity-card" id="provisioning-operation">
  <h3>Provisioning Operation</h3>
  <table class="model">
    <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
    <tbody>
      <tr><td><code>id</code></td><td>string</td><td></td></tr>
      <tr><td><code>type</code></td><td>enum</td><td><code>provision</code> · <code>deprovision</code></td></tr>
      <tr><td><code>status</code></td><td>enum</td><td><code>pending</code> · <code>running</code> · <code>done</code> · <code>failed</code></td></tr>
      <tr><td><code>startedAt</code> / <code>completedAt</code></td><td>number</td><td>Unix epoch milliseconds — not ISO date-time, unlike most other timestamps.</td></tr>
    </tbody>
  </table>
  <p>Full shape: <a href="ref-provisioning.html">Provisioning reference</a>.</p>
</div>

<div class="entity-card" id="optional-service">
  <h3>Optional Service</h3>
  <table class="model">
    <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
    <tbody>
      <tr><td><code>key</code> / <code>serviceId</code> / <code>displayName</code></td><td>string</td><td></td></tr>
      <tr><td><code>state</code></td><td>enum</td><td><code>not-configured</code> · <code>configured</code> · <code>active</code></td></tr>
      <tr><td><code>instanceName</code> / <code>url</code></td><td>string</td><td>Present once provisioned.</td></tr>
    </tbody>
  </table>
  <p>Full shape: <a href="ref-optional-services.html">Optional services reference</a>.</p>
</div>
`;

// ===========================================================================
// 8. Installation
// ===========================================================================

const installationBody = `
<div class="crumb"><a href="index.html">Docs</a> / Installation</div>
<h1>Installation</h1>
<p class="lede">Launching an instance of open-videocore on Open Source Cloud (OSC). No servers to provision by hand — an MCP-connected agent runs the calls for you.</p>

<ol class="steps">
  <li>
    <h3>Get an OSC account and access token</h3>
    <p>Create an account at <a href="https://www.osaas.io" target="_blank" rel="noopener">osaas.io</a>, then generate a Personal Access Token at <a href="https://app.osaas.io/settings" target="_blank" rel="noopener">app.osaas.io/settings</a>. You'll use this token to authenticate both the deploy agent and, later, the API itself.</p>
  </li>
  <li>
    <h3>Connect an agent to OSC over MCP</h3>
    <p>OSC exposes an MCP server that provisions and manages every resource open-videocore needs. Connect your agent to it:</p>
    <div class="code-block"><div class="code-label">Claude Code / Claude Desktop</div><pre><code>claude mcp add --transport http osc https://mcp.osaas.io/mcp</code></pre></div>
    <p>For any other MCP-compatible tool, add <code>https://mcp.osaas.io/mcp</code> as a server with your Personal Access Token as the Bearer token. Full setup guides at <a href="https://www.osaas.io/mcp" target="_blank" rel="noopener">osaas.io/mcp</a>.</p>
  </li>
  <li>
    <h3>Set up a parameter store</h3>
    <p>open-videocore tracks the OSC service instances it provisions in a parameter store. Ask your agent:</p>
    <div class="code-block"><div class="code-label">Prompt</div><pre><code>Set up an app-config parameter store called \`ovcconfig\` for my open-videocore deployment.</code></pre></div>
    <p>The agent provisions the store and returns a config API key — keep it, you'll pass it to the deploy step next.</p>
  </li>
  <li>
    <h3>Deploy the instance</h3>
    <p>Ask your agent to create the instance, wired to the parameter store from the previous step:</p>
    <div class="code-block"><div class="code-label">Prompt</div><pre><code>Create a Personal Access Token for the open-videocore instance, then create an
open-videocore instance called \`ovctest\`. Connect it to the parameter store
named \`ovcconfig\` using the API key from the previous step. Use the Personal
Access Token as the OSC access token. Generate strong passwords for
\`MinioRootPassword\` and \`CouchdbAdminPassword\`.</code></pre></div>
    <p>The agent provisions the instance and returns its public URL — that's <code>https://&lt;your-instance&gt;</code> in every example in this documentation.</p>
  </li>
  <li>
    <h3>Provision a workspace stack</h3>
    <p>One call stands up the backing infrastructure for a workspace — object storage, metadata store, and queue. The transcoder and packager are provisioned separately, on demand, the first time they're actually used — see <a href="guide-operating.html">Operating a workspace</a>.</p>
    <div class="code-block"><div class="code-label">Request</div><pre><code>curl -X POST https://&lt;your-instance&gt;/api/v1/provision \\
  -H "Content-Type: application/json" \\
  -d '{"name": "mystack"}'</code></pre></div>
    <p>Provisioning is asynchronous. Poll the returned <code>operationId</code> until <code>status</code> reaches <code>"done"</code>:</p>
    <div class="code-block"><pre><code>curl https://&lt;your-instance&gt;/api/v1/provision/operations/&lt;operationId&gt;</code></pre></div>
    <div class="callout">By default the stack provisions its own object storage and buckets — no storage configuration required. To point at an existing S3-compatible bucket instead, pass the optional <code>sourceStorage</code> / <code>packagedStorage</code> blocks — see <a href="ref-provisioning.html#post-api-v1-provision">provision</a> in the reference.</div>
  </li>
  <li>
    <h3>Bootstrap transcoding profiles</h3>
    <p>Seed the profile store from the default transcoder test profiles:</p>
    <div class="code-block"><pre><code>curl -X POST https://&lt;your-instance&gt;/api/v1/profiles/bootstrap</code></pre></div>
    <p>Your instance is live. The ops dashboard is at <code>https://&lt;your-instance&gt;/ui</code>; interactive, always-current API docs are served at <code>https://&lt;your-instance&gt;/api-docs</code>. Continue to <a href="guide-ingest.html">Ingesting media</a> to get your first asset in.</p>
  </li>
</ol>

<h2 id="env-vars">Environment variables</h2>
<p class="group-blurb">Set automatically by the deploy step above, or configurable directly if you're running open-videocore yourself.</p>
<table class="env">
  <thead><tr><th>Variable</th><th>Required</th><th>Description</th></tr></thead>
  <tbody>
    <tr><td><code>OSC_ACCESS_TOKEN</code></td><td>Yes</td><td>Personal Access Token. Injected automatically at deploy time on OSC.</td></tr>
    <tr><td><code>PARAMETER_STORE_API_KEY</code></td><td>Yes</td><td>Config API key of the connected parameter store.</td></tr>
    <tr><td><code>PARAMETER_STORE_INSTANCE_NAME</code></td><td>Yes</td><td>Name of the parameter store (default <code>ovcconfig</code>).</td></tr>
    <tr><td><code>MINIO_ROOT_PASSWORD</code></td><td>Yes</td><td>Admin password used when provisioning object storage instances.</td></tr>
    <tr><td><code>COUCHDB_ADMIN_PASSWORD</code></td><td>Yes</td><td>Admin password used when provisioning the metadata store.</td></tr>
    <tr><td><code>PORT</code></td><td>No</td><td>HTTP port (default <code>3000</code>).</td></tr>
    <tr><td><code>ENCORE_MAX_INSTANCES</code></td><td>No</td><td>Max transcoder instances the auto-scaler may run per workspace (default <code>3</code>).</td></tr>
    <tr><td><code>ENCORE_MIN_INSTANCES</code></td><td>No</td><td>Warm floor of transcoder instances kept running even when idle (default <code>0</code> — scale to zero). See <a href="guide-operating.html#scaler">Operating a workspace</a>.</td></tr>
    <tr><td><code>ENCORE_IDLE_TIMEOUT_MS</code></td><td>No</td><td>Idle time before a transcoder instance is torn down (default <code>300000</code>).</td></tr>
    <tr><td><code>PUBLIC_BASE_URL</code></td><td>No</td><td>Publicly-reachable base URL of this instance, used to build the profile index URL handed to each transcoder.</td></tr>
  </tbody>
</table>
`;

// ===========================================================================
// 9. Authentication & errors
// ===========================================================================

const authBody = `
<div class="crumb"><a href="index.html">Docs</a> / Authentication &amp; errors</div>
<h1>Authentication &amp; errors</h1>

<h2 id="authentication">Authentication</h2>
<p>Every request — other than health checks and the internal service callbacks — is authenticated with a bearer token, presented as an <code>Authorization</code> header:</p>
<div class="code-block"><pre><code>Authorization: Bearer &lt;your-osc-access-token&gt;</code></pre></div>
<p>In production on OSC, this is enforced by the platform's login wall in front of the instance. The token is your OSC Personal Access Token — the same one used in <a href="installation.html">Installation</a> to deploy the instance.</p>

<h2 id="errors">Errors &amp; conventions</h2>
<ul>
  <li>Standard HTTP status codes: <code>2xx</code> success, <code>4xx</code> client error (bad input, not found), <code>5xx</code> server/upstream error.</li>
  <li>Long-running work (transcode, package, provisioning) is asynchronous: the triggering call returns immediately with a job or operation id, which you poll via the corresponding <code>GET</code> endpoint — see <a href="introduction.html#async">Introduction &rarr; synchronous vs. asynchronous work</a>.</li>
  <li><strong>Trailing slash.</strong> Each collection root (for example <code>POST /api/v1/assets</code>) is served both with and without a trailing slash — both reach the same handler.</li>
  <li>Endpoints under <a href="ref-internal.html">Internal callbacks</a> are called by the transcoder and packager services as callbacks and are not part of the public client contract.</li>
</ul>
`;

const introductionDescription =
  "What open-videocore is, how it's put together, and the core REST conventions — identifiers, timestamps, sync vs. async — behind its API.";
const dataModelDescription =
  'The core entities open-videocore manages — Asset, Job, Pipeline Execution, Profile, Collection, Webhook, Stack, and more — and how they relate.';
const installationDescription =
  'Step-by-step instructions for launching an instance of open-videocore on Open Source Cloud (OSC).';
const authDescription =
  "How to authenticate requests to the open-videocore API with a bearer token, plus its error and status-code conventions.";

write('introduction.html', 'Introduction', introductionDescription, introductionBody, undefined, [
  'data-model.html',
  'Data model'
], 'Docs');
write(
  'data-model.html',
  'Data model',
  dataModelDescription,
  dataModelBody,
  ['introduction.html', 'Introduction'],
  ['installation.html', 'Installation'],
  'Docs'
);
write(
  'installation.html',
  'Installation',
  installationDescription,
  installationBody,
  ['data-model.html', 'Data model'],
  ['authentication.html', 'Authentication & errors'],
  'Docs'
);
write(
  'authentication.html',
  'Authentication & errors',
  authDescription,
  authBody,
  ['installation.html', 'Installation'],
  [GUIDES[0].slug + '.html', GUIDES[0].title],
  'Docs'
);

// ===========================================================================
// 10. Landing page (index.html)
// ===========================================================================

const guideCards = GUIDES.map(
  (g) => `<a class="card" href="${g.slug}.html"><div class="card-title">${esc(g.title)}</div><div class="card-desc">${esc(g.blurb)}</div></a>`
).join('');

const indexBody = `
<h1>open-videocore</h1>
<p class="lede">Headless, API-first media asset management middleware that runs entirely on Open Source Cloud. Ingest, transcode, package, search, and deliver video — one REST API per workspace, backed by its own provisioned stack.</p>
<div class="hero-links">
  <a href="installation.html">Install on OSC &rarr;</a>
  <a href="introduction.html">Read the introduction</a>
  <a href="agentic-examples.html">See agentic examples</a>
  <a href="api-reference.html">Browse the API reference</a>
</div>

<h2 id="guides">Guides</h2>
<p class="group-blurb">Task-oriented walkthroughs — what you can do, and how. Each one links to the exact endpoints involved.</p>
<div class="card-grid">${guideCards}</div>

<h2 id="agentic-examples">Agentic examples</h2>
<p class="group-blurb">Prompts for driving open-videocore from an AI agent, and the real API calls each one makes.</p>
<div class="card-grid">
  <a class="card" href="agentic-examples.html"><div class="card-title">Agentic examples</div><div class="card-desc">${esc(AGENTIC_EXAMPLES_DESCRIPTION)}</div></a>
</div>

<h2 id="reference">Reference</h2>
<p class="group-blurb">Looking for one endpoint's exact parameters or response shape? The <a href="api-reference.html">API reference</a> covers all ${totalEndpoints} endpoints, generated from the committed <code>openapi.json</code>.</p>
<div class="card-grid">
  <a class="card" href="introduction.html"><div class="card-title">Introduction</div><div class="card-desc">What open-videocore is and how it's put together.</div></a>
  <a class="card" href="data-model.html"><div class="card-title">Data model</div><div class="card-desc">Core entities and how they relate.</div></a>
  <a class="card" href="installation.html"><div class="card-title">Installation</div><div class="card-desc">Launch an instance on OSC.</div></a>
  <a class="card" href="authentication.html"><div class="card-title">Authentication &amp; errors</div><div class="card-desc">Bearer tokens and API conventions.</div></a>
</div>
`;

write('index.html', 'open-videocore', SITE_DESCRIPTION, indexBody, undefined, undefined, 'Docs');

// ===========================================================================
// 11. SEO / AEO artifacts: sitemap.xml, robots.txt, llms.txt, llms-full.txt
// ===========================================================================
// llms.txt / llms-full.txt follow the emerging llms.txt convention
// (https://llmstxt.org/) for making a site's content easy for an LLM or
// answer-engine crawler to fetch and read directly, without having to
// render HTML or navigate the sidebar — the same convention already used
// on Eyevinn's own osaas-landing-app site.

function decodeEntities(s: string): string {
  return s
    .replace(/&mdash;/g, '—')
    .replace(/&rarr;/g, '→')
    .replace(/&larr;/g, '←')
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…')
    .replace(/&rsquo;/g, '’')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Rough but effective HTML -> plain text for the llms-full.txt export: this
// is rendered from our own generated markup (a known, limited tag set), not
// arbitrary third-party HTML, so a regex stripper is adequate here.
function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<div class="crumb">[\s\S]*?<\/div>/gi, ''); // breadcrumb, redundant in plain text
  s = s.replace(/<\/(h1|h2|h3|h4|p|li|div|article|section|tr)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// --- sitemap.xml ---
const sitemapEntries = pageIndex
  .map((p) => `  <url><loc>${canonicalUrl(p.fname)}</loc></url>`)
  .join('\n');
writeFileSync(
  join(OUT_DIR, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries}\n</urlset>\n`
);

// --- robots.txt ---
writeFileSync(
  join(OUT_DIR, 'robots.txt'),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
);

// --- llms.txt (index) ---
const llmsSections = ['Guides', 'Agentic examples', 'Docs', 'API reference'];
const llmsBody = llmsSections
  .map((section) => {
    const pages = pageIndex.filter((p) => p.section === section && p.fname !== 'index.html');
    if (!pages.length) return '';
    const items = pages.map((p) => `- [${p.title}](${canonicalUrl(p.fname)}): ${p.description}`).join('\n');
    return `## ${section}\n\n${items}\n`;
  })
  .filter(Boolean)
  .join('\n');
writeFileSync(
  join(OUT_DIR, 'llms.txt'),
  `# open-videocore\n\n> ${SITE_DESCRIPTION}\n\n${llmsBody}\n[Full text of every page](${SITE_URL}/llms-full.txt)\n`
);

// --- llms-full.txt (concatenated plain-text content of every page) ---
const llmsFullBody = pageIndex
  .map((p) => `# ${p.title}\n\nURL: ${canonicalUrl(p.fname)}\n\n${htmlToText(p.bodyHtml)}`)
  .join('\n\n---\n\n');
writeFileSync(join(OUT_DIR, 'llms-full.txt'), `${llmsFullBody}\n`);

// ===========================================================================
// 12. Prune stale output (a resource group or guide that was removed)
// ===========================================================================

const expected = new Set([
  'index.html',
  'api-reference.html',
  'agentic-examples.html',
  ...STATIC_PAGES.map(([f]) => f),
  ...GUIDES.map((g) => g.slug + '.html'),
  ...groupOrder.map(fileForGroup)
]);
for (const fname of readdirSync(OUT_DIR)) {
  if (fname.endsWith('.html') && !expected.has(fname)) {
    console.log(`Removing stale generated page: ${fname}`);
    // Intentionally not auto-deleted to avoid surprises from a misconfigured
    // run; surface it instead so a human/CI decides.
    console.warn(`  -> not deleted automatically; remove public/docs/${fname} manually if it's no longer generated.`);
  }
}

console.log(`Docs generated: ${expected.size} pages, ${totalEndpoints} endpoints across ${groupOrder.length} groups.`);
