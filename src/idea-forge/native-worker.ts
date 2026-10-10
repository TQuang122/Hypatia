import { writeFile } from "node:fs/promises";
import { safePath, fileHash, exclusiveJson } from "../experiments/files.js";
import { loadGeneration, saveGeneration, lock } from "./store.js";
import { requestLedger, cacheHashes } from "./evidence.js";
import { verifyNativeBackend } from "./native-backend.js";
import { runNativePipeline, GenerationStopped } from "./native-pipeline.js";
import type { GenerationReceipt } from "./types.js";

export async function nativeWorker(root: string, token: string) {
  let run = await loadGeneration(root);
  if (run.state.active?.token !== token) return;
  const { id, startedAt } = run.state.active, deadline = startedAt + Math.max(0, run.spec.maxWallSeconds * 1000 - run.state.spentMs);
  const controller = new AbortController(); let paused = false, expired = false, complete = false, message = "", stdout = "", proposals = 0;
  const stop = () => { paused = true; controller.abort(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  const poll = setInterval(() => { void loadGeneration(root).then(current => {
    paused ||= current.state.status === "pause_requested" || current.state.active?.token !== token;
    expired ||= Date.now() >= deadline;
    if (paused || expired) controller.abort();
  }).catch(() => controller.abort()); }, 100);
  try {
    await verifyNativeBackend(run, controller.signal);
    if (run.state.status === "pause_requested") { paused = true; throw new GenerationStopped("Generation paused before model calls."); }
    const result = await runNativePipeline(run, controller.signal, deadline, event => { stdout += JSON.stringify(event) + "\n"; });
    proposals = result.proposals; complete = true;
  } catch (error) {
    message = error instanceof GenerationStopped ? error.message : "Native generation could not complete: model output, knowledge, authentication or evidence requires attention. Preserve this run and inspect model setup before retrying.";
  } finally { clearInterval(poll); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
  const out = `attempts/${id}/stdout.jsonl`, err = `attempts/${id}/stderr.log`;
  await writeFile(await safePath(root, out), stdout, { flag: "wx", mode: 0o600 });
  await writeFile(await safePath(root, err), "", { flag: "wx", mode: 0o600 });
  await lock(root, async () => {
    run = await loadGeneration(root); if (run.state.active?.token !== token) return;
    paused ||= run.state.status === "pause_requested";
    let requests = 0, journalHash: string | null = null, caches: Record<string, string> = {};
    try { const ledger = await requestLedger(root); requests = ledger.requests; journalHash = ledger.journalHash; caches = await cacheHashes(root); await verifyNativeBackend(run); }
    catch { complete = false; message = "Generation evidence or runtime configuration changed; cached responses cannot be reused."; }
    const checkpointHash = await fileHash(await safePath(root, "forge.json")).catch(() => null);
    const status = paused ? "paused" : expired || requests >= run.spec.maxRequests && !complete ? "budget_exhausted" : complete && checkpointHash ? "completed" : "blocked";
    const receipt: GenerationReceipt = { version: 1, id, contractHash: run.state.contractHash, status, elapsedMs: Math.max(0, Date.now() - startedAt), requests,
      checkpointHash, requestJournalHash: journalHash, cacheHashes: caches,
      message: complete ? `Generation completed with ${proposals} proposal(s); ideas and model reviews remain unverified.` : message || "Generation stopped.",
      startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(), logs: [{ path: out, hash: await fileHash(await safePath(root, out)) }, { path: err, hash: await fileHash(await safePath(root, err)) }] };
    await exclusiveJson(await safePath(root, `receipts/${id}.json`), receipt);
    run.state.receipts.push({ id, hash: await fileHash(await safePath(root, `receipts/${id}.json`)) }); run.state.spentMs += receipt.elapsedMs;
    run.state.status = status; run.state.message = receipt.message; delete run.state.active; await saveGeneration(run, "attempt_finished");
  });
}
