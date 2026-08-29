const MODULES=[
  {name:'Standard Visual Gate',slot:'#visual-gate-slot',loader:'./local-inspector-local-loader.js?v=h2.22-1',base:'./local-inspector.js?v=h2.14-photo-upload-1'},
  {name:'Autonomous Visual QA',slot:'#autonomous-slot',loader:'./autonomous-visual-local-adaptive-loader.js?v=h2.22-1',base:'./autonomous-visual-inspector.js?v=h2.15-1'}
];
const ROOT=new URL('./',import.meta.url);
const objectUrls=[];

async function text(url,label){
  const response=await fetch(url,{cache:'no-store'});
  if(!response.ok)throw new Error(`${label} load failed (HTTP ${response.status}).`);
  return response.text();
}
function moduleBlob(source){
  const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
  objectUrls.push(url);
  return url;
}
function absolute(path){return new URL(path,ROOT).href}
async function dependencyBlob(path,label){return moduleBlob(await text(absolute(path),label))}

function repairNestedTemplateInterpolations(source,module){
  if(module.name==='Standard Visual Gate'){
    source=source
      .replace(
        'const captureId = \\`${Date.now()}-\\${safe(candidateHash.slice(0, 12))}\\`;',
        'const captureId = \\`\\${Date.now()}-\\${safe(candidateHash.slice(0, 12))}\\`;'
      )
      .replace(
        'const path = \\`${root}/\\${capture.id}.jpg\\`;',
        'const path = \\`\\${root}/\\${capture.id}.jpg\\`;'
      )
      .replace(
        'const manifestPath = \\`${root}/manifest.json\\`;',
        'const manifestPath = \\`\\${root}/manifest.json\\`;'
      )
      .replace(
        "status.textContent = \\`${captureMeta.length} views saved locally\\`;",
        "status.textContent = \\`\\${captureMeta.length} views saved locally\\`;"
      );
  }
  if(module.name==='Autonomous Visual QA'){
    source=source
      .replace(
        'const inspectionId=\\`${visualCapture}-coverage-v2-adaptive-local\\`;',
        'const inspectionId=\\`\\${visualCapture}-coverage-v2-adaptive-local\\`;'
      )
      .replace(
        'const jpgPath=\\`${root}/\\${shot.id}.jpg\\`;',
        'const jpgPath=\\`\\${root}/\\${shot.id}.jpg\\`;'
      )
      .replace(
        'const manifestPath=\\`${root}/manifest.json\\`;',
        'const manifestPath=\\`\\${root}/manifest.json\\`;'
      );
  }
  return source;
}

function renderError(module,error){
  console.error(`[Rift ${module.name} loader]`,error);
  const slot=document.querySelector(module.slot);
  if(!slot)return;
  const card=document.createElement('section');
  card.className='card module-load-error';
  card.innerHTML=`<div class="section-title"><div><div class="eyebrow">MODULE ERROR</div><h2>${module.name}</h2></div><span class="status fail">LOAD FAILED</span></div><p class="hint"></p><button class="secondary">Reload module</button>`;
  const message=error?.message||String(error)||'Unknown module error.';
  const stack=error?.stack||'';
  card.querySelector('.hint').textContent=stack&&stack.includes(message)?stack:`${message}${stack?`\n${stack}`:''}`;
  card.querySelector('button').onclick=()=>location.reload();
  slot.replaceChildren(card);
}

async function run(module){
  try{
    const [loaderSource,storageUrl,githubUrl,mediaUrl]=await Promise.all([
      text(absolute(module.loader),`${module.name} loader`),
      dependencyBlob('./storage.js',`${module.name} storage dependency`),
      dependencyBlob('./github.js?v=h2.16-persistent-auth-2',`${module.name} GitHub dependency`),
      dependencyBlob('./local-media.js?v=h2.22-1',`${module.name} local-media dependency`)
    ]);

    let source=repairNestedTemplateInterpolations(loaderSource,module);
    const baseAbsolute=absolute(module.base);
    source=source
      .replace(/const originalUrl=new URL\([^;]+;/,`const originalUrl=new URL(${JSON.stringify(baseAbsolute)});`)
      .replace(/const storageUrl=new URL\([^;]+;/,`const storageUrl=${JSON.stringify(storageUrl)};`)
      .replace(/const githubUrl=new URL\([^;]+;/,`const githubUrl=${JSON.stringify(githubUrl)};`)
      .replace(/const mediaUrl=new URL\([^;]+;/,`const mediaUrl=${JSON.stringify(mediaUrl)};`);

    if(source===loaderSource)throw new Error('Safari-safe bootstrap could not rewrite loader dependencies.');
    await import(moduleBlob(source));
  }catch(error){renderError(module,error)}
}

for(const module of MODULES)await run(module);
window.dispatchEvent(new CustomEvent('rift-local-modules-ready'));
window.addEventListener('pagehide',()=>{for(const url of objectUrls)try{URL.revokeObjectURL(url)}catch{}},{once:true});
