import { access, readFile, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
export type Engine = typeof import("../../src/experiments/index.js");
export type Experiment = import("../../src/experiments/index.js").Experiment;
export type ContractInput = import("../../src/experiments/index.js").ContractInput;
export type ExperimentTree = import("../../src/experiments/index.js").ExperimentTree;
export type ExperimentTreeView = import("../../src/experiments/index.js").ExperimentTreeView;
export const EXPERIMENT_STATUS_KEY = "hypatia-experiment";
let loaded: Promise<Engine> | undefined;
export function treeNodeCountUnit(count: number): "node" | "nodes" { return count === 1 ? "node" : "nodes"; }
export function formatTreeNodeCount(count: number): string { return `${count} ${treeNodeCountUnit(count)}`; }
export async function engine(): Promise<Engine> {
  if (!loaded) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const path = join(root, "dist", "experiments", "index.js");
    loaded = access(path).then(() => import(pathToFileURL(path).href) as Promise<Engine>).catch(error => { loaded = undefined; throw new Error(`Experiment runtime unavailable. Run npm run build in the Hypatia checkout. ${error.message}`); });
  }
  return loaded;
}
export function statusLabel(experiment: Experiment): string {
  const { contract, state } = experiment;
  const stage = state.active?.kind === "baseline" || (!state.active && !state.baselineId) ? "Baseline" : "Trials";
  let label = state.activeReview ? `${state.activeReview.kind === "plan" ? "Critic" : "Auditor"} Review` : state.state.split("_").map(part => part[0]!.toUpperCase() + part.slice(1)).join(" ");
  if (state.activeReview?.ownerPid) {
    try { process.kill(state.activeReview.ownerPid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") label = "Review Recovery Required"; }
  }
  if (state.active?.workerPid) {
    try { process.kill(state.active.workerPid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") label = "Recovery Required"; }
  }
  const seed = state.active?.seedIndex !== undefined ? ` · seed ${state.active.seedIndex + 1}/${contract.seeds.length}` : "";
  return `Experiment · ${contract.slug} · ${stage} · ${state.trialAttempts}/${contract.maxIterations} · ${label}${seed}`;
}
export function summarize(experiment: Experiment): string {
  const { contract, state } = experiment;
  const baseline = state.receipts.find(ref => ref.id === state.baselineId), best = state.receipts.find(ref => ref.id === state.bestId);
  const reviews = state.reviews?.map(ref => `${ref.kind}: ${ref.verdict}`).join(", ") || (contract.reviewPolicy === "required" ? "required, not completed" : "not required by this contract");
  return `${statusLabel(experiment)}\nReview history: ${reviews} (current evidence is checked at each gate)\nMetric: ${contract.metric.key} (${contract.metric.unit}, ${contract.metric.direction}). Baseline: ${baseline?.value ?? "unavailable"}; best kept: ${best?.value ?? "unavailable"}.\nEnvironment fingerprint: ${contract.environmentFingerprint?.sha256 ?? "not recorded (legacy contract)"}.\nCharged execution time: ${(state.spentMs / 1000).toFixed(1)}s/${contract.maxWallSeconds}s.\n${state.message ?? state.outcome ?? ""}\nState: experiments/${contract.slug}/state.json`;
}
export function approvalText(experiment: Experiment): string {
  const { contract } = experiment;
  const fingerprint = contract.environmentFingerprint;
  return [
    contract.hypothesis,
    `Command: ${JSON.stringify(contract.argv)}`,
    `Working directory: ${contract.cwd}`,
    `Editable files: ${contract.filesInScope.join(", ")}`,
    `Frozen inputs: ${contract.inputFiles.join(", ") || "none"}`,
    `Environment: ${contract.environment}`,
    `Environment fingerprint: ${fingerprint?.sha256 ?? "not recorded (legacy contract)"}`,
    ...(fingerprint ? [`Fingerprint host/runtime: ${fingerprint.platform}/${fingerprint.architecture}; Node ${fingerprint.runtimeVersion}`] : []),
    `Review: ${contract.reviewPolicy === "required" ? "critic before baseline and auditor before close; up to 3 attempts per gate, 180s and 12 turns each; model usage is separate from benchmark budget" : contract.reviewPolicy === "none" ? "disabled by contract" : "legacy contract, review not enforced"}`,
    `Seeds: ${contract.seeds.join(", ")}`,
    `Metric: ${contract.metric.key} (${contract.metric.unit}, ${contract.metric.direction})`,
    `Limits: ${contract.maxIterations} trial configurations; up to 3 baseline attempts; ${contract.maxWallSeconds}s charged execution time; ${contract.timeoutPerRun}s per run.`,
  ].join("\n");
}
export async function backendRoot(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit;
  if (process.env.HYPATIA_AUTORESEARCH_ROOT) return process.env.HYPATIA_AUTORESEARCH_ROOT;
  try { const config = JSON.parse(await readFile(join(getAgentDir(), "autoresearch-backend.json"), "utf8")) as { root?: unknown }; return typeof config.root === "string" ? config.root : undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Invalid autoresearch-backend.json; expected a JSON object with root."); }
}

export async function ideaBackendRoot(cwd: string, source?: string, explicit?: string): Promise<string | undefined> {
  if (!source) return undefined;
  const handle = await open(resolve(cwd, source), "r");
  const prefix = Buffer.alloc(32);
  try { await handle.read(prefix, 0, prefix.length, 0); } finally { await handle.close(); }
  return prefix.toString("utf8").startsWith("<!-- autoresearch-provenance\n") ? backendRoot(explicit) : undefined;
}
