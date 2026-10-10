---
name: dataset-finder
description: Find and rank datasets for a replication or ML task by requirements, license, and availability. Use when the user needs training or evaluation data and asks which dataset to use.
---

# Dataset Finder

Turn a task description into a ranked dataset shortlist with access paths.

Workflow:

1. Pin requirements first: task type, modality, minimum size, license constraints, and needed splits (train/dev/test).
2. Search Hugging Face datasets (`hf_dataset_info` and related tools) plus web search for gated or domain-specific sources (Kaggle, Papers with Code, official releases).
3. Evaluate each candidate: license compatibility with the user's use, size and split availability, recency and maintenance status, and adoption in comparable work.
4. Record a ranked table (dataset, source URL or ID, license, size/splits, why it fits or does not) as an artifact. Never recommend scraping a gated or login-walled source without saying so.
5. Hand the top pick to `replication` or `ml-training-recipe` with its access path and license note.

Agents used: `evidence-scout` (for broad dataset sweeps)

Output: ranked dataset table in `outputs/`.
