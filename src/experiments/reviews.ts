import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { alive, exclusiveJson, fileHash, json, objectHash, safePath } from "./files.js";
import { audit, verifyEnvironment } from "./lifecycle.js";
import { better, verifyReceipt } from "./receipts.js";
import { snapshot } from "./snapshots.js";
import { experimentRoot, load, lock, save, type Experiment } from "./store.js";
import { record, type ReviewKind, type ReviewOwner, type ReviewRecord, type ReviewRef, type ReviewVerdict } from "./schema.js";
export const REVIEW_TIMEOUT_MS = 180_000;
export const REVIEW_MAX_ATTEMPTS = 3;
export function projectedOutcome(experiment: Experiment): NonNullable<Experiment["state"]["outcome"]> {
  const { state, contract } = experiment;
  const baseline = state.receipts.find(ref => ref.id === state.baselineId), best = state.receipts.find(ref => ref.id === state.bestId);
  return !baseline ? "failed" : state.trialAttempts >= contract.maxIterations || state.spentMs >= contract.maxWallSeconds * 1000 ? "budget_exhausted" : state.trialAttempts === 0 ? "baseline_only" : better(best!.value!, baseline.value!, contract.metric) ? "positive" : "negative";
}
export async function reviewBundle(experiment: Experiment, kind: ReviewKind) {
  const { contract, state } = experiment;
  const base = { version: 1, kind, contractHash: state.contractHash, contract, baselineCodeHash: contract.baselineCodeHash };
  if (kind === "plan") return base;
  if (state.active || state.receipts.some(ref => ref.kind === "trial" && !ref.decision)) throw new Error("Settle active benchmarks and trial decisions before auditing results.");
  if (!state.receipts.length) throw new Error("An auditor needs observed run evidence.");
  const receipts = await Promise.all(state.receipts.map(async ref => ({ ...ref, receipt: await verifyReceipt(experiment.root, ref, state.contractHash, experiment.contract.environmentFingerprint?.sha256) })));
  const codeHash = (await snapshot(contract)).hash;
  const best = receipts.find(ref => ref.id === state.bestId);
  if (best && codeHash !== best.receipt.snapshot.hash) throw new Error("Scoped code differs from the best kept snapshot; reconcile it before audit/close.");
  return { ...base, codeHash, receipts, baselineId: state.baselineId ?? null, bestId: state.bestId ?? null,
    trialAttempts: state.trialAttempts, baselineAttempts: state.baselineAttempts, spentMs: state.spentMs,
    outcome: projectedOutcome(experiment),
    claimBoundary: "Observed mean over frozen seeds only. No claim of statistical significance, novelty, scientific validity, or generalization.",
    planReview: state.reviews?.filter(ref => ref.kind === "plan").at(-1) ?? null };
}
export function validateReviewVerdict(value: unknown, bundleHash: string): ReviewVerdict {
  if (!record(value) || value.version !== 1 || value.bundleHash !== bundleHash || !["pass", "blocked"].includes(String(value.verdict))) throw new Error("Review must use schema 1 and bind to the exact evidence bundle hash.");
  if (Object.keys(value).some(key => !["version", "bundleHash", "verdict", "summary", "findings"].includes(key))) throw new Error("Unexpected review verdict field.");
  if (typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 10000) throw new Error("Review summary is required and must be bounded.");
  if (!Array.isArray(value.findings) || value.findings.length > 100) throw new Error("Review findings must be a bounded array.");
  for (const finding of value.findings) {
    if (!record(finding) || !["fatal", "major", "minor"].includes(String(finding.severity)) || Object.keys(finding).some(key => !["severity", "evidence", "message"].includes(key)) || [finding.evidence, finding.message].some(text => typeof text !== "string" || !text.trim() || text.length > 10000)) throw new Error("Every finding needs severity, evidence reference and message.");
  }
  if (value.verdict === "pass" && value.findings.some(f => f.severity !== "minor")) throw new Error("Unresolved fatal/major findings cannot pass a review gate.");
  return value as unknown as ReviewVerdict;
}
export async function verifyReview(experiment: Experiment, ref: ReviewRef): Promise<ReviewRecord> {
  const path = await safePath(experiment.root, `reviews/${ref.id}.json`);
  if (await fileHash(path) !== ref.hash) throw new Error("Review receipt integrity check failed.");
  const result = await json<ReviewRecord>(path, 2 * 1024 * 1024);
  if (result.id !== ref.id || result.kind !== ref.kind || result.contractHash !== experiment.state.contractHash || result.bundleHash !== ref.bundleHash || result.verdict !== ref.verdict) throw new Error("Review receipt binding changed.");
  if (objectHash(await json(await safePath(experiment.root, result.bundlePath), 4 * 1024 * 1024)) !== ref.bundleHash) throw new Error("Review evidence bundle changed.");
  if (result.verdict !== "error") validateReviewVerdict({ version: 1, bundleHash: result.bundleHash, verdict: result.verdict, summary: result.summary, findings: result.findings }, ref.bundleHash);
  if (result.verdict === "pass" && (!result.reviewer?.provider || !result.reviewer.model || !result.reviewer.promptHash || result.reviewer.role !== (ref.kind === "plan" ? "critic" : "auditor"))) throw new Error("A passed review must record the actual reviewer identity.");
  return result;
}
export async function verifyReviewHistory(experiment: Experiment): Promise<void> {
  for (const ref of experiment.state.reviews ?? []) await verifyReview(experiment, ref);
}
export async function reviewStatus(experiment: Experiment, kind: ReviewKind): Promise<{ hash: string; current?: ReviewRecord }> {
  const hash = objectHash(await reviewBundle(experiment, kind));
  const ref = experiment.state.reviews?.filter(item => item.kind === kind && item.bundleHash === hash).at(-1);
  return { hash, ...(ref ? { current: await verifyReview(experiment, ref) } : {}) };
}
export async function requireReviewGate(experiment: Experiment, kind: ReviewKind): Promise<void> {
  if (experiment.contract.reviewPolicy !== "required") return;
  await verifyReviewHistory(experiment);
  const status = await reviewStatus(experiment, kind);
  if (status.current?.verdict !== "pass") throw new Error(`${kind === "plan" ? "Critic contract" : "Auditor result"} review ${status.current?.verdict ?? "required"}. Use hypatia_experiment action review (${kind}) or Continue in chat. ${status.current?.summary ?? ""}`);
}
async function seal(experiment: Experiment, owner: ReviewOwner, result: Omit<ReviewRecord, "version" | "id" | "kind" | "contractHash" | "bundleHash" | "bundlePath" | "startedAt" | "endedAt">): Promise<ReviewRecord> {
  let receipt: ReviewRecord = { ...result, version: 1, id: owner.id, kind: owner.kind, contractHash: experiment.state.contractHash, bundleHash: owner.bundleHash, bundlePath: owner.bundlePath, startedAt: new Date(owner.startedAt).toISOString(), endedAt: new Date().toISOString() };
  const path = await safePath(experiment.root, `reviews/${owner.id}.json`);
  await exclusiveJson(path, receipt).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    // Recover a sealed receipt whose journal append was interrupted.
    receipt = await json<ReviewRecord>(path, 2 * 1024 * 1024);
  });
  const ref: ReviewRef = { id: owner.id, kind: owner.kind, bundleHash: owner.bundleHash, verdict: receipt.verdict, hash: await fileHash(path) };
  await verifyReview(experiment, ref);
  (experiment.state.reviews ??= []).push(ref);
  delete experiment.state.activeReview;
  await save(experiment, "review_finished");
  return receipt;
}
export async function beginReview(workspace: string, name: string, kind: ReviewKind) {
  const root = await experimentRoot(workspace, name);
  return lock(root, async () => {
    const experiment = await load(root), { state } = experiment;
    if (state.state === "completed" || state.active) throw new Error("Reviews require an open experiment with no active benchmark.");
    if (["paused", "pause_requested"].includes(state.state)) throw new Error("Resume the experiment before requesting a review.");
    if (state.approval?.contractHash !== state.contractHash) throw new Error("Approve the contract before spending reviewer model usage.");
    if (state.activeReview) {
      if (alive(state.activeReview.ownerPid)) throw new Error("A reviewer still owns this experiment; cancel/wait for that review before retrying.");
      await seal(experiment, state.activeReview, { verdict: "error", summary: "Review host stopped before sealing a verdict; no approval inferred.", findings: [], reviewer: null });
    }
    await verifyEnvironment(experiment); await audit(experiment); await verifyReviewHistory(experiment);
    if (kind === "audit") await requireReviewGate(experiment, "plan");
    const bundle = await reviewBundle(experiment, kind), bundleHash = objectHash(bundle);
    const status = await reviewStatus(experiment, kind);
    if (status.current?.verdict === "pass") return { experiment, cached: status.current, bundle, bundleHash };
    if ((state.reviewAttempts?.[kind] ?? 0) >= REVIEW_MAX_ATTEMPTS) throw new Error("Persisted review attempt budget exhausted (three attempts per gate). Export the incomplete report or create a revised contract.");
    if (kind === "plan" && !state.baselineId && (await snapshot(experiment.contract)).hash !== experiment.contract.baselineCodeHash) throw new Error("Baseline code changed; create a revised contract before reviewing it.");
    await mkdir(await safePath(root, "reviews"), { recursive: true });
    const id = randomUUID(), bundlePath = `reviews/${id}.input.json`;
    if (Buffer.byteLength(JSON.stringify(bundle)) > 4 * 1024 * 1024) throw new Error("Review bundle exceeds 4 MiB; export evidence for a bounded manual investigation.");
    await exclusiveJson(await safePath(root, bundlePath), bundle);
    const owner: ReviewOwner = { id, token: randomUUID(), kind, bundleHash, bundlePath, ownerPid: process.pid, startedAt: Date.now() };
    state.activeReview = owner;
    (state.reviewAttempts ??= {})[kind] = (state.reviewAttempts?.[kind] ?? 0) + 1;
    await save(experiment, "review_started");
    return { experiment, owner, bundle, bundleHash };
  });
}
export async function finishReview(workspace: string, name: string, owner: ReviewOwner, result: Parameters<typeof seal>[2]): Promise<ReviewRecord> {
  const root = await experimentRoot(workspace, name);
  return lock(root, async () => {
    const experiment = await load(root);
    if (experiment.state.activeReview?.token !== owner.token) throw new Error("Stale reviewer ownership.");
    try {
      await verifyEnvironment(experiment); await audit(experiment);
      if (owner.kind === "plan" && !experiment.state.baselineId && (await snapshot(experiment.contract)).hash !== experiment.contract.baselineCodeHash) throw new Error("Baseline code changed while the critic was reviewing.");
      if (objectHash(await reviewBundle(experiment, owner.kind)) !== owner.bundleHash) throw new Error("Evidence changed while the reviewer was running.");
      if (result.verdict !== "error") validateReviewVerdict({ version: 1, bundleHash: owner.bundleHash, verdict: result.verdict, summary: result.summary, findings: result.findings }, owner.bundleHash);
      if (result.verdict !== "error" && (!result.reviewer?.provider || !result.reviewer.model || !result.reviewer.promptHash || result.reviewer.role !== (owner.kind === "plan" ? "critic" : "auditor"))) throw new Error("Reviewer identity is missing.");
    } catch (error) {
      result = { ...result, verdict: "error", summary: error instanceof Error ? error.message : String(error), findings: [] };
    }
    return seal(experiment, owner, result);
  });
}
