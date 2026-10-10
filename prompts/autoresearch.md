---
description: Persistent bounded benchmark experiments with approved contracts, observed metrics, receipts, and pause/resume.
args: <idea|resume slug|review slug|close slug|off slug|tree <tree-slug> <node-id>|tree <tree-slug> close-node <node-id>|tree <tree-slug> close>
section: Research Workflows
topLevelCli: true
---
Run a bounded experiment workflow for: $@

Use `hypatia_experiment` as the authority for experiment state, execution, decisions and receipts. Keep every trial, including reverted, failed and interrupted runs, in the final report.

## Existing runs

- `close <slug>`: inspect approval/status, resume if paused, settle any pending decisions, then call `close`. It automatically audits required result evidence. Do not start a new benchmark for this request. Report any review blocker instead of closing without a valid gate.

- `review <slug>`: inspect status and approval, resume if paused, then call `review` with `reviewKind: plan` before a baseline or `reviewKind: audit` after results are settled. Report the verdict/findings and stop; this request does not start a benchmark.

- `resume <slug>`: inspect `status`; call `resume` for paused/blocked state, consume pending trial decisions, then continue the existing approved contract. Reuse its valid baseline. Approval and budget persist across chat sessions.
- `off <slug>`: call `pause` and report whether the worker has stopped or pause is still requested.
- To start fresh, choose a new slug and preserve prior evidence. Do not delete experiment state or legacy session files automatically.
- Call `legacy` to inspect existing `autoresearch.md`, `autoresearch.jsonl`, and `autoresearch.sh`. Those logs are historical notes without sealed runner receipts. Preserve them and create a new contract/baseline for new execution.

## Experiment trees

Use a tree when the user asks to compare multiple candidate directions with explicit parent/child lineage. Keep a single version-1 experiment for ordinary bounded searches.

- `/autoresearch tree <tree-slug> <node-id>` means continue that node: inspect `tree_status`, check its contract approval and node state, call `tree_resume` if the tree is paused or `tree_resume_node` if only that node is paused, then work only in the node's returned worktree path. Do not edit the base checkout.
- `/autoresearch tree <tree-slug> close-node <node-id>` means settle and close one node: inspect its receipts/decisions, run required plan/audit reviews, then call `tree_close_node`. Do not run another benchmark for this request.
- `/autoresearch tree <tree-slug> close` means close/export the tree: inspect every node, settle pending decisions, run required audit reviews, close any settled but open nodes, then call `tree_close`. Do not start a benchmark for a close request.
- `tree_create` accepts the same benchmark protocol plus `maxTotalTrials`, `maxTotalWallSeconds`, and `maxParallelRuns`. It requires the current workspace to be the clean Git repository root. It snapshots declared `inputFiles`, creates a detached root worktree at the captured commit, and saves a planned version-1 root-node contract. Do not attempt tree creation from a dirty or non-Git workspace; the ordinary version-1 workflow remains available there.
- Approve each new node contract with `tree_approve` or `/experiments tree approve <tree> <node>` before it runs. If approval dialogs are unavailable, leave the node planned and direct the user to the slash command.
- Use `tree_status` to inspect node IDs, parent receipt/snapshot lineage, shared budget and each node worktree. Make candidate edits only beneath the selected node's listed worktree, and only to that contract's `filesInScope`. Keep the node `HEAD` at the captured base commit; leave candidate edits uncommitted so version-1 receipts can snapshot them. Never edit the base checkout or commit/checkout another revision inside a managed node.
- Run `tree_run` with `kind: baseline` for each node before candidate edits. Each child gets a fresh baseline from the parent's verified best snapshot; baseline time counts against the shared wall-time budget. Fork with `tree_fork` only from a closed, settled parent with a valid best receipt and any required reviews passing. Give siblings distinct lowercase node IDs.
- Use `tree_decide` for every trial receipt before another trial. All nodes share one trial-attempt limit, wall-time limit and parallel-run cap. `tree_run` durably reserves the aggregate budget before starting a worker; a refusal means recover/pause existing work or stop within the saved tree limits, not bypass the tree controller with a version-1 action.
- `tree_review` binds critic/auditor reviews to that node's version-1 evidence. `tree_pause` / `tree_resume` coordinate all node workers; node-specific pause/resume actions are also available. If a run is interrupted, use `tree_recover`, inspect any surviving benchmark process, and only then acknowledge a stopped child launch through `/experiments tree acknowledge <tree> <node>`.
- Close settled nodes with `tree_close_node`, then use `tree_promote` only after a closed node has a verified best receipt and passing required reviews. Promotion selects a tree winner; it does not merge, copy or commit code. `tree_close` writes the graph report and provenance sidecar; `tree_export` can export an incomplete tree.
- Keep all tree worktrees and evidence after closure. Never delete tree state, remove worktrees or merge a promoted candidate automatically.

## Optional idea generation

When the user wants ideas from the configured AutoResearch backend, use `/experiments generate` for the bounded generation contract; do not invoke publishers, collectors or a supervisor. `/experiments ideas` previews completed proposals and opens the experiment wizard. Imported generation provenance validates artifact identity, not the scientific claims in generated text.

## Gather and prepare

Ask only for missing information: hypothesis, benchmark argv and working directory, observed metric key/unit/min-or-max direction, source files allowed to change, frozen input files, requested seeds, environment choice, trial limit and time budget. Reuse constraints the user already supplied.

The environment must be chosen explicitly: local, isolated branch/worktree, venv/conda, Docker, or an explicitly configured remote runner. A remote command must wait for measured results. The user chooses scope and environment before execution; use an isolated worktree when unrelated dirty edits could be affected.

The environment fingerprint binds the environment label, host platform/architecture/Node runtime, resolved benchmark executable, and hashes of declared frozen inputs. Include dependency lockfiles or nonsecret environment manifests in `inputFiles`; use an immutable image digest in the environment label when applicable. The fingerprint does not inventory installed packages or capture arbitrary inherited environment variables. Never put credentials in the label or frozen inputs.

Prepare an observable metric interface before saving the contract:
- stdout: the benchmark prints exactly one line `HYPATIA_METRIC {"score": <observed number>}` per seed;
- json-file: it writes the declared metric file inside the fresh `HYPATIA_EXPERIMENT_RUN_DIR` directory.

The runner supplies `HYPATIA_EXPERIMENT_SEED` and expands `{seed}` / `{runDir}` in the saved argv. The benchmark must honor the seed. Use a stable interpreter executable with the editable benchmark script as an argument. Include actual dataset files or a benchmark-validated dataset manifest in frozen inputs.

## Create and approve once

Call `create` with a contract: slug, hypothesis, argv, optional relative cwd, filesInScope, inputFiles, seeds, metric, environment, maxIterations (default 20), maxWallSeconds (default 3600), timeoutPerRun (default up to 600).

To import a selected AutoResearch idea, add `ideaFile` and `autoresearchRoot` (or use the configured root). Import checks Forge/source hash and selected-plan binding, and stores input snapshots. Import creates planned state and does not start a benchmark.

The tool shows the saved contract for user approval in dialog-capable sessions. Do not ask for a second confirmation beforehand. If no dialog is available or approval is declined, leave the run planned and direct the user to `/experiments approve <slug>`. Do not submit an approval flag as a model assertion.

## Independent review gates

New contracts default to `reviewPolicy: required`. The user can explicitly choose `none` in chat or an approved JSON contract for benchmark-only operation. Existing contracts without the field retain their recorded protocol. Do not disable review to bypass a blocker.

`run` automatically invokes a critic in a fresh read-only Pi session before the first baseline; `close` automatically invokes an auditor against the current result bundle. Role model routes are honored, with availability fallback only before a model request. Each review has a 180-second deadline, 12-turn limit and three persisted attempts per gate; model usage is accounted separately from benchmark execution time.

A malformed, failed, cancelled, blocked or stale verdict cannot pass. Findings and actual reviewer/model/usage are saved under `experiments/<slug>/reviews/`. If a gate reports blockers, inspect the findings and address them; use explicit action `review` to retry within the persisted cap. Contract changes require a new experiment. An audit becomes stale when its bound receipts, decisions, best code, inputs or conclusion change. Do not claim review establishes statistical significance or generalization.

## Baseline and iterations

1. Run `kind: baseline` before any candidate edits. Baseline code is frozen at contract creation; valid baseline requests return the cached receipt. A changed baseline/protocol/data requires a new contract.
2. Make one candidate edit within filesInScope, using focused patches that preserve other user work.
3. Run `kind: trial`. Each configuration runs the frozen seed list sequentially; the comparable value is their mean. Failed/interrupted configurations consume a trial attempt. The budget persists through resume.
4. Inspect the receipt and actual metric. Record `keep` only for an observed improvement over the best kept comparable value. Record `revert` for a valid rejected candidate, or `failed` for an invalid receipt, with a concrete reason. The engine restores only scoped files from the best snapshot and refuses to overwrite scoped edits made after the trial.
5. Continue until the bounded budget is exhausted, the user pauses, or further work is unjustified. Interrupted trial evidence must be settled before another run. Never retry an invalid run indefinitely.

Input changes, receipt/hash mismatches, unresolved ownership, or missing metric evidence are blocking conditions. Report the observed problem and preserve evidence; do not manufacture a metric or rewrite a receipt.

## Deliver

Call `close` only when there is no active or undecided run. The engine checks receipts and produces `outputs/<slug>.md` and `outputs/<slug>.provenance.md`. Use `export` for an explicitly incomplete summary while a run is parked.

Explain every tried configuration, the requested seeds, failures/reverts, charged budget and observed improvement. `positive`/`negative` describe the benchmark comparison, `baseline_only` means no candidate was tested, and `budget_exhausted` is a stopping condition. These labels do not establish scientific validity or generalization; the independent model reviews are recorded advisory evidence, with the gate results in the report.

Use `/experiments` to manage state and `/outputs` to read reports, logs and provenance. A completed chat turn is not evidence that the durable experiment is complete.
