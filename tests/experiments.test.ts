import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import * as engine from "../src/experiments/index.js";
import { currentEnvironmentFingerprintHost, fingerprintEnvironment } from "../src/experiments/environment.js";
import { verifyEnvironment } from "../src/experiments/lifecycle.js";
import { objectHash } from "../src/experiments/files.js";
import { lock, load, save } from "../src/experiments/store.js";
import { snapshot } from "../src/experiments/snapshots.js";
import { parseMetric } from "../src/experiments/receipts.js";
import { verifyReceipt } from "../src/experiments/receipts.js";
import { importIdea } from "../src/experiments/import-autoresearch.js";
import { engine as packagedEngine } from "../extensions/research-tools/experiment-engine.js";
import type { ContractInput } from "../src/experiments/schema.js";
const benchmarkTest = process.platform === "win32" ? test.skip : test;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const benchmark = `import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process';
const c=JSON.parse(fs.readFileSync('config.json','utf8'));
fs.appendFileSync('count.txt','run\\n');
await new Promise(r=>setTimeout(r,c.delay||0));
if(c.waitForRelease){const runDir=process.env.HYPATIA_EXPERIMENT_RUN_DIR;const release=path.resolve(runDir,'..','continue');await new Promise((resolve,reject)=>{const watcher=fs.watch(path.dirname(release),(_,name)=>{if((!name||name.toString()===path.basename(release))&&fs.existsSync(release)){watcher.close();resolve();}});watcher.once('error',reject);if(fs.existsSync(release)){watcher.close();resolve();}});}
if(c.exit) process.exit(c.exit);
const metric={loss:c.value+Number(process.env.HYPATIA_EXPERIMENT_SEED||0)};
if(c.descendant){ const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});p.unref();fs.writeFileSync('descendant.pid',String(p.pid));console.log('HYPATIA_METRIC '+JSON.stringify(metric));process.exit(0); }
if(c.file) fs.writeFileSync(path.join(process.env.HYPATIA_EXPERIMENT_RUN_DIR,'metrics.json'),JSON.stringify(metric));
else if(!c.missing){ console.log('HYPATIA_METRIC '+JSON.stringify(metric)); if(c.duplicate) console.log('HYPATIA_METRIC '+JSON.stringify(metric)); }
`;
async function fixture(t: TestContext, overrides: Partial<ContractInput> = {}, initialConfig: unknown = { value: 10 }) {
  const cwd = mkdtempSync(join(tmpdir(), "experiment space-"));
  writeFileSync(join(cwd, "benchmark.mjs"), benchmark);
  writeFileSync(join(cwd, "config.json"), JSON.stringify(initialConfig));
  const input: ContractInput = { slug: "fixture-run", hypothesis: "Validate benchmark accounting", argv: [process.execPath, "benchmark.mjs"], filesInScope: ["benchmark.mjs", "config.json", "candidate.txt"], seeds: [1, 3], metric: { source: "stdout", key: "loss", unit: "loss", direction: "min" }, environment: "Local Node fixture", reviewPolicy: "none", maxIterations: 3, maxWallSeconds: 30, timeoutPerRun: 5, ...overrides };
  t.after(async () => {
    const current = await engine.status(cwd, input.slug).catch(() => undefined);
    if (current?.state.active && current.state.active.workerPid !== 99999999) {
      await engine.pause(cwd, input.slug).catch(() => {});
      await engine.wait(cwd, input.slug, current.state.active.id).catch(() => {});
    }
    await rm(cwd, { recursive: true, force: true });
  });
  const experiment = await engine.create(cwd, input);
  return { cwd, input, experiment, config: (value: unknown) => writeFileSync(join(cwd, "config.json"), JSON.stringify(value)) };
}
async function executableDriftFixture(t: TestContext, seeds: number[], mutateSeed: number) {
  const cwd = mkdtempSync(join(tmpdir(), "experiment executable drift-"));
  const executable = join(cwd, "benchmark-executable");
  writeFileSync(join(cwd, "scope.txt"), "baseline\n");
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
if (process.env.HYPATIA_EXPERIMENT_SEED === ${JSON.stringify(String(mutateSeed))}) {
  fs.appendFileSync(process.argv[1], "\\n// executable changed\\n");
}
console.log("HYPATIA_METRIC " + JSON.stringify({ score: 1 }));
`);
  chmodSync(executable, 0o755);
  const input: ContractInput = {
    slug: "executable-drift",
    hypothesis: "Executable identity stays fixed throughout a benchmark",
    argv: [executable],
    filesInScope: ["scope.txt"],
    seeds,
    metric: { source: "stdout", key: "score", unit: "score", direction: "max" },
    environment: "Local executable drift fixture",
    reviewPolicy: "none",
    maxIterations: 1,
    maxWallSeconds: 30,
    timeoutPerRun: 5,
  };
  t.after(async () => {
    const current = await engine.status(cwd, input.slug).catch(() => undefined);
    if (current?.state.active && current.state.active.workerPid !== 99999999) {
      await engine.pause(cwd, input.slug).catch(() => {});
      await engine.wait(cwd, input.slug, current.state.active.id).catch(() => {});
    }
    await rm(cwd, { recursive: true, force: true });
  });
  const experiment = await engine.create(cwd, input);
  return { cwd, input, experiment };
}
async function run(cwd: string, kind: "baseline" | "trial" = "baseline") {
  const started = await engine.start(cwd, "fixture-run", kind);
  return started.cached ?? engine.wait(cwd, "fixture-run", started.runId!);
}
async function pollChild(cwd: string): Promise<void> {
  for (let i = 0; i < 100; i++) { if ((await engine.status(cwd, "fixture-run")).state.active?.childPid) return; await new Promise(r => setTimeout(r, 30)); }
  throw new Error("Worker did not start benchmark child.");
}
test("new experiment contracts persist the secret-safe environment fingerprint", async t => {
  const { experiment } = await fixture(t, {
    filesInScope: ["benchmark.mjs", "candidate.txt"],
    inputFiles: ["config.json"],
  });
  const fingerprint = experiment.contract.environmentFingerprint;

  assert.ok(fingerprint);
  assert.equal(fingerprint.platform, process.platform);
  assert.equal(fingerprint.architecture, process.arch);
  assert.equal(fingerprint.runtimeVersion, process.version);
  assert.equal(fingerprint.executableHash, experiment.contract.executableHash);
  assert.equal(fingerprint.inputFilesHash, objectHash(experiment.contract.inputHashes));
  assert.equal(fingerprint.sha256, fingerprintEnvironment(experiment.contract).sha256);
});
test("changed host identity prevents approval of an environment-bound contract", async t => {
  const { experiment } = await fixture(t);
  const fingerprint = fingerprintEnvironment(experiment.contract, {
    ...currentEnvironmentFingerprintHost(),
    architecture: "different-architecture",
  });
  const changed = {
    ...experiment,
    contract: { ...experiment.contract, environmentFingerprint: fingerprint },
  };

  await assert.rejects(verifyEnvironment(changed), /environment fingerprint changed/);
});
test("legacy contracts without environment fingerprints remain verifiable", async t => {
  const { experiment } = await fixture(t);
  const legacyContract = { ...experiment.contract };
  delete legacyContract.environmentFingerprint;

  await verifyEnvironment({ ...experiment, contract: legacyContract });
});
benchmarkTest("benchmark receipts bind the contract environment fingerprint", async t => {
  const { cwd, experiment } = await fixture(t, { seeds: [0] });
  await engine.approve(cwd, "fixture-run");
  const receipt = await run(cwd);
  const current = await engine.status(cwd, "fixture-run");
  const ref = current.state.receipts.find(item => item.id === receipt.id);

  assert.ok(ref);
  assert.equal(receipt.environmentFingerprint, experiment.contract.environmentFingerprint?.sha256);
  await assert.rejects(
    verifyReceipt(experiment.root, ref, current.state.contractHash, "0".repeat(64)),
    /environment fingerprint binding/,
  );
});
benchmarkTest("executable drift between seeds prevents launching the next seed", async t => {
  const { cwd, input } = await executableDriftFixture(t, [0, 1], 0);
  await engine.approve(cwd, input.slug);
  const started = await engine.start(cwd, input.slug, "baseline");
  const runId = started.runId;
  if (runId === undefined) throw new Error("Baseline start did not return a run ID.");

  const receipt = await engine.wait(cwd, input.slug, runId);

  assert.equal(receipt.valid, false);
  assert.equal(receipt.seeds.length, 1);
  assert.match(receipt.reason ?? "", /executable changed/);
});
benchmarkTest("executable drift during the final seed invalidates the sealed receipt", async t => {
  const { cwd, input } = await executableDriftFixture(t, [0], 0);
  await engine.approve(cwd, input.slug);
  const started = await engine.start(cwd, input.slug, "baseline");
  const runId = started.runId;
  if (runId === undefined) throw new Error("Baseline start did not return a run ID.");

  const receipt = await engine.wait(cwd, input.slug, runId);

  assert.equal(receipt.valid, false);
  assert.equal(receipt.seeds.length, 1);
  assert.match(receipt.reason ?? "", /executable changed/);
});
test("metric parser rejects absent, ambiguous and non-numeric evidence", () => {
  const metric = { source: "stdout" as const, key: "loss", unit: "loss", direction: "min" as const };
  assert.equal(parseMetric('noise\nHYPATIA_METRIC {"loss":-1.5}\n', metric), -1.5);
  for (const raw of ['{"loss":1}', 'HYPATIA_METRIC {"loss":"1"}', 'HYPATIA_METRIC {"loss":1}\nHYPATIA_METRIC {"loss":2}']) assert.throws(() => parseMetric(raw, metric));
});
benchmarkTest("unapproved contracts cannot execute and frozen data changes require a new baseline contract", async t => {
  const { cwd } = await fixture(t);
  await assert.rejects(engine.start(cwd, "fixture-run", "baseline"), /approved/);
  assert.equal(existsSync(join(cwd, "count.txt")), false);
  const other = join(cwd, "data.txt"); writeFileSync(other, "frozen");
  const original = await engine.status(cwd, "fixture-run");
  const second = { ...original.contract, slug: "data-run" };
  const exp = await engine.create(cwd, { ...second, argv: original.contract.argv, filesInScope: original.contract.filesInScope, inputFiles: ["data.txt"], hypothesis: "input freeze", environment: "fixture", metric: original.contract.metric, seeds: [0], maxIterations: 1, maxWallSeconds: 5, timeoutPerRun: 3 } as unknown as ContractInput).catch(() => undefined);
  // Create with the public input shape rather than supplying persisted engine fields.
  assert.equal(exp, undefined);
  await engine.create(cwd, { slug: "data-run", hypothesis: "input freeze", argv: [process.execPath, "benchmark.mjs"], filesInScope: ["benchmark.mjs", "config.json"], inputFiles: ["data.txt"], metric: original.contract.metric, environment: "fixture" });
  await engine.approve(cwd, "data-run"); writeFileSync(other, "changed");
  await assert.rejects(engine.start(cwd, "data-run", "baseline"), /input data changed/);
});
benchmarkTest("baseline cache, seeded mean, keep/revert and dirty file preservation survive new reads", async t => {
  const { cwd, config } = await fixture(t);
  await engine.approve(cwd, "fixture-run");
  const baseline = await run(cwd); assert.equal(baseline.value, 12); assert.equal(baseline.seeds.length, 2);
  const cached = await run(cwd); assert.equal(cached.id, baseline.id);
  assert.equal(readFileSync(join(cwd, "count.txt"), "utf8").trim().split("\n").length, 2);
  config({ value: 8 }); writeFileSync(join(cwd, "candidate.txt"), "kept candidate");
  const improved = await run(cwd, "trial"); assert.equal(improved.value, 10);
  await engine.decide(cwd, "fixture-run", improved.id, "keep", "Lower observed loss.");
  config({ value: 9 }); writeFileSync(join(cwd, "candidate.txt"), "rejected candidate"); writeFileSync(join(cwd, "unrelated.txt"), "user dirty work");
  const rejected = await run(cwd, "trial");
  await assert.rejects(engine.decide(cwd, "fixture-run", rejected.id, "keep", "wishful claim"), /improvement/);
  await engine.decide(cwd, "fixture-run", rejected.id, "revert", "Worse than the kept candidate.");
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, "config.json"), "utf8")), { value: 8 });
  assert.equal(readFileSync(join(cwd, "candidate.txt"), "utf8"), "kept candidate");
  assert.equal(readFileSync(join(cwd, "unrelated.txt"), "utf8"), "user dirty work");
  const finished = await engine.close(cwd, "fixture-run"); assert.equal(finished.experiment.state.outcome, "positive");
  assert.match(readFileSync(join(cwd, finished.report), "utf8"), /revert/);
  assert.match(readFileSync(join(cwd, finished.provenance), "utf8"), /SHA256/);
});
benchmarkTest("concurrent run claims start only one worker", async t => {
  const { cwd, experiment } = await fixture(t, { seeds: [0] }, { value: 10, waitForRelease: true });
  await engine.approve(cwd, "fixture-run");
  const started = await engine.start(cwd, "fixture-run", "baseline");
  const runId = started.runId ?? "";
  if (!runId) throw new Error("Baseline start did not return a run ID.");
  await assert.rejects(engine.start(cwd, "fixture-run", "baseline"), /already has a run\/review owner/);
  writeFileSync(join(experiment.root, "runs", runId, "continue"), "continue\n");
  const receipt = await engine.wait(cwd, "fixture-run", runId);
  assert.equal(receipt.valid, true, receipt.reason ?? "Expected a valid receipt");
  assert.equal(readFileSync(join(cwd, "count.txt"), "utf8").trim().split("\n").length, 1);
});
benchmarkTest("pause seals an interrupted receipt and budget persists through resume", async t => {
  const { cwd, config } = await fixture(t, { seeds: [0], maxIterations: 1 });
  await engine.approve(cwd, "fixture-run"); await run(cwd);
  config({ value: 8, delay: 4000 });
  const started = await engine.start(cwd, "fixture-run", "trial"); await pollChild(cwd);
  const paused = await engine.pause(cwd, "fixture-run"); assert.equal(paused.state.state, "pause_requested");
  const receipt = await engine.wait(cwd, "fixture-run", started.runId!); assert.equal(receipt.interrupted, true); assert.equal(receipt.valid, false);
  assert.equal((await engine.status(cwd, "fixture-run")).state.state, "paused");
  await engine.resume(cwd, "fixture-run"); await engine.decide(cwd, "fixture-run", receipt.id, "failed", "User interrupted the trial.");
  assert.equal((await engine.status(cwd, "fixture-run")).state.trialAttempts, 1);
  await assert.rejects(engine.start(cwd, "fixture-run", "trial"), /budget/);
  assert.equal((await engine.close(cwd, "fixture-run")).experiment.state.outcome, "budget_exhausted");
});
benchmarkTest("abort signal requests pause and waits for worker receipt", async t => {
  const { cwd } = await fixture(t, { seeds: [0] }, { value: 10, delay: 4000 });
  await engine.approve(cwd, "fixture-run");
  const started = await engine.start(cwd, "fixture-run", "baseline"), controller = new AbortController(); controller.abort();
  const receipt = await engine.wait(cwd, "fixture-run", started.runId!, { signal: controller.signal });
  assert.equal(receipt.interrupted, true); assert.equal((await engine.status(cwd, "fixture-run")).state.state, "paused");
});
benchmarkTest("malformed successful process output stays failed evidence, with bounded baseline retries", async t => {
  const { cwd } = await fixture(t, { seeds: [0] }, { value: 1, duplicate: true }); await engine.approve(cwd, "fixture-run");
  for (let i = 0; i < 3; i++) { const receipt = await run(cwd); assert.equal(receipt.valid, false); assert.match(receipt.reason!, /exactly one/); }
  await assert.rejects(engine.start(cwd, "fixture-run", "baseline"), /budget/);
  assert.equal((await engine.close(cwd, "fixture-run")).experiment.state.outcome, "failed");
});
benchmarkTest("JSON-file metric is observed under the fresh seed directory", async t => {
  const { cwd } = await fixture(t, { seeds: [2], metric: { source: "json-file", file: "metrics.json", key: "loss", direction: "min", unit: "loss" } }, { value: 5, file: true });
  await engine.approve(cwd, "fixture-run");
  const receipt = await run(cwd); assert.equal(receipt.value, 7); assert.equal(receipt.seeds[0]!.artifacts.length, 3);
});
benchmarkTest("receipt/log tampering blocks cached baseline, resume and closure", async t => {
  const { cwd } = await fixture(t); await engine.approve(cwd, "fixture-run"); const receipt = await run(cwd);
  const state = await engine.status(cwd, "fixture-run"); writeFileSync(join(state.root, receipt.seeds[0]!.artifacts[0]!.path), "tampered");
  await assert.rejects(engine.start(cwd, "fixture-run", "baseline"), /artifact changed/);
  await assert.rejects(engine.resume(cwd, "fixture-run"), /artifact changed/);
  await assert.rejects(engine.close(cwd, "fixture-run"), /artifact changed/);
});
test("state cache is derived from journal and a corrupt journal fails closed", async t => {
  const { cwd, experiment } = await fixture(t);
  writeFileSync(join(experiment.root, "state.json"), '{"state":"completed"}');
  assert.equal((await engine.status(cwd, "fixture-run")).state.state, "planned");
  writeFileSync(join(experiment.root, "events.jsonl"), readFileSync(join(experiment.root, "events.jsonl"), "utf8").replace('"created"', '"fake"'));
  await assert.rejects(engine.status(cwd, "fixture-run"), /integrity/);
});
benchmarkTest("orphan ownership prevents replay; dead-worker recovery preserves baseline and charges budget", async t => {
  const { cwd, experiment } = await fixture(t, { seeds: [0] }); await engine.approve(cwd, "fixture-run"); const baseline = await run(cwd);
  const id = randomUUID();
  await lock(experiment.root, async () => {
    const current = await load(experiment.root); const source = await snapshot(current.contract, current.root, id);
    current.state.active = { id, kind: "trial", token: randomUUID(), startedAt: Date.now(), workerPid: 99999999, engineHash: "recovery-fixture", workspaceRevision: null, childPid: process.pid, snapshot: source, inputHashes: current.contract.inputHashes }; current.state.trialAttempts++; current.state.state = "running";
    await save(current, "crash_fixture");
  });
  await assert.rejects(engine.resume(cwd, "fixture-run"), /still alive/);
  assert.equal((await engine.status(cwd, "fixture-run")).state.receipts.length, 1);
  await lock(experiment.root, async () => { const current = await load(experiment.root); delete current.state.active!.childPid; await save(current, "process_stopped_fixture"); });
  const recovered = await engine.resume(cwd, "fixture-run"); assert.equal(recovered.state.baselineId, baseline.id); assert.equal(recovered.state.receipts.length, 2);
  assert.equal(recovered.state.receipts.at(-1)!.valid, false); assert.ok(recovered.state.spentMs >= recovered.contract.timeoutPerRun * 1000);
  await engine.decide(cwd, "fixture-run", id, "failed", "Recovered after worker interruption.");
});
test("path escape/symlink scope is rejected and source runtime loads through packaged dist", async t => {
  const { cwd, input } = await fixture(t);
  await assert.rejects(engine.create(cwd, { ...input, slug: "escape-run", filesInScope: ["../outside"] }), /Unsafe/);
  if (process.platform !== "win32") { symlinkSync(join(cwd, "config.json"), join(cwd, "linked.json")); await assert.rejects(engine.create(cwd, { ...input, slug: "symlink-run", filesInScope: ["linked.json"] }), /Symlink/); }
  assert.equal(typeof (await packagedEngine()).start, "function");
});
test("AutoResearch import verifies source hash, selected body and snapshots source for later resume", async t => {
  const { cwd, input } = await fixture(t);
  const upstream = join(cwd, "upstream"); mkdirSync(join(upstream, "knowledge_base"), { recursive: true }); mkdirSync(join(upstream, "data"));
  writeFileSync(join(upstream, "knowledge_base", "domain.md"), "# Local domain knowledge\n");
  const forge = { results: [{ seed_title: "Seed", results: [{ b_id: "domain", idea_text: "A hypothesis", plan: "Run a bounded benchmark." }] }] }, forgeText = JSON.stringify(forge);
  writeFileSync(join(upstream, "data", "forge.json"), forgeText);
  const body = "# Seed\n\n## 1. Research idea\n\nA hypothesis\n\n## 2. Execution plan\n\nRun a bounded benchmark.\n";
  const metadata = { schema_version: 1, b_id: "domain", origin: { kind: "idea_forge", file: "data/forge.json", sha256: sha(forgeText), result_index: 1, plan_index: 1 } };
  const source = join(upstream, "idea.txt"); writeFileSync(source, `<!-- autoresearch-provenance\n${JSON.stringify(metadata)}\n-->\n\n${body}`);
  const imported = await engine.create(cwd, { ...input, slug: "imported-run" }, { ideaFile: source, autoresearchRoot: upstream }); assert.equal(imported.state.state, "planned");
  writeFileSync(source, "changed external source"); await rm(upstream, { recursive: true });
  await engine.approve(cwd, "imported-run"); assert.equal((await engine.status(cwd, "imported-run")).state.state, "ready");
  assert.match(readFileSync(join(imported.root, "idea.provenance.json"), "utf8"), /autoresearch-forge/);
  const badRoot = join(cwd, "bad"); mkdirSync(join(badRoot, "knowledge_base"), { recursive: true }); mkdirSync(join(badRoot, "data")); writeFileSync(join(badRoot, "knowledge_base", "domain.md"), "knowledge"); writeFileSync(join(badRoot, "data", "forge.json"), forgeText);
  const bad = join(badRoot, "idea.txt"); writeFileSync(bad, `<!-- autoresearch-provenance\n${JSON.stringify(metadata)}\n-->\n\n${body}altered`);
  await assert.rejects(importIdea(bad, badRoot), /body/);
  writeFileSync(join(badRoot, "data", "forge.json"), "changed"); await assert.rejects(importIdea(bad, badRoot), /checksum/);
});
test("legacy inspection preserves files and does not invent receipts", async t => {
  const { cwd } = await fixture(t); const raw = '{"metric":1}\n{"metric":2}\n'; writeFileSync(join(cwd, "autoresearch.jsonl"), raw);
  const result = await engine.legacy(cwd); assert.equal(result.recordedLines, 2); assert.match(result.message, /historical/); assert.equal(readFileSync(join(cwd, "autoresearch.jsonl"), "utf8"), raw);
  assert.equal((await engine.status(cwd, "fixture-run")).state.receipts.length, 0);
});

benchmarkTest("baseline code is frozen, and scope divergence cannot be silently overwritten or closed", async t => {
  const { cwd, config } = await fixture(t, { seeds: [0] });
  config({ value: 11 }); await assert.rejects(engine.approve(cwd, "fixture-run"), /Baseline code changed/);
  config({ value: 10 }); await engine.approve(cwd, "fixture-run");
  config({ value: 9 }); await assert.rejects(engine.start(cwd, "fixture-run", "baseline"), /Baseline code changed/);
  config({ value: 10 }); await run(cwd);
  config({ value: 8 }); const receipt = await run(cwd, "trial");
  config({ value: 7 }); await assert.rejects(engine.decide(cwd, "fixture-run", receipt.id, "revert", "user change"), /changed after/);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, "config.json"), "utf8")), { value: 7 });
  config({ value: 8 }); await engine.decide(cwd, "fixture-run", receipt.id, "keep", "observed improvement");
  config({ value: 6 }); await assert.rejects(engine.close(cwd, "fixture-run"), /diverged/);
});
benchmarkTest("run timeout records a failure and baseline-only closure does not claim a negative research result", async t => {
  const { cwd } = await fixture(t, { seeds: [0], timeoutPerRun: 1 }, { value: 10, delay: 2000 });
  await engine.approve(cwd, "fixture-run"); const receipt = await run(cwd);
  assert.equal(receipt.valid, false); assert.match(receipt.reason!, /timeout|budget/);
  const another = await fixture(t, { slug: "baseline-only", seeds: [0] }); await engine.approve(another.cwd, "baseline-only");
  const started = await engine.start(another.cwd, "baseline-only", "baseline"); await engine.wait(another.cwd, "baseline-only", started.runId!);
  assert.equal((await engine.close(another.cwd, "baseline-only")).experiment.state.outcome, "baseline_only");
});

benchmarkTest("lingering benchmark descendants are terminated before a run can settle", async t => {
  const { cwd } = await fixture(t, { seeds: [0], timeoutPerRun: 5 }, { value: 10, descendant: true });
  await engine.approve(cwd, "fixture-run"); const receipt = await run(cwd);
  assert.equal(receipt.valid, false); assert.match(receipt.reason!, /descendant/);
  assert.ok(receipt.elapsedMs < 4000, "Cleanup should happen after parent exit rather than waiting for the full deadline.");
});
benchmarkTest("dead lock owner is reclaimed and receipts contain engine and workspace identity", async t => {
  const { cwd, experiment } = await fixture(t, { seeds: [0] });
  mkdirSync(join(experiment.root, ".lock")); writeFileSync(join(experiment.root, ".lock", "owner.json"), JSON.stringify({pid:99999999,token:"dead-lock"}));
  await engine.approve(cwd, "fixture-run"); const receipt = await run(cwd);
  assert.match(receipt.engineHash, /^[a-f0-9]{64}$/); assert.equal(receipt.workspaceRevision, null);
  assert.equal(existsSync(join(experiment.root, ".lock")), false);
});

test("manual idea import requires valid UTF-8", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "idea-encoding-")); t.after(() => rm(cwd, { recursive:true, force:true }));
  const source = join(cwd, "binary.txt"); writeFileSync(source, Buffer.from([0xff,0xfe,0x00]));
  await assert.rejects(importIdea(source), /encoded data|encoding/);
});

benchmarkTest("unsealed child launch is blocked until the user acknowledges a stopped launch", async t => {
  const { cwd, experiment } = await fixture(t, {seeds:[0]}); await engine.approve(cwd,"fixture-run");
  const id=randomUUID();
  await lock(experiment.root,async()=>{const current=await load(experiment.root);const source=await snapshot(current.contract,current.root,id);current.state.active={id,kind:"baseline",token:randomUUID(),startedAt:Date.now(),workerPid:99999999,childLaunchPending:true,engineHash:"fixture",workspaceRevision:null,snapshot:source,inputHashes:current.contract.inputHashes};current.state.baselineAttempts++;current.state.state="running";await save(current,"launch_window_fixture");});
  await assert.rejects(engine.resume(cwd,"fixture-run"),/child identity|launch/);
  assert.equal((await engine.status(cwd,"fixture-run")).state.receipts.length,0);
  const recovered=await engine.acknowledgeStoppedLaunch(cwd,"fixture-run");assert.equal(recovered.state.state,"paused");assert.equal(recovered.state.receipts.length,1);assert.equal(recovered.state.receipts[0]!.valid,false);
});
