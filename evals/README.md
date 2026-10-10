# Research-quality evals

A small fixed eval for Hypatia's research workflows. It runs `/lit` (or `/deepresearch`) on each question in `questions.jsonl`, then scores the artifacts with deterministic checks against arXiv, Crossref and doi.org. No LLM judge.

This directory is not in the npm package (`package.json` `files` does not list it).

## Rule

Run the eval before and after any change to prompts (`prompts/`, `.hypatia/agents/`, `.hypatia/SYSTEM.md`, `skills/`), tools, extensions, or the Pi version. Use the same model and question ids for both runs, and commit both result files with the change.

## Run

Build first (`npm ci && npm run build`). Each question gets a fresh temp workspace and its own `HYPATIA_HOME`; it never writes to the real `~/.hypatia`. The model's provider comes from a `models.json` that is copied into each isolated home. If a role route file exists at `$HYPATIA_HOME/.hypatia/agent/model-routes.json` (default: `~/.hypatia/agent/model-routes.json`), the runner copies it into each isolated home too. The isolated runs do not read the rest of the real Hypatia home. Example for an OpenAI-compatible gateway (the key is read from the environment and never written to disk):

```json
{
  "providers": {
    "ferrylane-openai": {
      "baseUrl": "https://gateway.ferrylane.ai/v1",
      "api": "openai-responses",
      "apiKey": "$FERRYLANE_API_KEY",
      "models": [
        { "id": "gpt-5.6-terra", "reasoning": true, "input": ["text"], "contextWindow": 400000, "maxTokens": 64000 }
      ]
    }
  }
}
```

```sh
export FERRYLANE_API_KEY="$(cat ~/.ferrylane/api-key)"
node evals/run.mjs --model ferrylane-openai/gpt-5.6-terra --models-json /path/to/models.json \
  [--model-routes-json /path/to/model-routes.json | --no-model-routes] \
  [--ids q01,q04] [--workflow lit|deepresearch] [--concurrency 2] [--timeout-min 45] \
  [--results-dir /path/to/eval-results]
```

Built-in providers work the same way; pass their API key env var (for example `OPENAI_API_KEY`) and omit `--models-json`.

For Pi OAuth providers, pass the auth store explicitly with `--auth-json "$HOME/.hypatia/agent/auth.json"`. The runner copies it into each isolated home with mode `0600`, then removes it once the model process and detached subagents have exited. The original auth store is read-only to the runner. Use this only with a trusted local eval run; an interrupted process may leave its isolated work directory for manual cleanup.

To run locally held benchmark prompts, provide a JSONL manifest with unique safe `id` and non-empty `question` fields; `key_papers` is optional:

```sh
node evals/run.mjs --model <provider/model> --questions-jsonl /path/to/local-questions.jsonl \
  --workflow lit|deepresearch|audit [--ids case01,case02] \
  [--model-routes-json /path/to/model-routes.json | --no-model-routes]
```

The runner does not copy the manifest into the repository. `/audit` final reports are discovered by the `*-audit.md` output name and do not need a provenance sidecar; other workflows still require one. If a manifest omits `key_papers`, the generic expected-paper recall is `null` and the benchmark-specific lane scorer supplies its metric separately.

By default, an existing route file under the active `HYPATIA_HOME` is used. `--model-routes-json` selects another route file; `--no-model-routes` disables the default. The two options cannot be combined. Each result row records `model_routes_source` and the route JSON in `model_routes`, so the profile used for a run can be compared or replayed.

`--workflow deepresearch` sends one approval turn (`--continue`) after the plan gate. `--rescore evals/results/<file>.jsonl` re-scores the kept workdirs without rerunning Hypatia, which is useful after a scorer change.

Output goes to `evals/results/<date>-<workflow>-<model>.jsonl` by default; `--results-dir` changes that destination. Each row records git SHA, dirty flag, Hypatia version, scores, citation failures, total usage, `usage_by_role` with actual child models/tokens/costs, `model_routes_source`, the exact `model_routes` JSON copied into the run, and the `workdir` (under `~/.cache/hypatia-evals/` by default, `--work-root` to change) holding the full workspace, session JSONL and `hypatia.log`. The paired `.md` file includes per-role usage and cost tables.

Role attribution comes from Pi subagent result metadata (`agent`, actual `model`, and `usage`). Duplicate child results repeated by `subagent` and `bg_wait` are counted once by session file/run step. Missing model or usage metadata is reported as unknown/zero, not inferred from the requested model.

## Scores

| Column | Meaning |
|---|---|
| `done` | A final `outputs/<slug>.md` exists with its `outputs/<slug>.provenance.md` sidecar. |
| `cites` | Distinct arXiv IDs and DOIs in the final output. |
| `valid` | Share of those identifiers that resolve (arXiv API `id_list`; Crossref, falling back to the doi.org handle API for non-Crossref DOIs). Lookups that fail on the network are left out. Unresolvable IDs are listed in `unresolved`. |
| `title` | Among resolved IDs with a known title, the share that match the output: the resolved title is at least 60% present (by word tokens) on a line that carries the ID, or, for author-year citations, the resolved first author's surname is on that line. Low values flag IDs attached to the wrong paper; see `title_mismatch`. Short-name citations ("When2Think, arXiv:…") also miss, so read the listed rows before calling something a hallucination. |
| `recall` | Share of the question's expected key papers that appear in the final output, by any listed identifier or by exact normalized title. 0 when there is no final output. |
| `wall`, `tokens`, `cost` | Wall time for the whole run, and token and cost totals summed over every Pi session file in the isolated home and temp dir (parent and subagent sessions, deduplicated). Cost is 0 when the provider's `models.json` entry has no `cost` block. |

The first baseline, `results/2026-09-23-lit-ferrylane-openai_claude-sonnet-5.*`, ran q01, q04, q07 and q10 on Hypatia 0.5.0. It used `claude-sonnet-5` through the Ferrylane gateway because the gateway's GPT quota was exhausted that day.

Treat a single run as noisy. Compare before and after on the same ids, and look at the listed failures rather than only the percentages.

## Questions

`questions.jsonl` has 12 questions, each with expected key papers and a `source`:

- `q01`–`q06`: the six queries from Hypatia's paper-discovery search benchmark (test-time compute, speculative decoding, sparse autoencoders, CRISPR base editing, mixture of experts, RAG).
- `q07`–`q09`: verbatim questions from LitQA2 ([futurehouse/lab-bench](https://huggingface.co/datasets/futurehouse/lab-bench), CC-BY-SA-4.0). The key paper is the item's `sources` DOI. These three items are redistributed under CC-BY-SA-4.0 with that attribution.
- `q10`–`q12`: hand-authored topics outside ML and biology (econometrics, weather forecasting, cosmology) whose key papers are unambiguous.

Keep the set fixed. Adding or editing a question breaks comparison with earlier result files; if you must, bump the question id instead of reusing one.

## External benchmark score lanes

`score-lane.mjs` aggregates per-sample scores or judge records produced by the corresponding official evaluator. It does not download benchmark records, call judge models, or scrape cited pages. Keep model output, evaluator judgment, model/role metadata, and cost/usage rows together so A/B comparisons can be reproduced.

```sh
node evals/score-lane.mjs --lane scholarqa-cs2 --input /path/astabench-scores.jsonl [--split validation]
node evals/score-lane.mjs --lane deepresearch-fact --input /path/fact-judgments.jsonl
node evals/score-lane.mjs --lane scicoqa --input /path/scicoqa-judgments.jsonl --gold-ids /path/scicoqa-v1.1-real-ids.json
```

The input is JSONL with one record per evaluated sample/report/judgment. Every lane groups by `model` and optional `role` (missing role is `workflow`); preserve those fields from the corresponding `evals/run.mjs` run. Output is a JSON summary on stdout and can also be saved with `--output`.

### ScholarQA-CS2 / AstaBench (`/lit`)

Provide per-sample scores from the official AstaBench `ScholarQA_CS2_validation` evaluator:

```json
{"id":"sample-id","model":"provider/model","role":"evidence-scout","scores":{"ingredient_recall":0.8,"answer_precision":0.7,"citation_precision":0.9,"citation_recall":0.6}}
```

The adapter reports the four official component means, mean per-sample citation F1, and `global_avg` (the equal-weight mean of the four configured metrics). It does not recreate the AstaBench LLM judge. The data revision is pinned in the summary. The official `allenai/asta-bench` dataset is gated and its current terms prohibit redistribution; obtain access and review its terms yourself, keep data local, and use the validation split for tuning. Do not commit dataset rows or judge prompts from the gated release.

Sources: [AstaBench v1.0.0 validation config](https://github.com/allenai/asta-bench/blob/a9e338070ffff195cb4cc5ddcbcf9ca8805f141d/astabench/config/v1.0.0.yml), [ScholarQA-CS2 scorer](https://github.com/allenai/asta-bench/blob/a9e338070ffff195cb4cc5ddcbcf9ca8805f141d/astabench/evals/sqa/citation_eval.py), [dataset card and access terms](https://huggingface.co/datasets/allenai/asta-bench).

### DeepResearch Bench FACT (`/deepresearch`)

The adapter accepts one original FACT output row per report; it aggregates claim labels in `citations_deduped`:

```json
{"id":"report-id","model":"provider/model","role":"auditor","citations":[{"id":"[1]"}],"citations_deduped":{"https://example.org/source":{"validate_error":null,"validate_res":[{"result":"supported"},{"result":"unknown"}]}}}
```

`citation_accuracy` is supported / (supported + unsupported), excluding `unknown`; `effective_citations_per_task` counts zero-citation reports as zero. `official_style_effective_citations_per_cited_report` matches the pinned repository's current denominator, which excludes reports with no citations. Unsupported output status, unknown judgments, and fetch errors remain separate counts. Original FACT depends on LLM extraction/judging and live Jina Reader page retrieval; this summary is reproducible only for frozen judge/page results and is not a deterministic local judge. The source and dataset revisions are pinned in the output. Do not confuse the original 2025 benchmark with DRB II.

Sources: [original DeepResearch Bench paper](https://arxiv.org/abs/2506.11763), [FACT statistics](https://github.com/Ayanami0730/deep_research_bench/blob/f2735b5c3636759c22f9e936c0232de8bf545b67/utils/stat.py), [FACT judgment validator](https://github.com/Ayanami0730/deep_research_bench/blob/f2735b5c3636759c22f9e936c0232de8bf545b67/utils/validate.py), [Apache-2.0 dataset card](https://huggingface.co/datasets/muset-ai/DeepResearch-Bench-Dataset).

### SciCoQA real discrepancy recall (`/audit`)

Use the official v1.1 real split: provide its 92 unique `discrepancy_id` values as a local JSON string array with `--gold-ids`. Judgment rows use:

```json
{"model":"provider/model","role":"evidence-scout","discrepancy_id":"<gold-id>","origin":"real","code_only":false,"eval_type":"eval","reference_available":true,"answer":"yes"}
```

Rows must come from the official discrepancy matcher. The adapter deduplicates hits by `discrepancy_id`, ignores synthetic/code-only rows and judgments against empty references, and divides by the fixed v1.1 denominator of 92. It does not run the LLM matcher. The dataset is CC BY 4.0; this repository does not vendor records. Preserve attribution and keep paper/code snapshots aligned with the official version.

Sources: [SciCoQA ACL paper](https://aclanthology.org/2026.acl-long.1795/), [v1.1 dataset card/schema](https://huggingface.co/datasets/UKPLab/scicoqa/blob/6f598056828ae90cbee7a47f9e4f96a71e39c69d/README.md), [official recall implementation](https://github.com/UKPLab/scicoqa/blob/463162906459be508ed4a2294fcaede9fa072036/scicoqa/evaluation/compute_recall.py), [data license](https://github.com/UKPLab/scicoqa/blob/463162906459be508ed4a2294fcaede9fa072036/data/README.md).
