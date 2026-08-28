import { listLocal, putLocal } from './storage.js';
import { RiftGitHubClient } from './github.js';

const VISUALS_DIR = 'rift-local-autonomous';
const STANDARD_VISUALS_DIR = 'rift-local-visuals';
const CAPTURE_W = 720;
const CAPTURE_H = 540;
const MAX_SHOTS = 36;
const OPTIONAL_TARGET_RATIO = 0.97;
const AUTO_KEY = 'rift-local-builder.autonomous-visual-auto';
const ENGINE_FILES = {
  engine: 'public/rift-engine.js',
  math: 'public/rift-engine-math.js',
  geometry: 'public/rift-engine-geometry.js'
};
const $ = selector => document.querySelector(selector);
const safe = value => String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
const key = (x, y, z) => `${x}|${y}|${z}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let engineModule = null;
let running = false;
let autoTimer = null;

function injectUi() {
  const main = $('main');
  if (!main || $('#autonomous-visual-card')) return;
  const card = document.createElement('section');
  card.id = 'autonomous-visual-card';
  card.className = 'card';
  card.innerHTML = `<div class="section-title"><div><div class="eyebrow">AUTONOMOUS VISUAL QA</div><h2>Coverage-driven building inspection</h2></div><span id="autonomous-visual-status" class="status neutral">Ready</span></div><p class="hint">After the normal visual pack finishes, the phone plans an inspection route through semantic rooms, both sides of portals, entrances, stairs/cores, exterior facades, roof geometry and site features. It ray-checks visibility against the compiled voxel document, keeps only useful views, then queues JPEGs + AI-readable copies + a coverage manifest.</p><label class="toggle"><input id="autonomous-visual-auto" type="checkbox"> Run automatically after every local PASS visual pack</label><div class="actions"><button id="autonomous-visual-run">Run autonomous inspection</button></div><div id="autonomous-visual-summary" class="hint">No autonomous inspection yet.</div>`;
  const device = [...main.children].find(el => el.querySelector?.('#history'));
  main.insertBefore(card, device || null);
  const toggle = $('#autonomous-visual-auto');
  const stored = localStorage.getItem(AUTO_KEY);
  toggle.checked = stored == null ? true : stored === '1';
  toggle.onchange = () => localStorage.setItem(AUTO_KEY, toggle.checked ? '1' : '0');
  $('#autonomous-visual-run').onclick = () => runLatest(true).catch(showError);
}

function setStatus(text, kind = 'neutral') {
  const el = $('#autonomous-visual-status');
  if (!el) return;
  el.textContent = text;
  el.className = `status ${kind}`;
}
function setSummary(text) {
  const el = $('#autonomous-visual-summary');
  if (el) el.textContent = text;
}
function showError(error) {
  console.error('[Rift Autonomous Visual]', error);
  setStatus('Inspection failed', 'fail');
  setSummary(error?.message || String(error));
}

function b64ToText(value) {
  const binary = atob(String(value || '').replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function wrap64(value) {
  return (String(value).match(/.{1,76}/g) || []).join('\n') + '\n';
}
function repoApi(client, suffix) {
  return `/repos/${encodeURIComponent(client.config.owner)}/${encodeURIComponent(client.config.repo)}${suffix}`;
}
function contentPath(client, path) {
  return repoApi(client, `/contents/${String(path).split('/').map(encodeURIComponent).join('/')}`);
}
async function privateSource(client, path) {
  const row = await client.api(`${contentPath(client, path)}?ref=${encodeURIComponent(client.config.sourceBranch)}`);
  if (!row?.content) throw new Error(`AI branch did not return '${path}'.`);
  return b64ToText(row.content);
}
const moduleBlob = source => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
function swapImport(source, specifier, url) {
  return source.replaceAll(`'${specifier}'`, `'${url}'`).replaceAll(`"${specifier}"`, `"${url}"`);
}
async function loadEngine(client) {
  if (engineModule) return engineModule;
  const [mathSource, geometrySource, engineSource] = await Promise.all([
    privateSource(client, ENGINE_FILES.math),
    privateSource(client, ENGINE_FILES.geometry),
    privateSource(client, ENGINE_FILES.engine)
  ]);
  const mathUrl = moduleBlob(mathSource);
  const geometryUrl = moduleBlob(geometrySource);
  let source = swapImport(engineSource, './rift-engine-math.js', mathUrl);
  source = swapImport(source, './rift-engine-geometry.js', geometryUrl);
  engineModule = await import(moduleBlob(source));
  return engineModule;
}

function paletteSolid(document, state) {
  const raw = document?.palette?.[state] || {};
  const shape = String(raw.shape || 'full').toLowerCase();
  const kind = String(raw.kind || '').toLowerCase();
  return Number(raw.material_id) !== 0 && !['air', 'grass_detail', 'grass', 'water'].includes(shape) && !['detail', 'fluid'].includes(kind);
}
function applyBox(op, visit) {
  for (let y = op.min[1]; y <= op.max[1]; y += 1) {
    for (let z = op.min[2]; z <= op.max[2]; z += 1) {
      for (let x = op.min[0]; x <= op.max[0]; x += 1) visit(x, y, z);
    }
  }
}
function replayCells(document) {
  const cells = new Set();
  for (const op of document?.ops || []) {
    const type = String(op?.op || '').toLowerCase();
    if (type === 'set' && op.at) {
      const k = key(...op.at);
      if (paletteSolid(document, op.state)) cells.add(k); else cells.delete(k);
      continue;
    }
    if (!op?.min || !op?.max) continue;
    if (type === 'fill_box') applyBox(op, (x, y, z) => paletteSolid(document, op.state) ? cells.add(key(x, y, z)) : cells.delete(key(x, y, z)));
    else if (type === 'cut_box') applyBox(op, (x, y, z) => cells.delete(key(x, y, z)));
    else if (type === 'hollow_box') applyBox(op, (x, y, z) => {
      const edge = x === op.min[0] || x === op.max[0] || y === op.min[1] || y === op.max[1] || z === op.min[2] || z === op.max[2];
      const k = key(x, y, z);
      if (edge && paletteSolid(document, op.state)) cells.add(k); else if (!edge) cells.delete(k);
    });
  }
  return cells;
}
const cellAt = point => [Math.floor(point[0]), Math.floor(point[1]), Math.floor(point[2])];
function occupied(cells, point) { return cells.has(key(...cellAt(point))); }
function distance(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function normalize(v) { const d = Math.hypot(...v) || 1; return v.map(n => n / d); }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function subtract(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b, scale = 1) { return [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale]; }
function clearRay(cells, from, to) {
  const d = distance(from, to);
  if (d < 0.25) return true;
  const steps = Math.max(2, Math.ceil(d * 2.2));
  const end = Math.max(1, steps - Math.ceil(0.8 * steps / d));
  for (let i = 1; i < end; i += 1) {
    const t = i / steps;
    const p = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
    if (occupied(cells, p)) return false;
  }
  return true;
}

function floorFor(semantics, floor) {
  return (semantics?.floors || []).find(item => Number(item.floor) === Number(floor)) || null;
}
function spaceRect(space) {
  if (space?.local?.min && space?.local?.max) return { min: [space.local.min[0], space.local.min[2]], max: [space.local.max[0], space.local.max[2]] };
  if (space?.min && space?.max) return { min: [space.min[0], space.min[1]], max: [space.max[0], space.max[1]] };
  return null;
}
function point3(raw, yFallback = 1.5) {
  if (!Array.isArray(raw)) return null;
  if (raw.length >= 3) return [Number(raw[0]) + .5, Number(raw[1]) + .5, Number(raw[2]) + .5];
  if (raw.length === 2) return [Number(raw[0]) + .5, yFallback, Number(raw[1]) + .5];
  return null;
}
function facingNormal(side) {
  return ({ north: [0, 0, -1], east: [1, 0, 0], south: [0, 0, 1], west: [-1, 0, 0] })[String(side || '').toLowerCase()] || null;
}
function findFree(cells, desired, rect = null) {
  const offsets = [[0,0],[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1],[2,0],[-2,0],[0,2],[0,-2]];
  for (const [dx, dz] of offsets) {
    const p = [desired[0] + dx, desired[1], desired[2] + dz];
    if (rect && (p[0] < rect.min[0] + .25 || p[0] > rect.max[0] + .75 || p[2] < rect.min[1] + .25 || p[2] > rect.max[1] + .75)) continue;
    if (!occupied(cells, p) && !occupied(cells, [p[0], p[1] + .8, p[2]])) return p;
  }
  return desired;
}

function target(id, category, point, critical, extra = {}) {
  return { id, category, point, critical: !!critical, ...extra };
}
function candidate(id, label, kind, position, lookAt, extra = {}) {
  return { id, label, kind, position, lookAt, fov: extra.fov || (kind.startsWith('interior') ? Math.PI * .56 : Math.PI * .42), ...extra };
}

function semanticTargetsAndViews(row, cells) {
  const semantics = row.artifact?.semantics || {};
  const interior = semantics.interior || {};
  const targets = [];
  const candidates = [];
  const spaces = interior.spaces || [];
  const roomOrder = new Map(spaces.map((space, index) => [space.id, index]));

  for (const space of spaces) {
    const rect = spaceRect(space); if (!rect) continue;
    const floorMeta = floorFor(semantics, space.floor);
    const floorY = Number(floorMeta?.localY || 0);
    const eyeY = floorY + clamp(Number(space.clearHeight || space.clear_height || 4) * .34, 1.35, 1.8);
    const cx = (rect.min[0] + rect.max[0] + 1) / 2;
    const cz = (rect.min[1] + rect.max[1] + 1) / 2;
    const inset = Math.max(.8, Math.min(1.5, (Math.min(rect.max[0] - rect.min[0] + 1, rect.max[1] - rect.min[1] + 1) - 1) * .2));
    const samples = [
      [cx, eyeY, cz],
      [rect.min[0] + inset, eyeY, rect.min[1] + inset],
      [rect.max[0] + 1 - inset, eyeY, rect.min[1] + inset],
      [rect.min[0] + inset, eyeY, rect.max[1] + 1 - inset],
      [rect.max[0] + 1 - inset, eyeY, rect.max[1] + 1 - inset]
    ];
    samples.forEach((p, i) => targets.push(target(`space:${space.id}:${i}`, 'space', p, true, { spaceId: space.id })));
    const corners = samples.slice(1).map(p => findFree(cells, p, rect));
    corners.forEach((p, i) => candidates.push(candidate(`room-${safe(space.id)}-${i + 1}`, `${space.name || space.id} · room view ${i + 1}`, 'interior-room', p, [cx, eyeY, cz], { spaceId: space.id, routeOrder: roomOrder.get(space.id) || 0 })));
  }

  for (const portal of interior.portals || []) {
    const floorMeta = floorFor(semantics, portal.floor);
    const y = Number(floorMeta?.localY || 0) + 1.5;
    const at = point3(portal.local || portal.at, y); if (!at) continue;
    at[1] = y;
    const baseNormal = String(portal.axis || '').toLowerCase() === 'z' ? [1, 0, 0] : [0, 0, 1];
    for (const sign of [-1, 1]) {
      const normal = baseNormal.map(v => v * sign);
      targets.push(target(`portal:${portal.id}:${sign}`, 'portal-side', at, true, { normal, portalId: portal.id }));
      const desired = add(at, normal, 2.6);
      const pos = findFree(cells, desired);
      candidates.push(candidate(`portal-${safe(portal.id)}-${sign < 0 ? 'a' : 'b'}`, `${portal.id} · ${sign < 0 ? 'side A' : 'side B'}`, 'interior-portal', pos, at, { portalId: portal.id }));
    }
  }

  const entranceAnchors = (semantics.anchors || []).filter(a => String(a.kind || '').toLowerCase() === 'entrance');
  for (const entrance of entranceAnchors) {
    const at = point3(entrance.local || entrance.at); if (!at) continue;
    const normal = facingNormal(entrance.facing) || [0, 0, 1];
    targets.push(target(`entrance:${entrance.id}:outside`, 'entrance-side', at, true, { normal, entranceId: entrance.id }));
    targets.push(target(`entrance:${entrance.id}:inside`, 'entrance-side', at, true, { normal: normal.map(v => -v), entranceId: entrance.id }));
    candidates.push(candidate(`entrance-${safe(entrance.id)}-outside`, `${entrance.id} · outside`, 'exterior-entrance', add(at, normal, 4), at, { entranceId: entrance.id }));
    candidates.push(candidate(`entrance-${safe(entrance.id)}-inside`, `${entrance.id} · inside`, 'interior-entrance', findFree(cells, add(at, normal, -3)), at, { entranceId: entrance.id }));
  }

  for (const core of interior.verticalCores || []) {
    const raw = core.local || core.at || core.openingCellsLocal?.[0];
    const p = point3(raw); if (!p) continue;
    const from = floorFor(semantics, core.fromFloor)?.localY ?? p[1];
    const to = floorFor(semantics, core.toFloor)?.localY ?? (from + Number(core.steps || 4));
    const points = [[p[0], Number(from) + 1.5, p[2]], [p[0], (Number(from) + Number(to)) / 2 + 1, p[2]], [p[0], Number(to) + 1.5, p[2]]];
    points.forEach((q, i) => targets.push(target(`core:${core.id}:${i}`, 'vertical-core', q, true, { coreId: core.id })));
    points.forEach((q, i) => candidates.push(candidate(`core-${safe(core.id)}-${i + 1}`, `${core.id} · ${['bottom','middle','top'][i]}`, 'interior-core', findFree(cells, [q[0] + 3, q[1], q[2] + (i === 1 ? 2 : 0)]), q, { coreId: core.id })));
  }

  for (const anchor of (semantics.anchors || []).filter(a => String(a.kind || '').toLowerCase() !== 'entrance')) {
    const p = point3(anchor.local || anchor.at); if (!p) continue;
    targets.push(target(`anchor:${anchor.id}`, 'anchor', p, true, { anchorId: anchor.id }));
    candidates.push(candidate(`anchor-${safe(anchor.id)}`, `${anchor.id} · semantic focus`, 'interior-anchor', findFree(cells, [p[0] + 3, p[1], p[2] + 2]), p, { anchorId: anchor.id }));
  }

  const ops = (row.artifact?.document?.ops || []).filter(op => op?.op === 'fill_box');
  const bounds = row.artifact.document.bounds;
  const center = [(bounds.min[0] + bounds.max[0] + 1) / 2, (bounds.min[1] + bounds.max[1] + 1) / 2, (bounds.min[2] + bounds.max[2] + 1) / 2];
  for (const [index, op] of ops.entries()) {
    const role = String(op._semanticRole || '');
    const group = String(op._semanticGroup || '');
    const p = [(op.min[0] + op.max[0] + 1) / 2, (op.min[1] + op.max[1] + 1) / 2, (op.min[2] + op.max[2] + 1) / 2];
    if (group.endsWith('.facade') || role === 'wall') {
      const sx = op.max[0] - op.min[0] + 1, sz = op.max[2] - op.min[2] + 1;
      let normal;
      if (sx <= sz) normal = [p[0] >= center[0] ? 1 : -1, 0, 0];
      else normal = [0, 0, p[2] >= center[2] ? 1 : -1];
      targets.push(target(`facade:${index}`, 'facade', p, false, { normal }));
    } else if (role === 'roof' || group.endsWith('.roof')) {
      targets.push(target(`roof:${index}`, 'roof', p, false, { normal: [0, 1, 0] }));
    } else if (role === 'site') {
      targets.push(target(`site:${index}`, 'site', p, false));
    }
  }

  const width = bounds.max[0] - bounds.min[0] + 1;
  const height = bounds.max[1] - bounds.min[1] + 1;
  const depth = bounds.max[2] - bounds.min[2] + 1;
  const span = Math.max(width, depth);
  const exteriorTarget = [center[0], bounds.min[1] + Math.max(2, height * .38), center[2]];
  const exteriorRadius = span * .82 + 10;
  for (let i = 0; i < 16; i += 1) {
    const angle = -Math.PI + i * Math.PI * 2 / 16;
    const pos = [center[0] + Math.cos(angle) * exteriorRadius, bounds.min[1] + Math.max(3, height * .55), center[2] + Math.sin(angle) * exteriorRadius];
    candidates.push(candidate(`exterior-${String(i + 1).padStart(2, '0')}`, `Exterior perimeter ${i + 1}/16`, 'exterior-perimeter', pos, exteriorTarget, { angle, routeAngle: angle }));
  }
  const roofRadius = span * .72 + 6;
  const roofTarget = [center[0], bounds.max[1] - Math.max(0, height * .08), center[2]];
  for (let i = 0; i < 8; i += 1) {
    const angle = -Math.PI + i * Math.PI * 2 / 8;
    const pos = [center[0] + Math.cos(angle) * roofRadius, bounds.max[1] + Math.max(8, span * .48), center[2] + Math.sin(angle) * roofRadius];
    candidates.push(candidate(`roof-oblique-${i + 1}`, `Roof oblique ${i + 1}/8`, 'roof-oblique', pos, roofTarget, { angle, routeAngle: angle }));
  }
  candidates.push(candidate('roof-top', 'Roof top-down', 'roof-top', [center[0], bounds.max[1] + Math.max(16, span * 1.05), center[2] + .01], roofTarget, { fov: Math.PI * .36, routeAngle: Math.PI * 2 }));

  return { targets, candidates };
}

function targetVisible(cells, view, item) {
  const to = subtract(item.point, view.position);
  const dist = Math.hypot(...to);
  if (dist < .25 || dist > 240) return false;
  const forward = normalize(subtract(view.lookAt, view.position));
  const toward = normalize(to);
  if (dot(forward, toward) < Math.cos((view.fov || Math.PI * .45) * .54)) return false;
  if (item.normal && dot(normalize(subtract(view.position, item.point)), normalize(item.normal)) <= .03) return false;
  return clearRay(cells, view.position, item.point);
}
function calculateCoverage(cells, targets, candidates) {
  const byId = new Map(targets.map(item => [item.id, item]));
  for (const view of candidates) {
    view.covers = targets.filter(item => targetVisible(cells, view, item)).map(item => item.id);
  }
  const covered = new Set();
  const selected = [];
  const allCritical = targets.filter(t => t.critical);
  const optional = targets.filter(t => !t.critical);
  const ratio = () => optional.length ? optional.filter(t => covered.has(t.id)).length / optional.length : 1;
  while (selected.length < MAX_SHOTS) {
    let best = null, bestScore = 0;
    for (const view of candidates) {
      if (selected.includes(view)) continue;
      let score = 0;
      for (const id of view.covers) {
        if (covered.has(id)) continue;
        score += byId.get(id)?.critical ? 80 : 1;
      }
      if (score > bestScore) { best = view; bestScore = score; }
    }
    if (!best || bestScore <= 0) break;
    selected.push(best);
    best.covers.forEach(id => covered.add(id));
    if (allCritical.every(t => covered.has(t.id)) && ratio() >= OPTIONAL_TARGET_RATIO) break;
  }
  const criticalCovered = allCritical.filter(t => covered.has(t.id)).length;
  const optionalCovered = optional.filter(t => covered.has(t.id)).length;
  const categories = {};
  for (const item of targets) {
    const row = categories[item.category] ||= { total: 0, covered: 0, critical: 0, criticalCovered: 0 };
    row.total += 1;
    if (item.critical) row.critical += 1;
    if (covered.has(item.id)) { row.covered += 1; if (item.critical) row.criticalCovered += 1; }
  }
  return {
    selected,
    covered,
    report: {
      ok: criticalCovered === allCritical.length && (optional.length ? optionalCovered / optional.length : 1) >= OPTIONAL_TARGET_RATIO,
      candidateViews: candidates.length,
      selectedViews: selected.length,
      targets: targets.length,
      criticalTargets: allCritical.length,
      criticalCovered,
      optionalTargets: optional.length,
      optionalCovered,
      optionalCoverageRatio: optional.length ? optionalCovered / optional.length : 1,
      requiredOptionalCoverageRatio: OPTIONAL_TARGET_RATIO,
      categories,
      uncoveredCritical: allCritical.filter(t => !covered.has(t.id)).map(t => t.id)
    }
  };
}

function orderRoute(selected) {
  const interior = selected.filter(v => v.kind.startsWith('interior'));
  const exterior = selected.filter(v => v.kind.startsWith('exterior')).sort((a, b) => (a.routeAngle || 0) - (b.routeAngle || 0));
  const roof = selected.filter(v => v.kind.startsWith('roof')).sort((a, b) => (a.routeAngle || 0) - (b.routeAngle || 0));
  const other = selected.filter(v => !interior.includes(v) && !exterior.includes(v) && !roof.includes(v));
  const walk = [];
  const remaining = [...interior];
  let current = remaining.find(v => v.kind === 'interior-entrance') || remaining[0];
  while (current) {
    walk.push(current);
    remaining.splice(remaining.indexOf(current), 1);
    current = remaining.reduce((best, item) => !best || distance(walk.at(-1).position, item.position) < distance(walk.at(-1).position, best.position) ? item : best, null);
  }
  return [...walk, ...other, ...exterior, ...roof];
}

function colorFor(document, state) {
  const c = document?.palette?.[state]?.color;
  return Array.isArray(c) && c.length >= 3 ? c.slice(0, 3) : [.72, .75, .78];
}
function populateEngine(engine, document) {
  const bounds = document.bounds;
  for (const op of (document.ops || []).filter(op => op?.op === 'fill_box')) {
    const min = op.min, max = op.max;
    engine.addBox({
      position: [(min[0] + max[0] + 1) / 2, (min[1] + max[1] + 1) / 2, (min[2] + max[2] + 1) / 2],
      scale: [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1],
      color: colorFor(document, op.state), noise: 0, blockGrid: .16, blockFaceShade: 1, blockElevationCue: .006, blockElevationBase: bounds.min[1]
    });
  }
}
function createCaptureSurface() {
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-10000px;top:0;width:${CAPTURE_W}px;height:${CAPTURE_H}px;pointer-events:none;opacity:0`;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  holder.append(canvas); document.body.append(holder);
  return { holder, canvas };
}
function cameraForView(view) {
  const { RiftCamera } = engineModule;
  const delta = subtract(view.position, view.lookAt);
  const radius = Math.max(.5, Math.hypot(...delta));
  const camera = new RiftCamera({ projection: 'perspective', fov: view.fov, near: .03, far: 1400, radius, minRadius: .25, maxRadius: 2000, minBeta: .001, maxBeta: Math.PI - .001 });
  camera.alpha = Math.atan2(delta[2], delta[0]);
  camera.beta = Math.acos(clamp(delta[1] / radius, -1, 1));
  camera.radius = radius;
  camera.setTarget(...view.lookAt);
  return camera;
}
function readJpeg(engine, width, height) {
  const gl = engine.gl; gl.finish();
  const pixels = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const flipped = new Uint8ClampedArray(pixels.length), row = width * 4;
  for (let y = 0; y < height; y += 1) flipped.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  const out = document.createElement('canvas'); out.width = width; out.height = height;
  out.getContext('2d', { alpha: false }).putImageData(new ImageData(flipped, width, height), 0, 0);
  const url = out.toDataURL('image/jpeg', .9); return url.slice(url.indexOf(',') + 1);
}
async function renderRoute(client, row, route) {
  await loadEngine(client);
  const { holder, canvas } = createCaptureSurface();
  const engine = new engineModule.RiftEngine(canvas, { antialias: true, clearColor: [.035, .045, .055], fogColor: [.035, .045, .055], fogStart: 180, fogEnd: 800 });
  try {
    populateEngine(engine, row.artifact.document);
    const captures = [];
    for (let i = 0; i < route.length; i += 1) {
      const view = route[i]; setStatus(`Inspecting ${i + 1}/${route.length}…`, 'busy');
      const size = engine.resize(1); engine.render(cameraForView(view));
      captures.push({ id: `shot-${String(i + 1).padStart(2, '0')}-${safe(view.id)}`, label: view.label, kind: view.kind, position: view.position, lookAt: view.lookAt, width: size.width, height: size.height, base64: readJpeg(engine, size.width, size.height), covers: view.covers });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return captures;
  } finally { engine.dispose(); holder.remove(); }
}

async function gitBlob(client, content, encoding = 'utf-8') {
  return client.api(repoApi(client, '/git/blobs'), { method: 'POST', body: { content, encoding } });
}
async function queueHead(client) {
  const ref = await client.api(repoApi(client, `/git/ref/heads/${encodeURIComponent(client.config.queueBranch)}`));
  const commit = await client.api(repoApi(client, `/git/commits/${ref?.object?.sha}`));
  if (!ref?.object?.sha || !commit?.tree?.sha) throw new Error('Could not resolve rift-local-queue head.');
  return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
}
async function commitFiles(client, files, message) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const head = await queueHead(client);
    const tree = await client.api(repoApi(client, '/git/trees'), { method: 'POST', body: { base_tree: head.treeSha, tree: files.map(f => ({ path: f.path, mode: '100644', type: 'blob', sha: f.sha })) } });
    const commit = await client.api(repoApi(client, '/git/commits'), { method: 'POST', body: { message, tree: tree.sha, parents: [head.commitSha] } });
    try {
      await client.api(repoApi(client, `/git/refs/heads/${encodeURIComponent(client.config.queueBranch)}`), { method: 'PATCH', body: { sha: commit.sha, force: false } });
      return commit;
    } catch (error) {
      lastError = error;
      if (![409, 422].includes(Number(error?.status))) throw error;
      await new Promise(resolve => setTimeout(resolve, 350 + attempt * 250));
    }
  }
  throw lastError || new Error('Could not advance autonomous visual queue.');
}

function sameIdentity(latest, readable, row) {
  const visual = row.publicResult?.visual_pack;
  return Boolean(latest && readable && visual && latest.job_id === row.id && readable.job_id === row.id && latest.capture_id === visual.capture_id && readable.capture_id === visual.capture_id && latest.candidate_sha256 === row.publicResult?.candidate_sha256 && readable.candidate_sha256 === row.publicResult?.candidate_sha256 && latest.compiled_document_sha256 === row.publicResult?.compiled_document_sha256 && readable.compiled_document_sha256 === row.publicResult?.compiled_document_sha256);
}
async function standardVisualsReady(client, row) {
  try {
    const [latest, readable] = await Promise.all([client.readQueueJson(`${STANDARD_VISUALS_DIR}/latest.json`), client.readQueueJson(`${STANDARD_VISUALS_DIR}/latest-readable.json`)]);
    return sameIdentity(latest.json, readable.json, row);
  } catch { return false; }
}

async function queueAutonomousPack(client, row, coverage, captures) {
  const visualCapture = row.publicResult.visual_pack.capture_id;
  const inspectionId = `${visualCapture}-coverage-v1`;
  const root = `${VISUALS_DIR}/${safe(row.id)}/${safe(inspectionId)}`;
  const files = [], captureMeta = [];
  setStatus('Queueing inspection pack…', 'busy');
  for (const shot of captures) {
    const jpgPath = `${root}/${shot.id}.jpg`, readablePath = `${jpgPath}.b64.txt`;
    const [jpg, readable] = await Promise.all([gitBlob(client, shot.base64, 'base64'), gitBlob(client, wrap64(shot.base64), 'utf-8')]);
    files.push({ path: jpgPath, sha: jpg.sha }, { path: readablePath, sha: readable.sha });
    captureMeta.push({ id: shot.id, label: shot.label, kind: shot.kind, path: jpgPath, readable_path: readablePath, width: shot.width, height: shot.height, position: shot.position, look_at: shot.lookAt, covers: shot.covers });
  }
  const manifest = {
    format: 'riftcity-autonomous-visual-inspection', version: 1, planner: 'coverage-driven-voxel-los-v1', job_id: row.id, inspection_id: inspectionId,
    source_branch: client.config.sourceBranch, queue_branch: client.config.queueBranch, candidate_sha256: row.publicResult.candidate_sha256, compiled_document_sha256: row.publicResult.compiled_document_sha256,
    standard_visual_capture_id: visualCapture, generated_at: Date.now(), coverage: coverage.report, route: captureMeta.map(c => c.id), captures: captureMeta
  };
  const manifestPath = `${root}/manifest.json`;
  const latestPath = `${VISUALS_DIR}/latest.json`;
  const [manifestBlob, latestBlob] = await Promise.all([gitBlob(client, `${JSON.stringify(manifest, null, 2)}\n`), gitBlob(client, `${JSON.stringify({ ...manifest, manifest_path: manifestPath, captures: captureMeta.map(({ id, label, kind, path, readable_path, width, height }) => ({ id, label, kind, path, readable_path, width, height })) }, null, 2)}\n`)]);
  files.push({ path: manifestPath, sha: manifestBlob.sha }, { path: latestPath, sha: latestBlob.sha });
  const commit = await commitFiles(client, files, `Rift Local autonomous visual inspection: ${row.id}`);
  return { status: coverage.report.ok ? 'coverage-pass' : 'coverage-incomplete', inspection_id: inspectionId, manifest_path: manifestPath, latest_path: latestPath, commit_sha: commit.sha, candidate_sha256: row.publicResult.candidate_sha256, compiled_document_sha256: row.publicResult.compiled_document_sha256, coverage: coverage.report, captures: captureMeta.map(({ id, path, readable_path, kind }) => ({ id, path, readable_path, kind })) };
}

async function inspectRow(row) {
  if (running) return null;
  if (!row?.publicResult?.ok || !row?.artifact?.document || !row?.artifact?.semantics || !row?.publicResult?.visual_pack?.capture_id) throw new Error('Autonomous inspection requires a local PASS candidate with compiled semantics and a completed standard visual pack.');
  const existing = row.publicResult?.autonomous_visual_pack;
  if (existing?.candidate_sha256 === row.publicResult.candidate_sha256 && existing?.compiled_document_sha256 === row.publicResult.compiled_document_sha256 && existing?.standard_visual_capture_id === row.publicResult.visual_pack.capture_id) return existing;
  const client = new RiftGitHubClient(); if (!client.connected) throw new Error('GitHub is not connected.');
  if (!(await standardVisualsReady(client, row))) throw new Error('Waiting for the normal visual JPEG/readable pack to finish syncing first.');
  running = true;
  try {
    setStatus('Planning coverage…', 'busy');
    const cells = replayCells(row.artifact.document);
    const plan = semanticTargetsAndViews(row, cells);
    const coverage = calculateCoverage(cells, plan.targets, plan.candidates);
    const route = orderRoute(coverage.selected);
    setSummary(`${coverage.report.selectedViews}/${coverage.report.candidateViews} useful views selected · critical ${coverage.report.criticalCovered}/${coverage.report.criticalTargets} · geometric ${Math.round(coverage.report.optionalCoverageRatio * 1000) / 10}%`);
    const captures = await renderRoute(client, row, route);
    const marker = await queueAutonomousPack(client, row, coverage, captures);
    marker.standard_visual_capture_id = row.publicResult.visual_pack.capture_id;
    row.publicResult = { ...row.publicResult, autonomous_visual_pack: marker };
    await putLocal('candidates', { ...row, savedAt: Date.now() });
    await putLocal('results', { id: row.id, publicResult: row.publicResult, savedAt: Date.now() });
    setStatus(marker.status === 'coverage-pass' ? 'Coverage PASS' : 'Coverage incomplete', marker.status === 'coverage-pass' ? 'pass' : 'fail');
    setSummary(`${coverage.report.selectedViews} inspection shots · critical ${coverage.report.criticalCovered}/${coverage.report.criticalTargets} · optional ${Math.round(coverage.report.optionalCoverageRatio * 1000) / 10}% · ${marker.status}`);
    return marker;
  } finally { running = false; }
}

async function latestEligible() {
  const rows = (await listLocal('candidates')).filter(row => row.publicResult?.ok && row.artifact?.document && row.artifact?.semantics && row.publicResult?.visual_pack?.capture_id);
  return rows[0] || null;
}
async function runLatest(manual = false) {
  if (running) return;
  const row = await latestEligible();
  if (!row) { if (manual) throw new Error('No local PASS candidate with a completed visual pack is available.'); return; }
  try { await inspectRow(row); }
  catch (error) {
    if (!manual && /Waiting for the normal visual/.test(String(error?.message || ''))) return;
    throw error;
  }
}
function scheduleAuto(delay = 3000) {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    if ($('#autonomous-visual-auto')?.checked !== false && document.visibilityState === 'visible') runLatest(false).catch(showError);
  }, delay);
}

injectUi();
scheduleAuto(4500);
$('#run-build')?.addEventListener('click', () => scheduleAuto(5000));
$('#refresh-history')?.addEventListener('click', () => scheduleAuto(2500));
$('#sync-jobs')?.addEventListener('click', () => scheduleAuto(5000));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleAuto(1200); });
