const originalUrl=new URL('./autonomous-visual-inspector.js?v=h2.15-1',import.meta.url);
const storageUrl=new URL('./storage.js',import.meta.url).href;
const githubUrl=new URL('./github.js?v=h2.16-persistent-auth-2',import.meta.url).href;
const mediaUrl=new URL('./local-media.js?v=h2.22-1',import.meta.url).href;

const response=await fetch(originalUrl,{cache:'no-store'});
if(!response.ok)throw new Error(`Could not load autonomous inspector base (${response.status}).`);
let source=await response.text();
source=source
 .replace("from './storage.js'",`from '${storageUrl}'`)
 .replace("from './github.js'",`from '${githubUrl}'`)
 .replace('const MAX_SHOTS = 36;',`const MIN_SHOTS = 20;\nconst MAX_BASE_SHOTS = 72;\nconst HARD_SAFETY_CAP = 120;`)
 .replaceAll('coverage-driven-voxel-los-v1','coverage-driven-voxel-los-v2-adaptive-local')
 .replaceAll('-coverage-v1','-coverage-v2-adaptive-local');
source=`import { putBase64Media, putLocalJson, getLocalJson } from '${mediaUrl}';\n${source}`;

const coverageStart=source.indexOf('function calculateCoverage(cells, targets, candidates) {');
const coverageEnd=source.indexOf('\nfunction orderRoute(selected) {',coverageStart);
if(coverageStart<0||coverageEnd<0)throw new Error('Could not patch adaptive autonomous coverage planner.');
const adaptiveCoverage=`function recoveryCandidateViews(cells, item, seed = 0) {
  const views = [];
  const seen = new Set();
  const addView = (position, suffix, kind = 'recovery-critical') => {
    const pos = findFree(cells, position);
    const k = pos.map(v => Math.round(v * 10) / 10).join('|');
    if (seen.has(k) || occupied(cells, pos) || occupied(cells, [pos[0], pos[1] + .8, pos[2]])) return;
    seen.add(k);
    views.push(candidate(\`recovery-\${safe(item.id)}-\${seed}-\${suffix}\`, \`Recovery · \${item.id} · \${suffix}\`, kind, pos, item.point, { recoveryTargetId: item.id, fov: Math.PI * .60 }));
  };
  const normal = item.normal ? normalize(item.normal) : null;
  if (normal) {
    let tangent = Math.abs(normal[0]) > .5 ? [0,0,1] : [1,0,0];
    if (Math.abs(normal[1]) > .5) tangent = [1,0,0];
    const second = normalize([normal[1]*tangent[2]-normal[2]*tangent[1],normal[2]*tangent[0]-normal[0]*tangent[2],normal[0]*tangent[1]-normal[1]*tangent[0]]);
    for (const radius of [1.8,2.6,3.8,5.5,8]) for (const offset of [0,-1.5,1.5,-3,3]) {
      let p=add(item.point,normal,radius);p=add(p,tangent,offset);addView(p,\`n\${radius}-t\${offset}\`);
      if(Math.hypot(...second)>.1)addView(add(p,second,offset*.45),\`n\${radius}-s\${offset}\`);
    }
  } else {
    for(const radius of [1.8,2.8,4.2,6])for(let i=0;i<12;i+=1){const angle=i*Math.PI*2/12;addView([item.point[0]+Math.cos(angle)*radius,item.point[1],item.point[2]+Math.sin(angle)*radius],\`r\${radius}-a\${i}\`)}
  }
  return views;
}
function calculateCoverage(cells, targets, candidates) {
  const byId=new Map(targets.map(item=>[item.id,item]));
  const initialCandidateViews=candidates.length;
  const evaluate=view=>{view.covers=targets.filter(item=>targetVisible(cells,view,item)).map(item=>item.id);return view};
  candidates.forEach(evaluate);
  const covered=new Set(),selected=[];
  const allCritical=targets.filter(t=>t.critical),optional=targets.filter(t=>!t.critical);
  const adaptiveBaseBudget=clamp(Math.ceil(12+allCritical.length*.12+optional.length*.08),MIN_SHOTS,MAX_BASE_SHOTS);
  const optionalRatio=()=>optional.length?optional.filter(t=>covered.has(t.id)).length/optional.length:1;
  const categoryRatio=category=>{const rows=optional.filter(t=>t.category===category);return rows.length?rows.filter(t=>covered.has(t.id)).length/rows.length:1};
  const optionalGoalMet=()=>optionalRatio()>=OPTIONAL_TARGET_RATIO&&categoryRatio('facade')>=.95&&categoryRatio('roof')>=.95&&categoryRatio('site')>=.90;
  const criticalGoalMet=()=>allCritical.every(t=>covered.has(t.id));
  const scoreView=(view,criticalOnly=false)=>{let score=0;for(const id of view.covers||[]){if(covered.has(id))continue;const item=byId.get(id);if(!item)continue;if(item.critical)score+=1000;else if(!criticalOnly)score+=item.category==='site'?8:item.category==='roof'?6:item.category==='facade'?4:1}return score};
  const chooseBest=(pool,criticalOnly=false)=>{let best=null,bestScore=0;for(const view of pool){if(selected.includes(view))continue;const score=scoreView(view,criticalOnly);if(score>bestScore){best=view;bestScore=score}}return bestScore>0?best:null};
  const take=view=>{selected.push(view);for(const id of view.covers||[])covered.add(id)};
  while(selected.length<adaptiveBaseBudget){const best=chooseBest(candidates,false);if(!best)break;take(best);if(criticalGoalMet()&&optionalGoalMet())break}
  let emergencyViewsGenerated=0,criticalRecoveryViewsSelected=0,optionalRecoveryViewsSelected=0;
  if(!criticalGoalMet()){
    const recovery=[];allCritical.filter(t=>!covered.has(t.id)).forEach((item,i)=>{const rows=recoveryCandidateViews(cells,item,i).map(evaluate);emergencyViewsGenerated+=rows.length;recovery.push(...rows)});candidates.push(...recovery);
    while(!criticalGoalMet()&&selected.length<HARD_SAFETY_CAP){const best=chooseBest(recovery,true);if(!best)break;take(best);criticalRecoveryViewsSelected+=1}
  }
  if(!optionalGoalMet()&&selected.length<HARD_SAFETY_CAP){
    const recovery=[];optional.filter(t=>!covered.has(t.id)).forEach((item,i)=>{const rows=recoveryCandidateViews(cells,item,10000+i).map(evaluate);emergencyViewsGenerated+=rows.length;recovery.push(...rows)});candidates.push(...recovery);
    while(!optionalGoalMet()&&selected.length<HARD_SAFETY_CAP){const best=chooseBest(candidates,false);if(!best)break;take(best);optionalRecoveryViewsSelected+=1}
  }
  const criticalCovered=allCritical.filter(t=>covered.has(t.id)).length,optionalCovered=optional.filter(t=>covered.has(t.id)).length;
  const categories={};for(const item of targets){const row=categories[item.category]||=( {total:0,covered:0,critical:0,criticalCovered:0} );row.total+=1;if(item.critical)row.critical+=1;if(covered.has(item.id)){row.covered+=1;if(item.critical)row.criticalCovered+=1}}
  const categoryCoverage={};for(const [name,row] of Object.entries(categories))categoryCoverage[name]=row.total?row.covered/row.total:1;
  return{selected,covered,report:{ok:criticalCovered===allCritical.length&&optionalGoalMet(),plannerVersion:'adaptive-v2-local',initialCandidateViews,candidateViews:candidates.length,emergencyViewsGenerated,adaptiveBaseBudget,hardSafetyCap:HARD_SAFETY_CAP,budgetExpanded:selected.length>adaptiveBaseBudget,criticalRecoveryViewsSelected,optionalRecoveryViewsSelected,selectedViews:selected.length,targets:targets.length,criticalTargets:allCritical.length,criticalCovered,optionalTargets:optional.length,optionalCovered,optionalCoverageRatio:optional.length?optionalCovered/optional.length:1,requiredOptionalCoverageRatio:OPTIONAL_TARGET_RATIO,categoryMinimums:{facade:.95,roof:.95,site:.90},categoryCoverage,categories,uncoveredCritical:allCritical.filter(t=>!covered.has(t.id)).map(t=>t.id)}};
}
`;
source=source.slice(0,coverageStart)+adaptiveCoverage+source.slice(coverageEnd);

const readyStart=source.indexOf('async function standardVisualsReady(client, row) {');
const readyEnd=source.indexOf('\nasync function queueAutonomousPack(',readyStart);
if(readyStart<0||readyEnd<0)throw new Error('Could not patch local autonomous readiness.');
const localReady=`async function standardVisualsReady(client, row) {
  const visual=row?.publicResult?.visual_pack;
  if(!visual||visual.storage!=='local'||visual.status!=='saved-local'||!visual.manifest_path)return false;
  if(visual.candidate_sha256!==row.publicResult?.candidate_sha256||visual.compiled_document_sha256!==row.publicResult?.compiled_document_sha256)return false;
  try{
    const manifest=await getLocalJson(visual.manifest_path);
    return Boolean(manifest&&manifest.storage==='local'&&manifest.job_id===row.id&&manifest.capture_id===visual.capture_id&&manifest.candidate_sha256===row.publicResult?.candidate_sha256&&manifest.compiled_document_sha256===row.publicResult?.compiled_document_sha256);
  }catch{return false}
}
`;
source=source.slice(0,readyStart)+localReady+source.slice(readyEnd);

const packStart=source.indexOf('async function queueAutonomousPack(client, row, coverage, captures) {');
const packEnd=source.indexOf('\nasync function inspectRow(row) {',packStart);
if(packStart<0||packEnd<0)throw new Error('Could not patch local autonomous pack storage.');
const localPack=`async function queueAutonomousPack(client, row, coverage, captures) {
  const visualCapture=row.publicResult.visual_pack.capture_id;
  const inspectionId=\`${visualCapture}-coverage-v2-adaptive-local\`;
  const root=\`autonomous/\${safe(row.id)}/\${safe(inspectionId)}\`;
  const captureMeta=[];
  setStatus('Saving inspection pack locally…','busy');
  for(let i=0;i<captures.length;i+=1){
    const shot=captures[i];setStatus(\`Saving inspection \${i+1}/\${captures.length}…\`,'busy');
    const jpgPath=\`${root}/\${shot.id}.jpg\`;
    const saved=await putBase64Media(jpgPath,shot.base64,'image/jpeg');
    captureMeta.push({id:shot.id,label:shot.label,kind:shot.kind,path:jpgPath,width:shot.width,height:shot.height,position:shot.position,look_at:shot.lookAt,covers:shot.covers,storage:saved.storage});
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  const manifest={format:'riftcity-autonomous-visual-inspection',version:2,planner:'coverage-driven-voxel-los-v2-adaptive-local',storage:'local',job_id:row.id,inspection_id:inspectionId,source_branch:client.config.sourceBranch,candidate_sha256:row.publicResult.candidate_sha256,compiled_document_sha256:row.publicResult.compiled_document_sha256,standard_visual_capture_id:visualCapture,generated_at:Date.now(),coverage:coverage.report,route:captureMeta.map(c=>c.id),captures:captureMeta};
  const manifestPath=\`${root}/manifest.json\`;await putLocalJson(manifestPath,manifest);
  const marker={planner_version:'adaptive-v2',storage:'local',status:coverage.report.ok?'coverage-pass':'coverage-incomplete',inspection_id:inspectionId,manifest_path:manifestPath,standard_visual_capture_id:visualCapture,candidate_sha256:row.publicResult.candidate_sha256,compiled_document_sha256:row.publicResult.compiled_document_sha256,coverage:coverage.report,captures:captureMeta.map(({id,path,kind,width,height})=>({id,path,kind,width,height}))};
  window.dispatchEvent(new CustomEvent('rift-local-autonomous-ready',{detail:{jobId:row.id,inspectionId,status:marker.status}}));
  return marker;
}
`;
source=source.slice(0,packStart)+localPack+source.slice(packEnd);

const oldGuard="if (existing?.candidate_sha256 === row.publicResult.candidate_sha256 && existing?.compiled_document_sha256 === row.publicResult.compiled_document_sha256 && existing?.standard_visual_capture_id === row.publicResult.visual_pack.capture_id) return existing;";
const newGuard="if (existing?.planner_version === 'adaptive-v2' && existing?.storage === 'local' && existing?.candidate_sha256 === row.publicResult.candidate_sha256 && existing?.compiled_document_sha256 === row.publicResult.compiled_document_sha256 && existing?.standard_visual_capture_id === row.publicResult.visual_pack.capture_id) return existing;";
if(!source.includes(oldGuard))throw new Error('Could not patch local autonomous rerun guard.');
source=source.replace(oldGuard,newGuard)
 .replace('keeps only useful views, then queues JPEGs + AI-readable copies + a coverage manifest.','keeps only useful views, expands coverage when needed, then saves the JPEGs and coverage manifest only on this iPhone.')
 .replaceAll('Queueing inspection pack…','Saving inspection pack locally…');

const blobUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
try{await import(blobUrl)}finally{setTimeout(()=>URL.revokeObjectURL(blobUrl),1000)}
