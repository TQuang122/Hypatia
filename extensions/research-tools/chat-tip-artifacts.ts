import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { isReportOutputPath } from "./output-artifacts.js";

export type ReportSnapshot = { complete: boolean; revisions: Map<string, string> };

/** Observe report metadata only; skip drafts, provenance, hidden paths and links. */
export async function snapshotTipReports(cwd: string): Promise<ReportSnapshot> {
	const snapshot: ReportSnapshot = { complete: true, revisions: new Map() };
	const root = await realpath(cwd).catch(() => undefined);
	if (!root) return { ...snapshot, complete: false };
	const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
	const walk = async (directory: string): Promise<void> => {
		try {
			if (!(await lstat(directory)).isDirectory()) return;
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
				const path = join(directory, entry.name);
				if (entry.isDirectory()) { await walk(path); continue; }
				const key = relative(root, path);
				if (!entry.isFile() || !isReportOutputPath(key)) continue;
				try {
					const info = await lstat(path);
					if (info.isFile()) snapshot.revisions.set(key, `${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
				} catch (error) { if (!missing(error)) snapshot.complete = false; }
			}
		} catch (error) { if (!missing(error)) snapshot.complete = false; }
	};
	await walk(join(root, "outputs"));
	await walk(join(root, "papers"));
	return snapshot;
}
