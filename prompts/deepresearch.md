---
description: Run a thorough, source-heavy investigation on a topic and produce a durable research brief with inline citations.
args: <topic>
section: Research Workflows
topLevelCli: true
---
Run deep research for: $@

## Required Artifacts

Derive a short slug from the topic: lowercase, hyphenated, no filler words, at most 5 words.

Every run must leave these files on disk:
- `outputs/.plans/<slug>.md`
- `outputs/.drafts/<slug>-draft.md`
- `outputs/.drafts/<slug>-cited.md`
- `outputs/<slug>.md` or `papers/<slug>.md`
- `outputs/<slug>.provenance.md` or `papers/<slug>.provenance.md`

For argumentative topics (competing claims, disputed results), also leave:
- `outputs/.drafts/<slug>-tensions.md`

Before the plan is approved, only the plan file may exist; do not create placeholder drafts, final outputs, or provenance files. After the user approves the plan, if any capability fails, continue in degraded mode and still write a blocked or partial final output and provenance sidecar. Never end with chat-only output after plan approval. Never end with only an explanation in chat after plan approval. Use `Verification: BLOCKED` when verification could not be completed.

## Step 1: Plan

Create `outputs/.plans/<slug>.md` immediately. The plan must include:
- Key questions
- Evidence needed
- Scale decision (tier `light` for narrow explainers and bounded questions, tier `full` for surveys, comparisons, and disputed topics)
- Task ledger (every task marked `pending`, `done`, `blocked`, or `superseded`)
- Verification log
- Decision log

**Resume:** if `outputs/.plans/<slug>.md` already exists from an interrupted run, do not restart. Read the task ledger and verification log, continue from the first task not marked `done`, and record the resume in the decision log.

Make the scale decision before assigning owners in the plan. If the topic is a narrow "what is X" explainer, the plan must use lead-owned direct search tasks only; do not allocate evidence-scout subagents in the task ledger.

After writing the plan, stop and ask for explicit confirmation before gathering evidence. Summarize the plan briefly and ask:

`Proceed with this deep research plan? Reply "yes" to continue, or tell me what to change.`

Do not run searches, fetch sources, spawn subagents, draft, cite, review, or deliver final artifacts until the user confirms. If the user requests changes, update `outputs/.plans/<slug>.md` first, then ask for confirmation again.

## Step 2: Scale

Tier `light` — direct search, no subagents, do citation and review yourself (Steps 6–7 lead-owned). Use for:
- Single fact or narrow question, including "what is X" explainers
- Work you can answer with 3-10 tool calls

Tier `full` — subagents with the auditor-then-critic sequence. Use subagents only when decomposition clearly helps:

For "what is X" explainer topics, you MUST NOT spawn evidence-scout subagents unless the user explicitly asks for comprehensive coverage, current landscape, benchmarks, or production deployment.
Do not inflate a simple explainer into a multi-agent survey.

Use subagents only when decomposition clearly helps:
- Direct comparison of 2-3 items: 2 `evidence-scout` subagents
- Broad survey or multi-faceted topic: 3-4 `evidence-scout` subagents
- Complex multi-domain research: 4-6 `evidence-scout` subagents

## Step 3: Gather Evidence

Prefer abstracts, HTML pages, official docs, and paper metadata. Read full text only for the few papers the conclusions depend on.

If direct search was chosen:
- Skip evidence-scout spawning entirely.
- Search and fetch sources yourself.
- Use multiple search terms/angles before drafting. Minimum: 3 distinct queries for direct-mode research, covering definition/history, mechanism/formula, and current usage/comparison when relevant.
- Record the exact search terms used in `outputs/.drafts/<slug>-research-direct.md`.
- Write notes to `outputs/.drafts/<slug>-research-direct.md`.
- Continue to synthesis.

If subagents were chosen:
- Call `hypatia_subagent_models` before writing the workflow. For every child, pass the first model in that role's route as the `model` override. If the route is empty, omit `model` and use Pi's configured role or parent model.
- If Pi rejects a child launch before the child starts because its model/provider is unavailable, retry that same role/task with the next model in its configured route. Use a unique workflow key and output path for each attempt; record the attempted model and launch failure in the plan. Once a child starts, do not switch models for runtime errors, poor research, unsupported claims, or review findings.
- Write a per-evidence-scout brief first, such as `outputs/.plans/<slug>-T1.md`.
- Keep `subagent` tool-call JSON small and valid.
- Do not place multi-paragraph instructions inside the `subagent` JSON.
- Use only supported `subagent` keys. Do not add extra keys such as `artifacts` unless the tool schema explicitly exposes them.
- For parallel evidence gathering, write a workflow script that returns `await runs.all(...)` to `outputs/.plans/<slug>-workflow.js` with the write tool. After the write succeeds, call `subagent` with `workflow: "./outputs/.plans/<slug>-workflow.js"`, `async: true`, and `globalConcurrencyLimit: 4`. Each item needs a unique stable `key`, plus its agent, short task, and output path. Do not pass the script text inside the tool call.
- Read the ordered result array and record each child's `ok`, error, and returned output/artifact paths. Ordinary child failures are collected by `runs.all`; validation or infrastructure failure can still fail the workflow. Do not assume every output exists.
- Prefer broad guidance such as "use paper search and web search"; if a PDF parser or paper fetch fails, the evidence-scout must continue from metadata, abstracts, and web sources and mark PDF parsing as blocked.

Example shape: `outputs/.plans/<slug>-workflow.js` contains

```js
return await runs.all([
  { key: "web", agent: "evidence-scout", task: "Read outputs/.plans/<slug>-T1.md and write outputs/.drafts/<slug>-research-web.md.", output: "outputs/.drafts/<slug>-research-web.md" },
  { key: "papers", agent: "evidence-scout", task: "Read outputs/.plans/<slug>-T2.md and write outputs/.drafts/<slug>-research-papers.md.", output: "outputs/.drafts/<slug>-research-papers.md" },
]);
```

and the `subagent` call is:

```json
{ "workflow": "./outputs/.plans/<slug>-workflow.js", "async": true, "globalConcurrencyLimit": 4 }
```

Continue independent work after launch, then consume completion results before synthesis. Relative output paths resolve against the workspace, so each child writes its declared path; verify each file on disk, and use the returned output reference for any that is missing. After evidence gathering, update the plan ledger and verification log. If research failed, record exactly what failed and proceed with a blocked or partial draft.

## Step 4: Map Contradictions

Skip this step for pure explainer topics with no disputed claims. Otherwise, before drafting, pair contradictions across the corpus:

- List each substantive disagreement: claim A vs claim B, with the sources behind each side.
- Rank clusters by decision relevance: contradictions that change the conclusion first.
- Note the source of disagreement when visible: different methods, populations, time windows, or definitions.
- Write `outputs/.drafts/<slug>-tensions.md` with one section per cluster: the competing claims, supporting sources per side, and what evidence would settle it.

The draft must represent every ranked cluster fairly instead of citing only the side that fits the narrative.

## Step 5: Draft

Write the report yourself. Do not delegate synthesis.

Save to `outputs/.drafts/<slug>-draft.md`.

Include:
- Executive summary
- Findings organized by question/theme
- Evidence-backed caveats and disagreements
- Open questions
- No invented sources, results, figures, benchmarks, images, charts, or tables

Before citation, sweep the draft:
- Every critical claim, number, figure, table, or benchmark must map to a source URL, research note, raw artifact path, or command/script output.
- Remove or downgrade unsupported claims.
- Mark inferences as inferences.

## Step 6: Cite

If direct search/no evidence-scout subagents was chosen:
- Do citation yourself.
- Apply the same four gates the auditor runs (citation-sentence binding, quote integrity, numeric consistency, retraction and independence sweep).
- Verify reachable HTML/doc URLs with available fetch/search tools.
- Copy or rewrite `outputs/.drafts/<slug>-draft.md` to `outputs/.drafts/<slug>-cited.md` with inline citations and a Sources section.
- Do not spawn the `auditor` subagent for simple direct-search runs.

If evidence-scout subagents were used, run the `auditor` agent after the draft exists. This step is mandatory and must complete before any critic runs. Do not run the `auditor` and `critic` in the same parallel `subagent` call.
Use `hypatia_subagent_models` to select the auditor's first model. Pass it as a per-run override; if Pi rejects auditor launch before it starts because the model/provider is unavailable, retry with the next configured auditor model and record both attempts. Do not switch models after auditor execution starts.

Use this shape:

```json
{
  "agent": "auditor",
  "async": true,
  "task": "Add inline citations to outputs/.drafts/<slug>-draft.md using the research files as source material. Verify every URL. Write the complete cited brief to outputs/.drafts/<slug>-cited.md.",
  "output": "outputs/.drafts/<slug>-cited.md"
}
```

Wait for the auditor's completion result before review, not merely the async launch receipt. Verify on disk that `outputs/.drafts/<slug>-cited.md` exists. If it is missing, use the returned output reference to find the cited file and copy it there.

## Step 7: Review

If direct search/no evidence-scout subagents was chosen:
- Review the cited draft yourself.
- Write `outputs/.drafts/<slug>-verification.md` with FATAL / MAJOR / MINOR findings and the checks performed.
- Fix FATAL issues before delivery.
- Do not spawn the `critic` subagent for simple direct-search runs.

If evidence-scout subagents were used, only after `outputs/.drafts/<slug>-cited.md` exists, run the `critic` agent against it.
Use `hypatia_subagent_models` to select the critic's first model. Pass it as a per-run override; if Pi rejects critic launch before it starts because the model/provider is unavailable, retry with the next configured critic model and record both attempts. Do not switch models after critic execution starts.

Use this shape:

```json
{
  "agent": "critic",
  "async": true,
  "task": "Verify outputs/.drafts/<slug>-cited.md. Flag unsupported claims, logical gaps, single-source critical claims, and overstated confidence. This is a verification pass, not a peer review.",
  "output": "outputs/.drafts/<slug>-verification.md"
}
```

Consume the review completion result and locate its returned output before proceeding. If the critic flags FATAL or MAJOR issues, use `hypatia_subagent_models` to select the reviser's first model and pass it as a per-run override; spawn the `reviser` agent to apply the findings surgically (never regenerate the draft yourself). If Pi rejects launch before the reviser starts because its model/provider is unavailable, retry with the next configured reviser model and record both attempts. Then run one more review pass. Note MAJOR issues in Open Questions. Accept MINOR issues.

Use this shape:

```json
{
  "agent": "reviser",
  "async": true,
  "task": "Apply the FATAL and MAJOR findings in outputs/.drafts/<slug>-verification.md to outputs/.drafts/<slug>-cited.md. Escalate what does not fit a small hunk.",
  "output": "outputs/.drafts/<slug>-cited.md"
}
```

If the reviser escalates structural findings, fix those yourself with small localized edits (1-3 simple corrections) or write a corrected full file to `outputs/.drafts/<slug>-revised.md` for larger rewrites — never one giant `edit` call with many replacements.

The final candidate is `outputs/.drafts/<slug>-revised.md` if it exists; otherwise it is `outputs/.drafts/<slug>-cited.md`.

## Step 8: Deliver

Copy the final candidate to:
- `papers/<slug>.md` for paper-style drafts
- `outputs/<slug>.md` for everything else

Write provenance next to it as `<slug>.provenance.md`:

```markdown
# Provenance: [topic]

- **Date:** [date]
- **Rounds:** [number of research rounds]
- **Sources consulted:** [count and/or list]
- **Sources accepted:** [count and/or list]
- **Sources rejected:** [dead, unverifiable, or removed]
- **Verification:** [PASS / PASS WITH NOTES / BLOCKED]
- **Plan:** outputs/.plans/<slug>.md
- **Research files:** [files used]
- **Subagent model usage:** table with role, actual model per attempt, input/output tokens, cost when reported, and fallback reason. Use returned `model`, `usage`, and error fields; mark missing values `not reported`, never estimate.
```

Before responding, verify on disk that all required artifacts exist. If verification could not be completed, set `Verification: BLOCKED` or `PASS WITH NOTES` and list the missing checks.

Final response should be brief: link the final file, provenance file, and any blocked checks.
