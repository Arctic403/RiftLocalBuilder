import { RiftGitHubClient } from './github.js';

const VISUALS_DIR = 'rift-local-visuals';
const POLL_MS = 2500;
const client = new RiftGitHubClient();
let syncing = false;
let timer = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean64 = value => String(value || '').replace(/\s+/g, '');
const wrap64 = value => (clean64(value).match(/.{1,76}/g) || []).join('\n') + '\n';
const utf8Base64 = text => {
  const bytes = new TextEncoder().encode(String(text));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

function sameIdentity(a, b) {
  return Boolean(a && b &&
    a.job_id === b.job_id &&
    a.capture_id === b.capture_id &&
    a.candidate_sha256 === b.candidate_sha256 &&
    a.compiled_document_sha256 === b.compiled_document_sha256);
}

function visualUploaderBusy() {
  const visual = document.querySelector('#inspect-status');
  if (!visual?.classList.contains('busy')) return false;
  const text = String(visual.textContent || '').toLowerCase();
  return text.includes('captur') ||
    text.includes('uploading visual') ||
    text.includes('queueing visual') ||
    text.includes('rendering');
}

function conflictingWriterBusy() {
  const queue = document.querySelector('#queue-status');
  return visualUploaderBusy() || Boolean(queue?.classList.contains('busy'));
}

function setVisualStatus(text, kind = 'busy') {
  const el = document.querySelector('#inspect-status');
  if (!el) return;
  el.textContent = text;
  el.className = `status ${kind}`;
}

async function readQueueJson(path) {
  try {
    return (await client.readQueueJson(path)).json;
  } catch (error) {
    if (Number(error?.status) === 404) return null;
    throw error;
  }
}

async function readQueueContent(path) {
  const row = await client.api(`${client.contentPath(path)}?ref=${encodeURIComponent(client.config.queueBranch)}`);
  if (!row?.content || row?.encoding !== 'base64') throw new Error(`GitHub did not return base64 content for '${path}'.`);
  return clean64(row.content);
}

function repoApi(suffix) {
  return `/repos/${encodeURIComponent(client.config.owner)}/${encodeURIComponent(client.config.repo)}${suffix}`;
}

async function gitBlob(content, encoding = 'utf-8') {
  return client.api(repoApi('/git/blobs'), { method: 'POST', body: { content, encoding } });
}

async function queueHead() {
  const ref = await client.api(repoApi(`/git/ref/heads/${encodeURIComponent(client.config.queueBranch)}`));
  const commitSha = ref?.object?.sha;
  if (!commitSha) throw new Error('Could not resolve visual queue head.');
  const commit = await client.api(repoApi(`/git/commits/${commitSha}`));
  if (!commit?.tree?.sha) throw new Error('Could not resolve visual queue tree.');
  return { commitSha, treeSha: commit.tree.sha };
}

async function commitFiles(files, message) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    while (conflictingWriterBusy()) await sleep(350);
    const head = await queueHead();
    const tree = await client.api(repoApi('/git/trees'), {
      method: 'POST',
      body: {
        base_tree: head.treeSha,
        tree: files.map(file => ({ path: file.path, mode: '100644', type: 'blob', sha: file.sha }))
      }
    });
    const commit = await client.api(repoApi('/git/commits'), {
      method: 'POST',
      body: { message, tree: tree.sha, parents: [head.commitSha] }
    });
    try {
      await client.api(repoApi(`/git/refs/heads/${encodeURIComponent(client.config.queueBranch)}`), {
        method: 'PATCH',
        body: { sha: commit.sha, force: false }
      });
      return commit;
    } catch (error) {
      lastError = error;
      if (![409, 422].includes(Number(error?.status))) throw error;
      await sleep(180 * (attempt + 1));
    }
  }
  throw lastError || new Error('Could not advance the visual queue branch.');
}

async function syncLatestReadable() {
  if (syncing || !client.connected || document.visibilityState === 'hidden' || conflictingWriterBusy()) return;
  syncing = true;
  try {
    const latest = await readQueueJson(`${VISUALS_DIR}/latest.json`);
    if (!latest?.manifest_path) return;
    const currentReadable = await readQueueJson(`${VISUALS_DIR}/latest-readable.json`);
    if (sameIdentity(latest, currentReadable)) {
      setVisualStatus('Photos ready for AI', 'pass');
      return;
    }

    const manifest = await readQueueJson(latest.manifest_path);
    if (!sameIdentity(latest, manifest)) throw new Error('Visual latest pointer does not match its manifest.');
    if (!Array.isArray(manifest.captures) || !manifest.captures.length) throw new Error('Visual manifest has no captures.');

    setVisualStatus('Preparing AI-readable views…');
    const files = [];
    const readableCaptures = [];
    for (let i = 0; i < manifest.captures.length; i += 1) {
      if (conflictingWriterBusy()) throw new Error('Visual uploader became busy; readable sync will retry.');
      const capture = manifest.captures[i];
      setVisualStatus(`AI bridge ${i + 1}/${manifest.captures.length}…`);
      const base64 = await readQueueContent(capture.path);
      const sidecarPath = `${capture.path}.b64.txt`;
      const sidecarBlob = await gitBlob(wrap64(base64), 'utf-8');
      files.push({ path: sidecarPath, sha: sidecarBlob.sha });
      readableCaptures.push({
        id: capture.id,
        label: capture.label || capture.id,
        mode: capture.mode,
        view: capture.view,
        path: sidecarPath,
        width: capture.width,
        height: capture.height,
        encoding: 'base64-lines',
        line_width: 76,
        source_jpeg_path: capture.path,
        source_jpeg_blob_sha: capture.git_blob_sha || null,
        git_blob_sha: sidecarBlob.sha
      });
    }

    const root = latest.manifest_path.replace(/\/manifest\.json$/, '');
    const readableManifestPath = `${root}/readable-manifest.json`;
    const readable = {
      format: 'riftcity-local-visual-readable-pack',
      version: 2,
      job_id: latest.job_id,
      capture_id: latest.capture_id,
      candidate_sha256: latest.candidate_sha256,
      compiled_document_sha256: latest.compiled_document_sha256,
      source_manifest_path: latest.manifest_path,
      captures: readableCaptures
    };
    if (!sameIdentity(latest, readable)) throw new Error('Readable visual identity guard failed.');

    const readableManifestBlob = await gitBlob(`${JSON.stringify(readable, null, 2)}\n`, 'utf-8');
    files.push({ path: readableManifestPath, sha: readableManifestBlob.sha });

    const latestReadable = {
      ...readable,
      manifest_path: readableManifestPath,
      captures: readableCaptures.map(({ id, label, mode, view, path, width, height, source_jpeg_path, source_jpeg_blob_sha }) => ({
        id, label, mode, view, path, width, height, source_jpeg_path, source_jpeg_blob_sha
      })),
      updated_at: Date.now()
    };
    const latestReadableBlob = await gitBlob(`${JSON.stringify(latestReadable, null, 2)}\n`, 'utf-8');
    files.push({ path: `${VISUALS_DIR}/latest-readable.json`, sha: latestReadableBlob.sha });

    setVisualStatus('Finalizing AI-readable views…');
    await commitFiles(files, `Rift Local readable visual sync: ${latest.job_id}`);

    const [verifiedLatest, verifiedReadable] = await Promise.all([
      readQueueJson(`${VISUALS_DIR}/latest.json`),
      readQueueJson(`${VISUALS_DIR}/latest-readable.json`)
    ]);
    if (!sameIdentity(verifiedLatest, verifiedReadable)) throw new Error('Readable visual pointer verification failed after commit.');
    setVisualStatus('Photos ready for AI', 'pass');
  } catch (error) {
    if (!String(error?.message || '').includes('became busy')) {
      console.error('[Rift Local Visual Readable Sync v2]', error);
      setVisualStatus('AI photo sync retrying…', 'busy');
    }
  } finally {
    syncing = false;
  }
}

function schedule(delay = 0) {
  setTimeout(() => syncLatestReadable(), delay);
}

schedule(2200);
timer = setInterval(() => schedule(), POLL_MS);
document.querySelector('#run-build')?.addEventListener('click', () => schedule(3500));
document.querySelector('#sync-jobs')?.addEventListener('click', () => schedule(3500));
document.querySelector('#inspect-capture')?.addEventListener('click', () => schedule(5000));
document.querySelector('#refresh-history')?.addEventListener('click', () => schedule(1200));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') schedule(500);
});
window.addEventListener('pagehide', () => {
  if (timer) clearInterval(timer);
});
