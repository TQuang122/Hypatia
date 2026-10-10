import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function objectHash(value: unknown): string { return hash(canonical(value)); }
export function alive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
export function relativePath(path: string): string {
  if (isAbsolute(path) || path.includes("\0") || path.includes("\\") || path.split("/").some(p => p === ".." || p === ".git" || p === "node_modules")) throw new Error(`Unsafe workspace path: ${path}`);
  const normalized = path.replace(/^(?:\.\/)+/, "").replace(/\/+$/g, "");
  if (!normalized || normalized.split("/").some(p => !p || p === ".")) throw new Error(`Invalid relative path: ${path}`);
  return normalized;
}
export async function safePath(root: string, path: string, allowRoot = false): Promise<string> {
  if (allowRoot && (path === "." || path === "")) return root;
  const rel = relativePath(path);
  let cursor = root;
  for (const component of rel.split("/")) {
    cursor = join(cursor, component);
    const info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
    if (info?.isSymbolicLink()) throw new Error(`Symlink paths are not allowed: ${path}`);
  }
  return cursor;
}
export async function readBounded(path: string, max = 4 * 1024 * 1024): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error(`Expected a regular file smaller than ${max} bytes: ${path}`);
  return readFile(path);
}
export async function fileHash(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}
export async function exclusiveJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
export async function json<T>(path: string, max?: number): Promise<T> { return JSON.parse((await readBounded(path, max)).toString("utf8")) as T; }
export async function executable(command: string, cwd: string): Promise<string> {
  const candidates = command.includes("/") || command.includes("\\") ? [resolve(cwd, command)] : (process.env.PATH ?? "").split(delimiter).flatMap(directory => process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map(ext => join(directory, command + ext.toLowerCase())) : [join(directory, command)]);
  for (const path of candidates) { try { const target = await realpath(path); if ((await lstat(target)).isFile()) return target; } catch {} }
  throw new Error(`Benchmark executable not found: ${command}`);
}
export async function appendSynced(path: string, text: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
}
export function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }

export async function runtimeHash(directory: string): Promise<string> {
  const files: Record<string, string> = {};
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".js")).sort()) files[name] = await fileHash(join(directory, name));
  return objectHash(files);
}
