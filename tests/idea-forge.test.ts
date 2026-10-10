import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from "node:fs/promises";
import {createServer,type Server} from "node:http";
import {tmpdir} from "node:os";
import {join,resolve,relative} from "node:path";
import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {legacyGenerateIdeasDialog as generateIdeasDialog} from "../extensions/research-tools/idea-forge.js";
import type {ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import test,{type TestContext} from "node:test";
import * as forge from "../src/idea-forge/index.js";
import {requestLedger} from "../src/idea-forge/evidence.js";
import {importIdea} from "../src/experiments/import-autoresearch.js";
const backendRoot=process.env.HYPATIA_AUTORESEARCH_TEST_ROOT??resolve(process.cwd(),"../AutoResearch");
const actualBackend=existsSync(join(backendRoot,".venv/bin/python"));
const integrationTest=actualBackend&&process.platform!=="win32"?test:test.skip;
async function fixture(t:TestContext,options:{cap?:number;delay?:number;reject?:boolean;sameResponseModel?:boolean}={}){
  const cwd=await mkdtemp(join(tmpdir(),"forge fixture space-"));
  let requests=0;const models:string[]=[];const prompts:string[]=[];const timers=new Set<ReturnType<typeof setTimeout>>();
  const server=createServer((request,response)=>{
    let raw="";request.on("data",chunk=>raw+=chunk);request.on("end",()=>{
      requests++;const payload=JSON.parse(raw);models.push(payload.model);
      const prompt=payload.messages.at(-1).content;prompts.push(prompt);
      const content=options.reject?"NO_MATCH":prompt.includes("=== 方案 ===")?"D1通过\nD2通过\nD3通过\nD4无\nverdict: 通过":prompt.includes("请判断以下 idea 是否违反")?"最终判定: 通过\nSynthetic fixture only":prompt.includes("制定可执行计划书")?"# Synthetic fixture execution plan\nUse a controlled fixture benchmark, record the baseline, and compare one bounded candidate. No scientific claim.":`核心idea: Synthetic fixture ${payload.model}\nMechanism: bounded search improves a fixture metric under a fixed budget. Freeze data and seeds, compare a baseline, and record uncertainty. This is synthetic test data, not a research finding.`;
      const timer=setTimeout(()=>{timers.delete(timer);response.setHeader("content-type","application/json");response.end(JSON.stringify({model:options.sameResponseModel?"one-aliased-model":payload.model,choices:[{message:{content},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));},options.delay??0);timers.add(timer);
    });
  });
  await new Promise<void>(ok=>server.listen(0,"127.0.0.1",ok));
  const port=(server.address() as {port:number}).port;
  const config=join(cwd,"providers.json");const panel=["fixture-a","fixture-b","fixture-c"];
  await writeFile(config,JSON.stringify({profiles:Object.fromEntries(panel.map(alias=>[alias,{api:"openai_chat",model:alias,base_url:`http://127.0.0.1:${port}/v1`,api_key:"synthetic-fixture",proxy_contract:"direct",transport:"httpx"}])),roles:{ideator:{models:panel},planner:{models:[panel[0]]},consensus_checker:{models:[panel[1]]},freshness_refresher:{models:[panel[2]]}},request_defaults:{max_tokens:1024,temperature:0.3},execution:{max_concurrency:1}}));
  const keys=["AUTORESEARCH_CONFIG","AR_MODEL_IDEATOR","AR_MODEL_PLANNER","AR_MODEL_CONSENSUS_CHECKER","AR_MODEL_FRESHNESS_REFRESHER"];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));process.env.AUTORESEARCH_CONFIG=config;process.env.AR_MODEL_IDEATOR=panel.join(",");process.env.AR_MODEL_PLANNER=panel[0];process.env.AR_MODEL_CONSENSUS_CHECKER=panel[1];process.env.AR_MODEL_FRESHNESS_REFRESHER=panel[2];
  t.after(async()=>{for(const timer of timers)clearTimeout(timer);server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}await rm(cwd,{recursive:true,force:true});});
  const backend=await forge.inspectBackend(backendRoot,undefined,panel);
  assert.equal(requests,0,"offline preflight must never contact a model");assert.equal(backend.ready,true);
  const input={slug:"fixture-ideas",topic:"Synthetic bounded-search mechanism",signal:"Controlled fixture signal; no real scientific outcome\nSECOND-LINE-MECHANISM must reach the model",direction:"agent_memory",modelPanel:panel,maxRequests:options.cap??24,maxWallSeconds:30,maxTokens:1024,requestTimeoutSeconds:10,resourceDescription:"Synthetic local CPU fixture only"};
  const run=await forge.createGeneration(cwd,input,backend);
  return {cwd,run,backend,input,panel,config,requests:()=>requests,models,prompts};
}
integrationTest("real AutoResearch pipeline with localhost models generates proposals and seals import provenance",async t=>{
  const f=await fixture(t);await assert.rejects(forge.startGeneration(f.cwd,f.input.slug),/Approve/);assert.equal(f.requests(),0);
  await forge.approveGeneration(f.cwd,f.input.slug);await forge.startGeneration(f.cwd,f.input.slug);const result=await forge.waitGeneration(f.cwd,f.input.slug);
  assert.equal(result.state.status,"completed",result.state.message??"");
  assert.ok(f.prompts.slice(0,3).every(prompt=>prompt.includes("SECOND-LINE-MECHANISM")));
  const ledger=await requestLedger(result.root);assert.equal(ledger.requests,f.requests());assert.ok(ledger.requests>3&&ledger.requests<=24);
  assert.ok(ledger.events.some(e=>e.kind==="request_finished"&&e.data.responseModel==="fixture-a"&&e.data.usage.total_tokens===15),JSON.stringify(ledger.events.filter(e=>e.kind==="request_finished").slice(0,2)));
  const ideas=await forge.generationIdeas(result);assert.equal(ideas.length,3);
  const exported=await forge.exportGenerationIdea(result,ideas[0]!.index);const imported=await importIdea(exported.path);
  assert.equal(imported.provenance.kind,"hypatia-idea-forge");assert.equal(imported.provenance.verification,"unverified research proposal; model votes are not scientific validation");assert.ok(imported.snapshots.some(item=>item.path==="inputs/generation-receipt.json"));
  const cached=await forge.startGeneration(f.cwd,f.input.slug);assert.equal(cached.cached,true);assert.equal(f.requests(),ledger.requests);
  await writeFile(exported.path,(await readFile(exported.path,"utf8")).replace("## 2. Execution plan","## fabricated"));await assert.rejects(importIdea(exported.path),/content changed/);
});
integrationTest("request cap persists and cannot be reset by replay",async t=>{
  const f=await fixture(t,{cap:2});await forge.approveGeneration(f.cwd,f.input.slug);await forge.startGeneration(f.cwd,f.input.slug);const result=await forge.waitGeneration(f.cwd,f.input.slug);
  assert.equal(result.state.status,"budget_exhausted",result.state.message??"");assert.equal(f.requests(),2);assert.equal((await requestLedger(result.root)).requests,2);
  await assert.rejects(forge.startGeneration(f.cwd,f.input.slug),/budget.*exhausted/);assert.equal(f.requests(),2);assert.deepEqual(await forge.generationIdeas(result),[]);
});
integrationTest("pause/resume reuses completed response checkpoints instead of repeating model requests",async t=>{
  const f=await fixture(t,{delay:250});await forge.approveGeneration(f.cwd,f.input.slug);await forge.startGeneration(f.cwd,f.input.slug);
  for(let i=0;i<100;i++){const ledger=await requestLedger(f.run.root).catch(()=>({events:[]}));if(ledger.events.filter((e:any)=>e.kind==="response_cached").length>=1)break;await new Promise(ok=>setTimeout(ok,50));}
  await forge.pauseGeneration(f.cwd,f.input.slug);const paused=await forge.waitGeneration(f.cwd,f.input.slug);assert.equal(paused.state.status,"paused",paused.state.message??"");
  const firstCount=f.models.filter(model=>model==="fixture-a").length;
  await forge.startGeneration(f.cwd,f.input.slug);const completed=await forge.waitGeneration(f.cwd,f.input.slug);assert.equal(completed.state.status,"completed",completed.state.message??"");
  const stdout=await readFile(join(completed.root,`attempts/${completed.state.receipts.at(-1)!.id}/stdout.jsonl`),"utf8");assert.match(stdout,/cached_response/);
  const ledger=await requestLedger(completed.root);assert.equal(ledger.requests,f.requests());assert.ok(firstCount>=1);
});
integrationTest("zero accepted proposals is a completed generation outcome",async t=>{
  const f=await fixture(t,{reject:true});await forge.approveGeneration(f.cwd,f.input.slug);await forge.startGeneration(f.cwd,f.input.slug);const result=await forge.waitGeneration(f.cwd,f.input.slug);assert.equal(result.state.status,"completed");assert.equal(f.requests(),3);assert.deepEqual(await forge.generationIdeas(result),[]);
});
integrationTest("duplicate semantic model aliases, frozen knowledge edits and corrupted journal fail closed",async t=>{
  const f=await fixture(t);
  await assert.rejects(forge.createGeneration(f.cwd,{...f.input,slug:"duplicate",modelPanel:[f.panel[0]!,f.panel[0]!,f.panel[2]!]},f.backend),/unique/);
  await writeFile(join(f.run.root,"knowledge_base",f.run.spec.knowledgeFile),"tampered");await assert.rejects(forge.approveGeneration(f.cwd,f.input.slug),/snapshot changed/);assert.equal(f.requests(),0);
  await writeFile(join(f.run.root,"requests.jsonl"),'{"broken":true}');await assert.rejects(requestLedger(f.run.root),/incomplete/);
});

integrationTest("generation wizard declines API approval and leaves an inspectable planned contract",async t=>{
  const f=await fixture(t);const agent=join(f.cwd,"agent");await mkdir(agent);await writeFile(join(agent,"autoresearch-backend.json"),JSON.stringify({root:backendRoot}));
  const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agent;t.after(()=>{if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;});
  const inputs=["ui-ideas","Synthetic signal","","","","","",""];let approvals=0;let description="";
  const ctx={cwd:f.cwd,mode:"tui",hasUI:true,ui:{input:async()=>inputs.shift(),editor:async()=>"Controlled fixture mechanism",select:async(title:string,options:string[])=>title.includes("knowledge")?options.find(option=>option.startsWith("agent_memory")):options[0],confirm:async(_title:string,text:string)=>{approvals++;description=text;return false;},notify(){}}} as unknown as ExtensionCommandContext;
  await generateIdeasDialog(ctx);const planned=await forge.generationStatus(f.cwd,"ui-ideas");
  assert.equal(planned.state.status,"planned");assert.equal(planned.state.active,undefined);assert.equal(f.requests(),0);assert.equal(approvals,1);assert.match(description,/24 API attempts/);assert.match(description,/One seed × one direction/);
});

test("portable request journal validation rejects partial writes, changed hashes and missing cached responses",async t=>{
  const root=await mkdtemp(join(tmpdir(),"forge-journal-"));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,"requests.jsonl"),'{"seq":1}');await assert.rejects(requestLedger(root),/incomplete/);
  await writeFile(join(root,"requests.jsonl"),JSON.stringify({seq:1,previousHash:"",kind:"request_reserved",data:{request:1},hash:"fabricated"})+"\n");await assert.rejects(requestLedger(root),/integrity/);
});

integrationTest("contradictory response identities cannot count one model as independent panel seats",async t=>{
  const f=await fixture(t,{sameResponseModel:true});await forge.approveGeneration(f.cwd,f.input.slug);await forge.startGeneration(f.cwd,f.input.slug);const result=await forge.waitGeneration(f.cwd,f.input.slug);
  assert.equal(result.state.status,"blocked");assert.match(result.state.message??"",/same model/);assert.equal(f.requests(),2);assert.deepEqual(await forge.generationIdeas(result),[]);
});

integrationTest("explicit provider config survives a different global config and worker workspace",async t=>{
  const f=await fixture(t,{reject:true});
  process.env.AUTORESEARCH_CONFIG=join(f.cwd,"missing-global-config.json");
  const backend=await forge.inspectBackend(backendRoot,undefined,f.panel,f.config);assert.equal(backend.ready,true);
  const input={...f.input,slug:"isolated-config"};await forge.createGeneration(f.cwd,input,backend);await forge.approveGeneration(f.cwd,input.slug);
  delete process.env.AUTORESEARCH_CONFIG;
  await forge.startGeneration(f.cwd,input.slug);const result=await forge.waitGeneration(f.cwd,input.slug);
  assert.equal(result.state.status,"completed",result.state.message??"");assert.equal(result.spec.backend.providerConfig,f.config);assert.equal(f.requests(),3);
});

integrationTest("relative provider config resolves against backend root when caller cwd differs",async t=>{
  const f=await fixture(t);
  const output=await new Promise<string>((ok,no)=>{
    const child=spawn(join(backendRoot,".venv/bin/python"),["-B",join(process.cwd(),"scripts/idea-forge-bridge.py"),"inspect",backendRoot],{cwd:f.cwd,stdio:["pipe","pipe","pipe"],env:{...process.env,AUTORESEARCH_CONFIG:relative(backendRoot,f.config),PYTHONDONTWRITEBYTECODE:"1",PYTHONUTF8:"1"}});
    let text="";child.stdout.on("data",chunk=>text+=String(chunk));child.stderr.resume();child.on("error",no);child.on("close",code=>code===0?ok(text):no(new Error("Relative configuration preflight failed")));child.stdin.end("{}");
  });
  assert.equal(JSON.parse(output).ready,true);assert.equal(f.requests(),0);
});
