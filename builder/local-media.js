const DB_NAME='rift-local-builder-media-v1';
const DB_VERSION=1;
const STORE='files';
const ROOT_DIR='rift-local-builder-media';

function openDb(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE,{keyPath:'path'})};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
function parts(path){return String(path||'').split('/').filter(Boolean).map(x=>x.replace(/[^a-zA-Z0-9._-]/g,'_'))}
async function opfsRoot(){if(!navigator.storage?.getDirectory)return null;try{const root=await navigator.storage.getDirectory();return await root.getDirectoryHandle(ROOT_DIR,{create:true})}catch{return null}}
async function opfsFile(path,{create=false}={}){let dir=await opfsRoot();if(!dir)return null;const p=parts(path);const name=p.pop();if(!name)return null;for(const segment of p)dir=await dir.getDirectoryHandle(segment,{create});return dir.getFileHandle(name,{create})}
async function idbPut(path,blob){const db=await openDb();try{await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put({path:String(path),blob,updatedAt:Date.now()});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Local media transaction aborted.'))})}finally{db.close()}}
async function idbGet(path){const db=await openDb();try{return await new Promise((resolve,reject)=>{const r=db.transaction(STORE,'readonly').objectStore(STORE).get(String(path));r.onsuccess=()=>resolve(r.result?.blob||null);r.onerror=()=>reject(r.error)})}finally{db.close()}}

export async function putLocalMedia(path,data,type='application/octet-stream'){
  const blob=data instanceof Blob?data:new Blob([data],{type});
  const handle=await opfsFile(path,{create:true});
  if(handle){try{const w=await handle.createWritable();await w.write(blob);await w.close();return{path:String(path),storage:'opfs',size:blob.size,type:blob.type}}catch{}}
  await idbPut(path,blob);return{path:String(path),storage:'indexeddb',size:blob.size,type:blob.type};
}
export async function getLocalMedia(path){
  try{const handle=await opfsFile(path,{create:false});if(handle)return await handle.getFile()}catch{}
  return idbGet(path);
}
export async function hasLocalMedia(path){return Boolean(await getLocalMedia(path))}
export async function putLocalJson(path,value){return putLocalMedia(path,`${JSON.stringify(value,null,2)}\n`,'application/json')}
export async function getLocalJson(path){const blob=await getLocalMedia(path);if(!blob)return null;return JSON.parse(await blob.text())}
export function base64ToBlob(base64,type='application/octet-stream'){const binary=atob(String(base64||'').replace(/\s/g,''));const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i+=1)bytes[i]=binary.charCodeAt(i);return new Blob([bytes],{type})}
export async function putBase64Media(path,base64,type='application/octet-stream'){return putLocalMedia(path,base64ToBlob(base64,type),type)}
