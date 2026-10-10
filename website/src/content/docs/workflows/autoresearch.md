---
title: Autoresearch
description: Persistent bounded benchmark experiments with observed receipts, approval, and pause/resume.
section: Workflows
order: 10
---

`/autoresearch` uses the `hypatia_experiment` runner to optimize a declared benchmark metric. Each run keeps its contract, state, code snapshots, logs and receipts on disk. Pi coordinates the research workflow and uses your current model/auth configuration.

## Start and manage

```text
/autoresearch Optimize retrieval accuracy against my local benchmark
/autoresearch resume retrieval-pilot
/autoresearch off retrieval-pilot
/experiments
```

The CLI entrypoint remains `hypatia autoresearch "<idea>"`. The workflow gathers missing scope, environment, metric and budget details, then creates a contract for approval. Approval is recorded once. In a mode without approval dialogs, the run stays planned until you approve it in `/experiments`.

Use `/experiments create <goal>` or **Create experiment in chat** to describe the hypothesis, benchmark command, editable/frozen files, seeds, metric, environment and budget. Hypatia inspects the workspace, labels inferred defaults and groups missing critical fields into one plain chat question. Missing benchmark code or environment is reported before contract creation. The complete contract receives one approval dialog. Commands are parsed into argv without shell expansion; quote paths containing spaces. Put pipelines/redirects into a benchmark script.

The management menu can also create a run from a contract JSON file, import an idea, approve a contract, inspect status, request pause, resume, continue in chat, export a summary, or open reports/logs. Direct TUI commands include `/experiments status <slug>`, `pause`, `resume`, `approve`, `export`, and `close` with the same slug. `/experiments create` prefills the composer; a goal supplied after it starts setup in chat. `create-json <path>` loads a saved contract directly. `/experiments import <idea-file>` starts setup in chat; `import-json <idea-file> --contract <path>` loads an existing contract. `/experiments review <slug>` prefills `/autoresearch review <slug>` in the editor for you to send.

## Compare sibling candidates with an experiment tree

Use tree mode when a search needs explicit parent/child lineage across candidate directions. Ordinary version-1 experiments continue to work in dirty or non-Git workspaces; tree creation deliberately requires a clean Git repository root.

```text
/experiments tree create
/experiments tree list
/experiments tree status retrieval-tree
/experiments tree close-node retrieval-tree root
/experiments tree fork retrieval-tree root reranker-v2 A second reranking candidate
/experiments tree approve retrieval-tree reranker-v2
/autoresearch tree retrieval-tree reranker-v2
/experiments tree promote retrieval-tree reranker-v2
/experiments tree close retrieval-tree
```

Tree setup starts in chat and adds a shared trial, wall-time, and parallel-run budget. Creation snapshots declared frozen inputs and makes a detached root worktree at the captured commit. The `tree_status` / `/experiments tree status` response shows every node's worktree path and parent receipt/snapshot lineage. Edit only declared files under the selected node worktree; keep its `HEAD` at the captured base commit and leave candidate edits uncommitted for receipt snapshots. The base checkout is not the candidate workspace.

Each node retains an ordinary version-1 experiment contract, approvals, baseline, receipts, review history and recovery journal. A child can be forked only from a closed, settled parent with a valid best receipt and any required reviews passing. Its scoped source files are copied from that exact receipt snapshot; frozen inputs come from the tree-owned copies. Siblings receive separate writable worktrees and each node runs a fresh baseline. Baseline runs count toward shared wall time but not the shared trial-attempt limit.

`hypatia_experiment` tree actions include `tree_create`, `tree_status`, `tree_fork`, `tree_approve`, `tree_run`, `tree_decide`, `tree_review`, `tree_pause`, `tree_resume`, `tree_recover`, `tree_promote`, `tree_close_node`, `tree_close`, and `tree_export`. Run and decision calls must go through the tree controller so it can reserve aggregate budget and concurrency before starting a node. The parallel-run limit defaults to one. Resume/recovery never silently starts another benchmark. If a launch was interrupted before its child process identity was saved, inspect and stop that process before acknowledging the stopped launch.

`/experiments tree promote <tree> <node>` selects a closed node with a valid best receipt and passing required reviews. Promotion changes only the tree winner pointer: it does not merge, commit, or copy files into the user's checkout. `/experiments tree close <tree>` closes the settled nodes and writes `outputs/<tree>-tree.md` and `outputs/<tree>-tree.provenance.md`; `export` can write the aggregate record before closure. Worktrees and evidence remain available after close and are not pruned automatically.

## Benchmark contract

Prepare a script that emits the observed metric, then save a contract such as:

```json
{
  "slug": "retrieval-pilot",
  "hypothesis": "A bounded reranking change improves retrieval accuracy",
  "argv": [".venv/bin/python", "bench.py", "--seed", "{seed}"],
  "filesInScope": ["bench.py", "config.json"],
  "inputFiles": ["data/evaluation.json"],
  "seeds": [7, 42],
  "metric": {"source": "stdout", "key": "score", "unit": "accuracy", "direction": "max"},
  "environment": "Local Python venv",
  "maxIterations": 10,
  "maxWallSeconds": 1800,
  "timeoutPerRun": 120
}
```

`cwd` is optional and workspace-relative. `filesInScope` contains individual editable files; each snapshot file is limited to 2 MiB. `inputFiles` contains individual frozen files, whose content hashes are checked. Include dependency lockfiles or nonsecret environment manifests there when they affect the run. Hashing a manifest attests that manifest; the benchmark must validate any dataset files it references.

The environment fingerprint binds the environment label, host platform/architecture/Node runtime, resolved executable and hashes of declared frozen inputs. Use an immutable container image digest in the environment label when applicable. The fingerprint does not capture arbitrary inherited environment-variable values, so never put credentials in the label or frozen manifests. Use a stable interpreter followed by the editable script. The original scoped code is frozen for the baseline. Candidate edits are allowed after a valid baseline is recorded. Metric, direction, seeds, inputs and budget stay frozen for that experiment; choose a new slug when changing the protocol.

## Observed metrics

For stdout, print exactly one record per seed:

```python
print("HYPATIA_METRIC " + json.dumps({"score": observed_score}))
```

Alternatively use `{"source":"json-file","file":"metrics.json","key":"score","unit":"accuracy","direction":"max"}` and write that JSON beneath `HYPATIA_EXPERIMENT_RUN_DIR`. Each run and seed receives a fresh directory, so an old metric file cannot satisfy a new run. `{runDir}` and `{seed}` expand in argv; the seed is also supplied as `HYPATIA_EXPERIMENT_SEED`.

The runner executes requested seeds sequentially and reports their mean. The benchmark is responsible for using the seed correctly. Missing, duplicate, non-numeric or malformed metric evidence makes the receipt invalid even when the process exits 0. Each stdout/stderr stream is capped at 8 MiB; JSON-file metric input is capped at 1 MiB.

## Independent review gates

New contracts default to `reviewPolicy: "required"`. After contract approval, `run` automatically invokes the bundled critic before benchmarks; `close` invokes the auditor against settled results. `/autoresearch review <slug>` explicitly reviews the contract or settled results without starting a benchmark. The menu’s **Review in chat** prefills that command. For required-review contracts, **Close experiment** and `/experiments close <slug>` prefill `/autoresearch close <slug>` for you to submit; the chat tool performs the audit before closure.

Each reviewer starts a fresh Pi SDK session without parent chat history, skills, project instructions or extensions. Its only tool is `experiment_read`, restricted to declared source/input files and that experiment’s evidence. The role instructions come from the bundled critic/auditor files. Models follow configured role routes, including Pi role overrides; an empty route inherits the parent model. Availability fallback happens before launch; runtime failures never switch models.

A gate accepts only a schema-valid `pass` with no unresolved fatal/major findings, the exact bundle hash and actual reviewer identity. The critic binds the frozen contract/baseline; the auditor binds every receipt, decision, best code snapshot, execution accounting and generated benchmark conclusion. New trial evidence or decisions make an earlier audit stale. Error, timeout, cancelled, malformed and blocked reviews remain in the record and cannot pass.

Review artifacts and evidence bundles live in `experiments/<slug>/reviews/`, including independent Pi session logs. Reports preserve findings, role/model identity, prompt hash and provider-reported usage. A review has a 180-second deadline and a 12-turn limit; up to three attempts per gate persist across restarts. Reviewer model usage is separate from the benchmark execution budget, and cached reviews are not charged again. Address blockers before requesting an explicit retry. A changed contract requires a new slug.

The user can explicitly request benchmark-only operation in chat or a saved contract, recorded as `reviewPolicy: "none"`. Existing contracts without this field retain their original protocol and are labeled legacy. Review is advisory model evidence; gate passage does not establish novelty, significance or generalization.

## State, decisions and budgets

A valid baseline is cached and its receipt is checked before reuse. Trial decisions are `keep`, `revert`, or `failed`. Keep requires improvement over the best kept value; revert/failed restore only the declared source files, and refuse to overwrite scoped changes made after the trial. Unrelated files are preserved.

The default budget is 20 trial configurations, 3600 seconds of charged execution time and up to 600 seconds per configuration. Maximums are 100 trial configurations and 32 requested seeds. A configuration includes all its seeds. Failed and cancelled configurations count toward the trial limit; baseline attempts are capped at three. Limits persist across pause/resume and chat sessions.

Pause first records `pause_requested`; the worker terminates its benchmark process group and seals an interrupted receipt before the state becomes `paused`. A worker that disappears is recovered on resume only after its benchmark process has stopped. If a benchmark PID is still alive, resume reports the ownership problem and launches no replacement. Recovery without a sealed receipt charges the configured timeout conservatively and labels that accounting in provenance.

If a worker disappears in the narrow child-launch window before recording its PID, recovery remains blocked. Inspect/stop processes from that run, then use `/experiments recover <slug>` to acknowledge the stopped launch. This user command records failed evidence; it never launches a replacement. The model tool cannot submit that acknowledgement.

One benchmark configuration can own an experiment at a time. Session shutdown requests pause for work launched by that session. A hard host interruption may leave a bounded worker running; persisted ownership and its deadline prevent an automatic duplicate launch.

Benchmark execution currently supports macOS/Linux process groups. Windows can create/import, inspect and manage state; managed execution requires a supported host. Pi remains the execution harness; experiment contracts are not an OS sandbox. The fingerprint records the declared execution identity, not an exhaustive inventory of installed packages or inherited environment variables.

## AutoResearch idea import

Import a selected file produced by AutoResearch's `src/idea_provenance.py export`, or a manual text/Markdown idea. For Forge exports, specify the repository root through `HYPATIA_AUTORESEARCH_ROOT` or `~/.hypatia/agent/autoresearch-backend.json`:

```json
{"root":"/path/to/AutoResearch"}
```

Import verifies the Forge file SHA256, record/plan indices, selected plan body and knowledge direction. It stores snapshots of the original idea, Forge output and knowledge file so later resume does not depend on those external files. Manual ideas are marked with manual provenance. Import produces planned state and does not call model endpoints or start a benchmark.

The importer follows AutoResearch export schema 1, examined at commit `21f591298aca78690722686c38984ac2b7d6f7e6`. New Idea Forge generation is native to Hypatia as described below. Legacy Python-backed generations remain compatible. Imported artifacts and ordinary benchmarks need none of its Python runtime dependencies. The Claude/Ralph supervisor is not used by Hypatia.

## Reports and existing logs

State lives under `experiments/<slug>/contract.json`, `state.json`, `events.jsonl`, `snapshots/`, `runs/` and `receipts/`. The event journal is authoritative; `state.json` is a derived cache. Receipts include observed exit/metric evidence, log/snapshot/input hashes, the engine build hash and experiment workspace Git revision when available.

Closure checks receipt integrity, settled decisions and the best kept source snapshot. It writes `outputs/<slug>.md` and `outputs/<slug>.provenance.md`. `/outputs` reads the reports and the experiment's logs/JSON files. Explicit export while paused marks the summary incomplete.

Outcomes are `positive`, `negative`, `baseline_only`, `budget_exhausted`, or `failed`. Positive/negative refer to the observed benchmark comparison; they do not certify scientific validity, statistical significance or generalization. Reports preserve every failed/reverted trial. Independent critic/auditor verdicts are included for contracts that require reviews.

Legacy `autoresearch.md`, `autoresearch.jsonl`, and `autoresearch.sh` are inspectable through `/experiments` and remain unchanged. Their metrics are historical notes without engine receipts; start a fresh contract/baseline for new runs. Fresh runs use a new slug rather than deleting prior evidence.

After updating from a source checkout, run `npm run build` and restart Hypatia to load the compiled experiment runtime. Packaged installs include it under `dist/experiments/`.


## Idea Forge generation

For broad, chat-based exploration, the bundled `research-ideation` skill produces 3–5 speculative directions with a testable question, smallest informative test, and main uncertainty. It does not start separate Idea Forge panel calls or establish novelty. Choose a direction first, then use `/idea` for a bounded proposal with the model selector and approval contract.

Use `/idea <research goal>` (alias `/experiments generate <goal>`) in the TUI composer, or choose **`/idea <research goal>` in the `/experiments` menu** and describe your goal in chat. After the goal is entered, an opaque selector docked above the message input lets you keep one model (the current model is preselected) or choose three distinct available Hypatia models. No model IDs need to be typed into the prompt. A scrollable contract review groups the goal, panel, resources and limits; it estimates up to three requests per model and warns if the request cap is below that estimate. Model selection does not approve generation; the frozen contract still gets its own approval. Native generation uses existing Hypatia model/auth settings. No AutoResearch clone, Python environment or separate provider credentials are required for a new native run. The agent can also choose `hypatia_idea_forge` when an ordinary prompt clearly requests proposal generation. General explanations or literature questions do not authorize a generation; routing is model-guided rather than a keyword rewrite.

Hypatia suggests and labels inferred model/resource/budget defaults, asks one grouped question for missing critical information, then shows the complete generation contract for one approval. On TUI approval, the same tool flow starts and waits for the bounded generation; a declined approval or a mode without approval dialogs leaves the contract planned with zero requests. Use `/experiments forge-resume <slug>` to start a previously approved planned contract. Three-model panels require a request cap of at least nine; too-small caps are rejected before approval. BM25, cross-encoder and reranking topics use ML guidance; retrieval/RAG topics without those ranking signals use LLM guidance. Models configured only transiently by another extension need a persisted Hypatia provider/model configuration for the detached worker.

Built-in directions include `qml`, `retrieval`, `rag-evaluation`, `agent-evaluation`, `statistics`, `ml`, `llm`, and `research`. BM25, cross-encoder, reranking and ranking-metric topics route to retrieval/ranking guidance; RAG pipeline evaluation and agent/tool-use evaluation have separate packs. QML signals auto-match quantum ML guidance covering encodings, ansatz, controls, paired seeds, leakage and simulator/hardware limits. An explicit direction that conflicts with the recognized topic is rejected before a model-generation request. A project-relative `knowledgePath` can replace built-in guidance; its UTF-8 contents are bounded and snapshotted, with relevance requiring user review. Later edits to the original file do not change the approved snapshot. Built-in guidance is methodological, not a current literature search or verified novelty claim.

The default is the current Hypatia model. A panel may contain 1–6 distinct configured model identities; a single-model critique is clearly non-independent. Each member proposes one idea, prepares a plan and receives an advisory critique from the next panel member. Rejected ideas are omitted; revise/pass proposals retain findings and remain unverified. Aliases or provider routes to the same underlying model do not create independent seats; contradictory response model metadata blocks the panel. Runtime failures do not silently switch models. Provider-reported identity/usage are recorded when available, not estimated.

Defaults are 12 API attempts, 900 seconds, 5000 output tokens per request and 90 seconds per request, unless the user explicitly requests different limits. Maximums are 100 attempts, 3600 seconds, 8192 output tokens and 300 seconds per request. A full panel can require up to three calls per selected model (ideation, planning and critique); the contract review estimates this and warns when the cap is lower. Transport retries are disabled; failed/interrupted reservations consume caps. Runtime source/model configuration and frozen knowledge identity are checked before launch and receipt sealing. Credentials stay in Hypatia auth storage and are not copied into generation contracts. Preparing the contract in conversation uses normal main-chat model usage. The approved generation caps cover additional Idea Forge calls; their usage is stored in the generation request journal separately from main-chat usage.

`hypatia_idea_forge` supports preflight, create, status, run/resume, pause, ideas and export. Preflight validates configuration, knowledge and availability without calling a model for generation; it does not prove endpoint connectivity. Create presents the approval dialog. Run/resume require the recorded contract approval. Structured fields include topic, signal, optional sourceUrl/direction/knowledgePath/modelPanel, resourceDescription and request/time/token limits. Benchmarks use the separate `hypatia_experiment` tool.

Native runs live under `experiments/idea-forge/<slug>/`: contract, frozen knowledge, hash-chained state/request journals, private response cache, Forge checkpoint, attempts and receipts. `/experiments forge-status <slug>`, `forge-pause`, `forge-resume` and `forge-recover` manage state. Verified completed responses are reused on resume without a new request. Unknown interrupted responses remain charged. Unsealed worker ownership blocks automatic replay until an inspected stopped launch is acknowledged. Native generation uses a bounded Node worker; legacy Python runs retain their original process-group/host requirements.

`/experiments ideas` or **Browse generated ideas** shows history and proposals. **View status** opens a scrollable report with request counts, cached responses, elapsed budget, proposal count and receipt integrity. **Preview proposal** renders the idea, plan, model route and advisory findings as readable sections; it is view-only. Selecting **Create experiment from this proposal** sends its exported file to chat, where Hypatia inspects benchmark prerequisites and prepares a separate contract approval. Selection alone starts no benchmark. The importer validates and snapshots generation receipts/journals/checkpoints and knowledge. Zero proposals is a completed outcome, shown explicitly in state. Truncated, malformed or failed model output is recorded as blocked/failed request evidence.

Existing Python-backed runs and verified AutoResearch schema-1 imports are retained for compatibility. Those legacy runs/imports still use their recorded clone/provider configuration; native generation and manual/native-idea imports do not require it. After a source update, build and restart Hypatia.
