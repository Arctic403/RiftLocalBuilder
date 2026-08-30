import { listLocal, putLocal } from './storage.js';
import { analyzeDesignQuality } from './design-quality-core.js?v=h2.29-1';
const $=s=>document.querySelector(s);
let running=false;

function injectUi(){
  const main=$('main');if(!main||$('#design-quality-card'))return;
  const card=document.createElement('section');
  card.id='design-quality-card';card.className='card';
  card.innerHTML=`<div class="section-title"><div><div class="eyebrow">DESIGN QUALITY</div><h2>Architectural quality telemetry</h2></div><span id="design-quality-status" class="status neutral">Ready</span></div><p class="hint">Runs local geometry + semantic heuristics after visual coverage. It does not pretend to judge aesthetics; it flags likely blocky massing, repetitive facade/room patterns, thin site treatment and missing finish/detail layers so the AI handoff knows what to inspect next.</p><div class="actions"><button id="design-quality-run">Run design review</button></div><div id="design-quality-score" class="hint">No design-quality report yet.</div><div id="design-quality-signals" class="diagnostics"></div>`;
  const device=[...main.children].find(el=>el.querySelector?.('#history'));main.insertBefore(card,device||null);
  $('#design-quality-run').onclick=()=>runLatest(true).catch(showError);
}
function status(text,kind='neutral'){const el=$('#design-quality-status');if(el){el.textContent=text;el.className=`status ${kind}`}}
function summary(text){const el=$('#design-quality-score');if(el)el.textContent=text}
function showError(error){console.error('[Rift Design Quality]',error);status('Review failed','fail');summary(error?.message||String(error))}
function render(report){
  if(!report)return;
  const kind=report.status==='design-strong'?'pass':report.status==='detail-pass-needed'?'fail':'busy';
  status(`QUALITY ${report.score}`,kind);
  const c=report.categories||{};
  summary(`Overall ${report.score}/100 · massing ${c.massing??'—'} · facade ${c.facade??'—'} · roof ${c.roof??'—'} · interior ${c.interior??'—'} · detail ${c.detail??'—'} · site ${c.site??'—'}`);
  const box=$('#design-quality-signals');if(!box)return;
  const rows=report.signals||[];
  box.innerHTML=rows.length?rows.slice(0,8).map(s=>`<div class="diag ${s.severity==='high'?'error':s.severity==='medium'?'warning':'notice'}"><b>${String(s.severity||'notice').toUpperCase()} · ${s.code}</b><br>${s.message}</div>`).join(''):'<div class="diag notice">No heuristic design warnings.</div>';
}
async function latest(){
  const rows=(await listLocal('candidates')).filter(r=>r.publicResult?.ok&&r.artifact?.document&&r.artifact?.semantics);
  return rows[0]||null;
}
async function runLatest(manual=false){
  if(running)return null;
  const row=await latest();
  if(!row){if(manual)throw new Error('No local PASS candidate with compiled geometry is available.');return null}
  running=true;status('Analyzing…','busy');
  try{
    const report=analyzeDesignQuality(row);
    row.publicResult={...row.publicResult,design_quality_report:report};
    await putLocal('candidates',{...row,savedAt:Date.now()});
    await putLocal('results',{id:row.id,publicResult:row.publicResult,savedAt:Date.now()});
    render(report);
    window.dispatchEvent(new CustomEvent('rift-local-design-quality-ready',{detail:{jobId:row.id,score:report.score,status:report.status}}));
    return report;
  }finally{running=false}
}
injectUi();
setTimeout(()=>runLatest(false).catch(showError),2200);
window.addEventListener('rift-local-autonomous-ready',()=>setTimeout(()=>runLatest(false).catch(showError),250));
$('#refresh-history')?.addEventListener('click',()=>setTimeout(()=>runLatest(false).catch(showError),350));
