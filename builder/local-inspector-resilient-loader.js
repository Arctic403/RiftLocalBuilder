const originalUrl = new URL('./local-inspector.js?v=h2.14-photo-upload-1', import.meta.url);
const storageUrl = new URL('./storage.js', import.meta.url).href;
const githubUrl = new URL('./github.js?v=h2.16-persistent-auth-2', import.meta.url).href;

const response = await fetch(originalUrl, { cache: 'no-store' });
if (!response.ok) throw new Error(`Could not load Local Visual Gate base (${response.status}).`);
let source = await response.text();

source = source
  .replace("from './storage.js'", `from '${storageUrl}'`)
  .replace("from './github.js'", `from '${githubUrl}'`);

const commitStart = source.indexOf('async function commitQueuedFiles(client, files, message) {');
const commitEnd = source.indexOf('\nasync function queueVisualPack(row) {', commitStart);
if (commitStart < 0 || commitEnd < 0) throw new Error('Could not patch Local Visual Gate queue transaction.');

const resilientCommit = `const VISUAL_QUEUE_MAX_ATTEMPTS = 12;
const VISUAL_QUEUE_RETRY_BASE_MS = 220;
const visualQueueSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isRetryableQueueRace(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || error?.body?.message || '').toLowerCase();
  if (status === 409) return true;
  if (status !== 422) return false;
  return /not a fast.?forward|fast.?forward|reference.*update|update.*reference|failed.*ref|conflict/.test(message);
}

async function commitQueuedFiles(client, files, message) {
  let lastError = null;
  for (let attempt = 0; attempt < VISUAL_QUEUE_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const exponent = Math.min(attempt - 1, 4);
      const backoff = Math.min(3600, VISUAL_QUEUE_RETRY_BASE_MS * (2 ** exponent));
      const jitter = Math.floor(Math.random() * 260);
      const status = $('#inspect-status');
      if (status) {
        status.textContent = \`Queue moved · rebasing \${attempt + 1}/\${VISUAL_QUEUE_MAX_ATTEMPTS}…\`;
        status.className = 'status busy';
      }
      await visualQueueSleep(backoff + jitter);
    }

    // Every attempt starts from a freshly resolved queue HEAD. The GitHub ref
    // PATCH remains force:false, so another writer can never be overwritten.
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
      const updated = await client.api(repoApi(client, \`/git/refs/heads/\${encodeURIComponent(QUEUE_BRANCH)}\`), {
        method: 'PATCH',
        body: { sha: commit.sha, force: false }
      });
      if (updated?.object?.sha && updated.object.sha !== commit.sha) {
        const mismatch = new Error('GitHub returned an unexpected queue ref after the visual commit.');
        mismatch.status = 409;
        throw mismatch;
      }
      return commit;
    } catch (error) {
      lastError = error;
      if (!isRetryableQueueRace(error)) throw error;
    }
  }

  const error = new Error(
    \`The private queue kept moving after \${VISUAL_QUEUE_MAX_ATTEMPTS} safe rebase attempts. Nothing was force-pushed or overwritten. Wait for the current local sync to finish, then tap Capture + queue views once.\`
  );
  error.cause = lastError;
  throw error;
}
`;

source = source.slice(0, commitStart) + resilientCommit + source.slice(commitEnd);

// Avoid repeated iOS alert dialogs for queue races. Keep the failure visible in
// the Local Visual Gate card and console instead.
const quietCaptureHandler = `e => {
  const status = $('#inspect-status');
  if (status) {
    status.textContent = e?.message || String(e);
    status.className = 'status fail';
  }
  console.error('[Rift Local Visual Queue]', e);
}`;
source = source
  .replace("$('#inspect-capture').onclick = () => captureSelected().catch(e => alert(e.message));", `$('#inspect-capture').onclick = () => captureSelected().catch(${quietCaptureHandler});`)
  .replace("$('#inspect-capture-open').onclick = () => captureSelected().catch(e => alert(e.message));", `$('#inspect-capture-open').onclick = () => captureSelected().catch(${quietCaptureHandler});`);

const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
try {
  await import(blobUrl);
} finally {
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}
