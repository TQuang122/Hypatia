export interface ModelRoutesFile {
	source: "explicit" | "user-default" | "none" | "disabled";
	config: Record<string, unknown> | null;
	contents: string | null;
}

export function resolveModelRoutesSource(options?: {
	explicitPath?: string;
	disabled?: boolean;
	hypatiaHome?: string;
	homeDirectory?: string;
}): { source: "explicit" | "user-default"; path: string } | { source: "none" | "disabled" };
export function loadModelRoutesFile(source: { source: string; path?: string }): ModelRoutesFile;
export function copyModelRoutesToAgentDir(modelRoutes: ModelRoutesFile, agentDir: string): string | undefined;
