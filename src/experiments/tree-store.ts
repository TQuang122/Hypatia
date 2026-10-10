import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { appendSynced, atomicJson, exclusiveJson, inside, json, objectHash, readBounded, safePath } from "./files.js";
import { record, slug } from "./schema.js";
import { validateTreeDefinition, validateTreeState, type ExperimentTree, type TreeDefinition, type TreeState } from "./tree-schema.js";

type TreeEvent = { version: 1; seq: number; previousHash: string; hash: string; kind: string; at: string; state: TreeState };

export async function treeRoot(workspace: string, name: string): Promise<string> {
  const canonicalWorkspace = await realpath(workspace);
  return safePath(canonicalWorkspace, `experiments/.trees/${slug(name)}`);
}

async function readEvents(root: string, definition: TreeDefinition): Promise<TreeEvent[]> {
  const text = (await readBounded(await safePath(root, "events.jsonl"), 64 * 1024 * 1024)).toString("utf8");
  if (text.length > 64 * 1024 * 1024 || !text.endsWith("\n")) {
    throw new Error("Experiment tree journal is oversized or incomplete; preserve it and inspect before recovery.");
  }
  const lines = text.trimEnd().split("\n");
  if (!lines.length || !lines[0]) throw new Error("Experiment tree has no initial state.");
  const events: TreeEvent[] = [];
  let previousHash = "";
  for (let index = 0; index < lines.length; index++) {
    let value: unknown;
    try { value = JSON.parse(lines[index]!); }
    catch { throw new Error("Experiment tree journal contains invalid JSON."); }
    if (!record(value) || Object.keys(value).some(key => !["version", "seq", "previousHash", "hash", "kind", "at", "state"].includes(key))) {
      throw new Error("Experiment tree journal event has an invalid shape.");
    }
    const event = value as unknown as TreeEvent;
    if (typeof event.kind !== "string" || !event.kind || typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at))
      || typeof event.hash !== "string" || !/^[a-f0-9]{64}$/.test(event.hash)) {
      throw new Error("Experiment tree journal event has invalid metadata.");
    }
    const { hash: expected, ...unsigned } = event;
    if (
      event.version !== 1 || event.seq !== index + 1 || event.previousHash !== previousHash
      || objectHash(unsigned) !== expected
    ) throw new Error("Experiment tree journal integrity check failed.");
    event.state = validateTreeState(event.state, definition);
    previousHash = expected;
    events.push(event);
  }
  return events;
}

export async function loadTree(root: string): Promise<ExperimentTree> {
  const definition = validateTreeDefinition(await json<unknown>(await safePath(root, "definition.json"), 1024 * 1024));
  const expectedRoot = await treeRoot(definition.workspace, definition.slug);
  if (root !== expectedRoot) throw new Error("Experiment tree path does not match its saved workspace and slug.");
  const events = await readEvents(root, definition);
  return { root, definition, state: events.at(-1)!.state };
}

export async function saveTree(tree: ExperimentTree, kind: string): Promise<void> {
  if (!kind.trim() || kind.length > 100) throw new Error("Experiment tree event kind is required.");
  const definition = validateTreeDefinition(tree.definition);
  const state = validateTreeState(tree.state, definition);
  const root = await treeRoot(tree.definition.workspace, tree.definition.slug);
  if (root !== tree.root) throw new Error("Experiment tree path changed before saving.");
  const existing = await readFile(await safePath(tree.root, "events.jsonl"), "utf8")
    .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
  if (existing && !existing.endsWith("\n")) throw new Error("Refusing to append to an incomplete experiment tree journal.");
  const lines = existing.trimEnd() ? existing.trimEnd().split("\n") : [];
  let previous: TreeEvent | undefined;
  if (lines.length) {
    previous = (await readEvents(tree.root, definition)).at(-1);
  } else if (state.state !== "planned") throw new Error("The first experiment tree event must be planned.");
  state.updatedAt = new Date().toISOString();
  const unsigned = {
    version: 1 as const, seq: lines.length + 1, previousHash: previous?.hash ?? "",
    kind, at: state.updatedAt, state,
  };
  await appendSynced(await safePath(tree.root, "events.jsonl"), JSON.stringify({ ...unsigned, hash: objectHash(unsigned) }) + "\n");
  tree.state = state;
  await atomicJson(await safePath(tree.root, "state.json"), state);
}

export async function initializeTreeAt(workspace: string, path: string, value: TreeDefinition, initialState: TreeState): Promise<ExperimentTree> {
  const definition = validateTreeDefinition(value);
  const canonicalWorkspace = await realpath(workspace);
  if (definition.workspace !== canonicalWorkspace) throw new Error("Experiment tree workspace must be canonical.");
  const root = await realpath(path);
  const treesDirectory = await realpath(await safePath(canonicalWorkspace, "experiments/.trees"));
  if (!inside(treesDirectory, root) || root === treesDirectory) throw new Error("Experiment tree state must be inside experiments/.trees.");
  await mkdir(await safePath(root, "nodes"), { recursive: true });
  await exclusiveJson(await safePath(root, "definition.json"), definition);
  const state = validateTreeState(initialState, definition);
  if (state.state !== "planned") throw new Error("A new experiment tree must start in planned state.");
  state.updatedAt = new Date().toISOString();
  const unsigned = { version: 1 as const, seq: 1, previousHash: "", kind: "created", at: state.updatedAt, state };
  await appendSynced(await safePath(root, "events.jsonl"), JSON.stringify({ ...unsigned, hash: objectHash(unsigned) }) + "\n");
  await atomicJson(await safePath(root, "state.json"), state);
  const tree: ExperimentTree = { root, definition, state };
  return tree;
}

export async function initializeTree(workspace: string, value: TreeDefinition, initialState: TreeState): Promise<ExperimentTree> {
  const definition = validateTreeDefinition(value);
  const root = await treeRoot(workspace, definition.slug);
  await mkdir(join(root, "nodes"), { recursive: true });
  return initializeTreeAt(workspace, root, definition, initialState);
}

export async function listTrees(workspace: string): Promise<ExperimentTree[]> {
  const directory = await safePath(await realpath(workspace), "experiments/.trees");
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const trees: ExperimentTree[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const root = await safePath(directory, entry.name);
    const manifest = await lstat(join(root, "definition.json")).catch(() => undefined);
    if (manifest?.isFile() && !manifest.isSymbolicLink()) trees.push(await loadTree(root));
  }
  return trees.sort((left, right) => right.state.updatedAt.localeCompare(left.state.updatedAt));
}
