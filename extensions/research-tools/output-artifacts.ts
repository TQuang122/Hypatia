import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";

export const OUTPUT_GROUPS = ["Reports", "Provenance", "Drafts", "Other artifacts"] as const;
export type OutputGroup = typeof OUTPUT_GROUPS[number];
export type OutputArtifact = {
	path: string; fullPath: string; title: string; group: OutputGroup;
	size: number; modifiedAt: number; extension: string;
};
export type OutputPreview = { artifact: OutputArtifact; content: string; markdown: boolean };
export const MAX_OUTPUT_PREVIEW_BYTES = 2 * 1024 * 1024;

const DIRECTORIES = ["papers", "outputs", "experiments", "notes"];
const EXTENSIONS = new Set([".md", ".tex", ".pdf", ".py", ".csv", ".json", ".html", ".txt", ".log"]);
const TEXT_EXTENSIONS = new Set([...EXTENSIONS].filter((extension) => extension !== ".pdf"));

export function oneLine(value: string): string {
	return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

function groupFor(path: string): OutputGroup {
	const parts = path.split(sep);
	if (path.toLowerCase().endsWith(".provenance.md")) return "Provenance";
	if (parts.some((part) => part === ".drafts" || part === "drafts") || /-draft\.[^.]+$/i.test(path)) return "Drafts";
	if (["outputs", "papers"].includes(parts[0]) && !parts.some((part) => part.startsWith(".")) && [".md", ".pdf", ".tex", ".html", ".txt"].includes(extname(path).toLowerCase())) return "Reports";
	return "Other artifacts";
}

export function isReportOutputPath(path: string): boolean { return groupFor(path) === "Reports"; }

export async function collectOutputArtifacts(cwd: string): Promise<OutputArtifact[]> {
	const root = resolve(cwd);
	const items: OutputArtifact[] = [];
	const walk = async (directory: string): Promise<void> => {
		let entries;
		try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const fullPath = join(directory, entry.name);
			if (entry.isDirectory() && ![".git", "node_modules"].includes(entry.name)) { await walk(fullPath); continue; }
			const extension = extname(entry.name).toLowerCase();
			if (!entry.isFile() || !EXTENSIONS.has(extension)) continue;
			const info = await lstat(fullPath).catch(() => undefined);
			if (!info?.isFile()) continue;
			let title = "";
			if (extension === ".md") {
				// Read only a short heading prefix; never load PDFs/large data files for the menu.
				let handle;
				try {
					handle = await open(fullPath, "r");
					const buffer = Buffer.alloc(4096);
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
					title = oneLine(buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, "").match(/^#\s+(.+)$/m)?.[1] ?? "").slice(0, 160);
				} catch {} finally { await handle?.close(); }
			}
			const path = relative(root, fullPath);
			items.push({ path, fullPath, title, extension, group: groupFor(path), size: info.size, modifiedAt: info.mtimeMs });
		}
	};
	for (const directory of DIRECTORIES) {
		const path = join(root, directory);
		if ((await lstat(path).catch(() => undefined))?.isDirectory()) await walk(path);
	}
	return items.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
}

export function canPreviewOutput(artifact: OutputArtifact): boolean { return TEXT_EXTENSIONS.has(artifact.extension); }

export function relatedOutput(artifact: OutputArtifact, items: readonly OutputArtifact[]): OutputArtifact | undefined {
	if (artifact.extension !== ".md" && artifact.group !== "Reports" && artifact.group !== "Drafts") return undefined;
	const directory = dirname(artifact.path);
	if (artifact.path.toLowerCase().endsWith(".provenance.md")) {
		const stem = basename(artifact.path).slice(0, -".provenance.md".length);
		for (const extension of [".md", ".tex", ".pdf", ".html", ".txt"]) {
			const match = items.find((item) => dirname(item.path) === directory && item.extension === extension && basename(item.path).slice(0, -extension.length) === stem);
			if (match) return match;
		}
		return undefined;
	}
	const stem = basename(artifact.path).slice(0, -artifact.extension.length);
	return items.find((item) => dirname(item.path) === directory && item.path.toLowerCase().endsWith(".provenance.md") && basename(item.path).slice(0, -".provenance.md".length) === stem);
}

export function outputLabel(artifact: OutputArtifact, index: number): string {
	const size = artifact.size < 1024 ? `${artifact.size}B` : artifact.size < 1024 * 1024 ? `${Math.round(artifact.size / 1024)}KB` : `${(artifact.size / (1024 * 1024)).toFixed(1)}MB`;
	return `${index + 1}. ${oneLine(artifact.path)}${artifact.title ? ` — ${artifact.title}` : ""} (${size})`;
}

export async function readOutputPreview(cwd: string, artifact: OutputArtifact): Promise<OutputPreview> {
	if (!canPreviewOutput(artifact)) throw new Error("This file type has no text preview. Copy its path to open it in an editor or use Read in chat.");
	const root = await realpath(cwd);
	const path = await realpath(artifact.fullPath);
	const rel = relative(root, path);
	if (rel.startsWith(`..${sep}`) || rel === ".." || !DIRECTORIES.includes(rel.split(sep)[0])) throw new Error("Artifact is outside this workspace's research folders.");
	if (!(await lstat(artifact.fullPath)).isFile()) throw new Error("Artifact is no longer a regular file.");
	const handle = await open(path, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("Artifact is no longer a regular file.");
		if (info.size > MAX_OUTPUT_PREVIEW_BYTES) throw new Error("TUI preview is limited to 2 MiB. Copy the path to open the complete file in an editor.");
		const buffer = Buffer.alloc(MAX_OUTPUT_PREVIEW_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_OUTPUT_PREVIEW_BYTES) throw new Error("File grew beyond the 2 MiB preview limit. Copy the path to open the complete file.");
		const content = stripVTControlCharacters(buffer.subarray(0, length).toString("utf8")).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, " ");
		return { artifact, content, markdown: artifact.extension === ".md" };
	} finally { await handle.close(); }
}
