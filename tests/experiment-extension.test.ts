import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerExperimentWorkflow } from "../extensions/research-tools/experiment-workflow.js";
import { confirmTreeAction, registerExperiments, runExperimentsCommand } from "../extensions/research-tools/experiments.js";
import { registerExperimentChat } from "../extensions/research-tools/experiment-chat.js";
import { engine, treeNodeCountUnit } from "../extensions/research-tools/experiment-engine.js";
import { readPromptSpecs, extensionCommandSpecs } from "../metadata/commands.mjs";
import type { ContractInput } from "../src/experiments/schema.js";
import { createInitialTreeState, validateTreeInput, type TreeDefinition, type TreeNode } from "../src/experiments/tree-schema.js";
import { initializeTree } from "../src/experiments/tree-store.js";

type CapturedTreeTool = {
  execute: (
    id: string,
    params: { action: "tree_list" },
    signal: AbortSignal | undefined,
    onUpdate: ((result: unknown) => void) | undefined,
    context: ExtensionCommandContext,
  ) => Promise<{ details: unknown }>;
};

async function initializeListedTree(workspace: string, slug: string, nodeIds: readonly string[]): Promise<void> {
  const input = validateTreeInput({
    slug,
    hypothesis: "Inspect a bounded research direction",
    argv: [process.execPath, "fixture.mjs"],
    filesInScope: ["fixture.mjs"],
    environment: "Fixture Node",
    metric: { source: "stdout", key: "score", unit: "score", direction: "max" },
    reviewPolicy: "none",
    maxTotalTrials: 2,
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
  const state = createInitialTreeState(definition);
  state.nodes = nodeIds.map((id, index): TreeNode => ({
    id,
    status: nodeIds.length > 1 && index === 0 ? "planned" : "creating",
    parentNodeId: index === 0 ? null : "root",
    parentReceiptId: index === 0 ? null : `receipt-${index}`,
    ...(nodeIds.length > 1 && index === 0 ? { sourceSnapshotHash: "b".repeat(64), contractHash: "c".repeat(64) } : {}),
    worktree: `experiments/.trees/${slug}/nodes/${id}`,
    experimentSlug: slug,
    createdAt: definition.createdAt,
  }));
  await initializeTree(workspace, definition, state);
}

test("tree node count units distinguish singular and plural render tokens", () => {
  assert.equal(treeNodeCountUnit(1), "node");
  assert.equal(treeNodeCountUnit(2), "nodes");
});

test("agent tree_list returns numeric counts for one-node and multi-node trees", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "experiment-tree-list-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await initializeListedTree(cwd, "count-one", ["root"]);
  await initializeListedTree(cwd, "count-many", ["root", "child"]);

  let tool: CapturedTreeTool | undefined;
  const pi = { registerTool: (value: CapturedTreeTool) => { tool = value; }, on() {} } as unknown as ExtensionAPI;
  registerExperimentWorkflow(pi);
  const ctx = { cwd, mode: "rpc", hasUI: false } as unknown as ExtensionCommandContext;
  if (!tool) throw new Error("Experiment tool was not registered.");
  const result = await tool.execute("tree-list", { action: "tree_list" }, undefined, undefined, ctx);

  assert.ok(Array.isArray(result.details));
  const details: unknown[] = result.details;
  const counts = details.map(item => {
    if (!item || typeof item !== "object" || !("nodes" in item) || typeof item.nodes !== "number") {
      throw new Error("Tree-list details must include a numeric node count.");
    }
    return item.nodes;
  });
  assert.deepEqual(counts.sort((left, right) => left - right), [1, 2]);
});

test("experiment registration preserves the autoresearch prompt and exposes the management command", () => {
  const tools: string[] = [], commands: string[] = [];
  const pi = { registerTool: (tool: {name: string}) => tools.push(tool.name), registerCommand: (name: string) => commands.push(name), on() {} } as unknown as ExtensionAPI;
  registerExperimentWorkflow(pi); registerExperiments(pi);
  assert.deepEqual(tools, ["hypatia_experiment"]); assert.deepEqual(commands, ["experiments", "idea"]);
  assert.ok(readPromptSpecs(process.cwd()).some(prompt => prompt.name === "autoresearch" && prompt.topLevelCli));
  assert.ok(extensionCommandSpecs.some(command => command.name === "experiments"));
});
test("/experiments tree list suggests creation when no trees exist", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "experiment-tree-empty-list-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "experiments"));
  const notices: string[] = [];
  const ctx = {
    cwd, mode: "tui", hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext;

  await runExperimentsCommand("tree list", ctx);

  assert.deepEqual(notices, ["No experiment trees found. Use /experiments tree create to start one."]);
});
test("tree manager hides operations that cannot apply to an empty tree", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "experiment-tree-empty-actions-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await initializeListedTree(cwd, "empty-actions", []);
  const selectionCalls: Array<{ title: string; options: string[] }> = [];
  const selections = [
    "Manage experiment trees",
    "empty-actions · 0 nodes · 0/2 trials",
    "Back",
    "Back",
  ];
  const ctx = {
    cwd, mode: "tui", hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        selectionCalls.push({ title, options });
        return selections.shift();
      },
      notify() {},
    },
  } as unknown as ExtensionCommandContext;

  await runExperimentsCommand("", ctx);

  const actions = selectionCalls.find(call => call.title === "Tree empty-actions");
  assert.deepEqual(actions?.options, ["View tree status", "Export tree report", "Back"]);
});
test("tree approval prompts default to Back and name the affirmative action", async () => {
  const dialogs: Array<{ title: string; options: string[] }> = [], notices: string[] = [];
  let selected: string | undefined;
  const ctx = {
    ui: {
      notify: (message: string) => notices.push(message),
      select: async (title: string, options: string[]) => { dialogs.push({ title, options }); return selected ?? options[0]; },
    },
  } as unknown as Pick<ExtensionCommandContext, "ui">;

  assert.equal(await confirmTreeAction(ctx, "Approve root?", "Review the root contract.", "Approve"), false);
  selected = "Approve";
  assert.equal(await confirmTreeAction(ctx, "Approve root?", "Review the root contract.", "Approve"), true);
  assert.deepEqual(dialogs, [
    { title: "Approve root?", options: ["Back", "Approve"] },
    { title: "Approve root?", options: ["Back", "Approve"] },
  ]);
  assert.deepEqual(notices, ["Review the root contract.", "Review the root contract."]);
});
test("tree command failures name the affected tree and operation", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "experiment-tree-error-context-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "experiments"));
  const notices: string[] = [];
  const ctx = {
    cwd, mode: "tui", hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext;

  await runExperimentsCommand("tree status missing-tree", ctx);

  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /^Tree missing-tree · status failed:/);
  assert.match(notices[0]!, /ENOENT/i);
});
test("tool-created contracts require user approval and management status never starts a benchmark", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "experiment-ui-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "fixture.mjs"), "console.log('HYPATIA_METRIC {\\\"loss\\\":1}');");
  let tool: {execute: (...args: any[]) => Promise<any>} | undefined;
  const pi = { registerTool: (value: typeof tool) => { tool = value; }, on() {} } as unknown as ExtensionAPI;
  registerExperimentWorkflow(pi);
  const input: ContractInput = { slug: "ui-run", hypothesis: "Fixture", argv: [process.execPath, "fixture.mjs"], filesInScope: ["fixture.mjs"], environment: "Fixture Node", metric: {source:"stdout",key:"loss",direction:"min",unit:"loss"} };
  let confirmations = 0; const notifications: string[] = [];
  const ui = { confirm: async () => { confirmations++; return false; }, notify: (text: string) => notifications.push(text), setStatus() {} };
  const context = { cwd, mode: "tui", hasUI: true, ui } as unknown as ExtensionCommandContext;
  const created = await tool!.execute("create", {action:"create",contract:input}, undefined, undefined, context);
  assert.equal(created.isError, undefined); assert.equal(confirmations, 1);
  const runtime = await engine(); assert.equal((await runtime.status(cwd, "ui-run")).state.state, "planned");
  const denied = await tool!.execute("run", {action:"run",slug:"ui-run",kind:"baseline"}, undefined, undefined, context); assert.equal(denied.isError, true); assert.match(denied.content[0].text, /[Aa]pprov|supported host/);
  ui.confirm = async () => { confirmations++; return true; };
  await runExperimentsCommand("approve ui-run", context);
  assert.equal((await runtime.status(cwd, "ui-run")).state.state, "ready");
  await runExperimentsCommand("status ui-run", context); assert.equal(confirmations, 2); assert.equal((await runtime.status(cwd, "ui-run")).state.receipts.length, 0);
  assert.ok(notifications.some(text => text.includes("Baseline: unavailable")));
  const abort = new AbortController(); abort.abort();
  const cancelled = await tool!.execute("run", {action:"run",slug:"ui-run"}, abort.signal, undefined, context); assert.equal(cancelled.isError, true); assert.match(cancelled.content[0].text, /cancelled before/);
});
test("menu import of a manual idea with a spaced path creates planned state without launching a benchmark", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "experiment-import-ui-")); t.after(() => rm(cwd, {recursive:true,force:true}));
  const idea = join(cwd, "my idea.txt"); writeFileSync(idea, "A manually supplied research hypothesis."); writeFileSync(join(cwd, "fixture.mjs"), "console.log('HYPATIA_METRIC {\\\"loss\\\":1}');");
  const contract = { slug:"import-ui",hypothesis:"Manual idea",argv:[process.execPath,"fixture.mjs"],filesInScope:["fixture.mjs"],environment:"Fixture",metric:{source:"stdout",key:"loss",unit:"loss",direction:"min"} };
  writeFileSync(join(cwd,"contract.json"),JSON.stringify(contract));
  const inputs = ["contract.json", ""], notices: string[] = [];
  const ctx = {cwd,mode:"tui",hasUI:true,ui:{input:async()=>inputs.shift(),confirm:async()=>false,notify:(text:string)=>notices.push(text)}} as unknown as ExtensionCommandContext;
  await runExperimentsCommand(`import-json ${idea} --contract contract.json`,ctx);
  const state = await (await engine()).status(cwd,"import-ui"); assert.equal(state.state.state,"planned"); assert.equal(state.state.receipts.length,0);
  assert.ok(existsSync(join(state.root,"idea.provenance.json"))); assert.ok(notices.length);
});

test("/idea and Generate ideas menu selection enter the composer instead of a wizard", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "idea-command-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const commands = new Map<string, any>(), sent: string[] = [], notices: string[] = []; let composer = "";
  const pi = { registerTool() {}, registerCommand: (name: string, command: any) => commands.set(name, command), on() {}, sendUserMessage: (text: string) => sent.push(text) } as unknown as ExtensionAPI;
  registerExperiments(pi); registerExperimentChat(pi);
  const ui: any = { setEditorText: (text: string) => composer = text, notify: (text: string) => notices.push(text),
    select: async () => "/idea <research goal>", input: async () => { throw new Error("Wizard inputs must not open."); },
    editor: async () => { throw new Error("Wizard editor must not open."); } };
  const ctx = { cwd, mode: "tui", hasUI: true, ui } as unknown as ExtensionCommandContext;
  await commands.get("idea").handler("", ctx); assert.equal(composer, "/idea ");
  await commands.get("idea").handler("QML ring-CNOT pilot", ctx); assert.match(sent[0]!, /QML ring-CNOT pilot/);
  await runExperimentsCommand("", ctx); assert.equal(composer, "/idea "); assert.ok(notices.length >= 2);
});
