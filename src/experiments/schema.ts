export type Metric = { source: "stdout" | "json-file"; key: string; unit: string; direction: "min" | "max"; file?: string };
export type ContractInput = {
  slug: string; hypothesis: string; argv: string[]; cwd?: string; filesInScope: string[];
  inputFiles?: string[]; seeds?: number[]; metric: Metric; environment: string;
  maxIterations?: number; maxWallSeconds?: number; timeoutPerRun?: number;
  reviewPolicy?: "required" | "none";
};
export type EnvironmentFingerprint = {
  readonly version: 1; readonly platform: string; readonly architecture: string; readonly runtimeVersion: string;
  readonly executableHash: string; readonly inputFilesHash: string; readonly sha256: string;
};
export type TreeBinding = { treeSlug: string; nodeId: string; workspace: string };
export type Contract = {
  version: 1; experimentId: string; workspace: string; createdAt: string; slug: string;
  hypothesis: string; argv: string[]; cwd: string; filesInScope: string[]; inputFiles: string[];
  inputHashes: Record<string, string>; seeds: number[]; metric: Metric; environment: string;
  baselineCodeHash: string; ideaArtifacts: Artifact[]; executableHash: string; maxIterations: number; maxWallSeconds: number; timeoutPerRun: number;
  environmentFingerprint?: EnvironmentFingerprint;
  treeBinding?: TreeBinding;
  reviewPolicy?: "required" | "none";
};
export type SnapshotFile = { path: string; exists: boolean; sha256?: string; copy?: string };
export type Snapshot = { files: SnapshotFile[]; hash: string };
export type ActiveRun = {
  id: string; token: string; kind: "baseline" | "trial"; startedAt: number; workerPid: number;
  engineHash: string; workspaceRevision: string | null; childPid?: number; childLaunchPending?: boolean; seedIndex?: number; snapshot: Snapshot; inputHashes: Record<string, string>;
};
export type ReceiptRef = { id: string; hash: string; kind: "baseline" | "trial"; valid: boolean; value: number | null; decision?: "keep" | "revert" | "failed"; reason?: string };
export type State = {
  version: 1; contractHash: string; state: "planned" | "ready" | "running" | "pause_requested" | "paused" | "blocked" | "completed";
  updatedAt: string; approval?: { contractHash: string; at: string };
  trialAttempts: number; baselineAttempts: number; spentMs: number; receipts: ReceiptRef[];
  baselineId?: string; bestId?: string; active?: ActiveRun; message?: string;
  outcome?: "positive" | "negative" | "baseline_only" | "budget_exhausted" | "failed";
  reviews?: ReviewRef[]; reviewAttempts?: Partial<Record<ReviewKind, number>>; activeReview?: ReviewOwner;
};
export type ReviewKind = "plan" | "audit";
export type ReviewOwner = { id: string; token: string; kind: ReviewKind; bundleHash: string; bundlePath: string; ownerPid: number; startedAt: number };
export type ReviewRef = { id: string; kind: ReviewKind; bundleHash: string; hash: string; verdict: "pass" | "blocked" | "error" };
export type ReviewFinding = { severity: "fatal" | "major" | "minor"; evidence: string; message: string };
export type ReviewVerdict = { version: 1; bundleHash: string; verdict: "pass" | "blocked"; summary: string; findings: ReviewFinding[] };
export type ReviewRecord = {
  version: 1; id: string; kind: ReviewKind; contractHash: string; bundleHash: string; bundlePath: string;
  verdict: "pass" | "blocked" | "error"; summary: string; findings: ReviewFinding[];
  startedAt: string; endedAt: string; reviewer: { role: "critic" | "auditor"; provider: string; model: string; promptHash: string; sessionPath?: string } | null;
  usage?: import("@earendil-works/pi-ai").Usage;
};
export type Artifact = { path: string; sha256: string };
export type SeedResult = { seed: number; argv: string[]; exitCode: number | null; signal: string | null; value: number | null; error?: string; artifacts: Artifact[] };
export type Receipt = {
  version: 1; id: string; kind: "baseline" | "trial"; contractHash: string;
  startedAt: string; endedAt: string; elapsedMs: number; timeAccounting: "observed" | "conservative"; valid: boolean; value: number | null;
  reason?: string; snapshot: Snapshot; endCodeHash: string; inputHashes: Record<string, string>;
  engineHash: string; workspaceRevision: string | null; environment: string; executableHash: string;
  environmentFingerprint?: string; seeds: SeedResult[]; interrupted: boolean;
};
export function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export function slug(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/.test(value) || value.length > 80) throw new Error("Use a lowercase slug with at most five hyphen-separated words.");
  return value;
}
function limit(value: unknown, fallback: number, max: number, name: string): number {
  const number = value ?? fallback;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > max) throw new Error(`${name} must be an integer in 1..${max}.`);
  return number;
}
export function validateInput(value: unknown): ContractInput & { seeds: number[]; inputFiles: string[]; maxIterations: number; maxWallSeconds: number; timeoutPerRun: number } {
  if (!record(value)) throw new Error("Experiment contract must be an object.");
  const allowed = new Set(["slug", "hypothesis", "argv", "cwd", "filesInScope", "inputFiles", "seeds", "metric", "environment", "maxIterations", "maxWallSeconds", "timeoutPerRun", "reviewPolicy"]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error("Unknown experiment contract field.");
  slug(value.slug);
  if (value.reviewPolicy !== undefined && !["required", "none"].includes(String(value.reviewPolicy))) throw new Error("reviewPolicy must be required or none.");
  for (const key of ["hypothesis", "environment"] as const) if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > 20000) throw new Error(`${key} is required.`);
  if (!Array.isArray(value.argv) || !value.argv.length || value.argv.length > 100 || value.argv.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("argv must contain 1..100 strings.");
  if (value.cwd !== undefined && typeof value.cwd !== "string") throw new Error("cwd must be workspace-relative.");
  for (const key of ["filesInScope", "inputFiles"] as const) {
    const paths = value[key] ?? [];
    if (!Array.isArray(paths) || paths.length > 500 || paths.some(p => typeof p !== "string" || !p) || new Set(paths).size !== paths.length) throw new Error(`${key} must contain unique file paths.`);
    if (key === "filesInScope" && !paths.length) throw new Error("filesInScope must name the files the experiment may edit.");
  }
  const seeds = value.seeds ?? [0];
  if (!Array.isArray(seeds) || !seeds.length || seeds.length > 32 || seeds.some(seed => !Number.isSafeInteger(seed)) || new Set(seeds).size !== seeds.length) throw new Error("seeds must contain 1..32 unique integers.");
  if (!record(value.metric) || !["stdout", "json-file"].includes(String(value.metric.source)) || !["min", "max"].includes(String(value.metric.direction))) throw new Error("Define metric source and min/max direction.");
  if (typeof value.metric.key !== "string" || !/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)*$/.test(value.metric.key) || value.metric.key.split(".").some(k => ["constructor", "prototype", "__proto__"].includes(k))) throw new Error("Metric key must be a safe JSON property path.");
  if (typeof value.metric.unit !== "string" || !value.metric.unit.trim()) throw new Error("Metric unit is required.");
  if (value.metric.source === "json-file" && (typeof value.metric.file !== "string" || !value.metric.file)) throw new Error("JSON-file metric needs a relative file inside each fresh seed run directory.");
  const maxIterations = limit(value.maxIterations, 20, 100, "maxIterations");
  const maxWallSeconds = limit(value.maxWallSeconds, 3600, 604800, "maxWallSeconds");
  const timeoutPerRun = limit(value.timeoutPerRun, Math.min(600, maxWallSeconds), maxWallSeconds, "timeoutPerRun");
  return { ...(value as unknown as ContractInput), reviewPolicy: value.reviewPolicy as ContractInput["reviewPolicy"] ?? "required", seeds, inputFiles: (value.inputFiles ?? []) as string[], maxIterations, maxWallSeconds, timeoutPerRun };
}
