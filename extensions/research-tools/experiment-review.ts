import { readFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { createAgentSession, createExtensionRuntime, getAgentDir, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionContext, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { getSubagentModelRoutes } from "./subagent-models.js";
import { engine, type Experiment } from "./experiment-engine.js";
import type { ReviewKind, ReviewRecord } from "../../src/experiments/schema.js";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export function parseReviewOutput(text: string): unknown {
  if (text.length > 128 * 1024) throw new Error("Reviewer output exceeded 128 KiB.");
  const fenced = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return JSON.parse(fenced ? fenced[1]! : text.trim());
}
export async function consumeReviewSession(session: Pick<AgentSession, "messages" | "prompt" | "subscribe" | "abort">, prompt: string, signal: AbortSignal, onProgress?: (text: string) => void) {
  let turns = 0, bounded = false;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<void>((_resolve, reject) => { rejectAbort = reject; });
  const stop = () => { void session.abort().catch(() => {}); rejectAbort(new Error("Review cancelled or bounded deadline reached.")); };
  signal.addEventListener("abort", stop, { once: true });
  const unsubscribe = session.subscribe(event => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      if (++turns > 12 || (turns === 12 && event.message.stopReason === "toolUse")) { bounded = true; stop(); }
      onProgress?.(`Review · ${turns}/12 turns`);
    }
  });
  try {
    if (signal.aborted) throw new Error("Review cancelled.");
    let promptError: string | undefined;
    try { await Promise.race([session.prompt(prompt, { expandPromptTemplates: false }), aborted]); } catch (error) { promptError = error instanceof Error ? error.message : String(error); }
    const messages = session.messages.filter(message => message.role === "assistant");
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    for (const message of messages) {
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += message.usage[key];
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += message.usage.cost[key];
    }
    const last = messages.at(-1);
    if (promptError || signal.aborted || bounded || !last || ["error", "aborted", "toolUse"].includes(last.stopReason)) return { error: promptError ?? (signal.aborted ? "Review cancelled or exceeded its 180-second deadline." : bounded ? "Review turn budget exhausted." : last?.errorMessage ?? "Reviewer did not complete a verdict."), usage, provider: last?.provider, model: last?.responseModel ?? last?.model };
    const text = last.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    try { return { value: parseReviewOutput(text), usage, provider: last.provider, model: last.responseModel ?? last.model }; }
    catch (error) { return { error: `Malformed review: ${error instanceof Error ? error.message : String(error)}`, usage, provider: last.provider, model: last.responseModel ?? last.model }; }
  } finally { unsubscribe(); signal.removeEventListener("abort", stop); }
}
async function reviewerSession(ctx: ExtensionContext, experiment: Experiment, kind: ReviewKind, signal: AbortSignal) {
  const role: "critic" | "auditor" = kind === "plan" ? "critic" : "auditor", agentDir = getAgentDir();
  const rolePath = resolve(dirname(fileURLToPath(import.meta.url)), `../../.hypatia/agents/${role}.md`);
  const source = await readFile(rolePath, "utf8");
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), signal, allowModelNetwork: false });
  // Reuse registered custom providers without changing their persisted configuration.
  for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
    const native = ctx.modelRegistry.getRegisteredNativeProvider(id), config = ctx.modelRegistry.getRegisteredProviderConfig(id);
    if (native) modelRuntime.registerNativeProvider(native);
    if (config) modelRuntime.registerProvider(id, config);
  }
  const routes = getSubagentModelRoutes(agentDir)[role].models;
  const candidates = routes.length ? routes : ctx.model ? [`${ctx.model.provider}/${ctx.model.id}`] : [];
  let selected: ReturnType<ModelRuntime["getModel"]>, thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" = kind === "plan" ? "high" : "medium";
  for (const route of candidates) {
    const suffix = route.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
    const spec = suffix ? route.slice(0, -suffix[0].length) : route;
    const slash = spec.indexOf("/");
    const matches = slash > 0 ? [modelRuntime.getModel(spec.slice(0, slash), spec.slice(slash + 1))].filter(Boolean) : modelRuntime.getModels().filter(model => model.id === spec);
    if (matches.length !== 1) continue;
    const candidate = matches[0]!;
    const auth = await modelRuntime.getAuth(candidate, { signal }).catch(error => { if (signal.aborted) throw error; return undefined; });
    if (!auth) continue;
    selected = candidate;
    if (suffix) thinking = suffix[1] as typeof thinking;
    break;
  }
  if (!selected) throw new Error(`No available ${role} model. Configure /model-routes or authenticate a model before review.`);
  const loader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => body, getSystemPromptSource: () => ({ path: rolePath }), getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
  };
  const root = experiment.root, workspace = experiment.contract.workspace;
  const sessions = join(root, "reviews/sessions"); await mkdir(sessions, { recursive: true });
  const sessionManager = SessionManager.create(workspace, sessions);
  const { session } = await createAgentSession({ cwd: workspace, agentDir, model: selected, modelRuntime, thinkingLevel: thinking, resourceLoader: loader, sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }),
    tools: ["experiment_read"], customTools: [{ name: "experiment_read", label: "Read experiment evidence", description: "Read a workspace-relative experiment evidence or scoped source file. No writes or shell execution.", parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
      async execute(_id, value) {
        const args = value as { path: string; offset?: number; limit?: number };
        const runtime = await engine();
        const allowed = new Set([...experiment.contract.filesInScope, ...experiment.contract.inputFiles]);
        const base = `experiments/${experiment.contract.slug}/`;
        if (!args.path.startsWith(base) && !allowed.has(args.path)) throw new Error("Reviewer reads are limited to declared source/input files and this experiment's evidence.");
        // The engine's path resolver rejects traversal and symlinks.
        const { readReviewFile } = runtime;
        const text = await readReviewFile(workspace, args.path, args.offset ?? 1, args.limit ?? 200);
        return { content: [{ type: "text" as const, text }], details: {} };
      } }],
  });
  return { session, role, promptHash: sha(body), sessionPath: relative(workspace, sessionManager.getSessionFile()!) };
}
export async function performExperimentReview(ctx: ExtensionContext, experiment: Experiment, kind: ReviewKind, signal?: AbortSignal, onProgress?: (text: string) => void, onUsage?: (usage: Usage) => void, workspace = ctx.cwd): Promise<ReviewRecord> {
  const runtime = await engine();
  const start = await runtime.beginReview(workspace, experiment.contract.slug, kind);
  if (start.cached) return start.cached;
  const owner = start.owner!;
  const controller = new AbortController(), stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  const deadline = setTimeout(stop, runtime.REVIEW_TIMEOUT_MS);
  const paused = setInterval(() => { void runtime.status(workspace, experiment.contract.slug).then(current => { if (["paused", "pause_requested"].includes(current.state.state)) stop(); }).catch(stop); }, 1000);
  let child: Awaited<ReturnType<typeof reviewerSession>> | undefined;
  let observed: { reviewer: ReviewRecord["reviewer"]; usage?: Usage } = { reviewer: null };
  try {
    onProgress?.(`${kind === "plan" ? "Critic" : "Auditor"} review · Starting`);
    child = await reviewerSession(ctx, experiment, kind, controller.signal);
    const prompt = `HYPATIA_EXPERIMENT_REVIEW\nKind: ${kind}\nEvidence bundle: experiments/${experiment.contract.slug}/${owner.bundlePath}\nBundle SHA256: ${owner.bundleHash}\nRead the bundle with experiment_read, then inspect relevant evidence before returning the experiment review JSON contract.`;
    const output = await consumeReviewSession(child.session, prompt, controller.signal, onProgress);
    onUsage?.(output.usage);
    const reviewer = output.provider && output.model ? { role: child.role, provider: output.provider, model: output.model, promptHash: child.promptHash, sessionPath: child.sessionPath } : null;
    observed = { reviewer, usage: output.usage };
    if (output.error) return runtime.finishReview(workspace, experiment.contract.slug, owner, { verdict: "error", summary: output.error, findings: [], reviewer, usage: output.usage });
    const verdict = runtime.validateReviewVerdict(output.value, owner.bundleHash);
    return runtime.finishReview(workspace, experiment.contract.slug, owner, { verdict: verdict.verdict, summary: verdict.summary, findings: verdict.findings, reviewer, usage: output.usage });
  } catch (error) {
    return runtime.finishReview(workspace, experiment.contract.slug, owner, { verdict: "error", summary: error instanceof Error ? error.message : String(error), findings: [], ...observed });
  } finally { clearTimeout(deadline); clearInterval(paused); signal?.removeEventListener("abort", stop); child?.session.dispose(); }
}
export async function ensureExperimentReview(ctx: ExtensionContext, experiment: Experiment, kind: ReviewKind, signal?: AbortSignal, onProgress?: (text: string) => void, onUsage?: (usage: Usage) => void, workspace = ctx.cwd): Promise<ReviewRecord | undefined> {
  if (experiment.contract.reviewPolicy !== "required") return undefined;
  const current = (await (await engine()).reviewStatus(experiment, kind)).current;
  if (current?.verdict === "pass") return current;
  if (current) throw new Error(`Review ${current.verdict}: ${current.summary} Address findings and explicitly request action review before retrying.`);
  const result = await performExperimentReview(ctx, experiment, kind, signal, onProgress, onUsage, workspace);
  if (result.verdict !== "pass") throw new Error(`Review ${result.verdict}: ${result.summary}`);
  return result;
}
