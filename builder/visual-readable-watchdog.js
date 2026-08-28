import { RiftGitHubClient } from './github.js';

const VISUALS_DIR = 'rift-local-visuals';
const INTERVAL_MS = 2500;
const client = new RiftGitHubClient();
let checking = false;
let timer = null;

function sameIdentity(a, b) {
  return Boolean(
    a && b &&
    a.job_id === b.job_id &&
    a.capture_id === b.capture_id &&
    a.candidate_sha256 === b.candidate_sha256 &&
    a.compiled_document_sha256 === b.compiled_document_sha256
  );
}

async function readQueue(path) {
  try {
    return (await client.readQueueJson(path)).json;
  } catch (error) {
    if (Number(error?.status) === 404) return null;
    throw error;
  }
}

function nudgeReadableBridge() {
  const refresh = document.querySelector('#refresh-history');
  if (refresh) refresh.dispatchEvent(new Event('click'));
}

async function checkSync() {
  if (checking || document.visibilityState === 'hidden' || !client.connected) return;
  checking = true;
  try {
    const [latest, readable] = await Promise.all([
      readQueue(`${VISUALS_DIR}/latest.json`),
      readQueue(`${VISUALS_DIR}/latest-readable.json`)
    ]);
    if (!latest) return;
    if (!sameIdentity(latest, readable)) nudgeReadableBridge();
  } catch (error) {
    console.error('[Rift Local Visual Watchdog]', error);
  } finally {
    checking = false;
  }
}

function requestCheck(delay = 0) {
  setTimeout(() => checkSync(), delay);
}

requestCheck(1800);
timer = setInterval(() => requestCheck(), INTERVAL_MS);
document.querySelector('#run-build')?.addEventListener('click', () => requestCheck(1800));
document.querySelector('#sync-jobs')?.addEventListener('click', () => requestCheck(1800));
document.querySelector('#refresh-history')?.addEventListener('click', () => requestCheck(900));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestCheck(250);
});
window.addEventListener('pagehide', () => {
  if (timer) clearInterval(timer);
});
