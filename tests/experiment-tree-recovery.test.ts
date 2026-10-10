import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, watch, writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createInitialTreeStateWithRoot, validateTreeInput, type TreeDefinition } from "../src/experiments/tree-schema.js";
import { initializeTreeAt, loadTree } from "../src/experiments/tree-store.js";
import { createTreeWorktree, inspectTreeRepository } from "../src/experiments/tree-worktrees.js";
import { registerExperimentWorkflow } from "../extensions/research-tools/experiment-workflow.js";

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
  const workspace = mkdtempSync(join(tmpdir(), "experiment tree recovery-"));
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
  writeFileSync(join(workspace, "benchmark.mjs"), "console.log('HYPATIA_METRIC {\"score\":1}');\n");
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

type RegisteredTreeTool = {
  execute(
    id: string,
    params: { action: string; slug?: string; parentNodeId?: string; nodeId?: string; hypothesis?: string },
    signal: AbortSignal | undefined,
    onUpdate: ((result: unknown) => void) | undefined,
    ctx: ExtensionCommandContext,
  ): Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
};

function registeredTreeTool(): RegisteredTreeTool {
  let definition: RegisteredTreeTool | undefined;
  const pi = { registerTool: (value: unknown) => { definition = value as RegisteredTreeTool; }, on() {} } as unknown as ExtensionAPI;
  registerExperimentWorkflow(pi);
  if (!definition) throw new Error("Experiment workflow tool was not registered.");
  return definition;
}

async function completedSingleNodeTree(t: TestContext, slug: string) {
  const { workspace, runtime } = await settledSingleNodeTree(t, slug);
  await runtime.closeTree(workspace, slug);
  return { workspace, runtime };
}

test("aborted worktree creation does not publish a node directory", async t => {
  const { workspace, baseCommit, treeRoot } = await gitFixture(t);
  await mkdir(treeRoot, { recursive: true });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(createTreeWorktree({
    workspace, treeRoot, path: "experiments/.trees/tree-case/nodes/cancelled",
    baseCommit, inputFiles: [], inputHashes: {}, signal: controller.signal,
  }), error => error instanceof Error && error.name === "AbortError");
  assert.equal(existsSync(join(treeRoot, "nodes/cancelled")), false);
});

test("root creation ownership is journaled before the tree becomes discoverable", async t => {
  const { workspace } = await gitFixture(t);
  const runtime = await import("../src/experiments/index.js");
  await runtime.createTree(workspace, {
    slug: "published-root",
    ...contract,
    filesInScope: ["scope.txt"],
    maxTotalTrials: 2,
    maxTotalWallSeconds: 90,
  });

  const journal = await readFile(join(workspace, "experiments/.trees/published-root/events.jsonl"), "utf8");
  const initial = JSON.parse(journal.split("\n")[0]!) as { state: { nodes: Array<{ id: string; status: string; creationPid?: number }> } };
  assert.deepEqual(initial.state.nodes.map(node => node.id), ["root"]);
  assert.equal(initial.state.nodes[0]!.status, "creating");
  assert.equal(initial.state.nodes[0]!.creationPid, process.pid);
});

test("published root creation can be recovered after its creator exits", async t => {
  const { workspace, baseCommit, treeRoot } = await gitFixture(t);
  const input = validateTreeInput({
    slug: "tree-case",
    ...contract,
    filesInScope: ["scope.txt"],
    maxTotalTrials: 2,
    maxTotalWallSeconds: 90,
  });
  const definition: TreeDefinition = {
    version: 1,
    slug: input.slug,
    workspace: await realpath(workspace),
    baseCommit,
    createdAt: new Date().toISOString(),
    protocol: input.contract,
    budget: input.budget,
    inputHashes: {},
  };
  const treesDirectory = dirname(treeRoot);
  const stagingRoot = join(treesDirectory, ".tree-case.crash-staging");
  const creatorPid = Number.MAX_SAFE_INTEGER;
  await mkdir(treesDirectory, { recursive: true });
  await mkdir(stagingRoot);
  await initializeTreeAt(workspace, stagingRoot, definition, createInitialTreeStateWithRoot(definition, creatorPid));
  await rename(stagingRoot, treeRoot);

  const published = await loadTree(treeRoot);
  assert.equal(published.state.nodes[0]!.status, "creating");
  assert.equal(published.state.nodes[0]!.creationPid, creatorPid);

  const runtime = await import("../src/experiments/index.js");
  const recovered = await runtime.recoverTree(workspace, "tree-case");
  assert.equal(recovered.state.state, "blocked");
  assert.match(recovered.state.message ?? "", /Node root creation is incomplete/);
  assert.equal(recovered.state.nodes.length, 1);
  assert.equal(recovered.state.nodes[0]!.creationPid, creatorPid);
});

test("ready-root tree menu omits approval fork promotion and closure actions", async t => {
  const { workspace } = await gitFixture(t);
  const runtime = await import("../src/experiments/index.js");
  await runtime.createTree(workspace, {
    slug: "ready-menu",
    ...contract,
    filesInScope: ["scope.txt"],
    maxTotalTrials: 2,
    maxTotalWallSeconds: 90,
  });
  await runtime.approveTreeNode(workspace, "ready-menu", "root");
  const { runExperimentsCommand } = await import("../extensions/research-tools/experiments.js");
  const calls: Array<{ title: string; options: string[] }> = [];
  const selections = ["Manage experiment trees", "ready-menu · 1 node · 0/2 trials", "Back", "Back"];
  const context = {
    cwd: workspace, mode: "tui", hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => { calls.push({ title, options }); return selections.shift(); },
      notify() {},
    },
  } as unknown as ExtensionCommandContext;

  await runExperimentsCommand("", context);

  const actions = calls.find(call => call.title === "Tree ready-menu");
  assert.deepEqual(actions?.options, [
    "View tree status", "Pause tree", "Export tree report", "Continue a node in chat", "Back",
  ]);
});

test("completed tree menu hides actions rejected by the terminal state", async t => {
  const { workspace } = await completedSingleNodeTree(t, "closed-menu");
  const { runExperimentsCommand } = await import("../extensions/research-tools/experiments.js");
  const calls: Array<{ title: string; options: string[] }> = [];
  const selections = ["Manage experiment trees", "closed-menu · 1 node · 0/2 trials", "Back", "Back"];
  const context = {
    cwd: workspace, mode: "tui", hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => { calls.push({ title, options }); return selections.shift(); },
      notify() {},
    },
  } as unknown as ExtensionCommandContext;

  await runExperimentsCommand("", context);

  const actions = calls.find(call => call.title === "Tree closed-menu");
  assert.deepEqual(actions?.options, ["View tree status", "Export tree report", "Back"]);
});

test("cancelling a blocked fork preserves its incomplete node for recovery", { timeout: 60000 }, async t => {
  const { workspace, runtime } = await settledSingleNodeTree(t, "fork-cancel");
  const hookEntered = join(workspace, "fork-cancel-hook-entered");
  const releaseFork = join(workspace, "fork-cancel-hook-release");
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
  const controller = new AbortController();
  const fork = runtime.forkTreeNode(workspace, "fork-cancel", "root", "cancelled-child", "Cancel during worktree creation.", controller.signal);
  try {
    await forkEntered;
    controller.abort();
    await assert.rejects(fork, error => error instanceof Error && error.name === "AbortError");
  } finally {
    await writeFile(releaseFork, "");
    await fork.catch(() => undefined);
  }

  const tree = (await runtime.treeStatus(workspace, "fork-cancel")).tree;
  const child = tree.state.nodes.find(node => node.id === "cancelled-child");
  assert.equal(tree.state.state, "blocked");
  assert.ok(child);
  assert.equal(child.status, "creating");
  assert.equal(child.creationPid, undefined);
  assert.match(tree.state.message ?? "", /cancelled-child creation stopped/);
});

test("agent tree_fork passes cancellation to the runtime before creating a child", async t => {
  const { workspace, runtime } = await settledSingleNodeTree(t, "agent-fork-cancel");
  const tool = registeredTreeTool();
  const controller = new AbortController();
  let progressReported = false;
  const ctx = { cwd: workspace, mode: "rpc", hasUI: false } as unknown as ExtensionCommandContext;

  const result = await tool.execute(
    "agent-fork-cancel",
    { action: "tree_fork", slug: "agent-fork-cancel", parentNodeId: "root", nodeId: "cancelled-child", hypothesis: "Cancel before reservation." },
    controller.signal,
    () => { progressReported = true; controller.abort(); },
    ctx,
  );

  assert.equal(progressReported, true);
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /abort/i);
  assert.deepEqual((await runtime.treeStatus(workspace, "agent-fork-cancel")).tree.state.nodes.map(node => node.id), ["root"]);
});

test("agent tree_export passes cancellation before publishing report artifacts", async t => {
  const { workspace } = await gitFixture(t);
  const runtime = await import("../src/experiments/index.js");
  const slug = "agent-export-cancel";
  await runtime.createTree(workspace, {
    slug,
    ...contract,
    filesInScope: ["scope.txt"],
    maxTotalTrials: 2,
    maxTotalWallSeconds: 90,
  });
  const tool = registeredTreeTool();
  const controller = new AbortController();
  const updates: unknown[] = [];
  const ctx = { cwd: workspace, mode: "rpc", hasUI: false } as unknown as ExtensionCommandContext;

  const result = await tool.execute(
    "agent-export-cancel",
    { action: "tree_export", slug },
    controller.signal,
    update => { updates.push(update); if (updates.length === 2) controller.abort(); },
    ctx,
  );

  assert.equal(updates.length, 2);
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /abort/i);
  assert.equal(existsSync(join(workspace, `outputs/${slug}-tree.md`)), false);
  assert.equal(existsSync(join(workspace, `outputs/${slug}-tree.provenance.md`)), false);
});
