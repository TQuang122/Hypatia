import { fileHash, json, exclusiveJson, objectHash, alive, safePath, inside } from "./files.js";
import { lock, load, save, type Experiment } from "./store.js";
import { inputHashes, snapshot } from "./snapshots.js";
import { verifyReceipt } from "./receipts.js";
import { relative } from "node:path";
import type { Receipt, ActiveRun } from "./schema.js";
import { currentEnvironmentFingerprintHost, fingerprintEnvironment, type EnvironmentFingerprintHost } from "./environment.js";
export async function verifyExecutableFingerprint(
  experiment: Experiment,
  host: EnvironmentFingerprintHost = currentEnvironmentFingerprintHost(),
): Promise<void> {
  const { contract } = experiment;
  if (await fileHash(contract.argv[0]!) !== contract.executableHash) throw new Error("Benchmark executable changed; create a new experiment contract.");
  if (contract.environmentFingerprint && objectHash(fingerprintEnvironment(contract, host)) !== objectHash(contract.environmentFingerprint)) {
    throw new Error("Benchmark environment fingerprint changed; create a new experiment contract.");
  }
}
export async function verifyEnvironment(
  experiment: Experiment,
  host: EnvironmentFingerprintHost = currentEnvironmentFingerprintHost(),
): Promise<void> {
  const { contract } = experiment;
  if (!inside(contract.workspace, contract.cwd)) throw new Error("Benchmark cwd escaped the workspace.");
  await safePath(contract.workspace, relative(contract.workspace, contract.cwd).replaceAll("\\", "/"), true);
  await verifyExecutableFingerprint(experiment, host);
  if (objectHash(await inputHashes(contract)) !== objectHash(contract.inputHashes)) throw new Error("Frozen input data changed; create a new contract and baseline.");
  for (const artifact of contract.ideaArtifacts) if (await fileHash(await safePath(experiment.root, artifact.path)) !== artifact.sha256) throw new Error("Imported idea/provenance snapshot changed.");
}
export async function audit(experiment: Experiment): Promise<void> {
  for (const ref of experiment.state.receipts) {
    await verifyReceipt(experiment.root, ref, experiment.state.contractHash, experiment.contract.environmentFingerprint?.sha256);
  }
}
export async function acceptReceipt(experiment: Experiment, active: ActiveRun, receipt: Receipt): Promise<void> {
  if (experiment.state.active?.token !== active.token || receipt.id !== active.id || receipt.contractHash !== experiment.state.contractHash) throw new Error("Stale experiment worker ownership.");
  const path = await safePath(experiment.root, `receipts/${receipt.id}.json`);
  await exclusiveJson(path, receipt).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST" || objectHash(await json<Receipt>(path)) !== objectHash(receipt)) throw error;
  });
  const ref = { id: receipt.id, hash: await fileHash(path), kind: receipt.kind, valid: receipt.valid, value: receipt.value };
  await verifyReceipt(experiment.root, ref, experiment.state.contractHash, experiment.contract.environmentFingerprint?.sha256);
  experiment.state.receipts.push(ref);
  experiment.state.spentMs += receipt.elapsedMs;
  if (receipt.valid && receipt.kind === "baseline") { experiment.state.baselineId = receipt.id; experiment.state.bestId = receipt.id; }
  const paused = experiment.state.state === "pause_requested" || receipt.interrupted;
  delete experiment.state.active;
  experiment.state.state = paused ? "paused" : "ready";
  experiment.state.message = receipt.reason ?? (receipt.kind === "trial" ? "Record a keep/revert decision before the next trial." : "Baseline recorded.");
  await save(experiment, "run_finished");
}
export async function finish(root: string, active: ActiveRun, receipt: Receipt): Promise<void> {
  await lock(root, async () => acceptReceipt(await load(root), active, receipt));
}
export async function recover(experiment: Experiment): Promise<void> {
  const active = experiment.state.active;
  if (!active || alive(active.workerPid)) return;
  if (active.childLaunchPending) {
    experiment.state.state = "blocked"; experiment.state.message = "Worker interrupted during benchmark launch; child identity was not sealed. Inspect/stop experiment processes, then acknowledge the stopped launch in /experiments before resuming.";
    await save(experiment, "unsealed_launch_blocked"); throw new Error(experiment.state.message);
  }
  if (alive(active.childPid)) {
    experiment.state.state = "blocked"; experiment.state.message = `Worker exited but benchmark PID ${active.childPid} is still alive. Stop that process before resume; no duplicate run was started.`;
    await save(experiment, "orphan_blocked");
    throw new Error(experiment.state.message);
  }
  const existing = await json<Receipt>(await safePath(experiment.root, `receipts/${active.id}.json`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (existing) { await acceptReceipt(experiment, active, existing); return; }
  const receipt: Receipt = {
    version: 1, id: active.id, kind: active.kind, contractHash: experiment.state.contractHash,
    startedAt: new Date(active.startedAt).toISOString(), endedAt: new Date().toISOString(),
    elapsedMs: Math.min(experiment.contract.timeoutPerRun * 1000, Math.max(0, experiment.contract.maxWallSeconds * 1000 - experiment.state.spentMs)), timeAccounting: "conservative",
    valid: false, value: null, reason: "Worker interrupted before sealing a receipt; the run timeout is charged conservatively.",
    snapshot: active.snapshot, endCodeHash: (await snapshot(experiment.contract)).hash,
    inputHashes: active.inputHashes, engineHash: active.engineHash, workspaceRevision: active.workspaceRevision, environment: experiment.contract.environment, executableHash: experiment.contract.executableHash,
    ...(experiment.contract.environmentFingerprint ? { environmentFingerprint: experiment.contract.environmentFingerprint.sha256 } : {}),
    seeds: [], interrupted: true,
  };
  await acceptReceipt(experiment, active, receipt);
}
