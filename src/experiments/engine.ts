import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alive, executable, exclusiveJson, fileHash, hash, objectHash, relativePath, safePath, runtimeHash, readBounded } from "./files.js";
import { slug, validateInput, type Contract, type ContractInput, type Receipt, type State, type TreeBinding } from "./schema.js";
import { fingerprintEnvironment } from "./environment.js";
import { experimentRoot, lock, load, save, list, type Experiment } from "./store.js";
import { inputHashes, snapshot, restoreSnapshot } from "./snapshots.js";
import { audit, recover, verifyEnvironment } from "./lifecycle.js";
import { better, verifyReceipt } from "./receipts.js";
import { importIdea, persistIdea, type ImportedIdea } from "./import-autoresearch.js";
import { exportReport } from "./report.js";
import { projectedOutcome, requireReviewGate, verifyReviewHistory } from "./reviews.js";
import { loadTree, treeRoot } from "./tree-store.js";
export { list, exportReport };
export { beginReview, finishReview, reviewStatus, validateReviewVerdict, verifyReview, REVIEW_TIMEOUT_MS, REVIEW_MAX_ATTEMPTS } from "./reviews.js";
export { validateInput } from "./schema.js";
export { legacy } from "./legacy.js";
export type { ContractInput, Contract, Receipt, State, Experiment };
export async function readReviewFile(workspace: string, path: string, offset: number, limit: number): Promise<string> {
  if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid evidence read range.");
  const content = (await readBounded(await safePath(await realpath(workspace), path), 16 * 1024 * 1024)).toString("utf8");
  const lines = content.split(/\r?\n/);
  const text = lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}: ${line}`).join("\n");
  return text.slice(0, 32768) + `\n[${lines.length} lines total; next offset ${offset + limit}${text.length > 32768 ? "; output truncated" : ""}]`;
}
export async function create(workspace: string, value: ContractInput, options: { ideaFile?: string; autoresearchRoot?: string; treeBinding?: TreeBinding } = {}): Promise<Experiment> {
  const input = validateInput(value), canonicalWorkspace = await realpath(workspace);
  if (options.treeBinding) {
    const binding = options.treeBinding, treeSlug = slug(binding.treeSlug), nodeId = slug(binding.nodeId);
    const treeWorkspace = await realpath(binding.workspace);
    const expectedWorkspace = await realpath(await safePath(treeWorkspace, `experiments/.trees/${treeSlug}/nodes/${nodeId}`));
    if (treeWorkspace !== binding.workspace || input.slug !== treeSlug || canonicalWorkspace !== expectedWorkspace) {
      throw new Error("Tree node contract binding does not match its managed worktree.");
    }
  }
  const root = await experimentRoot(canonicalWorkspace, input.slug);
  const scope = input.filesInScope.map(relativePath), inputs = input.inputFiles.map(relativePath);
  if (new Set(scope).size !== scope.length || new Set(inputs).size !== inputs.length || inputs.some(p => scope.includes(p))) throw new Error("Scope and frozen input paths must be unique and disjoint.");
  for (const path of [...scope, ...inputs]) {
    if (path === `experiments/${input.slug}` || path.startsWith(`experiments/${input.slug}/`)) throw new Error("Experiment state cannot be an editable/frozen benchmark input.");
    await safePath(canonicalWorkspace, path);
  }
  if (input.metric.file) relativePath(input.metric.file);
  const cwd = await safePath(canonicalWorkspace, input.cwd ?? ".", true);
  if (!(await lstat(cwd)).isDirectory()) throw new Error("Benchmark cwd must be a workspace directory.");
  const command = await executable(input.argv[0]!, cwd);
  for (const path of [`outputs/${input.slug}.md`, `outputs/${input.slug}.provenance.md`]) if (await lstat(await safePath(canonicalWorkspace, path)).catch(() => undefined)) throw new Error("An output artifact already uses this slug; choose another slug.");
  const idea: ImportedIdea = options.ideaFile ? await importIdea(resolve(canonicalWorkspace, options.ideaFile), options.autoresearchRoot) : { body: input.hypothesis, provenance: { version: 1, kind: "user", ideaHash: hash(input.hypothesis) }, snapshots: [] };
  const contract: Contract = {
    version: 1, experimentId: randomUUID(), workspace: canonicalWorkspace, createdAt: new Date().toISOString(), slug: input.slug,
    hypothesis: input.hypothesis, argv: [command, ...input.argv.slice(1)], cwd,
    filesInScope: scope, inputFiles: inputs, inputHashes: {}, seeds: input.seeds, metric: input.metric,
    environment: input.environment, executableHash: await fileHash(command), maxIterations: input.maxIterations,
    maxWallSeconds: input.maxWallSeconds, timeoutPerRun: input.timeoutPerRun, baselineCodeHash: "", ideaArtifacts: [],
    ...(options.treeBinding ? { treeBinding: options.treeBinding } : {}),
    reviewPolicy: input.reviewPolicy,
  };
  contract.inputHashes = await inputHashes(contract);
  contract.environmentFingerprint = fingerprintEnvironment(contract);
  contract.baselineCodeHash = (await snapshot(contract)).hash;
  await mkdir(await safePath(canonicalWorkspace, "experiments"), { recursive: true });
  await mkdir(root);
  await mkdir(join(root, "receipts"));
  await persistIdea(root, idea);
  const importedPaths = ["idea.md", "idea.provenance.json", ...idea.snapshots.map(item => item.path)];
  contract.ideaArtifacts = await Promise.all(importedPaths.map(async path => ({ path, sha256: await fileHash(await safePath(root, path)) })));
  await exclusiveJson(join(root, "contract.json"), contract);
  const state: State = { version: 1, contractHash: objectHash(contract), state: "planned", updatedAt: contract.createdAt, trialAttempts: 0, baselineAttempts: 0, spentMs: 0, receipts: [] };
  const experiment = { root, contract, state };
  await lock(root, () => save(experiment, "created"));
  return experiment;
}
export async function status(workspace: string, name: string): Promise<Experiment> { return load(await experimentRoot(workspace, name)); }
export async function approve(workspace: string, name: string): Promise<Experiment> {
  const root = await experimentRoot(workspace, name);
  return lock(root, async () => {
    const experiment = await load(root);
    if (experiment.state.state === "completed") throw new Error("Experiment is already closed.");
    if (experiment.state.active || experiment.state.activeReview) throw new Error("An active run/reviewer already owns this experiment.");
    await verifyEnvironment(experiment);
    if (!experiment.state.baselineId && (await snapshot(experiment.contract)).hash !== experiment.contract.baselineCodeHash) throw new Error("Baseline code changed since contract creation; create a new contract before approval.");
    experiment.state.approval = { contractHash: experiment.state.contractHash, at: new Date().toISOString() };
    experiment.state.state = "ready";
    await save(experiment, "approved"); return experiment;
  });
}
export async function pause(workspace: string, name: string): Promise<Experiment> {
  const root = await experimentRoot(workspace, name);
  return lock(root, async () => {
    const experiment = await load(root);
    if (experiment.state.state === "completed") return experiment;
    await recover(experiment);
    experiment.state.state = experiment.state.active ? "pause_requested" : "paused";
    await save(experiment, "pause_requested"); return experiment;
  });
}
export async function resume(workspace: string, name: string): Promise<Experiment> {
  const root = await experimentRoot(workspace, name);
  return lock(root, async () => {
    const experiment = await load(root);
    if (experiment.state.state === "completed") throw new Error("Experiment is already closed.");
    await recover(experiment);
    if (experiment.state.active) throw new Error("A worker still owns this run. Inspect status or request pause.");
    await verifyEnvironment(experiment); await audit(experiment); await verifyReviewHistory(experiment);
    if (experiment.state.approval?.contractHash !== experiment.state.contractHash) throw new Error("Approve the saved contract through /experiments first.");
    experiment.state.state = "ready"; delete experiment.state.message;
    await save(experiment, "resumed"); return experiment;
  });
}
export async function acknowledgeStoppedLaunch(workspace: string, name: string): Promise<Experiment> {
  const root = await experimentRoot(workspace, name);
  return lock(root, async () => {
    const experiment = await load(root), active = experiment.state.active;
    if (!active?.childLaunchPending || alive(active.workerPid) || alive(active.childPid)) throw new Error("Acknowledgement applies only to an interrupted, unsealed launch with no known live owner.");
    delete active.childLaunchPending;
    await save(experiment, "user_acknowledged_stopped_launch");
    await recover(experiment); return experiment;
  });
}
export async function start(
  workspace: string,
  name: string,
  kind: "baseline" | "trial",
  options: { treeReservationId?: string } = {},
): Promise<{ experiment: Experiment; cached?: Receipt; runId?: string }> {
  if (process.platform === "win32") throw new Error("Managed benchmark execution currently supports macOS/Linux. Windows can manage/import experiment state; use a supported host for execution.");
  const root = await experimentRoot(workspace, name);
  const run = () => lock(root, async () => {
    const experiment = await load(root), { contract, state } = experiment;
    if (state.state === "completed") throw new Error("Experiment is already closed.");
    if (state.active || state.activeReview) throw new Error("This experiment already has a run/review owner. Resume/recover it before starting another.");
    if (["paused", "pause_requested", "blocked"].includes(state.state)) throw new Error("Resume the experiment before running.");
    if (state.approval?.contractHash !== state.contractHash) throw new Error("This contract has not been approved by the user.");
    await verifyEnvironment(experiment); await audit(experiment);
    await requireReviewGate(experiment, "plan");
    if (kind === "baseline" && state.baselineId) return { experiment, cached: await verifyReceipt(root, state.receipts.find(ref => ref.id === state.baselineId)!, state.contractHash, contract.environmentFingerprint?.sha256) };
    if (state.receipts.some(ref => ref.kind === "trial" && !ref.decision)) throw new Error("Record the previous trial's decision before another run.");
    if (kind === "trial" && !state.baselineId) throw new Error("Record a valid baseline first.");
    if ((kind === "trial" && state.trialAttempts >= contract.maxIterations) || (kind === "baseline" && state.baselineAttempts >= 3) || state.spentMs >= contract.maxWallSeconds * 1000) throw new Error("Persisted experiment execution budget is exhausted.");
    const id = randomUUID(), token = randomUUID();
    const modulePath = fileURLToPath(import.meta.url);
    const worker = modulePath.endsWith(".ts") ? resolve(dirname(modulePath), "../../dist/experiments/worker.js") : join(dirname(modulePath), "worker.js");
    const engineHash = await runtimeHash(dirname(worker));
    const workspaceRevision = await new Promise<string | null>(resolveRevision => execFile("git", ["rev-parse", "HEAD"], { cwd: contract.workspace, timeout: 3000 }, (error, output) => resolveRevision(error ? null : output.trim())));
    await mkdir(await safePath(root, `runs/${id}`), { recursive: true });
    const source = await snapshot(contract, root, id);
    if (kind === "baseline" && source.hash !== contract.baselineCodeHash) throw new Error("Baseline code changed after approval; create a new contract and baseline.");
    state.active = { id, token, kind, startedAt: Date.now(), workerPid: 0, engineHash, workspaceRevision, snapshot: source, inputHashes: contract.inputHashes };
    state.state = "running";
    if (kind === "baseline") state.baselineAttempts++; else state.trialAttempts++;
    await save(experiment, "run_reserved");
    const node = process.env.HYPATIA_NODE_EXECUTABLE ?? process.execPath;
    try {
      const child = spawn(node, [worker, root, token], { cwd: contract.workspace, detached: process.platform !== "win32", stdio: "ignore", env: process.env });
      await new Promise<void>((resolveSpawn, reject) => { child.once("spawn", resolveSpawn); child.once("error", reject); });
      state.active.workerPid = child.pid!; child.unref();
      await save(experiment, "worker_started");
    } catch (error) {
      state.state = "blocked"; state.message = `Worker could not start: ${error instanceof Error ? error.message : String(error)}`;
      await save(experiment, "worker_start_failed"); throw error;
    }
    return { experiment, runId: id };
  });
  const initial = await load(root), binding = initial.contract.treeBinding;
  if (!binding) {
    if (options.treeReservationId) throw new Error("A tree run reservation cannot authorize an ordinary experiment.");
    return run();
  }
  if (!options.treeReservationId) throw new Error("Tree nodes must run through the shared experiment-tree budget controller.");
  const sharedRoot = await treeRoot(binding.workspace, binding.treeSlug);
  return lock(sharedRoot, async () => {
    const tree = await loadTree(sharedRoot);
    const node = tree.state.nodes.find(item => item.id === binding.nodeId);
    const reservation = tree.state.activeRuns.find(item => item.id === options.treeReservationId);
    if (
      tree.definition.workspace !== binding.workspace || tree.definition.slug !== binding.treeSlug
      || !node || node.status !== "planned" || node.experimentSlug !== name
      || node.worktree !== `experiments/.trees/${binding.treeSlug}/nodes/${binding.nodeId}`
      || !reservation || reservation.nodeId !== binding.nodeId || reservation.kind !== kind
      || tree.state.state !== "running"
      || await realpath(await safePath(binding.workspace, node.worktree)) !== initial.contract.workspace
    ) throw new Error("Tree run reservation does not authorize this node, worktree, or run kind.");
    return run();
  });
}
export async function wait(workspace: string, name: string, id: string, options: { signal?: AbortSignal; onStatus?: (experiment: Experiment) => void } = {}): Promise<Receipt> {
  let lastUpdate = 0, abortRequested = false;
  while (true) {
    const experiment = await status(workspace, name);
    const ref = experiment.state.receipts.find(item => item.id === id);
    if (ref) return verifyReceipt(experiment.root, ref, experiment.state.contractHash, experiment.contract.environmentFingerprint?.sha256);
    if (options.signal?.aborted && !abortRequested) { abortRequested = true; await pause(workspace, name); }
    if (Date.now() - lastUpdate > 1000) { options.onStatus?.(experiment); lastUpdate = Date.now(); }
    if (experiment.state.active && !alive(experiment.state.active.workerPid)) {
      await lock(experiment.root, async () => { await recover(await load(experiment.root)); });
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
}
export async function decide(workspace: string, name: string, id: string, decision: "keep" | "revert" | "failed", reason: string): Promise<Experiment> {
  if (!reason.trim()) throw new Error("A decision reason is required.");
  const root = await experimentRoot(workspace, name);
  return lock(root, async () => {
    const experiment = await load(root), { state, contract } = experiment;
    if (state.active || state.activeReview || state.state === "completed") throw new Error("Settle the active run/review before a decision.");
    await audit(experiment); await verifyEnvironment(experiment);
    const ref = state.receipts.find(item => item.id === id);
    if (!ref || ref.kind !== "trial" || ref.decision) throw new Error("Choose an undecided trial receipt.");
    const receipt = await verifyReceipt(root, ref, state.contractHash, contract.environmentFingerprint?.sha256);
    if (!ref.valid && decision !== "failed") throw new Error("An invalid trial must be recorded as failed.");
    if (ref.valid && decision === "failed") throw new Error("A valid trial needs keep or revert.");
    const best = state.receipts.find(item => item.id === state.bestId)!;
    if (decision === "keep") {
      if (!better(ref.value!, best.value!, contract.metric)) throw new Error("Keep requires improvement over the best comparable observed metric.");
      if ((await snapshot(contract)).hash !== receipt.endCodeHash) throw new Error("Scoped code changed since this trial; preserve/reconcile it before keeping.");
      state.bestId = id;
    } else {
      const previous = await verifyReceipt(root, best, state.contractHash, contract.environmentFingerprint?.sha256);
      await restoreSnapshot(contract, root, previous.snapshot, receipt.endCodeHash);
    }
    ref.decision = decision; ref.reason = reason;
    await save(experiment, "trial_decided"); return experiment;
  });
}
export async function close(workspace: string, name: string): Promise<{ experiment: Experiment; report: string; provenance: string }> {
  const root = await experimentRoot(workspace, name);
  return lock(root, async () => {
    const experiment = await load(root), { state, contract } = experiment;
    if (state.active || state.activeReview || state.receipts.some(ref => ref.kind === "trial" && !ref.decision)) throw new Error("Active/undecided work prevents closing.");
    await audit(experiment); await verifyEnvironment(experiment);
    await requireReviewGate(experiment, "plan"); await requireReviewGate(experiment, "audit");
    if (!state.baselineId && !state.receipts.length) throw new Error("Run evidence is required before closing.");
    const baseline = state.receipts.find(ref => ref.id === state.baselineId), best = state.receipts.find(ref => ref.id === state.bestId);
    if (best && (await snapshot(contract)).hash !== (await verifyReceipt(root, best, state.contractHash, contract.environmentFingerprint?.sha256)).snapshot.hash) throw new Error("Scoped code diverged from the best kept snapshot; preserve changes or run a new trial before closing.");
    state.outcome = projectedOutcome(experiment);
    state.state = "completed"; await save(experiment, "closed");
    return { experiment, ...await exportReport(experiment) };
  });
}
