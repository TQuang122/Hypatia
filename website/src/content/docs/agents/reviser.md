---
title: Reviser
description: The reviser applies critic findings to a research draft as small, targeted edits.
section: Agents
order: 5
---

The reviser applies FATAL and MAJOR findings from the critic to a cited draft without regenerating it. Its definition lives in `.hypatia/agents/reviser.md`.

## What it does

Each finding receives one small edit. The reviser does not introduce claims, sources, numbers, or citations, and it leaves MINOR findings untouched unless the parent explicitly includes them.

If a finding needs restructuring, new evidence, or a rewritten section, the reviser escalates it rather than attempting a broad rewrite. A FATAL finding is either fixed or explicitly reported as unapplied.

## Used by

- `/deepresearch` -- applies FATAL and MAJOR findings after the critic's review
