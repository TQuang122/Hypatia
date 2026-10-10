import { realpath } from "node:fs/promises";
import { audit, verifyEnvironment } from "./lifecycle.js";
import { requireReviewGate, verifyReviewHistory } from "./reviews.js";
import { lock } from "./store.js";
import { loadTree, saveTree, treeRoot } from "./tree-store.js";
import { readNodes, updateTotals } from "./tree-execution.js";
import { assertTreeReportPathsAvailable, exportTreeReport } from "./tree-report.js";

export type TreeClosePlan = {
  readonly root: string;
  readonly nodeIds: readonly string[];
};

class TreeChangedDuringClosureError extends Error {
  readonly name = "TreeChangedDuringClosureError";

  constructor() {
    super("The experiment tree changed while closure was being prepared.");
  }
}

export async function prepareTreeClose(workspace: string, treeName: string): Promise<TreeClosePlan> {
  const tree = await loadTree(await treeRoot(await realpath(workspace), treeName));
  return { root: tree.root, nodeIds: tree.state.nodes.map(node => node.id) };
}

export async function finalizeTreeClose(plan: TreeClosePlan): Promise<{ tree: Awaited<ReturnType<typeof loadTree>>; report: string; provenance: string }> {
  return lock(plan.root, async () => {
    const tree = await loadTree(plan.root);
    if (tree.state.state === "completed") {
      const nodes = await readNodes(tree);
      await assertTreeReportPathsAvailable(tree.definition.workspace, tree.definition.slug);
      return { tree, ...await exportTreeReport(tree, nodes) };
    }
    if (tree.state.state === "blocked") throw new Error("Recover the blocked experiment tree before closing it.");
    const currentNodeIds = tree.state.nodes.map(node => node.id);
    if (plan.nodeIds.length !== currentNodeIds.length || plan.nodeIds.some((id, index) => id !== currentNodeIds[index])) {
      throw new TreeChangedDuringClosureError();
    }
    const nodes = await readNodes(tree);
    if (tree.state.activeRuns.length || nodes.some(node => node.experiment.state.state !== "completed" || node.experiment.state.active || node.experiment.state.activeReview)) {
      throw new Error("Close every settled node and resolve active reservations before closing the experiment tree.");
    }
    for (const node of nodes) {
      await audit(node.experiment);
      await verifyEnvironment(node.experiment);
      await verifyReviewHistory(node.experiment);
      await requireReviewGate(node.experiment, "plan");
      await requireReviewGate(node.experiment, "audit");
    }
    await assertTreeReportPathsAvailable(tree.definition.workspace, tree.definition.slug);
    updateTotals(tree, nodes);
    tree.state.state = "completed";
    await saveTree(tree, "tree_closed");
    const artifacts = await exportTreeReport(tree, nodes);
    return { tree, ...artifacts };
  });
}

export async function closeTree(workspace: string, treeName: string): Promise<{ tree: Awaited<ReturnType<typeof loadTree>>; report: string; provenance: string }> {
  return finalizeTreeClose(await prepareTreeClose(workspace, treeName));
}
