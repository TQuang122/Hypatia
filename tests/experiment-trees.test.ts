import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, watch, writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileHash, hash, objectHash } from "../src/experiments/files.js";
import { createInitialTreeState, validateTreeInput, type TreeDefinition } from "../src/experiments/tree-schema.js";
import { experimentRoot, load, lock, save } from "../src/experiments/store.js";
import { initializeTree, listTrees, loadTree, saveTree } from "../src/experiments/tree-store.js";
import { createTreeWorktree, freezeTreeInputs, inspectTreeRepository } from "../src/experiments/tree-worktrees.js";

const contract = {
  hypothesis: "Compare an isolated candidate against its parent",
  argv: [process.execPath, "benchmark.mjs"],
  filesInScope: ["benchmark.mjs"],
  seeds: [1, 2],
  metric: { source: "stdout" as const, key: "score", unit: "score", direction: "max" as const },
  environment: "Local Node fixture",
  reviewPolicy: "none" as const,
  timeoutPerRun: 10,
};

async function gitFixture(t: TestContext) {
  const workspace = mkdtempSync(join(tmpdir(), "experiment tree git-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Hypatia Tests"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "hypatia-tests@example.invalid"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, ".gitignore"), "experiments/*\n!experiments/.gitkeep\noutputs/*\n!outputs/.gitkeep\n");
  await mkdir(join(workspace, "experiments"), { recursive: true });
  await mkdir(join(workspace, "outputs"), { recursive: true });
  writeFileSync(join(workspace, "experiments/.gitkeep"), "");
  writeFileSync(join(workspace, "outputs/.gitkeep"), "");
  writeFileSync(join(workspace, "scope.txt"), "baseline source\n");
  writeFileSync(join(workspace, "data.txt"), "frozen input\n");
  writeFileSync(join(workspace, "benchmark.mjs"), String.raw`import fs from "node:fs"; import path from "node:path";
const hold = process.argv.includes("--hold")
  || (process.argv.includes("--hold-active") && process.cwd().split(path.sep).includes("active-node"));
if (hold) {
  const runDir = process.env.HYPATIA_EXPERIMENT_RUN_DIR;
  const release = path.resolve(runDir, "..", "continue");
  await new Promise((resolve, reject) => {
    const watcher = fs.watch(path.dirname(release), (_event, name) => {
      if ((!name || name.toString() === path.basename(release)) && fs.existsSync(release)) { watcher.close(); resolve(); }
    });
    watcher.once("error", reject);
    if (fs.existsSync(release)) { watcher.close(); resolve(); }
  });
}
console.log("HYPATIA_METRIC {\"score\":1}");
`);
  execFileSync("git", ["add", "-A"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: workspace, stdio: "ignore" });
  const repository = await inspectTreeRepository(workspace);
  return { ...repository, treeRoot: join(repository.workspace, "experiments/.trees/tree-case") };
}

function waitForFile(targetPath: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const name = basename(targetPath);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      watcher.close();
      if (error) reject(error);
      else resolve();
    };
    const watcher = watch(dirname(targetPath), (_event, filename) => {
      if ((!filename || filename.toString() === name) && existsSync(targetPath)) finish();
    });
    watcher.once("error", error => finish(error));
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${name}.`)), timeoutMs);
    if (existsSync(targetPath)) finish();
  });
}

function waitForTreeEvent(path: string, offset: number, kind: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let watcher: ReturnType<typeof watch> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      watcher?.close();
      if (error) reject(error);
      else resolve();
    };
    const check = async () => {
      try {
        const text = await readFile(path, "utf8");
        if (text.slice(offset).split("\n").some(line => line.includes(`"kind":"${kind}"`))) finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    watcher = watch(dirname(path), () => { void check(); });
    watcher.once("error", error => finish(error));
    timeout = setTimeout(() => finish(new Error(`Timed out waiting for tree event ${kind}.`)), timeoutMs);
    void check();
  });
}

async function settledSingleNodeTree(t: TestContext, slug: string) {
  const { workspace } = await gitFixture(t);
  const runtime = await import("../src/experiments/index.js");
  await runtime.createTree(workspace, {
    slug,
    ...contract,
    filesInScope: ["scope.txt"],
    maxTotalTrials: 2,
    maxTotalWallSeconds: 90,
  });
  await runtime.approveTreeNode(workspace, slug, "root");
  const baseline = await runtime.runTreeNode(workspace, slug, "root", "baseline");
  assert.equal(baseline.valid, true);
  await runtime.closeTreeNode(workspace, slug, "root");
  return { workspace, runtime };
}

async function completedSingleNodeTree(t: TestContext, slug: string) {
  const { workspace, runtime } = await settledSingleNodeTree(t, slug);
  await runtime.closeTree(workspace, slug);
  return { workspace, runtime };
}

test("tree input turns one experiment protocol into a shared bounded budget", () => {
  const input = validateTreeInput({
    slug: "metric-search",
    ...contract,
    maxTotalTrials: 8,
    maxTotalWallSeconds: 90,
    maxParallelRuns: 2,
  });

  assert.equal(input.contract.slug, "metric-search");
  assert.equal(input.contract.maxIterations, 8);
  assert.equal(input.contract.maxWallSeconds, 90);
  assert.deepEqual(input.budget, { maxTotalTrials: 8, maxTotalWallSeconds: 90, maxParallelRuns: 2 });
  assert.throws(() => validateTreeInput({
    slug: "metric-search",
    ...contract,
    timeoutPerRun: 100,
    maxTotalTrials: 8,
    maxTotalWallSeconds: 90,
  }), /timeoutPerRun/);
});

test("tree event journals reload state and reject modified history", async t => {
  const workspace = mkdtempSync(join(tmpdir(), "experiment tree store-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "experiments"), { recursive: true });
  const input = validateTreeInput({
    slug: "metric-search",
    ...contract,
    maxTotalTrials: 8,
    maxTotalWallSeconds: 90,
  });
  const definition: TreeDefinition = {
    version: 1,
    slug: input.slug,
    workspace: await realpath(workspace),
    baseCommit: "a".repeat(40),
    createdAt: new Date(0).toISOString(),
    protocol: input.contract,
    budget: input.budget,
    inputHashes: {},
  };
  const tree = await initializeTree(workspace, definition, createInitialTreeState(definition));
  tree.state.message = "lineage persisted";
  await saveTree(tree, "node_forked");

  const loaded = await loadTree(tree.root);
  assert.equal(loaded.state.message, "lineage persisted");
  assert.deepEqual((await listTrees(workspace)).map(item => item.definition.slug), ["metric-search"]);

  const journalPath = join(tree.root, "events.jsonl");
  const journal = await readFile(journalPath, "utf8");
  await writeFile(journalPath, journal.replace("lineage persisted", "history modified"));
  await assert.rejects(loadTree(tree.root), /integrity check failed/);
});

test("tree worktrees isolate siblings and seed verified parent code and frozen inputs", async t => {
  const { workspace, baseCommit, treeRoot } = await gitFixture(t);
  await mkdir(treeRoot, { recursive: true });
  const inputHashes = await freezeTreeInputs(workspace, treeRoot, ["data.txt"]);
  writeFileSync(join(workspace, "data.txt"), "changed after tree creation\n");

  const parent = await createTreeWorktree({
    workspace, treeRoot, path: "experiments/.trees/tree-case/nodes/parent", baseCommit,
    inputFiles: ["data.txt"], inputHashes,
  });
  writeFileSync(join(parent, "scope.txt"), "parent best snapshot\n");
  const evidenceRoot = join(treeRoot, "parent-evidence");
  await mkdir(join(evidenceRoot, "snapshots"), { recursive: true });
  await writeFile(join(evidenceRoot, "snapshots/parent.source"), "parent best snapshot\n");
  const snapshot = {
    files: [{ path: "scope.txt", exists: true, sha256: hash("parent best snapshot\n"), copy: "snapshots/parent.source" }],
    hash: objectHash([{ path: "scope.txt", exists: true, sha256: hash("parent best snapshot\n") }]),
  };

  const sibling = await createTreeWorktree({
    workspace, treeRoot, path: "experiments/.trees/tree-case/nodes/sibling", baseCommit,
    inputFiles: ["data.txt"], inputHashes, sourceSnapshot: { root: evidenceRoot, snapshot },
  });
  assert.equal(await readFile(join(sibling, "scope.txt"), "utf8"), "parent best snapshot\n");
  assert.equal(await readFile(join(sibling, "data.txt"), "utf8"), "frozen input\n");
  writeFileSync(join(sibling, "scope.txt"), "sibling edit\n");
  assert.equal(await readFile(join(parent, "scope.txt"), "utf8"), "parent best snapshot\n");
  assert.equal(await readFile(join(workspace, "scope.txt"), "utf8"), "baseline source\n");
});

test("tree worktrees require a clean repository root and reject external destinations", async t => {
  const { workspace, treeRoot } = await gitFixture(t);
  await assert.rejects(inspectTreeRepository(join(workspace, "experiments")), /repository root/);
  writeFileSync(join(workspace, "untracked.txt"), "dirty\n");
  await assert.rejects(inspectTreeRepository(workspace), /clean Git checkout/);

  const workspaceAgain = mkdtempSync(join(tmpdir(), "experiment tree target-"));
  t.after(async () => rm(workspaceAgain, { recursive: true, force: true }));
  await mkdir(treeRoot, { recursive: true });
  await assert.rejects(createTreeWorktree({
    workspace: await realpath(workspaceAgain), treeRoot, path: "outside/node",
    baseCommit: "a".repeat(40), inputFiles: [], inputHashes: {},
  }), /inside the experiment tree/);
});

test("tree creation refuses a dirty checkout without changing version-1 workspace behavior", async t => {
  const { workspace } = await gitFixture(t);
  writeFileSync(join(workspace, "user-change.txt"), "preserve me\n");
  const runtime = await import("../src/experiments/index.js");
  await assert.rejects(runtime.createTree(workspace, {
    slug: "dirty-tree",
    ...contract,
    filesInScope: ["scope.txt"],
    maxTotalTrials: 2,
    maxTotalWallSeconds: 90,
  }), /clean Git checkout/);
  const legacy = await runtime.create(workspace, {
    ...contract,
    slug: "legacy-dirty",
    filesInScope: ["scope.txt"],
  });
  assert.equal(legacy.state.state, "planned");
  assert.equal(await readFile(join(workspace, "user-change.txt"), "utf8"), "preserve me\n");
});

test("tree node runs retain the version-1 critic gate and release unused reservations", async t => {
  const { workspace } = await gitFixture(t);
  const runtime = await import("../src/experiments/index.js");
  await runtime.createTree(workspace, {
    slug: "review-tree",
    ...contract,
    reviewPolicy: "required",
    filesInScope: ["scope.txt"],
    maxTotalTrials: 2,
    maxTotalWallSeconds: 90,
  });
  await runtime.approveTreeNode(workspace, "review-tree", "root");
  await assert.rejects(runtime.runTreeNode(workspace, "review-tree", "root", "baseline"), /Critic contract review required/);
  const tree = (await runtime.treeStatus(workspace, "review-tree")).tree;
  assert.deepEqual(tree.state.activeRuns, []);
  assert.equal(tree.state.baselineAttempts, 0);
});

test("tree wall-time admission includes full active configuration reservations", async t => {
  const { workspace } = await gitFixture(t);
  const runtime = await import("../src/experiments/index.js");
  await runtime.createTree(workspace, {
    slug: "wall-budget",
    ...contract,
    timeoutPerRun: 10,
    filesInScope: ["scope.txt"],
    maxTotalTrials: 2,
    maxTotalWallSeconds: 15,
    maxParallelRuns: 2,
  });
  await runtime.approveTreeNode(workspace, "wall-budget", "root");
  await runtime.runTreeNode(workspace, "wall-budget", "root", "baseline");
  await runtime.closeTreeNode(workspace, "wall-budget", "root");
  await runtime.forkTreeNode(workspace, "wall-budget", "root", "child", "A child that shares wall time");
  await runtime.approveTreeNode(workspace, "wall-budget", "child");
  let tree = (await runtime.treeStatus(workspace, "wall-budget")).tree;
  tree.state.state = "running";
  tree.state.activeRuns.push({
    id: "reserved-full-configuration",
    nodeId: "root",
    kind: "baseline",
    startedAt: Date.now(),
    reservedMs: 10000,
    trialAttemptsBefore: 0,
    baselineAttemptsBefore: 0,
  });
  await saveTree(tree, "run_reserved");

  await assert.rejects(runtime.runTreeNode(workspace, "wall-budget", "child", "baseline"), /shared wall-time budget/);
  const recovered = await runtime.recoverTree(workspace, "wall-budget");
  assert.deepEqual(recovered.state.activeRuns, []);
  assert.equal((await runtime.treeNodeStatus(workspace, "wall-budget", "child")).state.baselineAttempts, 0);
});

test("tree creation records a planned root node and preserves single-experiment contracts", async t => {
  const { workspace } = await gitFixture(t);
  const runtime = await import("../src/experiments/index.js");
  const { createTree, forkTreeNode, listTrees } = runtime;
  const created = await createTree(workspace, {
    slug: "tree-case",
    ...contract,
    filesInScope: ["scope.txt"],
    maxTotalTrials: 4,
    maxTotalWallSeconds: 90,
  });
  const root = created.tree.state.nodes[0]!;

  assert.equal(created.tree.state.state, "planned");
  assert.equal(root.id, "root");
  assert.equal(root.status, "planned");
  assert.equal(root.contractHash, created.experiment.state.contractHash);
  assert.equal(root.sourceSnapshotHash, created.experiment.contract.baselineCodeHash);
  assert.equal((await listTrees(workspace)).length, 1);
  const rootWorkspace = await runtime.treeNodeWorkspace(workspace, "tree-case", "root");
  await assert.rejects(runtime.start(rootWorkspace, "tree-case", "baseline"), /shared experiment-tree budget controller/);
  await assert.rejects(
    forkTreeNode(workspace, "tree-case", "root", "sibling", "Try an alternate candidate"),
    /settled and closed/,
  );
});

test("tree budgets span root and child runs, then preserve verified promotion provenance", async t => {
  const { workspace } = await gitFixture(t);
  const runtime = await import("../src/experiments/index.js");
  const created = await runtime.createTree(workspace, {
    slug: "tree-case",
    ...contract,
    filesInScope: ["scope.txt"],
    maxTotalTrials: 1,
    maxTotalWallSeconds: 90,
  });
  await runtime.approveTreeNode(workspace, "tree-case", "root");
  const rootBaseline = await runtime.runTreeNode(workspace, "tree-case", "root", "baseline");
  assert.equal(rootBaseline.valid, true);
  const rootWorkspace = await runtime.treeNodeWorkspace(workspace, "tree-case", "root");
  writeFileSync(join(rootWorkspace, "scope.txt"), "root candidate\n");
  const rootTrial = await runtime.runTreeNode(workspace, "tree-case", "root", "trial");
  await runtime.decideTreeNode(workspace, "tree-case", "root", rootTrial.id, "revert", "Candidate did not improve the metric.");
  await runtime.closeTreeNode(workspace, "tree-case", "root");

  const forked = await runtime.forkTreeNode(workspace, "tree-case", "root", "sibling", "Compare a sibling candidate");
  const child = forked.state.nodes.find(node => node.id === "sibling")!;
  assert.equal(child.parentReceiptId, rootBaseline.id);
  assert.equal(child.sourceSnapshotHash, rootBaseline.snapshot.hash);
  await runtime.approveTreeNode(workspace, "tree-case", "sibling");
  const childBaseline = await runtime.runTreeNode(workspace, "tree-case", "sibling", "baseline");
  assert.equal(childBaseline.snapshot.hash, child.sourceSnapshotHash);
  const childWorkspace = await runtime.treeNodeWorkspace(workspace, "tree-case", "sibling");
  writeFileSync(join(childWorkspace, "scope.txt"), "unsettled child edit\n");
  await assert.rejects(runtime.runTreeNode(workspace, "tree-case", "sibling", "trial"), /shared trial budget is exhausted/);
  writeFileSync(join(childWorkspace, "scope.txt"), "baseline source\n");
  await runtime.closeTreeNode(workspace, "tree-case", "sibling");
  const promoted = await runtime.promoteTreeNode(workspace, "tree-case", "sibling");
  assert.equal(promoted.state.winnerNodeId, "sibling");
  const closed = await runtime.closeTree(workspace, "tree-case");

  assert.equal(closed.tree.state.state, "completed");
  assert.match(await readFile(join(workspace, closed.report), "utf8"), /Node sibling/);
  assert.match(await readFile(join(workspace, closed.provenance), "utf8"), /parent receipt/);
  assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: workspace, encoding: "utf8" }).trim(), "");
});

test("tree closure rejects a fork committed after its node snapshot", async t => {
  const { workspace } = await gitFixture(t);
  const runtime = await import("../src/experiments/index.js");
  await runtime.createTree(workspace, {
    slug: "close-race-tree",
    ...contract,
    filesInScope: ["scope.txt"],
    maxTotalTrials: 2,
    maxTotalWallSeconds: 90,
  });
  await runtime.approveTreeNode(workspace, "close-race-tree", "root");
  const baseline = await runtime.runTreeNode(workspace, "close-race-tree", "root", "baseline");
  assert.equal(baseline.valid, true);
  await runtime.closeTreeNode(workspace, "close-race-tree", "root");

  const closure = await import("../src/experiments/tree-close.js");
  const plan = await closure.prepareTreeClose(workspace, "close-race-tree");
  await runtime.forkTreeNode(workspace, "close-race-tree", "root", "late-child", "Preserve a concurrent fork.");
  await assert.rejects(closure.finalizeTreeClose(plan));

  const current = await runtime.treeStatus(workspace, "close-race-tree");
  assert.equal(current.tree.state.state, "ready");
  assert.deepEqual(current.nodes.map(item => item.node.id), ["root", "late-child"]);
});

test("tree creation rejects a conflicting report path without creating tree state", async t => {
  const { workspace } = await gitFixture(t);
  const runtime = await import("../src/experiments/index.js");
  const slug = "report-conflict";
  const outputPath = join(workspace, `outputs/${slug}-tree.md`);
  writeFileSync(outputPath, "User-owned report\n");

  await assert.rejects(runtime.createTree(workspace, {
    slug,
    ...contract,
    filesInScope: ["scope.txt"],
    maxTotalTrials: 2,
    maxTotalWallSeconds: 90,
  }));

  assert.deepEqual(await runtime.listTrees(workspace), []);
  assert.equal(await readFile(outputPath, "utf8"), "User-owned report\n");
});

test("tree closure remains retryable after a post-creation provenance collision", async t => {
  const slug = "late-report-conflict";
  const { workspace, runtime } = await settledSingleNodeTree(t, slug);
  const outputPath = join(workspace, `outputs/${slug}-tree.provenance.md`);
  writeFileSync(outputPath, "User-owned provenance\n");
  const tree = (await runtime.treeStatus(workspace, slug)).tree;
  const journalPath = join(tree.root, "events.jsonl");
  const journalHash = await fileHash(journalPath);

  await assert.rejects(runtime.closeTree(workspace, slug));
  const stillOpen = (await runtime.treeStatus(workspace, slug)).tree;
  assert.equal(stillOpen.state.state, "ready");
  assert.equal(await fileHash(journalPath), journalHash);
  assert.equal(await readFile(outputPath, "utf8"), "User-owned provenance\n");

  await unlink(outputPath);
  const closed = await runtime.closeTree(workspace, slug);
  assert.equal(closed.tree.state.state, "completed");
  assert.ok((await readFile(join(workspace, closed.report), "utf8")).includes(`Experiment tree: ${slug}`));
  assert.ok((await readFile(join(workspace, closed.provenance), "utf8")).includes("Tree event journal:"));
});

test("stale tree export cannot replace artifacts generated by closure", async t => {
  const slug = "stale-export";
  const { workspace, runtime } = await settledSingleNodeTree(t, slug);
  const exporter = await import("../src/experiments/tree-export.js");
  const plan = await exporter.prepareTreeExport(workspace, slug);
  const closed = await runtime.closeTree(workspace, slug);
  const reportPath = join(workspace, closed.report);
  const provenancePath = join(workspace, closed.provenance);
  const reportBefore = await readFile(reportPath, "utf8");
  const provenanceBefore = await readFile(provenancePath, "utf8");

  await assert.rejects(exporter.publishTreeExport(plan), error =>
    error instanceof Error && error.name === "TreeChangedDuringExportError",
  );

  assert.equal(await readFile(reportPath, "utf8"), reportBefore);
  assert.equal(await readFile(provenancePath, "utf8"), provenanceBefore);
});

test("cancelled tree export preparation does not publish artifacts", async t => {
  const slug = "cancel-export";
  const { workspace, runtime } = await settledSingleNodeTree(t, slug);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(runtime.prepareTreeExport(workspace, slug, controller.signal), error =>
    error instanceof Error && error.name === "AbortError",
  );
  assert.equal(existsSync(join(workspace, `outputs/${slug}-tree.md`)), false);
  assert.equal(existsSync(join(workspace, `outputs/${slug}-tree.provenance.md`)), false);
});

test("resumeTree rejects completed trees", async t => {
  const { workspace, runtime } = await completedSingleNodeTree(t, "closed-resume");
  await assert.rejects(runtime.resumeTree(workspace, "closed-resume"));
  const current = await runtime.treeStatus(workspace, "closed-resume");
  assert.equal(current.tree.state.state, "completed");
});

test("recoverTree rejects completed trees", async t => {
  const { workspace, runtime } = await completedSingleNodeTree(t, "closed-recovery");
  await assert.rejects(runtime.recoverTree(workspace, "closed-recovery"));
  const current = await runtime.treeStatus(workspace, "closed-recovery");
  assert.equal(current.tree.state.state, "completed");
});

test("pauseTree rejects completed trees", async t => {
  const { workspace, runtime } = await completedSingleNodeTree(t, "closed-tree-pause");
  await assert.rejects(runtime.pauseTree(workspace, "closed-tree-pause"));
  const current = await runtime.treeStatus(workspace, "closed-tree-pause");
  assert.equal(current.tree.state.state, "completed");
});

test("pauseTreeNode cannot reopen a completed tree", async t => {
  const { workspace, runtime } = await completedSingleNodeTree(t, "closed-node-pause");
  await assert.rejects(runtime.pauseTreeNode(workspace, "closed-node-pause", "root"));
  const current = await runtime.treeStatus(workspace, "closed-node-pause");
  assert.equal(current.tree.state.state, "completed");
});

test("completed-tree status does not mutate the provenance journal", async t => {
  const slug = "closed-status";
  const { workspace, runtime } = await completedSingleNodeTree(t, slug);
  const tree = (await runtime.treeStatus(workspace, slug)).tree;
  const nodeWorkspace = await runtime.treeNodeWorkspace(workspace, slug, "root");
  const nodeRoot = await experimentRoot(nodeWorkspace, slug);
  const experiment = await load(nodeRoot);
  experiment.state.trialAttempts++;
  await lock(nodeRoot, async () => save(experiment, "post-close-state-drift"));

  const journalPath = join(tree.root, "events.jsonl");
  const journalHash = await fileHash(journalPath);
  const provenancePath = join(workspace, `outputs/${slug}-tree.provenance.md`);
  const provenance = await readFile(provenancePath, "utf8");
  assert.ok(provenance.includes(journalHash));

  const current = await runtime.treeStatus(workspace, slug);
  assert.equal(current.tree.state.state, "completed");
  assert.equal(await fileHash(journalPath), journalHash);
  assert.ok((await readFile(provenancePath, "utf8")).includes(journalHash));
});

test("tree recovery clears only reservations with no live node owner and resumes without relaunch", async t => {
  const { workspace } = await gitFixture(t);
  const runtime = await import("../src/experiments/index.js");
  await runtime.createTree(workspace, {
    slug: "recovery-tree",
    ...contract,
    filesInScope: ["scope.txt"],
    maxTotalTrials: 2,
    maxTotalWallSeconds: 90,
  });
  let tree = (await runtime.treeStatus(workspace, "recovery-tree")).tree;
  tree.state.state = "running";
  tree.state.activeRuns.push({
    id: "interrupted-reservation",
    nodeId: "root",
    kind: "trial",
    startedAt: Date.now(),
    reservedMs: 20000,
    trialAttemptsBefore: 0,
    baselineAttemptsBefore: 0,
  });
  await saveTree(tree, "run_reserved");

  const recovered = await runtime.recoverTree(workspace, "recovery-tree");
  assert.equal(recovered.state.state, "paused");
  assert.deepEqual(recovered.state.activeRuns, []);
  const resumed = await runtime.resumeTree(workspace, "recovery-tree");
  assert.equal(resumed.state.state, "ready");
  assert.equal((await runtime.treeNodeStatus(workspace, "recovery-tree", "root")).state.trialAttempts, 0);
});

test("parallel siblings run up to the configured cap and reject the next reservation", { timeout: 30000 }, async t => {
  const { workspace } = await gitFixture(t);
  const runtime = await import("../src/experiments/index.js");
  await runtime.createTree(workspace, {
    slug: "parallel-tree",
    ...contract,
    argv: [process.execPath, "benchmark.mjs", "--hold"],
    filesInScope: ["scope.txt"],
    maxTotalTrials: 2,
    maxTotalWallSeconds: 90,
    maxParallelRuns: 2,
  });
  await runtime.approveTreeNode(workspace, "parallel-tree", "root");

  const beginHeldBaseline = (nodeId: string) => {
    let signalActive: (runId: string) => void = () => {};
    let signaled = false;
    const active = new Promise<string>(resolve => { signalActive = resolve; });
    const run = runtime.runTreeNode(workspace, "parallel-tree", nodeId, "baseline", {
      onStatus: experiment => {
        const runId = experiment.state.active?.id;
        if (runId && !signaled) { signaled = true; signalActive(runId); }
      },
    });
    return { active, run };
  };
  const release = async (nodeId: string, runId: string) => {
    const experiment = await runtime.treeNodeStatus(workspace, "parallel-tree", nodeId);
    await writeFile(join(experiment.root, "runs", runId, "continue"), "");
  };

  const rootRun = beginHeldBaseline("root");
  const rootRunId = await rootRun.active;
  const rootReceipt = await release("root", rootRunId).then(() => rootRun.run);
  await runtime.closeTreeNode(workspace, "parallel-tree", "root");
  await runtime.forkTreeNode(workspace, "parallel-tree", "root", "left", "First sibling");
  await runtime.forkTreeNode(workspace, "parallel-tree", "root", "right", "Second sibling");
  await runtime.forkTreeNode(workspace, "parallel-tree", "root", "third", "Third sibling");
  await runtime.approveTreeNode(workspace, "parallel-tree", "left");
  await runtime.approveTreeNode(workspace, "parallel-tree", "right");
  await runtime.approveTreeNode(workspace, "parallel-tree", "third");

  const leftRun = beginHeldBaseline("left");
  const leftRunId = await leftRun.active;
  const rightRun = beginHeldBaseline("right");
  const rightRunId = await rightRun.active;
  await assert.rejects(runtime.runTreeNode(workspace, "parallel-tree", "third", "baseline"), /parallel-run budget is full/);
  const leftReceipt = await release("left", leftRunId).then(() => leftRun.run);
  const rightReceipt = await release("right", rightRunId).then(() => rightRun.run);
  const thirdRun = beginHeldBaseline("third");
  const thirdRunId = await thirdRun.active;
  const thirdReceipt = await release("third", thirdRunId).then(() => thirdRun.run);

  assert.equal(rootReceipt.valid, true);
  assert.equal(leftReceipt.valid, true);
  assert.equal(rightReceipt.valid, true);
  assert.equal(thirdReceipt.valid, true);
});

test("an active run settles while a sibling fork blocks in worktree creation", { timeout: 60000 }, async t => {
  const { workspace } = await gitFixture(t);
  const runtime = await import("../src/experiments/index.js");
  const treeName = "fork-settlement";
  const created = await runtime.createTree(workspace, {
    slug: treeName,
    ...contract,
    argv: [process.execPath, "benchmark.mjs", "--hold-active"],
    filesInScope: ["scope.txt"],
    maxTotalTrials: 4,
    maxTotalWallSeconds: 180,
    maxParallelRuns: 2,
  });
  await runtime.approveTreeNode(workspace, treeName, "root");
  const rootBaseline = await runtime.runTreeNode(workspace, treeName, "root", "baseline");
  assert.equal(rootBaseline.valid, true);
  await runtime.closeTreeNode(workspace, treeName, "root");

  for (const nodeId of ["parent-a", "parent-b"]) {
    await runtime.forkTreeNode(workspace, treeName, "root", nodeId, `Parent ${nodeId}`);
    await runtime.approveTreeNode(workspace, treeName, nodeId);
    const receipt = await runtime.runTreeNode(workspace, treeName, nodeId, "baseline");
    assert.equal(receipt.valid, true);
    await runtime.closeTreeNode(workspace, treeName, nodeId);
  }
  await runtime.forkTreeNode(workspace, treeName, "parent-a", "active-node", "Hold a sibling baseline.");
  await runtime.approveTreeNode(workspace, treeName, "active-node");

  let signalActive: (runId: string) => void = () => {};
  let signaled = false;
  const active = new Promise<string>(resolve => { signalActive = resolve; });
  const activeRun = runtime.runTreeNode(workspace, treeName, "active-node", "baseline", {
    onStatus: experiment => {
      const runId = experiment.state.active?.id;
      if (runId && !signaled) { signaled = true; signalActive(runId); }
    },
  });
  const activeRunResult = activeRun.then(
    receipt => ({ receipt }),
    (error: unknown) => ({ error }),
  );
  const activeRunId = await active;

  const hookEntered = join(workspace, "fork-hook-entered");
  const releaseFork = join(workspace, "fork-hook-release");
  const hook = join(workspace, ".git/hooks/post-checkout");
  writeFileSync(hook, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const entered = ${JSON.stringify(hookEntered)};
const release = ${JSON.stringify(releaseFork)};
fs.writeFileSync(entered, "entered");
if (fs.existsSync(release)) process.exit(0);
const watcher = fs.watch(path.dirname(release), () => {
  if (fs.existsSync(release)) {
    watcher.close();
    process.exit(0);
  }
});
watcher.once("error", error => { console.error(error); process.exit(1); });
if (fs.existsSync(release)) { watcher.close(); process.exit(0); }
`);
  chmodSync(hook, 0o755);
  const forkEntered = waitForFile(hookEntered);
  const slowFork = runtime.forkTreeNode(workspace, treeName, "parent-b", "slow-child", "Block outside the tree lock.");
  try {
    await forkEntered;
    await assert.rejects(runtime.recoverTree(workspace, treeName), (error: unknown) =>
      error instanceof Error && error.name === "TreeNodeCreationInProgressError",
    );
    const activeExperiment = await runtime.treeNodeStatus(workspace, treeName, "active-node");
    const journalPath = join(created.tree.root, "events.jsonl");
    const journal = await readFile(journalPath, "utf8");
    const settledEvent = waitForTreeEvent(journalPath, journal.length, "run_settled");
    await writeFile(join(activeExperiment.root, "runs", activeRunId, "continue"), "");
    await settledEvent;
    const activeResult = await activeRunResult;
    if ("error" in activeResult) throw activeResult.error;
    assert.equal(activeResult.receipt.valid, true);
  } finally {
    await writeFile(releaseFork, "");
    await slowFork.catch(() => undefined);
  }

  const forked = await slowFork;
  assert.equal(forked.state.nodes.find(node => node.id === "slow-child")?.status, "planned");
  const settledTree = await runtime.treeStatus(workspace, treeName);
  assert.deepEqual(settledTree.tree.state.activeRuns, []);
});

