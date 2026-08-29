const originalUrl=new URL('./local-inspector.js?v=h2.14-photo-upload-1',import.meta.url);
const storageUrl=new URL('./storage.js',import.meta.url).href;
const githubUrl=new URL('./github.js?v=h2.16-persistent-auth-2',import.meta.url).href;
const mediaUrl=new URL('./local-media.js?v=h2.22-1',import.meta.url).href;

const response=await fetch(originalUrl,{cache:'no-store'});
if(!response.ok)throw new Error(`Could not load Local Visual Gate base (${response.status}).`);
let source=await response.text();
source=source
 .replace("from './storage.js'",`from '${storageUrl}'`)
 .replace("from './github.js'",`from '${githubUrl}'`);
source=`import { putBase64Media, putLocalJson } from '${mediaUrl}';\n${source}`;

const queueStart=source.indexOf('async function queueVisualPack(row) {');
const queueEnd=source.indexOf('\nasync function captureSelected() {',queueStart);
if(queueStart<0||queueEnd<0)throw new Error('Could not patch Local Visual Gate local storage flow.');
const localQueue=`async function queueVisualPack(row) {
  if (!row?.publicResult?.ok || !row?.artifact?.document) throw new Error('Only a local PASS candidate with compiled geometry can be captured.');
  if (captureLocks.has(row.id)) return null;
  captureLocks.add(row.id);
  const status = $('#inspect-status');
  const candidateHash = row.publicResult?.candidate_sha256 || 'nohash';
  const captureId = \`${Date.now()}-\${safe(candidateHash.slice(0, 12))}\`;
  const root = \`standard-visuals/\${safe(row.id)}/\${captureId}\`;
  try {
    const captures = [];
    for (let i = 0; i < STANDARD_CAPTURES.length; i += 1) {
      const spec = STANDARD_CAPTURES[i];
      status.textContent = \`Capturing \${i + 1}/\${STANDARD_CAPTURES.length}…\`;
      status.className = 'status busy';
      captures.push(await captureFrame(row, spec));
    }
    status.textContent = 'Saving visual pack locally…';
    status.className = 'status busy';
    const captureMeta = [];
    for (const capture of captures) {
      const path = \`${root}/\${capture.id}.jpg\`;
      const saved = await putBase64Media(path, capture.base64, 'image/jpeg');
      captureMeta.push({
        id: capture.id, label: capture.label, mode: capture.mode, view: capture.view,
        path, width: capture.width, height: capture.height, mime: capture.mime,
        bytes: capture.bytes, storage: saved.storage
      });
    }
    const manifestPath = \`${root}/manifest.json\`;
    const manifest = {
      format: 'riftcity-local-visual-pack', version: 2, storage: 'local',
      job_id: row.id, capture_id: captureId, captured_at: Date.now(),
      renderer: 'RiftEngine WebGL2', source_branch: BRANCH,
      source_program_id: row.publicResult?.source_program_id || row.program?.id || null,
      candidate_sha256: row.publicResult?.candidate_sha256 || null,
      compiled_document_sha256: row.publicResult?.compiled_document_sha256 || null,
      target: row.publicResult?.target || null,
      result_summary: { ok: true, stats: row.publicResult?.stats || null },
      captures: captureMeta
    };
    await putLocalJson(manifestPath, manifest);
    const visualPack = {
      status: 'saved-local', storage: 'local', capture_id: captureId,
      manifest_path: manifestPath, candidate_sha256: row.publicResult?.candidate_sha256 || null,
      compiled_document_sha256: row.publicResult?.compiled_document_sha256 || null,
      captures: captureMeta.map(({id,path,mode,view,width,height})=>({id,path,mode,view,width,height}))
    };
    row.publicResult = { ...row.publicResult, visual_pack: visualPack };
    await putLocal('candidates', { ...row, savedAt: Date.now() });
    await putLocal('results', { id: row.id, publicResult: row.publicResult, savedAt: Date.now() });
    status.textContent = \`${captureMeta.length} views saved locally\`;
    status.className = 'status pass';
    await refreshCandidates();
    window.dispatchEvent(new CustomEvent('rift-local-visual-pack-ready',{detail:{jobId:row.id,captureId}}));
    return visualPack;
  } finally {
    captureLocks.delete(row.id);
  }
}
`;
source=source.slice(0,queueStart)+localQueue+source.slice(queueEnd);

const approveStart=source.indexOf('async function approve() {');
const approveEnd=source.indexOf('\nfunction attachGestures() {',approveStart);
if(approveStart<0||approveEnd<0)throw new Error('Could not patch local visual approval.');
const localApprove=`async function approve() {
  if (!current) throw new Error('Open a candidate first.');
  const approval = {
    status: 'approved-local', approved_at: Date.now(), renderer: 'RiftEngine WebGL2',
    mode: $('#inspect-mode').value, view: $('#inspect-view').value,
    candidate_sha256: current.publicResult?.candidate_sha256 || null,
    compiled_document_sha256: current.publicResult?.compiled_document_sha256 || null
  };
  current.publicResult = { ...current.publicResult, visual_inspection: approval };
  await putLocal('candidates', { ...current, savedAt: Date.now() });
  await putLocal('results', { id: current.id, publicResult: current.publicResult, savedAt: Date.now() });
  $('#inspect-approval').textContent = 'VISUAL APPROVED';
  $('#inspect-approval').className = 'status pass';
}
`;
source=source.slice(0,approveStart)+localApprove+source.slice(approveEnd);
source=source
 .replaceAll("queued-local","saved-local")
 .replaceAll('Capture + queue views','Capture + save views')
 .replaceAll('Capture + queue standard views','Capture + save standard views')
 .replace('can automatically queue a six-view visual pack to <code>${VISUALS_DIR}</code> on <code>${QUEUE_BRANCH}</code>, so the AI can pull the screenshots without RiftCity Actions.','saves a six-view visual pack only on this iPhone. Nothing is pushed to GitHub; Autonomous Visual QA consumes the local pack directly.')
 .replaceAll('Visual queue failed','Local visual save failed');

const blobUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
try{await import(blobUrl)}finally{setTimeout(()=>URL.revokeObjectURL(blobUrl),1000)}
