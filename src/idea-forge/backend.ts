import { spawn, execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fileHash } from "../experiments/files.js";
import type { Backend } from "./types.js";
export function bridgePath(): string { return resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/idea-forge-bridge.py"); }
export async function inspectBackend(root: string, python?: string, modelPanel?: string[], providerConfig?: string): Promise<Backend> {
  root = await realpath(root);
  python = python ?? join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  if(providerConfig) providerConfig = resolve(root, providerConfig);
  const bridge = bridgePath();
  const output = await new Promise<string>((resolveOutput,reject) => {
    const child = spawn(python!, ["-B","-u",bridge,"inspect",root], { cwd:root, stdio:["pipe","pipe","pipe"], env:{...process.env,...(providerConfig?{AUTORESEARCH_CONFIG:providerConfig}:{}),PYTHONDONTWRITEBYTECODE:"1",PYTHONUTF8:"1"} });
    let text="", failed=false;
    const timer=setTimeout(()=>{failed=true;child.kill("SIGKILL");reject(new Error("AutoResearch preflight timed out."));},30000);
    child.stdout.on("data",chunk=>{text+=String(chunk);if(text.length>2*1024*1024){failed=true;child.kill("SIGKILL");reject(new Error("Backend preflight output exceeded its limit."));}});
    child.stderr.resume();child.on("error",()=>{clearTimeout(timer);reject(new Error("Could not launch AutoResearch Python. Configure python in autoresearch-backend.json."));});
    child.on("close",code=>{clearTimeout(timer);if(!failed){if(code===0)resolveOutput(text);else reject(new Error("AutoResearch preflight failed. Its venv needs httpx, python-dotenv and arxiv, with valid provider configuration."));}});
    child.stdin.on("error",()=>{});child.stdin.end(JSON.stringify({modelPanel}));
  });
  const metadata=JSON.parse(output.trim());
  if(metadata.version!==1||!Array.isArray(metadata.models)||!Array.isArray(metadata.directions)||typeof metadata.configHash!=="string")throw new Error("Unsupported AutoResearch bridge protocol.");
  const revision=await new Promise<string|null>(done=>execFile("git",["rev-parse","HEAD"],{cwd:root,timeout:3000},(error,text)=>done(error?null:text.trim())));
  return {...metadata,root,python,bridge,revision,...(providerConfig?{providerConfig}:{}),bridgeHash:await fileHash(bridge),pythonHash:await fileHash(await realpath(python))};
}
