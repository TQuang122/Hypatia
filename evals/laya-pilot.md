# Local Laya paper-triage pilot

This standalone evaluator compares Laya with Jev or a named retrieval baseline on the same fixed query-candidate pool and trusted relevance labels. It does not change runtime behavior or discard candidates. Hypatia's separate runtime integration is opt-in with `HYPATIA_LAYA_ENABLED=1`; see the configuration guide.

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

For a Jev comparison, ranks can be an inline `jev_rank` column or a separate JSONL/CSV file with `query_id`, `candidate_id`, and `jev_rank`. The two files must describe exactly the same candidates, with unique ranks within each query.

For any other retrieval system, provide its name with `--baseline-name` and use one of these formats:

- Put ranks in the label file's `retrieval_rank` column for inline rankings.
- Provide `--baseline-rankings <jsonl-or-csv>` with a separate file containing `query_id`, `candidate_id`, and `baseline_rank`.

Separate rankings are joined to labels by the exact `query_id` and `candidate_id` pair; both files must contain exactly the same pairs. In either format, every candidate needs a positive, unique rank within its query. This generic mode reports `metrics.baseline` and `inputs.baseline` with the supplied name; candidate scores use `baselineRank`. It is not labeled Jev and cannot be combined with `--jev-rankings`. No training or threshold tuning is performed on these labels.

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
