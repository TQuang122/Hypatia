import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { forgeRuntime } from "./idea-forge.js";
import { clearIdeaForgeModelSelection, getIdeaForgeModelSelection } from "./idea-forge-selection.js";
import { showIdeaForgeApproval } from "./idea-forge-view.js";
import { EXPERIMENT_STATUS_KEY } from "./experiment-engine.js";
import type { GenerationInput, Generation } from "../../src/idea-forge/types.js";

export function generationSummary(run: Generation) {
  const direction = run.spec.backend.directions.find(item => item.id === run.spec.direction)?.title ?? run.spec.direction;
  return [
    `Idea Forge · ${run.spec.slug} · ${run.state.status}`,
    `Topic: ${run.spec.topic}\nSignal: ${run.spec.signal}\nKnowledge: ${direction}${run.spec.knowledgePaths?.length ? " + project wiki context" : run.spec.knowledgePath ? ` (${run.spec.knowledgePath})` : " (built-in guidance)"}${run.spec.knowledgePaths?.length ? ` (wiki pages: ${run.spec.knowledgePaths.join(", ")})` : ""}`,
    ...(run.spec.knowledgePaths?.length ? [`Wiki page hashes:\n${(run.spec.knowledgeSources ?? []).map(source => `- ${source.path} · sha256 ${source.hash.slice(0, 12)}`).join("\n")}`] : []),
    `Source: ${run.spec.sourceUrl || "user-provided signal; not independently verified"}`,
    `Models: ${run.spec.modelPanel.join(", ")}\nReview: ${run.spec.modelPanel.length === 1 ? "single model; no independent panel" : "distinct configured models; model votes are advisory"}`,
    `Resources: ${run.spec.resourceDescription}`,
    `Caps: ${run.spec.maxRequests} API attempts; ${run.spec.maxWallSeconds}s; ${run.spec.maxTokens} output tokens/request; ${run.spec.requestTimeoutSeconds}s/request`,
    run.state.message || "Generation approval covers model calls only. A benchmark needs a separate contract approval.",
    `Artifacts: experiments/idea-forge/${run.spec.slug}/`,
  ].join("\n");
}
const inputSchema = Type.Object({
  slug: Type.String(), topic: Type.String(), signal: Type.String(), sourceUrl: Type.Optional(Type.String()),
  direction: Type.Optional(Type.String()), knowledgePath: Type.Optional(Type.String()), knowledgePaths: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })), modelPanel: Type.Optional(Type.Array(Type.String())),
  resourceDescription: Type.Optional(Type.String()), maxRequests: Type.Optional(Type.Integer()), maxWallSeconds: Type.Optional(Type.Integer()),
  maxTokens: Type.Optional(Type.Integer()), requestTimeoutSeconds: Type.Optional(Type.Integer()),
});
export function registerNativeIdeaForge(pi: ExtensionAPI) {
  const owned = new Map<string, {workspace:string;slug:string}>();
  pi.registerTool({
    name: "hypatia_idea_forge", label: "Idea Forge",
    description: "Generate bounded research proposals directly with Hypatia models/auth; no AutoResearch clone or Python required. preflight validates model availability and knowledge/domain without generation calls. When relevant, use up to 12 selected indexed project wiki concept/source pages as knowledgePaths alongside the matching built-in guidance; pending proposals are rejected, the combined 128 KiB bundle and page paths/hashes are frozen in the contract. Unless the user explicitly requests different caps, native idea generation defaults to at least 12 API attempts and at least three attempts per selected model, 900 seconds total, 5000 output tokens per request, and 90 seconds per request. create freezes a native contract and presents ONE user approval dialog; after approval in the TUI it starts and waits for generation in the same call. Declined approval leaves planned state; run/resume start a previously approved contract. Outside the TUI, run is a separate follow-up action after approval. Full-panel generation needs up to three attempts per selected model; explicitly supplied caps below that minimum are rejected before approval. Failed attempts consume request budget; checkpoints/receipts and cached responses survive pause/resume. Single-model critique is not independent. ideas lists unverified proposals; export returns an ideaFile for a separately approved hypatia_experiment contract. Ordinary explanations do not authorize a generation. Choose built-in knowledge or provide one project-relative knowledgePath for other user-supplied knowledge.",
    parameters: Type.Object({ action: Type.Union(["preflight", "create", "status", "run", "resume", "pause", "ideas", "export"].map(value => Type.Literal(value))),
      slug: Type.Optional(Type.String()), topic: Type.Optional(Type.String()), direction: Type.Optional(Type.String()), knowledgePath: Type.Optional(Type.String()), knowledgePaths: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
      modelPanel: Type.Optional(Type.Array(Type.String())), contract: Type.Optional(inputSchema), index: Type.Optional(Type.Integer()) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const result = (text: string, details: unknown, isError = false) => ({ content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) });
      try {
        const runtime = await forgeRuntime();
        if (signal?.aborted) throw new Error("Generation cancelled before execution.");
        const runGeneration = async (slug: string): Promise<Generation> => {
          const approvedRun = await runtime.generationStatus(ctx.cwd, slug);
          const minimumRequests = approvedRun.spec.modelPanel.length * 3;
          if (approvedRun.spec.backend.kind === "native" && approvedRun.spec.maxRequests < minimumRequests) {
            throw new Error(`This approved ${approvedRun.spec.modelPanel.length}-model contract allows ${approvedRun.spec.maxRequests} requests, below the ${minimumRequests} needed for a full panel. Create a new contract with a larger cap; this frozen contract was not started.`);
          }
          const started = await runtime.startGeneration(ctx.cwd, slug);
          const ownership = `${ctx.cwd}:${slug}`;
          if (!started.cached) owned.set(ownership, { workspace: ctx.cwd, slug });
          try {
            return await runtime.waitGeneration(ctx.cwd, slug, { signal, onStatus: (current, count) => {
              const text = `Idea Forge · ${slug} · ${count}/${current.spec.maxRequests} requests · ${current.state.status}`;
              try { ctx.ui.setStatus(EXPERIMENT_STATUS_KEY, text); } catch { /* Session replacement leaves bounded worker ownership on disk. */ }
              onUpdate?.(result(text, { status: current.state.status, requests: count }));
            } });
          } finally {
            owned.delete(ownership);
            try { ctx.ui.setStatus(EXPERIMENT_STATUS_KEY, undefined); } catch { /* Session may already be closed. */ }
          }
        };
        if (params.action === "preflight" || params.action === "create") {
          const raw = params.contract;
          const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
          const selectedPanel = sessionId ? getIdeaForgeModelSelection(sessionId) : undefined;
          const requestedPanel = raw?.modelPanel ?? params.modelPanel;
          const normalizePanel = (models: readonly string[]) => [...models].sort();
          if (selectedPanel && requestedPanel && JSON.stringify(normalizePanel(selectedPanel)) !== JSON.stringify(normalizePanel(requestedPanel))) {
            throw new Error("Use the exact Idea Forge model panel selected in the TUI.");
          }
          const panel = selectedPanel ?? requestedPanel;
          const preferred = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
          const backend = await runtime.inspectNativeBackend(getAgentDir(), panel, preferred);
          const topic = raw ? `${raw.topic}\n${raw.signal}` : params.topic;
          if (!topic?.trim()) throw new Error("Provide the research topic before preflight.");
          const knowledgePath = raw?.knowledgePath ?? params.knowledgePath;
          const knowledgePaths = raw?.knowledgePaths ?? params.knowledgePaths;
          const knowledge = await runtime.nativeKnowledge(ctx.cwd, topic, raw?.direction ?? params.direction, knowledgePath, knowledgePaths);
          const minimumRequests = backend.roles.ideator.length * 3;
          if (params.action === "preflight") return result(`Preflight ready · ${knowledge.title}\nModels: ${backend.roles.ideator.join(", ")}\n${knowledge.sources?.length ? `Knowledge pages/files:\n${knowledge.sources.map(source => `- ${source.path} · sha256 ${source.hash.slice(0, 12)}`).join("\n")}\n` : ""}No model-generation request was sent.`, { direction: knowledge.id, title: knowledge.title, knowledgePaths: knowledgePaths ?? [], knowledgeSources: knowledge.sources ?? [], knowledgeHash: knowledge.hash, modelPanel: backend.roles.ideator, minimumPanel: 1, defaults: { maxRequests: Math.max(12, minimumRequests), maxWallSeconds: 900, maxTokens: 5000, requestTimeoutSeconds: 90 } });
          if (!raw) throw new Error("create requires topic, signal and slug in contract.");
          const maxRequests = raw.maxRequests ?? Math.max(12, minimumRequests);
          if (raw.maxRequests !== undefined && maxRequests < minimumRequests) throw new Error(`The selected ${backend.roles.ideator.length}-model panel may need up to ${minimumRequests} requests (ideation, planning and critique per model); maxRequests=${maxRequests} is too low. Use at least ${minimumRequests} or choose a smaller panel.`);
          const input: GenerationInput = { ...raw, knowledgePath, knowledgePaths, direction: raw.direction ?? knowledge.id, modelPanel: backend.roles.ideator,
            resourceDescription: raw.resourceDescription ?? "Local CPU pilot proposed; compute availability is unverified.", maxRequests,
            maxWallSeconds: raw.maxWallSeconds ?? 900, maxTokens: raw.maxTokens ?? 5000, requestTimeoutSeconds: raw.requestTimeoutSeconds ?? Math.min(90, raw.maxWallSeconds ?? 900) };
          let run = await runtime.createGeneration(ctx.cwd, input, backend);
          if (selectedPanel && sessionId) clearIdeaForgeModelSelection(sessionId);
          const inferred = ["direction", "modelPanel", "resourceDescription", "maxRequests", "maxWallSeconds", "maxTokens", "requestTimeoutSeconds"].filter(key => raw[key as keyof typeof raw] === undefined);
          let approved = false;
          if (ctx.hasUI) {
            approved = ctx.mode === "tui"
              ? await showIdeaForgeApproval(ctx.ui, run, inferred)
              : await ctx.ui.confirm("Approve idea generation?", generationSummary(run) + `\nInferred defaults: ${inferred.join(", ") || "none"}`);
          }
          if (approved) {
            run = await runtime.approveGeneration(ctx.cwd, input.slug);
            if (ctx.mode === "tui") run = await runGeneration(input.slug);
          }
          return result(generationSummary(run), { slug: input.slug, status: run.state.status, inferredDefaults: inferred, contractHash: run.state.contractHash });
        }
        if (!params.slug) throw new Error("Provide the generation slug.");
        let run = await runtime.generationStatus(ctx.cwd, params.slug);
        if (params.action === "run" || params.action === "resume") {
          run = await runGeneration(params.slug);
        } else if (params.action === "pause") run = await runtime.pauseGeneration(ctx.cwd, params.slug);
        else if (params.action === "ideas") { const ideas = await runtime.generationIdeas(run); return result(`${ideas.length} unverified proposal(s)\n${ideas.map(idea => `${idea.index}. ${idea.title}\n${idea.idea}\n${idea.plan}`).join("\n\n")}`, { slug: params.slug, status: run.state.status, ideas }); }
        else if (params.action === "export") { if (!params.index) throw new Error("Select the proposal index."); const selected = await runtime.exportGenerationIdea(run, params.index); return result(`Idea file: ${selected.path}\nRead the proposal and prepare benchmark prerequisites. Selecting a proposal does not approve a benchmark.`, selected); }
        return result(generationSummary(run), { slug: params.slug, status: run.state.status, active: Boolean(run.state.active) });
      } catch (error) { return result(error instanceof Error ? error.message : "Idea generation failed.", { status: "blocked" }, true); }
    },
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (sessionId) clearIdeaForgeModelSelection(sessionId);
    const runtime = await forgeRuntime();
    for (const run of owned.values()) await runtime.pauseGeneration(run.workspace, run.slug);
    owned.clear();
  });
}
