import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { alive, appendSynced, atomicJson, json, objectHash, safePath, readBounded } from "./files.js";
import { slug, type Contract, type State } from "./schema.js";
export type Experiment = { root: string; contract: Contract; state: State };
type Event = { version: 1; seq: number; previousHash: string; hash: string; kind: string; at: string; state: State };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function experimentRoot(workspace: string, name: string): Promise<string> { return safePath(await realpath(workspace), `experiments/${slug(name)}`); }
export async function lock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const path = await safePath(root, ".lock");
  const recovery = await safePath(root, ".lock-recovery");
  const token = randomUUID();
  const started = Date.now();
  while (true) {
    if (await lstat(recovery).catch(() => undefined)) { if (Date.now() - started > 5000) throw new Error("Experiment lock recovery is busy; inspect .lock-recovery before retrying."); await sleep(25); continue; }
    try { await mkdir(path); await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid, token })); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid experiment lock.");
      const owner = await json<{ pid: number; token: string }>(join(path, "owner.json")).catch(() => undefined);
      if ((owner && !alive(owner.pid)) || (!owner && Date.now() - info.mtimeMs > 2000)) {
        try {
          await mkdir(recovery);
          try {
            const current = await json<{ pid: number; token: string }>(join(path, "owner.json")).catch(() => undefined);
            if ((!current && !owner) || (current?.token === owner?.token && !alive(current?.pid))) await rm(path, { recursive: true });
          } finally { await rm(recovery, { recursive: true }); }
        } catch (failure) { if (!["EEXIST", "ENOENT"].includes((failure as NodeJS.ErrnoException).code ?? "")) throw failure; }
      }
      if (Date.now() - started > 5000) throw new Error("Experiment is busy in another process.");
      await sleep(25);
    }
  }
  try { return await work(); }
  finally {
    const owner = await json<{ token: string }>(join(path, "owner.json")).catch(() => undefined);
    if (owner?.token === token) await rm(path, { recursive: true });
  }
}
export async function load(root: string): Promise<Experiment> {
  const contract = await json<Contract>(await safePath(root, "contract.json"));
  if (contract.version !== 1) throw new Error("Unsupported experiment contract version.");
  const text = (await readBounded(await safePath(root, "events.jsonl"), 64 * 1024 * 1024)).toString("utf8");
  if (text.length > 64 * 1024 * 1024 || !text.endsWith("\n")) throw new Error("Experiment event journal is oversized or incomplete; preserve it and inspect before recovery.");
  const contractHash = objectHash(contract);
  let previousHash = "", last: State | undefined;
  const lines = text.trimEnd().split("\n");
  for (let i = 0; i < lines.length; i++) {
    const event = JSON.parse(lines[i]!) as Event;
    const { hash: expected, ...unsigned } = event;
    if (event.version !== 1 || event.seq !== i + 1 || event.previousHash !== previousHash || objectHash(unsigned) !== expected || event.state.contractHash !== contractHash) throw new Error("Experiment journal/contract integrity check failed.");
    previousHash = expected; last = event.state;
  }
  if (!last) throw new Error("Experiment has no initial state.");
  return { root, contract, state: last };
}
export async function save(experiment: Experiment, kind: string): Promise<void> {
  experiment.state.updatedAt = new Date().toISOString();
  const path = await safePath(experiment.root, "events.jsonl");
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
  if (text && !text.endsWith("\n")) throw new Error("Refusing to append to an incomplete experiment journal.");
  const lines = text.trimEnd() ? text.trimEnd().split("\n") : [];
  const previous = lines.length ? JSON.parse(lines.at(-1)!) as Event : undefined;
  const unsigned = { version: 1 as const, seq: lines.length + 1, previousHash: previous?.hash ?? "", kind, at: experiment.state.updatedAt, state: experiment.state };
  await appendSynced(path, JSON.stringify({ ...unsigned, hash: objectHash(unsigned) }) + "\n");
  await atomicJson(await safePath(experiment.root, "state.json"), experiment.state);
}
export async function list(workspace: string): Promise<Experiment[]> {
  const directory = await safePath(await realpath(workspace), "experiments");
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const result: Experiment[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const root = await safePath(directory, entry.name);
    if (!(await lstat(join(root, "contract.json")).catch(() => undefined))) continue;
    result.push(await load(root));
  }
  return result.sort((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt));
}
