import { fileHash, json, safePath } from "./files.js";
import { record, type Metric, type Receipt, type ReceiptRef } from "./schema.js";
import { verifySnapshot } from "./snapshots.js";
export function parseMetric(text: string, metric: Metric): number {
  let raw = text;
  if (metric.source === "stdout") {
    const lines = text.split(/\r?\n/).filter(line => line.startsWith("HYPATIA_METRIC "));
    if (lines.length !== 1) throw new Error("Benchmark stdout must contain exactly one HYPATIA_METRIC JSON record per seed.");
    raw = lines[0]!.slice("HYPATIA_METRIC ".length);
  }
  let value: unknown = JSON.parse(raw);
  for (const key of metric.key.split(".")) { if (!record(value) || !Object.hasOwn(value, key)) throw new Error(`Metric ${metric.key} is missing.`); value = value[key]; }
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Observed metric must be a finite JSON number.");
  return value;
}
export async function verifyReceipt(
  root: string,
  ref: ReceiptRef,
  contractHash: string,
  environmentFingerprint?: string,
): Promise<Receipt> {
  const path = await safePath(root, `receipts/${ref.id}.json`);
  if (await fileHash(path) !== ref.hash) throw new Error(`Receipt checksum mismatch: ${ref.id}`);
  const receipt = await json<Receipt>(path);
  if (receipt.version !== 1 || receipt.id !== ref.id || receipt.contractHash !== contractHash || receipt.valid !== ref.valid || receipt.value !== ref.value || receipt.kind !== ref.kind) throw new Error("Receipt/state binding failed.");
  if (environmentFingerprint !== undefined && receipt.environmentFingerprint !== environmentFingerprint) throw new Error("Receipt environment fingerprint binding failed.");
  await verifySnapshot(root, receipt.snapshot);
  for (const seed of receipt.seeds) for (const artifact of seed.artifacts) if (await fileHash(await safePath(root, artifact.path)) !== artifact.sha256) throw new Error(`Run artifact changed: ${artifact.path}`);
  return receipt;
}
export function better(candidate: number, reference: number, metric: Metric): boolean { return metric.direction === "min" ? candidate < reference : candidate > reference; }
