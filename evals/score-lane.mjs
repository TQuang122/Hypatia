#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";

import { scoreAstaBenchRows } from "./lanes/astabench.mjs";
import { scoreDeepResearchFactRows } from "./lanes/deepresearch-fact.mjs";
import { scoreSciCoqaRows } from "./lanes/scicoqa.mjs";

const { values: opt } = parseArgs({
	options: {
		lane: { type: "string" },
		input: { type: "string" },
		split: { type: "string", default: "validation" },
		"gold-ids": { type: "string" },
		output: { type: "string" },
	},
});

function readJsonl(path) {
	return readFileSync(path, "utf8")
		.split("\n")
		.flatMap((line, index) => {
			if (!line.trim()) return [];
			try {
				return [JSON.parse(line)];
			} catch (error) {
				throw new Error(`Invalid JSON in ${basename(path)} at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
}

function scoreLane(lane, input, options) {
	if (lane === "scholarqa-cs2") {
		return scoreAstaBenchRows(input, { split: options.split });
	}
	if (lane === "deepresearch-fact") {
		return scoreDeepResearchFactRows(input);
	}
	if (lane === "scicoqa") {
		if (!options.goldIdsPath) throw new Error("--gold-ids <json-file> is required for the SciCoQA lane.");
		const ids = JSON.parse(readFileSync(options.goldIdsPath, "utf8"));
		return scoreSciCoqaRows(input, ids);
	}
	throw new Error("Unknown lane. Use scholarqa-cs2, deepresearch-fact, or scicoqa.");
}

function main() {
	if (!opt.lane || !opt.input) {
		throw new Error("Usage: node evals/score-lane.mjs --lane <scholarqa-cs2|deepresearch-fact|scicoqa> --input <official-score-jsonl> [--gold-ids <json-file>] [--output <json-file>]");
	}
	const inputPath = resolve(opt.input);
	const rows = readJsonl(inputPath);
	const summary = scoreLane(opt.lane, rows, {
		split: opt.split,
		goldIdsPath: opt["gold-ids"] ? resolve(opt["gold-ids"]) : undefined,
	});
	const output = `${JSON.stringify({ input: basename(inputPath), ...summary }, null, 2)}\n`;
	if (opt.output) writeFileSync(resolve(opt.output), output, "utf8");
	process.stdout.write(output);
}

main();
