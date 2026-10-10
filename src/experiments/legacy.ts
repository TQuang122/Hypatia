import { lstat } from "node:fs/promises";
import { readBounded, safePath } from "./files.js";
export async function legacy(workspace: string): Promise<{ files: string[]; recordedLines: number; message: string }> {
  const files: string[] = [];
  let recordedLines = 0;
  for (const name of ["autoresearch.md", "autoresearch.jsonl", "autoresearch.sh"]) {
    const path = await safePath(workspace, name);
    if (!(await lstat(path).catch(() => undefined))) continue;
    const bytes = await readBounded(path);
    files.push(name);
    if (name.endsWith("jsonl")) recordedLines = bytes.toString("utf8").split("\n").filter(line => line.trim()).length;
  }
  return { files, recordedLines, message: files.length ? "Legacy logs are preserved. They are historical notes without sealed engine receipts; create a new contract and baseline before benchmark execution." : "No legacy autoresearch state found." };
}
