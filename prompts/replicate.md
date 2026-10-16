---
description: Plan a source-grounded replication workflow with relevant project wiki context; execute only after an explicit environment choice.
args: <paper>
section: Research Workflows
topLevelCli: true
---
Design a replication plan for: $@

## Project wiki context (read-only)

Before extracting implementation details, check whether this workspace has `wiki/`. If both `wiki/README.md` and `wiki/index.md` exist, read them and follow only relevant indexed links to pages under `wiki/concepts/` and `wiki/sources/`. Do not scan the wiki or read `wiki/.proposals/`. Treat wiki pages as navigation leads, not primary evidence; verify relevant methods, results, and caveats against the original source paper and linked code. Record the wiki page paths consulted in the plan and replication notes. Never initialize or modify the wiki during `/replicate`.

## Workflow

1. **Extract** — If the topic has relevant wiki pages, write a per-evidence-scout brief before delegation with their exact paths, each relevant claim and its status, source IDs and original URLs, plus the implementation detail to verify. The scout treats these as leads, verifies against the original paper/code, and records wiki paths consulted in its output. State when none apply. Use the `evidence-scout` subagent to pull implementation details from the target paper and any linked code. If `CHANGELOG.md` exists, read the most recent relevant entries before planning or resuming.
2. **Recipe pass** — For ML training, fine-tuning, benchmark, or dataset-heavy targets, perform a recipe extraction before execution planning. Link each claimed result to the exact dataset, method, hyperparameters, compute assumptions, metric, and code path that produced it. Validate dataset availability/schema when possible and mark unchecked details as `unverified` instead of assuming they are usable.
3. **Plan** — Determine what code, datasets, metrics, and environment are needed. Be explicit about what is verified, what is inferred, what is still missing, and which checks or test oracles will be used to decide whether the replication succeeded.
4. **Environment** — Before running anything, ask the user where to execute:
   - **Local** — run in the current working directory
   - **Virtual environment** — create an isolated venv/conda env first
   - **Docker** — run experiment code inside an isolated Docker container
   - **Modal** — only if the user has the `modal` CLI installed and set up: write a Modal-decorated Python script and run it with `modal run <script.py>`. Best for burst GPU jobs that don't need persistent state.
   - **RunPod** — only if the user has the `runpodctl` CLI installed and `RUNPOD_API_KEY` set: provision a GPU pod, then SSH in to run and use `runpodctl` to transfer files and stop the pod. Best for long-running experiments or when you need SSH access and persistent storage.
   - **Plan only** — produce the replication plan without executing
5. **Execute** — If the user chose an execution environment, implement and run the replication steps there. Save notes, scripts, raw outputs, and results to disk in a reproducible layout. Do not call the outcome replicated unless the planned checks actually passed.
6. **Log** — For multi-step or resumable replication work, append concise entries to `CHANGELOG.md` after meaningful progress, failed attempts, major verification outcomes, and before stopping. Record the active objective, what changed, what was checked, and the next step.
7. **Report** — End with a `Sources` section containing paper, dataset, documentation, and repository URLs.

Do not install packages, run training, or execute experiments without confirming the execution environment first.
