---
name: alpha-research
description: Search, read, and query research papers via Hypatia's alphaXiv-backed alpha tools. Use when the user asks about academic papers, wants to find research on a topic, needs to read a specific paper, ask questions about a paper, inspect a paper's code repository, or manage paper annotations.
---

# Alpha Research CLI

Use visible Hypatia alpha tools when they are available. For shell commands, use `hypatia alpha ...`; do not call the user's bare global `alpha` binary because it can be stale.

## Commands

| Command | Description |
|---------|-------------|
| `hypatia alpha search "<query>"` | Search papers. Prefer `--mode semantic` by default; use `--mode keyword` only for exact-term lookup and `--mode agentic` for broader retrieval. |
| `hypatia alpha get <arxiv-id-or-url>` | Fetch paper content and any local annotation |
| `hypatia alpha get --full-text <arxiv-id>` | Get raw full text instead of AI report |
| `hypatia alpha ask <arxiv-id> "<question>"` | Ask a question about a paper's PDF |
| `hypatia alpha code <github-url> [path]` | Read files from a paper's GitHub repo. Use `/` for overview |
| `hypatia alpha annotate <paper-id> "<note>"` | Save a persistent annotation on a paper |
| `hypatia alpha annotate --clear <paper-id>` | Remove an annotation |
| `hypatia alpha annotate --list` | List all annotations |

## Auth

Run `hypatia alpha login` to authenticate with alphaXiv. Check status with `hypatia alpha status`.

## Examples

```bash
hypatia alpha search "transformer scaling laws"
hypatia alpha search --mode agentic "efficient attention mechanisms for long context"
hypatia alpha get 2106.09685
hypatia alpha ask 2106.09685 "What optimizer did they use?"
hypatia alpha code https://github.com/karpathy/nanoGPT src/model.py
hypatia alpha annotate 2106.09685 "Key paper on LoRA - revisit for adapter comparison"
```

## When to use

- Academic paper search, reading, Q&A → Hypatia alpha tools or `hypatia alpha`
- Current topics (products, releases, docs) → web search tools
- Mixed topics → combine both
