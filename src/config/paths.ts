import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Like Pi's own agent-dir variable: a leading ~ in HYPATIA_HOME (unexpanded in
// .env files, Docker ENV, or Windows shells) means the home folder.
export function expandHomePath(path: string, home = homedir()): string {
	if (path === "~") return home;
	return /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path;
}

export function getHypatiaHome(): string {
	return resolve(expandHomePath(process.env.HYPATIA_HOME ?? homedir()), ".hypatia");
}

export function getHypatiaAgentDir(home = getHypatiaHome()): string {
	return resolve(home, "agent");
}

export function getHypatiaMemoryDir(home = getHypatiaHome()): string {
	return resolve(home, "memory");
}

export function getHypatiaStateDir(home = getHypatiaHome()): string {
	return resolve(home, ".state");
}

export function getDefaultSessionDir(home = getHypatiaHome()): string {
	return resolve(home, "sessions");
}

export function getBootstrapStatePath(home = getHypatiaHome()): string {
	return resolve(getHypatiaStateDir(home), "bootstrap.json");
}

export function ensureHypatiaHome(home = getHypatiaHome()): void {
	for (const dir of [
		home,
		getHypatiaAgentDir(home),
		getHypatiaMemoryDir(home),
		getHypatiaStateDir(home),
		getDefaultSessionDir(home),
	]) {
		mkdirSync(dir, { recursive: true });
	}
}
