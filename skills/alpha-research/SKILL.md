---
name: alpha-research
description: Search, read, and query research papers via Hypatia's alphaXiv-backed alpha tools. Use when the user asks about academic papers, wants to find research on a topic, needs to read a specific paper, ask questions about a paper, inspect a paper's code repository, or manage paper annotations.
---

# Alpha Research CLI

Use visible Hypatia alpha tools when they are available. For shell commands, use `hypatia alpha ...`; do not call the user's bare global `alpha` binary because it can be stale.

## Commands

| Command | Description |
|---------|-------------|
| `hypatia alpha search "<query>"` | Public semantic search; no login required. |
| `hypatia alpha search --mode keyword "<query>"` | Public exact-term search; no login required. |
| `hypatia alpha search --mode both "<query>"` | Run public semantic and keyword search separately; no login required. |
| `hypatia alpha search --mode title "<paper title>"` | Fast public title lookup; no login required. |
| `hypatia alpha search --published-after YYYY-MM-DD --published-before YYYY-MM-DD --prioritize recency --limit 20 "<query>"` | Filter public discovery by date and ranking; output limit is 1–200 (default 15). |
| `hypatia alpha search --mode agentic "<query>"` | Broader account-backed retrieval; login required. |
| `hypatia alpha get <arxiv-id-or-url>` | Fetch public paper content and any local annotation; no login required. |
| `hypatia alpha get --full-text <arxiv-id>` | Get raw extracted text instead of the report; no login required. |
| `hypatia alpha implementations <arxiv-id-or-url>` | List public GitHub implementations linked to a paper; no login required. |
| `hypatia alpha ask <arxiv-id> "<question>"` | Ask a question about a paper's PDF; login required. |
| `hypatia alpha code <github-url> [path]` | Read files from a paper's GitHub repo; login required. Use `/` for overview. |
| `hypatia alpha annotate <paper-id> "<note>"` | Save a persistent annotation on a paper |
| `hypatia alpha annotate --clear <paper-id>` | Remove an annotation |
| `hypatia alpha annotate --list` | List all annotations |

## Auth

Login is optional for search and paper reading. Run `hypatia alpha login` for agentic search, PDF Q&A, and GitHub code reading. Check that optional account status with `hypatia alpha status`.

## Examples

```bash
hypatia alpha search "transformer scaling laws"
hypatia alpha search --mode title "Attention Is All You Need"
hypatia alpha search --published-after 2025-01-01 --prioritize recency --limit 20 "long-context retrieval"
hypatia alpha search --mode agentic "efficient attention mechanisms for long context"
hypatia alpha get 2106.09685
hypatia alpha implementations 2106.09685
hypatia alpha ask 2106.09685 "What optimizer did they use?"
hypatia alpha code https://github.com/karpathy/nanoGPT src/model.py
hypatia alpha annotate 2106.09685 "Key paper on LoRA - revisit for adapter comparison"
```

## When to use

- Academic paper search, reading, Q&A → Hypatia alpha tools or `hypatia alpha`
- Current topics (products, releases, docs) → web search tools
- Mixed topics → combine both
