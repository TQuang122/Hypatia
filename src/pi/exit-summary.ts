import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Codex-style exit summary printed by the Hypatia CLI after the Pi child
// exits. Pi prints its own resume hint; this block adds cwd, git branch,
// elapsed time, and a `hypatia` reconnect command. All helpers are
// best-effort and never throw.

export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export function shortenCwd(dir: string, home: string = homedir()): string {
	if (dir === home) return "~";
	return dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}

// Pi session files are `<timestamp>_<sessionId>.jsonl`; the timestamp never
// contains an underscore, so the id is everything after the first one.
export function extractSessionId(fileName: string): string | undefined {
	if (!fileName.endsWith(".jsonl")) return undefined;
	const base = fileName.slice(0, -".jsonl".length);
	const separator = base.indexOf("_");
	if (separator <= 0 || separator === base.length - 1) return undefined;
	return base.slice(separator + 1);
}

export function findRecentSessionId(sessionDir: string, sinceMs: number): string | undefined {
	let files: string[];
	try {
		files = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return undefined;
	}
	let best: { id: string; mtimeMs: number } | undefined;
	for (const file of files) {
		const id = extractSessionId(file);
		if (!id) continue;
		let mtimeMs: number;
		try {
			mtimeMs = statSync(join(sessionDir, file)).mtimeMs;
		} catch {
			continue;
		}
		if (mtimeMs < sinceMs) continue;
		if (!best || mtimeMs > best.mtimeMs) best = { id, mtimeMs };
	}
	return best?.id;
}

function explicitSessionId(piArgs: readonly string[]): string | undefined {
	const index = piArgs.indexOf("--session");
	if (index === -1) return undefined;
	const value = piArgs[index + 1];
	return value && !value.startsWith("-") ? value : undefined;
}

export function resolveReconnectCommand(
	piArgs: readonly string[],
	sessionDir: string,
	startedAtMs: number,
): string | undefined {
	if (piArgs.includes("--no-session")) return undefined;
	const explicit = explicitSessionId(piArgs);
	if (explicit) return `hypatia --session ${explicit}`;
	const recent = findRecentSessionId(sessionDir, startedAtMs - 30_000);
	if (recent) return `hypatia --session ${recent}`;
	return "hypatia -c";
}

export function getGitInfo(workingDir: string): { branch: string; dirty: boolean } | undefined {
	const options = { encoding: "utf8" as const, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] as never };
	let branch: string;
	try {
		branch = execFileSync("git", ["-C", workingDir, "rev-parse", "--abbrev-ref", "HEAD"], options).trim();
	} catch {
		return undefined;
	}
	if (!branch) return undefined;
	let dirty = false;
	try {
		dirty = execFileSync("git", ["-C", workingDir, "status", "--porcelain=v1"], options).trim().length > 0;
	} catch {
		dirty = false;
	}
	return { branch, dirty };
}

export function buildExitSummary(input: {
	workingDir: string;
	elapsedMs: number;
	reconnect: string | undefined;
	git?: { branch: string; dirty: boolean };
	home?: string;
}): string {
	const head = [shortenCwd(input.workingDir, input.home ?? homedir())];
	if (input.git) head.push(`${input.git.branch}${input.git.dirty ? "*" : ""}`);
	head.push(formatElapsed(input.elapsedMs));
	const lines = [head.join("  "), "❯ hypatia", "Session ended. Work is saved."];
	if (input.reconnect) lines.push("To reconnect, run:", `  ${input.reconnect}`);
	return `${lines.join("\n")}\n`;
}

export function shouldPrintExitSummary(input: {
	exitCode: number;
	mode: string | undefined;
	oneShotPrompt: string | undefined;
	isTTY: boolean;
}): boolean {
	if (!input.isTTY || input.exitCode !== 0) return false;
	if (input.mode === "rpc" || input.mode === "json") return false;
	if (input.oneShotPrompt) return false;
	return true;
}

export function printExitSummary(input: {
	workingDir: string;
	sessionDir: string;
	piArgs: readonly string[];
	startedAtMs: number;
}): void {
	try {
		const reconnect = resolveReconnectCommand(input.piArgs, input.sessionDir, input.startedAtMs);
		const text = buildExitSummary({
			workingDir: input.workingDir,
			elapsedMs: Date.now() - input.startedAtMs,
			reconnect,
			git: getGitInfo(input.workingDir),
		});
		process.stdout.write(`${text}`);
	} catch {
		// Exit summaries must never fail a shutdown.
	}
}
