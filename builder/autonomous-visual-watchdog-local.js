import { listLocal } from './storage.js';
const AUTO_KEY='rift-local-builder.autonomous-visual-auto';
const INTERVAL_MS=2200;
let checking=false,timer=null;
async function check(){
  if(checking||document.visibilityState==='hidden'||localStorage.getItem(AUTO_KEY)==='0')return;
  checking=true;
  try{
    const rows=(await listLocal('candidates')).filter(row=>row.publicResult?.ok&&row.artifact?.document&&row.artifact?.semantics&&row.publicResult?.visual_pack?.storage==='local'&&row.publicResult?.visual_pack?.status==='saved-local');
    const row=rows[0];if(!row)return;
    const visual=row.publicResult.visual_pack,existing=row.publicResult?.autonomous_visual_pack;
    if(existing?.planner_version==='adaptive-v2'&&existing?.storage==='local'&&existing?.candidate_sha256===row.publicResult?.candidate_sha256&&existing?.compiled_document_sha256===row.publicResult?.compiled_document_sha256&&existing?.standard_visual_capture_id===visual.capture_id)return;
    document.querySelector('#autonomous-visual-run')?.click();
  }catch(error){console.error('[Rift Local Autonomous Watchdog]',error)}finally{checking=false}
}
window.addEventListener('rift-local-visual-pack-ready',()=>setTimeout(check,250));
setTimeout(check,1200);timer=setInterval(check,INTERVAL_MS);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')setTimeout(check,200)});
window.addEventListener('pagehide',()=>{if(timer)clearInterval(timer)});
