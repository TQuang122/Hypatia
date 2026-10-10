import {experimentChat} from "./experiment-chat.js";
import {formatGenerationStatus,formatIdeaProposal,showIdeaForgeReader} from "./idea-forge-view.js";
import {Text,Key,matchesKey} from "@earendil-works/pi-tui";
import {readFile} from "node:fs/promises";
import {resolve,dirname,join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {getAgentDir,type ExtensionCommandContext} from "@earendil-works/pi-coding-agent";
import {backendRoot,EXPERIMENT_STATUS_KEY} from "./experiment-engine.js";
import {createExperiment} from "./experiments.js";
import type {Generation,GenerationInput} from "../../src/idea-forge/types.js";
type Runtime=typeof import("../../src/idea-forge/index.js");
let loaded:Promise<Runtime>|undefined;
export function forgeRuntime():Promise<Runtime>{return loaded??=(import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)),"../../dist/idea-forge/index.js")).href) as Promise<Runtime>).catch(error=>{loaded=undefined;throw new Error(`Idea Forge runtime unavailable. Build and restart Hypatia. ${error.message}`);});}
const owned=new Map<string,{workspace:string;name:string}>();
export async function pauseOwnedGenerations(){const runtime=await forgeRuntime().catch(()=>undefined);if(runtime)for(const run of owned.values())await runtime.pauseGeneration(run.workspace,run.name).catch(()=>{});owned.clear();}
export async function generationFooter(workspace:string){const run=(await (await forgeRuntime()).listGenerations(workspace)).find(run=>run.state.active);return run?`Idea Forge · ${run.spec.slug} · ${run.state.status}`:undefined;}
async function drive(ctx:ExtensionCommandContext,name:string){
  const runtime=await forgeRuntime(),key=`${ctx.cwd}:${name}`;
  const started=await runtime.startGeneration(ctx.cwd,name);if(started.cached)return started.run;
  owned.set(key,{workspace:ctx.cwd,name});
  let label=`Idea Forge · ${name} · Starting`,refresh=()=>{},closePanel:(()=>void)|undefined;
  const panel=ctx.mode==="tui"&&ctx.ui.custom?ctx.ui.custom<void>((tui,theme,_keys,done)=>{
    refresh=()=>tui.requestRender();closePanel=()=>done();
    return {invalidate(){},render(width:number){return new Text(`${theme.fg("accent",label)}\n\nOne signal × one direction. Requests include reserved/failed attempts.\nEsc to pause; completed responses stay cached for resume.`,1,1).render(width);},handleInput(data:string){if(matchesKey(data,Key.escape)){label="Idea Forge · Pause requested";refresh();void runtime.pauseGeneration(ctx.cwd,name).catch(()=>{});}}};
  },{overlay:true,overlayOptions:{width:"80%",anchor:"center"}}).catch(()=>{}):undefined;
  try{const finished=await runtime.waitGeneration(ctx.cwd,name,{signal:ctx.signal,onStatus:(run,count)=>{try{label=`Idea Forge · ${name} · ${count<0?"…":count}/${run.spec.maxRequests} requests · ${run.state.status}`;refresh();ctx.ui.setStatus(EXPERIMENT_STATUS_KEY,label);}catch{/* Session replacement leaves bounded worker ownership on disk. */}}});closePanel?.();await panel;return finished;}
  finally{try{closePanel?.();}catch{}owned.delete(key);try{ctx.ui.setStatus(EXPERIMENT_STATUS_KEY,undefined);}catch{}}
}
function describe(run:Generation){return [`Idea Forge · ${run.spec.slug} · ${run.state.status}`,`${run.spec.topic} · ${run.spec.direction}`,`Signal: ${run.spec.signal}`,`Source: ${run.spec.sourceUrl||"user-provided signal; source not independently verified"}`,`Compute constraints: ${run.spec.resourceDescription}`,`Panel: ${run.spec.modelPanel.join(", ")}`,`Limits: ${run.spec.maxRequests} API attempts; ${run.spec.maxWallSeconds}s total; ${run.spec.maxTokens} output tokens/request; ${run.spec.requestTimeoutSeconds}s/request.`,run.state.message??"",`Artifacts: experiments/idea-forge/${run.spec.slug}/`].join("\n");}
export async function viewGenerationStatus(ctx:ExtensionCommandContext,run:Generation,runtimeOverride?:Runtime){
  const runtime=runtimeOverride??await forgeRuntime();let requestCount:number|undefined,completedRequests:number|undefined,failedRequests:number|undefined,responseCacheCount:number|undefined,integrity="request journal not checked",proposalCount:number|undefined;
  const receipts:string[]=[];
  try{const ledger=await runtime.requestLedger(run.root);requestCount=ledger.requests;completedRequests=ledger.events.filter(event=>event.kind==="request_finished"&&event.data.outcome==="delivered").length;failedRequests=ledger.events.filter(event=>event.kind==="request_finished"&&event.data.outcome!=="delivered").length;responseCacheCount=ledger.events.filter(event=>event.kind==="response_cached").length;integrity="request journal and cached responses verified";}catch{integrity="request/cache verification failed; preserve artifacts";}
  for(const ref of run.state.receipts){try{const receipt=await runtime.generationReceipt(run,ref.id);receipts.push(`${receipt.status} · ${receipt.requests} requests · ${(receipt.elapsedMs/1000).toFixed(1)}s · checksum verified`);}catch{receipts.push("Receipt checksum/binding failed; preserve artifacts");}}
  if(run.state.status==="completed"){try{proposalCount=(await runtime.generationIdeas(run)).length;integrity+="; completed checkpoint verified";}catch{integrity+="; checkpoint/receipt verification failed";}}
  const content=formatGenerationStatus(run,{requestCount,completedRequests,failedRequests,responseCacheCount,proposalCount,integrity,receipts});
  await showIdeaForgeReader(ctx.ui,`Idea Forge status · ${run.spec.slug}`,content);
}
export async function generateIdeasDialog(ctx:ExtensionCommandContext,description=""){await experimentChat(ctx,"generate",description);}
export async function legacyGenerateIdeasDialog(ctx:ExtensionCommandContext){
  const runtime=await forgeRuntime();
  let root=await backendRoot();if(!root)root=await ctx.ui.input("AutoResearch repository root","Local clone path");if(!root)return;
  const config: {python?:string;expectedCommit?:string;providerConfig?:string}=await readFile(join(getAgentDir(),"autoresearch-backend.json"),"utf8").then(text=>JSON.parse(text) as {python?:string;expectedCommit?:string;providerConfig?:string}).catch((error:NodeJS.ErrnoException)=>{if(error.code!=="ENOENT")throw error;return {};});
  let backend=await runtime.inspectBackend(root,config.python,undefined,config.providerConfig);
  if(config.expectedCommit&&backend.revision!==config.expectedCommit)throw new Error("AutoResearch HEAD differs from expectedCommit. Review the backend update before generation.");
  const ask=async(title:string,hint:string,defaultValue?:string)=>{const text=await ctx.ui.input(title,hint);if(text===undefined)throw new Cancelled();return text.trim()||defaultValue||"";};
  const number=async(title:string,defaultValue:number,max:number)=>{while(true){const value=await ask(`${title} (Enter for ${defaultValue})`,String(defaultValue),String(defaultValue));if(/^\d+$/.test(value)&&Number(value)>=1&&Number(value)<=max)return Number(value);ctx.ui.notify(`Enter an integer in 1..${max}.`,"error");}};
  try{
    const slug=await ask("Idea generation name","up to five lowercase hyphenated words");
    const topic=await ask("Research signal title","Specific phenomenon, result, or question");
    const signal=await ctx.ui.editor("Describe the mechanism or research signal","");if(signal===undefined)throw new Cancelled();
    const sourceUrl=await ask("Signal source URL (optional)","Paper or source link");
    const directionLabels=backend.directions.map(direction=>`${direction.id} · ${direction.title}`);
    const choice=await ctx.ui.select("Choose one knowledge direction",directionLabels);if(!choice)throw new Cancelled();
    const direction=backend.directions[directionLabels.indexOf(choice)]!.id;
    const panelChoice=await ctx.ui.select("Idea model panel",[`Use configured panel: ${backend.roles.ideator.join(", ")}`,"Choose 3–6 backend model aliases"]);if(!panelChoice)throw new Cancelled();
    let modelPanel=backend.roles.ideator;
    if(panelChoice.startsWith("Choose")){modelPanel=(await ask("Model aliases (comma separated)",backend.models.filter(model=>model.ready).map(model=>model.alias).join(", "))).split(",").map(value=>value.trim()).filter(Boolean);}
    backend=await runtime.inspectBackend(root,config.python,modelPanel,config.providerConfig);
    if(!backend.ready)throw new Error("AutoResearch panel/support roles are not ready. Configure its provider credentials and at least three distinct models; generation made no API call.");
    const maxRequests=await number("Maximum API requests including failed attempts",24,100);
    const maxWallSeconds=await number("Total generation time budget in seconds",900,3600);
    const maxTokens=await number("Maximum output tokens per request",2048,8192);
    const requestTimeoutSeconds=await number("Timeout per request in seconds",Math.min(120,maxWallSeconds),Math.min(300,maxWallSeconds));
    const resourceDescription=await ask("Compute available for the proposed experiment","CPU/GPU/time constraints; Enter if unknown","Compute availability unspecified. Propose a small reproducible pilot and state its resource needs.");
    const input:GenerationInput={slug,topic,signal,sourceUrl,direction,modelPanel,maxRequests,maxWallSeconds,maxTokens,requestTimeoutSeconds,resourceDescription};
    let run=await runtime.createGeneration(ctx.cwd,input,backend);
    const approval=[describe(run),`One seed × one direction. Concurrency: 1. Planner/consensus/freshness routes: ${JSON.stringify(backend.roles)}`,`Backend: ${backend.root}\nPython: ${backend.python}\nRevision: ${backend.revision??"unavailable"}`,"Uses AutoResearch's own provider credentials. No Pi OAuth export. Freshness uses the frozen knowledge snapshot; arXiv collection is disabled for this pilot. Generated proposals and model votes remain unverified.","Approval starts model API calls within these limits. Selecting a proposal later prepares an experiment contract in chat for separate approval."].join("\n\n");
    if(!await ctx.ui.confirm("Approve bounded Idea Forge generation?",approval)){ctx.ui.notify("Generation saved as planned. No API request was sent.","info");return;}
    run=await runtime.approveGeneration(ctx.cwd,slug);run=await drive(ctx,slug);ctx.ui.notify(describe(run),run.state.status==="completed"?"info":"warning");
    if(run.state.status==="completed")await chooseIdea(ctx,run);
  }catch(error){if(error instanceof Cancelled){ctx.ui.notify("Idea setup cancelled. No generation was created.","info");return;}throw error;}
}
class Cancelled extends Error{}
async function chooseIdea(ctx:ExtensionCommandContext,run:Generation):Promise<boolean>{
  const runtime=await forgeRuntime(),ideas=await runtime.generationIdeas(run);
  if(!ideas.length){ctx.ui.notify("No executable proposal was produced. Inspect the checkpoint stage and request outcomes to distinguish rejection from provider errors.","info");return false;}
  while(true){
    const labels=ideas.map(idea=>`${idea.index}. ${idea.title.replace(/[\r\n\x00-\x1f]/g," ").slice(0,100)} · ${idea.sourceModel}`);
    const selected=await ctx.ui.select("Idea Forge proposals · unverified",labels);if(!selected)return false;
    const idea=ideas[labels.indexOf(selected)]!;
    const action=await ctx.ui.select(`Proposal ${idea.index}`,["Preview proposal","Create experiment from this proposal","Back"]);
    if(action==="Preview proposal"){const content=formatIdeaProposal(run,idea);await showIdeaForgeReader(ctx.ui,`Proposal ${idea.index} · ${idea.title}`,content);continue;}
    if(action==="Create experiment from this proposal"){
      const exported=await runtime.exportGenerationIdea(run,idea.index);
      await createExperiment(ctx,exported.path,false,{hypothesis:idea.idea.slice(0,12000)||idea.title});return true;
    }
  }
}
export async function browseGeneratedIdeas(ctx:ExtensionCommandContext):Promise<boolean>{
  const runtime=await forgeRuntime();
  while(true){
    const runs=await runtime.listGenerations(ctx.cwd);
    if(!runs.length){ctx.ui.notify("No Idea Forge runs. Choose /idea to start one.","info");return false;}
    const labels=runs.map(run=>`${run.spec.slug} · ${run.state.status} · ${run.spec.direction}`);
    const selected=await ctx.ui.select("Idea Forge generations",labels);if(!selected)return false;
    const run=runs[labels.indexOf(selected)]!;
    const operation=await ctx.ui.select(run.spec.slug,["View status",...(run.state.status==="planned"?["Approve and run"]:[]),...(run.state.active?["Request pause"]:[]),...(!run.state.active&&run.state.status!=="completed"&&run.state.status!=="planned"?["Resume approved generation"]:[]),...(run.state.status==="completed"?["View proposals"]:[]),"Back"]);
    if(operation==="View status"){await viewGenerationStatus(ctx,await runtime.generationStatus(ctx.cwd,run.spec.slug));continue;}
    if(operation==="View proposals"){if(await chooseIdea(ctx,run))return true;continue;}
    if(operation==="Request pause"){await runtime.pauseGeneration(ctx.cwd,run.spec.slug);continue;}
    if(operation==="Approve and run"){
      if(await ctx.ui.confirm("Approve model API generation?",describe(run)+`\nModels: ${run.spec.modelPanel.join(", ")}\nGeneration approval does not authorize a benchmark.`)){
        await runtime.approveGeneration(ctx.cwd,run.spec.slug);await drive(ctx,run.spec.slug);
      }
      continue;
    }
    if(operation==="Resume approved generation"){await drive(ctx,run.spec.slug);continue;}
  }
}
export async function generationCommand(action:string,name:string|undefined,ctx:ExtensionCommandContext,description?:string){
  if(!["generate","ideas","forge-status","forge-pause","forge-resume","forge-recover","forge-approve"].includes(action))return false;
  const runtime=await forgeRuntime();
  if(action==="generate"){await generateIdeasDialog(ctx,description??name??"");return true;}
  if(action==="ideas"){await browseGeneratedIdeas(ctx);return true;}
  if(!["forge-status","forge-pause","forge-resume","forge-recover","forge-approve"].includes(action))return false;
  if(!name)throw new Error("Provide an Idea Forge generation slug.");
  if(action==="forge-approve"){const run=await runtime.generationStatus(ctx.cwd,name);if(run.state.status!=="planned"){ctx.ui.notify(describe(run),"info");return true;}if(await ctx.ui.confirm("Approve model API generation?",describe(run)))ctx.ui.notify(describe(await runtime.approveGeneration(ctx.cwd,name)),"info");}
  else if(action==="forge-recover"){if(await ctx.ui.confirm("Acknowledge stopped Idea Forge launch?","Inspect and stop all processes for this interrupted launch first. Confirming cannot restore unknown API responses; reserved requests/time remain charged."))ctx.ui.notify(describe(await runtime.acknowledgeGenerationStopped(ctx.cwd,name)),"info");}
  else if(action==="forge-status"){await viewGenerationStatus(ctx,await runtime.generationStatus(ctx.cwd,name));}
  else if(action==="forge-resume"){await drive(ctx,name);await viewGenerationStatus(ctx,await runtime.generationStatus(ctx.cwd,name));}
  else if(action==="forge-pause"){await runtime.pauseGeneration(ctx.cwd,name);await viewGenerationStatus(ctx,await runtime.generationStatus(ctx.cwd,name));}
  return true;
}
