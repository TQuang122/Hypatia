import {readdir,writeFile,mkdir} from "node:fs/promises";
import {join} from "node:path";
import {safePath,fileHash,json,readBounded,objectHash,hash} from "../experiments/files.js";
import type {Generation,GenerationReceipt,IdeaChoice} from "./types.js";
export async function requestLedger(root:string){
  const path=await safePath(root,"requests.jsonl");
  const text=await readBounded(path,16*1024*1024).then(bytes=>bytes.toString("utf8")).catch((error:NodeJS.ErrnoException)=>{if(error.code!=="ENOENT")throw error;return "";});
  if(text&&!text.endsWith("\n"))throw new Error("Request journal is incomplete; no replay was started.");
  const events:any[]=[];let previous="";
  for(const line of text.trimEnd()?text.trimEnd().split("\n"):[]){
    const event=JSON.parse(line),{hash:claimed,...body}=event;
    if(event.seq!==events.length+1||event.previousHash!==previous||objectHash(body)!==claimed)throw new Error("Request journal integrity failed.");
    previous=claimed;events.push(event);
  }
  const reservations=events.filter(event=>event.kind==="request_reserved");
  if(reservations.some((event,index)=>event.data.request!==index+1))throw new Error("Request accounting is not sequential.");
  for(const event of events.filter(e=>e.kind==="response_cached")){
    if(!/^[a-f0-9]{64}$/.test(event.data.key)||await fileHash(await safePath(root,`cache/${event.data.key}.json`))!==event.data.hash)throw new Error("Cached model response changed.");
  }
  return {requests:reservations.length,events,journalHash:text?hash(text):null};
}
export async function generationReceipt(run:Generation,id:string){
  const ref=run.state.receipts.find(item=>item.id===id);if(!ref)throw new Error("Generation receipt not recorded.");
  const path=await safePath(run.root,`receipts/${id}.json`);
  if(await fileHash(path)!==ref.hash)throw new Error("Generation receipt checksum mismatch.");
  const receipt=await json<GenerationReceipt>(path);
  if(receipt.id!==id||receipt.contractHash!==run.state.contractHash)throw new Error("Generation receipt binding mismatch.");
  return receipt;
}
export async function verifyGeneration(run:Generation){
  const ledger=await requestLedger(run.root);
  if(ledger.requests>run.spec.maxRequests)throw new Error("Observed requests exceeded the frozen cap.");
  if(run.state.status==="completed"){
    const last=run.state.receipts.at(-1);if(!last)throw new Error("Completed generation has no receipt.");
    const receipt=await generationReceipt(run,last.id);
    if(receipt.requestJournalHash!==ledger.journalHash||receipt.checkpointHash!==await fileHash(await safePath(run.root,"forge.json")))throw new Error("Completed generation evidence changed.");
    if(objectHash(await cacheHashes(run.root))!==objectHash(receipt.cacheHashes))throw new Error("Generation cache inventory changed.");
    for(const artifact of receipt.logs)if(await fileHash(await safePath(run.root,artifact.path))!==artifact.hash)throw new Error("Generation logs changed.");
  }
  return ledger;
}
export async function generationIdeas(run:Generation):Promise<IdeaChoice[]>{
  await verifyGeneration(run);if(run.state.status!=="completed")return [];
  const data=await json<any>(await safePath(run.root,"forge.json"),16*1024*1024);
  if(data.module!=="idea_forge"||!Array.isArray(data.results)||data.results.length!==1||data.results[0].seed_key!==run.spec.seedHash)throw new Error("Forge checkpoint is not bound to the frozen seed.");
  if(objectHash(data.config.idea_models)!==objectHash(run.spec.modelPanel)||objectHash(data.config.b_ids)!==objectHash([run.spec.direction]))throw new Error("Forge checkpoint panel/direction mismatch.");
  const plans=data.results[0].results;if(!Array.isArray(plans))throw new Error("Invalid Forge results.");
  return plans.flatMap((item:any,index:number)=>typeof item.plan==="string"&&item.plan.trim()&&!/^(?:生成失败|计划书生成失败)$/.test(item.plan.trim())&&item.b_id===run.spec.direction?[{index:index+1,title:String(item.title||data.results[0].seed_title||run.spec.topic),direction:item.b_id,sourceModel:String(item.source_model||"unavailable"),idea:String(item.idea_text||""),plan:item.plan.trim(),validation:item.validation??null,consensus:item.consensus_check??null}]:[]);
}
export async function exportGenerationIdea(run:Generation,index:number){
  const ideas=await generationIdeas(run),selected=ideas.find(idea=>idea.index===index);if(!selected)throw new Error("Choose a completed executable proposal.");
  const forgeHash=await fileHash(await safePath(run.root,"forge.json"));
  const metadata={version:1,runRoot:run.root,contractHash:run.state.contractHash,forgeHash,index};
  const body=[`# ${selected.title}`,...(selected.idea.trim()?["## 1. Research idea",selected.idea.trim()]:[]),"## 2. Execution plan",selected.plan].join("\n\n")+"\n";
  const content=`<!-- hypatia-idea-forge\n${JSON.stringify(metadata)}\n-->\n\n${body}`;
  await mkdir(await safePath(run.root,"ideas"),{recursive:true});const path=await safePath(run.root,`ideas/idea-${index}.md`);
  await writeFile(path,content,{flag:"wx",mode:0o600}).catch(async(error:NodeJS.ErrnoException)=>{if(error.code!=="EEXIST"|| (await readBounded(path)).toString("utf8")!==content)throw error;});
  return {path,selected};
}
export async function cacheHashes(root:string){
  const entries=await readdir(await safePath(root,"cache")).catch(()=>[]);const hashes:Record<string,string>={};
  for(const entry of entries){if(!/^[a-f0-9]{64}\.json$/.test(entry))throw new Error("Unexpected generation cache file.");hashes[`cache/${entry}`]=await fileHash(await safePath(root,`cache/${entry}`));}return hashes;
}
