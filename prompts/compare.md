---
description: Compare multiple sources with relevant project wiki leads and produce a source-grounded matrix of agreements, disagreements, and confidence.
args: <topic>
section: Research Workflows
topLevelCli: true
---
Compare sources for: $@

Derive a short slug from the comparison topic (lowercase, hyphens, no filler words, ≤5 words). Use this slug for all files in this run.

## Project wiki context (read-only)

Before planning, check whether this workspace has `wiki/`. If both `wiki/README.md` and `wiki/index.md` exist, read them and follow only relevant indexed links to pages under `wiki/concepts/` and `wiki/sources/`. Do not scan the wiki or read `wiki/.proposals/`. Treat wiki pages as prior synthesis and navigation leads, not evidence; verify relevant claims against their original sources. Record the wiki page paths consulted in the plan and final comparison. Never initialize or modify the wiki during `/compare`.

Requirements:
- Before starting, outline the comparison plan: which sources to compare, which dimensions to evaluate, expected output structure. Write the plan to `outputs/.plans/<slug>.md`. Briefly summarize the plan to the user and continue immediately. Do not ask for confirmation or wait for a proceed response unless the user explicitly requested plan review.
- Use the `evidence-scout` subagent to gather source material when the comparison set is broad, and the `auditor` subagent to verify sources and add inline citations to the final matrix. Before delegating, write a per-evidence-scout brief with the exact relevant wiki page paths, each relevant claim and its status, source ID and original URL, and the comparison question to verify; the scout must verify original sources and record consulted wiki paths. If no pages apply, state that in the brief.
- Build a comparison matrix covering: source, key claim, evidence type, caveats, confidence.
- Use a Markdown table for quantitative metrics and Mermaid for method or architecture comparisons when the structure is source-supported.
- Distinguish agreement, disagreement, and uncertainty clearly.
- Save exactly one comparison to `outputs/<slug>-comparison.md`.
- End with a `Sources` section containing direct URLs for every source used.
