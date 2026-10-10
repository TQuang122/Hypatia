import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { aggregateRoleUsage } from "../evals/role-usage.mjs";

test("aggregateRoleUsage groups actual models and usage by delegated role", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-role-usage-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	mkdirSync(home);
	const rows = [
		{ type: "session", id: "parent" },
		{
			type: "message",
			id: "tool-result-1",
			timestamp: "2026-10-01T10:00:00.000Z",
			message: {
				role: "toolResult",
				toolName: "subagent",
				details: {
					runId: "run-first",
					results: [{
						index: 0,
						agent: "researcher",
						model: "openai/gpt-5.6-luna",
						sessionFile: "/sessions/researcher-first.jsonl",
						usage: { input: 20, output: 0, cacheRead: 5, cacheWrite: 0, cost: { total: 0.001 }, turns: 1 },
					}],
				},
			},
		},
		{
			type: "message",
			id: "tool-result-2",
			timestamp: "2026-10-01T10:01:00.000Z",
			message: {
				role: "toolResult",
				toolName: "bg_wait",
				details: {
					runId: "run-first",
					results: [{
						index: 0,
						agent: "researcher",
						model: "openai/gpt-5.6-luna",
						sessionFile: "/sessions/researcher-first.jsonl",
						usage: { input: 20, output: 0, cacheRead: 5, cacheWrite: 0, cost: { total: 0.001 }, turns: 1 },
					}],
				},
			},
		},
		{
			type: "custom_message",
			id: "completion-1",
			timestamp: "2026-10-01T10:02:00.000Z",
			details: {
				mode: "single",
				runId: "run-fallback",
				results: [{
					index: 0,
					agent: "researcher",
					model: "anthropic/claude-sonnet-5-5",
					requestedModel: "anthropic/claude-sonnet-5-5",
					sessionFile: "/sessions/researcher-fallback.jsonl",
					usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 8, cost: { total: 0.012 }, turns: 2 },
				}],
			},
		},
		{
			type: "message",
			id: "tool-result-3",
			timestamp: "2026-10-01T10:03:00.000Z",
			message: {
				role: "toolResult",
				toolName: "subagent",
				details: {
					runId: "run-review",
					results: [{
						index: 0,
						agent: "reviewer",
						model: "anthropic/claude-opus-5-5",
						sessionFile: "/sessions/reviewer.jsonl",
						usage: { input: 300, output: 90, cacheRead: 20, cacheWrite: 0, cost: { total: 0.05 }, turns: 3 },
					}],
				},
			},
		},
	];
	writeFileSync(join(home, "parent.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));

	assert.deepEqual(aggregateRoleUsage([home]), {
		researcher: {
			calls: 2,
			models: ["openai/gpt-5.6-luna", "anthropic/claude-sonnet-5-5"],
			modelNotReported: 0,
			input_tokens: 120,
			output_tokens: 40,
			cache_read_tokens: 5,
			cache_write_tokens: 8,
			total_tokens: 160,
			cost_usd: 0.013,
		},
		reviewer: {
			calls: 1,
			models: ["anthropic/claude-opus-5-5"],
			modelNotReported: 0,
			input_tokens: 300,
			output_tokens: 90,
			cache_read_tokens: 20,
			cache_write_tokens: 0,
			total_tokens: 390,
			cost_usd: 0.05,
		},
	});
});

test("aggregateRoleUsage records missing model and usage without inventing values", (t) => {
	const root = mkdtempSync(join(tmpdir(), "hypatia-role-usage-missing-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	mkdirSync(home);
	writeFileSync(join(home, "parent.jsonl"), [
		JSON.stringify({ type: "session", id: "parent" }),
		JSON.stringify({
			type: "message",
			id: "tool-result",
			message: {
				role: "toolResult",
				toolName: "subagent",
				details: { runId: "run-1", results: [{ index: 0, agent: "verifier" }] },
			},
		}),
	].join("\n"));

	assert.deepEqual(aggregateRoleUsage([home]), {
		verifier: {
			calls: 1,
			models: [],
			modelNotReported: 1,
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			total_tokens: 0,
			cost_usd: 0,
		},
	});
});
