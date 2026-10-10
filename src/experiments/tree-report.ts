import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile, rename } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { fileHash, safePath } from "./files.js";
import { verifyReceipt } from "./receipts.js";
import { reviewStatus, verifyReview, verifyReviewHistory } from "./reviews.js";
import type { Experiment } from "./store.js";
import type { ExperimentTree, TreeNode } from "./tree-schema.js";

type NodeEvidence = { node: TreeNode; workspace: string; experiment: Experiment };
export type RenderedTreeReport = { readonly reportContent: string; readonly provenanceContent: string };

function treeMarker(slug: string): string { return `<!-- hypatia-experiment-tree:${slug} -->`; }

function treeReportPaths(slug: string): string[] {
  return [`outputs/${slug}-tree.md`, `outputs/${slug}-tree.provenance.md`];
}

export async function assertTreeReportPathsAvailable(workspace: string, slug: string): Promise<void> {
  const marker = treeMarker(slug);
  for (const path of treeReportPaths(slug)) {
    const current = await readFile(await safePath(workspace, path), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (current !== undefined && !current.startsWith(marker)) {
      throw new Error(`An unrelated artifact already uses ${path}. Choose another experiment tree slug.`);
    }
  }
}

async function ownedWrite(workspace: string, path: string, content: string, marker: string): Promise<string> {
  const target = await safePath(workspace, path);
  const current = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current !== undefined && !current.startsWith(marker)) throw new Error(`An unrelated artifact already uses ${path}. Choose another experiment tree slug.`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    if (current === undefined) await link(temporary, target);
    else await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
  return relative(workspace, target);
}

export async function renderTreeReport(
  tree: ExperimentTree,
  nodes: NodeEvidence[],
  journalHash: string,
  signal?: AbortSignal,
): Promise<RenderedTreeReport> {
  const { definition, state } = tree;
  const workspace = definition.workspace;
  const definitionPath = `experiments/.trees/${definition.slug}/definition.json`;
  const eventsPath = `experiments/.trees/${definition.slug}/events.jsonl`;
  const marker = treeMarker(definition.slug);
  const treeReceipts: string[] = [];
  const treeReviews: string[] = [];
  const rows: string[] = [];
  for (const { node, experiment } of nodes) {
    signal?.throwIfAborted();
    await verifyReviewHistory(experiment);
    const receipts = await Promise.all(experiment.state.receipts.map(ref =>
      verifyReceipt(experiment.root, ref, experiment.state.contractHash, experiment.contract.environmentFingerprint?.sha256),
    ));
    const reviews = await Promise.all((experiment.state.reviews ?? []).map(ref => verifyReview(experiment, ref)));
    signal?.throwIfAborted();
    for (const ref of experiment.state.reviews ?? []) {
      treeReviews.push(`- experiments/.trees/${definition.slug}/nodes/${node.id}/experiments/${definition.slug}/reviews/${ref.id}.json — SHA256 ${ref.hash}; ${ref.kind} ${ref.verdict}; bundle ${ref.bundleHash}`);
    }
    const plan = await reviewStatus(experiment, "plan");
    const settled = !experiment.state.active && !experiment.state.activeReview && experiment.state.receipts.length > 0
      && !experiment.state.receipts.some(ref => ref.kind === "trial" && !ref.decision);
    const audit = settled ? await reviewStatus(experiment, "audit") : undefined;
    const best = experiment.state.receipts.find(ref => ref.id === experiment.state.bestId);
    const bestReceipt = best ? receipts.find(receipt => receipt.id === best.id) : undefined;
    const receiptLines = experiment.state.receipts.map((ref, index) => {
      const receiptPath = `experiments/.trees/${definition.slug}/nodes/${node.id}/experiments/${definition.slug}/receipts/${ref.id}.json`;
      treeReceipts.push(`- ${receiptPath} — SHA256 ${ref.hash}; receipt ${receipts[index]!.environmentFingerprint ?? "fingerprint unrecorded"}; snapshot ${receipts[index]!.snapshot.hash}`);
      return `| ${ref.kind} | ${ref.id} | ${ref.value ?? "unavailable"} | ${ref.valid ? "valid" : receipts[index]!.reason ?? "failed"} | ${ref.decision ?? (ref.kind === "baseline" ? "baseline" : "pending")} |`;
    });
    rows.push(
      `## Node ${node.id}`,
      "",
      `Parent: ${node.parentNodeId ?? "none"}. Parent receipt: ${node.parentReceiptId ?? "none"}.`,
      `Source snapshot SHA256: ${node.sourceSnapshotHash ?? "not sealed"}.`,
      `Node state: ${experiment.state.state}. Best receipt: ${best?.id ?? "none"} (${bestReceipt?.value ?? "unavailable"}).`,
      `Trials: ${experiment.state.trialAttempts}/${experiment.contract.maxIterations}; charged seconds: ${(experiment.state.spentMs / 1000).toFixed(1)}.`,
      `Current reviews: plan ${plan.current?.verdict ?? "pending"}; audit ${audit?.current?.verdict ?? (settled ? "pending" : "not current while node is unsettled")}.`,
      "",
      "| Kind | Receipt | Metric | Evidence | Decision |",
      "|---|---|---:|---|---|",
      ...receiptLines,
      "",
      ...reviews.map(review => `Review ${review.kind}: ${review.verdict} — ${review.summary}`),
      "",
    );
  }
  const reportContent = [
    marker,
    `# Experiment tree: ${definition.slug}`,
    "",
    `State: ${state.state}. Base commit: ${definition.baseCommit}.`,
    `Promoted winner: ${state.winnerNodeId ?? "none"}.`,
    `Shared budget: ${state.trialAttempts}/${definition.budget.maxTotalTrials} trial configurations; ${(state.spentMs / 1000).toFixed(1)}/${definition.budget.maxTotalWallSeconds}s; parallel limit ${definition.budget.maxParallelRuns}.`,
    "",
    ...rows,
    "Each child is an isolated worktree seeded from the named parent's verified best receipt. Promotion records the tree winner only; it does not merge or change the user's checkout.",
    "",
    "These are observed benchmark results under the saved protocol. Independent model reviews are advisory evidence, not a certificate of scientific validity, significance, or generalization.",
    "",
  ].join("\n");
  const provenanceContent = [
    marker,
    `# Provenance: experiment tree ${definition.slug}`,
    "",
    `Tree definition: ${definitionPath} — SHA256 ${await fileHash(await safePath(workspace, definitionPath))}`,
    `Tree event journal: ${eventsPath} — SHA256 ${journalHash}`,
    `Base commit: ${definition.baseCommit}`,
    `Shared budget: ${definition.budget.maxTotalTrials} trials; ${definition.budget.maxTotalWallSeconds}s; ${definition.budget.maxParallelRuns} concurrent runs.`,
    `Promoted winner: ${state.winnerNodeId ?? "none"}.`,
    "",
    "## Node contracts",
    ...nodes.map(({ node, experiment }) => `- ${node.id} (${node.worktree}) — experiments/${definition.slug}/contract.json; SHA256 ${experiment.state.contractHash}; source snapshot ${node.sourceSnapshotHash ?? "unsealed"}; parent ${node.parentNodeId ?? "none"}; parent receipt ${node.parentReceiptId ?? "none"}`),
    "",
    "## Receipts",
    ...treeReceipts,
    "",
    "## Review receipts",
    ...treeReviews,
    "",
    "Node review receipts are bound to the corresponding version-1 evidence bundle. The tree journal links every child to its parent receipt and source snapshot.",
    "",
  ].join("\n");
  return { reportContent, provenanceContent };
}

export async function writeTreeReport(
  tree: ExperimentTree,
  rendered: RenderedTreeReport,
): Promise<{ report: string; provenance: string }> {
  const { definition } = tree;
  const workspace = definition.workspace;
  const marker = treeMarker(definition.slug);
  await assertTreeReportPathsAvailable(workspace, definition.slug);
  const report = await ownedWrite(workspace, `outputs/${definition.slug}-tree.md`, rendered.reportContent, marker);
  const provenance = await ownedWrite(workspace, `outputs/${definition.slug}-tree.provenance.md`, rendered.provenanceContent, marker);
  return { report, provenance };
}

export async function exportTreeReport(
  tree: ExperimentTree,
  nodes: NodeEvidence[],
): Promise<{ report: string; provenance: string }> {
  const { workspace, slug } = tree.definition;
  const eventsPath = await safePath(workspace, `experiments/.trees/${slug}/events.jsonl`);
  const rendered = await renderTreeReport(tree, nodes, await fileHash(eventsPath));
  return writeTreeReport(tree, rendered);
}
