---
title: AlphaXiv
description: Search and read arXiv papers through Hypatia's alphaXiv integration.
section: Tools
order: 1
---

Hypatia uses AlphaXiv's public HTTP endpoints for semantic/keyword discovery and paper reading, so those operations work without an AlphaXiv account. Public discovery also supports publication-date filters, ranking preferences, result limits, and a fast title-lookup mode. Hypatia can resolve a paper to GitHub implementations linked by AlphaXiv; this returns repository metadata, while reading repository files remains account-backed. The bundled `@companion-ai/alpha-hub` client remains for agentic search, PDF Q&A, and GitHub code reading. AlphaXiv covers arXiv papers; DOI-only papers are read through web fetch or Europe PMC instead.

## Authentication

Login is optional. Sign in to enable agentic search, PDF Q&A, and GitHub code reading, either during `hypatia setup` or at any time:

```bash
hypatia alpha login
```

On a machine without a browser (SSH, Docker, WSL without a display), `hypatia alpha login` prints the sign-in URL. Open it in a browser on any machine and finish signing in. The browser then lands on a `http://127.0.0.1:9876/callback?code=...` page that fails to load; copy that full URL, paste it into the waiting terminal, and press Enter.

Check the optional account features' authentication status:

```bash
hypatia alpha status
```

## Agent tools

`alpha_search`, `alpha_get_paper`, and `alpha_find_implementations` are available without login. Search modes include semantic, keyword, both, and fast title lookup. Semantic/keyword discovery accepts `publishedAfter`, `publishedBefore`, `prioritize` (`historical`, `default`, `recency`, or `popular`), and `limit` (1–200; default 15); title mode accepts the output limit. The limit controls how many returned candidates Hypatia emits; AlphaXiv's server-side candidate pool is fixed. Paper reading fetches the public Markdown report and falls back to extracted text when the report is absent. `agentic` and `all` search modes, `alpha_ask_paper`, and `alpha_read_code` need an AlphaXiv login. Start a new Hypatia session after `hypatia alpha login` to load those account-backed tools.

| Tool | Purpose |
| --- | --- |
| `alpha_search` | Public modes: `semantic` (default), `keyword`, `both`, `title`; discovery accepts date/ranking/output-limit options, title mode accepts an output limit. Account-backed modes: `agentic`, `all` |
| `alpha_get_paper` | Fetch a public AlphaXiv report or raw extracted text with `fullText`, plus any local annotation. `section` or `sections` return requested paper sections when detectable |
| `alpha_find_implementations` | Resolve a paper and list its public GitHub implementations, with repository stars and author/community source when available |
| `alpha_ask_paper` | Ask a targeted question about a paper's PDF (login required) |
| `alpha_read_code` | Read files from a paper's GitHub repository (login required); `/` gives an overview |
| `alpha_annotate_paper` | Write or clear a local note on a paper |
| `alpha_list_annotations` | List local paper notes |

The lead agent calls these tools directly. The bundled evidence-scout does not load them; it runs public semantic/keyword search with `hypatia alpha search` through its shell. Agentic search still requires `hypatia alpha login`.

In chat, `alpha_search` shows a compact source, result-count, and recorded-duration summary. If alphaXiv falls back to OpenAlex, the summary names OpenAlex and shows the fallback reason. The `both` and `all` modes show separate group counts, which can overlap. `alpha_get_paper` shows a compact read summary and duration. Press `Ctrl+O` to expand the full result. `hypatia_science_database_search` uses the same compact display for the other literature sources, including source notes and errors.

## CLI

Public search and paper reading are available from the terminal without login. Agentic search and PDF Q&A/code inspection use the optional account-backed client:

```bash
hypatia alpha search "scaling laws"
hypatia alpha search --mode title "Attention Is All You Need"
hypatia alpha search --published-after 2025-01-01 --prioritize recency --limit 20 "long-context retrieval"
hypatia alpha implementations 2401.12345
hypatia alpha get 2401.12345
hypatia alpha search --mode agentic "efficient attention mechanisms"
hypatia alpha ask 2401.12345 "What optimizer did they use?"
hypatia alpha code https://github.com/org/repo src/model.py
```

## Storage

Optional AlphaXiv login state and local paper annotations are stored under `~/.ahub`, separate from Hypatia's `~/.hypatia` directory. Public search and paper reading do not use this login state. Remove `~/.ahub` to clear the account state and annotations during uninstall.

## If AlphaXiv is unavailable

If AlphaXiv's public endpoints are unavailable, `alpha_search` falls back to OpenAlex and known-paper reads fall back to arXiv metadata and abstract. Other paper discovery remains available through `hypatia_science_database_search` (Semantic Scholar, OpenAlex, arXiv ID lookup, PubMed, Europe PMC, bioRxiv/medRxiv, Crossref, CORE, DOAB) and web search.
