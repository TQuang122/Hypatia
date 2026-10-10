import { objectHash, relativePath } from "./files.js";
import { record, slug, validateInput, type ContractInput } from "./schema.js";

export type TreeBudget = {
  maxTotalTrials: number;
  maxTotalWallSeconds: number;
  maxParallelRuns: number;
};
export type NormalizedTreeInput = {
  slug: string;
  contract: ReturnType<typeof validateInput>;
  budget: TreeBudget;
};
export type TreeInput = Omit<ContractInput, "maxIterations" | "maxWallSeconds"> & {
  maxTotalTrials?: number;
  maxTotalWallSeconds?: number;
  maxParallelRuns?: number;
};
export type TreeDefinition = {
  version: 1;
  slug: string;
  workspace: string;
  baseCommit: string;
  createdAt: string;
  protocol: ReturnType<typeof validateInput>;
  budget: TreeBudget;
  inputHashes: Record<string, string>;
};
export type TreeNode = {
  id: string;
  status: "creating" | "planned";
  creationPid?: number;
  parentNodeId: string | null;
  parentReceiptId: string | null;
  sourceSnapshotHash?: string;
  contractHash?: string;
  worktree: string;
  experimentSlug: string;
  createdAt: string;
};
export type TreeRunReservation = {
  id: string;
  nodeId: string;
  kind: "baseline" | "trial";
  startedAt: number;
  reservedMs: number;
  trialAttemptsBefore: number;
  baselineAttemptsBefore: number;
};
export type TreeState = {
  version: 1;
  definitionHash: string;
  state: "planned" | "ready" | "running" | "pause_requested" | "paused" | "blocked" | "completed";
  updatedAt: string;
  nodes: TreeNode[];
  winnerNodeId?: string;
  trialAttempts: number;
  baselineAttempts: number;
  spentMs: number;
  activeRuns: TreeRunReservation[];
  message?: string;
};
export type ExperimentTree = { root: string; definition: TreeDefinition; state: TreeState };

const MAX_TREE_NODES = 100;
const SHA256 = /^[a-f0-9]{64}$/;
const STATES = new Set(["planned", "ready", "running", "pause_requested", "paused", "blocked", "completed"]);

function integer(value: unknown, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new Error(`${name} must be an integer in 1..${maximum}.`);
  }
  return result;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Unknown ${name} field.`);
}

export function validateTreeInput(value: unknown): NormalizedTreeInput {
  if (!record(value)) throw new Error("Experiment tree input must be an object.");
  const allowed = [
    "slug", "hypothesis", "argv", "cwd", "filesInScope", "inputFiles", "seeds", "metric", "environment",
    "timeoutPerRun", "reviewPolicy", "maxTotalTrials", "maxTotalWallSeconds", "maxParallelRuns",
  ];
  exactKeys(value, allowed, "experiment tree");
  const treeSlug = slug(value.slug);
  const budget: TreeBudget = {
    maxTotalTrials: integer(value.maxTotalTrials, 20, 100, "maxTotalTrials"),
    maxTotalWallSeconds: integer(value.maxTotalWallSeconds, 3600, 604800, "maxTotalWallSeconds"),
    maxParallelRuns: integer(value.maxParallelRuns, 1, 16, "maxParallelRuns"),
  };
  const contract = validateInput({
    slug: treeSlug,
    hypothesis: value.hypothesis,
    argv: value.argv,
    cwd: value.cwd,
    filesInScope: value.filesInScope,
    inputFiles: value.inputFiles,
    seeds: value.seeds,
    metric: value.metric,
    environment: value.environment,
    timeoutPerRun: value.timeoutPerRun,
    reviewPolicy: value.reviewPolicy,
    maxIterations: budget.maxTotalTrials,
    maxWallSeconds: budget.maxTotalWallSeconds,
  });
  const frozen = new Set(contract.inputFiles);
  if (contract.filesInScope.some(path => frozen.has(path))) throw new Error("Tree editable source and frozen input paths must be disjoint.");
  for (const path of [...contract.filesInScope, ...contract.inputFiles]) {
    if (path === "experiments/.trees" || path.startsWith("experiments/.trees/")) {
      throw new Error("Experiment tree state and worktrees cannot be benchmark inputs or editable source.");
    }
    if (path === `experiments/${treeSlug}` || path.startsWith(`experiments/${treeSlug}/`)) {
      throw new Error("Experiment tree state cannot be benchmark input or editable source.");
    }
  }
  if (
    contract.cwd === "experiments/.trees" || contract.cwd?.startsWith("experiments/.trees/")
    || contract.cwd === `experiments/${treeSlug}` || contract.cwd?.startsWith(`experiments/${treeSlug}/`)
  ) {
    throw new Error("Benchmark cwd cannot be inside experiment tree state.");
  }
  return { slug: treeSlug, contract, budget };
}

export function validateTreeDefinition(value: unknown): TreeDefinition {
  if (!record(value)) throw new Error("Experiment tree definition must be an object.");
  exactKeys(value, ["version", "slug", "workspace", "baseCommit", "createdAt", "protocol", "budget", "inputHashes"], "tree definition");
  if (value.version !== 1) throw new Error("Unsupported experiment tree definition version.");
  const treeSlug = slug(value.slug);
  if (typeof value.workspace !== "string" || !value.workspace || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("Experiment tree workspace and creation time are required.");
  }
  if (typeof value.baseCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseCommit)) {
    throw new Error("Experiment tree base commit must be a full Git object ID.");
  }
  if (!record(value.budget)) throw new Error("Experiment tree budget must be an object.");
  const budget: TreeBudget = {
    maxTotalTrials: integer(value.budget.maxTotalTrials, 0, 100, "maxTotalTrials"),
    maxTotalWallSeconds: integer(value.budget.maxTotalWallSeconds, 0, 604800, "maxTotalWallSeconds"),
    maxParallelRuns: integer(value.budget.maxParallelRuns, 0, 16, "maxParallelRuns"),
  };
  const protocol = validateInput(value.protocol);
  if (protocol.slug !== treeSlug || protocol.maxIterations !== budget.maxTotalTrials || protocol.maxWallSeconds !== budget.maxTotalWallSeconds) {
    throw new Error("Tree protocol limits must match the shared tree budget.");
  }
  if (!record(value.inputHashes)) throw new Error("Tree input hashes must be an object.");
  const inputHashes: Record<string, string> = {};
  for (const path of protocol.inputFiles) {
    const digest = value.inputHashes[path];
    if (typeof digest !== "string" || !SHA256.test(digest)) throw new Error(`Missing or invalid frozen input hash: ${path}`);
    inputHashes[path] = digest;
  }
  if (Object.keys(value.inputHashes).length !== protocol.inputFiles.length) throw new Error("Tree input hashes do not match declared frozen inputs.");
  return {
    version: 1, slug: treeSlug, workspace: value.workspace, baseCommit: value.baseCommit,
    createdAt: value.createdAt, protocol, budget, inputHashes,
  };
}

export function createInitialTreeState(definition: TreeDefinition): TreeState {
  return {
    version: 1, definitionHash: objectHash(definition), state: "planned", updatedAt: definition.createdAt,
    nodes: [], trialAttempts: 0, baselineAttempts: 0, spentMs: 0, activeRuns: [],
  };
}

export function createInitialTreeStateWithRoot(definition: TreeDefinition, creationPid: number): TreeState {
  const state = createInitialTreeState(definition);
  state.nodes.push({
    id: "root", status: "creating", creationPid, parentNodeId: null, parentReceiptId: null,
    worktree: `experiments/.trees/${definition.slug}/nodes/root`, experimentSlug: definition.slug,
    createdAt: definition.createdAt,
  });
  return state;
}

export function validateTreeState(value: unknown, definition: TreeDefinition): TreeState {
  if (!record(value)) throw new Error("Experiment tree state must be an object.");
  exactKeys(value, [
    "version", "definitionHash", "state", "updatedAt", "nodes", "winnerNodeId",
    "trialAttempts", "baselineAttempts", "spentMs", "activeRuns", "message",
  ], "tree state");
  if (value.version !== 1 || value.definitionHash !== objectHash(definition) || typeof value.state !== "string" || !STATES.has(value.state)) {
    throw new Error("Experiment tree state/definition integrity check failed.");
  }
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error("Invalid experiment tree state timestamp.");
  if (!Array.isArray(value.nodes) || value.nodes.length > MAX_TREE_NODES) throw new Error(`Experiment trees support at most ${MAX_TREE_NODES} nodes.`);
  const nodes: TreeNode[] = [];
  const seen = new Set<string>();
  for (const item of value.nodes) {
    if (!record(item)) throw new Error("Invalid experiment tree node.");
    exactKeys(item, ["id", "status", "creationPid", "parentNodeId", "parentReceiptId", "sourceSnapshotHash", "contractHash", "worktree", "experimentSlug", "createdAt"], "tree node");
    const id = slug(item.id);
    if (seen.has(id)) throw new Error("Experiment tree node IDs must be unique.");
    seen.add(id);
    if (item.status !== "creating" && item.status !== "planned") throw new Error("Invalid experiment tree node status.");
    const creationPid = item.creationPid;
    if (creationPid !== undefined && (
      item.status !== "creating" || typeof creationPid !== "number" || !Number.isSafeInteger(creationPid) || creationPid < 1
    )) throw new Error("Invalid experiment tree node creation owner.");
    if (typeof item.parentNodeId !== "string" && item.parentNodeId !== null) throw new Error("Invalid experiment tree parent node ID.");
    if (typeof item.parentReceiptId !== "string" && item.parentReceiptId !== null) throw new Error("Invalid experiment tree parent receipt ID.");
    if (item.sourceSnapshotHash !== undefined && (typeof item.sourceSnapshotHash !== "string" || !SHA256.test(item.sourceSnapshotHash))) {
      throw new Error("Invalid experiment tree source snapshot hash.");
    }
    if (item.contractHash !== undefined && (typeof item.contractHash !== "string" || !SHA256.test(item.contractHash))) {
      throw new Error("Invalid experiment tree node contract hash.");
    }
    if (item.status === "planned" && (!item.sourceSnapshotHash || !item.contractHash)) {
      throw new Error("A planned tree node must bind its source snapshot and experiment contract.");
    }
    if (item.status === "creating" && item.contractHash !== undefined) throw new Error("An unfinished tree node cannot bind an experiment contract.");
    if (typeof item.worktree !== "string" || relativePath(item.worktree) !== item.worktree) throw new Error("Invalid experiment tree worktree path.");
    if (item.worktree !== `experiments/.trees/${definition.slug}/nodes/${id}` || item.experimentSlug !== definition.slug) {
      throw new Error("Experiment tree node path or experiment slug does not match its definition.");
    }
    if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) throw new Error("Invalid experiment tree node timestamp.");
    if (nodes.length === 0) {
      if (id !== "root" || item.parentNodeId !== null || item.parentReceiptId !== null) throw new Error("The first tree node must be the unparented root.");
    } else if (
      typeof item.parentNodeId !== "string" || !seen.has(item.parentNodeId) || item.parentNodeId === id
      || typeof item.parentReceiptId !== "string" || !item.parentReceiptId
      || nodes.find(node => node.id === item.parentNodeId)?.status !== "planned"
    ) {
      throw new Error("A child tree node must name an earlier planned parent node and receipt.");
    }
    nodes.push({
      id, status: item.status, ...(creationPid === undefined ? {} : { creationPid }),
      parentNodeId: item.parentNodeId, parentReceiptId: item.parentReceiptId,
      ...(item.sourceSnapshotHash ? { sourceSnapshotHash: item.sourceSnapshotHash } : {}),
      ...(item.contractHash ? { contractHash: item.contractHash } : {}),
      worktree: item.worktree,
      experimentSlug: definition.slug, createdAt: item.createdAt,
    });
  }
  if (!nodes.length && value.state !== "planned") throw new Error("An initialized experiment tree must contain its root node.");
  if (!nodes.length && (value.winnerNodeId !== undefined || (Array.isArray(value.activeRuns) && value.activeRuns.length))) {
    throw new Error("An empty planned tree cannot have a winner or active run.");
  }
  if (value.winnerNodeId !== undefined && (typeof value.winnerNodeId !== "string" || !seen.has(value.winnerNodeId))) {
    throw new Error("The promoted tree winner must identify an existing node.");
  }
  for (const name of ["trialAttempts", "baselineAttempts", "spentMs"] as const) {
    if (typeof value[name] !== "number" || !Number.isSafeInteger(value[name]) || value[name] < 0) throw new Error(`Invalid experiment tree ${name}.`);
  }
  if (!Array.isArray(value.activeRuns)) throw new Error("Experiment tree active runs must be an array.");
  const reservations: TreeRunReservation[] = [];
  const reservedNodes = new Set<string>();
  for (const item of value.activeRuns) {
    if (!record(item)) throw new Error("Invalid experiment tree run reservation.");
    exactKeys(item, ["id", "nodeId", "kind", "startedAt", "reservedMs", "trialAttemptsBefore", "baselineAttemptsBefore"], "tree run reservation");
    if (typeof item.id !== "string" || !item.id || typeof item.nodeId !== "string" || !seen.has(item.nodeId) || reservedNodes.has(item.nodeId)) {
      throw new Error("Invalid or duplicate active tree node reservation.");
    }
    if (item.kind !== "baseline" && item.kind !== "trial") throw new Error("Invalid active tree run kind.");
    if (typeof item.startedAt !== "number" || !Number.isSafeInteger(item.startedAt) || item.startedAt < 1 || typeof item.reservedMs !== "number" || !Number.isSafeInteger(item.reservedMs) || item.reservedMs < 1) {
      throw new Error("Invalid active tree run budget reservation.");
    }
    if (typeof item.trialAttemptsBefore !== "number" || !Number.isSafeInteger(item.trialAttemptsBefore) || item.trialAttemptsBefore < 0
      || typeof item.baselineAttemptsBefore !== "number" || !Number.isSafeInteger(item.baselineAttemptsBefore) || item.baselineAttemptsBefore < 0) {
      throw new Error("Invalid tree run attempt baseline.");
    }
    reservedNodes.add(item.nodeId);
    reservations.push({
      id: item.id, nodeId: item.nodeId, kind: item.kind, startedAt: item.startedAt, reservedMs: item.reservedMs,
      trialAttemptsBefore: item.trialAttemptsBefore, baselineAttemptsBefore: item.baselineAttemptsBefore,
    });
  }
  if (value.message !== undefined && (typeof value.message !== "string" || value.message.length > 20000)) throw new Error("Invalid experiment tree message.");
  return {
    version: 1, definitionHash: value.definitionHash, state: value.state as TreeState["state"], updatedAt: value.updatedAt,
    nodes, ...(value.winnerNodeId === undefined ? {} : { winnerNodeId: value.winnerNodeId as string }),
    trialAttempts: value.trialAttempts as number, baselineAttempts: value.baselineAttempts as number,
    spentMs: value.spentMs as number, activeRuns: reservations,
    ...(value.message === undefined ? {} : { message: value.message as string }),
  };
}
