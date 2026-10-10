import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrZero(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageValues(value) {
	const usage = isRecord(value) ? value : {};
	const cost = isRecord(usage.cost) ? usage.cost.total : usage.cost;
	const input = numberOrZero(usage.input);
	const output = numberOrZero(usage.output);
	return {
		input_tokens: input,
		output_tokens: output,
		cache_read_tokens: numberOrZero(usage.cacheRead),
		cache_write_tokens: numberOrZero(usage.cacheWrite),
		total_tokens: Math.max(input + output, numberOrZero(usage.totalTokens)),
		cost_usd: numberOrZero(cost),
	};
}

function resultRows(details) {
	if (!isRecord(details)) return [];
	const rows = Array.isArray(details.results) ? [...details.results] : [];
	if (Array.isArray(details.completions)) {
		for (const completion of details.completions) {
			if (isRecord(completion) && Array.isArray(completion.results)) rows.push(...completion.results);
		}
	}
	return rows.filter(isRecord);
}

function childResults(entry) {
	if (!isRecord(entry)) return [];
	if (entry.type === "message" && isRecord(entry.message)) {
		const message = entry.message;
		if (message.role === "toolResult" && ["subagent", "bg_wait"].includes(message.toolName)) {
			return resultRows(message.details);
		}
	}
	if (entry.type === "custom_message" && isRecord(entry.details)) {
		const result = entry.details.result;
		if (isRecord(result) && isRecord(result.details)) return resultRows(result.details);
		return resultRows(entry.details);
	}
	return [];
}

export function aggregateRoleUsage(dirs) {
	const byRole = new Map();
	const seen = new Set();

	const addResult = (result, parentEntry) => {
		if (typeof result.agent !== "string" || !result.agent.trim()) return;
		const identity = typeof result.sessionFile === "string" && result.sessionFile
			? `session:${result.sessionFile}`
			: `${parentEntry.runId ?? parentEntry.asyncId ?? parentEntry.id ?? "unknown"}:${result.index ?? 0}:${result.agent}`;
		if (seen.has(identity)) return;
		seen.add(identity);

		let role = byRole.get(result.agent);
		if (!role) {
			role = {
				calls: 0,
				models: new Set(),
				modelNotReported: 0,
				input_tokens: 0,
				output_tokens: 0,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
				total_tokens: 0,
				cost_usd: 0,
			};
			byRole.set(result.agent, role);
		}
		role.calls += 1;
		if (typeof result.model === "string" && result.model.trim()) role.models.add(result.model.trim());
		else role.modelNotReported += 1;
		for (const [key, value] of Object.entries(usageValues(result.usage))) role[key] += value;
	};

	const readSession = (path) => {
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			for (const result of childResults(entry)) addResult(result, isRecord(entry.message?.details) ? entry.message.details : entry.details ?? {});
		}
	};

	const walk = (directory) => {
		if (!existsSync(directory)) return;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) readSession(path);
		}
	};
	for (const directory of dirs) walk(directory);

	return Object.fromEntries([...byRole].map(([name, role]) => {
		const { models, ...usage } = role;
		return [name, {
			...usage,
			models: [...models],
			cost_usd: Number(role.cost_usd.toFixed(4)),
		}];
	}));
}
