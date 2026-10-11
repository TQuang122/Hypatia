# Laya search-reranking acceptance gate

This protocol is frozen before scoring the held-out labels. The earlier nine-query Laya pilot is development evidence only and must not be included in the held-out aggregate.

## Held-out set

- Use query IDs not scored in the earlier Laya pilot. The first reserved candidates are `q07`-`q09`; these are a small smoke set, not enough to enable Laya by default.
- Require at least 30 distinct held-out queries before considering a default-on decision. Report the domain/source mix and the number of candidates per query.
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

## Runtime contract

- Laya is called only for topical paper-discovery searches, behind an explicit opt-in setting.
- Exact identifiers, citation/reference lookups, author/venue lookups, and full-text retrieval are not reranked.
- The candidate set is never reduced. Original rank and source provenance remain available after reranking.
- Any health, timeout, HTTP, or response-validation failure preserves the full original order and returns a visible status explaining that Laya was skipped.
- Candidate text is sent only to the configured loopback service. Telemetry must not include query text, titles, abstracts, or tool arguments.
