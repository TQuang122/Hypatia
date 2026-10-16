# Laya search-reranking acceptance gate

This protocol is frozen before scoring the held-out labels. The earlier nine-query Laya pilot is development evidence only and must not be included in the held-out aggregate.

## Held-out set

- Use query IDs not scored in the earlier Laya pilot. The first reserved candidates are `q07`-`q09`; these are a small smoke set, not enough to enable Laya by default.
- Require at least 30 distinct held-out queries before considering a default-on decision. Report the domain/source mix and the number of candidates per query.
- Assign whole query IDs to training, calibration, or held-out splits before sampling candidate rows; no query may appear in more than one split. For the binary training target, grades 2-3 mean useful and grades 0-1 mean not useful. Balance training classes only, and report per-split grade counts without rebalancing the held-out set.
- For new questions, use a separate JSONL manifest with one `{"id":"...","question":"..."}` record per line and pass it with `--questions-jsonl`; do not edit the fixed `evals/questions.jsonl` comparison set.
- Keep one fixed candidate pool per query and compare Laya with the original retrieval order on exactly the same candidates.
- Keep expected-paper keys and original ranks out of the blinded annotation file.
- Grade relevance from 0 (not relevant) to 3 (highly relevant). Double-label at least 20% of rows and adjudicate disagreements before unblinding ranks.
- Resolve missing abstracts from the source record when possible. Otherwise retain the row, mark it title-only, and report its metrics separately; never label it irrelevant solely because its abstract is absent.

## Frozen acceptance criteria

Laya remains opt-in unless every default-on criterion below passes:

1. Primary metric: macro nDCG@10 improves by at least `0.03` absolute over the named source-order baseline, and a query-level paired bootstrap 95% confidence interval for the improvement has a lower bound above zero.
2. Regression guard: no more than 10% of held-out queries regress by `0.10` or more nDCG@10.
3. Service reliability: at least 99% of candidate scores are returned successfully, and no more than 5% of candidates are truncated.
4. Runtime cost: warm-service p95 added latency is at most 10 seconds for a 20-candidate result set on the tested CPU host. Report cold-start separately.

If the minimum query count, label-quality check, or any acceptance criterion is unmet, report the result as inconclusive or failed and keep default behavior unchanged.

## Public benchmark amendment (2026-10-11)

The user selected a public benchmark instead of supplying 27 more Hypatia queries. Use the released SciFact `claims_dev.jsonl` evidence annotations and `corpus.jsonl`; do not use SciFact test labels, which the upstream project says are not public. Exclude query IDs `1`, `3`, `5`, `13`, and `36` from the earlier smoke. Exclude claims with no evidence qrels (112 in the downloaded dev file), then select 30 remaining claims deterministically with seed `hypatia-laya-scifact-dev-20261011`.

Build one fixed candidate pool per claim from the SciFact corpus using BM25 over title plus abstract (`k1=1.2`, `b=0.75`, document-ID ascending tie break), top 20. Evidence document IDs from the claim's released `evidence` map receive qrel score 1; other retrieved documents receive 0. The reported result is specific to SciFact claim-evidence retrieval and must not be described as representative of Hypatia's general user workload. This public-qrels route uses the dataset's published evidence annotations instead of creating new double labels; keep that provenance and limitation visible.

For this route, keep all numeric default-on thresholds above. Compute a deterministic paired query bootstrap for nDCG@10 with 10,000 resamples and seed `20261011`; use the 2.5th and 97.5th percentile bounds.

## Hypatia-history benchmark amendment (2026-10-13)

The user subsequently chose to continue with an actual Hypatia-query evaluation. This amendment supersedes the 2026-10-11 SciFact route for the current run; keep the SciFact protocol above as historical context. The current held-out artifact is `outputs/laya-hypatia-30-abstracts-labels.jsonl`, with ranks in `outputs/laya-hypatia-30-abstracts-ranks.jsonl`.

The 30 groups are reserved `q07`-`q09` plus `q13`-`q39`. The 27 new questions came from recorded Hypatia science-database search calls in local sessions (historical tool queries, not necessarily verbatim user messages). Candidate pools were regenerated with OpenAlex keyword search and licensed abstracts enabled; `q32` uses a broader retrieval override because the original phrase returned one candidate. The final pool has 582 candidates, 293 with abstracts and 289 title-only. `q09` has only two candidates and must be reported as low-information.

The 117-row duplicate sample was independently graded by a second annotator. Primary and duplicate grades agree exactly on 74/117 rows (63.2%) and at the useful/not-useful threshold on 97/117 (82.9%); quadratic weighted Cohen's kappa is 0.609. A separate AI reviewer, blinded to both human grades and retrieval ranks, adjudicated the 43 exact-grade disagreements. Its decisions are recorded in `outputs/laya-hypatia-30-ai-adjudication.jsonl`; the evaluation input is `outputs/laya-hypatia-30-adjudicated-labels.jsonl`. Preserve the raw human files and report that arbitration was AI-assisted, not human consensus. Report the topic/session clustering of the historical queries and include a session-cluster sensitivity analysis before considering automatic reordering.

## Current run result (2026-10-13)

The adjudicated 30-query holdout scored 582 candidates against OpenAlex keyword retrieval order. Laya macro nDCG@10 was 0.7394 versus 0.7576 for the baseline (delta -0.0182); the frozen query-bootstrap 95% interval was [-0.0475, 0.0111]. Four of 30 queries regressed by at least 0.10 (13.3%). Both quality criteria fail.

All 582 candidates were scored successfully; 4 were truncated (0.69%). The 30-trial warm 20-candidate p95 was 1.713 seconds. Reliability and latency pass, but the default-on gate fails because ranking quality and the regression guard fail. A corrected session-cluster bootstrap over 10 clusters gave a 95% interval of [-0.0366, -0.0070], also negative. The abstract-present stratum had nDCG@10 0.8482 versus 0.8693; the title-only stratum had 0.8947 versus 0.8536.

The fine-tuning report also records a temperature of 5 (the calibration clamp) fitted on 12 items, held-out fixed-choice accuracy dropping from 0.8230 before fine-tuning to 0.3351 after, and 34/582 option-order decision flips (5.84%). Keep Laya advisory-only and disabled by default; do not reorder search results. Full results and run details are in `outputs/laya-hypatia-30-verification.md`.

## Runtime contract

- Laya is called only through the explicit opt-in advisory tool for topical paper-discovery results.
- Exact identifiers, citation/reference lookups, author/venue lookups, and full-text retrieval are not reranked.
- The primary search result is never reordered or reduced. The advisory tool returns a separate suggested order with original ranks and source provenance.
- Any health, timeout, HTTP, truncation, or response-validation failure preserves the full original order and returns a visible status explaining that Laya advice is unavailable.
- Automatic result reordering remains disabled until every frozen default-on quality and latency criterion passes.
- Candidate text is sent only to the configured loopback service. Telemetry must not include query text, titles, abstracts, or tool arguments.

## Assistant fallback re-evaluation (2026-10-13)

The user did not provide the 20 final grades after the review request timed out, then explicitly asked to proceed on best judgment. The original human review sheet remains blank. A separate assistant fallback was used for the rerun; it is neither a user annotation nor a fully blind adjudication because the coordinator had previously seen the human labels. Raw primary and duplicate labels remain unchanged, and the assistant resolutions are traceable in `outputs/laya-hypatia-20-assistant-review.jsonl` and `outputs/laya-hypatia-30-assistant-final-labels-summary.json`.

The 582-candidate holdout was scored with the same frozen CPU checkpoint (`local-sha256:67ff5dc22c7144cad62848683f9eb7a624cffcb55a6ead2c3ee181bf45495294`). No training or tuning used the holdout. Macro nDCG@10 was 0.7417 versus 0.7578 for OpenAlex order (delta -0.0161); the query-bootstrap 95% interval was [-0.0440, 0.0123]. Four of 30 queries regressed by at least 0.10 (13.3%). All 582 candidates were scored; four were truncated (0.69%). The 30-trial warm 20-candidate p95 was 1.516 seconds with all requests successful. Session-cluster sensitivity over ten clusters was [-0.0358, -0.0037].

The quality delta, confidence-interval, and query-regression criteria fail. Keep Laya advisory-only and disabled by default. Artifacts: `outputs/laya-hypatia-30-assistant-final-results.json`, `outputs/laya-hypatia-30-assistant-final-latency-retry.json`, and `outputs/laya-hypatia-30-assistant-session-bootstrap.json`.
