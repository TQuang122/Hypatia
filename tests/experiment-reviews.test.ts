import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as runtime from "../src/experiments/index.js";
import { validateReviewVerdict } from "../src/experiments/reviews.js";
import { lock, load, save } from "../src/experiments/store.js";
import type { ReviewOwner, ReviewKind } from "../src/experiments/schema.js";
async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "review-fixture-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "bench.mjs"), "console.log('HYPATIA_METRIC '+JSON.stringify({score:1}));");
  const experiment = await runtime.create(cwd, { slug: "review-run", hypothesis: "An exploratory fixture comparison", argv: [process.execPath, "bench.mjs"], filesInScope: ["bench.mjs"], seeds: [0], metric: { source: "stdout", key: "score", unit: "score", direction: "max" }, environment: "Synthetic Node fixture", maxWallSeconds: 10, timeoutPerRun: 3 });
  await runtime.approve(cwd, "review-run"); return { cwd, experiment };
}
async function seal(cwd: string, owner: ReviewOwner, verdict: "pass" | "blocked" = "pass", kind: ReviewKind = owner.kind) {
  return runtime.finishReview(cwd, "review-run", owner, { verdict, summary: verdict === "pass" ? "Fixture evidence inspected." : "Fixture blocker.", findings: verdict === "blocked" ? [{ severity: "major", evidence: "contract.json", message: "Fixture finding" }] : [], reviewer: { role: kind === "plan" ? "critic" : "auditor", provider: "fixture", model: "synthetic-reviewer", promptHash: "fixture-prompt" } });
}
test("review schema rejects mismatched evidence, extra fields, malformed findings and fatal/major pass", () => {
  const good = { version: 1, bundleHash: "abc", verdict: "pass", summary: "Inspected", findings: [] };
  assert.equal(validateReviewVerdict(good, "abc").verdict, "pass");
  for (const value of [{ ...good, bundleHash: "old" }, { ...good, approved: true }, { ...good, findings: [{}] }, { ...good, findings: [{ severity: "major", evidence: "receipt", message: "Unresolved" }] }]) assert.throws(() => validateReviewVerdict(value, "abc"));
});
const benchmarkTest = process.platform === "win32" ? test.skip : test;
benchmarkTest("required critic/auditor gates bind exact receipts and decisions and retain every review", async t => {
  const { cwd } = await fixture(t);
  await assert.rejects(runtime.start(cwd, "review-run", "baseline"), /Critic.*required/);
  const plan = await runtime.beginReview(cwd, "review-run", "plan"); await seal(cwd, plan.owner!);
  const baseline = await runtime.start(cwd, "review-run", "baseline"); await runtime.wait(cwd, "review-run", baseline.runId!);
  await assert.rejects(runtime.close(cwd, "review-run"), /Auditor.*required/);
  const firstAudit = await runtime.beginReview(cwd, "review-run", "audit"); await seal(cwd, firstAudit.owner!);
  const trial = await runtime.start(cwd, "review-run", "trial"); const receipt = await runtime.wait(cwd, "review-run", trial.runId!);
  await runtime.decide(cwd, "review-run", receipt.id, "revert", "Equal fixture value.");
  await assert.rejects(runtime.close(cwd, "review-run"), /Auditor.*required/);
  const secondAudit = await runtime.beginReview(cwd, "review-run", "audit"); assert.notEqual(secondAudit.bundleHash, firstAudit.bundleHash); await seal(cwd, secondAudit.owner!);
  const closed = await runtime.close(cwd, "review-run"); assert.equal(closed.experiment.state.reviews!.length, 3);
  assert.match(await readFile(join(cwd, closed.report), "utf8"), /Independent reviews/);
  assert.match(await readFile(join(cwd, closed.provenance), "utf8"), /bundle/);
});
test("blocked review prevents execution and retries are capped across reloads", async t => {
  const { cwd } = await fixture(t);
  for (let i = 0; i < 3; i++) { const start = await runtime.beginReview(cwd, "review-run", "plan"); await seal(cwd, start.owner!, "blocked"); }
  await assert.rejects(runtime.beginReview(cwd, "review-run", "plan"), /budget exhausted/);
  if (process.platform !== "win32") await assert.rejects(runtime.start(cwd, "review-run", "baseline"), /blocked/);
  assert.equal((await runtime.status(cwd, "review-run")).state.receipts.length, 0);
});
test("concurrent review ownership, source changes and missing reviewer identity fail closed", async t => {
  const { cwd } = await fixture(t);
  const results = await Promise.allSettled([runtime.beginReview(cwd, "review-run", "plan"), runtime.beginReview(cwd, "review-run", "plan")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const start = (results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof runtime.beginReview>>>).value;
  await writeFile(join(cwd, "bench.mjs"), "console.log('changed');");
  const stale = await seal(cwd, start.owner!); assert.equal(stale.verdict, "error"); assert.match(stale.summary, /Baseline code changed/);
  await writeFile(join(cwd, "bench.mjs"), "console.log('HYPATIA_METRIC '+JSON.stringify({score:1}));");
  const fresh = await runtime.beginReview(cwd, "review-run", "plan");
  const result = await runtime.finishReview(cwd, "review-run", fresh.owner!, { verdict: "pass", summary: "Guess", findings: [], reviewer: null }); assert.equal(result.verdict, "error");
});
test("dead review host records interrupted evidence and tampered verdict/bundle is rejected", async t => {
  const { cwd, experiment } = await fixture(t);
  const first = await runtime.beginReview(cwd, "review-run", "plan");
  await lock(experiment.root, async () => { const current = await load(experiment.root); current.state.activeReview!.ownerPid = 99999999; await save(current, "fixture_dead_owner"); });
  const second = await runtime.beginReview(cwd, "review-run", "plan"); await seal(cwd, second.owner!);
  const state = await runtime.status(cwd, "review-run"); assert.equal(state.state.reviews![0]!.verdict, "error");
  const ref = state.state.reviews!.at(-1)!;
  await writeFile(join(experiment.root, `reviews/${ref.id}.json`), "{}");
  await assert.rejects(runtime.beginReview(cwd, "review-run", "plan"), /integrity/);
  assert.equal(first.owner!.bundlePath.startsWith("reviews/"), true);
});
test("review approval is required and evidence reads reject traversal and bound output", async t => {
  const { cwd, experiment } = await fixture(t);
  await lock(experiment.root, async () => { const current = await load(experiment.root); delete current.state.approval; await save(current, "fixture_unapprove"); });
  await assert.rejects(runtime.beginReview(cwd, "review-run", "plan"), /Approve/);
  await assert.rejects(runtime.readReviewFile(cwd, "../outside", 1, 200), /Unsafe/);
  await writeFile(join(cwd, "large.txt"), "A".repeat(100000));
  assert.ok((await runtime.readReviewFile(cwd, "large.txt", 1, 200)).length < 33000);
});

test("review receipt sealed before journal crash is recovered without replaying the reviewer", async t => {
  const { cwd, experiment } = await fixture(t);
  const first = await runtime.beginReview(cwd, "review-run", "plan"), owner = first.owner!;
  await writeFile(join(experiment.root, `reviews/${owner.id}.json`), JSON.stringify({ version: 1, id: owner.id, kind: "plan", contractHash: experiment.state.contractHash, bundleHash: owner.bundleHash, bundlePath: owner.bundlePath, verdict: "pass", summary: "Sealed synthetic fixture", findings: [], startedAt: new Date(owner.startedAt).toISOString(), endedAt: new Date().toISOString(), reviewer: { role: "critic", provider: "fixture", model: "synthetic", promptHash: "fixture" } }));
  await lock(experiment.root, async () => { const current = await load(experiment.root); current.state.activeReview!.ownerPid = 99999999; await save(current, "fixture_journal_crash"); });
  const recovered = await runtime.beginReview(cwd, "review-run", "plan");
  assert.equal(recovered.cached!.id, owner.id); assert.equal(recovered.owner, undefined);
  assert.equal(recovered.experiment.state.reviewAttempts!.plan, 1);
});
