---
title: Slash Commands
description: Complete reference for REPL slash commands.
section: Reference
order: 2
---

Slash commands are available inside the Hypatia REPL. They map to research workflows, project utilities, and commands from the bundled Pi packages. Type `/help` inside the REPL for Hypatia's grouped command list.

In a new chat, the welcome logo gives way to a compact list of research commands after your first interaction. The list stays visible while you draft and hides after you send. Type `/` for autocomplete; `/help` opens a picker that prefills your selection without sending it.

## Research workflows

| Command | Description |
| --- | --- |
| `/deepresearch <topic>` | Run a thorough, source-heavy investigation and produce a research brief with inline citations |
| `/lit <topic-or-lab-or-author>` | Run a literature review on a topic, lab, PI, or author |
| `/review <artifact>` | Run an internal research critique with likely objections, severity, and a concrete revision plan |
| `/audit <item>` | Compare a paper's claims against its public codebase for mismatches, omissions, and reproducibility risks |
| `/replicate <paper>` | Plan a replication workflow for a paper, claim, or benchmark; execute only after an explicit environment choice |
| `/recipe <task-or-paper>` | Find ranked, implementable ML training recipes backed by papers, datasets, docs, and code |
| `/compare <topic>` | Compare multiple sources and produce a matrix of agreements, disagreements, and confidence |
| `/draft <topic>` | Turn research findings into a paper-style draft |
| `/autoresearch <idea>` | Run persistent benchmark experiments with approved contracts, observed receipts and pause/resume |
| `/summarize <source>` | Summarize a paper, report, README, local artifact, or PDF with the source kept on disk instead of in context |

Workflow prompts can call the bundled agents (evidence-scout, scribe, auditor, critic, reviser) through Pi's `subagent` tool when delegation helps; narrow tasks stay lead-owned.

## Project and session

| Command | Description |
| --- | --- |
| `/log` | Write a durable session log with completed work, findings, open questions, and next steps |
| `/help` | Search grouped Hypatia commands, inspect a concise detail view, and prefill the composer without sending |
| `/init` | Bootstrap `AGENTS.md` and session-log folders for a research project |
| `/idea <research goal>` | Generate bounded research ideas in chat with native Idea Forge; use the mouse wheel or arrow keys to move through the model selector |
| `/experiments` | Native idea creation, experiment setup, review gates, receipts, pause/resume, trees and provenance |
| `/outputs` | Browse grouped reports, provenance, drafts, and other artifacts in one searchable TUI; preview text, open a related file, copy its path, or read it in chat |
| `/sources` | Browse citations from the latest answer in a scrollable panel; arrows or the mouse wheel move through sources, `/` filters, Enter opens, `c` copies the URL, and Esc closes |
| `/compare-provenance` | Compare recorded source coverage and verification metadata from two completed research runs |
| `/wiki [init|ingest <source>|apply <proposal>|query <question>|lint]` | Maintain a project-local Markdown wiki with source-linked, reviewable updates |
| `/compact [instructions]` | Compact older context while retaining observed citations, evidence states, artifact paths, and next steps |
| `/tree` | Navigate session branches; chosen branch summaries preserve the research hypothesis and evidence |
| `/model-routes` | Configure ordered subagent models and choose Pi-override or parent-model inheritance |
| `/tools` | Browse public research tools with their source and parameter summary |
| `/service-tier` | View or set the provider service tier override for supported models |

### Project research wiki

The wiki lives in `wiki/` inside the current workspace; it is separate from session logs, reports, and Hypatia's global memory. `/wiki init` creates `README.md`, `index.md`, `log.md`, and empty `sources/` and `concepts/` folders without replacing an existing wiki. `/wiki ingest <source>` reads a source and any matching provenance sidecar, then writes a proposed set of source/concept page changes under `wiki/.proposals/`. It does not modify canonical pages.

Review a proposal, then run `/wiki apply <proposal>` to inspect the affected paths and confirm before applying it. `/wiki query <question>` uses the index and relevant pages as a navigation layer, while answers cite original source URLs or identifiers. `/wiki lint` checks local links, orphan pages, source metadata, and claims missing source references without editing files. A wiki synthesis is not primary evidence; retain disagreements and mark provisional or superseded claims explicitly.

When the workspace has relevant wiki pages, `/lit`, `/deepresearch`, `/compare`, and `/replicate` read indexed pages as read-only leads and record the paths in their plans or provenance. If they delegate to an evidence-scout, the lead passes selected page paths, claim statuses, and original source URLs in the scout brief; the scout verifies the original sources and records the wiki pages it consulted. `/idea` can freeze up to 12 selected concept/source pages (128 KiB total) with their hashes in the generation contract; pending proposals are excluded and the approval view lists the selected pages.

While subagents are active, Hypatia shows their role, model, current tool, and elapsed time in a panel above the composer. Press `Ctrl+Shift+A` to collapse or expand it.

During `/lit` and `/deepresearch`, the live progress widget tracks search, reading, synthesis, and verification only when the corresponding parent or subagent runtime activity is observed. Its source total counts distinct records returned to the parent runtime, deduplicated by available DOI/arXiv or other IDs, URL, or title; records without identifying fields count per result row. Search results kept inside a subagent are not included until Pi returns them to the parent. The total does not imply that every source was read or verified.

## Reading research outputs

`/outputs` groups files under `papers/`, `outputs/`, `experiments/`, and `notes/` into Reports, Provenance, Drafts, and Other artifacts. Reports are offered first, and each group is sorted newest first. The responsive browser filters by title/path, previews a bounded text excerpt, and switches between a report and its matching provenance sidecar. Press Enter to open the full reader, `p` to switch to the paired file, `c` to copy its path, or `r` to prefill the path in chat. Group labels describe file locations/types; they do not certify completion or verification.

Selecting Markdown opens a local reader; other supported text formats open as plain text. Use arrows, Page Up/Page Down, Home/End, or the fullscreen mouse wheel to scroll. `/` or `Ctrl+F` opens a literal, case-insensitive search of rendered text; Enter applies it, and `n`/`N` moves between matching rows. Escape cancels search editing, then returns from the reader to the list.

Press `p` to switch to a report/provenance sidecar with the same stem in the same directory, when present. Press `c` to copy the current file's absolute path through Pi's clipboard support. Local viewing/copying does not submit a model request or replace composer text. **Read in chat**, or `r` in the reader, explicitly prefills the file path; you review and submit the prompt yourself.

Previews are limited to 2 MiB. PDFs and files over that limit offer Copy path and Read in chat. Artifact discovery skips symlinks; previews stay inside the workspace's research folders. Clipboard availability follows the terminal/platform's support.

## Package commands

| Command | Package | Description |
| --- | --- | --- |
| `/btw <question>` | `pi-btw` | Ask a side question while the main research agent is busy |
| `/search` | `pi-web-access` | Browse stored web search results from the current session |
| `/websearch [queries]` | `pi-web-access` | Open the search curator to run and review searches yourself |
| `/curator [on\|off]` | `pi-web-access` | Toggle the search curator workflow |
| `/subagents` | `pi-subagents` | Inspect configured agents |
| `/run <agent> [task] [--bg] [--fork]` | `pi-subagents` | Run one agent |
| `/hotkeys`, `/new`, `/quit` | Pi | Show keyboard shortcuts, start a new session, quit |

## Research delegation

The current runtime does not provide `/chain` or `/parallel` commands. Research workflows call `subagent` directly for one child, or write a workflow script for parallel or sequential work to `outputs/.plans/<slug>-workflow.js` and run it by calling `subagent` with that path. A file works with every model; an inline ```` ```js workflow ```` block with `workflow: true` fails when a model puts the block in its hidden reasoning instead of the reply.

```js
return await runs.all([
  { key: "papers", agent: "evidence-scout", task: "Read outputs/.plans/<slug>-papers.md.", output: "outputs/.drafts/<slug>-research-papers.md" },
  { key: "web", agent: "evidence-scout", task: "Read outputs/.plans/<slug>-web.md.", output: "outputs/.drafts/<slug>-research-web.md" },
]);
```

```json
{ "workflow": "./outputs/.plans/<slug>-workflow.js", "async": true, "globalConcurrencyLimit": 4 }
```

For sequential work, await `runs.run(key, {agent, task, output})` before starting the next step. Legacy top-level `tasks`, `chain`, and `parallel` inputs are rejected. `runs.all` returns an ordered array, including ordinary child failures; inspect each result's `ok` and returned output references.

An async launch receipt is not completion: consume the result and verify child output paths before synthesis or dependent review. Ordinary background subagents notify their parent; `bg_wait` is for background work without a native completion notification.

## Running workflows from the CLI

Every research workflow can also be run from the command line, for example `hypatia deepresearch "topic"`. See [CLI Commands](/hypatia/docs/reference/cli-commands#workflow-commands).

For experiment setup in chat use `/experiments create <goal>`; use `create-json <path>` for saved contracts. `import <idea-file>` prepares a contract in chat; `import-json <idea-file> --contract <path>` loads one directly. `review <slug>` prefills a review-only chat request. New contracts require a critic before benchmarks and an auditor before closure.

`/idea <goal>` starts native Idea Forge preparation in chat; `/experiments generate <goal>` is an alias with Hypatia auth and no clone; `ideas` browses generations/proposals. Use `forge-status`, `forge-approve`, `forge-pause`, `forge-resume`, or `forge-recover` with a generation slug. Model API generation and benchmark execution have separate approved contracts.

Tree controls are `/experiments tree create`, `list`, `status <slug>`, `approve <tree> <node>`, `fork <tree> <parent> <child> <hypothesis>`, `promote <tree> <node>`, `pause`, `resume`, `recover`, `close-node <tree> <node>`, `close`, and `export`. Tree creation requires a clean Git repository root; each node runs in a detached worktree and shares the tree's trial/time/parallel-run budgets. `/autoresearch tree <tree> <node>` continues a selected node. Promotion records a reviewed winner without merging or changing the checkout.
