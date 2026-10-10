import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileHash } from "./files.js";
import { lock } from "./store.js";
import { loadTree, treeRoot } from "./tree-store.js";
import { readNodes } from "./tree-execution.js";
import { renderTreeReport, writeTreeReport, type RenderedTreeReport } from "./tree-report.js";

export type TreeExportPlan = {
  readonly root: string;
  readonly journalHash: string;
  readonly rendered: RenderedTreeReport;
};

class TreeChangedDuringExportError extends Error {
  readonly name = "TreeChangedDuringExportError";

  constructor() {
    super("The experiment tree changed while its report was being prepared.");
  }
}

export async function prepareTreeExport(
  workspace: string,
  treeName: string,
  signal?: AbortSignal,
  onProgress?: () => void,
): Promise<TreeExportPlan> {
  signal?.throwIfAborted();
  const root = await treeRoot(await realpath(workspace), treeName);
  const journalPath = join(root, "events.jsonl");
  const journalHash = await fileHash(journalPath);
  signal?.throwIfAborted();
  const tree = await loadTree(root);
  signal?.throwIfAborted();
  const nodes = await readNodes(tree);
  signal?.throwIfAborted();
  onProgress?.();
  signal?.throwIfAborted();
  if (await fileHash(journalPath) !== journalHash) throw new TreeChangedDuringExportError();
  const rendered = await renderTreeReport(tree, nodes, journalHash, signal);
  signal?.throwIfAborted();
  if (await fileHash(journalPath) !== journalHash) throw new TreeChangedDuringExportError();
  return { root, journalHash, rendered };
}

export async function publishTreeExport(plan: TreeExportPlan, signal?: AbortSignal): Promise<{ report: string; provenance: string }> {
  signal?.throwIfAborted();
  return lock(plan.root, async () => {
    signal?.throwIfAborted();
    const tree = await loadTree(plan.root);
    if (await fileHash(join(plan.root, "events.jsonl")) !== plan.journalHash) throw new TreeChangedDuringExportError();
    signal?.throwIfAborted();
    return writeTreeReport(tree, plan.rendered);
  });
}

export async function exportTree(workspace: string, treeName: string): Promise<{ report: string; provenance: string }> {
  return publishTreeExport(await prepareTreeExport(workspace, treeName));
}
