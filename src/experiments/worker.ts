import { spawn, spawnSync } from "node:child_process";
import { openSync, closeSync, writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { alive, fileHash, objectHash, readBounded, safePath, runtimeHash } from "./files.js";
import { load, lock, save, type Experiment } from "./store.js";
import { finish, verifyEnvironment, verifyExecutableFingerprint } from "./lifecycle.js";
import { inputHashes, snapshot } from "./snapshots.js";
import { parseMetric } from "./receipts.js";
import type { ActiveRun, Receipt, SeedResult } from "./schema.js";
const LOG_LIMIT = 8 * 1024 * 1024;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function groupAlive(pid: number): boolean {
  try { process.kill(process.platform === "win32" ? pid : -pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
async function stopTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    if (alive(pid)) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 });
    if (alive(pid)) throw new Error("Benchmark process survived cancellation.");
    return;
  }
  if (!groupAlive(pid)) return;
  try { process.kill(-pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  for (let i = 0; i < 10 && groupAlive(pid); i++) await sleep(50);
  if (groupAlive(pid)) { try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
  // Dead descendants may remain as zombies until reaped by the OS; all running
  // members received SIGKILL, and the direct child is awaited by runSeed.
}
async function runSeed(experiment: Experiment, active: ActiveRun, seed: number, index: number, deadline: number, requestedStop: () => string | undefined): Promise<SeedResult> {
  const { contract, root } = experiment;
  const directory = await safePath(root, `runs/${active.id}/seed-${index}`);
  await mkdir(directory);
  const stdoutPath = join(directory, "stdout.log"), stderrPath = join(directory, "stderr.log");
  const stdoutFd = openSync(stdoutPath, "wx", 0o600), stderrFd = openSync(stderrPath, "wx", 0o600);
  const argv = contract.argv.map(arg => arg.replaceAll("{runDir}", directory).replaceAll("{seed}", String(seed)));
  let childPid: number | undefined, stopReason: string | undefined, stopping: Promise<void> | undefined, scanBusy = false;
  let outputBytes = 0, errorBytes = 0;
  const requestStop = (reason: string): void => {
    stopReason ??= reason;
    if (childPid && !stopping) stopping = stopTree(childPid).catch(error => { stopReason = `${stopReason}; cleanup failed: ${error.message}`; });
  };
  let exitCode: number | null = null, exitSignal: string | null = null;
  try {
    await lock(root, async () => {
      const current = await load(root);
      if (current.state.active?.token !== active.token) throw new Error("Worker ownership changed before benchmark launch.");
      delete current.state.active.childPid; current.state.active.childLaunchPending = true;
      await save(current, "seed_launch_pending");
    });
    await verifyExecutableFingerprint(experiment);
  } catch (error) {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    throw error;
  }
  const child = spawn(argv[0]!, argv.slice(1), { cwd: contract.cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, HYPATIA_EXPERIMENT_RUN_DIR: directory, HYPATIA_EXPERIMENT_SEED: String(seed) } });
  const exited = new Promise<void>((resolveExit) => {
    child.once("error", error => { stopReason = `spawn failed: ${error.message}`; resolveExit(); });
    child.once("close", (code, signal) => { exitCode = code; exitSignal = signal; resolveExit(); });
  });
  child.stdout!.on("data", (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes <= LOG_LIMIT) writeSync(stdoutFd, chunk); else requestStop("stdout exceeded the 8 MiB log limit"); });
  child.stderr!.on("data", (chunk: Buffer) => { errorBytes += chunk.length; if (errorBytes <= LOG_LIMIT) writeSync(stderrFd, chunk); else requestStop("stderr exceeded the 8 MiB log limit"); });
  childPid = child.pid;
  let descendantCheck: ReturnType<typeof setTimeout> | undefined;
  child.once("exit", () => {
    descendantCheck = setTimeout(() => { if (childPid && !alive(childPid) && groupAlive(childPid)) requestStop("Benchmark left running descendant processes after exit."); }, 50);
    descendantCheck.unref?.();
  });
  try {
    if (childPid) await lock(root, async () => {
      const current = await load(root);
      if (current.state.active?.token !== active.token) { requestStop("worker ownership changed"); return; }
      current.state.active.childPid = childPid; delete current.state.active.childLaunchPending; current.state.active.seedIndex = index;
      await save(current, "seed_started");
    });
    const timer = setInterval(() => {
      if (requestedStop()) requestStop(requestedStop()!);
      if (Date.now() >= deadline) requestStop("benchmark execution budget/timeout exhausted");
      if (scanBusy) return;
      scanBusy = true;
      void load(root).then(current => {
        if (current.state.active?.token !== active.token) requestStop("worker ownership changed");
        else if (current.state.state === "pause_requested") requestStop("paused by user");
      }).catch(error => requestStop(`state read failed: ${error.message}`)).finally(() => { scanBusy = false; });
    }, 100);
    try { await exited; } finally { clearInterval(timer); }
    if (stopping) await stopping;
    if (childPid) await stopTree(childPid);
  } catch (error) {
    requestStop(error instanceof Error ? error.message : String(error));
    if (stopping) await stopping;
    await exited;
  } finally { if (descendantCheck) clearTimeout(descendantCheck); closeSync(stdoutFd); closeSync(stderrFd); }
  const artifacts = await Promise.all([stdoutPath, stderrPath].map(async path => ({ path: relative(root, path).replaceAll("\\", "/"), sha256: await fileHash(path) })));
  let value: number | null = null;
  if (!stopReason && exitCode === 0) {
    try {
      const metricPath = contract.metric.source === "json-file" ? await safePath(directory, contract.metric.file!) : stdoutPath;
      value = parseMetric((await readBounded(metricPath, contract.metric.source === "stdout" ? LOG_LIMIT : 1024 * 1024)).toString("utf8"), contract.metric);
      if (contract.metric.source === "json-file") artifacts.push({ path: relative(root, metricPath).replaceAll("\\", "/"), sha256: await fileHash(metricPath) });
    } catch (error) { stopReason = error instanceof Error ? error.message : String(error); }
  } else stopReason ??= `Benchmark exited with ${exitCode ?? exitSignal ?? "unknown status"}.`;
  return { seed, argv, exitCode, signal: exitSignal, value, ...(stopReason ? { error: stopReason } : {}), artifacts };
}
async function main(root: string, token: string): Promise<void> {
  const experiment = await lock(root, async () => {
    const current = await load(root);
    if (!current.state.active || current.state.active.token !== token || current.state.active.workerPid !== process.pid) throw new Error("Worker does not own this run.");
    return current;
  });
  const active = experiment.state.active!, startedAt = active.startedAt;
  const deadline = startedAt + Math.min(experiment.contract.timeoutPerRun * 1000, experiment.contract.maxWallSeconds * 1000 - experiment.state.spentMs);
  let requestedStop: string | undefined;
  process.on("SIGTERM", () => { requestedStop = "interrupted by signal"; });
  process.on("SIGINT", () => { requestedStop = "interrupted by signal"; });
  const seeds: SeedResult[] = [];
  let reason: string | undefined;
  try {
    if (await runtimeHash(dirname(fileURLToPath(import.meta.url))) !== active.engineHash) throw new Error("Experiment engine build changed before the worker started.");
    await verifyEnvironment(experiment);
    for (let index = 0; index < experiment.contract.seeds.length; index++) {
      const current = await load(root);
      if (current.state.state === "pause_requested" || requestedStop) { reason = requestedStop ?? "paused by user"; break; }
      if (Date.now() >= deadline) { reason = "benchmark execution budget/timeout exhausted"; break; }
      const result = await runSeed(experiment, active, experiment.contract.seeds[index]!, index, deadline, () => requestedStop);
      seeds.push(result);
      if (result.error) { reason = result.error; break; }
    }
  } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  try {
    if (objectHash(await inputHashes(experiment.contract)) !== objectHash(active.inputHashes)) {
      reason ??= "Frozen input data changed during the run.";
    }
    await verifyExecutableFingerprint(experiment);
  } catch (error) {
    reason ??= error instanceof Error ? error.message : String(error);
  }
  const endSnapshot = await snapshot(experiment.contract).catch(() => undefined);
  if (!endSnapshot || endSnapshot.hash !== active.snapshot.hash) reason = "Scoped code changed while the benchmark was running.";
  const mean = seeds.length ? seeds.reduce((sum, seed) => sum + (seed.value ?? 0), 0) / seeds.length : null;
  const valid = !reason && seeds.length === experiment.contract.seeds.length && mean !== null && Number.isFinite(mean);
  const receipt: Receipt = {
    version: 1, id: active.id, kind: active.kind, contractHash: experiment.state.contractHash,
    startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, timeAccounting: "observed",
    valid, value: valid ? mean : null, ...(reason ? { reason } : {}), snapshot: active.snapshot, endCodeHash: endSnapshot?.hash ?? active.snapshot.hash,
    inputHashes: active.inputHashes, engineHash: active.engineHash, workspaceRevision: active.workspaceRevision, environment: experiment.contract.environment, executableHash: experiment.contract.executableHash,
    ...(experiment.contract.environmentFingerprint ? { environmentFingerprint: experiment.contract.environmentFingerprint.sha256 } : {}),
    seeds, interrupted: !!reason && /paused by user|interrupted by signal/.test(reason),
  };
  await finish(root, active, receipt);
}
const [root, token] = process.argv.slice(2);
if (!root || !token) process.exitCode = 2;
else main(root, token).catch(async error => {
  // Preserve durable ownership and logs for explicit resume/recovery; never mark
  // a run complete because the worker itself failed.
  await import("node:fs/promises").then(fs => fs.writeFile(join(root, "worker-error.log"), String(error) + "\n", { mode: 0o600 })).catch(() => {});
  process.exitCode = 1;
});
