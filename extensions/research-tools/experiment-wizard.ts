import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { engine, type ContractInput } from "./experiment-engine.js";
class Cancelled extends Error {}
// Parse an argv without invoking a shell, expanding variables, or losing quoted paths.
export function parseBenchmarkCommand(text: string): string[] {
  const args: string[] = []; let word = "", quote = "", started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "\\" && quote !== "'") {
      const next = text[i + 1];
      if (next && /[\s\\\"']/.test(next)) { word += next; i++; } else word += char;
      started = true;
    }
    else if (quote) { if (char === quote) quote = ""; else word += char; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { args.push(word); word = ""; started = false; } }
    else { if (/[|;&<>`$]/.test(char)) throw new Error("Use an executable and arguments. Shell operators/expansion are unavailable; put shell logic in a benchmark script."); word += char; started = true; }
  }
  if (quote) throw new Error("Close the quoted command argument.");
  if (started) args.push(word);
  if (!args.length || !args[0]) throw new Error("Enter a benchmark executable and its arguments.");
  return args;
}
export function parseSeeds(text: string): number[] {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (!parts.length || parts.length > 32 || parts.some(part => !/^-?\d+$/.test(part))) throw new Error("Enter 1..32 integer seeds, separated by commas or spaces.");
  const seeds = parts.map(Number);
  if (seeds.some(seed => !Number.isSafeInteger(seed)) || new Set(seeds).size !== seeds.length) throw new Error("Seeds must be distinct safe integers.");
  return seeds;
}
export async function experimentWizard(ctx: ExtensionCommandContext, defaults?: { hypothesis: string }): Promise<ContractInput | undefined> {
  const ask = async <T>(title: string, hint: string, parse: (text: string) => T, options: { default?: string; multiline?: boolean } = {}): Promise<T> => {
    while (true) {
      const text = options.multiline ? await ctx.ui.editor(title, title.startsWith("What hypothesis") ? defaults?.hypothesis ?? "" : "") : await ctx.ui.input(title, hint);
      if (text === undefined) throw new Cancelled();
      try { return parse(text.trim() || options.default || ""); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    }
  };
  const choose = async (title: string, choices: string[]) => { const value = await ctx.ui.select(title, choices); if (value === undefined) throw new Cancelled(); return value; };
  const required = (text: string) => { if (!text) throw new Error("This field is required."); return text; };
  const paths = (text: string) => text.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
  const integer = (max: number) => (text: string) => { if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > max) throw new Error(`Enter an integer in 1..${max}.`); return Number(text); };
  try {
    const slug = await ask("Experiment name", "lowercase-hyphenated-name", text => { if (!/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/.test(text) || text.length > 80) throw new Error("Use up to five lowercase words separated by hyphens."); return text; });
    const hypothesis = await ask("What hypothesis will this benchmark test?", "", required, { multiline: true });
    const argv = await ask("Benchmark command", 'Example: .venv/bin/python bench.py --seed {seed}', parseBenchmarkCommand);
    const cwd = await ask("Benchmark directory (Enter for workspace root)", ".", text => text, { default: "." });
    const filesInScope = await ask("Editable source files — one workspace-relative path per line", "", text => { const files = paths(text); if (!files.length) throw new Error("Name at least one editable file."); return files; }, { multiline: true });
    const inputFiles = await ask("Frozen data files and dependency lockfiles — one workspace-relative path per line, empty if none", "", paths, { multiline: true });
    const seeds = await ask("Seeds (Enter for 0)", "7, 42", parseSeeds, { default: "0" });
    const source = await choose("Where does the measured metric come from?", ["Stdout HYPATIA_METRIC", "Fresh JSON file"]);
    const key = await ask("Metric JSON key", "score or evaluation.loss", required);
    const unit = await ask("Metric unit", "accuracy, loss, milliseconds…", required);
    const direction = await choose("Which value is better?", ["Higher is better (max)", "Lower is better (min)"]);
    const file = source === "Fresh JSON file" ? await ask("Metric file beneath each fresh run directory", "metrics.json", required) : undefined;
    const environment = await ask("Execution environment", "Local venv or image@sha256:digest; do not enter credentials", required);
    const maxIterations = await ask("Trial limit (Enter for 20)", "1..100", integer(100), { default: "20" });
    const maxWallSeconds = await ask("Total benchmark execution budget in seconds (Enter for 3600)", "Includes baseline and trials", integer(604800), { default: "3600" });
    const timeoutPerRun = await ask(`Timeout per configuration (Enter for ${Math.min(600, maxWallSeconds)}s)`, "Includes all requested seeds", integer(maxWallSeconds), { default: String(Math.min(600, maxWallSeconds)) });
    const policy = await choose("Independent review", ["Automatic critic + auditor (Recommended)", "Benchmark only — no model review"]);
    const input: ContractInput = { slug, hypothesis, argv, cwd, filesInScope, inputFiles, seeds,
      metric: { source: source === "Fresh JSON file" ? "json-file" : "stdout", key, unit, direction: direction.startsWith("Higher") ? "max" : "min", ...(file ? { file } : {}) },
      environment, maxIterations, maxWallSeconds, timeoutPerRun, reviewPolicy: policy.startsWith("Automatic") ? "required" : "none" };
    return (await engine()).validateInput(input);
  } catch (error) {
    if (error instanceof Cancelled) { ctx.ui.notify("Experiment setup cancelled. No contract was created.", "info"); return undefined; }
    throw error;
  }
}
