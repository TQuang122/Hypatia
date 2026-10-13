# Local Laya paper-triage pilot

This standalone evaluator compares Laya with Jev or a named retrieval baseline on the same fixed query-candidate pool and trusted relevance labels. It does not change runtime behavior or discard candidates. Hypatia's separate `hypatia_laya_advisory` tool is opt-in with `HYPATIA_LAYA_ENABLED=1` and never changes the primary search order; see the configuration guide.

Candidate text is sent only to a Laya service bound to loopback. The first model request may download the Laya checkpoint from Hugging Face; candidate records are not uploaded to Hugging Face or another remote inference API. The evaluator rejects non-loopback URLs and redirects. Its result file contains IDs, labels, ranks, scores, metrics, and input hashes, but not titles, queries, or abstracts.

## Start the local service

Laya 0.4.1 supports Python 3.10 and newer. The following keeps its environment and model cache separate from Hypatia:

```sh
uv venv --python 3.13 /tmp/hypatia-laya-pilot-py313
uv pip install --python /tmp/hypatia-laya-pilot-py313/bin/python 'laya[serve]==0.4.1'
LAYA_HOST=127.0.0.1 \
LAYA_PORT=8000 \
LAYA_DEVICE=cpu \
LAYA_PRELOAD=0 \
LAYA_MODELS=english \
LAYA_DEFAULT_MODEL=english \
LAYA_THREADS=8 \
/tmp/hypatia-laya-pilot-py313/bin/laya-serve
```

Keep the host on `127.0.0.1`; the server otherwise binds to all network interfaces by default. `LAYA_API_KEY` is optional for a loopback-only run. If set, the evaluator reads the same environment variable and sends it only to the loopback service.

## Prepare a blinded Hypatia candidate pool

The local generator uses Hypatia's current science-database search implementation and the fixed questions in `evals/questions.jsonl`. By default it searches `q01`-`q06` and `q10`-`q12`, with up to 20 results per query:

```sh
node --import tsx evals/prepare-hypatia-laya-pool.mjs
```

For a separate held-out set, write a JSONL file with unique `id` and non-empty `question` fields, then pass `--questions-jsonl /path/to/heldout-questions.jsonl`. When this option is used without `--ids`, every manifest question is searched. The fixed `evals/questions.jsonl` should not be edited for new comparisons.

It writes `outputs/decision-model-systems-hypatia-labels.jsonl` and `outputs/decision-model-systems-hypatia-ranks.jsonl`. The label file is sorted by candidate ID and contains `relevance: null`; it intentionally omits retrieval ranks and expected-paper labels for blind annotation. Fill `relevance` with trusted human grades from 0 to 3, preserving candidate IDs. Keep the rank file unchanged; it records the original Hypatia science-database result order separately. Each candidate records its actual source so any fallback remains visible.

Use `--ids` to select a comma-separated subset, `--limit` to choose 1-20 results per query, and `--source semanticscholar|openalex` to choose the search source. The generator refuses to overwrite either output file. Candidates without abstracts are marked `abstract_missing`; inspect their source URL before assigning a grade rather than inferring irrelevance.

The reserved `q07`-`q09` held-out pool contains three query groups. To add 27 new real queries while preserving those fixed candidates, first prepare the additional pool with a separate manifest:

```sh
node --import tsx evals/prepare-hypatia-laya-pool.mjs \
  --questions-jsonl outputs/laya-hypatia-27-questions.jsonl \
  --labels-output outputs/laya-hypatia-27-labels.jsonl \
  --rankings-output outputs/laya-hypatia-27-ranks.jsonl \
  --source semanticscholar \
  --limit 20
```

Then combine it with the ungraded `q07`-`q09` files using `evals/merge-hypatia-laya-pools.mjs`. The merger refuses assigned grades, overlapping query IDs, duplicate candidates/ranks, and label-rank mismatches; its summary records both input hashes, source mix, per-query sizes, and output hashes. The merged primary label sheet stays blinded with every `relevance` set to `null`; a separate deterministic hash sample selects at least 20% of each query for a second annotator. Adjudicate every disagreement before creating the final `relevance` grades.

```sh
node evals/merge-hypatia-laya-pools.mjs \
  --existing-labels outputs/decision-model-systems-hypatia-heldout-labels.jsonl \
  --existing-rankings outputs/decision-model-systems-hypatia-heldout-ranks.jsonl \
  --additional-labels outputs/laya-hypatia-27-labels.jsonl \
  --additional-rankings outputs/laya-hypatia-27-ranks.jsonl \
  --labels-output outputs/laya-hypatia-30-labels.jsonl \
  --double-labels-output outputs/laya-hypatia-30-double-labels.jsonl \
  --rankings-output outputs/laya-hypatia-30-ranks.jsonl \
  --summary-output outputs/laya-hypatia-30-pool-summary.json
```

## Input format

Use JSONL or CSV. Each label row represents one candidate and includes:

| Field | Meaning |
|---|---|
| `query_id` | Stable query key |
| `candidate_id` | Stable candidate key, unique within a query |
| `query` | Research question |
| `title` | Candidate title |
| `abstract` | Candidate abstract; may be empty |
| `relevance` | Trusted grade: `0` not relevant, `1` partial, `2` relevant, `3` highly relevant |
| `retrieval_rank` | Optional inline rank for a named generic baseline |

Ranking metrics retain all four grades, with grades 1-3 counting as relevant. For Laya's binary "can this paper help answer the question?" decision, map grades 2-3 to useful (A) and grades 0-1 to not useful (B); grade 1 remains a partial match rather than a direct answer. Balance this binary target in the training split only, and leave held-out class prevalence unchanged.

For a Jev comparison, ranks can be an inline `jev_rank` column or a separate JSONL/CSV file with `query_id`, `candidate_id`, and `jev_rank`. The two files must describe exactly the same candidates, with unique ranks within each query.

For any other retrieval system, provide its name with `--baseline-name` and use one of these formats:

- Put ranks in the label file's `retrieval_rank` column for inline rankings.
- Provide `--baseline-rankings <jsonl-or-csv>` with a separate file containing `query_id`, `candidate_id`, and `baseline_rank`.

Separate rankings are joined to labels by the exact `query_id` and `candidate_id` pair; both files must contain exactly the same pairs. In either format, every candidate needs a positive, unique rank within its query. This generic mode reports `metrics.baseline` and `inputs.baseline` with the supplied name; candidate scores use `baselineRank`. It is not labeled Jev and cannot be combined with `--jev-rankings`. No training or threshold tuning is performed on these labels.

## Prepare and fine-tune on Hypatia labels

The existing nine-query human-labeled set can seed a training-only exploratory fit while a fresh holdout is being collected. This command balances the binary target and explicitly records that no held-out query evaluation exists:

```sh
node evals/prepare-laya-training-data.mjs \
  --training-only \
  --train-labels outputs/decision-model-systems-hypatia-labels-labeled.jsonl \
  --train-rankings outputs/decision-model-systems-hypatia-ranks.jsonl \
  --output-dir outputs/laya-hypatia-training-seed

~/.hypatia/laya-py313/bin/python evals/finetune_hypatia_laya.py \
  --train outputs/laya-hypatia-training-seed/train.jsonl \
  --output outputs/laya-hypatia-finetuned-seed \
  --device auto
```

Without `--holdout`, the runner measures A/B label-order sensitivity on training cases and labels it training-only. Its internal temperature fit is calibration evidence, not independent generalization evidence; this run cannot satisfy the frozen gate.

After collecting and double-labeling a new held-out candidate pool, keep it separate from the earlier nine-query training set. Prepare binary Laya data with query-disjoint splits, deterministic 1:1 class balancing on training rows only, and the original held-out prevalence:

```sh
node evals/prepare-laya-training-data.mjs \
  --holdout-labels outputs/laya-hypatia-holdout-labels.jsonl \
  --holdout-rankings outputs/laya-hypatia-holdout-ranks.jsonl \
  --output-dir outputs/laya-hypatia-training
```

The command writes `train.jsonl`, `holdout.jsonl`, and an audit `summary.json` with query IDs, per-split grade counts, input hashes, and output hashes. Grades 2-3 map to useful (A), while grades 0-1 map to not useful (B). It refuses query overlap and never balances or resamples the held-out candidates.

Fine-tune locally in the isolated Laya environment. The runner uses option-order augmentation, fits Laya's calibration temperature on its training calibration slice, evaluates the separate held-out file, and measures decision/probability sensitivity when the A/B labels are reversed:

```sh
~/.hypatia/laya-py313/bin/python evals/finetune_hypatia_laya.py \
  --train outputs/laya-hypatia-training/train.jsonl \
  --holdout outputs/laya-hypatia-training/holdout.jsonl \
  --output outputs/laya-hypatia-finetuned \
  --device auto
```

No model is uploaded. For the pinned Laya 0.4.1 environment, serve the output checkpoint through the repository wrapper, which injects a local `Router(models=...)` into `laya.serve.create_app()` and preloads only the selected checkpoint:

```sh
~/.hypatia/laya-py313/bin/python evals/serve_hypatia_laya.py \
  --checkpoint outputs/laya-hypatia-finetuned \
  --host 127.0.0.1 \
  --port 8000 \
  --device cpu
```

The wrapper re-points the built-in `english` name to the local checkpoint, so keep `HYPATIA_LAYA_MODEL=english`. The integration gate still decides whether any default search order may change.

## Run the comparison

Use `--jev-rankings` for a separate Jev rankings file:

```sh
node evals/laya-pilot.mjs \
  --labels /path/to/candidate-labels.jsonl \
  --jev-rankings /path/to/jev-ranks.jsonl \
  --base-url http://127.0.0.1:8000 \
  --output /path/to/new-laya-pilot-results.json
```

For inline generic ranks, include `retrieval_rank` in each label row and run:

```sh
node evals/laya-pilot.mjs \
  --labels /path/to/candidate-labels-with-retrieval-rank.jsonl \
  --baseline-name "Hypatia retrieval" \
  --base-url http://127.0.0.1:8000 \
  --output /path/to/new-laya-pilot-results.json
```

For a blinded annotation sheet and separate generic rankings, put `query_id`, `candidate_id`, and `baseline_rank` in the ranking file and run:

```sh
node evals/laya-pilot.mjs \
  --labels /path/to/blinded-labels.jsonl \
  --baseline-name "Hypatia retrieval order" \
  --baseline-rankings /path/to/hypatia-retrieval-ranks.jsonl \
  --base-url http://127.0.0.1:8000 \
  --output /path/to/new-laya-pilot-results.json
```

The output path must not already exist. Omit `--jev-rankings` when Jev ranks are inline, and omit `--baseline-rankings` when generic ranks are inline. Use `--cutoffs 5,10` to choose ranking cutoffs; `--timeout-ms` controls each local inference request.

The report includes macro-averaged P@k, recall@k, graded nDCG@k and MRR for Laya and the selected baseline, plus Laya's fixed-choice accuracy and Brier score. Generic baseline results appear under `metrics.baseline`; the report records the baseline name under both `metrics.baseline.name` and `inputs.baseline.name`, along with the ranking field and separate-file hash when applicable. P@k divides by the smaller of k and the number of candidates for that query; metrics are averaged per query, so larger candidate pools do not dominate. Laya's probability is treated as a ranking score, not a calibrated confidence claim. Any truncated candidate is listed by ID.

After scoring, the evaluator reads `/health` and requires the loaded English checkpoint revision. The report records that revision and the server's measured device so the result is tied to the model that actually answered.

## Measure warm advisory latency

With a preloaded loopback service, repeat one fixed 20-candidate query to obtain a warm p95, candidate-success rate, and truncation rate:

```sh
node --import tsx evals/measure-laya-advisory-latency.mjs \
  --labels outputs/decision-model-systems-hypatia-heldout-labels.jsonl \
  --query-id q07 \
  --base-url http://127.0.0.1:8000 \
  --model english \
  --repeats 30 \
  --output outputs/laya-hypatia-runtime-latency-smoke.json
```

The command performs one excluded warm-up, then records 30 warm requests and exact input hashes. This single-query diagnostic is latency/reliability evidence only; it does not satisfy the 30-query relevance-quality gate.
