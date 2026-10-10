import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseBenchmarkCommand, parseSeeds, experimentWizard } from "../extensions/research-tools/experiment-wizard.js";
test("wizard command parser preserves spaces and empty quoted argv and never expands shell syntax", () => {
  assert.deepEqual(parseBenchmarkCommand('"venv path/bin/python" "bench file.py" --seed {seed} ""'), ["venv path/bin/python", "bench file.py", "--seed", "{seed}", ""]);
  assert.deepEqual(parseBenchmarkCommand('"C:\\Python\\python.exe" "C:\\research\\bench.py"'), ["C:\\Python\\python.exe", "C:\\research\\bench.py"]);
  assert.deepEqual(parseBenchmarkCommand("node a\\ b.mjs"), ["node", "a b.mjs"]);
  for (const text of ['node a | cat', 'node a && x', 'node $(x)', 'node "unterminated', '']) assert.throws(() => parseBenchmarkCommand(text));
  assert.deepEqual(parseSeeds("7, 42 -1"), [7, 42, -1]);
  for (const text of ["7,7", "0.2", "9007199254740992", ""]) assert.throws(() => parseSeeds(text));
});
test("legacy wizard helper parses a contract without launching benchmark/model calls", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "wizard space-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "bench file.mjs"), "console.log('fixture');");
  const inputs = ["wizard-run", `${process.execPath} "bench file.mjs" --seed {seed}`, "", "7,42", "score", "accuracy", "Local Node fixture", "2", "30", "3"];
  const editors = ["A fixture hypothesis", "bench file.mjs", ""];
  const choices = ["Stdout HYPATIA_METRIC", "Higher is better (max)", "Automatic critic + auditor (Recommended)"];
  let confirms = 0; let approval = "";
  const ctx = { cwd, mode: "tui", hasUI: true, ui: { input: async () => inputs.shift(), editor: async () => editors.shift(), select: async () => choices.shift(), confirm: async (_title: string, text: string) => { confirms++; approval = text; return true; }, notify() {} } } as unknown as ExtensionCommandContext;
  const contract = await experimentWizard(ctx);
  assert.equal(contract!.reviewPolicy, "required");
  assert.deepEqual(contract!.argv.slice(1), ["bench file.mjs", "--seed", "{seed}"]); assert.deepEqual(contract!.seeds, [7,42]);
  assert.equal(confirms, 0); await assert.rejects(stat(join(cwd,"experiments")), /ENOENT/);
});
test("wizard retries invalid fields and cancelling creates no experiment artifacts", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "wizard-cancel-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const inputs = ["INVALID", "valid-run", undefined]; const notices: string[] = [];
  const ctx = { cwd, mode: "tui", hasUI: true, ui: { input: async () => inputs.shift(), editor: async () => undefined, notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
  assert.equal(await experimentWizard(ctx), undefined);
  await assert.rejects(stat(join(cwd, "experiments")), /ENOENT/);
  assert.ok(notices.some(text => text.includes("lowercase"))); assert.ok(notices.some(text => text.includes("cancelled")));
});
