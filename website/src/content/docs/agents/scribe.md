---
title: Scribe
description: The scribe agent turns research notes into structured briefs and drafts.
section: Agents
order: 3
---

The scribe turns research files into a clear, structured document. It writes only from the evidence it is given and leaves citation to the auditor. Its definition lives in `.hypatia/agents/scribe.md`.

## What it does

The scribe reads the research files a workflow supplies and organizes them into a draft with an executive summary, themed sections, and an Open Questions section for unresolved issues, gaps, and disagreements between sources.

It does not introduce claims, tools, or sources that are not in the input files. Caveats and disagreements stay in the text, and tentative or inferred results are labeled as such. Missing results become gaps or TODOs, never plausible-looking data.

The scribe has file and shell tools only (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`); it has no search or fetch tools.

## Citations

The scribe does not add inline citations or a Sources section. The [auditor](/hypatia/docs/agents/auditor) adds both in a separate pass. Before finishing, the scribe checks that every strong factual statement has an obvious home in the research files.

## Visuals

The scribe uses Markdown tables for quantitative comparisons and Mermaid diagrams for architectures or pipelines, only when the supplied evidence supports them. Plots use source-backed data only, with the plotting script saved next to the draft. Every visual gets a caption that names its data source.

## Used by

The `/draft` workflow uses the scribe when the draft should be produced from already-collected notes, then runs the auditor on its output. Other workflows, including `/deepresearch`, have the lead agent write the draft directly.
