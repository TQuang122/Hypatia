import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileHash, hash, objectHash, readBounded, safePath } from "./files.js";
import type { Contract, Snapshot, SnapshotFile } from "./schema.js";
export async function inputHashes(contract: Contract): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of contract.inputFiles) result[path] = await fileHash(await safePath(contract.workspace, path));
  return result;
}
export async function snapshot(contract: Contract, root?: string, id?: string): Promise<Snapshot> {
  const files: SnapshotFile[] = [];
  for (let index = 0; index < contract.filesInScope.length; index++) {
    const path = contract.filesInScope[index]!;
    const full = await safePath(contract.workspace, path);
    const content = await readBounded(full, 2 * 1024 * 1024).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    const entry: SnapshotFile = { path, exists: content !== undefined, ...(content !== undefined ? { sha256: hash(content) } : {}) };
    if (root && id && content !== undefined) {
      const copy = `snapshots/${id}/${index}.source`;
      const target = await safePath(root, copy);
      await mkdir(join(root, "snapshots", id), { recursive: true });
      await writeFile(target, content, { flag: "wx", mode: 0o600 });
      entry.copy = copy;
    }
    files.push(entry);
  }
  return { files, hash: objectHash(files.map(({ copy: _copy, ...file }) => file)) };
}
export async function verifySnapshot(root: string, value: Snapshot): Promise<void> {
  if (value.hash !== objectHash(value.files.map(({ copy: _copy, ...file }) => file))) throw new Error("Snapshot metadata hash mismatch.");
  for (const file of value.files) if (file.exists) {
    if (!file.copy || await fileHash(await safePath(root, file.copy)) !== file.sha256) throw new Error(`Code snapshot changed: ${file.path}`);
  }
}
export async function restoreSnapshot(contract: Contract, root: string, value: Snapshot, expectedCurrentHash: string): Promise<void> {
  await verifySnapshot(root, value);
  if ((await snapshot(contract)).hash !== expectedCurrentHash) throw new Error("Scoped code changed after this trial. Preserve those edits before requesting revert.");
  const content = await Promise.all(value.files.map(async file => file.exists ? readFile(await safePath(root, file.copy!)) : undefined));
  for (let i = 0; i < value.files.length; i++) {
    const file = value.files[i]!, target = await safePath(contract.workspace, file.path);
    if (!file.exists) await unlink(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    else await writeFile(target, content[i]!);
  }
}
