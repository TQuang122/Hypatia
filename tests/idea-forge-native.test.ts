import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as forge from "../src/idea-forge/index.js";
import { requestLedger } from "../src/idea-forge/evidence.js";
import { importIdea } from "../src/experiments/import-autoresearch.js";
import { registerNativeIdeaForge } from "../extensions/research-tools/idea-forge-native.js";
import { registerExperimentChat } from "../extensions/research-tools/experiment-chat.js";
import { runExperimentsCommand } from "../extensions/research-tools/experiments.js";

async function fixture(t: TestContext, options: { delay?: number; cap?: number; sameModel?: boolean; truncated?: boolean; noUsage?: boolean } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "native-forge-")), agent = join(workspace, "agent"); await mkdir(agent);
  let count = 0; const stages: string[] = [];
  const server = createServer((req, res) => {
    let raw = ""; req.on("data", chunk => raw += String(chunk)); req.on("end", () => {
      count++; const input = JSON.parse(raw), last = input.messages.at(-1).content;
      const prompt = typeof last === "string" ? last : JSON.stringify(last);
      const stage = prompt.includes("Propose ONE") ? "ideation" : prompt.includes("Write a concise executable") ? "planning" : "critique"; stages.push(stage);
      const text = stage === "ideation" ? JSON.stringify({ title: `Synthetic QML ${input.model}`, idea: "Paired entanglement ablation with fixed data and resources.", rationale: "Fixture only", limitations: [] })
        : stage === "planning" ? "Synthetic fixture plan: frozen paired splits, seeds and metric; prepare benchmark files first. No research evidence."
        : JSON.stringify({ verdict: "pass", summary: "Synthetic advisory review only.", findings: [] });
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const model = options.sameModel ? "shared-underlying-model" : input.model;
        const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
        chunk({ role: "assistant", content: text }, null); chunk({}, options.truncated ? "length" : "stop", options.noUsage ? undefined : { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }); res.end("data: [DONE]\n\n");
      }, options.delay ?? 0);
    });
  });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  const panel = ["fixture/a", "fixture/b", "fixture/c"];
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "synthetic-private-key", api: "openai-completions", models: ["a", "b", "c"].map(id => ({ id, name: id, contextWindow: 10000, maxTokens: 4096, reasoning: false })) } } }));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); await rm(workspace, { recursive: true, force: true }); });
  const backend = await forge.inspectNativeBackend(agent, panel);
  const input = { slug: "qml-native", topic: "Quantum machine learning VQC", signal: "Test a paired ring-CNOT ablation on two moons", direction: "qml", modelPanel: panel,
    maxRequests: options.cap ?? 24, maxWallSeconds: 30, maxTokens: 1024, requestTimeoutSeconds: 5, resourceDescription: "CPU synthetic fixture" };
  return { workspace, agent, panel, backend, input, count: () => count, stages };
}
const integration = process.platform === "win32" ? test.skip : test;
integration("native Hypatia generation needs no clone/Python, seals real SDK requests, and imports proposals without benchmark approval", async t => {
  const f = await fixture(t); assert.equal(f.backend.kind, "native"); assert.equal(f.backend.python, ""); assert.equal(f.count(), 0);
  const run = await forge.createGeneration(f.workspace, f.input, f.backend); assert.equal(f.count(), 0);
  assert.ok(!(await readFile(join(run.root, "contract.json"), "utf8")).includes("synthetic-private-key"));
  await assert.rejects(forge.startGeneration(f.workspace, f.input.slug), /Approve/); assert.equal(f.count(), 0);
  await forge.approveGeneration(f.workspace, f.input.slug); await forge.startGeneration(f.workspace, f.input.slug);
  const complete = await forge.waitGeneration(f.workspace, f.input.slug); assert.equal(complete.state.status, "completed", complete.state.message ?? "");
  assert.equal(f.count(), 9); const ideas = await forge.generationIdeas(complete); assert.equal(ideas.length, 3);
  const ledger = await requestLedger(run.root); assert.equal(ledger.requests, 9); assert.ok(ledger.events.some(e => e.kind === "request_finished" && e.data.usage.totalTokens === 30));
  const exported = await forge.exportGenerationIdea(complete, 1); const imported = await importIdea(exported.path); assert.equal(imported.provenance.kind, "hypatia-idea-forge");
  const cached = await forge.startGeneration(f.workspace, f.input.slug); assert.equal(cached.cached, true); assert.equal(f.count(), 9);
  await writeFile(join(run.root, "forge.json"), "{}"); await assert.rejects(forge.generationIdeas(await forge.generationStatus(f.workspace, f.input.slug)), /evidence changed/);
});
test("QML knowledge auto-matches, rejects unrelated directions before requests, and snapshots custom workspace knowledge", async t => {
  const f = await fixture(t); assert.equal((await forge.nativeKnowledge(f.workspace, "VQC ring-CNOT")).id, "qml");
  await assert.rejects(forge.nativeKnowledge(f.workspace, "quantum classifier", "llm"), /does not match/);
  await assert.rejects(forge.createGeneration(f.workspace, { ...f.input, direction: "llm" }, f.backend), /does not match/); assert.equal(f.count(), 0);
  await writeFile(join(f.workspace, "domain.md"), "Custom fixed quantum ML protocol");
  const run = await forge.createGeneration(f.workspace, { ...f.input, knowledgePath: "domain.md" }, f.backend);
  await writeFile(join(f.workspace, "domain.md"), "Later external edit"); assert.equal(await readFile(join(run.root, "knowledge_base/custom.md"), "utf8"), "Custom fixed quantum ML protocol");
  await assert.rejects(forge.nativeKnowledge(f.workspace, "qml", undefined, "../escape.md"), /Unsafe/);
});
integration("native caps persist and never replay an exhausted generation", async t => {
  const f = await fixture(t, { cap: 2 }); await forge.createGeneration(f.workspace, f.input, f.backend); await forge.approveGeneration(f.workspace, f.input.slug);
  await forge.startGeneration(f.workspace, f.input.slug); const run = await forge.waitGeneration(f.workspace, f.input.slug);
  assert.equal(run.state.status, "budget_exhausted", run.state.message ?? ""); assert.equal(f.count(), 2);
  await assert.rejects(forge.startGeneration(f.workspace, f.input.slug), /budget.*exhausted/); assert.equal(f.count(), 2);
});
integration("native pause/resume reuses completed responses and keeps interrupted request reservations", async t => {
  const f = await fixture(t, { delay: 150 }); await forge.createGeneration(f.workspace, f.input, f.backend); await forge.approveGeneration(f.workspace, f.input.slug);
  await forge.startGeneration(f.workspace, f.input.slug);
  for (let i = 0; i < 100; i++) { const run = await forge.generationStatus(f.workspace, f.input.slug); const ledger = await requestLedger(run.root).catch(() => ({ events: [] })); if (ledger.events.some(e => e.kind === "response_cached")) break; await new Promise(ok => setTimeout(ok, 50)); }
  await forge.pauseGeneration(f.workspace, f.input.slug); const paused = await forge.waitGeneration(f.workspace, f.input.slug); assert.equal(paused.state.status, "paused");
  await forge.startGeneration(f.workspace, f.input.slug); const complete = await forge.waitGeneration(f.workspace, f.input.slug); assert.equal(complete.state.status, "completed", complete.state.message ?? "");
  const log = await readFile(join(complete.root, `attempts/${complete.state.receipts.at(-1)!.id}/stdout.jsonl`), "utf8"); assert.match(log, /cached_response/);
  assert.equal((await requestLedger(complete.root)).requests, f.count()); assert.ok(f.count() < 18);
});
integration("native blocks contradictory panel response identities", async t => {
  const f = await fixture(t, { sameModel: true }); await forge.createGeneration(f.workspace, f.input, f.backend); await forge.approveGeneration(f.workspace, f.input.slug);
  await forge.startGeneration(f.workspace, f.input.slug); const run = await forge.waitGeneration(f.workspace, f.input.slug); assert.equal(run.state.status, "blocked"); assert.equal(f.count(), 2); assert.equal((await forge.generationIdeas(run)).length, 0);
});
test("chat entrypoints prefill/send requests without wizard; normal chat is not rewritten or automatically executed", async t => {
  const f = await fixture(t); let hook: any; const sent: string[] = []; let composer = "";
  registerExperimentChat({ on: (_event: string, fn: unknown) => { hook = fn; }, sendUserMessage: (text: string) => sent.push(text) } as unknown as ExtensionAPI);
  const ctx = { cwd: f.workspace, mode: "tui", hasUI: true, ui: { setEditorText: (text: string) => composer = text, notify() {}, input() { throw new Error("Wizard input forbidden"); }, editor() { throw new Error("Wizard editor forbidden"); } } } as unknown as ExtensionCommandContext;
  await runExperimentsCommand("generate VQC entanglement ideas", ctx); assert.match(sent[0]!, /VQC entanglement ideas/);
  await runExperimentsCommand("create quantum benchmark", ctx); assert.match(sent[1]!, /quantum benchmark/);
  await runExperimentsCommand("create", ctx); assert.match(composer, /Create a bounded benchmark/);
  const event: any = { prompt: "Explain what a qubit is", systemPromptOptions: { sections: {} } }; hook(event, ctx); assert.equal(event.prompt, "Explain what a qubit is");
  assert.match(event.systemPromptOptions.sections.hypatia_experiments, /wiki\/index\.md/u);
  assert.match(event.systemPromptOptions.sections.hypatia_experiments, /knowledgePaths/u);
  assert.equal(sent.length, 2); assert.equal(f.count(), 0);
});
test("native tool declines approval once and makes no provider call", async t => {
  const f = await fixture(t); let definition: any, confirmations = 0;
  await writeFile(join(f.agent,"autoresearch-backend.json"),"{invalid-legacy-config");
  registerNativeIdeaForge({ registerTool: (tool: unknown) => definition = tool, on() {} } as unknown as ExtensionAPI);
  const ctx = { cwd: f.workspace, hasUI: true, model: { provider: "fixture", id: "a" }, ui: { confirm: async () => { confirmations++; return false; }, setStatus() {} } };
  const result = await definition.execute("create", { action: "create", contract: { slug: "single-model", topic: "QML pilot", signal: "Compare entanglement on two moons" } }, undefined, undefined, ctx);
  assert.equal(result.isError, undefined, result.content[0].text); assert.equal(result.details.status, "planned"); assert.equal(confirmations, 1); assert.equal(f.count(), 0);
  const denied = await definition.execute("run", { action: "run", slug: "single-model" }, undefined, undefined, ctx); assert.equal(denied.isError, true); assert.equal(f.count(), 0);
});
test("native Idea Forge preflights, reviews, and freezes selected wiki pages as one knowledge bundle", async t => {
  const f = await fixture(t); const page = "wiki/concepts/rag-evaluation.md"; const body = "# RAG evaluation\nKeep retrieval and answer grounding metrics separate.\n";
  await mkdir(join(f.workspace, "wiki/concepts"), { recursive: true }); await writeFile(join(f.workspace, page), body);
  let definition: any, approval = "";
  registerNativeIdeaForge({ registerTool: (tool: unknown) => definition = tool, on() {} } as unknown as ExtensionAPI);
  const ctx = { cwd: f.workspace, hasUI: true, model: { provider: "fixture", id: "a" }, ui: { confirm: async (_title: string, text: string) => { approval = text; return false; }, setStatus() {} } };
  const selected = [page];
  const preflight = await definition.execute("preflight", { action: "preflight", topic: "RAG evaluation", knowledgePaths: selected }, undefined, undefined, ctx);
  assert.equal(preflight.isError, undefined, preflight.content[0].text);
  assert.deepEqual(preflight.details.knowledgePaths, selected);
  assert.equal(preflight.details.knowledgeSources[0].path, page);
  assert.equal(preflight.details.knowledgeHash.length, 64);
  assert.equal(f.count(), 0);

  const created = await definition.execute("create", { action: "create", contract: { ...f.input, slug: "wiki-ideas", topic: "RAG evaluation", direction: preflight.details.direction, knowledgePaths: selected } }, undefined, undefined, ctx);
  assert.equal(created.isError, undefined, created.content[0].text);
  assert.equal(created.details.status, "planned");
  assert.match(approval, /wiki\/concepts\/rag-evaluation\.md/u);
  assert.match(approval, new RegExp(preflight.details.knowledgeSources[0].hash.slice(0, 12), "u"));
  const run = await forge.generationStatus(f.workspace, "wiki-ideas");
  assert.deepEqual(run.spec.knowledgePaths, selected);
  assert.deepEqual(run.spec.knowledgeSources, preflight.details.knowledgeSources);
  assert.equal(await readFile(join(run.root, "knowledge_base/custom.md"), "utf8").then(text => text.includes(body.trim())), true);
  await writeFile(join(f.workspace, page), "Later wiki edit\n");
  assert.equal((await readFile(join(run.root, "knowledge_base/custom.md"), "utf8")).includes("Later wiki edit"), false);
  assert.equal(f.count(), 0);
});
integration("single-model native tool creates and runs after one approval without claiming independent review", async t => {
  const f = await fixture(t); let definition: any, confirmations = 0;
  registerNativeIdeaForge({ registerTool: (tool: unknown) => definition = tool, on() {} } as unknown as ExtensionAPI);
  const ctx = { cwd: f.workspace, hasUI: true, model: { provider: "fixture", id: "a" }, ui: { confirm: async () => { confirmations++; return true; }, setStatus() {} } };
  const created = await definition.execute("create", { action: "create", contract: { slug: "single-native", topic: "QML", signal: "Paired entanglement ablation", maxWallSeconds: 30 } }, undefined, undefined, ctx);
  assert.equal(created.details.status, "ready", created.content[0].text); assert.equal(confirmations, 1); assert.equal(f.count(), 0);
  const finished = await definition.execute("run", { action: "run", slug: "single-native" }, undefined, undefined, ctx);
  assert.equal(finished.details.status, "completed", finished.content[0].text); assert.equal(f.count(), 3); assert.equal(confirmations, 1);
  const run = await forge.generationStatus(f.workspace, "single-native"); const ideas = await forge.generationIdeas(run);
  assert.equal(ideas.length, 1); assert.equal((ideas[0]!.consensus as any).independent, false);
});
integration("truncated native generation is blocked with charged evidence and no proposal cache", async t => {
  const f = await fixture(t, { truncated: true }); await forge.createGeneration(f.workspace, f.input, f.backend); await forge.approveGeneration(f.workspace, f.input.slug);
  await forge.startGeneration(f.workspace, f.input.slug); const run = await forge.waitGeneration(f.workspace, f.input.slug);
  assert.equal(run.state.status, "blocked"); assert.match(run.state.message!, /truncated/); assert.equal(f.count(), 1);
  const ledger = await requestLedger(run.root); assert.equal(ledger.requests, 1); assert.equal(ledger.events.filter(e => e.kind === "response_cached").length, 0);
});
integration("source-free installed layout runs native ideas without an upstream repository or Python", async t => {
  const f = await fixture(t), installed = join(f.workspace, "installed-hypatia"); await mkdir(installed);
  await cp(join(process.cwd(), "dist"), join(installed, "dist"), { recursive: true });
  await writeFile(join(installed, "package.json"), JSON.stringify({ type: "module" }));
  await symlink(join(process.cwd(), "node_modules"), join(installed, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(stat(join(installed, "src")), /ENOENT/);
  const packaged = await import(pathToFileURL(join(installed, "dist/idea-forge/index.js")).href) as typeof forge;
  const backend = await packaged.inspectNativeBackend(f.agent, [f.panel[0]!]);
  await packaged.createGeneration(f.workspace, { ...f.input, slug: "packaged-native", modelPanel: [f.panel[0]!] }, backend);
  await packaged.approveGeneration(f.workspace, "packaged-native"); await packaged.startGeneration(f.workspace, "packaged-native");
  const completed = await packaged.waitGeneration(f.workspace, "packaged-native"); assert.equal(completed.state.status, "completed", completed.state.message ?? ""); assert.equal(f.count(), 3);
});
integration("missing provider usage stays unreported; SDK/runtime identity is frozen and changed configuration cannot execute", async t => {
  const f = await fixture(t, { noUsage: true }); const backend = await forge.inspectNativeBackend(f.agent, [f.panel[0]!]);
  assert.ok(backend.dependencyVersions.node); assert.ok(backend.dependencyVersions["@earendil-works/pi-ai"]);
  const run = await forge.createGeneration(f.workspace, { ...f.input, modelPanel: [f.panel[0]!] }, backend);
  await forge.approveGeneration(f.workspace, f.input.slug); await forge.startGeneration(f.workspace, f.input.slug);
  const completed = await forge.waitGeneration(f.workspace, f.input.slug); assert.equal(completed.state.status, "completed", completed.state.message ?? "");
  const ledger = await requestLedger(run.root);
  for(const event of ledger.events.filter(e=>e.kind==="request_finished")){ assert.equal(event.data.usage,null); assert.equal(event.data.usageReported,false); }
  const next = await forge.createGeneration(f.workspace, { ...f.input, slug:"config-drift", modelPanel:[f.panel[0]!] }, backend);
  await writeFile(join(f.agent,"models.json"),(await readFile(join(f.agent,"models.json"),"utf8")).replace('"name":"a"','"name":"changed-name"'));
  await assert.rejects(forge.approveGeneration(f.workspace, next.spec.slug), /configuration changed/); assert.equal(f.count(), 3);
});
