import assert from "node:assert/strict";
import test from "node:test";
import { Key, type TUI } from "@earendil-works/pi-tui";
import { initTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { formatGenerationApproval, formatGenerationStatus, formatIdeaProposal, IdeaForgeReader, showIdeaForgeReader } from "../extensions/research-tools/idea-forge-view.js";
import { viewGenerationStatus } from "../extensions/research-tools/idea-forge.js";

const run = {
  spec: { slug: "qml-pilot", topic: "QML VQC", signal: "Paired ring-CNOT ablation", direction: "qml", sourceUrl: "", modelPanel: ["openai/gpt-6-luna"], maxRequests: 24, maxWallSeconds: 900, backend: { directions: [{ id: "qml", title: "Quantum machine learning" }] } },
  state: { status: "completed", updatedAt: "2026-10-07T02:00:00.000Z", spentMs: 21000, message: "Generation completed with 1 proposal.", receipts: [] },
  root: "/tmp/forge",
} as any;
initTheme();

test("proposal preview renders readable sections and advisory verdict instead of JSON dumps", () => {
  const rendered = formatIdeaProposal(run, { index: 1, title: "Entanglement ablation", idea: "Compare paired VQC circuits.", plan: "1. Freeze the split.\n2. Report paired differences.", direction: "qml", sourceModel: "openai/gpt-6-luna", validation: { verdict: "revise", advisory: true, summary: "Add a bounded seed count.", findings: ["Keep the held-out split closed."] }, consensus: { reviewer: "openai/gpt-6-luna", independent: false } });
  assert.match(rendered, /## Research idea/);
  assert.match(rendered, /## Proposed plan/);
  assert.match(rendered, /## Advisory review/);
  assert.match(rendered, /Verdict: revise · advisory only/);
  assert.match(rendered, /Independent model: no/);
  assert.match(rendered, /Keep the held-out split closed/);
  assert.doesNotMatch(rendered, /Consensus:\s*\{/);
});

test("generation status includes request, cache, receipt and integrity details", () => {
  const rendered = formatGenerationStatus(run, { requestCount: 3, completedRequests: 3, failedRequests: 0, responseCacheCount: 3, proposalCount: 1, integrity: "request journal and checkpoint verified", receipts: ["completed · 3 requests · 21.0s · checksum verified"] });
  assert.match(rendered, /Reserved: 3\/24/);
  assert.match(rendered, /Completed responses cached: 3/);
  assert.match(rendered, /Proposals: 1 · unverified/);
  assert.match(rendered, /checksum verified/);
  assert.match(rendered, /request journal and checkpoint verified/);
});

test("generation approval lists the exact wiki pages and hashes frozen into the contract", () => {
  const wikiRun = { ...run, spec: { ...run.spec, knowledgePaths: ["wiki/concepts/rag-evaluation.md"], knowledgeSources: [{ path: "wiki/concepts/rag-evaluation.md", hash: "abcdef1234567890" }] } };
  const rendered = formatGenerationApproval(wikiRun, []);
  assert.match(rendered, /project wiki context/iu);
  assert.match(rendered, /selected project wiki bundle/u);
  assert.match(rendered, /wiki\/concepts\/rag-evaluation\.md/u);
  assert.match(rendered, /sha256 abcdef123456/u);
});

test("reader provides scrolling controls and returns cleanly without submitting editor text", async () => {
  let closed = false, renderRequests = 0;
  const tui = { terminal: { rows: 10 }, requestRender: () => renderRequests++ } as unknown as Pick<TUI, "requestRender"> & { terminal: Pick<TUI["terminal"], "rows"> };
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, style: (text: string) => text, colors: { customMessageBg: "#222222" } } as unknown as Theme;
  const doc = Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n\n");
  const reader = new IdeaForgeReader(tui, theme, "Proposal preview", doc, () => { closed = true; });
  const first = reader.render(60).join("\n");
  assert.match(first, /Proposal preview/); assert.match(first, /Line 1/); assert.match(first, /Esc back/);
  for (let i = 0; i < 6; i++) reader.handleInput("\u001b[6~");
  const later = reader.render(60).join("\n");
  assert.ok(renderRequests > 0); assert.doesNotMatch(later, /Line 1\s/); assert.match(later, /Line/);
  reader.handleInput("\u001b"); assert.equal(closed, true);
});

test("custom reader opens the TUI view API and resolves only when the reader closes", async () => {
  let output = "", done!: () => void;
  const ui = { custom: async (factory: any) => new Promise<void>(resolve => {
    const component = factory({ terminal: { rows: 12 }, requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text, style: (text: string) => text, colors: { customMessageBg: "#222222" } }, {}, resolve);
    output = component.render(70).join("\n"); component.handleInput("\u001b");
  }) } as unknown as Pick<ExtensionCommandContext["ui"], "custom">;
  await showIdeaForgeReader(ui, "Idea Forge status", "## Request budget\n\n3/24 calls");
  assert.match(output, /Idea Forge status/); assert.match(output, /3\/24 calls/);
});

test("View Status opens the readable reader panel instead of an ephemeral toast", async () => {
  let output = "", notifications = 0;
  const ctx = { ui: { notify: () => notifications++, custom: async (factory: any) => new Promise<void>(resolve => {
    const component = factory({ terminal: { rows: 14 }, requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text, style: (text: string) => text, colors: { customMessageBg: "#222222" } }, {}, resolve);
    output = component.render(75).join("\n"); component.handleInput("\u001b");
  }) } } as any;
  const runtime = { requestLedger: async () => ({ requests: 3, events: [{ kind: "request_finished", data: { outcome: "delivered" } }, { kind: "response_cached" }] }), generationReceipt: async () => { throw new Error("no receipt expected"); } };
  await viewGenerationStatus(ctx, run as any, runtime as any);
  assert.equal(notifications, 0); assert.match(output, /Idea Forge status · qml-pilot/); assert.match(output, /Reserved: 3\/24/); assert.match(output, /responses cached: 1/);
});
