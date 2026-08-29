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
  if(scroll)window.scrollTo({top:0,behavior:'auto'});
}
for(const button of navButtons)button.addEventListener('click',()=>activate(button.dataset.panel));

function moveInto(node,slot){if(!node||!slot||node.parentElement===slot)return;slot.append(node)}
function placeDynamicModules(){
  moveInto(document.querySelector('.inspect-card'),$('#visual-gate-slot'));
  moveInto($('#autonomous-visual-card'),$('#autonomous-slot'));
  moveInto($('#handoff-card'),$('#handoff-slot'));
}
placeDynamicModules();
const moduleObserver=new MutationObserver(placeDynamicModules);
moduleObserver.observe($('main')||document.body,{childList:true,subtree:true});

function setDot(panel,state){
  const dot=document.querySelector(`.nav-btn[data-panel="${panel}"] .nav-dot`);if(!dot)return;
  const next=state||'';
  if(dot.dataset.state===next)return;
  dot.dataset.state=next;dot.classList.toggle('ready',state==='ready');dot.classList.toggle('fail',state==='fail');
}
function syncWorkflowState(){
  const text=$('#result-status')?.textContent?.trim().toUpperCase()||'';
  setDot('inspect',text==='PASS'?'ready':text==='FAIL'?'fail':null);
  const visual=$('#inspect-status')?.textContent||'';
  const auto=$('#autonomous-visual-status')?.textContent||'';
  const handoff=$('#handoff-status')?.textContent||'';
  if(/fail/i.test(visual)||/fail|incomplete/i.test(auto))setDot('handoff','fail');
  else if(/pass|saved|ready/i.test(visual)||/pass/i.test(auto))setDot('handoff','ready');
  else setDot('handoff',null);
  if(/fail/i.test(handoff))setDot('handoff','fail');
}
const stateObserver=new MutationObserver(syncWorkflowState);
stateObserver.observe(document.body,{subtree:true,childList:true,characterData:true});

$('#go-inspect')?.addEventListener('click',()=>activate('inspect'));
$('#go-handoff')?.addEventListener('click',()=>activate('handoff'));

function setText(el,value){if(el&&el.textContent!==value)el.textContent=value}
function fillQuickStrip(){
  setText($('#quick-auth'),$('#auth-status')?.textContent?.trim()||'Disconnected');
  setText($('#quick-build'),$('#build-status')?.textContent?.trim()||'Ready');
  setText($('#quick-history'),$('#history-count')?.textContent?.trim()||'0');
}
const quickSources=[$('#auth-status'),$('#build-status'),$('#history-count')].filter(Boolean);
const quickObserver=new MutationObserver(fillQuickStrip);
for(const node of quickSources)quickObserver.observe(node,{subtree:true,childList:true,characterData:true});
fillQuickStrip();syncWorkflowState();

let initial='build';try{initial=localStorage.getItem(PANEL_KEY)||'build'}catch{}
activate(initial,{persist:false,scroll:false});
window.addEventListener('beforeunload',()=>{moduleObserver.disconnect();stateObserver.disconnect();quickObserver.disconnect()},{once:true});
