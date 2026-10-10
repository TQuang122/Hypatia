import {nativeWorker} from "./native-worker.js";
import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {writeFile} from "node:fs/promises";
import {safePath,fileHash,exclusiveJson} from "../experiments/files.js";
import {loadGeneration,saveGeneration,lock} from "./store.js";
import {requestLedger,cacheHashes} from "./evidence.js";
import {verifyBackend} from "./index.js";
import type {GenerationReceipt} from "./types.js";
function stopGroup(pid:number,signal:NodeJS.Signals){try{process.kill(-pid,signal);}catch{}}
async function main(root:string,token:string){
  let run=await loadGeneration(root),active=run.state.active;
  if(run.spec.backend.kind==="native")return nativeWorker(root,token);
  if(!active||active.token!==token)return;
  const id=active.id,startedAt=active.startedAt;
  const remaining=Math.max(0,run.spec.maxWallSeconds*1000-run.state.spentMs),deadline=startedAt+remaining;
  let stdout="",stderr="",error="",interrupted=false,budget=false,complete=false;
  const out=`attempts/${id}/stdout.jsonl`,err=`attempts/${id}/stderr.log`;
  let child:ChildProcessWithoutNullStreams|undefined,ended:Promise<number|null>|undefined;
  try{
    await lock(root,async()=>{run=await loadGeneration(root);if(run.state.active?.token!==token)throw new Error("Stale worker.");if(run.state.status==="pause_requested"){interrupted=true;throw new Error("Paused before Python launch.");}run.state.active.launchPending=true;await saveGeneration(run,"python_launch_pending");});
    child=spawn(run.spec.backend.python,["-B","-u",run.spec.backend.bridge,"generate",run.spec.backend.root],{cwd:run.spec.workspace,detached:true,stdio:["pipe","pipe","pipe"],env:{...process.env,...(run.spec.backend.providerConfig?{AUTORESEARCH_CONFIG:run.spec.backend.providerConfig}:{}),PYTHONDONTWRITEBYTECODE:"1",PYTHONUTF8:"1"}});
    const currentChild=child;
    ended=new Promise<number|null>(ok=>{currentChild.once("error",()=>ok(null));currentChild.once("close",ok);});
    await new Promise<void>((ok,no)=>{currentChild.once("spawn",ok);currentChild.once("error",no);});
    await lock(root,async()=>{run=await loadGeneration(root);if(run.state.active?.token!==token)throw new Error("Stale Python owner.");run.state.active.childPid=currentChild.pid!;run.state.active.launchPending=false;await saveGeneration(run,"python_started");});
    currentChild.stdout.on("data",chunk=>{stdout+=String(chunk);if(Buffer.byteLength(stdout)>2*1024*1024){error="Bridge output exceeded 2 MiB.";stopGroup(currentChild.pid!,"SIGKILL");stdout=stdout.slice(0,2*1024*1024);}});
    currentChild.stderr.on("data",chunk=>{stderr+=String(chunk);if(Buffer.byteLength(stderr)>2*1024*1024){error="Bridge stderr exceeded 2 MiB.";stopGroup(currentChild.pid!,"SIGKILL");stderr=stderr.slice(0,2*1024*1024);}});
    currentChild.stdin.on("error",()=>{});child.stdin.end(JSON.stringify({spec:run.spec,runRoot:root,deadline:deadline/1000}));
    let killing=false;
    const poll=setInterval(()=>{void loadGeneration(root).then(current=>{
      if(killing)return;
      const paused=current.state.status==="pause_requested"||current.state.active?.token!==token;
      const expired=Date.now()>=deadline;
      if(paused||expired){killing=true;interrupted=paused;budget=expired;stopGroup(currentChild.pid!,"SIGTERM");setTimeout(()=>stopGroup(currentChild.pid!,"SIGKILL"),500).unref();}
    }).catch(()=>{killing=true;error="Generation state could not be read.";stopGroup(currentChild.pid!,"SIGKILL");});},100);
    let code:number|null;
    try{code=await ended;}finally{clearInterval(poll);stopGroup(currentChild.pid!,"SIGKILL");}
    for(const line of stdout.trim().split("\n"))try{const message=JSON.parse(line);if(message.type==="complete")complete=true;if(message.type==="error")error=String(message.message);}catch{error="Malformed bridge event.";}
    if(code!==0&&!error)error="Generation backend did not complete.";
  }catch{if(!interrupted)error="Generation worker/bridge failed; inspect its private attempt logs.";}
  finally {
    if(child?.pid && child.exitCode===null && child.signalCode===null){
      stopGroup(child.pid,"SIGTERM");
      const kill=setTimeout(()=>stopGroup(child!.pid!,"SIGKILL"),500);
      await Promise.race([ended??Promise.resolve(null),new Promise(ok=>setTimeout(ok,1200))]);clearTimeout(kill);
      if(child.exitCode===null&&child.signalCode===null)throw new Error("Python ownership did not settle; preserve the active owner for recovery.");
    }
  }
  await writeFile(await safePath(root,out),stdout,{flag:"wx",mode:0o600});await writeFile(await safePath(root,err),stderr,{flag:"wx",mode:0o600});
  await lock(root,async()=>{
    run=await loadGeneration(root);if(run.state.active?.token!==token)return;
    let requests=0,journalHash:string|null=null,caches:Record<string,string>={};
    try{const ledger=await requestLedger(root);requests=ledger.requests;journalHash=ledger.journalHash;caches=await cacheHashes(root);}catch{error="Request/cache integrity could not be verified; inspect artifacts before replay.";complete=false;}
    try{await verifyBackend(run);}catch{error="Backend identity/configuration changed during generation.";complete=false;}
    const checkpointHash=await fileHash(await safePath(root,"forge.json")).catch(()=>null);
    const status=interrupted?"paused":budget||requests>=run.spec.maxRequests&&!complete?"budget_exhausted":complete&&checkpointHash&&!error?"completed":"blocked";
    const receipt:GenerationReceipt={version:1,id,contractHash:run.state.contractHash,status,elapsedMs:Math.max(0,Date.now()-startedAt),requests,checkpointHash,requestJournalHash:journalHash,cacheHashes:caches,message:error||(status==="completed"?"Generation completed; proposals remain unverified research ideas.":status==="paused"?"Generation paused. Reserved requests remain charged.":"Generation stopped by its budget."),startedAt:new Date(startedAt).toISOString(),endedAt:new Date().toISOString(),logs:[{path:out,hash:await fileHash(await safePath(root,out))},{path:err,hash:await fileHash(await safePath(root,err))}]};
    await exclusiveJson(await safePath(root,`receipts/${id}.json`),receipt);
    run.state.receipts.push({id,hash:await fileHash(await safePath(root,`receipts/${id}.json`))});run.state.spentMs+=receipt.elapsedMs;run.state.status=status;run.state.message=receipt.message;delete run.state.active;await saveGeneration(run,"attempt_finished");
  });
}
void main(process.argv[2]!,process.argv[3]!).catch(()=>{process.exitCode=1;});
