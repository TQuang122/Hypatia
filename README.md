<p align="center">
  <a href="https://github.com/TQuang122/hypatia">
    <img src="assets/hypatia-readme-banner-console.png" alt="Hypatia — open source AI research, made traceable" width="800" />
  </a>
</p>
<p align="center">The open source AI research agent.</p>
<p align="center">
  <a href="https://github.com/TQuang122/hypatia/docs"><img alt="Docs" src="https://img.shields.io/badge/docs-github.com/TQuang122/hypatia-0d9668?style=flat-square" /></a>
  <a href="https://github.com/TQuang122/hypatia/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/TQuang122/hypatia?style=flat-square" /></a>
  <a href="https://deepwiki.com/TQuang122/hypatia"><img alt="Ask DeepWiki" src="https://deepwiki.com/badge.svg" /></a>
</p>

## Install

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/TQuang122/hypatia/main/scripts/install/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/TQuang122/hypatia/main/scripts/install/install.ps1 | iex
```

Or with npm and Node.js 22.22 or newer: `npm install -g @TQuang122/hypatia`.

Then sign in to a model provider:

```bash
hypatia setup
```

The [installation guide](https://github.com/TQuang122/hypatia/docs/getting-started/installation) covers pinned versions, uninstalling, and the skills-only bundle for Codex and OpenCode. The [setup guide](https://github.com/TQuang122/hypatia/docs/getting-started/setup) covers local models and editors such as Zed.

## Use

```bash
hypatia "what do we know about scaling laws"
hypatia lit "RLHF alternatives"
hypatia deepresearch "mechanistic interpretability"
hypatia --codemode deepresearch "compare mechanistic interpretability methods"
```

`--codemode` adds Pi Codemode for one session while keeping the default tools. It is off by default. To keep it available in every session, add `"defaultTools": ["+codemode"]` to `~/.hypatia/agent/settings.json`.

| Workflow | What it does |
| --- | --- |
| `/deepresearch <topic>` | Planned investigation with parallel evidence scouts and citation checks |
| `/lit <topic or lab>` | Literature review: consensus, disagreements, open questions |
| `/review <paper or draft>` | Critique with severity levels and a revision plan |
| `/audit <paper>` | Paper claims compared with its public code |
| `/replicate <paper>` | Replication plan; runs only after you choose an environment |
| `/recipe <task>` | Ranked ML training recipes with datasets and code |
| `/compare <topic>` | Source comparison matrix |
| `/draft <topic>` | Paper-style draft from research findings |
| `/idea <goal>` | Generate bounded research ideas with Hypatia-native Idea Forge |
| `/autoresearch <idea>` | Bounded experiment loop against a benchmark |
| `/summarize <source>` | Summary of a paper, repository, or PDF |

Results are saved to `outputs/` (drafts to `papers/`). `/lit`, `/deepresearch`, and `/recipe` also write a provenance file listing the sources used and what was verified.

Run `/outputs` in chat to browse **Reports**, **Provenance**, **Drafts**, and **Other artifacts**, newest first within each group. Choosing a Markdown report opens it directly in the TUI. Use arrows/Page Up/Page Down to scroll, `/` or `Ctrl+F` to search, `n`/`N` for the next/previous matching row, `p` for the same-name report/provenance beside the current file, and `c` to copy its absolute path. `Esc` returns to the file list. Text previews are limited to 2 MiB; PDFs and larger files offer path copying and an explicit **Read in chat** action. Viewing and copying preserve the composer; **Read in chat** (or `r` in the reader) prefills a quoted file path for you to review and submit.

Use `/compare-provenance` in the chat TUI to compare the recorded verification and source-coverage fields from two completed runs. It compares metadata only and does not rank the runs.

## Persistent experiments

`/autoresearch <idea>` now uses a durable benchmark runner. A user-approved contract freezes argv, metric, seeds, baseline code, data files and budget; each configuration stores observed metrics, exit status, code snapshots and log hashes. Its environment fingerprint binds the label, host platform/architecture/Node runtime, executable and declared frozen-input hashes. Include dependency lockfiles as frozen inputs and use an immutable container image digest in the label; arbitrary environment variables and installed-package inventories are not captured. Do not put credentials in the label or frozen inputs. Valid baselines are cached. Pause/resume preserves the trial/time budget, and keep/revert decisions operate only on declared files.

Use `/experiments create <goal>` or describe a benchmark request in chat. Hypatia inspects prerequisites, labels inferred defaults, and groups missing critical information into one chat question. A complete frozen contract gets one approval dialog. `/experiments create-json <path>` loads a saved contract. You can create/import, approve, inspect, pause/resume or export a run, and `/outputs` to read final reports/provenance or logs. AutoResearch exported ideas are validated and snapshotted using its schema-1 provenance; set `HYPATIA_AUTORESEARCH_ROOT` to the local clone for imports. Import creates planned state. The footer follows persisted experiment state across chat turns.

New contracts require a critic review before baseline execution and an auditor review before closure. Reviews run in fresh Pi sessions with evidence-read access only, using the configured role model routes. A verdict binds exact evidence hashes; blockers, malformed output and stale evidence prevent gate passage. Reports retain review findings, actual model identity and reported usage. Review model usage is separate from the benchmark time budget. Explicit benchmark-only contracts and legacy contracts show their review policy.

For sibling comparisons, `/experiments tree create` starts an experiment tree in a clean Git repository root. Each node runs in a detached worktree under `experiments/.trees/`, and a child is seeded from its closed parent's verified best snapshot. Nodes keep the existing version-1 contracts and review gates while sharing trial, wall-time and parallel-run limits. Keep node `HEAD` at the captured base commit and leave candidate edits uncommitted for receipt snapshots. Use `/experiments tree status <slug>`, `fork`, `pause`, `resume`, `promote`, and `close`; promotion records the verified winner but does not merge or change the checkout. Tree closure writes an aggregate report and provenance sidecar. Ordinary version-1 experiments still work in dirty or non-Git workspaces.

The implementation runs bounded benchmarks on macOS/Linux; Windows can manage/import state while execution requires a supported host. Metrics use one `HYPATIA_METRIC {"key": value}` stdout record per seed or a fresh JSON metric file. Legacy autoresearch logs are preserved. See the [workflow documentation](website/src/content/docs/workflows/autoresearch.md) for the contract and limits. After a source update, build and restart Hypatia to load `dist/experiments/`.

### Idea Forge generation

Use `/idea <research signal>` (also `/experiments generate <goal>`) or choose **`/idea <research goal>` in the menu** to describe your goal in chat. The TUI opens an opaque model-panel selector docked above the message input: keep one model (the current model is preselected) or choose three distinct available models. Before generation, a scrollable review panel groups the research goal, model panel, resources and limits, and estimates up to three requests per selected model. Contracts with too few requests for the selected panel are rejected before approval. Unless you request other limits, native Idea Forge defaults to 12 API attempts, 900 seconds total, 5000 output tokens per request and 90 seconds per request. Approving the frozen contract starts generation in the same tool flow; approval covers idea calls only, not a benchmark. Native generation includes QML, information retrieval/ranking, RAG evaluation, agent evaluation, statistics, general ML/LLM and research-design guidance. No AutoResearch clone, Python venv or separate credentials are needed. Single-model critique is labeled non-independent. A relevant project knowledge file can be supplied instead of built-in guidance. Unrelated explicit directions fail preflight before generation calls.

For broad, chat-based brainstorming before choosing a direction, use the bundled `research-ideation` skill. It returns 3–5 speculative candidates without starting separate Idea Forge panel calls; continue with `/idea` when you want a bounded proposal and model panel.

Approve one frozen generation contract before its model calls. Request/time/token caps, runtime/model/knowledge identity, response cache and receipts persist across pause/resume. `/experiments ideas` browses proposals with a readable scrollable Preview and a status view containing request/cache/receipt integrity; selecting an idea sends it to chat with verified artifact provenance; benchmark execution needs a separate contract approval. Generated text, citations and model reviews remain unverified. Existing Python-backed runs remain inspectable/resumable with their original backend configuration; new native runs ignore that optional legacy configuration. See the [workflow documentation](website/src/content/docs/workflows/autoresearch.md#idea-forge-generation).

## Chat TUI

The bundled `hypatia` theme uses Graphite colors: soft white text, a pale blue accent, and charcoal panels. Success is green, warnings are yellow, and errors are red in chat and CLI output. Select a theme in `/settings` and run `/reload` after updating the bundled theme. For the full Graphite palette, set your terminal background to `#151515` and foreground to `#E6E6E6`; the terminal controls the base screen colors.

The chat TUI starts in fullscreen mode so the transcript scrolls while the composer and status stay in view. The header keeps Hypatia, project, and session. A two-row footer shows model, thinking level, context, token usage, and recorded cost on the first row; the second shows live activity or research shortcuts when idle. Errors and waiting states take priority, and narrow windows shorten labels and omit usage detail without adding rows. Retries and queued continuations keep the busy status. Change the layout with `/settings` or set `tuiMode` to `regular` in `~/.hypatia/agent/settings.json`.

An empty fullscreen session shows the supplied Hypatia PNG centered in chat, with its transparent background showing the terminal through. Pi renders it directly in terminals that support inline images; otherwise Hypatia automatically renders the same PNG as a truecolor terminal image. The splash disappears as soon as you enter a slash command, use a keyboard shortcut, or send your first message; it is not added to the transcript or model context. Regular TUI mode uses a compact scale.

Transcript messages have **You** and **Hypatia** labels: your messages sit on charcoal panels, and answers use the open reading area with a small blue marker. The composer has a thin `› Message` border and a research placeholder when empty; its lower border follows Pi's border color when the upper border shows an active Working status. An English **Tip** appears above the composer only when the editor is empty and the main agent, tools, subagents, and blocking input have finished. Successful visible tool results suggest the configured key to expand tool details; new or updated report files suggest `/outputs`. Otherwise it shows your newline/send keys and `/hotkeys`. Report tips observe file metadata in `outputs/` and `papers/`, excluding hidden files, drafts, provenance, and links; they do not certify report completion or verification. Tips follow your current bindings after reload and add no conversation message. The composer grows with multiline input within Pi's viewport limit; overflow counts and autocomplete remain available. Run `/reload` while idle to load the presentation update; a custom editor installed by another extension takes precedence.

Completed answers compact arXiv, OpenReview, and DOI URLs into short source labels; OSC 8 terminals make those labels clickable. Bibliography entries emphasize citation numbers and titles while muting venue/year details. Deep Markdown headings use clean heading styling without visible `###` prefixes, and explicit verification and completeness notes appear as amber callouts. These changes affect TUI rendering only; transcript text, model context, and exports keep their original content.

Paste a clipboard image with the configured image-paste shortcut (usually `Ctrl+V` on macOS). Hypatia also recognizes temporary image paths pasted by Orca. The composer shows a compact, accent-blue `[Image #1]` marker instead of the path; when you send, Hypatia attaches the image data to the prompt. The marker stays in the user message so you can see which image you sent.

While a turn runs, the chat area groups its activity, operations, filenames, and observed issues in one live line. After the turn, a transcript entry records the outcome, elapsed time, local finish time, and operation groups. Press `Ctrl+O` to expand the operation list and available tool error details. Tool labels show file basenames rather than full paths. Tool arguments and result bodies are not copied into the summary.

Changing **TUI mode** in `/settings` switches and saves the new mode immediately; the transcript confirms that a restart is not required. If a saved mode differs from the current interface after settings reload, Hypatia reports that the current session still uses the old mode and needs a restart.

Warning-level notifications from Hypatia extensions are collected in a footer badge such as `⚠ 6 warnings · F2 to view`. Press **F2**, choose a warning to read its full text, then press **d** to dismiss it. When a user skill shadows a bundled Hypatia skill, Hypatia filters the skipped bundle copy before Pi loads resources. The winning user skill stays active, and the collision no longer appears in the startup panel or warning inbox. Other unresolved Pi skill diagnostics remain available through F2.

Tips use English labels. Default composer keys: **Enter** sends, **Shift+Enter** inserts a newline (**Ctrl+J** also works), and **Alt+Enter** queues a follow-up. Edit `~/.hypatia/agent/keybindings.json` and run `/reload` to change them; existing user keybindings are retained on upgrade.

Usage totals remain cumulative through compaction. `↑` includes uncached input plus cache reads/writes; `↓` is output. `R`/`W` show cache detail when space permits. `--` marks unavailable values, `+` marks a partial total, and `sub` identifies the active provider's subscription access. Monetary figures use Pi's recorded catalog-price estimates.

Paper search (`alpha_search` and `hypatia_science_database_search`) and `alpha_get_paper` show compact summaries with recorded tool duration. Search summaries also show source, returned-result counts, fallback reasons, and notes. Press `Ctrl+O` to expand the full tool result. Counts describe returned records; alphaXiv's overlapping search modes show separate counts rather than an invented unique total.

## Per-role model routing

Active subagent model and progress appear in the footer only while agents are running.

Hypatia's bundled `evidence-scout`, `scribe`, `auditor`, `critic`, and `reviser` agents inherit the main model unless you configure a route. In the chat TUI, run `/model-routes`; from a shell, run `hypatia model routes`. Both configure a primary model and ordered launch fallbacks for each role. The picker distinguishes **Use Pi override** from **Inherit parent model**; the latter clears the role's single-model Pi override while preserving its other settings. Use `hypatia model routes --json` to inspect the effective routes without a TTY. `/subagents` remains the separate agent-selection menu. You can also edit `~/.hypatia/agent/model-routes.json` directly:

```json
{
  "version": 1,
  "roles": {
    "evidence-scout": ["openai-codex/gpt-5.6-luna", "openai/gpt-5.6-terra"],
    "auditor": ["anthropic/claude-opus-5-5", "openai/gpt-5.6-terra"],
    "critic": ["anthropic/claude-opus-5-5", "openai/gpt-5.6-terra"],
    "scribe": ["anthropic/claude-sonnet-5-5", "openai/gpt-5.6-terra"],
    "reviser": ["anthropic/claude-sonnet-5-5", "openai/gpt-5.6-terra"]
  }
}
```

Existing v1 model-route keys and `subagents.agentOverrides` keys migrate to the new names at startup; when both old and new keys set the same field, the canonical value wins. The old `writer`, `verifier`, and `patcher` selectors remain aliases. Use `evidence-scout` and `critic` instead of `researcher` and `reviewer`, which Pi reserves for its built-in agents.

Hypatia serializes startup settings normalization with a lock in the Pi agent directory (`~/.hypatia/agent/.hypatia-settings.lock` by default); command-specific model and service-tier writes use their own paths. If startup times out waiting for the lock, the error names its path; remove a stale lock only after confirming no Hypatia startup is active.

Use exact `provider/model` IDs from `hypatia model list`. The `hypatia_subagent_models` tool reports the configured order. Hypatia starts with the first model and tries the next only if Pi rejects launch before the child starts because its model/provider is unavailable; it does not switch models after execution begins. An empty route keeps Pi's per-agent override or parent-model behavior. Existing `subagents.agentOverrides.<role>.model` settings remain supported. Eval JSONL results and research provenance report actual models and usage returned by Pi, not estimates.

## Evaluation

The repository includes the fixed research eval plus score adapters for ScholarQA-CS2/AstaBench, DeepResearch Bench FACT, and SciCoQA. The runner accepts local question manifests; score adapters consume local outputs from the official evaluators and do not fetch gated data or make judge calls. See [`evals/README.md`](evals/README.md) for input schemas, pinned sources, and scoring commands.

## Sources

Hypatia searches alphaXiv, Semantic Scholar, OpenAlex, arXiv, PubMed, Europe PMC, bioRxiv, medRxiv, Crossref, CORE, DOAB, public GitHub code, the web, and Hugging Face, recovers legal open-access copies for paywalled DOIs, and reads local PDFs and documents. Free `OPENALEX_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY`, and `CORE_API_KEY` keys avoid the shared rate limits; `UNPAYWALL_EMAIL` enables the Unpaywall step of OA recovery. It runs on stock [Pi](https://github.com/earendil-works/pi) with five research agents: evidence-scout, scribe, auditor, critic, and reviser.

## Telemetry

Hypatia sends anonymous usage data to PostHog only if you opt in with `HYPATIA_TELEMETRY=1` and your own `HYPATIA_POSTHOG_KEY`: commands, workflows, tools, models, token counts, and errors with their messages and stack traces (your home folder shown as `~`). It never sends prompts, model output, paper content, or tool arguments. Telemetry is off by default. [What is sent](https://github.com/TQuang122/hypatia/blob/main/website/src/content/docs/getting-started/configuration.md#telemetry)

## Contributing

```bash
git clone https://github.com/TQuang122/hypatia.git
cd hypatia
npm install
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

[Docs](https://github.com/TQuang122/hypatia/docs) · [Release notes](RELEASES.md) · [MIT License](LICENSE)
