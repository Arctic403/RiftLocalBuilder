(()=>{
  if(window.__riftQueueWriteCoordinatorInstalled)return;
  window.__riftQueueWriteCoordinatorInstalled=true;

  const originalFetch=window.fetch.bind(window);
  const REPO_PREFIX='/repos/Arctic403/RiftCityV1';
  const QUEUE_BRANCH='rift-local-queue';
  const HEAD_PATHS=new Set([
    `${REPO_PREFIX}/git/ref/heads/${QUEUE_BRANCH}`,
    `${REPO_PREFIX}/git/refs/heads/${QUEUE_BRANCH}`
  ]);
  const UPDATE_REF_PATH=`${REPO_PREFIX}/git/refs/heads/${QUEUE_BRANCH}`;
  const TX_TIMEOUT_MS=90000;
  const WEB_LOCK_NAME='riftcity-rift-local-queue-write-v1';
  const LEASE_KEY='rift-local-builder.queue-write-lease-v1';
  const LEASE_MS=12000;
  const INSTANCE_ID=(globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`);

  let tail=Promise.resolve();
  let transactionRelease=null;

  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

  async function acquireLocal(){
    let unlock;
    const gate=new Promise(resolve=>{unlock=resolve});
    const previous=tail;
    tail=previous.catch(()=>{}).then(()=>gate);
    await previous.catch(()=>{});
    let released=false;
    return()=>{
      if(released)return;
      released=true;
      unlock();
    };
  }

  async function acquireBrowserWide(){
    if(navigator?.locks?.request){
      let grantedResolve;
      let holdResolve;
      const granted=new Promise(resolve=>{grantedResolve=resolve});
      const hold=new Promise(resolve=>{holdResolve=resolve});
      const request=navigator.locks.request(WEB_LOCK_NAME,{mode:'exclusive'},async()=>{
        grantedResolve();
        await hold;
      });
      await granted;
      let released=false;
      return()=>{
        if(released)return;
        released=true;
        holdResolve();
        request.catch(()=>{});
      };
    }

    // Fallback for browsers without Web Locks: a short renewable localStorage lease.
    let heartbeat=null;
    const claim=()=>{
      const now=Date.now();
      let current=null;
      try{current=JSON.parse(localStorage.getItem(LEASE_KEY)||'null')}catch{}
      if(current&&current.owner!==INSTANCE_ID&&Number(current.expires||0)>now)return false;
      try{
        localStorage.setItem(LEASE_KEY,JSON.stringify({owner:INSTANCE_ID,expires:now+LEASE_MS}));
        const verify=JSON.parse(localStorage.getItem(LEASE_KEY)||'null');
        return verify?.owner===INSTANCE_ID;
      }catch{return true}
    };
    while(!claim())await sleep(120+Math.floor(Math.random()*180));
    heartbeat=setInterval(()=>{
      try{
        const current=JSON.parse(localStorage.getItem(LEASE_KEY)||'null');
        if(current?.owner===INSTANCE_ID)localStorage.setItem(LEASE_KEY,JSON.stringify({owner:INSTANCE_ID,expires:Date.now()+LEASE_MS}));
      }catch{}
    },Math.floor(LEASE_MS/3));
    let released=false;
    return()=>{
      if(released)return;
      released=true;
      if(heartbeat)clearInterval(heartbeat);
      try{
        const current=JSON.parse(localStorage.getItem(LEASE_KEY)||'null');
        if(current?.owner===INSTANCE_ID)localStorage.removeItem(LEASE_KEY);
      }catch{}
    };
  }

  async function acquire(label){
    const releaseLocal=await acquireLocal();
    let releaseBrowserWide=null;
    try{
      releaseBrowserWide=await acquireBrowserWide();
    }catch(error){
      releaseLocal();
      throw error;
    }
    let released=false;
    const timer=setTimeout(()=>release(),TX_TIMEOUT_MS);
    function release(){
      if(released)return;
      released=true;
      clearTimeout(timer);
      try{releaseBrowserWide?.()}finally{releaseLocal()}
      window.dispatchEvent(new CustomEvent('riftqueuewriteunlock',{detail:{label,instance:INSTANCE_ID}}));
    }
    window.dispatchEvent(new CustomEvent('riftqueuewritelock',{detail:{label,instance:INSTANCE_ID}}));
    return release;
  }

  function releaseTransaction(){
    const release=transactionRelease;
    transactionRelease=null;
    if(release)release();
  }

  function requestMethod(input,init){
    return String(init?.method||input?.method||'GET').toUpperCase();
  }

  function requestUrl(input){
    try{return new URL(typeof input==='string'?input:input?.url,location.href)}catch{return null}
  }

  function queueContentsWrite(url,method,init){
    if(!url||url.origin!=='https://api.github.com')return false;
    if(!url.pathname.startsWith(`${REPO_PREFIX}/contents/`))return false;
    if(!['PUT','POST','DELETE','PATCH'].includes(method))return false;
    try{
      const raw=typeof init?.body==='string'?init.body:'';
      const body=raw?JSON.parse(raw):null;
      return body?.branch===QUEUE_BRANCH;
    }catch{return false}
  }

  // Expose an explicit lock for modules that want to guard a larger transaction.
  window.__riftQueueWriteCoordinator={
    acquire,
    async runExclusive(label,fn){
      const release=await acquire(label||'explicit-transaction');
      try{return await fn()}finally{release()}
    },
    instanceId:INSTANCE_ID,
    browserWide:Boolean(navigator?.locks?.request)
  };

  window.fetch=async function riftSerializedFetch(input,init={}){
    const url=requestUrl(input);
    const method=requestMethod(input,init);
    if(!url||url.origin!=='https://api.github.com'||!url.pathname.startsWith(REPO_PREFIX)){
      return originalFetch(input,init);
    }

    const path=url.pathname;

    // A Git-data commit transaction starts by reading the queue head. Hold both
    // the local mutex and a browser-wide lock until the ref PATCH finishes.
    if(method==='GET'&&HEAD_PATHS.has(path)){
      const release=await acquire('git-data-transaction');
      transactionRelease=release;
      try{
        const response=await originalFetch(input,init);
        if(!response.ok)releaseTransaction();
        return response;
      }catch(error){
        releaseTransaction();
        throw error;
      }
    }

    // Contents API writes must also wait behind a Git-data transaction in any tab.
    if(queueContentsWrite(url,method,init)){
      const release=await acquire('contents-write');
      try{return await originalFetch(input,init)}finally{release()}
    }

    if(method==='PATCH'&&path===UPDATE_REF_PATH){
      try{return await originalFetch(input,init)}finally{releaseTransaction()}
    }

    try{
      const response=await originalFetch(input,init);
      if(transactionRelease&&!response.ok&&method==='POST'&&(
        path===`${REPO_PREFIX}/git/trees`||path===`${REPO_PREFIX}/git/commits`
      ))releaseTransaction();
      return response;
    }catch(error){
      if(transactionRelease&&method==='POST'&&(
        path===`${REPO_PREFIX}/git/trees`||path===`${REPO_PREFIX}/git/commits`
      ))releaseTransaction();
      throw error;
    }
  };
})();
