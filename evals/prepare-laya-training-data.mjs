import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
	balanceTrainingRows,
	loadCandidateRows,
	splitRowsByQuery,
	USEFUL_RELEVANCE_MINIMUM,
} from "./laya-pilot-input.mjs";

const RELEVANCE_QUESTION = {
	type: "choice",
	instructions: "Judge how useful this paper is for answering the research question.",
	criteria: {
		A: "Directly answers the question or supplies closely applicable evidence or methods.",
		B: "Unrelated, only tangential, or not useful for answering the question.",
	},
};

function queryIds(rows) {
	return [...new Set(rows.map((row) => row.queryId))].toSorted();
}

function toLayaTrainingCase(row) {
	return {
		state: [
			`Research question:\n${row.query}`,
			`Paper title: ${row.title}`,
			`Abstract: ${row.abstract.trim() || "not available"}`,
		].join("\n\n"),
		questions: { relevance: RELEVANCE_QUESTION },
		expected: {
			relevance: row.relevance >= USEFUL_RELEVANCE_MINIMUM ? "A" : "B",
		},
	};
}

export function prepareLayaTrainingData(trainRows, holdoutRows, { seed = "hypatia-laya-balanced-training-v1" } = {}) {
	if (!Array.isArray(trainRows) || trainRows.length === 0) throw new Error("training candidates are required.");
	if (!Array.isArray(holdoutRows) || holdoutRows.length === 0) throw new Error("held-out candidates are required.");
	const trainQueryIds = queryIds(trainRows);
	const holdoutQueryIds = queryIds(holdoutRows);
	const overlap = trainQueryIds.filter((queryId) => holdoutQueryIds.includes(queryId));
	if (overlap.length > 0) throw new Error(`training and held-out query IDs overlap: ${overlap.join(", ")}.`);

	const split = splitRowsByQuery([...trainRows, ...holdoutRows], { testQueryIds: holdoutQueryIds });
	const balanced = balanceTrainingRows(split.trainRows, { seed });
	return {
		train: balanced.rows.map(toLayaTrainingCase),
		holdout: split.testRows.map(toLayaTrainingCase),
		summary: {
			seed,
			binaryDecision: {
				usefulWhen: `relevance >= ${USEFUL_RELEVANCE_MINIMUM}`,
				notUsefulWhen: `relevance < ${USEFUL_RELEVANCE_MINIMUM}`,
			},
			train: {
				queryIds: split.trainQueryIds,
				selectedQueryIds: queryIds(balanced.rows),
				candidatesBeforeBalance: split.trainRows.length,
				candidatesAfterBalance: balanced.rows.length,
				omittedCandidates: balanced.omittedCandidates,
				balance: { before: balanced.before, after: balanced.after },
			},
			holdout: {
				queryIds: split.testQueryIds,
				...split.testSummary,
			},
		},
	};
}

export function prepareLayaTrainingOnlyData(rows, { seed = "hypatia-laya-balanced-training-v1" } = {}) {
	if (!Array.isArray(rows) || rows.length === 0) throw new Error("training candidates are required.");
	const balanced = balanceTrainingRows(rows, { seed });
	return {
		train: balanced.rows.map(toLayaTrainingCase),
		summary: {
			scope: "training-only; no held-out query evaluation",
			seed,
			binaryDecision: {
				usefulWhen: `relevance >= ${USEFUL_RELEVANCE_MINIMUM}`,
				notUsefulWhen: `relevance < ${USEFUL_RELEVANCE_MINIMUM}`,
			},
			train: {
				queryIds: queryIds(rows),
				selectedQueryIds: queryIds(balanced.rows),
				candidatesBeforeBalance: rows.length,
				candidatesAfterBalance: balanced.rows.length,
				omittedCandidates: balanced.omittedCandidates,
				balance: { before: balanced.before, after: balanced.after },
			},
			holdout: null,
		},
	};
}

function jsonl(records) {
	return `${records.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

function requiredPath(value, name) {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`--${name} is required.`);
	return resolve(value);
}

function sourceFiles(labelsPath, rankingsPath) {
	const source = loadCandidateRows(labelsPath, {
		baselineName: "Hypatia science-database retrieval order",
		baselineRankingsPath: rankingsPath,
	});
	return {
		rows: source.rows,
		label: source.label,
		rankings: source.baseline.rankings,
	};
}

async function main() {
	const { values } = parseArgs({
		options: {
			"train-labels": { type: "string", default: "outputs/decision-model-systems-hypatia-labels.jsonl" },
			"train-rankings": { type: "string", default: "outputs/decision-model-systems-hypatia-ranks.jsonl" },
			"holdout-labels": { type: "string" },
			"holdout-rankings": { type: "string" },
			"output-dir": { type: "string", default: "outputs/laya-hypatia-training" },
			"training-only": { type: "boolean" },
			seed: { type: "string", default: "hypatia-laya-balanced-training-v1" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		process.stdout.write(
			"Usage: node --import tsx evals/prepare-laya-training-data.mjs " +
			"[--training-only] [--holdout-labels <jsonl> --holdout-rankings <jsonl>] " +
			"[--train-labels <jsonl>] [--train-rankings <jsonl>] " +
			"[--output-dir <directory>] [--seed <value>]\n",
		);
		return;
	}
	const trainLabelsPath = requiredPath(values["train-labels"], "train-labels");
	const trainRankingsPath = requiredPath(values["train-rankings"], "train-rankings");
	if (typeof values.seed !== "string" || values.seed.trim() === "") throw new Error("--seed must be non-empty.");
	const trainSource = sourceFiles(trainLabelsPath, trainRankingsPath);
	const outputDir = resolve(values["output-dir"] ?? "outputs/laya-hypatia-training");
	if (values["training-only"]) {
		if (values["holdout-labels"] !== undefined || values["holdout-rankings"] !== undefined) {
			throw new Error("--training-only cannot be combined with holdout inputs.");
		}
		const prepared = prepareLayaTrainingOnlyData(trainSource.rows, { seed: values.seed });
		const outputPaths = {
			train: resolve(outputDir, "train.jsonl"),
			summary: resolve(outputDir, "summary.json"),
		};
		if (Object.values(outputPaths).some(existsSync)) {
			throw new Error("Training output already exists; choose a new --output-dir to preserve prior artifacts.");
		}
		const trainText = jsonl(prepared.train);
		const summary = {
			...prepared.summary,
			inputs: {
				trainLabels: trainSource.label,
				trainRankings: trainSource.rankings,
			},
			outputs: {
				train: { path: outputPaths.train, sha256: sha256(trainText) },
			},
		};
		const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
		mkdirSync(outputDir, { recursive: true });
		const created = [];
		try {
			writeFileSync(outputPaths.train, trainText, { flag: "wx", mode: 0o600 });
			created.push(outputPaths.train);
			writeFileSync(outputPaths.summary, summaryText, { flag: "wx", mode: 0o600 });
			created.push(outputPaths.summary);
		} catch (error) {
			for (const path of created) unlinkSync(path);
			throw error;
		}
		process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
		return;
	}
	const holdoutLabelsPath = requiredPath(values["holdout-labels"], "holdout-labels");
	const holdoutRankingsPath = requiredPath(values["holdout-rankings"], "holdout-rankings");
	const holdoutSource = sourceFiles(holdoutLabelsPath, holdoutRankingsPath);
	const prepared = prepareLayaTrainingData(trainSource.rows, holdoutSource.rows, { seed: values.seed });
	const outputPaths = {
		train: resolve(outputDir, "train.jsonl"),
		holdout: resolve(outputDir, "holdout.jsonl"),
		summary: resolve(outputDir, "summary.json"),
	};
	if (Object.values(outputPaths).some(existsSync)) {
		throw new Error("Training output already exists; choose a new --output-dir to preserve prior artifacts.");
	}

	const trainText = jsonl(prepared.train);
	const holdoutText = jsonl(prepared.holdout);
	const summary = {
		...prepared.summary,
		inputs: {
			trainLabels: trainSource.label,
			trainRankings: trainSource.rankings,
			holdoutLabels: holdoutSource.label,
			holdoutRankings: holdoutSource.rankings,
		},
		outputs: {
			train: { path: outputPaths.train, sha256: sha256(trainText) },
			holdout: { path: outputPaths.holdout, sha256: sha256(holdoutText) },
		},
	};
	const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
	mkdirSync(outputDir, { recursive: true });
	const created = [];
	try {
		writeFileSync(outputPaths.train, trainText, { flag: "wx", mode: 0o600 });
		created.push(outputPaths.train);
		writeFileSync(outputPaths.holdout, holdoutText, { flag: "wx", mode: 0o600 });
		created.push(outputPaths.holdout);
		writeFileSync(outputPaths.summary, summaryText, { flag: "wx", mode: 0o600 });
		created.push(outputPaths.summary);
	} catch (error) {
		for (const path of created) unlinkSync(path);
		throw error;
	}
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`Laya training data preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
