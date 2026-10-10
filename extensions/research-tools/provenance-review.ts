import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

export type ProvenanceVerification = "PASS" | "PASS WITH NOTES" | "BLOCKED" | "UNKNOWN";

export type ProvenanceRecord = {
	readonly path: string;
	readonly title: string;
	readonly verification: ProvenanceVerification;
	readonly date?: string;
	readonly rounds?: string;
	readonly sourcesConsulted?: string;
	readonly sourcesAccepted?: string;
	readonly sourcesRejected?: string;
};

export type ProvenanceField =
	| "Date"
	| "Rounds"
	| "Sources consulted"
	| "Sources accepted"
	| "Sources rejected"
	| "Verification";

export type ProvenanceDifference = {
	readonly field: ProvenanceField;
	readonly before: string | undefined;
	readonly after: string | undefined;
};

type ProvenanceFile = {
	readonly path: string;
	readonly fullPath: string;
	readonly modifiedAt: number;
};

const PROVENANCE_DIRECTORIES = ["outputs", "papers"] as const;
const PROVENANCE_SUFFIX = ".provenance.md";
const MAX_PROVENANCE_FILES = 200;
const MAX_PROVENANCE_FILE_BYTES = 128 * 1024;

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sanitizeProvenanceText(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ");
}

function provenanceField(content: string, label: string): string | undefined {
	const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const expression = new RegExp(`^[ \\t]*(?:-[ \\t]*)?\\*\\*${escapedLabel}:\\*\\*[ \\t]*([^\\r\\n]*?)[ \\t]*$`, "im");
	const value = content.match(expression)?.[1]?.trim();
	return value || undefined;
}

function parseVerification(value: string | undefined): ProvenanceVerification {
	const normalized = value?.trim().toUpperCase() ?? "";
	if (/^PASS WITH NOTES(?:\b|$)/.test(normalized)) return "PASS WITH NOTES";
	if (/^PASS(?:\b|$)/.test(normalized)) return "PASS";
	if (/^BLOCKED(?:\b|$)/.test(normalized)) return "BLOCKED";
	return "UNKNOWN";
}

export function parseProvenanceSidecar(path: string, source: string): ProvenanceRecord {
	const content = sanitizeProvenanceText(source);
	const safePath = sanitizeProvenanceText(path).replace(/\s+/g, " ").trim();
	const title = content.match(/^#\s+Provenance:\s*(.+?)\s*$/im)?.[1]?.trim()
		?? content.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim()
		?? basename(safePath).replace(/\.provenance\.md$/i, "");

	return {
		path: safePath,
		title,
		verification: parseVerification(provenanceField(content, "Verification")),
		date: provenanceField(content, "Date"),
		rounds: provenanceField(content, "Rounds"),
		sourcesConsulted: provenanceField(content, "Sources consulted"),
		sourcesAccepted: provenanceField(content, "Sources accepted"),
		sourcesRejected: provenanceField(content, "Sources rejected"),
	};
}

export function compareProvenanceRecords(before: ProvenanceRecord, after: ProvenanceRecord): readonly ProvenanceDifference[] {
	const fields: readonly ProvenanceDifference[] = [
		{ field: "Date", before: before.date, after: after.date },
		{ field: "Rounds", before: before.rounds, after: after.rounds },
		{ field: "Sources consulted", before: before.sourcesConsulted, after: after.sourcesConsulted },
		{ field: "Sources accepted", before: before.sourcesAccepted, after: after.sourcesAccepted },
		{ field: "Sources rejected", before: before.sourcesRejected, after: after.sourcesRejected },
		{ field: "Verification", before: before.verification, after: after.verification },
	];
	return fields.filter((entry) => entry.before !== entry.after);
}

export async function discoverProvenanceRecords(cwd: string): Promise<readonly ProvenanceRecord[]> {
	const root = resolve(cwd);
	const candidates: ProvenanceFile[] = [];

	for (const directory of PROVENANCE_DIRECTORIES) {
		const directoryPath = join(root, directory);
		let directoryInfo;
		try {
			directoryInfo = await lstat(directoryPath);
		} catch (error) {
			if (isNotFoundError(error)) continue;
			throw error;
		}
		if (!directoryInfo.isDirectory()) continue;

		let entries;
		try {
			entries = await readdir(directoryPath, { withFileTypes: true });
		} catch (error) {
			if (isNotFoundError(error)) continue;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(PROVENANCE_SUFFIX)) continue;
			const fullPath = join(directoryPath, entry.name);
			let info;
			try {
				info = await lstat(fullPath);
			} catch (error) {
				if (isNotFoundError(error)) continue;
				throw error;
			}
			if (!info.isFile() || info.size > MAX_PROVENANCE_FILE_BYTES) continue;
			candidates.push({
				path: relative(root, fullPath),
				fullPath,
				modifiedAt: info.mtimeMs,
			});
		}
	}

	candidates.sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path));
	const records: ProvenanceRecord[] = [];
	for (const candidate of candidates.slice(0, MAX_PROVENANCE_FILES)) {
		let content: string;
		try {
			content = await readFile(candidate.fullPath, "utf8");
		} catch (error) {
			if (isNotFoundError(error)) continue;
			throw error;
		}
		records.push(parseProvenanceSidecar(candidate.path, content));
	}
	return records;
}
