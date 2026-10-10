---
title: AlphaXiv
description: Search and read arXiv papers through Hypatia's alphaXiv integration.
section: Tools
order: 1
---

Hypatia bundles an alphaXiv client (`@companion-ai/alpha-hub`) for searching arXiv papers, reading AI-generated paper reports or full text, asking questions about a paper, and reading a paper's linked code. alphaXiv covers arXiv papers; DOI-only papers are read through web fetch or Europe PMC instead.

## Authentication

Sign in during `hypatia setup` or at any time:

```bash
hypatia alpha login
```

On a machine without a browser (SSH, Docker, WSL without a display), `hypatia alpha login` prints the sign-in URL. Open it in a browser on any machine and finish signing in. The browser then lands on a `http://127.0.0.1:9876/callback?code=...` page that fails to load; copy that full URL, paste it into the waiting terminal, and press Enter.

Check your authentication status:

```bash
hypatia alpha status
```

## Agent tools

`alpha_search`, `alpha_get_paper`, `alpha_ask_paper`, and `alpha_read_code` are available only when you are signed in; without an account, Hypatia searches papers through Semantic Scholar, OpenAlex, and the other literature databases instead. Start a new Hypatia session after `hypatia alpha login` to get them.

| Tool | Purpose |
| --- | --- |
| `alpha_search` | Search papers. Modes: `semantic` (default), `keyword`, `agentic`, `both`, `all` |
| `alpha_get_paper` | Fetch a paper's AI-generated report, or raw full text with `fullText`, plus any local annotation. `section` or `sections` return only abstract, introduction, methodology, experiments, results, discussion, limitations, or conclusion when detectable |
| `alpha_ask_paper` | Ask a targeted question about a paper's PDF |
| `alpha_read_code` | Read files from a paper's GitHub repository; `/` gives an overview |
| `alpha_annotate_paper` | Write or clear a local note on a paper |
| `alpha_list_annotations` | List local paper notes |

The lead agent calls these tools directly. The bundled evidence-scout does not load them; it runs `hypatia alpha ...` through its shell instead, after checking `hypatia alpha status`.

In chat, `alpha_search` shows a compact source, result-count, and recorded-duration summary. If alphaXiv falls back to OpenAlex, the summary names OpenAlex and shows the fallback reason. The `both` and `all` modes show separate group counts, which can overlap. `alpha_get_paper` shows a compact read summary and duration. Press `Ctrl+O` to expand the full result. `hypatia_science_database_search` uses the same compact display for the other literature sources, including source notes and errors.

## CLI

The same client is available from the terminal:

```bash
hypatia alpha search "scaling laws"
hypatia alpha get 2401.12345
hypatia alpha ask 2401.12345 "What optimizer did they use?"
hypatia alpha code https://github.com/org/repo src/model.py
```

## Storage

The alphaXiv client keeps its login state and local paper annotations under `~/.ahub`, separate from Hypatia's `~/.hypatia` directory. Remove `~/.ahub` to clear them during uninstall.

## Without AlphaXiv

Hypatia works without an alphaXiv login. Paper discovery then goes through `hypatia_science_database_search` (Semantic Scholar, OpenAlex, arXiv ID lookup, PubMed, Europe PMC, bioRxiv/medRxiv, Crossref, CORE, DOAB) and web search, and full text comes from `fetch_content` on arXiv or open-access pages.
