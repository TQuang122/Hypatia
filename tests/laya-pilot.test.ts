import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { evaluateRankings, pairedQueryBootstrap, summarizeLatencyTrials } from "../evals/laya-pilot-metrics.mjs";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value;
}

function requireNumber(value: unknown, label: string): number {
	if (typeof value !== "number") throw new Error(`${label} must be a number`);
	return value;
}

test("paired query bootstrap is deterministic and estimates Laya minus baseline nDCG", () => {
	const perQuery = [
		{ queryId: "q1", laya: { "ndcg@10": 0.8 }, baseline: { "ndcg@10": 0.5 } },
		{ queryId: "q2", laya: { "ndcg@10": 0.2 }, baseline: { "ndcg@10": 0.3 } },
		{ queryId: "q3", laya: { "ndcg@10": 1 }, baseline: { "ndcg@10": 0.9 } },
	];
	const options = { iterations: 2_000, seed: 1234 };
	const first = pairedQueryBootstrap(perQuery, "baseline", "ndcg@10", options);
	const second = pairedQueryBootstrap(perQuery, "baseline", "ndcg@10", options);

	assert.deepEqual(first, second);
	assert.ok(Math.abs(first.meanDifference - 0.1) < 1e-12);
	assert.ok(first.lower <= first.meanDifference);
	assert.ok(first.upper >= first.meanDifference);
	assert.equal(first.confidenceLevel, 0.95);
});

test("warm latency summary uses nearest-rank p95 and counts failed or truncated candidates", () => {
	const trials = Array.from({ length: 20 }, (_, index) => ({
		state: index === 19 ? "unavailable" : "advisory",
		durationMs: index + 1,
		scoredCandidates: index === 19 ? 0 : 20,
		truncatedCandidates: index === 0 ? 2 : 0,
	}));

	const summary = summarizeLatencyTrials(trials, 20);

	assert.equal(summary.warmRequests, 20);
	assert.equal(summary.successfulRequests, 19);
	assert.equal(summary.failedRequests, 1);
	assert.equal(summary.candidateAttempts, 400);
	assert.equal(summary.scoredCandidates, 380);
	assert.equal(summary.candidateSuccessRate, 0.95);
	assert.equal(summary.truncatedCandidates, 2);
	assert.equal(summary.truncationRate, 2 / 380);
	assert.equal(summary.warmP95Ms, 19);
	assert.equal(summary.warmMaxMs, 20);
});

test("Laya score ties preserve the baseline retrieval order", () => {
	const result = evaluateRankings([
		{ queryId: "q1", candidateId: "a", relevance: 0, baselineRank: 2, layaScore: 0.5, layaChoice: "A" },
		{ queryId: "q1", candidateId: "z", relevance: 3, baselineRank: 1, layaScore: 0.5, layaChoice: "A" },
	], [10], "retrieval");

	const evaluation = requireRecord(result, "evaluation");
	const perQuery = evaluation["perQuery"];
	assert.ok(Array.isArray(perQuery));
	const firstQuery = requireRecord(perQuery[0], "first query");
	const laya = requireRecord(firstQuery["laya"], "Laya metrics");
	assert.equal(requireNumber(laya["ndcg@10"], "Laya nDCG@10"), 1);
});

test("ranking metrics report abstract-complete and title-only strata separately", () => {
	const result = evaluateRankings([
		{ queryId: "with-abstract", candidateId: "relevant", relevance: 3, baselineRank: 1, layaScore: 0.1, layaChoice: "B", abstract: "Evidence." },
		{ queryId: "with-abstract", candidateId: "irrelevant", relevance: 0, baselineRank: 2, layaScore: 0.9, layaChoice: "A", abstract: "Unrelated." },
		{ queryId: "title-only", candidateId: "irrelevant", relevance: 0, baselineRank: 2, layaScore: 0.1, layaChoice: "B", abstract: "" },
		{ queryId: "title-only", candidateId: "relevant", relevance: 1, baselineRank: 1, layaScore: 0.9, layaChoice: "A", abstract: "" },
	], [2], "retrieval");
	const evaluation = requireRecord(result, "evaluation");
	const abstractStrata = requireRecord(evaluation["abstractStrata"], "abstract strata");
	const abstractPresent = requireRecord(abstractStrata["abstractPresent"], "abstract-present metrics");
	const titleOnly = requireRecord(abstractStrata["titleOnly"], "title-only metrics");
	const abstractLaya = requireRecord(abstractPresent["laya"], "abstract-present Laya metrics");
	const titleOnlyLaya = requireRecord(titleOnly["laya"], "title-only Laya metrics");

	assert.equal(abstractPresent["queries"], 1);
	assert.equal(abstractPresent["candidates"], 2);
	assert.equal(titleOnly["queries"], 1);
	assert.equal(titleOnly["candidates"], 2);
	assert.ok(Math.abs(requireNumber(abstractLaya["ndcg@2"], "abstract-present nDCG@2") - 0.6309297535714575) < 1e-12);
	assert.equal(requireNumber(titleOnlyLaya["ndcg@2"], "title-only nDCG@2"), 1);
});

test("binary relevance accuracy treats grade 1 partial as not directly useful", () => {
	const result = evaluateRankings([
		{ queryId: "q1", candidateId: "partial", relevance: 1, baselineRank: 1, layaScore: 0.1, layaChoice: "B" },
		{ queryId: "q1", candidateId: "useful", relevance: 2, baselineRank: 2, layaScore: 0.9, layaChoice: "A" },
	], [2], "retrieval");
	const evaluation = requireRecord(result, "evaluation");
	const laya = requireRecord(evaluation["laya"], "Laya metrics");
	const classification = requireRecord(laya["classification"], "binary relevance metrics");

	assert.equal(classification["accuracy"], 1);
	assert.equal(classification["precision"], 1);
	assert.equal(classification["recall"], 1);
});

async function runCli(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawn(process.execPath, [resolve("evals/laya-pilot.mjs"), ...args], {
		cwd: process.cwd(),
		env: { ...process.env, LAYA_API_KEY: "" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (!child.stdout || !child.stderr) throw new Error("CLI output streams were unavailable");
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	const code = await new Promise<number | null>((resolveCode, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("Laya pilot CLI did not exit within 30 seconds."));
		}, 30_000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (exitCode) => {
			clearTimeout(timeout);
			resolveCode(exitCode);
		});
	});
	return {
		code,
		stdout: Buffer.concat(stdout).toString("utf8"),
		stderr: Buffer.concat(stderr).toString("utf8"),
	};
}

test("Laya pilot refuses non-loopback endpoints before sending candidate data", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hypatia-laya-remote-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	const labels = join(directory, "labels.jsonl");
	await writeFile(
		labels,
		JSON.stringify({
			query_id: "q1",
			candidate_id: "p1",
			query: "test-time compute",
			title: "Paper",
			abstract: "Candidate text",
			relevance: 1,
			jev_rank: 1,
		}) + "\n",
	);

	const result = await runCli(["--labels", labels, "--base-url", "https://example.com"]);

	assert.equal(result.code, 1);
	assert.match(result.stderr, /loopback/i);
	assert.doesNotMatch(result.stderr, /Candidate text/);
});

test("Laya pilot rejects duplicate candidates before making a local request", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hypatia-laya-duplicate-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	const labels = join(directory, "labels.jsonl");
	const duplicate = {
		query_id: "q1",
		candidate_id: "p1",
		query: "test-time compute",
		title: "Paper",
		abstract: "Candidate text",
		relevance: 1,
	};
	await writeFile(labels, [
		JSON.stringify({ ...duplicate, jev_rank: 1 }),
		JSON.stringify({ ...duplicate, jev_rank: 2 }),
	].join("\n") + "\n");

	const result = await runCli(["--labels", labels, "--base-url", "http://127.0.0.1:1"]);

	assert.equal(result.code, 1);
	assert.match(result.stderr, /duplicate candidate_id/);
	assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
});

test("CSV headers that collide after trimming are rejected", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hypatia-laya-csv-headers-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	const labels = join(directory, "labels.csv");
	let requests = 0;
	const server = createServer((_request, response) => {
		requests += 1;
		response.writeHead(500).end();
	});
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Mock Laya server did not bind a TCP port");
	t.after(async () => {
		const closed = once(server, "close");
		server.close();
		await closed;
	});
	await writeFile(
		labels,
		[
			"query_id, query_id,candidate_id,query,title,abstract,relevance,jev_rank",
			'q1,q2,p1,"test-time compute","Paper","Abstract",1,1',
		].join("\n") + "\n",
	);

	const result = await runCli(["--labels", labels, "--base-url", `http://127.0.0.1:${address.port}`]);

	assert.equal(result.code, 1);
	assert.equal(requests, 0);
});

test("Laya pilot compares identical candidates with Jev ranks and relevance labels", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hypatia-laya-paired-"));
	const candidatesPath = join(directory, "labels.csv");
	const jevPath = join(directory, "jev.jsonl");
	await writeFile(
		candidatesPath,
		[
			"query_id,candidate_id,query,title,abstract,relevance",
			'q1,a,"test-time compute scaling","Paper A","Relevant evidence, with comma.",3',
			'q1,b,"test-time compute scaling","Paper B","Unrelated evidence.",0',
			'q1,c,"test-time compute scaling","Paper C","Partially relevant evidence.",1',
			'q1,d,"test-time compute scaling","Paper D","Unrelated evidence.",0',
		].join("\n") + "\n",
	);
	await writeFile(
		jevPath,
		[
			{ query_id: "q1", candidate_id: "b", jev_rank: 1 },
			{ query_id: "q1", candidate_id: "a", jev_rank: 2 },
			{ query_id: "q1", candidate_id: "c", jev_rank: 3 },
			{ query_id: "q1", candidate_id: "d", jev_rank: 4 },
		].map((row) => JSON.stringify(row)).join("\n") + "\n",
	);
	const scores = [0.9, 0.1, 0.8, 0.2];
	let requests = 0;
	let healthRequests = 0;
	const server = createServer((request, response) => {
		if (request.method === "GET" && request.url === "/health") {
			healthRequests += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({
				status: "ok",
				revisions: { english: "test-revision" },
				checkpoint_devices: { english: "cpu" },
			}));
			return;
		}
		const score = scores[requests];
		requests += 1;
		if (score === undefined) {
			response.writeHead(500).end();
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({
			model: "laya-rl-agent",
			answers: {
				relevance: {
					type: "choice",
					choice: score >= 0.5 ? "A" : "B",
					probabilities: { A: score, B: 1 - score },
				},
			},
			usage: { truncated: false },
			routing: { model: "english", repo: "convaiinnovations/laya" },
		}));
	});
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Mock Laya server did not bind a TCP port");
	t.after(async () => {
		const closed = once(server, "close");
		server.close();
		await closed;
		await rm(directory, { recursive: true, force: true });
	});

	const result = await runCli([
		"--labels",
		candidatesPath,
		"--jev-rankings",
		jevPath,
		"--base-url",
		`http://127.0.0.1:${address.port}`,
		"--cutoffs",
		"2,10",
	]);

	assert.equal(result.code, 0, result.stderr);
	assert.equal(requests, 4);
	assert.equal(healthRequests, 1);
	const parsedSummary: unknown = JSON.parse(result.stdout);
	const summary = requireRecord(parsedSummary, "summary");
	const model = requireRecord(summary["model"], "model");
	const metrics = requireRecord(summary["metrics"], "metrics");
	const laya = requireRecord(metrics["laya"], "Laya metrics");
	const jev = requireRecord(metrics["jev"], "Jev metrics");
	const bootstrap = requireRecord(metrics["pairedBootstrap"], "paired bootstrap");
	assert.equal(model["revision"], "test-revision");
	assert.equal(model["device"], "cpu");
	assert.equal(bootstrap["metric"], "ndcg@10");
	assert.equal(bootstrap["iterations"], 10_000);
	assert.equal(requireNumber(laya["precision@2"], "Laya precision@2"), 1);
	assert.equal(requireNumber(laya["recall@2"], "Laya recall@2"), 1);
	assert.equal(requireNumber(laya["mrr"], "Laya MRR"), 1);
	assert.equal(requireNumber(jev["precision@2"], "Jev precision@2"), 0.5);
	assert.equal(requireNumber(jev["recall@2"], "Jev recall@2"), 0.5);
	assert.equal(requireNumber(jev["mrr"], "Jev MRR"), 0.5);
	assert.doesNotMatch(result.stdout, /Relevant evidence, with comma/);
});

test("malformed Laya JSON errors do not expose response body text", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hypatia-laya-response-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	const labels = join(directory, "labels.jsonl");
	await writeFile(labels, JSON.stringify({
		query_id: "q1",
		candidate_id: "p1",
		query: "test-time compute",
		title: "Paper",
		abstract: "Synthetic abstract.",
		relevance: 1,
		jev_rank: 1,
	}) + "\n");
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end("SECRET_LAYA_RESPONSE_BODY");
	});
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Mock Laya server did not bind a TCP port");
	t.after(async () => {
		const closed = once(server, "close");
		server.close();
		await closed;
	});

	const result = await runCli([
		"--labels",
		labels,
		"--base-url",
		`http://127.0.0.1:${address.port}`,
	]);

	assert.equal(result.code, 1);
	assert.match(result.stderr, /invalid JSON/i);
	assert.doesNotMatch(result.stderr, /SECRET_LAYA_RESPONSE_BODY/);
});

test("Laya pilot compares a named Hypatia retrieval baseline", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hypatia-laya-retrieval-baseline-"));
	const candidatesPath = join(directory, "labels.csv");
	await writeFile(
		candidatesPath,
		[
			"query_id,candidate_id,query,title,abstract,relevance,retrieval_rank",
			'q1,a,"test-time compute scaling","Paper A","Relevant evidence.",3,2',
			'q1,b,"test-time compute scaling","Paper B","Unrelated evidence.",0,1',
			'q1,c,"test-time compute scaling","Paper C","Partially relevant evidence.",1,3',
			'q1,d,"test-time compute scaling","Paper D","Unrelated evidence.",0,4',
		].join("\n") + "\n",
	);
	const scores = [0.9, 0.1, 0.8, 0.2];
	let requests = 0;
	let healthRequests = 0;
	const server = createServer((request, response) => {
		if (request.method === "GET" && request.url === "/health") {
			healthRequests += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({
				status: "ok",
				revisions: { english: "test-revision" },
				checkpoint_devices: { english: "cpu" },
			}));
			return;
		}
		const score = scores[requests];
		requests += 1;
		if (score === undefined) {
			response.writeHead(500).end();
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({
			model: "laya-rl-agent",
			answers: {
				relevance: {
					type: "choice",
					choice: score >= 0.5 ? "A" : "B",
					probabilities: { A: score, B: 1 - score },
				},
			},
			usage: { truncated: false },
			routing: { model: "english", repo: "convaiinnovations/laya" },
		}));
	});
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Mock Laya server did not bind a TCP port");
	t.after(async () => {
		const closed = once(server, "close");
		server.close();
		await closed;
		await rm(directory, { recursive: true, force: true });
	});

	const result = await runCli([
		"--labels",
		candidatesPath,
		"--baseline-name",
		"Hypatia retrieval",
		"--base-url",
		`http://127.0.0.1:${address.port}`,
		"--cutoffs",
		"2",
	]);

	assert.equal(result.code, 0, result.stderr);
	assert.equal(requests, 4);
	assert.equal(healthRequests, 1);
	const parsedSummary: unknown = JSON.parse(result.stdout);
	const summary = requireRecord(parsedSummary, "summary");
	const metrics = requireRecord(summary["metrics"], "metrics");
	const laya = requireRecord(metrics["laya"], "Laya metrics");
	const baseline = requireRecord(metrics["baseline"], "baseline metrics");
	const inputs = requireRecord(summary["inputs"], "inputs");
	const baselineInput = requireRecord(inputs["baseline"], "baseline input");
	const candidates = summary["candidateScores"];
	assert.ok(Array.isArray(candidates));
	const firstCandidate = requireRecord(candidates[0], "first candidate");
	assert.equal(baseline["name"], "Hypatia retrieval");
	assert.equal(baselineInput["name"], "Hypatia retrieval");
	assert.equal(requireNumber(laya["precision@2"], "Laya precision@2"), 1);
	assert.equal(requireNumber(baseline["precision@2"], "baseline precision@2"), 0.5);
	assert.equal(firstCandidate["baselineRank"], 2);
	assert.equal(metrics["jev"], undefined);
});

test("Laya pilot joins separate baseline rankings by query and candidate IDs", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hypatia-laya-separate-baseline-"));
	const candidatesPath = join(directory, "blinded-labels.jsonl");
	const baselinePath = join(directory, "baseline-rankings.jsonl");
	await writeFile(candidatesPath, [
		{ query_id: "q1", candidate_id: "a", query: "question one", title: "Paper A1", abstract: "", relevance: 3 },
		{ query_id: "q1", candidate_id: "b", query: "question one", title: "Paper B1", abstract: "", relevance: 0 },
		{ query_id: "q2", candidate_id: "a", query: "question two", title: "Paper A2", abstract: "", relevance: 0 },
		{ query_id: "q2", candidate_id: "b", query: "question two", title: "Paper B2", abstract: "", relevance: 3 },
	].map((row) => JSON.stringify(row)).join("\n") + "\n");
	await writeFile(baselinePath, [
		{ query_id: "q1", candidate_id: "a", baseline_rank: 1 },
		{ query_id: "q1", candidate_id: "b", baseline_rank: 2 },
		{ query_id: "q2", candidate_id: "a", baseline_rank: 2 },
		{ query_id: "q2", candidate_id: "b", baseline_rank: 1 },
	].map((row) => JSON.stringify(row)).join("\n") + "\n");
	const scores = [0.9, 0.1, 0.1, 0.9];
	let requests = 0;
	let healthRequests = 0;
	const server = createServer((request, response) => {
		if (request.method === "GET" && request.url === "/health") {
			healthRequests += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({
				status: "ok",
				revisions: { english: "test-revision" },
				checkpoint_devices: { english: "cpu" },
			}));
			return;
		}
		const score = scores[requests];
		requests += 1;
		if (score === undefined) {
			response.writeHead(500).end();
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({
			model: "laya-rl-agent",
			answers: {
				relevance: {
					type: "choice",
					choice: score >= 0.5 ? "A" : "B",
					probabilities: { A: score, B: 1 - score },
				},
			},
			usage: { truncated: false },
			routing: { model: "english", repo: "convaiinnovations/laya" },
		}));
	});
	const listening = once(server, "listening");
	server.listen(0, "127.0.0.1");
	await listening;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Mock Laya server did not bind a TCP port");
	t.after(async () => {
		const closed = once(server, "close");
		server.close();
		await closed;
		await rm(directory, { recursive: true, force: true });
	});

	const result = await runCli([
		"--labels",
		candidatesPath,
		"--baseline-name",
		"Hypatia retrieval order",
		"--baseline-rankings",
		baselinePath,
		"--base-url",
		`http://127.0.0.1:${address.port}`,
		"--cutoffs",
		"1",
	]);

	assert.equal(result.code, 0, result.stderr);
	assert.equal(requests, 4);
	assert.equal(healthRequests, 1);
	const parsedSummary: unknown = JSON.parse(result.stdout);
	const summary = requireRecord(parsedSummary, "summary");
	const metrics = requireRecord(summary["metrics"], "metrics");
	const baseline = requireRecord(metrics["baseline"], "baseline metrics");
	const inputs = requireRecord(summary["inputs"], "inputs");
	const baselineInput = requireRecord(inputs["baseline"], "baseline input");
	const baselineRankings = requireRecord(baselineInput["rankings"], "baseline rankings");
	const candidates = summary["candidateScores"];
	assert.ok(Array.isArray(candidates));
	assert.deepEqual(candidates.map((candidate) => requireRecord(candidate, "candidate")["baselineRank"]), [1, 2, 2, 1]);
	assert.equal(baseline["name"], "Hypatia retrieval order");
	assert.equal(baselineInput["name"], "Hypatia retrieval order");
	assert.equal(baselineRankings["name"], "baseline-rankings.jsonl");
	assert.equal(requireNumber(baseline["precision@1"], "baseline precision@1"), 1);
	assert.equal(metrics["jev"], undefined);
});
