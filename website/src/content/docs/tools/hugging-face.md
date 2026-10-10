---
title: Hugging Face Hub
description: Inspect Hugging Face datasets and repository files during research workflows.
section: Tools
order: 3
---

Hypatia includes read-only Hugging Face Hub tools for grounding ML recipes and replication plans. They help the evidence-scout verify whether a dataset or repo actually exposes the files, splits, schema, and card metadata needed for implementation.

These tools are grounded in Hugging Face's public [Hub API endpoint docs](https://huggingface.co/docs/hub/api). Authentication follows the `HF_TOKEN` environment variable documented by [`huggingface_hub`](https://huggingface.co/docs/huggingface_hub/main/en/package_reference/environment_variables).

## Authentication

Public Hub resources work without configuration. For private or gated resources, set an access token in your shell before launching Hypatia:

```bash
export HF_TOKEN=hf_...
```

If `HF_TOKEN` is unset, Hypatia uses `HUGGINGFACE_HUB_TOKEN`. The token is sent with every Hub request.

## Tools

The lead agent and the evidence-scout can call these tools:

| Tool | Purpose |
| --- | --- |
| `hf_dataset_info` | Inspect dataset metadata, tags, access status (private, gated, disabled), card data, `dataset_info` features and splits, downloads, likes, and sibling files |
| `hf_repo_files` | List files in a model, dataset, or Space repository (default 200 entries, max 1000) before reading anything large |
| `hf_repo_read_file` | Read small text files from Hub repos, such as `README.md`, configs, examples, and scripts |

`hf_repo_files` and `hf_repo_read_file` default to dataset repos; pass `repoType: "model"` or `"space"` for others. The file reader returns 20,000 characters by default (max 60,000) and is intended for text files only. It is not a weight downloader or dataset bulk reader. It refuses model weight files, archives, and dataset shards such as `.safetensors`, `.bin`, `.gguf`, `.parquet`, `.zip`, and `.tar` before download.

## Where it is used

The `/recipe` workflow uses `hf_dataset_info` to validate dataset availability and schema, and `hf_repo_files` and `hf_repo_read_file` to ground implementation details, before recommending a training recipe. The evidence-scout can use the same tools in any workflow that delegates ML evidence gathering to it, such as `/replicate`.

For example, a recipe using a chat SFT dataset should verify that the dataset has a `messages`, `text`, or prompt/completion-style schema before calling it usable. If Hypatia cannot check that schema, the final artifact should mark the dataset as `unverified` or `blocked`.

## Boundaries

These tools are read-only. They do not create repos, upload files, start jobs, or manage private data. If an experiment needs execution on Hugging Face infrastructure, Hypatia records that as a follow-up implementation decision.
