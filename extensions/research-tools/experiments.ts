import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { BorderedLoader, copyToClipboard, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionCommandSpec } from "../../metadata/commands.mjs";
import { generationCommand, browseGeneratedIdeas, generationFooter, pauseOwnedGenerations } from "./idea-forge.js";
import { experimentChat } from "./experiment-chat.js";
import { runOutputsCommand } from "./outputs.js";
import { approvalText, ideaBackendRoot, engine, EXPERIMENT_STATUS_KEY, formatTreeNodeCount, statusLabel, summarize, type ContractInput, type Experiment, type ExperimentTreeView } from "./experiment-engine.js";
async function readContract(ctx: ExtensionCommandContext, path: string): Promise<ContractInput> {
  const full = resolve(ctx.cwd, path), info = await lstat(full);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("Contract JSON must be a regular file under 1 MiB.");
  return JSON.parse(await readFile(full, "utf8")) as ContractInput;
}
export async function createExperiment(ctx: ExtensionCommandContext, ideaFile?: string, fromJson = false, defaults?: { hypothesis: string }, contractPath?: string): Promise<void> {
  if (!fromJson) { await experimentChat(ctx, ideaFile ? "import" : "create", defaults?.hypothesis ?? "", ideaFile); return; }
  if (!contractPath?.trim()) { ctx.ui.setEditorText(ideaFile ? `/experiments import-json ${JSON.stringify(ideaFile)} --contract ` : "/experiments create-json "); ctx.ui.notify("Add the saved contract path in the composer and press Enter.", "info"); return; }
  const path = contractPath.trim().replace(/^(["'])(.*)\1$/, "$2");
  const contract = await readContract(ctx, path), runtime = await engine();
  const root = await ideaBackendRoot(ctx.cwd, ideaFile);
  let experiment = await runtime.create(ctx.cwd, contract, { ideaFile, autoresearchRoot: root });
  if (await ctx.ui.confirm("Approve experiment contract?", approvalText(experiment))) experiment = await runtime.approve(ctx.cwd, contract.slug);
  ctx.ui.notify(summarize(experiment), "info");
}
async function createExperimentTree(ctx: ExtensionCommandContext, defaults?: { hypothesis: string }): Promise<void> {
  await experimentChat(ctx, "tree", defaults?.hypothesis ?? "");
}
function treeSummary(view: ExperimentTreeView): string {
  const { tree } = view;
  return [
    `Experiment tree · ${tree.definition.slug} · ${tree.state.state}`,
    `Base commit: ${tree.definition.baseCommit}`,
    `Budget: ${tree.state.trialAttempts}/${tree.definition.budget.maxTotalTrials} trials · ${(tree.state.spentMs / 1000).toFixed(1)}/${tree.definition.budget.maxTotalWallSeconds}s · ${tree.state.activeRuns.length}/${tree.definition.budget.maxParallelRuns} active`,
    `Winner: ${tree.state.winnerNodeId ?? "not promoted"}`,
    ...(tree.state.message ? [`Message: ${tree.state.message}`] : []),
    ...view.nodes.map(({ node, experiment, message }) => {
      const best = experiment?.state.receipts.find(receipt => receipt.id === experiment.state.bestId);
      return `- ${node.id} · ${node.parentNodeId ? `child of ${node.parentNodeId}` : "root"} · ${experiment?.state.state ?? message ?? node.status} · best ${best?.value ?? "unavailable"} · ${node.worktree}`;
    }),
  ].join("\n");
}
function treeManagementOperations(view: ExperimentTreeView): string[] {
  const { tree, nodes } = view;
  const hasNodes = tree.state.nodes.length > 0;
  const incomplete = tree.state.nodes.some(node => node.status !== "planned");
  const planned = nodes.some(item => item.node.status === "planned" && item.experiment?.state.state === "planned");
  const closed = nodes.some(item => item.experiment?.state.state === "completed");
  const settled = nodes.some(item => item.experiment && item.experiment.state.state !== "completed"
    && !item.experiment.state.active && !item.experiment.state.activeReview && item.experiment.state.receipts.length
    && !item.experiment.state.receipts.some(receipt => receipt.kind === "trial" && !receipt.decision));
  const continuable = nodes.some(item => item.node.status === "planned" && item.experiment
    && item.experiment.state.state !== "completed" && !item.experiment.state.active && !item.experiment.state.activeReview);
  const closable = hasNodes && tree.state.activeRuns.length === 0 && nodes.length === tree.state.nodes.length
    && nodes.every(item => item.experiment?.state.state === "completed" && !item.experiment.state.active && !item.experiment.state.activeReview);
  const operations = ["View tree status"];
  if (planned) operations.push("Approve a planned node");
  if (closed && !["completed", "blocked", "pause_requested", "paused"].includes(tree.state.state)) {
    operations.push("Fork a child from a closed node");
  }
  if (closed && tree.state.state !== "completed") operations.push("Promote a verified winner");
  if (hasNodes && !incomplete && !["completed", "paused", "pause_requested"].includes(tree.state.state)) operations.push("Pause tree");
  if (hasNodes && !incomplete && ["blocked", "pause_requested", "paused"].includes(tree.state.state)) operations.push("Resume tree");
  if (tree.state.state !== "completed" && (incomplete || tree.state.activeRuns.length || ["blocked", "pause_requested"].includes(tree.state.state))) {
    operations.push("Recover tree");
  }
  if (settled) operations.push("Close a settled node in chat");
  if (closable && tree.state.state !== "completed") operations.push("Close tree in chat");
  operations.push("Export tree report");
  if (continuable) operations.push("Continue a node in chat");
  operations.push("Back");
  return operations;
}
export async function confirmTreeAction(
  ctx: Pick<ExtensionCommandContext, "ui">,
  title: string,
  message: string,
  actionLabel: string,
): Promise<boolean> {
  ctx.ui.notify(message, "info");
  return await ctx.ui.select(title, ["Back", actionLabel]) === actionLabel;
}
function notifyTreeOperationError(ctx: ExtensionCommandContext, treeName: string | undefined, operation: string, error: unknown): void {
  const target = treeName ? `Tree ${treeName}` : "Tree command";
  const detail = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`${target} · ${operation} failed: ${detail}`, "error");
}
async function runTreeAction<T>(
  ctx: ExtensionCommandContext,
  treeName: string,
  operation: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try { return await run(); }
  catch (error) {
    notifyTreeOperationError(ctx, treeName, operation, error);
    return undefined;
  }
}
type TreeLoaderOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "cancelled" }
  | { kind: "failed"; error: unknown };
async function runTreeOperationWithLoader<T>(
  ctx: ExtensionCommandContext,
  message: string,
  operation: (signal: AbortSignal) => Promise<T>,
  cancellable = true,
): Promise<TreeLoaderOutcome<T>> {
  return ctx.ui.custom<TreeLoaderOutcome<T>>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, message, { cancellable });
    let finished = false;
    const finish = (result: TreeLoaderOutcome<T>) => {
      if (finished) return;
      finished = true;
      done(result);
    };
    if (cancellable) loader.onAbort = () => ctx.ui.notify(`Cancelling: ${message}`, "info");
    void Promise.resolve().then(() => operation(loader.signal)).then(
      value => finish({ kind: "completed", value }),
      error => finish(loader.signal.aborted ? { kind: "cancelled" } : { kind: "failed", error }),
    );
    return loader;
  });
}
async function runTreeActionWithLoader<T>(
  ctx: ExtensionCommandContext,
  treeName: string,
  operation: string,
  message: string,
  run: (signal: AbortSignal) => Promise<T>,
  options: { cancellable?: boolean; cancelledMessage?: string } = {},
): Promise<T | undefined> {
  if (!options.cancellable) {
    ctx.ui.notify(`Tree ${treeName} · ${operation} updates multiple node states and cannot be safely interrupted.`, "info");
  }
  const outcome = await runTreeOperationWithLoader(ctx, message, run, options.cancellable ?? false);
  if (outcome.kind === "completed") return outcome.value;
  if (outcome.kind === "cancelled") {
    ctx.ui.notify(options.cancelledMessage ?? `Tree ${treeName} · ${operation} was cancelled. Persisted state was preserved for recovery.`, "warning");
  } else notifyTreeOperationError(ctx, treeName, operation, outcome.error);
  return undefined;
}
async function exportTreeWithLoader(
  ctx: ExtensionCommandContext,
  runtime: Awaited<ReturnType<typeof engine>>,
  treeName: string,
): Promise<void> {
  const plan = await runTreeActionWithLoader(
    ctx, treeName, "export", `Preparing report for tree ${treeName}…`,
    signal => runtime.prepareTreeExport(ctx.cwd, treeName, signal),
    { cancellable: true, cancelledMessage: `Tree ${treeName} export cancelled before publication; no artifacts were changed.` },
  );
  if (!plan) return;
  ctx.ui.setStatus("hypatia-experiment-tree-operation", `Publishing tree report ${treeName}…`);
  try {
    const result = await runtime.publishTreeExport(plan);
    ctx.ui.notify(`Report: ${result.report}\nProvenance: ${result.provenance}`, "info");
  } catch (error) {
    notifyTreeOperationError(ctx, treeName, "export", error);
  } finally {
    ctx.ui.setStatus("hypatia-experiment-tree-operation", undefined);
  }
}
async function manageExperimentTrees(ctx: ExtensionCommandContext): Promise<void> {
  const runtime = await engine();
  while (true) {
    const trees = await runtime.listTrees(ctx.cwd);
    const labels = trees.map(tree => `${tree.definition.slug} · ${formatTreeNodeCount(tree.state.nodes.length)} · ${tree.state.trialAttempts}/${tree.definition.budget.maxTotalTrials} trials`);
    const choice = await ctx.ui.select("Experiment trees", [...labels, "Create experiment tree", "Back"]);
    if (!choice || choice === "Back") return;
    if (choice === "Create experiment tree") { await createExperimentTree(ctx); return; }
    const tree = trees[labels.indexOf(choice)];
    if (!tree) continue;
    const view = await runTreeAction(ctx, tree.definition.slug, "status", () => runtime.treeStatus(ctx.cwd, tree.definition.slug));
    if (!view) continue;
    const operation = await ctx.ui.select(`Tree ${tree.definition.slug}`, treeManagementOperations(view));
    if (!operation || operation === "Back") continue;
    if (operation === "View tree status") { ctx.ui.notify(treeSummary(view), "info"); continue; }
    if (operation === "Approve a planned node") {
      const planned = view.nodes.filter(item => item.experiment?.state.state === "planned");
      if (!planned.length) { ctx.ui.notify("No planned tree node needs approval.", "warning"); continue; }
      const plannedLabels = planned.map(item => `${item.node.id} · ${item.experiment!.contract.hypothesis}`);
      const selected = await ctx.ui.select("Approve node contract", plannedLabels);
      const node = planned[plannedLabels.indexOf(selected ?? "")];
      if (node && await confirmTreeAction(ctx, `Approve tree node ${node.node.id}?`, approvalText(node.experiment!), "Approve")) {
        await runTreeAction(ctx, tree.definition.slug, "approval", () => runtime.approveTreeNode(ctx.cwd, tree.definition.slug, node.node.id));
      }
      continue;
    }
    if (operation === "Fork a child from a closed node") {
      const parents = view.nodes.filter(item => item.experiment?.state.state === "completed");
      if (!parents.length) { ctx.ui.notify("Close a settled node before forking a child.", "warning"); continue; }
      const parentLabels = parents.map(item => `${item.node.id} · ${item.experiment!.contract.hypothesis}`);
      const parentChoice = await ctx.ui.select("Parent node", parentLabels);
      const parent = parents[parentLabels.indexOf(parentChoice ?? "")];
      if (!parent) continue;
      ctx.ui.setEditorText(`/experiments tree fork ${tree.definition.slug} ${parent.node.id} `);
      ctx.ui.notify("Add a child ID and hypothesis in the composer.", "info"); return;
    }
    if (operation === "Promote a verified winner") {
      const candidates = view.nodes.filter(item => item.experiment?.state.state === "completed");
      if (!candidates.length) { ctx.ui.notify("No closed node is eligible for promotion.", "warning"); continue; }
      const candidateLabels = candidates.map(item => `${item.node.id} · ${item.experiment!.contract.hypothesis}`);
      const selected = await ctx.ui.select("Promote winner", candidateLabels);
      const winner = candidates[candidateLabels.indexOf(selected ?? "")];
      if (!winner || !await confirmTreeAction(ctx, `Promote node ${winner.node.id}?`, `Record ${winner.node.id} as the tree winner. This does not change the Git checkout.`, "Promote")) continue;
      const updated = await runTreeAction(ctx, tree.definition.slug, "promotion", () => runtime.promoteTreeNode(ctx.cwd, tree.definition.slug, winner.node.id));
      if (!updated) continue;
      ctx.ui.notify(`Promoted ${updated.state.winnerNodeId}; the user's checkout was not changed.`, "info");
      continue;
    }
    if (operation === "Pause tree") {
      const updated = await runTreeActionWithLoader(ctx, tree.definition.slug, "pause", `Pausing tree ${tree.definition.slug}…`, () => runtime.pauseTree(ctx.cwd, tree.definition.slug));
      if (updated) ctx.ui.notify(`Tree ${tree.definition.slug} · ${updated.state.state}`, "info");
      continue;
    }
    if (operation === "Resume tree") {
      const updated = await runTreeActionWithLoader(ctx, tree.definition.slug, "resume", `Resuming tree ${tree.definition.slug}…`, () => runtime.resumeTree(ctx.cwd, tree.definition.slug));
      if (updated) ctx.ui.notify(`Tree ${tree.definition.slug} · ${updated.state.state}`, "info");
      continue;
    }
    if (operation === "Recover tree") {
      const updated = await runTreeActionWithLoader(ctx, tree.definition.slug, "recovery", `Recovering tree ${tree.definition.slug}…`, () => runtime.recoverTree(ctx.cwd, tree.definition.slug));
      if (updated) ctx.ui.notify(`Tree ${tree.definition.slug} · ${updated.state.state}\nInspect any stopped child launch before acknowledging it.`, "info");
      continue;
    }
    if (operation === "Close a settled node in chat") {
      const settled = view.nodes.filter(item => item.experiment && item.experiment.state.state !== "completed"
        && !item.experiment.state.active && !item.experiment.state.activeReview && item.experiment.state.receipts.length
        && !item.experiment.state.receipts.some(receipt => receipt.kind === "trial" && !receipt.decision));
      const nodeLabels = settled.map(item => `${item.node.id} · ${item.experiment!.state.receipts.length} receipt(s)`);
      const selected = await ctx.ui.select("Close tree node", nodeLabels);
      const node = settled[nodeLabels.indexOf(selected ?? "")];
      if (node) { ctx.ui.setEditorText(`/autoresearch tree ${tree.definition.slug} close-node ${node.node.id}`); return; }
      continue;
    }
    if (operation === "Close tree in chat") { ctx.ui.setEditorText(`/autoresearch tree ${tree.definition.slug} close`); return; }
    if (operation === "Export tree report") {
      await exportTreeWithLoader(ctx, runtime, tree.definition.slug);
      continue;
    }
    if (operation === "Continue a node in chat") {
      const candidates = view.nodes.filter(item => item.node.status === "planned");
      const nodeLabels = candidates.map(item => `${item.node.id} · ${item.experiment?.state.state ?? "unavailable"}`);
      const selected = await ctx.ui.select("Continue tree node", nodeLabels);
      const node = candidates[nodeLabels.indexOf(selected ?? "")];
      if (node) { ctx.ui.setEditorText(`/autoresearch tree ${tree.definition.slug} ${node.node.id}`); return; }
    }
  }
}
async function runTreeSubcommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const runtime = await engine(), [action, treeName, parentNodeId, nodeId, ...hypothesisParts] = args.trim().split(/\s+/);
  if (action === "create") { await createExperimentTree(ctx); return; }
  if (action === "list") {
    const trees = await runtime.listTrees(ctx.cwd);
    ctx.ui.notify(trees.length ? trees.map(tree => `${tree.definition.slug} · ${formatTreeNodeCount(tree.state.nodes.length)} · ${tree.state.trialAttempts}/${tree.definition.budget.maxTotalTrials} trials · ${tree.state.state}`).join("\n") : "No experiment trees found. Use /experiments tree create to start one.", "info");
    return;
  }
  if (action === "status") {
    if (!treeName) throw new Error("Use /experiments tree status <tree-slug>.");
    ctx.ui.notify(treeSummary(await runtime.treeStatus(ctx.cwd, treeName)), "info");
    return;
  }
  if (action === "approve") {
    if (!treeName || !parentNodeId) throw new Error("Use /experiments tree approve <tree-slug> <node-id>.");
    const experiment = await runtime.treeNodeStatus(ctx.cwd, treeName, parentNodeId);
    if (await confirmTreeAction(ctx, `Approve tree node ${parentNodeId}?`, approvalText(experiment), "Approve")) {
      ctx.ui.notify(summarize(await runtime.approveTreeNode(ctx.cwd, treeName, parentNodeId)), "info");
    }
    return;
  }
  if (action === "close-node") {
    if (!treeName || !parentNodeId) throw new Error("Use /experiments tree close-node <tree-slug> <node-id>.");
    ctx.ui.setEditorText(`/autoresearch tree ${treeName} close-node ${parentNodeId}`);
    return;
  }
  if (action === "pause" || action === "resume" || action === "recover" || action === "close" || action === "export") {
    if (!treeName) throw new Error(`Use /experiments tree ${action} <tree-slug>.`);
    if (action === "pause") {
      const updated = await runTreeActionWithLoader(ctx, treeName, "pause", `Pausing tree ${treeName}…`, () => runtime.pauseTree(ctx.cwd, treeName));
      if (updated) ctx.ui.notify(`Tree ${treeName} · ${updated.state.state}`, "info");
    }
    else if (action === "resume") {
      const updated = await runTreeActionWithLoader(ctx, treeName, "resume", `Resuming tree ${treeName}…`, () => runtime.resumeTree(ctx.cwd, treeName));
      if (updated) ctx.ui.notify(`Tree ${treeName} · ${updated.state.state}`, "info");
    }
    else if (action === "recover") {
      const updated = await runTreeActionWithLoader(ctx, treeName, "recovery", `Recovering tree ${treeName}…`, () => runtime.recoverTree(ctx.cwd, treeName));
      if (updated) ctx.ui.notify(`Tree ${treeName} · ${updated.state.state}\nInspect any stopped child launch before acknowledging it.`, "info");
    }
    else if (action === "close") ctx.ui.setEditorText(`/autoresearch tree ${treeName} close`);
    else await exportTreeWithLoader(ctx, runtime, treeName);
    return;
  }
  if (action === "acknowledge") {
    if (!treeName || !parentNodeId) throw new Error("Use /experiments tree acknowledge <tree-slug> <node-id> after inspecting and stopping its benchmark processes.");
    if (await confirmTreeAction(ctx, "Acknowledge stopped tree launch?", "Confirm that no benchmark from this interrupted launch remains. This records failed evidence and does not run a benchmark.", "Acknowledge")) {
      ctx.ui.notify(summarize(await runtime.acknowledgeTreeStoppedLaunch(ctx.cwd, treeName, parentNodeId)), "info");
    }
    return;
  }
  if (action === "fork") {
    if (!treeName || !parentNodeId || !nodeId) throw new Error("Use /experiments tree fork <tree-slug> <parent-node> <child-node> [hypothesis].");
    const hypothesis = hypothesisParts.join(" ").trim();
    if (!hypothesis) { ctx.ui.setEditorText(`/experiments tree fork ${treeName} ${parentNodeId} ${nodeId} `); ctx.ui.notify("Add the child hypothesis in chat.", "info"); return; }
    if (!hypothesis?.trim()) return;
    const updated = await runTreeActionWithLoader(
      ctx, treeName, "fork",
      `Creating node ${nodeId} from ${parentNodeId}…`,
      signal => runtime.forkTreeNode(ctx.cwd, treeName, parentNodeId, nodeId, hypothesis.trim(), signal),
      { cancellable: true, cancelledMessage: `Tree ${treeName} fork cancelled. Any reserved node or worktree was preserved for recovery.` },
    );
    if (!updated) return;
    const experiment = await runtime.treeNodeStatus(ctx.cwd, treeName, nodeId);
    if (await confirmTreeAction(ctx, `Approve child node ${nodeId}?`, approvalText(experiment), "Approve")) await runtime.approveTreeNode(ctx.cwd, treeName, nodeId);
    ctx.ui.notify(`Created tree node ${nodeId} from ${parentNodeId}.\nWorktree: ${updated.state.nodes.find(item => item.id === nodeId)!.worktree}`, "info");
    return;
  }
  if (action === "promote") {
    if (!treeName || !parentNodeId) throw new Error("Use /experiments tree promote <tree-slug> <node-id>.");
    const view = await runtime.treeStatus(ctx.cwd, treeName);
    const winner = view.nodes.find(item => item.node.id === parentNodeId);
    if (!winner || !await confirmTreeAction(ctx, `Promote node ${parentNodeId}?`, `Record ${parentNodeId} as the tree winner. This does not change the Git checkout.`, "Promote")) return;
    ctx.ui.notify(`Promoted ${(await runtime.promoteTreeNode(ctx.cwd, treeName, parentNodeId)).state.winnerNodeId}.`, "info");
    return;
  }
  throw new Error("Use /experiments tree [create|list|status|approve <tree> <node>|pause|resume|recover|close-node <tree> <node>|close|export <slug>|fork <tree> <parent> <child> <hypothesis>|promote <tree> <node>|acknowledge <tree> <node>].");
}
export async function runExperimentsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") { if (ctx.hasUI) ctx.ui.notify("/experiments requires the interactive TUI. Use hypatia_experiment for scripted status.", "warning"); return; }
  const runtime = await engine();
  const [action, name] = args.trim().split(/\s+/);
  if (action === "tree") {
    const treeArgs = args.trim().slice("tree".length).trim();
    const [treeAction, treeName] = treeArgs.split(/\s+/);
    try { await runTreeSubcommand(treeArgs, ctx); }
    catch (error) { notifyTreeOperationError(ctx, treeName, treeAction ?? "operation", error); }
    return;
  }
  if (action && await generationCommand(action, name, ctx, args.trim().slice(action.length).trim())) return;
  if (action === "import") {
    const path = args.trim().slice("import".length).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (!path) { ctx.ui.setEditorText("/experiments import "); ctx.ui.notify("Add the idea file path in the composer.", "info"); return; }
    if (path) await createExperiment(ctx, path); return;
  }
  if (action === "create" || action === "create-json") { if (action === "create-json") await createExperiment(ctx, undefined, true, undefined, args.trim().slice(action.length).trim()); else await experimentChat(ctx, "create", args.trim().slice(action.length).trim()); return; }
  if (action === "import-json") { const tail = args.trim().slice(action.length).trim(), separator = tail.lastIndexOf(" --contract "); const path = (separator < 0 ? tail : tail.slice(0, separator)).trim().replace(/^(["'])(.*)\1$/, "$2"); if (!path) throw new Error("Provide an idea file path."); await createExperiment(ctx, path, true, undefined, separator < 0 ? undefined : tail.slice(separator + 12)); return; }
  if (action === "review") { if (!name) throw new Error("Provide an experiment slug."); await runtime.status(ctx.cwd, name); ctx.ui.setEditorText(`/autoresearch review ${name}`); return; }
  if (action && ["status", "pause", "resume", "approve", "export", "close", "recover"].includes(action)) {
    if (!name) throw new Error("Provide an experiment slug.");
    const current = await runtime.status(ctx.cwd, name);
    if (action === "recover") {
      if (await ctx.ui.confirm("Acknowledge stopped benchmark launch?", "The worker exited before sealing its child process identity. Inspect and stop processes from this run first. Confirm that no benchmark from the interrupted launch remains; this records failed evidence and does not run a benchmark.")) ctx.ui.notify(summarize(await runtime.acknowledgeStoppedLaunch(ctx.cwd, name)), "info");
    }
    else if (action === "approve") { if (await ctx.ui.confirm("Approve experiment contract?", approvalText(current))) ctx.ui.notify(summarize(await runtime.approve(ctx.cwd, name)), "info"); }
    else if (action === "export") { const report = await runtime.exportReport(current); ctx.ui.notify(`Report: ${report.report}\nProvenance: ${report.provenance}`, "info"); }
    else if (action === "close") {
      if (current.contract.reviewPolicy === "required" && current.state.state !== "completed") { ctx.ui.setEditorText(`/autoresearch close ${name}`); ctx.ui.notify("Press Enter to audit the current result evidence and close the experiment in chat.", "info"); return; }
      const result = await runtime.close(ctx.cwd, name); ctx.ui.notify(`Experiment closed: ${result.experiment.state.outcome}\n${result.report}`, "info"); }
    else ctx.ui.notify(summarize(action === "pause" ? await runtime.pause(ctx.cwd, name) : action === "resume" ? await runtime.resume(ctx.cwd, name) : current), "info");
    return;
  }
  if (action) throw new Error("Use /experiments [generate|ideas|forge-status|forge-pause|forge-resume|forge-recover <slug>|status|pause|resume|approve|export|close|recover|review <slug>|create|create-json|import|import-json <idea-file>].");
  while (true) {
    const items = await runtime.list(ctx.cwd);
    const labels = items.map(item => statusLabel(item));
    const choice = await ctx.ui.select("Experiments", [...labels, "/idea <research goal>", "Browse generated ideas", "Create experiment in chat", "Create experiment tree", "Manage experiment trees", "Create from contract JSON", "Import an idea", "Inspect legacy logs"]);
    if (!choice) return;
    if (choice === "/idea <research goal>") { ctx.ui.setEditorText("/idea "); ctx.ui.notify("Describe the research idea and press Enter.", "info"); return; }
    if (choice === "Browse generated ideas") { if (await browseGeneratedIdeas(ctx)) return; continue; }
    if (choice === "Create experiment in chat") { await createExperiment(ctx); return; }
    if (choice === "Create experiment tree") { await createExperimentTree(ctx); return; }
    if (choice === "Manage experiment trees") {
      try { await manageExperimentTrees(ctx); }
      catch (error) { notifyTreeOperationError(ctx, undefined, "list", error); }
      continue;
    }
    if (choice === "Create from contract JSON") { await createExperiment(ctx, undefined, true); return; }
    if (choice === "Import an idea") { ctx.ui.setEditorText("/experiments import "); ctx.ui.notify("Add your idea file path in the composer.", "info"); return; }
    if (choice === "Inspect legacy logs") { const result = await runtime.legacy(ctx.cwd); ctx.ui.notify(result.message + "\n" + result.files.join("\n"), "info"); continue; }
    const selected = items[labels.indexOf(choice)];
    if (!selected) continue;
    const options = ["View status", ...(selected.state.state !== "completed" ? ["Review in chat"] : []), ...(selected.state.active?.childLaunchPending ? ["Acknowledge stopped launch"] : []), ...(selected.state.state === "planned" ? ["Approve contract"] : []), ...(selected.state.active || selected.state.activeReview ? ["Request pause"] : []), ...(["paused", "blocked"].includes(selected.state.state) ? ["Resume"] : []), ...(selected.state.state !== "completed" ? ["Continue in chat"] : []), "Export summary", "Open reports and logs", "Copy experiment path", ...(!selected.state.active && !selected.state.activeReview && selected.state.receipts.length && selected.state.state !== "completed" ? ["Close experiment"] : []), "Back"];
    const operation = await ctx.ui.select(selected.contract.slug, options);
    if (operation === "Acknowledge stopped launch") {
      if (await ctx.ui.confirm("Acknowledge stopped benchmark launch?", "Confirm only after inspecting/stopping all processes from this interrupted launch. No benchmark is started by this action.")) await runtime.acknowledgeStoppedLaunch(ctx.cwd, selected.contract.slug);
    }
    else if (operation === "Review in chat") { ctx.ui.setEditorText(`/autoresearch review ${selected.contract.slug}`); return; }
    else if (operation === "View status") ctx.ui.notify(summarize(await runtime.status(ctx.cwd, selected.contract.slug)), "info");
    else if (operation === "Approve contract") { if (await ctx.ui.confirm("Approve experiment contract?", approvalText(selected))) await runtime.approve(ctx.cwd, selected.contract.slug); }
    else if (operation === "Request pause") await runtime.pause(ctx.cwd, selected.contract.slug);
    else if (operation === "Resume") await runtime.resume(ctx.cwd, selected.contract.slug);
    else if (operation === "Continue in chat") { ctx.ui.setEditorText(`/autoresearch resume ${selected.contract.slug}`); return; }
    else if (operation === "Export summary") { const result = await runtime.exportReport(await runtime.status(ctx.cwd, selected.contract.slug)); ctx.ui.notify(`Report: ${result.report}\nProvenance: ${result.provenance}`, "info"); }
    else if (operation === "Open reports and logs") { await runOutputsCommand(ctx); return; }
    else if (operation === "Copy experiment path") { await copyToClipboard(selected.root); ctx.ui.notify("Experiment path copied", "info"); }
    else if (operation === "Close experiment") {
      if (selected.contract.reviewPolicy === "required") { ctx.ui.setEditorText(`/autoresearch close ${selected.contract.slug}`); return; }
      await runtime.close(ctx.cwd, selected.contract.slug);
    }
  }
}
export function registerExperiments(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined, timer: ReturnType<typeof setInterval> | undefined, refreshing = false, lastError = "";
  const refresh = async (): Promise<void> => {
    if (!context || context.mode !== "tui" || !context.hasUI || refreshing) return;
    refreshing = true;
    const current = context;
    try {
      const items = await (await engine()).list(current.cwd);
      if (context !== current) return;
      const selected = items.find(item => item.state.state !== "completed");
      current.ui.setStatus(EXPERIMENT_STATUS_KEY, await generationFooter(current.cwd) ?? (selected ? statusLabel(selected) : undefined));
      lastError = "";
    } catch (error) {
      if (context !== current) return;
      const text = error instanceof Error ? error.message : String(error);
      if (text !== lastError) current.ui.notify(text, "warning");
      lastError = text;
    } finally { refreshing = false; }
  };
  pi.registerCommand("experiments", {
    description: getExtensionCommandSpec("experiments")?.description ?? "Browse and manage experiment ideas, contracts and runs.",
    handler: async (args, ctx) => { try { await runExperimentsCommand(args, ctx); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } await refresh(); },
  });
  pi.registerCommand("idea", {
    description: getExtensionCommandSpec("idea")?.description ?? "Prepare research ideas in chat using Hypatia models and knowledge.",
    handler: async (args, ctx) => { try { if (!args.trim()) { ctx.ui.setEditorText("/idea "); ctx.ui.notify("Describe the research idea and press Enter.", "info"); return; } await experimentChat(ctx, "generate", args.trim()); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } },
  });
  pi.on("session_start", (_event, ctx) => { context = ctx; if (timer) clearInterval(timer); if (ctx.mode === "tui") { void refresh(); timer = setInterval(() => { void refresh(); }, 1000); timer.unref?.(); } });
  pi.on("session_shutdown", async () => { await pauseOwnedGenerations(); if (timer) clearInterval(timer); timer = undefined; context?.ui.setStatus(EXPERIMENT_STATUS_KEY, undefined); context = undefined; });
}
