import { listLocal } from './storage.js';
import { RiftGitHubClient } from './github.js';

const AUTO_KEY = 'rift-local-builder.autonomous-visual-auto';
const VISUALS_DIR = 'rift-local-visuals';
const INTERVAL_MS = 3500;
const client = new RiftGitHubClient();
let checking = false;
let timer = null;

function sameIdentity(a, b, row) {
  const visual = row?.publicResult?.visual_pack;
  return Boolean(
    a && b && visual &&
    a.job_id === row.id && b.job_id === row.id &&
    a.capture_id === visual.capture_id && b.capture_id === visual.capture_id &&
    a.candidate_sha256 === row.publicResult?.candidate_sha256 &&
    b.candidate_sha256 === row.publicResult?.candidate_sha256 &&
    a.compiled_document_sha256 === row.publicResult?.compiled_document_sha256 &&
    b.compiled_document_sha256 === row.publicResult?.compiled_document_sha256
  );
}

async function readQueue(path) {
  try { return (await client.readQueueJson(path)).json; }
  catch (error) { if (Number(error?.status) === 404) return null; throw error; }
}

async function check() {
  if (checking || document.visibilityState === 'hidden' || !client.connected) return;
  if (localStorage.getItem(AUTO_KEY) === '0') return;
  checking = true;
  try {
    const rows = (await listLocal('candidates')).filter(row => row.publicResult?.ok && row.artifact?.document && row.artifact?.semantics && row.publicResult?.visual_pack?.capture_id);
    const row = rows[0];
    if (!row) return;
    const visual = row.publicResult.visual_pack;
    const existing = row.publicResult?.autonomous_visual_pack;
    if (existing?.candidate_sha256 === row.publicResult?.candidate_sha256 && existing?.compiled_document_sha256 === row.publicResult?.compiled_document_sha256 && existing?.standard_visual_capture_id === visual.capture_id) return;
    const [latest, readable] = await Promise.all([
      readQueue(`${VISUALS_DIR}/latest.json`),
      readQueue(`${VISUALS_DIR}/latest-readable.json`)
    ]);
    if (!sameIdentity(latest, readable, row)) return;
    document.querySelector('#autonomous-visual-run')?.click();
  } catch (error) {
    console.error('[Rift Autonomous Visual Watchdog]', error);
  } finally {
    checking = false;
  }
}

setTimeout(check, 2500);
timer = setInterval(check, INTERVAL_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(check, 250); });
window.addEventListener('pagehide', () => { if (timer) clearInterval(timer); });
