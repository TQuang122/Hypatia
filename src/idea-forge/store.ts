import {mkdir,readFile,readdir,realpath,lstat} from "node:fs/promises";
import {join} from "node:path";
import {safePath,json,objectHash,appendSynced,atomicJson,readBounded} from "../experiments/files.js";
import {slug} from "../experiments/schema.js";
import type {Generation,GenerationSpec,GenerationState} from "./types.js";
export {lock} from "../experiments/store.js";
export async function generationRoot(workspace:string,name:string){return safePath(await realpath(workspace),`experiments/idea-forge/${slug(name)}`);}
export async function loadGeneration(root:string):Promise<Generation>{
  const spec=await json<GenerationSpec>(await safePath(root,"contract.json"));
  const text=(await readBounded(await safePath(root,"events.jsonl"),16*1024*1024)).toString("utf8");
  if(!text.endsWith("\n"))throw new Error("Generation journal is incomplete.");
  let previous="",state:GenerationState|undefined;
  for(const [seq,line]of text.trimEnd().split("\n").entries()){
    const event=JSON.parse(line),{hash,...body}=event;
    if(event.seq!==seq+1||event.previousHash!==previous||objectHash(body)!==hash||event.state.contractHash!==objectHash(spec))throw new Error("Generation journal/contract integrity failed.");
    previous=hash;state=event.state;
  }
  if(!state||spec.version!==1)throw new Error("Invalid generation state.");
  return {root,spec,state};
}
export async function saveGeneration(run:Generation,kind:string){
  const path=await safePath(run.root,"events.jsonl");
  const text=await readFile(path,"utf8").catch((error:NodeJS.ErrnoException)=>{if(error.code!=="ENOENT")throw error;return "";});
  if(text&&!text.endsWith("\n"))throw new Error("Refusing to append incomplete generation journal.");
  const lines=text.trimEnd()?text.trimEnd().split("\n"):[];
  const previous=lines.length?JSON.parse(lines.at(-1)!):undefined;
  run.state.updatedAt=new Date().toISOString();
  const body={seq:lines.length+1,previousHash:previous?.hash??"",kind,state:run.state};
  await appendSynced(path,JSON.stringify({...body,hash:objectHash(body)})+"\n");await atomicJson(await safePath(run.root,"state.json"),run.state);
}
export async function listGenerations(workspace:string){
  const base=await safePath(await realpath(workspace),"experiments/idea-forge");
  const dirs=await readdir(base,{withFileTypes:true}).catch(()=>[]),runs:Generation[]=[];
  for(const dir of dirs)if(dir.isDirectory()&&!dir.isSymbolicLink()&&await lstat(join(base,dir.name,"contract.json")).catch(()=>undefined))runs.push(await loadGeneration(await safePath(base,dir.name)));
  return runs.sort((a,b)=>b.state.updatedAt.localeCompare(a.state.updatedAt));
}
