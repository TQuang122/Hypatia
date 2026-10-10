import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { alive } from "./files.js";
import { audit, verifyEnvironment } from "./lifecycle.js";
import { verifyReceipt } from "./receipts.js";
import { verifyReviewHistory, requireReviewGate } from "./reviews.js";
import { acknowledgeStoppedLaunch, close, decide, pause, resume, start, status, wait, type Experiment } from "./engine.js";
import { lock } from "./store.js";
import type { Receipt } from "./schema.js";
import type { ExperimentTree, TreeNode, TreeRunReservation } from "./tree-schema.js";
import { loadTreeNode } from "./tree-actions.js";
import { loadTree, saveTree, treeRoot } from "./tree-store.js";

export type NodeRun = { node: TreeNode; workspace: string; experiment: Experiment };

async function readTree(workspace: string, name: string): Promise<ExperimentTree> {
  return loadTree(await treeRoot(await realpath(workspace), name));
}

export async function readNodes(tree: ExperimentTree): Promise<NodeRun[]> {
  const incomplete = tree.state.nodes.find(node => node.status !== "planned");
  if (incomplete) throw new Error(`Tree node ${incomplete.id} creation is incomplete; recover it before running or closing the tree.`);
  return readPlannedNodes(tree);
}

async function readPlannedNodes(tree: ExperimentTree): Promise<NodeRun[]> {
  const nodes: NodeRun[] = [];
  for (const node of tree.state.nodes) {
    if (node.status !== "planned") continue;
    nodes.push(await loadTreeNode(tree, node.id));
  }
  return nodes;
}

export function updateTotals(tree: ExperimentTree, nodes: NodeRun[]): void {
  tree.state.trialAttempts = nodes.reduce((sum, item) => sum + item.experiment.state.trialAttempts, 0);
  tree.state.baselineAttempts = nodes.reduce((sum, item) => sum + item.experiment.state.baselineAttempts, 0);
  tree.state.spentMs = nodes.reduce((sum, item) => sum + item.experiment.state.spentMs, 0);
}

type TreeOperation = "pause" | "resume" | "recover";
class CompletedTreeError extends Error {
  readonly name = "CompletedTreeError";

  constructor(readonly operation: TreeOperation) {
    super(`Cannot ${operation} a completed experiment tree.`);
  }
}

class TreeNodeCreationInProgressError extends Error {
  readonly name = "TreeNodeCreationInProgressError";

  constructor(readonly nodeId: string) {
    super(`Tree node ${nodeId} creation is still active.`);
  }
}

function assertTreeNotCompleted(tree: ExperimentTree, operation: TreeOperation): void {
  if (tree.state.state === "completed") throw new CompletedTreeError(operation);
}

async function releaseReservation(root: string, id: string): Promise<ExperimentTree> {
  return lock(root, async () => {
    const tree = await loadTree(root);
    if (tree.state.state === "completed") return tree;
    const nodes = await readPlannedNodes(tree);
    const activeNodeIds = new Set(nodes.filter(item => item.experiment.state.active).map(item => item.node.id));
    tree.state.activeRuns = tree.state.activeRuns.filter(item => item.id !== id || activeNodeIds.has(item.nodeId));
    updateTotals(tree, nodes);
    if (tree.state.state !== "blocked") {
      if (tree.state.activeRuns.length) tree.state.state = tree.state.state === "pause_requested" ? "pause_requested" : "running";
      else tree.state.state = tree.state.state === "pause_requested" || nodes.some(item => item.experiment.state.state === "paused") ? "paused" : "ready";
    }
    await saveTree(tree, "run_settled");
    return tree;
  });
}

async function reserveRun(
  workspace: string,
  treeName: string,
  nodeId: string,
  kind: "baseline" | "trial",
): Promise<{ tree: ExperimentTree; node: NodeRun; reservation: TreeRunReservation; cached?: Receipt }> {
  const root = await treeRoot(await realpath(workspace), treeName);
  return lock(root, async () => {
    const tree = await loadTree(root);
    if (["completed", "paused", "pause_requested", "blocked"].includes(tree.state.state)) {
      throw new Error(`Experiment tree is ${tree.state.state}; resume or recover it before starting a node.`);
    }
    const nodes = await readPlannedNodes(tree);
    const node = nodes.find(item => item.node.id === nodeId);
    if (!node) throw new Error(`Experiment tree node not found: ${nodeId}`);
    const { state, contract } = node.experiment;
    if (state.state === "completed") throw new Error("A closed tree node cannot run another benchmark.");
    if (state.approval?.contractHash !== state.contractHash) throw new Error("Approve the tree node contract before running it.");
    if (kind === "baseline" && state.baselineId) {
      const ref = state.receipts.find(item => item.id === state.baselineId);
      if (!ref) throw new Error("Saved tree baseline receipt is missing.");
      await verifyEnvironment(node.experiment); await audit(node.experiment); await requireReviewGate(node.experiment, "plan");
      const cached = await verifyReceipt(node.experiment.root, ref, state.contractHash, contract.environmentFingerprint?.sha256);
      tree.state.trialAttempts = nodes.reduce((sum, item) => sum + item.experiment.state.trialAttempts, 0);
      tree.state.baselineAttempts = nodes.reduce((sum, item) => sum + item.experiment.state.baselineAttempts, 0);
      tree.state.spentMs = nodes.reduce((sum, item) => sum + item.experiment.state.spentMs, 0);
      await saveTree(tree, "baseline_reused");
      return { tree, node, reservation: { id: "", nodeId, kind, startedAt: Date.now(), reservedMs: 1, trialAttemptsBefore: state.trialAttempts, baselineAttemptsBefore: state.baselineAttempts }, cached };
    }
    if (tree.state.activeRuns.some(item => item.nodeId === nodeId)) throw new Error("This tree node already has a reserved run; recover or wait for it before starting another.");
    if (tree.state.activeRuns.length >= tree.definition.budget.maxParallelRuns) throw new Error("Experiment tree parallel-run budget is full.");
    const reservedTrialAttempts = tree.state.activeRuns.reduce((sum, item) => {
      const active = nodes.find(candidate => candidate.node.id === item.nodeId);
      const uncounted = active && active.experiment.state.trialAttempts <= item.trialAttemptsBefore;
      return sum + (item.kind === "trial" && uncounted ? 1 : 0);
    }, 0);
    const totalTrialAttempts = nodes.reduce((sum, item) => sum + item.experiment.state.trialAttempts, 0) + reservedTrialAttempts;
    if (kind === "trial" && totalTrialAttempts >= tree.definition.budget.maxTotalTrials) {
      throw new Error("Experiment tree shared trial budget is exhausted.");
    }
    const spentMs = nodes.reduce((sum, item) => sum + item.experiment.state.spentMs, 0);
    const reservedMs = tree.state.activeRuns.reduce((sum, item) => sum + item.reservedMs, 0);
    const nextReservationMs = contract.timeoutPerRun * 1000;
    if (spentMs + reservedMs + nextReservationMs > tree.definition.budget.maxTotalWallSeconds * 1000) {
      throw new Error("Experiment tree shared wall-time budget cannot reserve one complete configuration.");
    }
    const reservation: TreeRunReservation = {
      id: randomUUID(), nodeId, kind, startedAt: Date.now(), reservedMs: nextReservationMs,
      trialAttemptsBefore: state.trialAttempts, baselineAttemptsBefore: state.baselineAttempts,
    };
    tree.state.activeRuns.push(reservation);
    tree.state.state = "running";
    updateTotals(tree, nodes);
    await saveTree(tree, "run_reserved");
    return { tree, node, reservation };
  });
}

export async function runTreeNode(
  workspace: string,
  treeName: string,
  nodeId: string,
  kind: "baseline" | "trial",
  options: { signal?: AbortSignal; onStatus?: (experiment: Experiment) => void } = {},
): Promise<Receipt> {
  const reserved = await reserveRun(workspace, treeName, nodeId, kind);
  if (reserved.cached) return reserved.cached;
  try {
    const started = await start(reserved.node.workspace, reserved.node.node.experimentSlug, kind, {
      treeReservationId: reserved.reservation.id,
    });
    if (started.cached) {
      await releaseReservation(reserved.tree.root, reserved.reservation.id);
      return started.cached;
    }
    const receipt = await wait(reserved.node.workspace, reserved.node.node.experimentSlug, started.runId!, {
      signal: options.signal,
      onStatus: options.onStatus,
    });
    await releaseReservation(reserved.tree.root, reserved.reservation.id);
    return receipt;
  } catch (error) {
    const current = await status(reserved.node.workspace, reserved.node.node.experimentSlug).catch(() => undefined);
    if (!current?.state.active) await releaseReservation(reserved.tree.root, reserved.reservation.id);
    throw error;
  }
}

export async function decideTreeNode(
  workspace: string,
  treeName: string,
  nodeId: string,
  receiptId: string,
  decision: "keep" | "revert" | "failed",
  reason: string,
): Promise<Experiment> {
  const tree = await readTree(workspace, treeName), node = await loadTreeNode(tree, nodeId);
  return decide(node.workspace, node.node.experimentSlug, receiptId, decision, reason);
}

export async function pauseTreeNode(workspace: string, treeName: string, nodeId: string): Promise<Experiment> {
  const tree = await readTree(workspace, treeName);
  return lock(tree.root, async () => {
    const current = await loadTree(tree.root);
    assertTreeNotCompleted(current, "pause");
    if (current.state.nodes.some(node => node.status !== "planned")) throw new Error("Finish or recover node creation before pausing the tree.");
    const node = await loadTreeNode(current, nodeId);
    const experiment = await pause(node.workspace, node.node.experimentSlug);
    const nodes = await readNodes(current);
    updateTotals(current, nodes);
    if (current.state.activeRuns.length) current.state.state = "pause_requested";
    else current.state.state = "paused";
    await saveTree(current, "node_pause_requested");
    return experiment;
  });
}

export async function resumeTreeNode(workspace: string, treeName: string, nodeId: string): Promise<Experiment> {
  const tree = await readTree(workspace, treeName);
  return lock(tree.root, async () => {
    const current = await loadTree(tree.root);
    assertTreeNotCompleted(current, "resume");
    if (current.state.nodes.some(node => node.status !== "planned")) throw new Error("Finish or recover node creation before resuming the tree.");
    const node = await loadTreeNode(current, nodeId);
    const experiment = await resume(node.workspace, node.node.experimentSlug);
    const nodes = await readNodes(current);
    updateTotals(current, nodes);
    current.state.state = current.state.activeRuns.length ? "running" : "ready";
    current.state.message = undefined;
    await saveTree(current, "node_resumed");
    return experiment;
  });
}

export async function pauseTree(workspace: string, treeName: string): Promise<ExperimentTree> {
  const tree = await readTree(workspace, treeName);
  await lock(tree.root, async () => {
    const current = await loadTree(tree.root);
    assertTreeNotCompleted(current, "pause");
    if (current.state.nodes.some(node => node.status !== "planned")) throw new Error("Finish or recover node creation before pausing the tree.");
    current.state.state = current.state.activeRuns.length ? "pause_requested" : "paused";
    await saveTree(current, "tree_pause_requested");
  });
  const current = await loadTree(tree.root), nodes = await readNodes(current);
  for (const node of nodes) if (node.experiment.state.active) await pause(node.workspace, node.node.experimentSlug);
  return lock(tree.root, async () => {
    const latest = await loadTree(tree.root);
    assertTreeNotCompleted(latest, "pause");
    const settled = await readNodes(latest);
    updateTotals(latest, settled);
    latest.state.state = latest.state.activeRuns.length ? "pause_requested" : "paused";
    await saveTree(latest, "tree_paused");
    return latest;
  });
}

export async function resumeTree(workspace: string, treeName: string): Promise<ExperimentTree> {
  const tree = await readTree(workspace, treeName);
  return lock(tree.root, async () => {
    const current = await loadTree(tree.root);
    assertTreeNotCompleted(current, "resume");
    if (current.state.nodes.some(node => node.status !== "planned")) throw new Error("Tree node creation is incomplete; inspect it before resume.");
    const nodes = await readNodes(current);
    for (const node of nodes) {
      const active = node.experiment.state.active;
      if (active) {
        if (alive(active.workerPid) || alive(active.childPid)) continue;
        await pause(node.workspace, node.node.experimentSlug);
      }
      const latest = await status(node.workspace, node.node.experimentSlug);
      if (!latest.state.active && ["paused", "blocked"].includes(latest.state.state)) {
        await resume(node.workspace, node.node.experimentSlug);
      }
    }
    const settled = await readNodes(current);
    updateTotals(current, settled);
    current.state.activeRuns = current.state.activeRuns.filter(reservation => settled.some(node => node.node.id === reservation.nodeId && !!node.experiment.state.active));
    current.state.state = current.state.activeRuns.length ? "running" : "ready";
    current.state.message = undefined;
    await saveTree(current, "tree_resumed");
    return current;
  });
}

export async function recoverTree(workspace: string, treeName: string): Promise<ExperimentTree> {
  const tree = await readTree(workspace, treeName);
  return lock(tree.root, async () => {
    const current = await loadTree(tree.root);
    assertTreeNotCompleted(current, "recover");
    const incomplete = current.state.nodes.find(node => node.status !== "planned");
    if (incomplete) {
      if (incomplete.creationPid && alive(incomplete.creationPid)) throw new TreeNodeCreationInProgressError(incomplete.id);
      current.state.state = "blocked";
      current.state.message = `Node ${incomplete.id} creation is incomplete at ${incomplete.worktree}. Inspect its files and Git worktree registration; recovery never deletes or recreates it automatically.`;
      await saveTree(current, "tree_recovery_required");
      return current;
    }
    const nodes = await readNodes(current);
    for (const node of nodes) if (node.experiment.state.active) await pause(node.workspace, node.node.experimentSlug);
    const settled = await readNodes(current);
    updateTotals(current, settled);
    current.state.activeRuns = current.state.activeRuns.filter(reservation => settled.some(node => node.node.id === reservation.nodeId && !!node.experiment.state.active));
    current.state.state = current.state.activeRuns.length ? "pause_requested" : "paused";
    await saveTree(current, "tree_recovered");
    return current;
  });
}

export async function acknowledgeTreeStoppedLaunch(workspace: string, treeName: string, nodeId: string): Promise<Experiment> {
  const tree = await readTree(workspace, treeName), node = await loadTreeNode(tree, nodeId);
  const experiment = await acknowledgeStoppedLaunch(node.workspace, node.node.experimentSlug);
  await releaseReservation(tree.root, tree.state.activeRuns.find(item => item.nodeId === nodeId)?.id ?? "");
  return experiment;
}

export async function closeTreeNode(workspace: string, treeName: string, nodeId: string): Promise<Awaited<ReturnType<typeof close>>> {
  const tree = await readTree(workspace, treeName), node = await loadTreeNode(tree, nodeId);
  return close(node.workspace, node.node.experimentSlug);
}

