import { realpath, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { hash, inside, readBounded, safePath } from "./files.js";
import { record } from "./schema.js";
export type ImportedIdea = { body: string; provenance: Record<string, unknown>; snapshots: { path: string; bytes: Buffer }[] };
export async function importIdea(source: string, upstreamRoot?: string): Promise<ImportedIdea> {
  const bytes = await readBounded(source), text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.startsWith("<!-- hypatia-idea-forge\n")) return (await import("../idea-forge/artifacts.js")).importGeneratedIdea(source);
  const prefix = "<!-- autoresearch-provenance\n", suffix = "\n-->";
  if (!text.startsWith(prefix)) {
    if (!text.trim()) throw new Error("Idea file is empty.");
    return { body: text, provenance: { version: 1, kind: "manual", source, sourceHash: hash(bytes), ideaHash: hash(text) }, snapshots: [{ path: "inputs/idea-original.txt", bytes }] };
  }
  if (!upstreamRoot) throw new Error("An AutoResearch exported idea requires its repository root for provenance verification.");
  const root = await realpath(upstreamRoot), end = text.indexOf(suffix, prefix.length);
  if (end < 0) throw new Error("Unterminated AutoResearch provenance header.");
  const metadata: unknown = JSON.parse(text.slice(prefix.length, end));
  if (!record(metadata) || metadata.schema_version !== 1 || Object.keys(metadata).some(k => !["schema_version", "b_id", "origin"].includes(k)) || typeof metadata.b_id !== "string" || !/^[\w-]+$/.test(metadata.b_id) || !record(metadata.origin)) throw new Error("Unsupported AutoResearch provenance schema.");
  if (["readme", "template"].includes(metadata.b_id.toLowerCase())) throw new Error("README/TEMPLATE are not AutoResearch knowledge directions.");
  const origin = metadata.origin;
  if (origin.kind !== "idea_forge" || typeof origin.file !== "string" || typeof origin.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(origin.sha256) || !Number.isSafeInteger(origin.result_index) || !Number.isSafeInteger(origin.plan_index) || Number(origin.result_index) < 1 || Number(origin.plan_index) < 1 || Object.keys(origin).some(k => !["kind", "file", "sha256", "result_index", "plan_index"].includes(k))) throw new Error("Invalid AutoResearch Forge origin.");
  const forgePath = isAbsolute(origin.file) ? resolve(origin.file) : await safePath(root, origin.file);
  if (!inside(root, forgePath) || !inside(root, await realpath(forgePath))) throw new Error("Forge origin must stay inside the supplied AutoResearch repository.");
  const forgeBytes = await readBounded(forgePath, 16 * 1024 * 1024);
  if (hash(forgeBytes) !== origin.sha256) throw new Error("AutoResearch Forge checksum mismatch.");
  const forge: unknown = JSON.parse(forgeBytes.toString("utf8"));
  const result = record(forge) && Array.isArray(forge.results) ? forge.results[Number(origin.result_index) - 1] : undefined;
  const plan = record(result) && Array.isArray(result.results) ? result.results[Number(origin.plan_index) - 1] : undefined;
  if (!record(result) || !record(plan) || plan.b_id !== metadata.b_id || typeof plan.plan !== "string" || !plan.plan.trim() || ["生成失败", "计划书生成失败"].includes(plan.plan.trim())) throw new Error("Selected Forge plan is missing or not executable.");
  const title = String(result.seed_title || plan.seed_title || "Exported Idea Forge plan").trim();
  const idea = String(plan.idea_text || "").trim();
  const sections = [`# ${title}`, ...(idea ? ["## 1. Research idea", idea] : []), "## 2. Execution plan", plan.plan.trim()];
  const body = text.slice(end + suffix.length).replace(/^[\r\n]+/, "");
  if (body !== sections.join("\n\n") + "\n") throw new Error("Exported idea body does not match its selected Forge plan.");
  const knowledge = await readBounded(await safePath(root, `knowledge_base/${metadata.b_id}.md`));
  return {
    body,
    provenance: { version: 1, kind: "autoresearch-forge", source, sourceHash: hash(bytes), ideaHash: hash(body), upstreamRoot: root, origin, knowledgeDirection: metadata.b_id, knowledgeHash: hash(knowledge) },
    snapshots: [{ path: "inputs/idea-original.txt", bytes }, { path: "inputs/forge.json", bytes: forgeBytes }, { path: "inputs/knowledge.md", bytes: knowledge }],
  };
}
export async function persistIdea(root: string, idea: ImportedIdea): Promise<void> {
  for (const item of idea.snapshots) {
    const path = await safePath(root, item.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, item.bytes, { flag: "wx", mode: 0o600 });
  }
  await writeFile(join(root, "idea.md"), idea.body, { flag: "wx", mode: 0o600 });
  await writeFile(join(root, "idea.provenance.json"), JSON.stringify(idea.provenance, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
