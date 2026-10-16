import {readBounded,hash,fileHash,safePath} from "../experiments/files.js";
import {loadGeneration} from "./store.js";
import {generationIdeas} from "./evidence.js";
import type {ImportedIdea} from "../experiments/import-autoresearch.js";
export async function importGeneratedIdea(source:string):Promise<ImportedIdea>{
  const bytes=await readBounded(source),text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  const prefix="<!-- hypatia-idea-forge\n",suffix="\n-->",end=text.indexOf(suffix,prefix.length);
  if(!text.startsWith(prefix)||end<0)throw new Error("Invalid generated idea header.");
  const meta=JSON.parse(text.slice(prefix.length,end));
  if(meta.version!==1||typeof meta.runRoot!=="string"||!Number.isInteger(meta.index)||meta.index<1||Object.keys(meta).some(key=>!["version","runRoot","contractHash","forgeHash","index"].includes(key)))throw new Error("Invalid generated idea provenance.");
  const run=await loadGeneration(meta.runRoot),idea=(await generationIdeas(run)).find(item=>item.index===meta.index);
  if(!idea||run.state.contractHash!==meta.contractHash||await fileHash(await safePath(run.root,"forge.json"))!==meta.forgeHash)throw new Error("Generated idea no longer matches its sealed generation receipt.");
  const body=[`# ${idea.title}`,...(idea.idea.trim()?["## 1. Research idea",idea.idea.trim()]:[]),"## 2. Execution plan",idea.plan].join("\n\n")+"\n";
  if(text.slice(end+suffix.length).replace(/^[\r\n]+/,"")!==body)throw new Error("Generated idea content changed after selection.");
  const snapshots=[{path:"inputs/idea-original.txt",bytes}];
  for(const [path,target]of [["forge.json","forge.json"],["contract.json","generation-contract.json"],[`knowledge_base/${run.spec.knowledgeFile}`,"knowledge.md"],["requests.jsonl","generation-requests.jsonl"]]){
    const input=await readBounded(await safePath(run.root,path!),16*1024*1024);snapshots.push({path:`inputs/${target}`,bytes:input});
  }
  const receipt=run.state.receipts.at(-1)!;snapshots.push({path:"inputs/generation-receipt.json",bytes:await readBounded(await safePath(run.root,`receipts/${receipt.id}.json`))});
  return {body,provenance:{version:1,kind:"hypatia-idea-forge",source,sourceHash:hash(bytes),ideaHash:hash(body),generationRoot:run.root,generationContractHash:run.state.contractHash,generationReceiptHash:receipt.hash,forgeHash:meta.forgeHash,index:meta.index,knowledgeDirection:run.spec.direction,knowledgeHash:run.spec.knowledgeHash,knowledgeSources:run.spec.knowledgeSources??[],backendRevision:run.spec.backend.revision,sourceModel:idea.sourceModel,verification:"unverified research proposal; model votes are not scientific validation"},snapshots};
}
