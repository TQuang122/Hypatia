import { lstat, mkdir, realpath, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { objectHash, safePath } from "./files.js";
import { slug, validateInput } from "./schema.js";
import { audit, verifyEnvironment } from "./lifecycle.js";
import { verifyReceipt } from "./receipts.js";
import { verifyReviewHistory, requireReviewGate } from "./reviews.js";
import { approve, create, status, type Experiment } from "./engine.js";
import { lock } from "./store.js";
import { createInitialTreeStateWithRoot, validateTreeInput, type ExperimentTree, type TreeNode } from "./tree-schema.js";
import { initializeTreeAt, listTrees, loadTree, saveTree, treeRoot } from "./tree-store.js";
import { createTreeWorktree, freezeTreeInputs, inspectTreeRepository, verifyTreeWorktree } from "./tree-worktrees.js";
import { assertTreeReportPathsAvailable } from "./tree-report.js";
import type { Receipt } from "./schema.js";

export type TreeNodeView = { node: TreeNode; experiment?: Experiment; message?: string };
export type ExperimentTreeView = { tree: ExperimentTree; nodes: TreeNodeView[] };

async function readTree(workspace: string, name: string): Promise<ExperimentTree> {
  return loadTree(await treeRoot(await realpath(workspace), name));
}

function nodeRecord(tree: ExperimentTree, id: string): TreeNode {
  const node = tree.state.nodes.find(candidate => candidate.id === id);
  if (!node) throw new Error(`Experiment tree node not found: ${id}`);
  return node;
}

async function loadNode(tree: ExperimentTree, id: string): Promise<{ node: TreeNode; workspace: string; experiment: Experiment }> {
  const node = nodeRecord(tree, id);
  if (node.status !== "planned" || !node.contractHash || !node.sourceSnapshotHash) {
    throw new Error(`Tree node ${id} has an incomplete worktree/contract creation; preserve it and inspect before recovery.`);
  }
  const workspace = await verifyTreeWorktree(tree.definition.workspace, tree.root, node.worktree, tree.definition.baseCommit);
  const experiment = await status(workspace, node.experimentSlug);
  if (experiment.state.contractHash !== node.contractHash || experiment.contract.workspace !== workspace) {
    throw new Error(`Tree node ${id} experiment contract no longer matches its lineage record.`);
  }
  const contract = experiment.contract, protocol = tree.definition.protocol;
  const expectedCwd = await safePath(workspace, protocol.cwd ?? ".", true);
  if (
    contract.slug !== tree.definition.slug || contract.cwd !== expectedCwd
    || contract.treeBinding?.treeSlug !== tree.definition.slug
    || contract.treeBinding.nodeId !== node.id
    || contract.treeBinding.workspace !== tree.definition.workspace
    || objectHash(contract.argv.slice(1)) !== objectHash(protocol.argv.slice(1))
    || objectHash(contract.filesInScope) !== objectHash(protocol.filesInScope)
    || objectHash(contract.inputFiles) !== objectHash(protocol.inputFiles)
    || objectHash(contract.inputHashes) !== objectHash(tree.definition.inputHashes)
    || objectHash(contract.seeds) !== objectHash(protocol.seeds)
    || objectHash(contract.metric) !== objectHash(protocol.metric)
    || contract.environment !== protocol.environment
    || contract.maxIterations !== tree.definition.budget.maxTotalTrials
    || contract.maxWallSeconds !== tree.definition.budget.maxTotalWallSeconds
    || contract.timeoutPerRun !== protocol.timeoutPerRun || contract.reviewPolicy !== protocol.reviewPolicy
    || contract.baselineCodeHash !== node.sourceSnapshotHash
    || !contract.environmentFingerprint
  ) throw new Error(`Tree node ${id} contract no longer matches the frozen tree protocol or source lineage.`);
  if (id !== "root") {
    const rootNode = tree.state.nodes[0]!;
    const rootExperiment = await status(
      await verifyTreeWorktree(tree.definition.workspace, tree.root, rootNode.worktree, tree.definition.baseCommit),
      rootNode.experimentSlug,
    );
    if (
      contract.argv[0] !== rootExperiment.contract.argv[0]
      || contract.executableHash !== rootExperiment.contract.executableHash
      || contract.environmentFingerprint.sha256 !== rootExperiment.contract.environmentFingerprint?.sha256
    ) throw new Error(`Tree node ${id} resolved a different executable or environment fingerprint than the root node.`);
  }
  return { node, workspace, experiment };
}

export async function loadTreeNode(tree: ExperimentTree, id: string): Promise<{ node: TreeNode; workspace: string; experiment: Experiment }> {
  return loadNode(tree, id);
}

async function persistFailure(tree: ExperimentTree, message: string, kind: string): Promise<void> {
  for (const node of tree.state.nodes) {
    if (node.status === "creating" && node.creationPid === process.pid) delete node.creationPid;
  }
  tree.state.state = "blocked";
  tree.state.message = message.slice(0, 20000);
  await saveTree(tree, kind);
}

export async function createTree(workspace: string, value: unknown): Promise<{ tree: ExperimentTree; experiment: Experiment }> {
  const input = validateTreeInput(value);
  const repository = await inspectTreeRepository(workspace);
  await assertTreeReportPathsAvailable(repository.workspace, input.slug);
  const root = await treeRoot(repository.workspace, input.slug);
  if (await lstat(root).catch(() => undefined)) throw new Error("An experiment tree already uses this slug; inspect its state before choosing another.");
  const treesDirectory = dirname(root);
  await mkdir(treesDirectory, { recursive: true });
  const stagingRoot = join(treesDirectory, `.${input.slug}.${randomUUID()}.staging`);
  await mkdir(stagingRoot);
  const inputHashes = await freezeTreeInputs(repository.workspace, stagingRoot, input.contract.inputFiles);
  const definition = {
    version: 1 as const, slug: input.slug, workspace: repository.workspace, baseCommit: repository.baseCommit,
    createdAt: new Date().toISOString(), protocol: input.contract, budget: input.budget, inputHashes,
  };
  await initializeTreeAt(repository.workspace, stagingRoot, definition, createInitialTreeStateWithRoot(definition, process.pid));
  await rename(stagingRoot, root);
  const tree = await loadTree(root);
  const persistedNode = tree.state.nodes[0]!;
  try {
    const nodeWorkspace = await createTreeWorktree({
      workspace: repository.workspace, treeRoot: tree.root, path: persistedNode.worktree, baseCommit: repository.baseCommit,
      inputFiles: input.contract.inputFiles, inputHashes,
    });
    const experiment = await create(nodeWorkspace, input.contract, {
      treeBinding: { treeSlug: input.slug, nodeId: "root", workspace: repository.workspace },
    });
    const completedTree = await lock(tree.root, async () => {
      const current = await loadTree(tree.root), currentNode = nodeRecord(current, "root");
      if (current.state.state === "completed" || currentNode.status !== "creating" || currentNode.creationPid !== process.pid) {
        throw new Error("Root node creation ownership changed; preserve its worktree for inspection.");
      }
      currentNode.status = "planned";
      delete currentNode.creationPid;
      currentNode.sourceSnapshotHash = experiment.contract.baselineCodeHash;
      currentNode.contractHash = experiment.state.contractHash;
      await saveTree(current, "root_created");
      return current;
    });
    return { tree: completedTree, experiment };
  } catch (error) {
    const message = `Root node creation stopped; preserve tree files and worktree for inspection. ${error instanceof Error ? error.message : String(error)}`;
    await lock(tree.root, async () => {
      const current = await loadTree(tree.root);
      if (current.state.state !== "completed") await persistFailure(current, message, "root_creation_blocked");
    });
    throw error;
  }
}

export async function treeStatus(workspace: string, name: string): Promise<ExperimentTreeView> {
  let tree = await readTree(workspace, name);
  const nodes: TreeNodeView[] = [];
  for (const node of tree.state.nodes) {
    if (node.status !== "planned") {
      nodes.push({ node, message: "Node creation is incomplete; preserve its files and inspect before recovery." });
      continue;
    }
    const loaded = await loadNode(tree, node.id);
    nodes.push({ node, experiment: loaded.experiment });
  }
  const trials = nodes.reduce((sum, item) => sum + (item.experiment?.state.trialAttempts ?? 0), 0);
  const baselines = nodes.reduce((sum, item) => sum + (item.experiment?.state.baselineAttempts ?? 0), 0);
  const spent = nodes.reduce((sum, item) => sum + (item.experiment?.state.spentMs ?? 0), 0);
  if (tree.state.trialAttempts !== trials || tree.state.baselineAttempts !== baselines || tree.state.spentMs !== spent) {
    tree = await lock(tree.root, async () => {
      const current = await loadTree(tree.root);
      if (current.state.state === "completed") return current;
      let currentTrials = 0, currentBaselines = 0, currentSpent = 0;
      for (const node of current.state.nodes) if (node.status === "planned") {
        const loaded = await loadNode(current, node.id);
        currentTrials += loaded.experiment.state.trialAttempts;
        currentBaselines += loaded.experiment.state.baselineAttempts;
        currentSpent += loaded.experiment.state.spentMs;
      }
      if (
        current.state.trialAttempts !== currentTrials
        || current.state.baselineAttempts !== currentBaselines
        || current.state.spentMs !== currentSpent
      ) {
        current.state.trialAttempts = currentTrials;
        current.state.baselineAttempts = currentBaselines;
        current.state.spentMs = currentSpent;
        await saveTree(current, "tree_state_reconciled");
      }
      return current;
    });
  }
  return { tree, nodes };
}

export async function treeNodeStatus(workspace: string, treeName: string, nodeId: string): Promise<Experiment> {
  const tree = await readTree(workspace, treeName);
  return (await loadNode(tree, nodeId)).experiment;
}

export async function treeNodeWorkspace(workspace: string, treeName: string, nodeId: string): Promise<string> {
  const tree = await readTree(workspace, treeName);
  return (await loadNode(tree, nodeId)).workspace;
}

export async function approveTreeNode(workspace: string, treeName: string, nodeId: string): Promise<Experiment> {
  const tree = await readTree(workspace, treeName);
  const loaded = await loadNode(tree, nodeId);
  const approved = await approve(loaded.workspace, loaded.node.experimentSlug);
  await lock(tree.root, async () => {
    const current = await loadTree(tree.root);
    if (current.state.state === "completed") return;
    if (current.state.state === "planned") current.state.state = "ready";
    await saveTree(current, "node_approved");
  });
  return approved;
}

async function verifiedBest(tree: ExperimentTree, nodeId: string): Promise<{ node: TreeNode; workspace: string; experiment: Experiment; receipt: Receipt }> {
  const loaded = await loadNode(tree, nodeId), { experiment } = loaded;
  if (experiment.state.state !== "completed" || experiment.state.active || experiment.state.activeReview
    || experiment.state.receipts.some(ref => ref.kind === "trial" && !ref.decision)) {
    throw new Error("A tree parent or winner must be settled and closed before use.");
  }
  await audit(experiment);
  await verifyEnvironment(experiment);
  await verifyReviewHistory(experiment);
  await requireReviewGate(experiment, "plan");
  await requireReviewGate(experiment, "audit");
  if (!experiment.state.bestId) throw new Error("Tree node has no selected best receipt.");
  const ref = experiment.state.receipts.find(receipt => receipt.id === experiment.state.bestId);
  if (!ref || !ref.valid) throw new Error("Tree node's selected best receipt is missing or invalid.");
  const receipt = await verifyReceipt(experiment.root, ref, experiment.state.contractHash, experiment.contract.environmentFingerprint?.sha256);
  return { ...loaded, receipt };
}

export async function forkTreeNode(
  workspace: string,
  treeName: string,
  parentNodeId: string,
  nodeId: string,
  hypothesis: string,
  signal?: AbortSignal,
): Promise<ExperimentTree> {
  signal?.throwIfAborted();
  const tree = await readTree(workspace, treeName);
  const childId = slug(nodeId);
  if (childId === "root" || tree.state.nodes.some(node => node.id === childId)) throw new Error("Tree node IDs must be unique and root is reserved.");
  const parent = await verifiedBest(tree, parentNodeId);
  signal?.throwIfAborted();
  const reservation = await lock(tree.root, async () => {
    signal?.throwIfAborted();
    const current = await loadTree(tree.root);
    if (current.state.state === "completed" || current.state.nodes.length >= 100) throw new Error("This experiment tree cannot accept another node.");
    if (current.state.state === "blocked" || current.state.state === "pause_requested" || current.state.state === "paused") {
      throw new Error("Resume or recover this experiment tree before forking another node.");
    }
    if (current.state.nodes.some(node => node.status !== "planned")) {
      throw new Error("Finish or recover the existing tree node creation before forking another node.");
    }
    if (current.state.nodes.some(node => node.id === childId)) throw new Error("Tree node IDs must be unique.");
    if (parent.experiment.state.state !== "completed") throw new Error("A tree parent must be settled and closed before forking.");
    const contract = {
      ...current.definition.protocol, slug: current.definition.slug, hypothesis,
    };
    const validatedContract = validateInput(contract);
    const child: TreeNode = {
      id: childId, status: "creating", creationPid: process.pid, parentNodeId, parentReceiptId: parent.receipt.id,
      sourceSnapshotHash: parent.receipt.snapshot.hash,
      worktree: `experiments/.trees/${current.definition.slug}/nodes/${childId}`,
      experimentSlug: current.definition.slug, createdAt: new Date().toISOString(),
    };
    current.state.nodes.push(child);
    await saveTree(current, "node_fork_started");
    return { root: current.root, definition: current.definition, child, contract: validatedContract };
  });
  try {
    const nodeWorkspace = await createTreeWorktree({
      workspace: reservation.definition.workspace, treeRoot: reservation.root, path: reservation.child.worktree,
      baseCommit: reservation.definition.baseCommit, inputFiles: reservation.definition.protocol.inputFiles,
      inputHashes: reservation.definition.inputHashes,
      signal,
      sourceSnapshot: { root: parent.experiment.root, snapshot: parent.receipt.snapshot },
    });
    signal?.throwIfAborted();
    const experiment = await create(nodeWorkspace, reservation.contract, {
      treeBinding: { treeSlug: reservation.definition.slug, nodeId: childId, workspace: reservation.definition.workspace },
    });
    signal?.throwIfAborted();
    if (experiment.contract.baselineCodeHash !== reservation.child.sourceSnapshotHash) {
      throw new Error("New child baseline does not match the selected parent receipt snapshot.");
    }
    return await lock(reservation.root, async () => {
      const current = await loadTree(reservation.root);
      if (current.state.state === "completed" || current.state.state === "blocked") {
        throw new Error("Tree state changed while node creation was in progress; preserve the worktree for inspection.");
      }
      const child = current.state.nodes.find(node => node.id === childId);
      if (!child || child.status !== "creating" || child.creationPid !== process.pid) {
        throw new Error("Tree node creation ownership changed; preserve the worktree for inspection.");
      }
      child.status = "planned";
      delete child.creationPid;
      child.contractHash = experiment.state.contractHash;
      await saveTree(current, "node_forked");
      return current;
    });
  } catch (error) {
    const message = `Node ${childId} creation stopped; preserve its worktree for inspection. ${error instanceof Error ? error.message : String(error)}`;
    await lock(reservation.root, async () => {
      const current = await loadTree(reservation.root);
      const child = current.state.nodes.find(node => node.id === childId);
      if (current.state.state !== "completed" && child?.status === "creating" && child.creationPid === process.pid) {
        await persistFailure(current, message, "node_fork_blocked");
      }
    });
    throw error;
  }
}

export async function promoteTreeNode(workspace: string, treeName: string, nodeId: string): Promise<ExperimentTree> {
  const tree = await readTree(workspace, treeName);
  const winner = await verifiedBest(tree, nodeId);
  return lock(tree.root, async () => {
    const current = await loadTree(tree.root);
    nodeRecord(current, nodeId);
    if (current.state.state === "completed") throw new Error("A closed experiment tree cannot change its promoted winner.");
    current.state.winnerNodeId = nodeId;
    current.state.message = `Promoted receipt ${winner.receipt.id} from node ${nodeId}; the user's checkout was not changed.`;
    await saveTree(current, "winner_promoted");
    return current;
  });
}

export { listTrees };
