# Hypatia product facts for the subagent preview

Checked: 2026-10-07

This preview uses the current local website and agent documentation as its source of truth. A web search for the public GitHub project did not return a usable official result, so no current release or version claims are used here.

## Product

- Hypatia is described by the local website as a research-first agent shell that wraps stock Pi and supports research workflows.
- Workflow prompts may call bundled subagents when delegation helps. Narrow tasks can remain lead-owned; the page must not suggest that all five agents run on every request or that they always run as a fixed pipeline.
- The five local agent docs are `website/src/content/docs/agents/{auditor,evidence-scout,scribe,critic,reviser}.md`.

## Agent roles used in the preview

| Site name | Supported role summary |
|---|---|
| Auditor | Adds inline citations, checks source URLs and whether sources support the attached claims, and removes unsupported material. |
| Evidence Scout | Searches paper databases and the web, reads relevant sources, and writes a structured evidence file for synthesis. |
| Scribe | Turns supplied research files into a structured draft while preserving caveats and open questions; does not add claims or sources. |
| Critic | Reviews novelty, clarity, empirical rigor, and reproducibility; returns severity-graded findings and a revision plan. |
| Reviser | Applies FATAL and MAJOR critique findings with targeted edits; does not add claims, numbers, sources, or citations. |

The user-provided image supplies the visual reference for the five illustrated roles. Its labels and portraits are treated as artwork/reference, while copy comes from the local agent docs.

## Homepage workflows used in the new preview

The command names and descriptions below are copied from `website/src/pages/index.astro`; the preview does not add new workflow capabilities.

| Command | Current page description |
|---|---|
| `/deepresearch` | Plan-first investigation across papers, web, and code, with parallel evidence scouts when the topic needs them. |
| `/lit` | Literature review from primary sources with consensus mapping. |
| `/review` | Internal research critique with severity scores and a revision plan. |
| `/audit` | Paper-to-code mismatch audit for reproducibility claims. |
| `/replicate` | Replication plan with environment choice before any execution. |
| `/recipe` | Ranked ML training recipes grounded in papers, datasets, docs, and code. |
| `/compare` | Side-by-side source comparison with agreement and conflict matrix. |
| `/draft` | Polished paper-style draft with inline citations from findings. |
| `/autoresearch` | Bounded loop: hypothesize, experiment, measure, repeat. |
| `/summarize` | Summarizes papers, reports, READMEs, local artifacts, and PDFs; longer inputs use bounded-window reading while short inputs can be read directly. |

These descriptions are presented as independent commands; the page does not claim they must run in a fixed order.
