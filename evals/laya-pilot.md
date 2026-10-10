# Local Laya paper-triage pilot

This evaluator compares Laya with Jev on the same fixed query-candidate pool and trusted relevance labels. It is evaluation-only: it does not change Hypatia's search tools or discard candidates.

Candidate text is sent only to a Laya service bound to loopback. The first model request may download the Laya checkpoint from Hugging Face; candidate records are not uploaded to Hugging Face or another remote inference API. The evaluator rejects non-loopback URLs and redirects. Its result file contains IDs, labels, ranks, scores, metrics, and input hashes, but not titles, queries, or abstracts.

## Start the local service

Laya 0.4.0 supports Python 3.10 and newer. The following keeps its environment and model cache separate from Hypatia:

```sh
uv venv --python 3.13 /tmp/hypatia-laya-pilot-py313
uv pip install --python /tmp/hypatia-laya-pilot-py313/bin/python 'laya[serve]==0.4.0'
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

Jev ranks can be an inline `jev_rank` column or a separate JSONL/CSV file with `query_id`, `candidate_id`, and `jev_rank`. The two files must describe exactly the same candidates, with unique ranks within each query. No training or threshold tuning is performed on these labels.

## Run the comparison

```sh
node evals/laya-pilot.mjs \
  --labels /path/to/candidate-labels.jsonl \
  --jev-rankings /path/to/jev-ranks.jsonl \
  --base-url http://127.0.0.1:8000 \
  --output /path/to/new-laya-pilot-results.json
```

The output path must not already exist. Omit `--jev-rankings` when ranks are included in the label file. Use `--cutoffs 5,10` to choose ranking cutoffs; `--timeout-ms` controls each local inference request.

The report includes macro-averaged P@k, recall@k, graded nDCG@k and MRR for both Laya and Jev, plus Laya's fixed-choice accuracy and Brier score. P@k divides by the smaller of k and the number of candidates for that query; metrics are averaged per query, so larger candidate pools do not dominate. Laya's probability is treated as a ranking score, not a calibrated confidence claim. Any truncated candidate is listed by ID.

After scoring, the evaluator reads `/health` and requires the loaded English checkpoint revision. The report records that revision and the server's measured device so the result is tied to the model that actually answered.
