/**
 * open-videocore ops dashboard — app.js
 *
 * Security note: All dynamic values from the API or user input are passed through
 * escHtml() before being interpolated into HTML template literals. escHtml() encodes
 * &, <, >, and " characters. No raw external strings are inserted into innerHTML.
 * DOM APIs (textContent, createElement) are used where possible; innerHTML is used
 * only with fully-escaped, controlled template strings.
 */

// ─── Escape helper (XSS prevention) ─────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Stack selector ──────────────────────────────────────────────────────────

const STACK_KEY = 'ovc_stack';

function getActiveStack() {
  return localStorage.getItem(STACK_KEY) || '';
}

function setActiveStack(name) {
  if (name) localStorage.setItem(STACK_KEY, name);
  else localStorage.removeItem(STACK_KEY);
}

async function initStackSelector() {
  const sel = document.getElementById('stack-select');
  if (!sel) return;
  try {
    const names = await apiFetch('/provision');
    sel.innerHTML = '';
    if (!names || !names.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '— no stacks —';
      sel.appendChild(opt);
      return;
    }
    const stored = getActiveStack();
    names.forEach(function(name) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === stored) opt.selected = true;
      sel.appendChild(opt);
    });
    // If nothing stored yet, default to first stack
    if (!stored && names.length) setActiveStack(names[0]);
    sel.addEventListener('change', function() {
      setActiveStack(sel.value);
      // Reload current tab with new stack
      const active = document.querySelector('.tab-btn.active');
      if (active) active.click();
    });
  } catch (_) {
    sel.innerHTML = '<option value="">— unavailable —</option>';
  }
}

// ─── API fetch helper ────────────────────────────────────────────────────────

const API_BASE = window.location.origin + '/api/v1';

async function apiFetch(path, options = {}) {
  const stack = getActiveStack();
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(stack ? { 'X-Stack-Name': stack } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(API_BASE + path, { ...options, headers });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const body = await res.json();
      msg = body.error || body.message || msg;
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return res.json();
  }
  return null;
}

// ─── Utility helpers ─────────────────────────────────────────────────────────

function fmtDate(val) {
  if (!val) return '—';
  try {
    return new Date(val).toLocaleString();
  } catch (_) {
    return String(val);
  }
}

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  n = Number(n);
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return (i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

function badgeClass(status) {
  if (!status) return 'badge-unknown';
  const s = status.toLowerCase();
  if (['ready', 'active', 'done', 'completed'].includes(s)) return 'badge-ready';
  if (['pending', 'ingesting', 'transcoding', 'processing', 'running'].includes(s)) return 'badge-pending';
  if (['failed', 'error', 'archived'].includes(s)) return 'badge-failed';
  return 'badge-unknown';
}

function renderBadge(status) {
  // status is escaped before insertion
  return '<span class="badge ' + badgeClass(status) + '">' + escHtml(status || 'unknown') + '</span>';
}

function renderTags(tags) {
  if (!tags || tags.length === 0) return '<span class="text-muted">—</span>';
  // each tag is escaped individually
  return tags.map(function(t) { return '<span class="tag">' + escHtml(t) + '</span>'; }).join(' ');
}

function showMsg(container, text, type) {
  type = type || 'info';
  const el = document.createElement('div');
  el.className = 'msg msg-' + type;
  el.textContent = text;
  container.appendChild(el);
  setTimeout(function() { el.remove(); }, 6000);
}

function loadingEl() {
  const el = document.createElement('div');
  el.className = 'loading';
  el.innerHTML = '<span class="spinner"></span>';
  const txt = document.createTextNode(' Loading…');
  el.appendChild(txt);
  return el;
}

// ─── Tab switching ────────────────────────────────────────────────────────────

const TABS = ['assets', 'jobs', 'collections', 'search', 'webhooks', 'storage', 'provision'];
const TAB_RENDERERS = {};

function switchTab(name) {
  if (!TABS.includes(name)) return;
  document.querySelectorAll('.tab-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  const content = document.getElementById('content');
  content.innerHTML = '';
  TAB_RENDERERS[name](content);
}

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
  });
}

// ─── ASSETS TAB ──────────────────────────────────────────────────────────────

async function renderAssetsTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Assets';
  container.appendChild(title);

  // Ingest URL section
  const ingestSection = document.createElement('div');
  ingestSection.className = 'section';
  // Only static HTML here — no user data
  ingestSection.innerHTML = [
    '<div class="section-title">Ingest from URL</div>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="ingest-url">Source URL</label>',
    '    <input type="url" id="ingest-url" placeholder="https://example.com/video.mp4" />',
    '  </div>',
    '  <div class="form-field">',
    '    <label for="ingest-title">Title (optional)</label>',
    '    <input type="text" id="ingest-title" placeholder="My asset" />',
    '  </div>',
    '  <button id="ingest-btn">Ingest</button>',
    '</div>',
    '<div id="ingest-msg"></div>',
  ].join('');
  container.appendChild(ingestSection);

  // Upload file section
  const uploadSection = document.createElement('div');
  uploadSection.className = 'section';
  const uploadTitle = document.createElement('div');
  uploadTitle.className = 'section-title';
  uploadTitle.textContent = 'Upload file';
  uploadSection.appendChild(uploadTitle);
  const uploadForm = document.createElement('div');
  uploadForm.className = 'form-row';
  const fileField = document.createElement('div');
  fileField.className = 'form-field grow';
  const fileLabel = document.createElement('label');
  fileLabel.htmlFor = 'upload-file';
  fileLabel.textContent = 'File';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'upload-file';
  fileInput.accept = 'video/*,audio/*';
  fileField.appendChild(fileLabel);
  fileField.appendChild(fileInput);
  const uploadBtn = document.createElement('button');
  uploadBtn.id = 'upload-btn';
  uploadBtn.textContent = 'Upload';
  uploadForm.appendChild(fileField);
  uploadForm.appendChild(uploadBtn);
  uploadSection.appendChild(uploadForm);
  const uploadProgress = document.createElement('div');
  uploadSection.appendChild(uploadProgress);
  container.appendChild(uploadSection);

  uploadBtn.addEventListener('click', async function() {
    const file = fileInput.files && fileInput.files[0];
    uploadProgress.textContent = '';
    if (!file) { showMsg(uploadProgress, 'Select a file first.', 'error'); return; }
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading…';
    try {
      // 1. Create the asset record.
      const asset = await apiFetch('/assets', {
        method: 'POST',
        body: JSON.stringify({ name: file.name })
      });
      const assetId = asset.id;
      showMsg(uploadProgress, 'Asset created (' + assetId + '), getting upload URL…', 'info');

      // 2. Get a presigned PUT URL.
      const { url: presignedUrl } = await apiFetch('/assets/' + encodeURIComponent(assetId) + '/upload-url');

      showMsg(uploadProgress, 'Uploading ' + file.name + ' (' + Math.round(file.size / 1024 / 1024 * 10) / 10 + ' MB)…', 'info');

      // 3. PUT the file directly to MinIO.
      const putRes = await fetch(presignedUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' }
      });
      if (!putRes.ok) throw new Error('Upload to storage failed: HTTP ' + putRes.status);

      // 4. Notify the API the upload is complete.
      await apiFetch('/assets/' + encodeURIComponent(assetId) + '/upload-complete', { method: 'POST' });

      showMsg(uploadProgress, 'Upload complete — asset "' + file.name + '" is ready.', 'success');
      fileInput.value = '';
      await loadAssets(listSection, detailPanel);
    } catch (err) {
      showMsg(uploadProgress, 'Error: ' + err.message, 'error');
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload';
    }
  });

  // Asset list section
  const listSection = document.createElement('div');
  listSection.className = 'section';
  listSection.innerHTML = [
    '<div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">',
    '  <span>Asset list</span>',
    '  <button id="assets-refresh" class="btn-ghost" style="font-size:12px;padding:4px 10px;">Refresh</button>',
    '</div>',
    '<div id="assets-table-wrap"></div>',
  ].join('');
  container.appendChild(listSection);

  // Detail panel placeholder
  const detailPanel = document.createElement('div');
  detailPanel.id = 'asset-detail';
  detailPanel.style.display = 'none';
  container.appendChild(detailPanel);

  ingestSection.querySelector('#ingest-btn').addEventListener('click', async function() {
    const url = ingestSection.querySelector('#ingest-url').value.trim();
    const titleVal = ingestSection.querySelector('#ingest-title').value.trim();
    const msgEl = ingestSection.querySelector('#ingest-msg');
    msgEl.innerHTML = '';
    if (!url) { showMsg(msgEl, 'Source URL is required.', 'error'); return; }
    try {
      const body = { sourceUrl: url };
      if (titleVal) body.title = titleVal;
      const result = await apiFetch('/assets/ingest-url', { method: 'POST', body: JSON.stringify(body) });
      showMsg(msgEl, 'Ingest job started. Job ID: ' + (result && (result.jobId || result.id) ? (result.jobId || result.id) : JSON.stringify(result)), 'success');
      await loadAssets(listSection, detailPanel);
    } catch (err) {
      showMsg(msgEl, 'Error: ' + err.message, 'error');
    }
  });

  listSection.querySelector('#assets-refresh').addEventListener('click', function() {
    loadAssets(listSection, detailPanel);
  });

  await loadAssets(listSection, detailPanel);
}

async function loadAssets(listSection, detailPanel) {
  const wrap = listSection.querySelector('#assets-table-wrap');
  wrap.innerHTML = '';
  const loader = loadingEl();
  wrap.appendChild(loader);

  let assets = [];
  try {
    const res = await apiFetch('/assets');
    assets = Array.isArray(res) ? res : (res && (res.items || res.assets) ? (res.items || res.assets) : []);
  } catch (err) {
    wrap.innerHTML = '';
    showMsg(wrap, 'Failed to load assets: ' + err.message, 'error');
    return;
  }
  loader.remove();

  if (assets.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No assets found.';
    wrap.appendChild(empty);
    return;
  }

  const tableWrap = document.createElement('div');
  tableWrap.className = 'table-wrap';

  // Build table using escaped values
  const rows = assets.map(function(a) {
    var thumb = a.thumbnails && a.thumbnails.length
      ? '<img src="/api/v1/assets/' + escHtml(a.id) + '/thumbnails/0" class="thumb-xs" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
      : '<div class="thumb-xs thumb-placeholder"></div>';
    return '<tr data-id="' + escHtml(a.id) + '">' +
      '<td style="width:52px;padding:4px 6px">' + thumb + '</td>' +
      '<td class="cell-id">' + escHtml(a.id) + '</td>' +
      '<td>' + escHtml(a.title || a.name || '—') + '</td>' +
      '<td>' + renderBadge(a.status) + '</td>' +
      '<td>' + renderTags(a.tags) + '</td>' +
      '<td>' + escHtml(fmtDate(a.createdAt)) + '</td>' +
      '<td>' +
        '<button class="btn-ghost asset-detail-btn" data-id="' + escHtml(a.id) + '" style="font-size:12px;padding:3px 8px;">Detail</button>' +
        '<button class="btn-danger asset-delete-btn" data-id="' + escHtml(a.id) + '" style="font-size:12px;padding:3px 8px;margin-left:4px;">Archive</button>' +
      '</td>' +
      '</tr>';
  }).join('');

  tableWrap.innerHTML = '<table>' +
    '<thead><tr><th></th><th>ID</th><th>Name / Title</th><th>Status</th><th>Tags</th><th>Created</th><th>Actions</th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table>';
  wrap.appendChild(tableWrap);

  tableWrap.querySelectorAll('.asset-detail-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      showAssetDetail(btn.dataset.id, detailPanel);
    });
  });

  tableWrap.querySelectorAll('.asset-delete-btn').forEach(function(btn) {
    btn.addEventListener('click', async function(e) {
      e.stopPropagation();
      if (!confirm('Archive asset ' + btn.dataset.id + '?')) return;
      try {
        await apiFetch('/assets/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
        await loadAssets(listSection, detailPanel);
      } catch (err) {
        alert('Error: ' + err.message);
      }
    });
  });
}

async function showAssetDetail(id, detailPanel) {
  detailPanel.style.display = 'block';
  detailPanel.className = 'detail-panel';
  // Static structural HTML only
  detailPanel.innerHTML = [
    '<div class="detail-panel-header">',
    '  <h3>Asset Detail</h3>',
    '  <button id="close-detail" class="btn-ghost" style="font-size:12px;padding:3px 8px;">Close</button>',
    '</div>',
    '<div class="detail-panel-body" id="detail-body"></div>',
  ].join('');

  detailPanel.querySelector('#close-detail').addEventListener('click', function() {
    detailPanel.style.display = 'none';
    detailPanel.innerHTML = '';
  });

  const body = detailPanel.querySelector('#detail-body');
  const loader = loadingEl();
  body.appendChild(loader);

  try {
    const asset = await apiFetch('/assets/' + encodeURIComponent(id));
    let deliveryUrl = null;
    try { deliveryUrl = await apiFetch('/assets/' + encodeURIComponent(id) + '/delivery'); } catch (_) {}

    loader.remove();

    // Build KV grid with escaped values
    const kvRows = [
      ['ID', '<span class="text-mono">' + escHtml(asset.id) + '</span>'],
      ['Title', escHtml(asset.title || asset.name || '—')],
      ['Status', renderBadge(asset.status)],
      ['MIME type', escHtml(asset.mimeType || '—')],
      ['Tags', renderTags(asset.tags)],
      ['Created', escHtml(fmtDate(asset.createdAt))],
      ['Updated', escHtml(fmtDate(asset.updatedAt))],
    ];
    if (deliveryUrl && deliveryUrl.urls) {
      var du = deliveryUrl.urls;
      if (du.hls) kvRows.push(['HLS', '<a href="' + escHtml(du.hls) + '" target="_blank" rel="noopener" style="color:var(--accent)">Open</a>']);
      if (du.dash) kvRows.push(['DASH', '<a href="' + escHtml(du.dash) + '" target="_blank" rel="noopener" style="color:var(--accent)">Open</a>']);
      if (du.source) kvRows.push(['Source URL', '<a href="' + escHtml(du.source) + '" target="_blank" rel="noopener" style="color:var(--accent)">Download</a>']);
    }

    const kvHtml = kvRows.map(function(r) {
      return '<span class="kv-key">' + r[0] + '</span><span class="kv-val">' + r[1] + '</span>';
    }).join('');

    const kvDiv = document.createElement('div');
    kvDiv.className = 'kv-grid';
    kvDiv.innerHTML = kvHtml;
    body.appendChild(kvDiv);

    if (asset.metadata) {
      const metaDiv = document.createElement('div');
      metaDiv.className = 'mt12';
      const metaTitle = document.createElement('div');
      metaTitle.className = 'section-title';
      metaTitle.textContent = 'Metadata';
      const pre = document.createElement('pre');
      pre.className = 'code-block';
      pre.textContent = JSON.stringify(asset.metadata, null, 2);
      metaDiv.appendChild(metaTitle);
      metaDiv.appendChild(pre);
      body.appendChild(metaDiv);
    }

    // Action buttons — static labels, no dynamic content
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'mt12 flex-gap';
    actionsDiv.innerHTML = [
      '<button id="btn-transcode" class="btn-ghost">Transcode (ABR)</button>',
      '<button id="btn-extract-meta" class="btn-ghost">Extract Metadata</button>',
      '<button id="btn-thumbnails" class="btn-ghost">Thumbnails</button>',
    ].join('');
    body.appendChild(actionsDiv);

    const actionMsg = document.createElement('div');
    actionMsg.id = 'action-msg';
    actionMsg.className = 'mt8';
    body.appendChild(actionMsg);

    const thumbArea = document.createElement('div');
    thumbArea.id = 'thumbnails-area';
    body.appendChild(thumbArea);

    body.querySelector('#btn-transcode').addEventListener('click', async function() {
      actionMsg.innerHTML = '';
      try {
        const r = await apiFetch('/assets/' + encodeURIComponent(id) + '/transcode', { method: 'POST', body: JSON.stringify({}) });
        showMsg(actionMsg, 'Transcode job submitted. ID: ' + (r && (r.jobId || r.id) ? (r.jobId || r.id) : JSON.stringify(r)), 'success');
      } catch (err) {
        showMsg(actionMsg, 'Error: ' + err.message, 'error');
      }
    });

    body.querySelector('#btn-extract-meta').addEventListener('click', async function() {
      actionMsg.innerHTML = '';
      try {
        const r = await apiFetch('/assets/' + encodeURIComponent(id) + '/extract-metadata', { method: 'POST', body: JSON.stringify({}) });
        const pre = document.createElement('pre');
        pre.className = 'code-block mt8';
        pre.textContent = JSON.stringify(r, null, 2);
        showMsg(actionMsg, 'Metadata extraction complete.', 'success');
        actionMsg.appendChild(pre);
      } catch (err) {
        showMsg(actionMsg, 'Error: ' + err.message, 'error');
      }
    });

    body.querySelector('#btn-thumbnails').addEventListener('click', async function() {
      actionMsg.innerHTML = '';
      thumbArea.innerHTML = '';
      // First fetch existing thumbnails; if none, extract at 0s, 25%, 50%, 75%
      try {
        var existing = await apiFetch('/assets/' + encodeURIComponent(id) + '/thumbnails');
        var existingUrls = existing && existing.thumbnails ? existing.thumbnails : [];
        if (existingUrls.length) {
          renderThumbnailStrip(thumbArea, existingUrls);
          return;
        }
        // Extract using duration from technicalMetadata if available
        var dur = asset.technicalMetadata && asset.technicalMetadata.durationSeconds
          ? asset.technicalMetadata.durationSeconds : 10;
        var timecodes = [0, Math.round(dur * 0.25), Math.round(dur * 0.5), Math.round(dur * 0.75)];
        showMsg(actionMsg, 'Extracting thumbnails…', 'info');
        var r = await apiFetch('/assets/' + encodeURIComponent(id) + '/thumbnails',
          { method: 'POST', body: JSON.stringify({ timecodes: timecodes }) });
        actionMsg.innerHTML = '';
        var urls = r && r.thumbnails ? r.thumbnails : [];
        if (urls.length) {
          renderThumbnailStrip(thumbArea, urls);
        } else {
          showMsg(actionMsg, 'Thumbnails extracted.', 'success');
        }
      } catch (err) {
        showMsg(actionMsg, 'Error: ' + err.message, 'error');
      }
    });

    function renderThumbnailStrip(container, urls) {
      var titleEl = document.createElement('div');
      titleEl.className = 'section-title mt12';
      titleEl.textContent = 'Thumbnails';
      container.appendChild(titleEl);
      var strip = document.createElement('div');
      strip.className = 'thumbnails';
      urls.forEach(function(u) {
        var img = document.createElement('img');
        img.src = u;
        img.alt = 'thumbnail';
        strip.appendChild(img);
      });
      container.appendChild(strip);
    }

  } catch (err) {
    body.innerHTML = '';
    showMsg(body, 'Failed to load asset: ' + err.message, 'error');
  }
}

// ─── JOBS TAB ────────────────────────────────────────────────────────────────

async function renderJobsTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Jobs';
  container.appendChild(title);

  // Job list
  const listSection = document.createElement('div');
  listSection.className = 'section';
  const listContent = document.createElement('div');
  listContent.appendChild(loadingEl());
  listSection.innerHTML = '<div class="section-title">Recent jobs</div>';
  listSection.appendChild(listContent);
  container.appendChild(listSection);

  apiFetch('/jobs').then(function(data) {
    listContent.innerHTML = '';
    if (!data.items || !data.items.length) {
      listContent.innerHTML = '<p class="text-muted">No jobs yet.</p>';
      return;
    }
    var tbody = document.createElement('tbody');
    data.items.forEach(function(j) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="cell-id">' + escHtml(j.id) + '</td>' +
        '<td>' + escHtml(j.type) + '</td>' +
        '<td>' + renderBadge(j.status) + '</td>' +
        '<td class="cell-id">' + escHtml(j.assetId || '—') + '</td>' +
        '<td>' + (j.progress != null ? j.progress + '%' : '—') + '</td>' +
        '<td>' + escHtml(fmtDate(j.createdAt)) + '</td>' +
        '<td></td>';
      if (j.status === 'running' || j.status === 'pending') {
        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-danger';
        cancelBtn.style.cssText = 'font-size:12px;padding:3px 8px';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function() {
          cancelBtn.disabled = true;
          apiFetch('/jobs/' + encodeURIComponent(j.id), { method: 'DELETE' })
            .then(function() { renderJobsTab(container.parentElement ? container : document.getElementById('content')); })
            .catch(function(err) { cancelBtn.disabled = false; alert(err.message); });
        });
        tr.lastElementChild.appendChild(cancelBtn);
      }
      tbody.appendChild(tr);
    });
    var table = document.createElement('table');
    table.innerHTML = '<thead><tr>' +
      '<th>ID</th><th>Type</th><th>Status</th><th>Asset</th><th>Progress</th><th>Created</th><th></th>' +
      '</tr></thead>';
    table.appendChild(tbody);
    listContent.appendChild(table);
  }).catch(function(err) {
    listContent.innerHTML = '<p class="text-muted">' + escHtml(err.message) + '</p>';
  });

  // Job lookup
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = [
    '<div class="section-title">Look up job by ID</div>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="job-id-input">Job ID</label>',
    '    <input type="text" id="job-id-input" placeholder="job_abc123" />',
    '  </div>',
    '  <button id="job-lookup-btn">Lookup</button>',
    '</div>',
    '<div id="job-result" class="mt8"></div>',
  ].join('');
  container.appendChild(section);

  section.querySelector('#job-lookup-btn').addEventListener('click', async function() {
    const jobId = section.querySelector('#job-id-input').value.trim();
    const resultEl = section.querySelector('#job-result');
    resultEl.innerHTML = '';
    if (!jobId) { showMsg(resultEl, 'Enter a Job ID.', 'error'); return; }
    const loader = loadingEl();
    resultEl.appendChild(loader);
    try {
      const job = await apiFetch('/jobs/' + encodeURIComponent(jobId));
      loader.remove();

      const kvRows = [
        ['ID', '<span class="text-mono">' + escHtml(job.id) + '</span>'],
        ['Asset ID', '<span class="text-mono">' + escHtml(job.assetId || '—') + '</span>'],
        ['Type', escHtml(job.type || '—')],
        ['Status', renderBadge(job.status)],
        ['Created', escHtml(fmtDate(job.createdAt))],
        ['Updated', escHtml(fmtDate(job.updatedAt))],
      ];
      const kvDiv = document.createElement('div');
      kvDiv.className = 'kv-grid mt8';
      kvDiv.innerHTML = kvRows.map(function(r) {
        return '<span class="kv-key">' + r[0] + '</span><span class="kv-val">' + r[1] + '</span>';
      }).join('');
      resultEl.appendChild(kvDiv);

      if (job.error) {
        const errEl = document.createElement('div');
        errEl.className = 'msg msg-error mt8';
        errEl.textContent = job.error;
        resultEl.appendChild(errEl);
      }

      const pre = document.createElement('pre');
      pre.className = 'code-block mt12';
      pre.textContent = JSON.stringify(job, null, 2);
      resultEl.appendChild(pre);
    } catch (err) {
      loader.remove();
      showMsg(resultEl, 'Error: ' + err.message, 'error');
    }
  });

  // Admin status
  const statusSection = document.createElement('div');
  statusSection.className = 'section';
  const sTitle = document.createElement('div');
  sTitle.className = 'section-title';
  sTitle.textContent = 'Background service status';
  statusSection.appendChild(sTitle);
  const adminWrap = document.createElement('div');
  const adminLoader = loadingEl();
  adminWrap.appendChild(adminLoader);
  statusSection.appendChild(adminWrap);
  container.appendChild(statusSection);

  async function refreshWatchFolderStatus() {
    try {
      const status = await apiFetch('/admin/watch-folder/status');
      adminLoader.remove();
      adminWrap.innerHTML = '';

      const row = document.createElement('div');
      row.className = 'form-row';
      row.style.alignItems = 'center';

      const info = document.createElement('span');
      info.style.flex = '1';
      info.innerHTML =
        '<strong>Watch folder:</strong> ' +
        (status.enabled ? (status.running ? '🟢 running' : '🔴 stopped') : '⚪ not configured') +
        ' &nbsp;|&nbsp; processed: <strong>' + escHtml(String(status.processedCount)) + '</strong>';
      row.appendChild(info);

      if (status.enabled) {
        const btn = document.createElement('button');
        btn.className = 'btn-sm';
        btn.textContent = status.running ? 'Stop' : 'Start';
        btn.addEventListener('click', async function() {
          btn.disabled = true;
          try {
            await apiFetch('/admin/watch-folder/' + (status.running ? 'stop' : 'start'), { method: 'POST' });
            await refreshWatchFolderStatus();
          } catch (err) {
            showMsg(adminWrap, 'Error: ' + err.message, 'error');
            btn.disabled = false;
          }
        });
        row.appendChild(btn);
      }
      adminWrap.appendChild(row);
    } catch (err) {
      adminLoader.remove();
      showMsg(adminWrap, 'Failed: ' + err.message, 'error');
    }
  }

  await refreshWatchFolderStatus();
}

// ─── COLLECTIONS TAB ─────────────────────────────────────────────────────────

async function renderCollectionsTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Collections';
  container.appendChild(title);

  // Create form
  const createSection = document.createElement('div');
  createSection.className = 'section';
  createSection.innerHTML = [
    '<div class="section-title">Create collection</div>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="coll-name">Name</label>',
    '    <input type="text" id="coll-name" placeholder="My collection" />',
    '  </div>',
    '  <button id="coll-create-btn">Create</button>',
    '</div>',
    '<div id="coll-create-msg"></div>',
  ].join('');
  container.appendChild(createSection);

  // List section
  const listSection = document.createElement('div');
  listSection.className = 'section';
  listSection.innerHTML = [
    '<div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">',
    '  <span>Collections</span>',
    '  <button id="coll-refresh" class="btn-ghost" style="font-size:12px;padding:4px 10px;">Refresh</button>',
    '</div>',
    '<div id="coll-list-wrap"></div>',
  ].join('');
  container.appendChild(listSection);

  const detailPanel = document.createElement('div');
  detailPanel.id = 'coll-detail';
  detailPanel.style.display = 'none';
  container.appendChild(detailPanel);

  async function loadCollections() {
    const wrap = listSection.querySelector('#coll-list-wrap');
    wrap.innerHTML = '';
    const loader = loadingEl();
    wrap.appendChild(loader);
    let collections = [];
    try {
      const res = await apiFetch('/collections');
      collections = Array.isArray(res) ? res : (res && (res.items || res.collections) ? (res.items || res.collections) : []);
    } catch (err) {
      loader.remove();
      showMsg(wrap, 'Failed: ' + err.message, 'error');
      return;
    }
    loader.remove();
    if (collections.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No collections.';
      wrap.appendChild(empty);
      return;
    }

    const rows = collections.map(function(c) {
      const assetCount = c.assets ? c.assets.length : (c.assetCount != null ? c.assetCount : '—');
      return '<tr data-id="' + escHtml(c.id) + '">' +
        '<td class="cell-id">' + escHtml(c.id) + '</td>' +
        '<td>' + escHtml(c.name || '—') + '</td>' +
        '<td>' + escHtml(String(assetCount)) + '</td>' +
        '<td>' + escHtml(fmtDate(c.createdAt)) + '</td>' +
        '<td>' +
          '<button class="btn-ghost coll-view-btn" data-id="' + escHtml(c.id) + '" style="font-size:12px;padding:3px 8px;">View</button>' +
          '<button class="btn-danger coll-delete-btn" data-id="' + escHtml(c.id) + '" style="font-size:12px;padding:3px 8px;margin-left:4px;">Delete</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    const tableWrap = document.createElement('div');
    tableWrap.className = 'table-wrap';
    tableWrap.innerHTML = '<table>' +
      '<thead><tr><th>ID</th><th>Name</th><th>Asset count</th><th>Created</th><th>Actions</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table>';
    wrap.appendChild(tableWrap);

    tableWrap.querySelectorAll('.coll-view-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { showCollectionDetail(btn.dataset.id, detailPanel, loadCollections); });
    });
    tableWrap.querySelectorAll('.coll-delete-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        if (!confirm('Delete collection ' + btn.dataset.id + '?')) return;
        try {
          await apiFetch('/collections/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
          loadCollections();
        } catch (err) {
          alert('Error: ' + err.message);
        }
      });
    });
  }

  createSection.querySelector('#coll-create-btn').addEventListener('click', async function() {
    const name = createSection.querySelector('#coll-name').value.trim();
    const msgEl = createSection.querySelector('#coll-create-msg');
    msgEl.innerHTML = '';
    if (!name) { showMsg(msgEl, 'Name is required.', 'error'); return; }
    try {
      await apiFetch('/collections', { method: 'POST', body: JSON.stringify({ name: name }) });
      showMsg(msgEl, 'Collection created.', 'success');
      createSection.querySelector('#coll-name').value = '';
      loadCollections();
    } catch (err) {
      showMsg(msgEl, 'Error: ' + err.message, 'error');
    }
  });

  listSection.querySelector('#coll-refresh').addEventListener('click', loadCollections);
  await loadCollections();
}

async function showCollectionDetail(id, detailPanel, onRefresh) {
  detailPanel.style.display = 'block';
  detailPanel.className = 'detail-panel';
  detailPanel.innerHTML = [
    '<div class="detail-panel-header">',
    '  <h3>Collection</h3>',
    '  <button id="close-coll-detail" class="btn-ghost" style="font-size:12px;padding:3px 8px;">Close</button>',
    '</div>',
    '<div class="detail-panel-body" id="coll-detail-body"></div>',
  ].join('');

  detailPanel.querySelector('#close-coll-detail').addEventListener('click', function() {
    detailPanel.style.display = 'none';
    detailPanel.innerHTML = '';
  });

  const body = detailPanel.querySelector('#coll-detail-body');
  const loader = loadingEl();
  body.appendChild(loader);

  try {
    const coll = await apiFetch('/collections/' + encodeURIComponent(id));
    loader.remove();
    const assets = coll.assets || [];

    const kvDiv = document.createElement('div');
    kvDiv.className = 'kv-grid';
    kvDiv.innerHTML = [
      '<span class="kv-key">ID</span><span class="kv-val text-mono">' + escHtml(coll.id) + '</span>',
      '<span class="kv-key">Name</span><span class="kv-val">' + escHtml(coll.name || '—') + '</span>',
      '<span class="kv-key">Created</span><span class="kv-val">' + escHtml(fmtDate(coll.createdAt)) + '</span>',
    ].join('');
    body.appendChild(kvDiv);

    // Add asset form
    const addDiv = document.createElement('div');
    addDiv.className = 'mt12';
    addDiv.innerHTML = [
      '<div class="section-title">Add asset to collection</div>',
      '<div class="form-row mt8">',
      '  <div class="form-field grow">',
      '    <input type="text" id="add-asset-id" placeholder="Asset ID" />',
      '  </div>',
      '  <button id="add-asset-btn">Add</button>',
      '</div>',
      '<div id="add-asset-msg"></div>',
    ].join('');
    body.appendChild(addDiv);

    addDiv.querySelector('#add-asset-btn').addEventListener('click', async function() {
      const assetId = addDiv.querySelector('#add-asset-id').value.trim();
      const msgEl = addDiv.querySelector('#add-asset-msg');
      msgEl.innerHTML = '';
      if (!assetId) { showMsg(msgEl, 'Asset ID required.', 'error'); return; }
      try {
        await apiFetch('/collections/' + encodeURIComponent(id) + '/assets/' + encodeURIComponent(assetId), { method: 'PUT', body: JSON.stringify({}) });
        showMsg(msgEl, 'Asset added.', 'success');
        showCollectionDetail(id, detailPanel, onRefresh);
      } catch (err) {
        showMsg(msgEl, 'Error: ' + err.message, 'error');
      }
    });

    // Asset list
    const assetsDiv = document.createElement('div');
    assetsDiv.className = 'mt12';
    const assetsTitle = document.createElement('div');
    assetsTitle.className = 'section-title';
    assetsTitle.textContent = 'Assets (' + assets.length + ')';
    assetsDiv.appendChild(assetsTitle);

    if (assets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No assets in this collection.';
      assetsDiv.appendChild(empty);
    } else {
      const rows = assets.map(function(a) {
        return '<tr>' +
          '<td class="cell-id">' + escHtml(a.id) + '</td>' +
          '<td>' + escHtml(a.title || a.name || '—') + '</td>' +
          '<td>' + renderBadge(a.status) + '</td>' +
          '<td><button class="btn-danger remove-asset-btn" data-asset-id="' + escHtml(a.id) + '" style="font-size:12px;padding:3px 8px;">Remove</button></td>' +
          '</tr>';
      }).join('');
      const tableWrap = document.createElement('div');
      tableWrap.className = 'table-wrap';
      tableWrap.innerHTML = '<table>' +
        '<thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Actions</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>';
      assetsDiv.appendChild(tableWrap);

      tableWrap.querySelectorAll('.remove-asset-btn').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          try {
            await apiFetch('/collections/' + encodeURIComponent(id) + '/assets/' + encodeURIComponent(btn.dataset.assetId), { method: 'DELETE' });
            showCollectionDetail(id, detailPanel, onRefresh);
          } catch (err) {
            alert('Error: ' + err.message);
          }
        });
      });
    }
    body.appendChild(assetsDiv);

  } catch (err) {
    body.innerHTML = '';
    showMsg(body, 'Failed: ' + err.message, 'error');
  }
}

// ─── SEARCH TAB ──────────────────────────────────────────────────────────────

async function renderSearchTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Search';
  container.appendChild(title);

  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = [
    '<div class="section-title">Search assets</div>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="search-q">Query</label>',
    '    <input type="text" id="search-q" placeholder="Full-text search…" />',
    '  </div>',
    '  <div class="form-field">',
    '    <label for="search-tags">Tags (comma-separated)</label>',
    '    <input type="text" id="search-tags" placeholder="news,sports" />',
    '  </div>',
    '  <div class="form-field">',
    '    <label for="search-mime">MIME type</label>',
    '    <input type="text" id="search-mime" placeholder="video/mp4" />',
    '  </div>',
    '  <button id="search-btn">Search</button>',
    '</div>',
    '<div id="search-results" class="mt8"></div>',
  ].join('');
  container.appendChild(section);

  section.querySelector('#search-btn').addEventListener('click', async function() {
    const q = section.querySelector('#search-q').value.trim();
    const tags = section.querySelector('#search-tags').value.trim();
    const mime = section.querySelector('#search-mime').value.trim();
    const resultsEl = section.querySelector('#search-results');
    resultsEl.innerHTML = '';
    const loader = loadingEl();
    resultsEl.appendChild(loader);

    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tags) params.set('tags', tags);
    if (mime) params.set('mimeType', mime);

    try {
      const res = await apiFetch('/search?' + params.toString());
      const assets = Array.isArray(res) ? res :
        (res && (res.items || res.results || res.assets) ? (res.items || res.results || res.assets) : []);
      loader.remove();
      if (assets.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No results.';
        resultsEl.appendChild(empty);
        return;
      }
      const rows = assets.map(function(a) {
        return '<tr>' +
          '<td class="cell-id">' + escHtml(a.id) + '</td>' +
          '<td>' + escHtml(a.title || a.name || '—') + '</td>' +
          '<td>' + renderBadge(a.status) + '</td>' +
          '<td>' + renderTags(a.tags) + '</td>' +
          '<td>' + escHtml(a.mimeType || '—') + '</td>' +
          '<td>' + escHtml(fmtDate(a.createdAt)) + '</td>' +
          '</tr>';
      }).join('');
      const tableWrap = document.createElement('div');
      tableWrap.className = 'table-wrap';
      tableWrap.innerHTML = '<table>' +
        '<thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Tags</th><th>MIME type</th><th>Created</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>';
      resultsEl.appendChild(tableWrap);
    } catch (err) {
      loader.remove();
      showMsg(resultsEl, 'Error: ' + err.message, 'error');
    }
  });
}

// ─── WEBHOOKS TAB ────────────────────────────────────────────────────────────

const WEBHOOK_EVENTS = ['asset.ready', 'transcode.complete', 'package.complete', 'asset.failed'];

async function renderWebhooksTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Webhooks';
  container.appendChild(title);

  // Register form
  const registerSection = document.createElement('div');
  registerSection.className = 'section';
  // All labels are static strings — no dynamic content
  const checkboxes = WEBHOOK_EVENTS.map(function(ev) {
    return '<label class="checkbox-label">' +
      '<input type="checkbox" name="wh-event" value="' + escHtml(ev) + '" checked />' +
      ' ' + escHtml(ev) +
      '</label>';
  }).join('');

  registerSection.innerHTML = [
    '<div class="section-title">Register webhook</div>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="wh-url">Endpoint URL</label>',
    '    <input type="url" id="wh-url" placeholder="https://example.com/webhook" />',
    '  </div>',
    '</div>',
    '<div class="form-field mt8">',
    '  <label>Events</label>',
    '  <div class="checkbox-group">' + checkboxes + '</div>',
    '</div>',
    '<button id="wh-register-btn" class="mt8">Register</button>',
    '<div id="wh-register-msg"></div>',
  ].join('');
  container.appendChild(registerSection);

  // List
  const listSection = document.createElement('div');
  listSection.className = 'section';
  listSection.innerHTML = [
    '<div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">',
    '  <span>Registered webhooks</span>',
    '  <button id="wh-refresh" class="btn-ghost" style="font-size:12px;padding:4px 10px;">Refresh</button>',
    '</div>',
    '<div id="wh-list-wrap"></div>',
  ].join('');
  container.appendChild(listSection);

  async function loadWebhooks() {
    const wrap = listSection.querySelector('#wh-list-wrap');
    wrap.innerHTML = '';
    const loader = loadingEl();
    wrap.appendChild(loader);
    let webhooks = [];
    try {
      const res = await apiFetch('/webhooks');
      webhooks = Array.isArray(res) ? res : (res && (res.items || res.webhooks) ? (res.items || res.webhooks) : []);
    } catch (err) {
      loader.remove();
      showMsg(wrap, 'Failed: ' + err.message, 'error');
      return;
    }
    loader.remove();
    if (webhooks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No webhooks registered.';
      wrap.appendChild(empty);
      return;
    }
    const rows = webhooks.map(function(wh) {
      const evTags = (wh.events || []).map(function(e) { return '<span class="tag">' + escHtml(e) + '</span>'; }).join(' ');
      return '<tr>' +
        '<td class="cell-id">' + escHtml(wh.id) + '</td>' +
        '<td style="word-break:break-all;">' + escHtml(wh.url || wh.endpoint || '—') + '</td>' +
        '<td>' + evTags + '</td>' +
        '<td>' + escHtml(fmtDate(wh.createdAt)) + '</td>' +
        '<td><button class="btn-danger wh-delete-btn" data-id="' + escHtml(wh.id) + '" style="font-size:12px;padding:3px 8px;">Delete</button></td>' +
        '</tr>';
    }).join('');
    const tableWrap = document.createElement('div');
    tableWrap.className = 'table-wrap';
    tableWrap.innerHTML = '<table>' +
      '<thead><tr><th>ID</th><th>URL</th><th>Events</th><th>Created</th><th>Actions</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table>';
    wrap.appendChild(tableWrap);

    tableWrap.querySelectorAll('.wh-delete-btn').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        if (!confirm('Delete webhook ' + btn.dataset.id + '?')) return;
        try {
          await apiFetch('/webhooks/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
          loadWebhooks();
        } catch (err) {
          alert('Error: ' + err.message);
        }
      });
    });
  }

  registerSection.querySelector('#wh-register-btn').addEventListener('click', async function() {
    const url = registerSection.querySelector('#wh-url').value.trim();
    const events = Array.from(registerSection.querySelectorAll('input[name="wh-event"]:checked')).map(function(cb) { return cb.value; });
    const msgEl = registerSection.querySelector('#wh-register-msg');
    msgEl.innerHTML = '';
    if (!url) { showMsg(msgEl, 'URL is required.', 'error'); return; }
    if (events.length === 0) { showMsg(msgEl, 'Select at least one event.', 'error'); return; }
    try {
      await apiFetch('/webhooks', { method: 'POST', body: JSON.stringify({ url: url, events: events }) });
      showMsg(msgEl, 'Webhook registered.', 'success');
      registerSection.querySelector('#wh-url').value = '';
      loadWebhooks();
    } catch (err) {
      showMsg(msgEl, 'Error: ' + err.message, 'error');
    }
  });

  listSection.querySelector('#wh-refresh').addEventListener('click', loadWebhooks);
  await loadWebhooks();
}

// ─── STORAGE TAB ─────────────────────────────────────────────────────────────

async function renderStorageTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Storage';
  container.appendChild(title);

  // Create-bucket form
  const createSection = document.createElement('div');
  createSection.className = 'section';
  createSection.innerHTML = [
    '<div class="section-title">Create bucket</div>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="bucket-name">Bucket name</label>',
    '    <input type="text" id="bucket-name" placeholder="my-bucket (3-63 chars, a-z 0-9 -)" />',
    '  </div>',
    '  <button id="bucket-create-btn">Create</button>',
    '</div>',
    '<div id="bucket-create-msg"></div>',
  ].join('');
  container.appendChild(createSection);

  // Bucket list section
  const bucketsSection = document.createElement('div');
  bucketsSection.className = 'section';
  bucketsSection.innerHTML = '<div class="section-title">Buckets</div><div id="buckets-wrap"></div>';
  container.appendChild(bucketsSection);

  // Browser panel (hidden until a bucket is selected)
  const browser = document.createElement('div');
  browser.id = 'storage-browser';
  browser.style.display = 'none';
  container.appendChild(browser);

  const bucketsWrap = bucketsSection.querySelector('#buckets-wrap');

  async function loadBuckets() {
    bucketsWrap.innerHTML = '';
    const loader = loadingEl();
    bucketsWrap.appendChild(loader);

    let buckets = [];
    try {
      buckets = await apiFetch('/storage/buckets');
    } catch (err) {
      loader.remove();
      showMsg(bucketsWrap, 'Failed to load buckets: ' + err.message, 'error');
      return;
    }
    loader.remove();

    if (!buckets || buckets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No buckets configured.';
      bucketsWrap.appendChild(empty);
      return;
    }

    const cards = document.createElement('div');
    cards.className = 'bucket-cards';
    buckets.forEach(function(b) {
      const card = document.createElement('div');
      card.className = 'bucket-card';
      const badgeCls = b.role === 'source' ? 'badge-pending' : (b.role === 'packaged' ? 'badge-ready' : 'badge-unknown');
      card.innerHTML =
        '<div class="bucket-card-name">📦 ' + escHtml(b.name) + '</div>' +
        '<span class="badge ' + badgeCls + '">' + escHtml(b.role) + '</span>';
      card.addEventListener('click', function() {
        cards.querySelectorAll('.bucket-card').forEach(function(c) { c.classList.remove('active'); });
        card.classList.add('active');
        openBucketBrowser(browser, b.name, '');
      });
      cards.appendChild(card);
    });
    bucketsWrap.appendChild(cards);
  }

  createSection.querySelector('#bucket-create-btn').addEventListener('click', async function() {
    const input = createSection.querySelector('#bucket-name');
    const name = input.value.trim();
    const msgEl = createSection.querySelector('#bucket-create-msg');
    msgEl.innerHTML = '';
    if (!name) { showMsg(msgEl, 'Bucket name is required.', 'error'); return; }
    if (!/^[a-zA-Z0-9-]{3,63}$/.test(name)) {
      showMsg(msgEl, 'Name must be 3-63 alphanumeric characters and hyphens.', 'error');
      return;
    }
    try {
      await apiFetch('/storage/buckets', { method: 'POST', body: JSON.stringify({ name: name }) });
      showMsg(msgEl, 'Bucket "' + name + '" created.', 'success');
      input.value = '';
      await loadBuckets();
    } catch (err) {
      showMsg(msgEl, 'Error: ' + err.message, 'error');
    }
  });

  await loadBuckets();
}

async function renderWatchFolderToggle(wfEl, bucket) {
  wfEl.innerHTML = '';
  let status;
  try {
    status = await apiFetch('/storage/buckets/' + encodeURIComponent(bucket) + '/watch-folder');
  } catch (err) {
    // Watch-folder not configured (501) or other error — surface nothing
    // intrusive; the feature is optional.
    showMsg(wfEl, 'Watch folder unavailable: ' + err.message, 'info');
    return;
  }

  const btn = document.createElement('button');
  btn.className = 'btn-sm';
  const active = status.enabled && status.running;
  btn.textContent = active ? '⏹ Disable watch folder' : '▶ Enable watch folder';
  btn.addEventListener('click', async function() {
    btn.disabled = true;
    try {
      await apiFetch('/storage/buckets/' + encodeURIComponent(bucket) + '/watch-folder/toggle', { method: 'POST' });
      await renderWatchFolderToggle(wfEl, bucket);
    } catch (err) {
      showMsg(wfEl, 'Error: ' + err.message, 'error');
      btn.disabled = false;
    }
  });
  wfEl.appendChild(btn);
}

async function openBucketBrowser(browser, bucket, prefix) {
  browser.style.display = 'block';
  browser.className = 'section';
  browser.innerHTML = [
    '<div class="section-title">Bucket: ' + escHtml(bucket) + '</div>',
    '<div id="storage-watch-folder" class="mt8"></div>',
    '<div id="storage-breadcrumb" class="breadcrumb"></div>',
    '<div id="storage-objects"></div>',
  ].join('');

  // Watch-folder toggle for this bucket.
  const wfEl = browser.querySelector('#storage-watch-folder');
  renderWatchFolderToggle(wfEl, bucket);

  // Breadcrumb trail — each segment clickable, narrows the prefix.
  const crumb = browser.querySelector('#storage-breadcrumb');
  const segments = prefix.split('/').filter(Boolean);
  const rootLink = document.createElement('a');
  rootLink.href = '#';
  rootLink.className = 'crumb-seg';
  rootLink.textContent = '(root)';
  rootLink.addEventListener('click', function(e) { e.preventDefault(); openBucketBrowser(browser, bucket, ''); });
  crumb.appendChild(rootLink);
  let acc = '';
  segments.forEach(function(seg) {
    acc += seg + '/';
    const sep = document.createTextNode(' / ');
    crumb.appendChild(sep);
    const link = document.createElement('a');
    link.href = '#';
    link.className = 'crumb-seg';
    link.textContent = seg;
    const target = acc;
    link.addEventListener('click', function(e) { e.preventDefault(); openBucketBrowser(browser, bucket, target); });
    crumb.appendChild(link);
  });

  const objectsEl = browser.querySelector('#storage-objects');
  const loader = loadingEl();
  objectsEl.appendChild(loader);

  let data;
  try {
    const qs = new URLSearchParams();
    if (prefix) qs.set('prefix', prefix);
    data = await apiFetch('/storage/buckets/' + encodeURIComponent(bucket) + '/objects' + (qs.toString() ? '?' + qs.toString() : ''));
  } catch (err) {
    loader.remove();
    showMsg(objectsEl, 'Failed to list objects: ' + err.message, 'error');
    return;
  }
  loader.remove();

  const objects = (data && data.objects) || [];
  if (objects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No objects in this location.';
    objectsEl.appendChild(empty);
    return;
  }

  const rows = objects.map(function(o) {
    // Display only the portion of the key below the current prefix.
    const display = prefix && o.key.indexOf(prefix) === 0 ? o.key.slice(prefix.length) : o.key;
    if (o.isPrefix) {
      return '<tr>' +
        '<td><a href="#" class="storage-folder" data-prefix="' + escHtml(o.key) + '">📁 ' + escHtml(display) + '</a></td>' +
        '<td>—</td>' +
        '<td>—</td>' +
        '<td></td>' +
        '</tr>';
    }
    return '<tr>' +
      '<td>' + escHtml(display) + '</td>' +
      '<td>' + escHtml(fmtBytes(o.size)) + '</td>' +
      '<td>' + escHtml(fmtDate(o.lastModified)) + '</td>' +
      '<td><button class="btn-danger storage-delete-btn" data-key="' + escHtml(o.key) + '" style="font-size:12px;padding:3px 8px;">Delete</button></td>' +
      '</tr>';
  }).join('');

  const tableWrap = document.createElement('div');
  tableWrap.className = 'table-wrap';
  tableWrap.innerHTML = '<table>' +
    '<thead><tr><th>Name</th><th>Size</th><th>Last modified</th><th>Actions</th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table>';
  objectsEl.appendChild(tableWrap);

  tableWrap.querySelectorAll('.storage-folder').forEach(function(link) {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      openBucketBrowser(browser, bucket, link.dataset.prefix);
    });
  });

  tableWrap.querySelectorAll('.storage-delete-btn').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      if (!confirm('Delete object ' + btn.dataset.key + '?')) return;
      try {
        const path = btn.dataset.key.split('/').map(encodeURIComponent).join('/');
        await apiFetch('/storage/buckets/' + encodeURIComponent(bucket) + '/objects/' + path, { method: 'DELETE' });
        openBucketBrowser(browser, bucket, prefix);
      } catch (err) {
        alert('Error: ' + err.message);
      }
    });
  });
}

// ─── PROVISION TAB ───────────────────────────────────────────────────────────

async function renderProvisionTab(container) {
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'Provision OSC Stack';
  container.appendChild(title);

  // Active operations — shown on load so in-progress ops survive tab switches / reloads.
  const opsSection = document.createElement('div');
  opsSection.className = 'section';
  const opsSectionTitle = document.createElement('div');
  opsSectionTitle.className = 'section-title';
  opsSectionTitle.textContent = 'Active operations';
  opsSection.appendChild(opsSectionTitle);
  const opsContent = document.createElement('div');
  opsSection.appendChild(opsContent);
  container.appendChild(opsSection);

  const activeOpIds = new Set();

  function renderOpRow(op) {
    const isDone = op.status === 'done';
    const isFailed = op.status === 'failed';
    const row = document.createElement('div');
    row.id = 'op-' + op.id;
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--border,#333);font-size:13px;';

    const icon = document.createElement('span');
    icon.style.cssText = 'min-width:16px;margin-top:1px;';
    icon.textContent = isDone ? '✓' : isFailed ? '✗' : '⟳';

    const body = document.createElement('div');
    const label = document.createElement('span');
    label.style.fontWeight = 'bold';
    label.textContent = op.type + ' ';
    const nameSpan = document.createElement('span');
    nameSpan.style.fontFamily = 'monospace';
    nameSpan.textContent = op.name;
    const statusSpan = document.createElement('span');
    statusSpan.style.cssText = 'margin-left:8px;opacity:.7;';
    statusSpan.textContent = op.status;
    body.appendChild(label);
    body.appendChild(nameSpan);
    body.appendChild(statusSpan);
    if (op.error) {
      const errEl = document.createElement('div');
      errEl.style.cssText = 'font-size:11px;opacity:.7;margin-top:2px;color:var(--color-danger,#f66);';
      errEl.textContent = op.error;
      body.appendChild(errEl);
    }

    row.appendChild(icon);
    row.appendChild(body);
    return row;
  }

  function upsertOpRow(op) {
    const existing = opsContent.querySelector('#op-' + op.id);
    const row = renderOpRow(op);
    if (existing) existing.replaceWith(row);
    else opsContent.prepend(row);
  }

  function pollOp(op) {
    if (activeOpIds.has(op.id)) return;
    activeOpIds.add(op.id);
    const tick = function() {
      apiFetch('/provision/operations/' + encodeURIComponent(op.id)).then(function(updated) {
        upsertOpRow(updated);
        if (updated.status !== 'done' && updated.status !== 'failed') {
          setTimeout(tick, 3000);
        } else {
          activeOpIds.delete(op.id);
          // Hide the section once no active ops remain.
          const row = opsContent.querySelector('#op-' + op.id);
          if (row) row.remove();
          if (!activeOpIds.size) opsSection.style.display = 'none';
        }
      }).catch(function() {
        setTimeout(tick, 5000);
      });
    };
    setTimeout(tick, 3000);
  }

  function refreshOpsSection() {
    apiFetch('/provision/operations').then(function(ops) {
      const active = (ops || []).filter(function(op) {
        return op.status === 'pending' || op.status === 'running';
      });
      opsSection.style.display = active.length ? '' : 'none';
      active.forEach(function(op) {
        upsertOpRow(op);
        pollOp(op);
      });
    }).catch(function() {});
  }
  opsSection.style.display = 'none';
  refreshOpsSection();

  // Stack list
  const listSection = document.createElement('div');
  listSection.className = 'section';
  const listContent = document.createElement('div');
  listContent.id = 'stacks-list';
  listContent.appendChild(loadingEl());
  listSection.innerHTML = '<div class="section-title">Provisioned stacks</div>';
  listSection.appendChild(listContent);
  container.appendChild(listSection);

  // Detail panel (hidden until a stack is clicked)
  const detailSection = document.createElement('div');
  detailSection.className = 'section';
  detailSection.style.display = 'none';
  detailSection.id = 'stack-detail';
  listSection.appendChild(detailSection);

  function showStackDetail(name) {
    detailSection.textContent = '';
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = 'Stack: ' + name;
    detailSection.appendChild(title);
    detailSection.appendChild(loadingEl());
    detailSection.style.display = 'block';
    apiFetch('/provision/' + encodeURIComponent(name)).then(function(data) {
      detailSection.textContent = '';
      const t2 = document.createElement('div');
      t2.className = 'section-title';
      t2.textContent = 'Stack: ' + name;
      detailSection.appendChild(t2);
      const table = document.createElement('table');
      Object.entries(data)
        .filter(function(e) { return e[0] !== 'services'; })
        .forEach(function(e) {
          const tr = document.createElement('tr');
          const kd = document.createElement('td');
          kd.style.cssText = 'color:var(--text-muted);white-space:nowrap;padding-right:16px';
          kd.textContent = e[0];
          const vd = document.createElement('td');
          vd.style.cssText = 'word-break:break-all;font-family:monospace;font-size:12px';
          vd.textContent = String(e[1]);
          tr.appendChild(kd);
          tr.appendChild(vd);
          table.appendChild(tr);
        });
      detailSection.appendChild(table);
    }).catch(function(err) {
      detailSection.textContent = '';
      const p = document.createElement('p');
      p.className = 'text-muted';
      p.textContent = err.message;
      detailSection.appendChild(p);
    });
  }

  function pollDeprovisionOp(opId, statusEl, rowEl) {
    apiFetch('/provision/operations/' + encodeURIComponent(opId)).then(function(op) {
      if (op.status === 'done') {
        statusEl.textContent = '✓ removed';
        statusEl.style.color = 'var(--color-success, #4caf50)';
        if (rowEl) rowEl.remove();
      } else if (op.status === 'failed') {
        statusEl.textContent = '✗ ' + (op.error || 'failed');
        statusEl.style.color = 'var(--color-danger, #f44)';
      } else {
        statusEl.textContent = op.status + '…';
        setTimeout(function() { pollDeprovisionOp(opId, statusEl, rowEl); }, 3000);
      }
    }).catch(function() {
      setTimeout(function() { pollDeprovisionOp(opId, statusEl, rowEl); }, 5000);
    });
  }

  apiFetch('/provision').then(function(names) {
    listContent.textContent = '';
    if (!names.length) {
      const p = document.createElement('p');
      p.className = 'text-muted';
      p.textContent = 'No stacks provisioned yet.';
      listContent.appendChild(p);
      return;
    }
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    ['Name', '', ''].forEach(function(h) {
      const th = document.createElement('th');
      th.textContent = h;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    names.forEach(function(name) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = name;

      const tdBtn = document.createElement('td');
      const detailBtn = document.createElement('button');
      detailBtn.className = 'btn-sm';
      detailBtn.textContent = 'Details';
      detailBtn.addEventListener('click', function() { showStackDetail(name); });
      tdBtn.appendChild(detailBtn);

      const tdRemove = document.createElement('td');
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-sm btn-danger';
      removeBtn.textContent = 'Remove';
      const statusSpan = document.createElement('span');
      statusSpan.style.cssText = 'margin-left:8px;font-size:12px;';
      removeBtn.addEventListener('click', function() {
        if (!confirm('Remove stack "' + name + '"? This will destroy all OSC services in the stack.')) return;
        removeBtn.disabled = true;
        statusSpan.textContent = 'removing…';
        apiFetch('/provision/' + encodeURIComponent(name), { method: 'DELETE' }).then(function(res) {
          const opId = res && res.operationId;
          if (opId) {
            statusSpan.textContent = 'pending…';
            // Mirror into Active Operations so it survives tab switches.
            upsertOpRow({ id: opId, type: 'deprovision', name: name, status: 'pending' });
            pollOp({ id: opId, type: 'deprovision', name: name, status: 'pending' });
            pollDeprovisionOp(opId, statusSpan, tr);
          } else {
            statusSpan.textContent = '✓ removed';
            tr.remove();
          }
        }).catch(function(err) {
          statusSpan.textContent = '✗ ' + err.message;
          removeBtn.disabled = false;
        });
      });
      tdRemove.appendChild(removeBtn);
      tdRemove.appendChild(statusSpan);

      tr.appendChild(tdName);
      tr.appendChild(tdBtn);
      tr.appendChild(tdRemove);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    listContent.appendChild(table);
  }).catch(function(err) {
    listContent.textContent = '';
    const p = document.createElement('p');
    p.className = 'text-muted';
    p.textContent = err.message;
    listContent.appendChild(p);
  });

  // Provision form
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = [
    '<div class="section-title">Provision a new stack</div>',
    '<p class="text-muted" style="font-size:13px;margin-bottom:12px;">Creates and configures OSC services for a named workspace.</p>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="prov-name">Stack name</label>',
    '    <input type="text" id="prov-name" placeholder="my-workspace" />',
    '  </div>',
    '  <button id="prov-btn">Provision Stack</button>',
    '</div>',
    '<div id="prov-msg"></div>',
  ].join('');
  container.appendChild(section);

  // Status lookup
  const statusSection = document.createElement('div');
  statusSection.className = 'section';
  statusSection.innerHTML = [
    '<div class="section-title">Check stack coordinates</div>',
    '<div class="form-row">',
    '  <div class="form-field grow">',
    '    <label for="prov-status-name">Stack name</label>',
    '    <input type="text" id="prov-status-name" placeholder="my-workspace" />',
    '  </div>',
    '  <button id="prov-status-btn" class="btn-ghost">Get Status</button>',
    '</div>',
    '<div id="prov-status-result" class="mt8"></div>',
  ].join('');
  container.appendChild(statusSection);

  section.querySelector('#prov-btn').addEventListener('click', async function() {
    const name = section.querySelector('#prov-name').value.trim();
    const msgEl = section.querySelector('#prov-msg');
    msgEl.innerHTML = '';
    if (!name) { showMsg(msgEl, 'Stack name is required.', 'error'); return; }
    const btn = section.querySelector('#prov-btn');
    btn.disabled = true;
    btn.textContent = 'Provisioning…';
    try {
      const result = await apiFetch('/provision', { method: 'POST', body: JSON.stringify({ name: name }) });
      const opId = result && result.operationId;

      // Show a live status bar that polls until done/failed.
      const statusBar = document.createElement('div');
      statusBar.className = 'mt8';
      msgEl.appendChild(statusBar);

      const updateBar = function(op) {
        const isDone = op.status === 'done';
        const isFailed = op.status === 'failed';
        const icon = isDone ? '✓' : isFailed ? '✗' : '…';
        const cls = isDone ? 'success' : isFailed ? 'error' : 'info';

        statusBar.textContent = '';
        const wrap = document.createElement('div');
        wrap.className = 'msg msg-' + cls;
        wrap.style.cssText = 'display:flex;align-items:center;gap:8px;';

        const iconEl = document.createElement('span');
        iconEl.style.fontSize = '16px';
        iconEl.textContent = icon;
        wrap.appendChild(iconEl);

        const body = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = op.status;
        body.appendChild(strong);
        body.appendChild(document.createTextNode(' — ' + op.name));
        if (op.error) {
          const errEl = document.createElement('span');
          errEl.style.cssText = 'display:block;font-size:12px;opacity:.8;';
          errEl.textContent = op.error;
          body.appendChild(errEl);
        }
        wrap.appendChild(body);
        statusBar.appendChild(wrap);
        if (isDone) {
          // Show stack coordinates inline once provisioning succeeds.
          apiFetch('/provision/' + encodeURIComponent(op.name)).then(function(coords) {
            const pre = document.createElement('pre');
            pre.className = 'code-block mt8';
            pre.textContent = JSON.stringify(coords, null, 2);
            msgEl.appendChild(pre);
          }).catch(function() {});
        }
      };

      if (opId) {
        // Mirror into the Active Operations section so it survives tab switches.
        upsertOpRow({ id: opId, type: 'provision', name: name, status: 'pending' });
        pollOp({ id: opId, type: 'provision', name: name, status: 'pending' });
        // Poll until terminal (also updates the inline status bar).
        const poll = async function() {
          try {
            const op = await apiFetch('/provision/operations/' + encodeURIComponent(opId));
            updateBar(op);
            if (op.status !== 'done' && op.status !== 'failed') {
              setTimeout(poll, 3000);
            } else {
              btn.disabled = false;
              btn.textContent = 'Provision Stack';
            }
          } catch (e) {
            // Keep polling on transient fetch errors.
            setTimeout(poll, 5000);
          }
        };
        updateBar({ status: 'pending', name: name });
        poll();
      } else {
        // Fallback: no operationId, show raw response.
        showMsg(msgEl, 'Provisioning started for "' + name + '".', 'success');
        btn.disabled = false;
        btn.textContent = 'Provision Stack';
      }
    } catch (err) {
      showMsg(msgEl, 'Error: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Provision Stack';
    }
  });

  statusSection.querySelector('#prov-status-btn').addEventListener('click', async function() {
    const name = statusSection.querySelector('#prov-status-name').value.trim();
    const resultEl = statusSection.querySelector('#prov-status-result');
    resultEl.innerHTML = '';
    if (!name) { showMsg(resultEl, 'Stack name is required.', 'error'); return; }
    const loader = loadingEl();
    resultEl.appendChild(loader);
    try {
      const data = await apiFetch('/provision/' + encodeURIComponent(name));
      loader.remove();

      const kvRows = [
        ['Name', escHtml(data && data.name ? data.name : name)],
        ['Status', renderBadge(data && data.status ? data.status : null)],
        ['Created', escHtml(fmtDate(data && data.createdAt ? data.createdAt : null))],
      ];

      const kvDiv = document.createElement('div');
      kvDiv.className = 'kv-grid';
      kvDiv.innerHTML = kvRows.map(function(r) {
        return '<span class="kv-key">' + r[0] + '</span><span class="kv-val">' + r[1] + '</span>';
      }).join('');
      resultEl.appendChild(kvDiv);

      const endpoints = (data && (data.endpoints || data.services)) ? (data.endpoints || data.services) : {};
      if (Object.keys(endpoints).length > 0) {
        const epTitle = document.createElement('div');
        epTitle.className = 'mt12 section-title';
        epTitle.textContent = 'Endpoints';
        resultEl.appendChild(epTitle);

        const epGrid = document.createElement('div');
        epGrid.className = 'kv-grid mt8';
        epGrid.innerHTML = Object.entries(endpoints).map(function(pair) {
          const k = pair[0], v = pair[1];
          return '<span class="kv-key">' + escHtml(k) + '</span>' +
            '<span class="kv-val text-mono">' + escHtml(typeof v === 'string' ? v : JSON.stringify(v)) + '</span>';
        }).join('');
        resultEl.appendChild(epGrid);
      }

      const pre = document.createElement('pre');
      pre.className = 'code-block mt12';
      pre.textContent = JSON.stringify(data, null, 2);
      resultEl.appendChild(pre);

    } catch (err) {
      loader.remove();
      showMsg(resultEl, 'Error: ' + err.message, 'error');
    }
  });
}

// ─── Tab renderer registry ───────────────────────────────────────────────────

TAB_RENDERERS['assets'] = renderAssetsTab;
TAB_RENDERERS['jobs'] = renderJobsTab;
TAB_RENDERERS['collections'] = renderCollectionsTab;
TAB_RENDERERS['search'] = renderSearchTab;
TAB_RENDERERS['webhooks'] = renderWebhooksTab;
TAB_RENDERERS['storage'] = renderStorageTab;
TAB_RENDERERS['provision'] = renderProvisionTab;

// ─── Boot ────────────────────────────────────────────────────────────────────

setupTabs();
switchTab('assets');
initStackSelector();
