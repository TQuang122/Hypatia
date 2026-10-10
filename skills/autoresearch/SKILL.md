---
name: autoresearch
description: Run persistent bounded benchmark experiments or lineage-linked experiment trees with shared budgets, observed metrics, receipts, and pause/resume. Use when optimizing or reproducing a research metric across controlled trials.
---

# Autoresearch

Run `/autoresearch` with a hypothesis or `resume <slug>`. The prompt expands workflow instructions in the active session.

Use `hypatia_experiment` for contracts, baseline/trial execution, observed metric receipts, decisions and closure. `/experiments` manages approved state and imports AutoResearch idea files; `/outputs` opens the resulting reports and provenance.

State and receipts live in `experiments/<slug>/`; final report/provenance live in `outputs/`. Preserve legacy `autoresearch.md`, `autoresearch.sh`, and `autoresearch.jsonl` as historical notes; inspect them through the tool's `legacy` action.

New contracts fingerprint the environment label, host platform/architecture/Node runtime, resolved benchmark executable, and hashes of declared frozen inputs. Include dependency lockfiles or nonsecret environment manifests in `inputFiles`; use immutable image digests in the label. Fingerprints do not capture arbitrary inherited environment variables or enumerate installed packages, so never put credentials in the label or frozen inputs.

Use `/experiments create <goal>` for setup in chat, or `create-json <path>` for an existing contract. Group critical missing fields into one chat question and label inferred defaults; one final contract approval replaces sequential wizard dialogs. New contracts require automatic critic review before benchmarks and auditor review before closure. Reviews bind exact evidence hashes, use fresh read-only Pi sessions and persist capped attempts/model usage. Inspect blockers rather than bypassing them; `/autoresearch review <slug>` explicitly requests a retry without running a benchmark.

For explicit sibling comparisons, create an experiment tree with `tree_create`. Tree mode requires a clean Git repository root; it creates detached node worktrees under `experiments/.trees/<tree-slug>/` and leaves the user's checkout untouched. `tree_fork` requires a closed parent with a valid, reviewed best receipt and seeds a child from that exact snapshot. Every node remains a version-1 experiment with its own approval, baseline, receipts and review gates. The tree controller enforces one shared trial/time/parallel-run budget and persists reservations for recovery.

Use `tree_status` to find node worktree paths, edit only the selected node's declared `filesInScope`, and run its baseline before candidate trials. Keep node `HEAD` at the captured base commit and leave candidate edits uncommitted; version-1 receipts record the scoped snapshots. Use `tree_decide` for each result, `tree_pause`/`tree_resume` or node-specific variants for workers, `tree_recover` after interruption, `tree_promote` to record a verified winner, and `tree_close` / `tree_export` for aggregate report and provenance. Promotion never merges, copies or commits code. Preserve closed worktrees and evidence; cleanup is not automatic.

For idea generation, use `hypatia_idea_forge` preflight/create/run or `/idea <goal>` (`/experiments generate <goal>` is an alias). Native generation uses Hypatia auth/models and bundled QML/ML/LLM/research guidance or a project knowledgePath; no AutoResearch clone/Python is required. The current model is the default, with an optional distinct panel of up to six models. Label single-model critique non-independent. Preflight rejects incompatible explicit directions before generation calls. The create tool presents one final approval; declined approval stays planned. `/experiments ideas` previews unverified proposals and transfers one to chat with provenance. Selecting a proposal requires a separate benchmark contract approval. Legacy Python runs retain their recorded backend configuration.
