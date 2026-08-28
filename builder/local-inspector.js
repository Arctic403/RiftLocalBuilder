import { listLocal, putLocal } from './storage.js';
import { RiftGitHubClient } from './github.js';

const API = 'https://api.github.com';
const OWNER = 'Arctic403';
const REPO = 'RiftCityV1';
const BRANCH = 'ai-static-world-builder';
const QUEUE_BRANCH = 'rift-local-queue';
const TOKEN_KEY = 'rift-local-builder.github-token';
const VISUALS_DIR = 'rift-local-visuals';
const CAPTURE_W = 720;
const CAPTURE_H = 540;
const FILES = {
  engine: 'public/rift-engine.js',
  math: 'public/rift-engine-math.js',
  geometry: 'public/rift-engine-geometry.js'
};
const STANDARD_CAPTURES = [
  { id: 'exterior-iso-nw', label: 'Exterior ISO NW', mode: 'exterior', view: 'iso-nw' },
  { id: 'exterior-iso-ne', label: 'Exterior ISO NE', mode: 'exterior', view: 'iso-ne' },
  { id: 'exterior-front', label: 'Exterior front', mode: 'exterior', view: 'south' },
  { id: 'exterior-top', label: 'Exterior top', mode: 'exterior', view: 'top' },
  { id: 'roof-off-iso-ne', label: 'Roof off ISO NE', mode: 'roof-off', view: 'iso-ne' },
  { id: 'interior-cutaway-iso-ne', label: 'Interior cutaway ISO NE', mode: 'interior', view: 'iso-ne' }
];

const $ = s => document.querySelector(s);
let engineModule = null;
let engine = null;
let camera = null;
let current = null;
let lastPoint = null;
let pointers = new Map();
let lastPinch = null;
const captureLocks = new Set();

function injectUi() {
  const style = document.createElement('style');
  style.textContent = `.inspect-card .inspect-row{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:end}.inspect-dialog{width:100vw!important;height:100dvh!important;max-width:none!important;max-height:none!important;margin:0!important;border:0!important;border-radius:0!important;padding:0!important;background:#06090d!important}.inspect-dialog::backdrop{background:#000}.inspect-shell{display:grid;grid-template-rows:auto 1fr auto;height:100%;background:#070b10}.inspect-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:max(10px,env(safe-area-inset-top)) 10px 10px;background:#0b1118;border-bottom:1px solid #ffffff18}.inspect-toolbar select{width:auto;min-width:118px;border:1px solid #ffffff1b;background:#111a23;color:#eef5fb;border-radius:9px;padding:9px}.inspect-toolbar .grow{flex:1;min-width:120px}.inspect-toolbar small{display:block;color:#8fa0b0;font-size:10px}.inspect-viewport{position:relative;min-height:0}.inspect-viewport canvas{display:block;width:100%;height:100%;touch-action:none;background:#080d12}.inspect-hud{position:absolute;left:10px;bottom:10px;max-width:calc(100% - 20px);padding:7px 9px;border-radius:9px;background:#05090dcc;color:#c7d3dd;font-size:10px;pointer-events:none}.inspect-footer{display:flex;gap:8px;flex-wrap:wrap;padding:10px 10px max(10px,env(safe-area-inset-bottom));background:#0b1118;border-top:1px solid #ffffff18}.inspect-footer .approve{background:#62d889;color:#07120b}.inspect-status.pass{color:#83eca8}@media(max-width:760px){.inspect-card .inspect-row{grid-template-columns:1fr}.inspect-toolbar{align-items:flex-end}}`;
  document.head.append(style);

  const main = document.querySelector('main');
  const card = document.createElement('section');
  card.className = 'card inspect-card';
  card.innerHTML = `<div class="section-title"><div><div class="eyebrow">LOCAL VISUAL GATE</div><h2>Inspect compiled candidate</h2></div><span id="inspect-status" class="status neutral">Ready</span></div><p class="hint">Renders the exact compiled H2 document on this iPhone. A PASS manual build can automatically queue a six-view visual pack to <code>${VISUALS_DIR}</code> on <code>${QUEUE_BRANCH}</code>, so the AI can pull the screenshots without RiftCity Actions.</p><div class="inspect-row"><label>Local PASS candidate<select id="inspect-candidate"></select></label><button id="inspect-open">Open 3D inspector</button><button id="inspect-capture" class="secondary">Capture + queue views</button></div>`;
  main.insertBefore(card, main.lastElementChild);

  const dialog = document.createElement('dialog');
  dialog.id = 'inspect-dialog';
  dialog.className = 'inspect-dialog';
  dialog.innerHTML = `<div class="inspect-shell"><div class="inspect-toolbar"><div class="grow"><b id="inspect-title">Rift Local Inspection</b><small id="inspect-subtitle">Loading…</small></div><label>Mode<select id="inspect-mode"><option value="exterior">Exterior</option><option value="roof-off">Roof off</option><option value="interior">Interior cutaway</option></select></label><label>View<select id="inspect-view"><option value="iso-nw">ISO NW</option><option value="iso-ne">ISO NE</option><option value="top">Top</option><option value="south">Front</option><option value="north">Back</option><option value="east">Right</option><option value="west">Left</option></select></label><button id="inspect-close" class="secondary">Close</button></div><div class="inspect-viewport"><canvas id="inspect-canvas"></canvas><div class="inspect-hud" id="inspect-hud">One finger orbit · pinch zoom · Roof off removes whole authored roof masses · Interior cutaway also removes exterior facade</div></div><div class="inspect-footer"><button id="inspect-approve" class="approve">Approve visual</button><button id="inspect-reset" class="secondary">Reset camera</button><button id="inspect-capture-open" class="secondary">Capture + queue standard views</button><span id="inspect-approval" class="status neutral">Not approved</span></div></div>`;
  document.body.append(dialog);
}

const enc = p => String(p).split('/').map(encodeURIComponent).join('/');
const safe = value => String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);

async function privateText(path, token) {
  const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${enc(path)}?ref=${encodeURIComponent(BRANCH)}`, {
    headers: {
      Accept: 'application/vnd.github.raw+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!r.ok) throw new Error(`Private renderer load failed for ${path} (HTTP ${r.status}).`);
  return r.text();
}

const blob = s => URL.createObjectURL(new Blob([s], { type: 'text/javascript' }));
function swap(source, spec, url) {
  return source.replaceAll(`'${spec}'`, `'${url}'`).replaceAll(`"${spec}"`, `"${url}"`);
}

async function loadEngine() {
  if (engineModule) return engineModule;
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) throw new Error('Connect GitHub first so Safari can load the private RiftCity renderer.');
  const [mathSrc, geometrySrc, engineSrc] = await Promise.all([
    privateText(FILES.math, token),
    privateText(FILES.geometry, token),
    privateText(FILES.engine, token)
  ]);
  const mathUrl = blob(mathSrc);
  const geometryUrl = blob(geometrySrc);
  let source = swap(engineSrc, './rift-engine-math.js', mathUrl);
  source = swap(source, './rift-engine-geometry.js', geometryUrl);
  const engineUrl = blob(source);
  engineModule = await import(engineUrl);
  return engineModule;
}

function roofMassIds(program) {
  return new Set((program?.building?.masses || []).filter(m => (m.tags || []).includes('roof')).map(m => String(m.id || '')));
}

function opInMass(group, massIds) {
  for (const id of massIds) if (id && group.startsWith(`${id}.`)) return true;
  return false;
}

function renderableOps(document, mode, program) {
  const roofIds = roofMassIds(program);
  return (document?.ops || [])
    .filter(op => op?.op === 'fill_box')
    .filter(op => {
      const role = String(op._semanticRole || '');
      const group = String(op._semanticGroup || '');
      const roofMass = opInMass(group, roofIds);
      const roofSurface = role === 'roof';
      if (mode !== 'exterior' && (roofSurface || roofMass)) return false;
      if (mode === 'interior') {
        if (role === 'window') return false;
        if (group.endsWith('.facade')) return false;
      }
      return true;
    });
}

function boundsFor(ops) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const op of ops) {
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], Number(op.min?.[i] ?? 0));
      max[i] = Math.max(max[i], Number(op.max?.[i] ?? 0));
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [1, 1, 1] };
  return { min, max };
}

function colorFor(document, state) {
  const c = document?.palette?.[state]?.color;
  return Array.isArray(c) && c.length >= 3 ? c.slice(0, 3) : [.72, .75, .78];
}

function configureCamera(view, b) {
  const { RiftCamera } = engineModule;
  const min = b.min;
  const max = b.max;
  const width = max[0] - min[0] + 1;
  const height = max[1] - min[1] + 1;
  const depth = max[2] - min[2] + 1;
  const span = Math.max(width, depth, height * 1.4);
  const center = [(min[0] + max[0] + 1) / 2, (min[1] + max[1] + 1) / 2, (min[2] + max[2] + 1) / 2];
  const side = ['north', 'south', 'east', 'west'].includes(view);
  const c = new RiftCamera({
    projection: (side || view === 'top') ? 'orthographic' : 'perspective',
    alpha: -3 * Math.PI / 4,
    beta: .72,
    radius: Math.max(24, span * 1.7),
    minRadius: 4,
    maxRadius: 800,
    orthoSize: Math.max(18, span * 1.18),
    minOrthoSize: 8,
    maxOrthoSize: 800,
    fov: Math.PI / 3.15,
    near: .03,
    far: 1400,
    minBeta: .02,
    maxBeta: 1.56
  });
  if (view === 'top') {
    c.alpha = -Math.PI / 2;
    c.beta = .025;
  } else if (view === 'south') {
    c.alpha = Math.PI / 2;
    c.beta = Math.PI / 2;
  } else if (view === 'north') {
    c.alpha = -Math.PI / 2;
    c.beta = Math.PI / 2;
  } else if (view === 'east') {
    c.alpha = 0;
    c.beta = Math.PI / 2;
  } else if (view === 'west') {
    c.alpha = Math.PI;
    c.beta = Math.PI / 2;
  } else if (view === 'iso-ne') {
    c.alpha = -Math.PI / 4;
    c.beta = .72;
  }
  c.setTarget(...center);
  c.updatePosition();
  return c;
}

function populateEngine(targetEngine, ops, document, b) {
  for (const op of ops) {
    const min = op.min;
    const max = op.max;
    const scale = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
    const position = [(min[0] + max[0] + 1) / 2, (min[1] + max[1] + 1) / 2, (min[2] + max[2] + 1) / 2];
    targetEngine.addBox({
      position,
      scale,
      color: colorFor(document, op.state),
      noise: 0,
      blockGrid: .16,
      blockFaceShade: 1,
      blockElevationCue: .006,
      blockElevationBase: b.min[1]
    });
  }
}

function draw() {
  if (!engine || !camera) return;
  engine.resize(Math.min(Math.max(1, devicePixelRatio || 1), 1.6));
  engine.render(camera);
}

async function rebuild() {
  if (!current?.artifact?.document) return;
  const status = $('#inspect-status');
  status.textContent = 'Rendering…';
  status.className = 'status busy';
  await loadEngine();
  engine?.dispose?.();
  const canvas = $('#inspect-canvas');
  const document = current.artifact.document;
  const mode = $('#inspect-mode').value;
  const view = $('#inspect-view').value;
  const all = (document?.ops || []).filter(op => op?.op === 'fill_box');
  const ops = renderableOps(document, mode, current.program);
  const b = boundsFor(ops);
  engine = new engineModule.RiftEngine(canvas, {
    antialias: true,
    clearColor: [.035, .045, .055],
    fogColor: [.035, .045, .055],
    fogStart: 180,
    fogEnd: 800
  });
  populateEngine(engine, ops, document, b);
  camera = configureCamera(view, b);
  draw();
  $('#inspect-title').textContent = current.id;
  $('#inspect-subtitle').textContent = `${mode} · ${view} · ${ops.length} boxes · ${all.length - ops.length} hidden · ${current.publicResult?.stats?.structuralCells ?? '—'} structural cells`;
  status.textContent = 'Visual ready';
  status.className = 'status pass';
}

async function refreshCandidates() {
  const rows = (await listLocal('candidates')).filter(r => r.publicResult?.ok && r.artifact?.document);
  const select = $('#inspect-candidate');
  const previous = select.value;
  select.innerHTML = rows.length ? rows.map(r => `<option value="${r.id}">${r.id}${r.publicResult?.visual_pack?.status === 'queued-local' ? ' · visuals queued' : ''}</option>`).join('') : '<option value="">No local PASS candidates</option>';
  if (previous && rows.some(r => r.id === previous)) select.value = previous;
  $('#inspect-open').disabled = !rows.length;
  $('#inspect-capture').disabled = !rows.length;
  return rows;
}

async function selectedCandidate() {
  const rows = (await listLocal('candidates')).filter(r => r.publicResult?.ok && r.artifact?.document);
  const id = $('#inspect-candidate').value;
  return rows.find(r => r.id === id) || rows[0] || null;
}

async function openSelected() {
  current = await selectedCandidate();
  if (!current) throw new Error('No local PASS candidate is available.');
  $('#inspect-dialog').showModal();
  $('#inspect-approval').textContent = current.publicResult?.visual_inspection?.status || 'Not approved';
  await rebuild();
}

function createSizedCanvas(width, height) {
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;pointer-events:none;opacity:0;`;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  holder.append(canvas);
  document.body.append(holder);
  return { holder, canvas };
}

function readRenderedJpeg(sourceEngine, width, height) {
  const gl = sourceEngine.gl;
  gl.finish();
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const flipped = new Uint8ClampedArray(pixels.length);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y += 1) {
    const sourceStart = (height - 1 - y) * rowBytes;
    flipped.set(pixels.subarray(sourceStart, sourceStart + rowBytes), y * rowBytes);
  }
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d', { alpha: false });
  ctx.putImageData(new ImageData(flipped, width, height), 0, 0);
  const url = out.toDataURL('image/jpeg', .9);
  const comma = url.indexOf(',');
  if (comma < 0) throw new Error('Safari could not encode the visual capture.');
  return url.slice(comma + 1);
}

async function captureFrame(row, spec) {
  await loadEngine();
  const { holder, canvas } = createSizedCanvas(CAPTURE_W, CAPTURE_H);
  let captureEngine = null;
  try {
    const document = row.artifact.document;
    const ops = renderableOps(document, spec.mode, row.program);
    const b = boundsFor(ops);
    captureEngine = new engineModule.RiftEngine(canvas, {
      antialias: true,
      clearColor: [.035, .045, .055],
      fogColor: [.035, .045, .055],
      fogStart: 180,
      fogEnd: 800
    });
    populateEngine(captureEngine, ops, document, b);
    const captureCamera = configureCamera(spec.view, b);
    const size = captureEngine.resize(1);
    captureEngine.render(captureCamera);
    const base64 = readRenderedJpeg(captureEngine, size.width, size.height);
    return {
      ...spec,
      width: size.width,
      height: size.height,
      mime: 'image/jpeg',
      bytes: Math.floor(base64.length * 3 / 4),
      base64
    };
  } finally {
    captureEngine?.dispose?.();
    holder.remove();
  }
}

function utf8Base64(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function repoApi(client, suffix) {
  return `/repos/${encodeURIComponent(client.config.owner)}/${encodeURIComponent(client.config.repo)}${suffix}`;
}

async function createGitBlob(client, content, encoding = 'base64') {
  return client.api(repoApi(client, '/git/blobs'), { method: 'POST', body: { content, encoding } });
}

async function currentQueueHead(client) {
  const ref = await client.api(repoApi(client, `/git/ref/heads/${encodeURIComponent(QUEUE_BRANCH)}`));
  const commitSha = ref?.object?.sha;
  if (!commitSha) throw new Error(`Could not resolve ${QUEUE_BRANCH} head.`);
  const commit = await client.api(repoApi(client, `/git/commits/${commitSha}`));
  if (!commit?.tree?.sha) throw new Error(`Could not resolve ${QUEUE_BRANCH} tree.`);
  return { commitSha, treeSha: commit.tree.sha };
}

async function commitQueuedFiles(client, files, message) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const head = await currentQueueHead(client);
    const tree = await client.api(repoApi(client, '/git/trees'), {
      method: 'POST',
      body: {
        base_tree: head.treeSha,
        tree: files.map(file => ({ path: file.path, mode: '100644', type: 'blob', sha: file.sha }))
      }
    });
    const commit = await client.api(repoApi(client, '/git/commits'), {
      method: 'POST',
      body: { message, tree: tree.sha, parents: [head.commitSha] }
    });
    try {
      await client.api(repoApi(client, `/git/refs/heads/${encodeURIComponent(QUEUE_BRANCH)}`), {
        method: 'PATCH',
        body: { sha: commit.sha, force: false }
      });
      return commit;
    } catch (e) {
      lastError = e;
      if (![409, 422].includes(Number(e?.status))) throw e;
    }
  }
  throw lastError || new Error('Could not advance the visual queue branch.');
}

async function queueVisualPack(row) {
  if (!row?.publicResult?.ok || !row?.artifact?.document) throw new Error('Only a local PASS candidate with compiled geometry can be captured.');
  if (captureLocks.has(row.id)) return null;
  const client = new RiftGitHubClient();
  if (!client.connected) throw new Error('Connect GitHub first so the visual pack can be queued privately.');
  captureLocks.add(row.id);
  const status = $('#inspect-status');
  const candidateHash = row.publicResult?.candidate_sha256 || 'nohash';
  const captureId = `${Date.now()}-${safe(candidateHash.slice(0, 12))}`;
  const root = `${VISUALS_DIR}/${safe(row.id)}/${captureId}`;
  try {
    const captures = [];
    for (let i = 0; i < STANDARD_CAPTURES.length; i += 1) {
      const spec = STANDARD_CAPTURES[i];
      status.textContent = `Capturing ${i + 1}/${STANDARD_CAPTURES.length}…`;
      status.className = 'status busy';
      captures.push(await captureFrame(row, spec));
    }

    status.textContent = 'Uploading visual pack…';
    const files = [];
    const captureMeta = [];
    for (const capture of captures) {
      const path = `${root}/${capture.id}.jpg`;
      const created = await createGitBlob(client, capture.base64, 'base64');
      files.push({ path, sha: created.sha });
      captureMeta.push({
        id: capture.id,
        label: capture.label,
        mode: capture.mode,
        view: capture.view,
        path,
        width: capture.width,
        height: capture.height,
        mime: capture.mime,
        bytes: capture.bytes,
        git_blob_sha: created.sha
      });
    }

    const manifestPath = `${root}/manifest.json`;
    const manifest = {
      format: 'riftcity-local-visual-pack',
      version: 1,
      job_id: row.id,
      capture_id: captureId,
      captured_at: Date.now(),
      queue_branch: QUEUE_BRANCH,
      renderer: 'RiftEngine WebGL2',
      source_program_id: row.publicResult?.source_program_id || row.program?.id || null,
      candidate_sha256: row.publicResult?.candidate_sha256 || null,
      compiled_document_sha256: row.publicResult?.compiled_document_sha256 || null,
      target: row.publicResult?.target || null,
      result_summary: {
        ok: true,
        stats: row.publicResult?.stats || null
      },
      captures: captureMeta
    };
    const manifestBlob = await createGitBlob(client, utf8Base64(`${JSON.stringify(manifest, null, 2)}\n`), 'base64');
    files.push({ path: manifestPath, sha: manifestBlob.sha });

    const latestPath = `${VISUALS_DIR}/latest.json`;
    const latest = {
      format: 'riftcity-local-visual-latest',
      version: 1,
      job_id: row.id,
      capture_id: captureId,
      manifest_path: manifestPath,
      manifest_blob_sha: manifestBlob.sha,
      candidate_sha256: row.publicResult?.candidate_sha256 || null,
      compiled_document_sha256: row.publicResult?.compiled_document_sha256 || null,
      updated_at: Date.now()
    };
    const latestBlob = await createGitBlob(client, utf8Base64(`${JSON.stringify(latest, null, 2)}\n`), 'base64');
    files.push({ path: latestPath, sha: latestBlob.sha });

    const commit = await commitQueuedFiles(client, files, `Rift Local visual pack: ${row.id}`);
    const visualPack = {
      status: 'queued-local',
      capture_id: captureId,
      manifest_path: manifestPath,
      latest_path: latestPath,
      queue_branch: QUEUE_BRANCH,
      commit_sha: commit.sha,
      candidate_sha256: row.publicResult?.candidate_sha256 || null,
      compiled_document_sha256: row.publicResult?.compiled_document_sha256 || null,
      captures: captureMeta.map(({ id, path, mode, view }) => ({ id, path, mode, view }))
    };
    row.publicResult = { ...row.publicResult, visual_pack: visualPack };
    await putLocal('candidates', { ...row, savedAt: Date.now() });
    await putLocal('results', { id: row.id, publicResult: row.publicResult, savedAt: Date.now() });
    status.textContent = `${captureMeta.length} views queued`;
    status.className = 'status pass';
    await refreshCandidates();
    return visualPack;
  } finally {
    captureLocks.delete(row.id);
  }
}

async function captureSelected() {
  const row = await selectedCandidate();
  if (!row) throw new Error('No local PASS candidate is available.');
  return queueVisualPack(row);
}

async function autoQueueLatestManualPass() {
  const rows = (await listLocal('candidates')).filter(r => r.publicResult?.ok && r.artifact?.document);
  const row = rows[0];
  if (!row || !String(row.id).startsWith('manual-')) return;
  const existing = row.publicResult?.visual_pack;
  if (existing?.status === 'queued-local' && existing?.candidate_sha256 === row.publicResult?.candidate_sha256) return;
  await queueVisualPack(row);
}

async function approve() {
  if (!current) throw new Error('Open a candidate first.');
  const client = new RiftGitHubClient();
  if (!client.connected) throw new Error('Connect GitHub before approving visual inspection.');
  const approval = {
    status: 'approved-local',
    approved_at: Date.now(),
    renderer: 'RiftEngine WebGL2',
    mode: $('#inspect-mode').value,
    view: $('#inspect-view').value,
    candidate_sha256: current.publicResult?.candidate_sha256 || null,
    compiled_document_sha256: current.publicResult?.compiled_document_sha256 || null
  };
  const result = { ...current.publicResult, visual_inspection: approval };
  await client.writeJsonFile(client.resultPath(current.id), result, `Rift Local visual approval: ${current.id}`);
  current.publicResult = result;
  await putLocal('results', { id: current.id, publicResult: result, savedAt: Date.now() });
  $('#inspect-approval').textContent = 'VISUAL APPROVED';
  $('#inspect-approval').className = 'status pass';
}

function attachGestures() {
  const canvas = $('#inspect-canvas');
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    lastPoint = [e.clientX, e.clientY];
  });
  canvas.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId) || !camera) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    const pts = [...pointers.values()];
    if (pts.length >= 2) {
      const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
      if (lastPinch != null) camera.zoom((lastPinch - d) * .055);
      lastPinch = d;
    } else if (lastPoint) {
      const dx = e.clientX - lastPoint[0];
      const dy = e.clientY - lastPoint[1];
      camera.orbit(-dx * .008, dy * .006);
      lastPoint = [e.clientX, e.clientY];
    }
    draw();
  });
  const end = e => {
    pointers.delete(e.pointerId);
    lastPoint = null;
    if (pointers.size < 2) lastPinch = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    camera?.zoom(e.deltaY * .03);
    draw();
  }, { passive: false });
}

function watchManualPasses() {
  const resultStatus = $('#result-status');
  if (!resultStatus) return;
  let timer = null;
  const observer = new MutationObserver(() => {
    if (resultStatus.textContent.trim() !== 'PASS') return;
    clearTimeout(timer);
    timer = setTimeout(() => autoQueueLatestManualPass().catch(e => {
      const status = $('#inspect-status');
      status.textContent = 'Visual queue failed';
      status.className = 'status fail';
      console.error('[Rift Local Visual Queue]', e);
    }), 700);
  });
  observer.observe(resultStatus, { childList: true, characterData: true, subtree: true });
}

async function boot() {
  injectUi();
  await refreshCandidates();
  $('#inspect-open').onclick = () => openSelected().catch(e => alert(e.message));
  $('#inspect-close').onclick = () => $('#inspect-dialog').close();
  $('#inspect-mode').onchange = () => rebuild().catch(e => alert(e.message));
  $('#inspect-view').onchange = () => rebuild().catch(e => alert(e.message));
  $('#inspect-reset').onclick = () => rebuild().catch(e => alert(e.message));
  $('#inspect-approve').onclick = () => approve().catch(e => alert(e.message));
  $('#inspect-capture').onclick = () => captureSelected().catch(e => alert(e.message));
  $('#inspect-capture-open').onclick = () => captureSelected().catch(e => alert(e.message));
  $('#refresh-history')?.addEventListener('click', () => setTimeout(refreshCandidates, 120));
  $('#sync-jobs')?.addEventListener('click', () => setTimeout(refreshCandidates, 1200));
  $('#run-build')?.addEventListener('click', () => setTimeout(refreshCandidates, 1000));
  window.addEventListener('resize', draw);
  attachGestures();
  watchManualPasses();
}

boot().catch(e => console.error('[Rift Local Inspector]', e));
