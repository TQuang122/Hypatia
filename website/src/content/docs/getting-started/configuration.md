---
title: Configuration
description: Understand Hypatia's configuration files and environment variables.
section: Getting Started
order: 4
---

Hypatia stores user-level configuration and state under `~/.hypatia/`, created on first run. Set `HYPATIA_HOME` to use `<HYPATIA_HOME>/.hypatia` instead.

## Directory structure

```
~/.hypatia/
├── agent/                  # Pi agent dir (PI_CODING_AGENT_DIR)
│   ├── settings.json       # Default model, thinking level, packages
│   ├── model-routes.json   # Ordered model preferences for research subagents
│   ├── auth.json           # Provider credentials (user-only permissions)
│   ├── models.json         # Custom and local providers
│   ├── web-search.json     # Web search provider and keys
│   ├── web-search-cache/   # Fetched pages, kept for one hour
│   ├── extensions/subagent/config.json  # Subagent runtime config
│   └── npm/                # Optional Pi packages from `hypatia packages install`
├── sessions/               # Session transcripts (JSONL)
├── bin/                    # `hypatia` shim used by child agents
└── .state/                 # Telemetry install ID and first-run notice state
```

`agent/settings.json` is the main configuration file. Hypatia fills in missing defaults on every launch, and you can edit it by hand. The model fields look like:

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5.6-terra",
  "defaultThinkingLevel": "medium"
}
```

## Terminal layout

The bundled `hypatia` theme uses the Graphite palette, shared by the chat UI and CLI output:

| Role | Color |
| --- | --- |
| Text | Soft white `#E6E6E6` |
| Accent | Pale blue `#93C5FD` |
| Panels | Charcoal `#222222` |
| Selection | Blue gray `#2B3A4D` |
| Success | Green `#86EFAC` |
| Warning | Yellow `#FCD34D` |
| Error | Red `#FCA5A5` |

Choose a theme through `/settings`. The Graphite palette keeps the theme name `hypatia`, so existing selections continue to work. Run `/reload` after an update to refresh the bundled theme. Pi uses the terminal's base background; for the full Graphite appearance, set your terminal background to `#151515` and foreground to `#E6E6E6`.

An empty fullscreen session shows the supplied Hypatia PNG centered in chat, with its transparent background showing the terminal through. Pi renders it directly in terminals that support inline images; otherwise Hypatia automatically renders the same PNG as a truecolor terminal image. Slash commands and keyboard shortcuts dismiss it immediately; it is not added to the transcript or model context. Regular TUI mode uses a compact scale.

The transcript labels prompts **You** on charcoal panels and answers **Hypatia** with a small accent marker. Answers retain an open layout, and thinking uses quieter text. These labels are display-only; stored messages and model context keep their original content. Very narrow transcript widths omit labels to leave space for the content.

The composer uses a thin `› Message` border and an empty-state research placeholder. Its lower border follows Pi's border color when the upper border shows an active **Working** status; while idle, it keeps the muted lower border. A **Tip** appears in the chat area above it only when the editor is empty and the main agent, tools, subagents, and blocking input are idle. Typing or running work removes the tip row; it returns after work fully settles and the editor is cleared. Shortcut help stays outside the input border.

Paste a clipboard image with the configured image-paste shortcut (usually `Ctrl+V` on macOS). Hypatia also recognizes temporary image paths pasted by Orca. The composer shows a compact, accent-blue `[Image #1]` marker instead of the temporary file path. Submitting the prompt attaches the image data as image content; the marker remains visible in the user message.

While a turn runs, a live **Exploring** line groups observed operations, file basenames, and issue counts. Once the whole turn settles, the transcript gets a compact receipt with its outcome, elapsed time, local finish time, and grouped work. Press `Ctrl+O` to expand the operations and available tool error details. The summary excludes full paths, tool arguments, and result bodies.

Changing **TUI mode** in `/settings` applies and saves the new layout immediately; a chat entry confirms that no restart is needed. If settings are reloaded with a TUI mode different from the active layout, Hypatia reports that the current session needs a restart to use the saved mode.

Warning-level notifications from Hypatia extensions are collected into a footer badge, for example `⚠ 6 warnings · F2 to view`. Press **F2** to open the warning list, select an item to read the full text, and press **d** in the detail view to dismiss it. When a user skill shadows a bundled Hypatia skill, Hypatia filters the skipped package copy before Pi loads resources. The winning user skill remains active and the resolved collision no longer appears in startup diagnostics or the warning inbox. Other unresolved Pi skill diagnostics remain available through F2.

Tips use the latest observed context:

- A successful tool result visible in the transcript: `Press Ctrl+O to expand tool details.` The key follows your current bindings; an unbound expand action falls back to general shortcut help. Nested calls without their own transcript entry do not trigger this tip.
- A new or updated report after work settles: `Use /outputs to read your report.` Report availability takes priority over the tool tip. Metadata snapshots observe `outputs/` and `papers/`, using the same report classification as `/outputs`; hidden paths, drafts, provenance, and links are excluded. This makes no claim about report completion or verification.
- Otherwise: your current newline/send keys and `/hotkeys`.

Tips are native UI widgets and add nothing to stored conversation messages or model context. They resolve current bindings and theme when rendered, including after reload; no rotation timer runs. In narrow windows tips wrap naturally. Multiline overflow retains Pi's hidden-line counts. Input grows within Pi's viewport limit, and shell mode uses a `Shell` label. Padding, input history, image paste, cursor placement, and application shortcuts remain provided by Pi. An editor installed by another extension takes precedence. Reload an idle chat to apply these presentation changes.

New installations bind **Enter** to send, **Shift+Enter** and **Ctrl+J** to insert a newline, and **Alt+Enter** to queue a follow-up. Existing user keybindings are preserved on upgrade. To use this mapping in an existing installation, edit `~/.hypatia/agent/keybindings.json`:

```json
{
  "tui.input.newLine": ["shift+enter", "ctrl+j"],
  "tui.input.submit": ["enter"],
  "app.message.followUp": ["alt+enter"]
}
```

Tips use English labels. Run `/reload` to apply the file and refresh the tip in chat. Shift+Enter depends on your terminal reporting modified Enter; Ctrl+J is the fallback.

Hypatia defaults to Pi's fullscreen TUI: the transcript scrolls inside the terminal while the composer and status remain in view. The header keeps Hypatia, project, and session. The footer uses two rows:

- Model, thinking level, context usage, cumulative token usage, and recorded cost.
- Observed activity and elapsed time, or research shortcuts when idle. Errors and waiting states take priority; narrow windows preserve the leading activity and elapsed time where space permits.

The first row shortens the model label and omits lower-priority detail when space is limited. `↑` counts uncached input plus cache reads/writes, `↓` counts output, and `R`/`W` show the cache portion when space permits. Totals include the full session, cache warming, tool-reported usage, and compaction/branch summaries. `--` marks unavailable data; `+` marks a partial total. Monetary figures use Pi's recorded catalog-price estimates, and `sub` identifies subscription access for the active provider.

The activity row follows processing, thinking, answering, searching or reading sources, writing files, waiting for input, and subagents. Retries and queued continuations keep the busy status. Failed or interrupted turns display their observed outcome. Footer status omits prompts, queries, and task text. Change the layout with `/settings`, or set `"tuiMode": "regular"` in `~/.hypatia/agent/settings.json`. Pi currently labels fullscreen mode experimental.

Paper-discovery tools (`alpha_search` and `hypatia_science_database_search`) use compact summaries showing the source, returned-result count, and recorded tool duration when available. `alpha_get_paper` also shows a compact paper-read summary with its duration. Fallback reasons, source notes, and errors remain visible in the collapsed view. Press `Ctrl+O` to expand the original result, including its identifiers and provenance. Counts describe returned records, which may be papers, authors, books, or other lookup results. alphaXiv's `both` and `all` modes retain separate group counts because their results can overlap.

Completed assistant answers compact arXiv, OpenReview, and DOI URLs into short labels; OSC 8 terminals make the labels clickable. Citation entries give numbers and titles more weight, show venue/year details in muted text, and render explicit verification or completeness notes as amber callouts. Heading levels 3–6 use clean heading styling without visible `###` markers. This is a TUI-only Markdown transformation: saved transcript text, model context, and exports remain unchanged.

## Experiment imports and execution

`/experiments` manages benchmark jobs under `experiments/<slug>/`; the footer reads their persisted state. `/autoresearch` or `/experiments create <goal>` prepares a contract in chat for user approval and reuses its approval/budget on resume. Source checkouts need `npm run build` and a restart after updating the compiled experiment engine; packaged installs include it.

For AutoResearch exported ideas, configure `HYPATIA_AUTORESEARCH_ROOT` or `~/.hypatia/agent/autoresearch-backend.json` with a `root` path. Imports validate source hashes and snapshot idea/Forge/knowledge files. They produce planned state without launching models or benchmarks. See [Autoresearch](/hypatia/docs/workflows/autoresearch) for contract limits and the macOS/Linux execution support boundary.

## Model configuration

`defaultProvider` and `defaultModel` set the model used when you launch without `--model`. Only providers you have authenticated appear in `hypatia model list`. To add a provider, sign in to it, then switch the default:

```bash
hypatia model login anthropic
hypatia model list
hypatia model set anthropic/claude-opus-5-5
```

`hypatia model login` with no provider shows the OAuth and API-key choices. `model set` accepts `provider/model` or `provider:model`. Pro-class model IDs are rejected here and in `--model`. See [Setup](/hypatia/docs/getting-started/setup) for OAuth on headless machines, Amazon Bedrock, and local models.

## Web search configuration

Web search, page fetching, and PDF extraction come from the bundled `pi-web-access` package, configured in `~/.hypatia/agent/web-search.json`. The default `auto` route works without keys through Exa and uses any other provider you have configured. Set a provider and key from the CLI:

```bash
hypatia search status
hypatia search set perplexity <api-key>   # or exa, gemini, auto
hypatia search clear                      # back to auto, keys kept
```

The [pi-web-access README](https://github.com/nicobailon/pi-web-access#readme) documents every provider and option, including PDF extraction.

## Subagent model overrides

The header keeps project and session identity; the first footer row keeps the active model, thinking level, context, and usage. Delegated role, model, current tool, and progress appear in the activity row while subagents are active.

The bundled subagents (`evidence-scout`, `scribe`, `auditor`, `critic`, `reviser`) inherit the main research model unless you configure a route. Use `/model-routes` in chat or `hypatia model routes` in a shell to choose a primary model and ordered launch fallbacks. The picker labels whether a role uses an explicit route, a Pi role override, or the parent model. **Use Pi override** clears the explicit route and keeps `subagents.agentOverrides.<name>.model`; **Inherit parent model** clears both model overrides so the role follows the chat model while preserving other Pi role settings. For a native Pi single-model override, set `subagents.agentOverrides.<name>.model` in `~/.hypatia/agent/settings.json`. `/subagents` is a separate agent-inspection and selection menu, not the model-route editor. Hypatia sets `subagents.agentExcludeDirs` to `["~/.agents"]` so agent files there cannot replace the bundled agents, and `subagents.defaultSubagentOnlyExtensions` to its research tools and pi-web-access so every subagent can search, including foreground runs. It rewrites that list on each launch unless you replace it with your own.

For ordered per-role preferences and fallback candidates, create `~/.hypatia/agent/model-routes.json`:

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

You can configure the same file from the chat TUI with `/model-routes` or from a shell with `hypatia model routes`. Choose a role, select its primary model, then add fallback models in their exact order. The picker lists authenticated non-premium models. On a headless machine, use `hypatia model routes --json` to inspect the effective routes.

Existing v1 route keys and `subagents.agentOverrides` keys migrate to the canonical names at startup; when both old and new keys set the same field, the canonical value wins. The former `writer`, `verifier`, and `patcher` selectors remain aliases. Use `evidence-scout` and `critic` instead of `researcher` and `reviewer`, which Pi reserves for built-in agents.

Hypatia serializes startup settings normalization with a lock in the Pi agent directory (`~/.hypatia/agent/.hypatia-settings.lock` by default); command-specific model and service-tier writes use their own paths. If startup times out waiting for the lock, the error names its path; remove a stale lock only after confirming no Hypatia startup is active.

Use exact `provider/model` IDs shown by `hypatia model list`; each role accepts up to eight ordered candidates. The `hypatia_subagent_models` tool reports the effective route. A route in this file takes precedence over that role's `subagents.agentOverrides.<name>.model`; roles without a route keep the Pi override or inherit the parent model. Hypatia passes the first candidate as the per-run model. It tries the next candidate only if Pi rejects launch before the child starts because its model/provider is unavailable; it does not switch models after execution begins.

Subagent results expose the actual model and reported token/cost usage. `/deepresearch`, `/lit`, and `/recipe` provenance records that data by role and attempt; eval JSONL rows and Markdown summaries include `usage_by_role`. Missing provider usage remains `not reported` rather than being estimated.

The subagent runtime config at `~/.hypatia/agent/extensions/subagent/config.json` defaults to background delegation on and missions and the fleet view off. Hypatia fills in only missing values and leaves your changes alone.

## Thinking levels

`defaultThinkingLevel` sets how much the model reasons before responding: `off`, `minimal`, `low`, `medium` (default), `high`, `xhigh`, or `max`, subject to the active model's capabilities. Override it for one run:

```bash
hypatia --thinking high
```

## Codemode (optional)

Use `hypatia --codemode` to add Pi Codemode for one session without replacing Hypatia's default tools. To keep Codemode available in every session, add this to `~/.hypatia/agent/settings.json`:

```json
{
  "defaultTools": ["+codemode"]
}
```

Codemode lets the model call available tools from a script, which can help with multi-source research and filtering large results. It does not verify evidence by itself; Hypatia's source checks still apply.

## Environment variables

Hypatia reads these environment variables. `HYPATIA_MODEL`, `HYPATIA_THINKING`, and `HYPATIA_SERVICE_TIER` override `settings.json` for that run. Hypatia also loads a `.env` file from the current directory.

| Variable | Description |
| --- | --- |
| `HYPATIA_MODEL` | Model to use instead of the default (same as `--model`) |
| `HYPATIA_HOME` | Override the parent directory used to create `.hypatia` (default parent: `~`) |
| `HYPATIA_THINKING` | Thinking level (same as `--thinking`) |
| `HYPATIA_SERVICE_TIER` | Request service tier (same as `--service-tier`) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `DATALAB_API_KEY` | Optional Datalab key for layout-aware PDF-to-Markdown extraction |
| `AWS_PROFILE` | Preferred AWS profile for Amazon Bedrock |
| `EXA_API_KEY`, `PERPLEXITY_API_KEY`, `TAVILY_API_KEY`, ... | Web search provider keys read by pi-web-access |
| `OPENALEX_API_KEY` | Free OpenAlex key ([create one](https://openalex.org/settings/api)); without one, requests share a small anonymous daily budget |
| `SEMANTIC_SCHOLAR_API_KEY` | Optional free Semantic Scholar key ([request one](https://www.semanticscholar.org/product/api#api-key-form)) so searches use your own rate limit instead of the shared anonymous pool |
| `CROSSREF_MAILTO` | Your email, sent to Crossref so requests use its faster polite pool (3 per second instead of 1) |
| `NCBI_API_KEY` | Optional NCBI E-utilities key; NCBI allows 10 requests per second with a key instead of 3 |
| `HYPATIA_TELEMETRY` | Set to `1` to opt in to anonymous usage telemetry (off by default; `DO_NOT_TRACK=1` also keeps it off) |
| `HYPATIA_POSTHOG_KEY` | Your own PostHog project key; required for opt-in telemetry (no default project) |
| `HYPATIA_TOOL_BUDGET` | Max top-level tool calls per session; unset means unlimited |
| `HYPATIA_AUTORESEARCH_ROOT` | Local AutoResearch repository root for validating exported idea provenance |
| `HYPATIA_CONTEXT7` | Set to `1` to register the Context7 MCP server (versioned library docs, fetched via npx) |
| `CORE_API_KEY` | Free CORE key ([create one](https://core.ac.uk/services/api)); without one, CORE results are metadata-only with no full text |
| `UNPAYWALL_EMAIL` | Your email, required for the Unpaywall step of OA recovery (`NCBI_EMAIL` works as a fallback) |

## Telemetry

Hypatia telemetry is off by default and nothing is sent unless you opt in. To opt in, set `HYPATIA_TELEMETRY=1` and provide your own PostHog project key via `HYPATIA_POSTHOG_KEY`. The install ID is a random value stored in `~/.hypatia/.state/telemetry.json`. Person profiles and GeoIP lookup are off.

Hypatia never sends prompts, model output, paper or document content, or tool arguments. When something fails, it sends the error message and stack trace, the end of Pi's error output, and a failed tool's error text, with your home folder shown as `~`. These can include file paths inside your projects.

To opt out, nothing is sent unless you opt in:

```bash
export HYPATIA_TELEMETRY=1              # opt in
export HYPATIA_POSTHOG_KEY=<your key>   # your own PostHog project
export DO_NOT_TRACK=1                   # always keeps telemetry off
```

`hypatia status` shows whether telemetry is on.

What is sent:

| Event | Properties |
|-------|------------|
| `hypatia_command_started`, `hypatia_command_completed`, `hypatia_command_failed` | Command and allow-listed subcommand, output mode, whether a prompt, model, service tier, or new-session flag was given, duration, exit code, error name and message; for a failed run, the last lines of Pi's error output. Errors thrown by Hypatia also go to PostHog error tracking with their stack trace |
| `hypatia_session_started` | Why the session started (startup, resume, new, fork, reload), mode, model and provider name |
| `hypatia_workflow_started` | Workflow name (`deepresearch`, `lit`, `review`, and so on; `chat` for anything else) |
| `hypatia_workflow_completed` | Workflow name, status (`completed`, `error`, `aborted`), tool and subagent call counts, whether any file under `outputs/` or `papers/` was written (yes or no), duration |
| `hypatia_tool_used` | Tool name, whether it failed and its error text, whether a subagent called it |
| `$ai_generation` | [PostHog LLM analytics](https://posthog.com/docs/llm-analytics/generations) metadata for each model response: model, provider, input, output, and cache token counts, latency, HTTP status, stop reason, error flag and provider error message, and the Pi session ID as the trace ID. No `$ai_input` or `$ai_output_choices`. |

Every event also carries the Hypatia version, Node.js version, platform, and CPU architecture.

Each send is tried once. The first network or ingest failure turns telemetry off for the rest of that process without printing anything; set `HYPATIA_DEBUG=1` to see the single CLI diagnostic.

## Session storage

Sessions are saved as JSONL files in `~/.hypatia/sessions/`. An interactive `hypatia` launch continues the most recent session for the current directory. Session flags:

```bash
hypatia --new-session                 # start a new session
hypatia --codemode                    # add Pi Codemode for this session
hypatia --resume                      # pick a previous session
hypatia --session <path|id>           # open a specific session
hypatia --fork <path|id>              # fork a session into a new one
hypatia --no-session                  # in-memory session, not saved
hypatia --export <session.jsonl> [out.html]   # export a session to HTML
hypatia --session-dir <path>          # store sessions somewhere else
```

## Diagnostics

`hypatia doctor` checks alphaXiv auth, the default model and authenticated providers, `models.json`, pandoc, web search config, and the Pi runtime, and prints next steps. `hypatia status` prints a shorter summary.


### Native Idea Forge

`research-ideation` is available for broad chat-based brainstorming before a direction is chosen. It returns a few speculative candidates without starting separate Idea Forge panel calls; use `/idea` to prepare one bounded proposal. In the TUI, entering a goal opens an opaque selector above the message input for one current model or three distinct available models; no model list is needed in the prompt. A scrollable contract review groups the goal, model panel, resources and caps, estimates up to three requests per selected model, and rejects a cap below the selected panel's full-run estimate. Unless specified otherwise, limits are 12 API attempts, 900 seconds, 5000 output tokens per request and 90 seconds per request. Approving the contract starts Idea Forge automatically; benchmark execution still requires its own contract approval. Native knowledge directions now include retrieval/ranking, RAG evaluation, agent evaluation and statistical design, alongside QML, ML, LLM and general research; custom project knowledge can replace them. No clone, Python venv or separate credentials are needed for new native runs. Critical missing information is grouped into one chat question. Existing legacy Python runs continue using `autoresearch-backend.json`; that file is ignored by new native generation. See [Idea Forge generation](/hypatia/docs/workflows/autoresearch#idea-forge-generation).
