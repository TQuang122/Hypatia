import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fileHash, objectHash } from "../experiments/files.js";
import { knowledgeDirections, nativeKnowledge } from "./knowledge.js";
import type { Backend, Generation, GenerationInput } from "./types.js";

export function nativeDirectory() {
  const here = fileURLToPath(import.meta.url);
  return here.endsWith(".ts") ? resolve(dirname(here), "../../dist/idea-forge") : dirname(here);
}
async function sdkIdentity() {
  const versions:Record<string,string> = {node:process.version};
  for(const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]) {
    const entry=fileURLToPath(import.meta.resolve(name));
    const manifest=JSON.parse(await readFile(join(dirname(entry), "../package.json"), "utf8"));
    versions[name]=String(manifest.version);
  }
  return versions;
}
async function sourceIdentity() {
  const root = nativeDirectory(), sources: Record<string, string> = {};
  for (const name of (await readdir(root)).filter(name => name.endsWith(".js")).sort()) sources[name] = await fileHash(join(root, name));
  return { root, sources, sourceHash: objectHash(sources) };
}
export async function nativeRuntime(backend: Backend, signal?: AbortSignal) {
  if (!backend.authPath || !backend.modelsPath) throw new Error("Native generation has no Hypatia model configuration.");
  return ModelRuntime.create({ authPath: backend.authPath, modelsPath: backend.modelsPath, signal, allowModelNetwork: false });
}
export async function inspectNativeBackend(agentDir: string, panel?: string[], preferredModel?: string, signal?: AbortSignal): Promise<Backend> {
  const authPath = join(resolve(agentDir), "auth.json"), modelsPath = join(resolve(agentDir), "models.json");
  const runtime = await ModelRuntime.create({ authPath, modelsPath, signal, allowModelNetwork: false });
  const available = await runtime.getAvailable(undefined, { signal });
  const selected = panel?.length ? panel : preferredModel ? [preferredModel] : available[0] ? [`${available[0].provider}/${available[0].id}`] : [];
  if (!selected.length || selected.length > 6 || new Set(selected).size !== selected.length) throw new Error("Configure a Hypatia model; select 1..6 unique provider/model entries.");
  const models = selected.map(alias => {
    const model = available.find(model => `${model.provider}/${model.id}` === alias);
    if (!model) throw new Error(`Model ${alias} is not available from Hypatia auth/models configuration. No model request was sent.`);
    return { alias, identity: model.id.toLowerCase(), ready: true, api: model.api, transport: "pi", fingerprint: objectHash(model) };
  });
  if (new Set(models.map(model => model.identity)).size !== models.length) throw new Error("Panel entries must use distinct model identities, not aliases for the same model.");
  const identity = await sourceIdentity(), dependencyVersions = await sdkIdentity();
  const modelsHash = await readFile(modelsPath).then(bytes => objectHash(bytes.toString("utf8"))).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
  return { kind: "native", authPath, modelsPath, ...identity, python: "", bridge: "", bridgeHash: identity.sourceHash, pythonHash: "", revision: null,
    configHash: objectHash({ modelsHash, models, dependencyVersions }), pythonVersion: "", dependencyVersions, ready: true, minimumPanel: 1, models,
    roles: { ideator: selected, planner: selected, consensus_checker: selected, freshness_refresher: [] }, directions: knowledgeDirections() };
}
export async function prepareNativeGeneration(workspace: string, input: GenerationInput, backend: Backend) {
  const current = await inspectNativeBackend(dirname(backend.authPath!), input.modelPanel);
  if (current.sourceHash !== backend.sourceHash || current.configHash !== backend.configHash) throw new Error("Hypatia runtime/model configuration changed after preflight.");
  const knowledge = await nativeKnowledge(workspace, `${input.topic}\n${input.signal}`, input.direction || undefined, input.knowledgePath);
  return { current, knowledge };
}
export async function verifyNativeBackend(run: Generation, signal?: AbortSignal) {
  const current = await inspectNativeBackend(dirname(run.spec.backend.authPath!), run.spec.modelPanel, undefined, signal);
  if (current.sourceHash !== run.spec.backend.sourceHash || current.configHash !== run.spec.backend.configHash) throw new Error("Hypatia runtime/model configuration changed. Create a new generation contract.");
  if (await fileHash(join(run.root, "knowledge_base", run.spec.knowledgeFile)) !== run.spec.knowledgeHash) throw new Error("Frozen knowledge changed.");
}
