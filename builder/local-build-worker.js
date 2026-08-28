import{loadPrivateH2Runtime}from'./runtime-loader.js';
import{runLocalBuildJob,RIFT_LOCAL_BUILD_VERSION}from'./local-build-core.js';
self.postMessage({type:'ready',version:RIFT_LOCAL_BUILD_VERSION});
self.addEventListener('message',async event=>{const msg=event.data||{};if(msg.type!=='build')return;const requestId=String(msg.requestId||crypto.randomUUID());try{self.postMessage({type:'runtime-loading',requestId});const runtime=await loadPrivateH2Runtime(msg.githubToken);const output=await runLocalBuildJob(msg.job,msg.program,runtime);self.postMessage({type:'result',requestId,...output})}catch(error){self.postMessage({type:'error',requestId,error:String(error?.message||error),stack:String(error?.stack||'')})}});
