import type { Usage } from "@earendil-works/pi-ai";
import { ensureExperimentReview, performExperimentReview } from "./experiment-review.js";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approvalText, ideaBackendRoot, engine, EXPERIMENT_STATUS_KEY, formatTreeNodeCount, statusLabel, summarize, type ContractInput } from "./experiment-engine.js";
const actions = [
  "create", "status", "review", "run", "record_decision", "pause", "resume", "close", "export", "legacy",
  "tree_list", "tree_create", "tree_status", "tree_fork", "tree_approve", "tree_promote", "tree_review", "tree_run",
  "tree_decide", "tree_pause_node", "tree_resume_node", "tree_pause", "tree_resume", "tree_recover",
  "tree_close_node", "tree_close", "tree_export",
] as const;
const contractSchema = Type.Object({
  slug: Type.String(), hypothesis: Type.String(), argv: Type.Array(Type.String()), cwd: Type.Optional(Type.String()),
  filesInScope: Type.Array(Type.String()), inputFiles: Type.Optional(Type.Array(Type.String())), seeds: Type.Optional(Type.Array(Type.Integer())),
  metric: Type.Object({ source: Type.Union([Type.Literal("stdout"), Type.Literal("json-file")]), key: Type.String(), unit: Type.String(), direction: Type.Union([Type.Literal("min"), Type.Literal("max")]), file: Type.Optional(Type.String()) }),
  reviewPolicy: Type.Optional(Type.Union([Type.Literal("required"), Type.Literal("none")])),
  environment: Type.String(), maxIterations: Type.Optional(Type.Integer()), maxWallSeconds: Type.Optional(Type.Integer()), timeoutPerRun: Type.Optional(Type.Integer()),
});
const treeContractSchema = Type.Object({
  slug: Type.String(), hypothesis: Type.String(), argv: Type.Array(Type.String()), cwd: Type.Optional(Type.String()),
  filesInScope: Type.Array(Type.String()), inputFiles: Type.Optional(Type.Array(Type.String())), seeds: Type.Optional(Type.Array(Type.Integer())),
  metric: Type.Object({ source: Type.Union([Type.Literal("stdout"), Type.Literal("json-file")]), key: Type.String(), unit: Type.String(), direction: Type.Union([Type.Literal("min"), Type.Literal("max")]), file: Type.Optional(Type.String()) }),
  reviewPolicy: Type.Optional(Type.Union([Type.Literal("required"), Type.Literal("none")])),
  environment: Type.String(), timeoutPerRun: Type.Optional(Type.Integer()),
  maxTotalTrials: Type.Optional(Type.Integer()), maxTotalWallSeconds: Type.Optional(Type.Integer()), maxParallelRuns: Type.Optional(Type.Integer()),
});
export function registerExperimentWorkflow(pi: ExtensionAPI): void {
  const owned = new Map<string, { cwd: string; slug: string; id: string }>();
  pi.registerTool({
    name: "hypatia_experiment", label: "Experiment",
    description: "Persist and run bounded benchmark experiments, or create an experiment tree of lineage-linked Git worktrees. tree_create requires a clean Git repository root and saves one aggregate trial/time/parallelism budget; tree_fork seeds an isolated child from a closed parent's verified best snapshot; tree_promote records a reviewed winner without merging or changing the checkout. Version-1 create/run behavior remains available for dirty or non-Git workspaces. Every node keeps a version-1 contract, receipts, reviews and recovery journal. Run records observed metrics, scoped snapshots, frozen-input identity and log hashes; decisions keep an improvement or restore only scoped files. New contracts require critic review before benchmarks and auditor review before closure; callers cannot supply review verdicts. Metric stdout must contain one HYPATIA_METRIC JSON record per seed; JSON-file metrics are fresh files under HYPATIA_EXPERIMENT_RUN_DIR.",
    parameters: Type.Object({
      action: Type.Union(actions.map(action => Type.Literal(action))), slug: Type.Optional(Type.String()), contract: Type.Optional(contractSchema),
      treeContract: Type.Optional(treeContractSchema), parentNodeId: Type.Optional(Type.String()), nodeId: Type.Optional(Type.String()), hypothesis: Type.Optional(Type.String()),
      reviewKind: Type.Optional(Type.Union([Type.Literal("plan"), Type.Literal("audit")])),
      kind: Type.Optional(Type.Union([Type.Literal("baseline"), Type.Literal("trial")])), receiptId: Type.Optional(Type.String()),
      decision: Type.Optional(Type.Union([Type.Literal("keep"), Type.Literal("revert"), Type.Literal("failed")])), reason: Type.Optional(Type.String()),
      ideaFile: Type.Optional(Type.String()), autoresearchRoot: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      let usage: Usage | undefined;
      const addUsage = (next: Usage) => {
        if (!usage) { usage = structuredClone(next); return; }
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += next[key];
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += next.cost[key];
      };
      const textResult = (text: string, details: unknown, isError = false) => ({ ...(usage ? { usage } : {}), content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) });
      try {
        const runtime = await engine();
        if (signal?.aborted) throw new Error("Experiment operation cancelled before execution.");
        if (params.action === "legacy") { const result = await runtime.legacy(ctx.cwd); return textResult(result.message + "\n" + result.files.join("\n"), result); }
        if (params.action === "tree_list") {
          const trees = await runtime.listTrees(ctx.cwd);
          const summaries = trees.map(tree => ({
            slug: tree.definition.slug, state: tree.state.state, nodes: tree.state.nodes.length,
            trials: tree.state.trialAttempts, maxTotalTrials: tree.definition.budget.maxTotalTrials,
            spentMs: tree.state.spentMs, maxTotalWallSeconds: tree.definition.budget.maxTotalWallSeconds,
            winnerNodeId: tree.state.winnerNodeId,
          }));
          return textResult(summaries.length ? summaries.map(tree => `${tree.slug} · ${formatTreeNodeCount(tree.nodes)} · ${tree.trials}/${tree.maxTotalTrials} trials · ${tree.state}`).join("\n") : "No experiment trees found.", summaries);
        }
        if (params.action === "tree_create") {
          if (!params.treeContract) throw new Error("tree_create requires treeContract.");
          const created = await runtime.createTree(ctx.cwd, params.treeContract);
          let experiment = created.experiment;
          if (ctx.hasUI && await ctx.ui.confirm("Approve experiment tree root contract?", approvalText(experiment))) {
            experiment = await runtime.approveTreeNode(ctx.cwd, created.tree.definition.slug, "root");
          }
          return textResult(`Experiment tree ${created.tree.definition.slug}\n${summarize(experiment)}\nRoot worktree: ${created.tree.state.nodes[0]!.worktree}`, { slug: created.tree.definition.slug, nodeId: "root", state: created.tree.state.state, contractHash: experiment.state.contractHash });
        }
        if (params.action === "tree_status") {
          if (!params.slug) throw new Error("tree_status requires a tree slug.");
          const view = await runtime.treeStatus(ctx.cwd, params.slug);
          const nodes = view.nodes.map(item => {
            const best = item.experiment?.state.receipts.find(ref => ref.id === item.experiment?.state.bestId);
            return {
              id: item.node.id, state: item.experiment?.state.state ?? item.node.status,
              parentNodeId: item.node.parentNodeId, parentReceiptId: item.node.parentReceiptId,
              sourceSnapshotHash: item.node.sourceSnapshotHash, worktree: item.node.worktree,
              bestReceiptId: best?.id, bestValue: best?.value, message: item.message,
            };
          });
          const summary = {
            slug: view.tree.definition.slug, state: view.tree.state.state,
            trials: view.tree.state.trialAttempts, maxTotalTrials: view.tree.definition.budget.maxTotalTrials,
            spentMs: view.tree.state.spentMs, maxTotalWallSeconds: view.tree.definition.budget.maxTotalWallSeconds,
            maxParallelRuns: view.tree.definition.budget.maxParallelRuns, winnerNodeId: view.tree.state.winnerNodeId,
            nodes,
          };
          return textResult(`Tree ${summary.slug} · ${summary.state}\nBudget: ${summary.trials}/${summary.maxTotalTrials} trials · ${(summary.spentMs / 1000).toFixed(1)}/${summary.maxTotalWallSeconds}s · ${view.tree.state.activeRuns.length}/${summary.maxParallelRuns} active\nWinner: ${summary.winnerNodeId ?? "not promoted"}\n${nodes.map(item => `- ${item.id} · ${item.state} · parent ${item.parentNodeId ?? "none"} · receipt ${item.parentReceiptId ?? "none"} · snapshot ${item.sourceSnapshotHash ?? "pending"} · worktree ${item.worktree}`).join("\n")}`, summary);
        }
        if (params.action === "tree_approve") {
          if (!params.slug || !params.nodeId) throw new Error("tree_approve requires slug and nodeId.");
          const experiment = await runtime.treeNodeStatus(ctx.cwd, params.slug, params.nodeId);
          if (!ctx.hasUI) return textResult(`Node remains planned. Approve it through /experiments tree approve ${params.slug} ${params.nodeId}.`, { slug: params.slug, nodeId: params.nodeId, state: experiment.state.state });
          if (!await ctx.ui.confirm("Approve tree node contract?", approvalText(experiment))) {
            return textResult("Node contract remains planned and unapproved.", { slug: params.slug, nodeId: params.nodeId, state: experiment.state.state });
          }
          const approved = await runtime.approveTreeNode(ctx.cwd, params.slug, params.nodeId);
          return textResult(summarize(approved), { slug: params.slug, nodeId: params.nodeId, state: approved.state.state });
        }
        if (params.action === "tree_fork") {
          if (!params.slug || !params.parentNodeId || !params.nodeId || !params.hypothesis) throw new Error("tree_fork requires slug, parentNodeId, nodeId and hypothesis.");
          try {
            onUpdate?.(textResult(`Creating node ${params.nodeId} from ${params.parentNodeId}…`, { slug: params.slug, nodeId: params.nodeId }));
          } catch { /* Session can be replaced while a fork is starting. */ }
          const tree = await runtime.forkTreeNode(ctx.cwd, params.slug, params.parentNodeId, params.nodeId, params.hypothesis, signal);
          let experiment = await runtime.treeNodeStatus(ctx.cwd, params.slug, params.nodeId);
          if (ctx.hasUI && await ctx.ui.confirm("Approve child experiment contract?", approvalText(experiment))) {
            experiment = await runtime.approveTreeNode(ctx.cwd, params.slug, params.nodeId);
          }
          const node = tree.state.nodes.find(item => item.id === params.nodeId)!;
          return textResult(`Created tree node ${node.id} from ${node.parentNodeId}.\n${summarize(experiment)}\nWorktree: ${node.worktree}`, { slug: params.slug, nodeId: params.nodeId, parentNodeId: node.parentNodeId, sourceSnapshotHash: node.sourceSnapshotHash });
        }
        if (params.action === "tree_promote") {
          if (!params.slug || !params.nodeId) throw new Error("tree_promote requires slug and nodeId.");
          const tree = await runtime.promoteTreeNode(ctx.cwd, params.slug, params.nodeId);
          return textResult(`Promoted ${tree.state.winnerNodeId}; the user's checkout was not changed.`, { slug: params.slug, winnerNodeId: tree.state.winnerNodeId });
        }
        if (params.action === "create") {
          if (!params.contract) throw new Error("create requires a contract.");
          let experiment = await runtime.create(ctx.cwd, params.contract as ContractInput, { ideaFile: params.ideaFile, autoresearchRoot: await ideaBackendRoot(ctx.cwd, params.ideaFile, params.autoresearchRoot) });
          if (ctx.hasUI && await ctx.ui.confirm("Approve experiment contract?", approvalText(experiment))) experiment = await runtime.approve(ctx.cwd, experiment.contract.slug);
          return textResult(summarize(experiment), { slug: experiment.contract.slug, state: experiment.state.state, contractPath: `experiments/${experiment.contract.slug}/contract.json`, environmentFingerprint: experiment.contract.environmentFingerprint?.sha256 });
        }
        if (params.action === "status" && !params.slug) {
          const items = await runtime.list(ctx.cwd); return textResult(items.length ? items.map(summarize).join("\n\n") : "No experiments found.", items.map(item => ({ slug: item.contract.slug, state: item.state.state })));
        }
        if (!params.slug) throw new Error("This action requires slug.");
        const progress = (text: string) => { try { onUpdate?.(textResult(text, { slug: params.slug })); if (ctx.mode === "tui") ctx.ui.setStatus(EXPERIMENT_STATUS_KEY, text); } catch { /* Session can be replaced while a review ends. */ } };
        if (params.action === "tree_review") {
          if (!params.nodeId) throw new Error("tree_review requires nodeId.");
          const experiment = await runtime.treeNodeStatus(ctx.cwd, params.slug, params.nodeId);
          const workspace = await runtime.treeNodeWorkspace(ctx.cwd, params.slug, params.nodeId);
          const kind = params.reviewKind ?? (experiment.state.baselineId ? "audit" : "plan");
          const review = await performExperimentReview(ctx, experiment, kind, signal, progress, addUsage, workspace);
          return textResult(`${review.kind} review · ${review.verdict}\n${review.summary}\nReview: experiments/${params.slug}/reviews/${review.id}.json`, review, review.verdict !== "pass");
        }
        if (params.action === "tree_run") {
          if (!params.nodeId) throw new Error("tree_run requires nodeId.");
          const experiment = await runtime.treeNodeStatus(ctx.cwd, params.slug, params.nodeId);
          const workspace = await runtime.treeNodeWorkspace(ctx.cwd, params.slug, params.nodeId);
          await ensureExperimentReview(ctx, experiment, "plan", signal, progress, addUsage, workspace);
          const receipt = await runtime.runTreeNode(ctx.cwd, params.slug, params.nodeId, params.kind ?? "baseline", {
            signal,
            onStatus: current => {
              try {
                const text = statusLabel(current);
                if (ctx.mode === "tui") ctx.ui.setStatus(EXPERIMENT_STATUS_KEY, text);
                onUpdate?.(textResult(text, { slug: params.slug, nodeId: params.nodeId, state: current.state.state }));
              } catch { /* Session replacement does not interrupt durable receipt sealing. */ }
            },
          });
          return textResult(`${receipt.valid ? "Benchmark recorded" : "Benchmark failed/interrupted"} · ${receipt.value ?? "metric unavailable"}\n${receipt.reason ?? ""}\nNode: ${params.nodeId}\nReceipt: ${params.slug}/nodes/${params.nodeId}/experiments/${params.slug}/receipts/${receipt.id}.json`, receipt, !receipt.valid);
        }
        if (params.action === "tree_decide") {
          if (!params.nodeId || !params.receiptId || !params.decision || !params.reason) throw new Error("tree_decide requires nodeId, receiptId, decision and reason.");
          const experiment = await runtime.decideTreeNode(ctx.cwd, params.slug, params.nodeId, params.receiptId, params.decision, params.reason);
          return textResult(summarize(experiment), { slug: params.slug, nodeId: params.nodeId, receiptId: params.receiptId, decision: params.decision });
        }
        if (params.action === "tree_pause_node") {
          if (!params.nodeId) throw new Error("tree_pause_node requires nodeId.");
          const experiment = await runtime.pauseTreeNode(ctx.cwd, params.slug, params.nodeId);
          return textResult(summarize(experiment), { slug: params.slug, nodeId: params.nodeId, state: experiment.state.state });
        }
        if (params.action === "tree_resume_node") {
          if (!params.nodeId) throw new Error("tree_resume_node requires nodeId.");
          const experiment = await runtime.resumeTreeNode(ctx.cwd, params.slug, params.nodeId);
          return textResult(summarize(experiment), { slug: params.slug, nodeId: params.nodeId, state: experiment.state.state });
        }
        if (params.action === "tree_pause") return textResult(`Tree ${params.slug} · ${(await runtime.pauseTree(ctx.cwd, params.slug)).state.state}`, { slug: params.slug });
        if (params.action === "tree_resume") return textResult(`Tree ${params.slug} · ${(await runtime.resumeTree(ctx.cwd, params.slug)).state.state}`, { slug: params.slug });
        if (params.action === "tree_recover") return textResult(`Tree ${params.slug} · ${(await runtime.recoverTree(ctx.cwd, params.slug)).state.state}\nInspect any stopped child launch before acknowledging it.`, { slug: params.slug });
        if (params.action === "tree_close_node") {
          if (!params.nodeId) throw new Error("tree_close_node requires nodeId.");
          const experiment = await runtime.treeNodeStatus(ctx.cwd, params.slug, params.nodeId);
          const workspace = await runtime.treeNodeWorkspace(ctx.cwd, params.slug, params.nodeId);
          await ensureExperimentReview(ctx, experiment, "plan", signal, progress, addUsage, workspace);
          await ensureExperimentReview(ctx, await runtime.treeNodeStatus(ctx.cwd, params.slug, params.nodeId), "audit", signal, progress, addUsage, workspace);
          const result = await runtime.closeTreeNode(ctx.cwd, params.slug, params.nodeId);
          return textResult(`${summarize(result.experiment)}\nReport: ${result.report}\nProvenance: ${result.provenance}`, { slug: params.slug, nodeId: params.nodeId, report: result.report, provenance: result.provenance });
        }
        if (params.action === "tree_close") {
          const view = await runtime.treeStatus(ctx.cwd, params.slug);
          for (const item of view.nodes) {
            if (!item.experiment || item.experiment.state.state === "completed") continue;
            const workspace = await runtime.treeNodeWorkspace(ctx.cwd, params.slug, item.node.id);
            await ensureExperimentReview(ctx, item.experiment, "plan", signal, progress, addUsage, workspace);
            await ensureExperimentReview(ctx, await runtime.treeNodeStatus(ctx.cwd, params.slug, item.node.id), "audit", signal, progress, addUsage, workspace);
            await runtime.closeTreeNode(ctx.cwd, params.slug, item.node.id);
          }
          const result = await runtime.closeTree(ctx.cwd, params.slug);
          return textResult(`Experiment tree closed · ${result.tree.state.winnerNodeId ?? "no winner"}\nReport: ${result.report}\nProvenance: ${result.provenance}`, result);
        }
        if (params.action === "tree_export") {
          progress(`Preparing tree export · ${params.slug}`);
          const plan = await runtime.prepareTreeExport(
            ctx.cwd, params.slug, signal,
            () => progress(`Verifying tree export · ${params.slug}`),
          );
          progress(`Publishing tree export · ${params.slug}`);
          const result = await runtime.publishTreeExport(plan, signal);
          return textResult(`Tree report: ${result.report}\nTree provenance: ${result.provenance}`, result);
        }
        if (params.action === "review") {
          const experiment = await runtime.status(ctx.cwd, params.slug);
          const review = await performExperimentReview(ctx, experiment, params.reviewKind ?? (experiment.state.baselineId ? "audit" : "plan"), signal, progress, addUsage);
          return textResult(`${review.kind} review · ${review.verdict}\n${review.summary}\nReview: experiments/${params.slug}/reviews/${review.id}.json`, review, review.verdict !== "pass");
        }
        if (params.action === "run") {
          await ensureExperimentReview(ctx, await runtime.status(ctx.cwd, params.slug), "plan", signal, progress, addUsage);
          const result = await runtime.start(ctx.cwd, params.slug, params.kind ?? "baseline");
          if (result.cached) return textResult(`Cached baseline · ${result.cached.value} ${result.experiment.contract.metric.unit}\nReceipt: experiments/${params.slug}/receipts/${result.cached.id}.json`, result.cached);
          const id = result.runId!, key = `${ctx.cwd}:${params.slug}`;
          owned.set(key, { cwd: ctx.cwd, slug: params.slug, id });
          try {
            const receipt = await runtime.wait(ctx.cwd, params.slug, id, { signal, onStatus: experiment => {
              try {
                if (ctx.mode === "tui") ctx.ui.setStatus(EXPERIMENT_STATUS_KEY, statusLabel(experiment));
                onUpdate?.(textResult(statusLabel(experiment), { slug: params.slug, runId: id, state: experiment.state.state }));
              } catch { /* Session replacement does not interrupt durable receipt sealing. */ }
            } });
            const path = `experiments/${params.slug}/receipts/${id}.json`;
            return textResult(`${receipt.valid ? "Benchmark recorded" : "Benchmark failed/interrupted"} · ${receipt.value ?? "metric unavailable"}\n${receipt.reason ?? ""}\nReceipt: ${path}`, receipt, !receipt.valid);
          } finally { owned.delete(key); }
        }
        if (params.action === "record_decision") {
          if (!params.receiptId || !params.decision || !params.reason) throw new Error("record_decision requires receiptId, decision and reason.");
          return textResult(summarize(await runtime.decide(ctx.cwd, params.slug, params.receiptId, params.decision, params.reason)), { slug: params.slug });
        }
        if (params.action === "close") {
          const experiment = await runtime.status(ctx.cwd, params.slug);
          await ensureExperimentReview(ctx, experiment, "plan", signal, progress, addUsage);
          await ensureExperimentReview(ctx, await runtime.status(ctx.cwd, params.slug), "audit", signal, progress, addUsage);
          const result = await runtime.close(ctx.cwd, params.slug);
          return textResult(`${summarize(result.experiment)}\nReport: ${result.report}\nProvenance: ${result.provenance}`, { report: result.report, provenance: result.provenance, outcome: result.experiment.state.outcome });
        }
        if (params.action === "export") {
          const result = await runtime.exportReport(await runtime.status(ctx.cwd, params.slug));
          return textResult(`Report: ${result.report}\nProvenance: ${result.provenance}`, result);
        }
        const experiment = params.action === "pause" ? await runtime.pause(ctx.cwd, params.slug) : params.action === "resume" ? await runtime.resume(ctx.cwd, params.slug) : await runtime.status(ctx.cwd, params.slug);
        return textResult(summarize(experiment), { slug: params.slug, state: experiment.state.state, outcome: experiment.state.outcome });
      } catch (error) { return textResult(error instanceof Error ? error.message : String(error), undefined, true); }
    },
  });
  pi.on("session_shutdown", async () => {
    if (!owned.size) return;
    const runtime = await engine().catch(() => undefined);
    if (!runtime) return;
    for (const run of owned.values()) await runtime.pause(run.cwd, run.slug).catch(() => {});
    owned.clear();
  });
}
