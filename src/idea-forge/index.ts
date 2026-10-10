import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {mkdir,realpath,writeFile} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {alive,exclusiveJson,fileHash,hash,objectHash,safePath,readBounded} from "../experiments/files.js";
import {slug} from "../experiments/schema.js";
import {inspectNativeBackend,prepareNativeGeneration,verifyNativeBackend} from "./native-backend.js";
import {inspectBackend} from "./backend.js";
import {generationRoot,loadGeneration,saveGeneration,listGenerations,lock} from "./store.js";
import {requestLedger,verifyGeneration,generationIdeas,exportGenerationIdea,generationReceipt} from "./evidence.js";
import type {Backend,GenerationInput,GenerationSpec,Generation,GenerationReceipt} from "./types.js";
export {nativeKnowledge} from "./knowledge.js";
export {inspectBackend,inspectNativeBackend,listGenerations,generationIdeas,exportGenerationIdea,generationReceipt,requestLedger};
export type {Backend,GenerationInput,GenerationSpec,Generation,GenerationReceipt,IdeaChoice} from "./types.js";
export async function createGeneration(workspace:string,input:GenerationInput,backend:Backend):Promise<Generation>{
  slug(input.slug);workspace=await realpath(workspace);
  for(const field of ["topic","signal","resourceDescription"] as const)if(typeof input[field]!=="string"||!input[field].trim()||input[field].length>20000)throw new Error(`${field} is required and bounded.`);
  for(const [field,max]of [["maxRequests",100],["maxWallSeconds",3600],["maxTokens",8192],["requestTimeoutSeconds",300]] as const)if(!Number.isInteger(input[field])||input[field]<1||input[field]>max)throw new Error(`${field} must be in 1..${max}.`);
  if(input.requestTimeoutSeconds>input.maxWallSeconds)throw new Error("Request timeout exceeds generation time budget.");
  let current:Backend, knowledge:Buffer, direction:{id:string;file:string;hash:string};
  if(backend.kind==="native") {
    if(input.modelPanel.length<1||input.modelPanel.length>6)throw new Error("Select 1..6 Hypatia models.");
    const prepared=await prepareNativeGeneration(workspace,input,backend);current=prepared.current;
    direction=prepared.knowledge;knowledge=Buffer.from(prepared.knowledge.text);
  } else {
    if(input.modelPanel.length<3||input.modelPanel.length>6||new Set(input.modelPanel).size!==input.modelPanel.length)throw new Error("Select 3..6 unique model aliases.");
    current=await inspectBackend(backend.root,backend.python,input.modelPanel,backend.providerConfig);
    if(current.configHash!==backend.configHash||current.sourceHash!==backend.sourceHash||current.bridgeHash!==backend.bridgeHash)throw new Error("Preflight changed; inspect and approve the new backend configuration.");
    if(!current.ready)throw new Error("Configure at least three distinct ready panel models and available planner/consensus/freshness roles in AutoResearch.");
    const identities=input.modelPanel.map(alias=>current.models.find(model=>model.alias===alias&&model.ready&&model.transport==="httpx")?.identity);
    if(identities.some(value=>!value)||new Set(identities).size!==identities.length)throw new Error("Panel aliases must resolve to distinct available models.");
    const selected=current.directions.find(item=>item.id===input.direction);if(!selected||!/^[\w-]+\.md$/.test(selected.file))throw new Error("Select an available knowledge direction.");
    direction=selected;knowledge=await readBounded(await safePath(current.root,`knowledge_base/${direction.file}`));if(hash(knowledge)!==direction.hash)throw new Error("Knowledge changed after preflight.");
  }
  const root=await generationRoot(workspace,input.slug);await mkdir(await safePath(workspace,"experiments/idea-forge"),{recursive:true});await mkdir(root);
  await mkdir(await safePath(root,"knowledge_base"));await writeFile(await safePath(root,`knowledge_base/${direction.file}`),knowledge,{flag:"wx",mode:0o600});
  await mkdir(await safePath(root,"receipts"));
  const spec:GenerationSpec={...input,direction:direction.id,version:1,workspace,createdAt:new Date().toISOString(),sourceUrl:input.sourceUrl??"",seedHash:objectHash({topic:input.topic,signal:input.signal,sourceUrl:input.sourceUrl??""}),backend:current,knowledgeFile:direction.file,knowledgeHash:direction.hash};
  await exclusiveJson(await safePath(root,"contract.json"),spec);
  const run:Generation={root,spec,state:{version:1,contractHash:objectHash(spec),status:"planned",spentMs:0,receipts:[],updatedAt:spec.createdAt}};
  await lock(root,()=>saveGeneration(run,"created"));return run;
}
export async function generationStatus(workspace:string,name:string){return loadGeneration(await generationRoot(workspace,name));}
export async function approveGeneration(workspace:string,name:string){const root=await generationRoot(workspace,name);return lock(root,async()=>{const run=await loadGeneration(root);if(run.state.active||run.state.status!=="planned")throw new Error("Approve only a planned generation contract.");await verifyBackend(run);run.state.approval=run.state.contractHash;run.state.status="ready";await saveGeneration(run,"approved");return run;});}
export async function verifyBackend(run:Generation){
  if(run.spec.backend.kind==="native")return verifyNativeBackend(run);
  const {spec}=run;
  if(await fileHash(spec.backend.bridge)!==spec.backend.bridgeHash||await fileHash(await realpath(spec.backend.python))!==spec.backend.pythonHash)throw new Error("Python/bridge identity changed; create a new generation contract.");
  if(await fileHash(await safePath(run.root,`knowledge_base/${spec.knowledgeFile}`))!==spec.knowledgeHash)throw new Error("Frozen knowledge snapshot changed.");
  const backend=await inspectBackend(spec.backend.root,spec.backend.python,spec.modelPanel,spec.backend.providerConfig);
  if(backend.configHash!==spec.backend.configHash||backend.sourceHash!==spec.backend.sourceHash||!backend.ready)throw new Error("AutoResearch configuration/credential environment/source changed; create a new generation contract.");
}
export async function pauseGeneration(workspace:string,name:string){const root=await generationRoot(workspace,name);return lock(root,async()=>{const run=await loadGeneration(root);if(run.state.status==="completed")return run;run.state.status=run.state.active?"pause_requested":"paused";await saveGeneration(run,"pause_requested");return run;});}
export async function recoverGeneration(run:Generation){
  const active=run.state.active;if(!active||alive(active.workerPid))return;
  if(active.launchPending||alive(active.childPid))throw new Error("Interrupted launch/known live backend process prevents replay. Inspect and stop it, then use forge-recover to acknowledge the stopped launch.");
  const receiptPath=await safePath(run.root,`receipts/${active.id}.json`);
  let receipt:GenerationReceipt|undefined;
  try{receipt=JSON.parse((await readBounded(receiptPath)).toString("utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  if(receipt){if(receipt.id!==active.id||receipt.contractHash!==run.state.contractHash)throw new Error("Interrupted generation receipt is not bound to this run.");run.state.receipts.push({id:receipt.id,hash:await fileHash(receiptPath)});run.state.spentMs+=receipt.elapsedMs;run.state.status=receipt.status;run.state.message=receipt.message;}
  else{run.state.spentMs=run.spec.maxWallSeconds*1000;run.state.status="blocked";run.state.message="Worker disappeared without a receipt; the time budget is charged conservatively. Model request reservations remain charged; inspect artifacts or start a new contract.";}
  delete run.state.active;await saveGeneration(run,"recovered");
}
export async function acknowledgeGenerationStopped(workspace:string,name:string){const root=await generationRoot(workspace,name);return lock(root,async()=>{const run=await loadGeneration(root);if(!run.state.active||alive(run.state.active.workerPid)||alive(run.state.active.childPid))throw new Error("No interrupted stopped launch is available to acknowledge.");delete run.state.active.launchPending;await saveGeneration(run,"user_acknowledged_stopped_launch");await recoverGeneration(run);return run;});}
export async function startGeneration(workspace:string,name:string){
  const root=await generationRoot(workspace,name);
  return lock(root,async()=>{
    const run=await loadGeneration(root);
    if(process.platform==="win32"&&run.spec.backend.kind!=="native")throw new Error("Legacy AutoResearch Python generation requires macOS/Linux.");
    await recoverGeneration(run);
    if(run.state.active)throw new Error("A generation worker still owns this run.");
    if(run.state.status==="completed"){await verifyGeneration(run);return {run,cached:true};}
    if(run.state.approval!==run.state.contractHash)throw new Error("Approve this generation contract in the TUI first.");
    if((await requestLedger(root)).requests>=run.spec.maxRequests||run.state.spentMs>=run.spec.maxWallSeconds*1000)throw new Error("Persisted request/time budget is exhausted.");
    await verifyBackend(run);
    const id=randomUUID(),token=randomUUID();await mkdir(await safePath(root,`attempts/${id}`),{recursive:true});
    run.state.active={id,token,workerPid:0,startedAt:Date.now(),launchPending:true};run.state.status="running";await saveGeneration(run,"worker_reserved");
    const here=fileURLToPath(import.meta.url),worker=here.endsWith(".ts")?resolve(dirname(here),"../../dist/idea-forge/worker.js"):join(dirname(here),"worker.js");
    const child=spawn(process.env.HYPATIA_NODE_EXECUTABLE??process.execPath,[worker,root,token],{detached:true,stdio:"ignore",cwd:run.spec.workspace,env:process.env});
    try{await new Promise<void>((ok,no)=>{child.once("spawn",ok);child.once("error",no);});run.state.active.workerPid=child.pid!;run.state.active.launchPending=false;child.unref();await saveGeneration(run,"worker_started");}catch(error){delete run.state.active;run.state.status="blocked";await saveGeneration(run,"worker_start_failed");throw error;}
    return {run,cached:false};
  });
}
export async function waitGeneration(workspace:string,name:string,options:{signal?:AbortSignal;onStatus?:(run:Generation,requests:number)=>void}={}){
  let stopping=false;
  while(true){
    const run=await generationStatus(workspace,name);
    if(!run.state.active){await verifyGeneration(run);return run;}
    if(options.signal?.aborted&&!stopping){stopping=true;await pauseGeneration(workspace,name);}
    if(!alive(run.state.active.workerPid))await lock(run.root,async()=>recoverGeneration(await loadGeneration(run.root)));
    options.onStatus?.(run,await requestLedger(run.root).then(ledger=>ledger.requests).catch(()=>-1));
    await new Promise(ok=>setTimeout(ok,250));
  }
}
