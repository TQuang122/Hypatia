import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function expandHomePath(path, homeDirectory) {
	if (path === "~") return homeDirectory;
	if (/^~[\\/]/.test(path)) return join(homeDirectory, path.slice(2));
	return path;
}

export function resolveModelRoutesSource({
	explicitPath,
	disabled = false,
	hypatiaHome = process.env.HYPATIA_HOME,
	homeDirectory = homedir(),
} = {}) {
	if (disabled && explicitPath !== undefined) {
		throw new Error("--model-routes-json cannot be combined with --no-model-routes.");
	}
	if (disabled) return { source: "disabled" };
	if (explicitPath !== undefined) {
		if (typeof explicitPath !== "string" || !explicitPath.trim()) {
			throw new Error("--model-routes-json must be a non-empty path.");
		}
		return { source: "explicit", path: resolve(expandHomePath(explicitPath.trim(), homeDirectory)) };
	}

	const parent = resolve(expandHomePath(hypatiaHome ?? homeDirectory, homeDirectory));
	const path = join(parent, ".hypatia", "agent", "model-routes.json");
	return existsSync(path) ? { source: "user-default", path } : { source: "none" };
}

export function loadModelRoutesFile(source) {
	if (!source.path) return { source: source.source, config: null, contents: null };
	let contents;
	try {
		contents = readFileSync(source.path, "utf8");
	} catch (error) {
		throw new Error(`Cannot read model routes at ${source.path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let config;
	try {
		config = JSON.parse(contents);
	} catch (error) {
		throw new Error(`Invalid model routes at ${source.path}: ${error instanceof Error ? error.message : "expected valid JSON"}`);
	}
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error(`Invalid model routes at ${source.path}: expected a JSON object.`);
	}
	return { source: source.source, config, contents };
}

export function copyModelRoutesToAgentDir(modelRoutes, agentDir) {
	if (!modelRoutes.contents) return undefined;
	mkdirSync(agentDir, { recursive: true });
	const target = join(agentDir, "model-routes.json");
	writeFileSync(target, modelRoutes.contents, { encoding: "utf8", mode: 0o600 });
	return target;
}
