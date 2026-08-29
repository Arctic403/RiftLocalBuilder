const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const PANEL_KEY='rift-local-builder.clean-panel-v2';
const panels=new Map($$('.workspace-panel').map(el=>[el.dataset.panel,el]));
const navButtons=$$('.nav-btn[data-panel]');

function activate(name,{persist=true,scroll=true}={}){
  if(!panels.has(name))name='build';
  for(const [id,panel] of panels)panel.classList.toggle('active',id===name);
  for(const button of navButtons){const on=button.dataset.panel===name;button.classList.toggle('active',on);button.setAttribute('aria-selected',String(on))}
  if(persist)try{localStorage.setItem(PANEL_KEY,name)}catch{}
  if(scroll)window.scrollTo({top:0,behavior:'instant'});
}
for(const button of navButtons)button.addEventListener('click',()=>activate(button.dataset.panel));

function moveInto(node,slot){if(!node||!slot||node.parentElement===slot)return;slot.append(node)}
function placeDynamicModules(){
  moveInto(document.querySelector('.inspect-card'),$('#visual-gate-slot'));
  moveInto($('#autonomous-visual-card'),$('#autonomous-slot'));
  moveInto($('#handoff-card'),$('#handoff-slot'));
}
placeDynamicModules();
const observer=new MutationObserver(placeDynamicModules);
observer.observe(document.body,{childList:true,subtree:true});

function setDot(panel,state){const dot=document.querySelector(`.nav-btn[data-panel="${panel}"] .nav-dot`);if(!dot)return;dot.classList.remove('ready','fail');if(state)dot.classList.add(state)}
function syncWorkflowState(){
  const result=$('#result-status');
  if(result){const text=result.textContent.trim().toUpperCase();setDot('inspect',text==='PASS'?'ready':text==='FAIL'?'fail':null)}
  const visual=$('#inspect-status');
  const auto=$('#autonomous-visual-status');
  const handoff=$('#handoff-status');
  const inspectReady=[visual,auto].some(el=>/pass|saved|ready/i.test(el?.textContent||''));
  if(inspectReady)setDot('handoff','ready');
  if(/fail/i.test(handoff?.textContent||''))setDot('handoff','fail');
}
const stateObserver=new MutationObserver(syncWorkflowState);
stateObserver.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class']});

$('#go-inspect')?.addEventListener('click',()=>activate('inspect'));
$('#go-handoff')?.addEventListener('click',()=>activate('handoff'));

function fillQuickStrip(){
  const auth=$('#auth-status')?.textContent?.trim()||'Disconnected';
  const build=$('#build-status')?.textContent?.trim()||'Ready';
  const count=$('#history-count')?.textContent?.trim()||'0';
  const qa=$('#quick-auth');if(qa)qa.textContent=auth;
  const qb=$('#quick-build');if(qb)qb.textContent=build;
  const qc=$('#quick-history');if(qc)qc.textContent=count;
}
const quickObserver=new MutationObserver(fillQuickStrip);quickObserver.observe(document.body,{subtree:true,childList:true,characterData:true});fillQuickStrip();

let initial='build';try{initial=localStorage.getItem(PANEL_KEY)||'build'}catch{}
activate(initial,{persist:false,scroll:false});
window.addEventListener('beforeunload',()=>observer.disconnect(),{once:true});
