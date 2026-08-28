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
  const TX_TIMEOUT_MS=45000;

  let tail=Promise.resolve();
  let transactionRelease=null;

  async function acquire(label){
    let unlock;
    const gate=new Promise(resolve=>{unlock=resolve});
    const previous=tail;
    tail=previous.catch(()=>{}).then(()=>gate);
    await previous.catch(()=>{});
    let released=false;
    const timer=setTimeout(()=>release(),TX_TIMEOUT_MS);
    function release(){
      if(released)return;
      released=true;
      clearTimeout(timer);
      unlock();
      window.dispatchEvent(new CustomEvent('riftqueuewriteunlock',{detail:{label}}));
    }
    window.dispatchEvent(new CustomEvent('riftqueuewritelock',{detail:{label}}));
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

  window.fetch=async function riftSerializedFetch(input,init={}){
    const url=requestUrl(input);
    const method=requestMethod(input,init);
    if(!url||url.origin!=='https://api.github.com'||!url.pathname.startsWith(REPO_PREFIX)){
      return originalFetch(input,init);
    }

    const path=url.pathname;

    // A Git-data commit transaction always starts by reading the queue head.
    // Hold the mutex until that transaction attempts to advance the queue ref.
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

    // Contents API writes are already atomic, but must not overlap a Git-data
    // transaction on the same branch.
    if(queueContentsWrite(url,method,init)){
      const release=await acquire('contents-write');
      try{return await originalFetch(input,init)}finally{release()}
    }

    // Only the transaction that acquired the queue head can reach this PATCH;
    // release after GitHub accepts or rejects it so a retry can rebase cleanly.
    if(method==='PATCH'&&path===UPDATE_REF_PATH){
      try{return await originalFetch(input,init)}finally{releaseTransaction()}
    }

    try{
      const response=await originalFetch(input,init);
      // If the current Git-data transaction dies before its final ref PATCH,
      // don't leave every other writer waiting for the timeout.
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
