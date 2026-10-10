import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ResumableRun = { slug: string; pending: number; blocked: number };

// A plan is resumable when its ledger still has pending or blocked tasks and
// no final output exists yet. The ledger convention comes from the
// deepresearch prompt: tasks marked pending, done, blocked, or superseded.
export function findResumableRuns(workingDir: string): ResumableRun[] {
	const plansDir = resolve(workingDir, "outputs", ".plans");
	let files: string[];
	try {
		files = readdirSync(plansDir).filter((name) => name.endsWith(".md") && !name.endsWith("-workflow.js"));
	} catch {
		return [];
	}
	const runs: ResumableRun[] = [];
	for (const file of files) {
		const slug = file.replace(/\.md$/, "");
		if (existsSync(join(workingDir, "outputs", `${slug}.md`)) || existsSync(join(workingDir, "papers", `${slug}.md`))) {
			continue;
		}
		let ledger: string;
		try {
			ledger = readFileSync(join(plansDir, file), "utf8");
		} catch {
			continue;
		}
		const lines = ledger.split("\n");
		const isTask = (line: string) => /pending|blocked|done|superseded/i.test(line) && line.length < 300;
		const tasks = lines.filter(isTask);
		if (tasks.length === 0) continue;
		const pending = tasks.filter((line) => /pending/i.test(line)).length;
		const blocked = tasks.filter((line) => /blocked/i.test(line)).length;
		runs.push({ slug, pending, blocked });
	}
	return runs;
}

// Surfaces interrupted runs once per session, before the first agent turn, so
// a resumed session continues the plan instead of starting over.
export function registerResumeNudge(pi: ExtensionAPI): void {
	let pendingRuns: ResumableRun[] = [];
	let announced = false;
	pi.on("session_start", () => {
		announced = false;
		pendingRuns = [];
		return undefined;
	});
	pi.on("before_agent_start", (_event, ctx) => {
		if (announced) return undefined;
		announced = true;
		const cwd = typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
		pendingRuns = findResumableRuns(cwd);
		if (pendingRuns.length === 0) return undefined;
		const lines = pendingRuns.map((run) => `- ${run.slug} (${run.pending} pending, ${run.blocked} blocked) — resume with: continue outputs/.plans/${run.slug}.md from its first incomplete task`);
		return {
			message: {
				customType: "hypatia-resume-nudge",
				content: `Interrupted research runs found in this workspace. Ask the user whether to resume one before starting new work:\n${lines.join("\n")}`,
				display: true as boolean,
			},
		};
	});
}
