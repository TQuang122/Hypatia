import { mkdir, readFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { safePath } from "./files.js";
import { verifyReceipt } from "./receipts.js";
import { verifyReviewHistory, verifyReview } from "./reviews.js";
import type { Experiment } from "./store.js";
import { writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
async function ownedWrite(path: string, content: string, marker: string): Promise<void> {
  const previous = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (previous !== undefined && !previous.startsWith(marker)) throw new Error("An unrelated report already uses this slug. Choose another experiment slug.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(temporary, content, { flag: "wx", mode: 0o600 }); await rename(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
}
export async function exportReport(experiment: Experiment): Promise<{ report: string; provenance: string }> {
  const { contract, state, root } = experiment;
  await verifyReviewHistory(experiment);
  const reviews = await Promise.all((state.reviews ?? []).map(ref => verifyReview(experiment, ref)));
  const reviewLines = reviews.length ? reviews.flatMap(review => [`- ${review.kind}: ${review.verdict} — ${review.summary}`, `  Reviewer: ${review.reviewer ? `${review.reviewer.role} · ${review.reviewer.provider}/${review.reviewer.model}` : "unavailable"}`, ...review.findings.map(finding => `  - ${finding.severity}: ${finding.message} [${finding.evidence}]`)]) : [`- ${contract.reviewPolicy === "required" ? "Required reviews are pending." : contract.reviewPolicy === "none" ? "Model reviews disabled by approved contract." : "Legacy contract: model reviews were not required."}`];
  const marker = `<!-- hypatia-experiment:${contract.experimentId} -->`;
  const receipts = await Promise.all(state.receipts.map(ref => verifyReceipt(root, ref, state.contractHash, contract.environmentFingerprint?.sha256)));
  const report = await safePath(contract.workspace, `outputs/${contract.slug}.md`);
  const provenance = await safePath(contract.workspace, `outputs/${contract.slug}.provenance.md`);
  const fingerprintLines = contract.environmentFingerprint
    ? [
        `Environment fingerprint SHA256: ${contract.environmentFingerprint.sha256}`,
        `Fingerprint host: ${contract.environmentFingerprint.platform}/${contract.environmentFingerprint.architecture}; Node ${contract.environmentFingerprint.runtimeVersion}`,
        `Declared frozen inputs SHA256: ${contract.environmentFingerprint.inputFilesHash}`,
      ]
    : ["Environment fingerprint: not recorded (legacy contract)."];
  const rows = state.receipts.map((ref, index) => {
    const receipt = receipts[index]!;
    return `| ${ref.kind} | ${ref.id} | ${ref.value ?? "unavailable"} | ${ref.valid ? "valid" : receipt.reason || "failed"} | ${ref.decision ?? (ref.kind === "baseline" ? "baseline" : "pending")} |`;
  });
  await ownedWrite(report, [
    marker,
    `# Experiment: ${contract.slug}`,
    "",
    contract.hypothesis,
    "",
    `State: ${state.state}. Outcome: ${state.outcome ?? "incomplete"}.`,
    `Metric: ${contract.metric.key} (${contract.metric.unit}, ${contract.metric.direction}); mean over frozen seeds ${contract.seeds.join(", ")}.`,
    "",
    ...fingerprintLines,
    "",
    "| Kind | Run | Observed metric | Evidence | Decision |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `Trial attempts: ${state.trialAttempts}/${contract.maxIterations}. Charged execution time: ${(state.spentMs / 1000).toFixed(1)}s/${contract.maxWallSeconds}s.`,
    "",
    "## Independent reviews",
    ...reviewLines,
    "",
    "Model review is advisory evidence, not a certificate of scientific validity. Gate passage records a schema-valid verdict against the exact evidence bundle.",
    "",
    "These are observed benchmark results under the saved contract. Scientific validity and generalization require research review; failed and reverted trials remain in the record.",
    "",
  ].join("\n"), marker);
  await ownedWrite(provenance, [
    marker,
    `# Provenance: ${contract.slug}`,
    "",
    `Experiment ID: ${contract.experimentId}`,
    `Contract SHA256: ${state.contractHash}`,
    `Contract: experiments/${contract.slug}/contract.json`,
    `Environment label: ${contract.environment}`,
    `Executable SHA256: ${contract.executableHash}`,
    ...fingerprintLines,
    "",
    "## Receipts",
    ...state.receipts.map((ref, index) => `- experiments/${contract.slug}/receipts/${ref.id}.json — SHA256 ${ref.hash}; environment fingerprint ${receipts[index]!.environmentFingerprint ?? "unrecorded"}; engine ${receipts[index]!.engineHash}; workspace revision ${receipts[index]!.workspaceRevision ?? "unavailable"}; code snapshot ${receipts[index]!.snapshot.hash}; time accounting ${receipts[index]!.timeAccounting}`),
    "",
    "## Reviews",
    ...reviews.map((review, index) => `- reviews/${review.id}.json — SHA256 ${state.reviews![index]!.hash}; bundle ${review.bundleHash}; role prompt ${review.reviewer?.promptHash ?? "unavailable"}; session ${review.reviewer?.sessionPath ?? "unavailable"}; reported tokens ${review.usage?.totalTokens ?? "unavailable"}; reported cost ${review.usage?.cost.total ?? "unavailable"}`),
    "",
    "Review model usage is separate from benchmark execution time; recorded usage is provider-reported.",
    "",
    "Receipt, snapshot and log hashes were checked while exporting. Fingerprints cover the saved environment label, host/runtime, executable and declared frozen input hashes; installed packages and arbitrary environment variables are not inventoried.",
    "",
  ].join("\n"), marker);
  return { report: relative(contract.workspace, report), provenance: relative(contract.workspace, provenance) };
}
