---
name: citation-export
description: Export the Sources section of a cited research draft to a BibTeX (.bib) file. Use when the user needs machine-readable citations for LaTeX, a reference manager, or a paper appendix.
---

# Citation Export

Turn an auditor-cited draft (`outputs/.drafts/<slug>-cited.md` with `[N]` citations and a Sources section) into `outputs/<slug>.bib`.

Workflow:

1. Extract every Sources entry with its citation number, title, and any DOI, arXiv ID, or ISBN.
2. Resolve each entry to canonical metadata with `hypatia_science_database_search` (`crossref` for DOIs, `arxiv` for arXiv IDs, `doab` for books). Prefer the version of record; record which version was matched.
3. Emit one BibTeX entry per source with a stable deterministic key (`authorYearVenue`, e.g. `vaswani2017attention`). Escape LaTeX special characters in titles.
4. Flag entries that cannot be resolved (no DOI/ID found) in the output instead of inventing metadata. Flag retracted matches.
5. Write `outputs/<slug>.bib` and report: resolved count, unresolved entries, retraction flags.

Output: `outputs/<slug>.bib` plus a short resolution report.
