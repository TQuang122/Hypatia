import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileHash, inside, objectHash, relativePath, safePath } from "./files.js";
import { verifySnapshot } from "./snapshots.js";
import type { Snapshot } from "./schema.js";

const execFileAsync = promisify(execFile);
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

async function git(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, signal,
  });
  return stdout.trim();
}

export async function inspectTreeRepository(workspace: string): Promise<{ workspace: string; baseCommit: string }> {
  const canonicalWorkspace = await realpath(workspace);
  let topLevel: string;
  try { topLevel = await git(["rev-parse", "--show-toplevel"], canonicalWorkspace); }
  catch { throw new Error("Experiment trees require a Git repository root."); }
  if (await realpath(topLevel) !== canonicalWorkspace) throw new Error("Experiment trees must be created from the Git repository root.");
  const status = await git(["status", "--porcelain", "--untracked-files=all"], canonicalWorkspace);
  if (status) throw new Error("Experiment trees require a clean Git checkout, including nonignored untracked files.");
  const baseCommit = await git(["rev-parse", "--verify", "HEAD^{commit}"], canonicalWorkspace);
  if (!OBJECT_ID.test(baseCommit)) throw new Error("Git returned an invalid tree base commit.");
  return { workspace: canonicalWorkspace, baseCommit };
}

export async function verifyTreeWorktree(workspace: string, treeRoot: string, nodePath: string, baseCommit: string): Promise<string> {
  const canonicalWorkspace = await realpath(workspace), canonicalTreeRoot = await realpath(treeRoot);
  const nodeWorkspace = await realpath(await safePath(canonicalWorkspace, relativePath(nodePath)));
  if (!inside(canonicalTreeRoot, nodeWorkspace) || nodeWorkspace === canonicalTreeRoot) {
    throw new Error("Tree node worktree is outside its managed experiment tree.");
  }
  const topLevel = await realpath(await git(["rev-parse", "--show-toplevel"], nodeWorkspace));
  const commonGitDir = await realpath(resolve(canonicalWorkspace, await git(["rev-parse", "--git-common-dir"], canonicalWorkspace)));
  const nodeGitDir = await realpath(await git(["rev-parse", "--absolute-git-dir"], nodeWorkspace));
  const head = await git(["rev-parse", "--verify", "HEAD^{commit}"], nodeWorkspace);
  if (
    topLevel !== nodeWorkspace || head !== baseCommit
    || !inside(join(commonGitDir, "worktrees"), nodeGitDir)
  ) throw new Error("Tree node is not the expected detached Git worktree.");
  return nodeWorkspace;
}

export async function freezeTreeInputs(workspace: string, treeRoot: string, inputFiles: string[]): Promise<Record<string, string>> {
  const canonicalWorkspace = await realpath(workspace), canonicalTreeRoot = await realpath(treeRoot);
  if (!inside(canonicalWorkspace, canonicalTreeRoot) || canonicalTreeRoot === canonicalWorkspace) {
    throw new Error("Frozen tree inputs must be stored inside the repository's experiment tree.");
  }
  if (new Set(inputFiles).size !== inputFiles.length) throw new Error("Tree frozen input paths must be unique.");
  const hashes: Record<string, string> = {};
  for (let index = 0; index < inputFiles.length; index++) {
    const path = relativePath(inputFiles[index]!);
    if (path.startsWith("experiments/.trees/")) throw new Error("Tree state cannot be a frozen benchmark input.");
    const source = await safePath(canonicalWorkspace, path);
    const before = await fileHash(source);
    const destination = await safePath(canonicalTreeRoot, `inputs/${index}.source`);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    const copied = await fileHash(destination), after = await fileHash(source);
    if (before !== copied || before !== after) throw new Error(`Frozen tree input changed while being copied: ${path}`);
    hashes[path] = before;
  }
  return hashes;
}

async function installFrozenInputs(
  treeRoot: string,
  workspace: string,
  inputFiles: string[],
  inputHashes: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  if (Object.keys(inputHashes).length !== inputFiles.length) throw new Error("Tree frozen input hashes do not match declared paths.");
  for (let index = 0; index < inputFiles.length; index++) {
    signal?.throwIfAborted();
    const path = relativePath(inputFiles[index]!);
    const expected = inputHashes[path];
    if (!expected) throw new Error(`Tree frozen input hash is missing: ${path}`);
    const source = await safePath(treeRoot, `inputs/${index}.source`);
    if (await fileHash(source) !== expected) throw new Error(`Tree frozen input snapshot changed: ${path}`);
    const target = await safePath(workspace, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    if (await fileHash(target) !== expected) throw new Error(`Tree frozen input could not be installed: ${path}`);
  }
}

async function installParentSnapshot(sourceRoot: string, snapshot: Snapshot, workspace: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await verifySnapshot(sourceRoot, snapshot);
  for (const file of snapshot.files) {
    signal?.throwIfAborted();
    const target = await safePath(workspace, file.path);
    if (!file.exists) {
      await unlink(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      continue;
    }
    const source = await safePath(sourceRoot, file.copy!);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    if (await fileHash(target) !== file.sha256) throw new Error(`Parent best snapshot could not be installed: ${file.path}`);
  }
  const installed = await Promise.all(snapshot.files.map(async file => ({
    path: file.path,
    exists: !!(await lstat(await safePath(workspace, file.path)).catch(() => undefined)),
    ...(file.exists ? { sha256: await fileHash(await safePath(workspace, file.path)) } : {}),
  })));
  if (objectHash(installed) !== snapshot.hash) throw new Error("Installed child source does not match the parent snapshot.");
}

export async function createTreeWorktree(options: {
  workspace: string;
  treeRoot: string;
  path: string;
  baseCommit: string;
  inputFiles: string[];
  inputHashes: Record<string, string>;
  signal?: AbortSignal;
  sourceSnapshot?: { root: string; snapshot: Snapshot };
}): Promise<string> {
  options.signal?.throwIfAborted();
  const workspace = await realpath(options.workspace), treeRoot = await realpath(options.treeRoot);
  const target = await safePath(workspace, relativePath(options.path));
  if (!inside(treeRoot, target) || target === treeRoot) throw new Error("Tree worktree destination must be inside the experiment tree.");
  if (!OBJECT_ID.test(options.baseCommit)) throw new Error("Experiment tree base commit must be a full Git object ID.");
  if (await lstat(target).catch(() => undefined)) throw new Error("Experiment tree worktree destination already exists; preserve it and inspect before recovery.");
  const resolvedCommit = await git(["rev-parse", "--verify", `${options.baseCommit}^{commit}`], workspace, options.signal);
  if (resolvedCommit !== options.baseCommit) throw new Error("Experiment tree base commit no longer resolves to the saved object.");
  await mkdir(dirname(target), { recursive: true });
  await git(["worktree", "add", "--detach", target, options.baseCommit], workspace, options.signal);
  options.signal?.throwIfAborted();
  const nodeWorkspace = await realpath(target);
  if (!inside(treeRoot, nodeWorkspace)) throw new Error("Git created a worktree outside the experiment tree.");
  await installFrozenInputs(treeRoot, nodeWorkspace, options.inputFiles, options.inputHashes, options.signal);
  if (options.sourceSnapshot) {
    await installParentSnapshot(options.sourceSnapshot.root, options.sourceSnapshot.snapshot, nodeWorkspace, options.signal);
  }
  return nodeWorkspace;
}
