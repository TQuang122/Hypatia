---
title: CLI Commands
description: Complete reference for all Hypatia CLI commands and flags.
section: Reference
order: 1
---

This page covers the Hypatia CLI commands and flags. `hypatia help` prints the same list. Workflow commands like `hypatia deepresearch` map directly to the REPL [slash commands](/hypatia/docs/reference/slash-commands).

## Core commands

| Command | Description |
| --- | --- |
| `hypatia` | Launch the interactive REPL |
| `hypatia chat [prompt]` | Start chat explicitly, optionally with an initial prompt |
| `hypatia help` | Show CLI help |
| `hypatia setup` | Run the guided setup wizard |
| `hypatia setup preview` | Install or verify pandoc |
| `hypatia doctor` | Diagnose config, auth, Pi runtime, and preview dependencies |
| `hypatia status` | Show the current setup summary (model, auth, alphaXiv, web access, service tier, telemetry) |

## Model management

| Command | Description |
| --- | --- |
| `hypatia model list` | List available models in Pi auth storage |
| `hypatia model login [id]` | Authenticate a model provider with OAuth or API-key setup; legacy Azure provider settings migrate on startup |
| `hypatia model logout [id]` | Clear stored auth for a model provider |
| `hypatia model set [provider/model]` | Set the default approved research model for all sessions; without one, pick from a list |
| `hypatia model routes [--json]` | Configure ordered primary/fallback models per subagent role, or inspect the effective routes as JSON |
| `hypatia model tier [value]` | View or set the request service tier override |

The `model set` command updates `~/.hypatia/agent/settings.json` with the new default. It accepts either `provider/model-name` or `provider:model-name`; run `hypatia model list` first and choose a model ID from that output, or run `hypatia model set` alone to pick from the available models. When a model is not usable, the error says why: no credentials for its provider, a local provider in `models.json` without an `apiKey` placeholder, or close matches for an unknown ID. `hypatia model help` lists these commands. `hypatia model login <id>` goes straight to API-key setup for API-key providers such as `google`, `azure`, `amazon-bedrock`, and `openrouter`. For OAuth logins in SSH or other headless sessions, paste the final redirect URL into Hypatia when the browser runs on another machine.

`hypatia model routes` opens an interactive editor in the shell; `/model-routes` opens the editor in the chat TUI. Each role can use up to eight authenticated non-premium model IDs, in order. The picker distinguishes **Use Pi override** (remove the explicit route, keep the single-model Pi override) from **Inherit parent model** (remove both model overrides and preserve other role settings). The chat header is two lines, and active subagent/model/tool progress appears in the footer until delegation ends. `hypatia model routes --json` prints the resolved route sources without prompting.

## AlphaXiv commands

| Command | Description |
| --- | --- |
| `hypatia alpha login` | Sign in to alphaXiv |
| `hypatia alpha logout` | Clear alphaXiv auth |
| `hypatia alpha status` | Check alphaXiv auth status |
| `hypatia alpha search "query"` | Search papers through Hypatia's bundled alphaXiv client |
| `hypatia alpha get <id-or-url>` | Fetch paper content and local annotations |
| `hypatia alpha ask <id-or-url> "question"` | Ask a question about a paper |
| `hypatia alpha code <github-url> [path]` | Inspect a paper repository |
| `hypatia alpha annotate ...` | Read, write, list, or clear local paper notes |

Use `hypatia alpha ...` rather than a global `alpha` binary so the bundled client runs. See [AlphaXiv](/hypatia/docs/tools/alphaxiv).

## Package management

| Command | Description |
| --- | --- |
| `hypatia packages list` | Show core packages and optional package presets |
| `hypatia packages install <preset>` | Install an optional package preset |
| `hypatia update [package]` | Update optional Pi packages you installed, or one of them; core packages update with Hypatia |

See [Package Stack](/hypatia/docs/reference/package-stack) for the core packages and optional presets.

## Web search

| Command | Description |
| --- | --- |
| `hypatia search status` | Show Pi web-access status and config path |
| `hypatia search set <provider> [api-key]` | Set the web search provider (`auto`, `exa`, `perplexity`, or `gemini`) and optionally save its API key |
| `hypatia search clear` | Reset the web search provider to `auto` while keeping API keys |

See [Web Search](/hypatia/docs/tools/web-search).

## REPL hotkeys

Inside the interactive REPL, use `/hotkeys` to show the live keyboard map. The default reasoning controls are:

| Hotkey | Action |
| --- | --- |
| `Shift+Tab` | Cycle thinking/reasoning level |
| `Ctrl+T` | Collapse or expand thinking blocks |

## Workflow commands

Every workflow prompt can also be run directly from the CLI:

```bash
hypatia deepresearch "topic"
hypatia lit "topic-or-lab"
hypatia review artifact.md
hypatia audit 2401.12345
hypatia replicate "claim"
hypatia recipe "fine-tune a small model for math reasoning"
hypatia compare "topic"
hypatia draft "topic"
hypatia autoresearch "idea"
hypatia summarize paper.pdf
hypatia log
```

These are equivalent to launching the REPL and typing the corresponding slash command.

For lineage-linked benchmark comparisons, use `/experiments tree ...` inside the REPL. Tree creation requires a clean Git repository root; see the [autoresearch workflow](/hypatia/docs/workflows/autoresearch#compare-sibling-candidates-with-an-experiment-tree) for shared budgets, isolated node worktrees and promotion behavior.

## Flags

| Flag | Description |
| --- | --- |
| `--prompt "<text>"` | Run one prompt and exit (one-shot mode) |
| `--model <provider/model\|provider:model>` | Force a specific approved research model for this session |
| `--service-tier <tier>` | Override the request service tier for this run |
| `--thinking <level>` | Set thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--codemode` | Add Pi Codemode for this session while keeping the default tools; off by default |
| `--cwd <path>` | Set the working directory for tools |
| `--session-dir <path>` | Set the session storage directory |
| `--new-session` | Start a new persisted session |
| `--continue`, `-c` | Continue the most recent session (the default for an interactive launch) |
| `--resume`, `-r` | Pick a previous session to resume |
| `--session <path\|id>` | Open a specific session |
| `--fork <path\|id>` | Fork a session into a new one |
| `--no-session` | Use an in-memory session that is not persisted |
| `--no-themes` | Skip theme loading (passed by ACP adapters such as pi-acp) |
| `--export <session.jsonl> [out.html]` | Export a session file to HTML and exit |
| `--alpha-login` | Sign in to alphaXiv and exit |
| `--alpha-logout` | Clear alphaXiv auth and exit |
| `--alpha-status` | Show alphaXiv auth status and exit |
| `--doctor` | Alias for `hypatia doctor` |
| `--setup-preview` | Alias for `hypatia setup preview` |

When stdin is not a terminal, `--prompt` and workflow commands do not read it, so an idle pipe from a parent process cannot stall the run. Pipe text without `--prompt` to send it as the prompt, for example `git diff | hypatia --no-session`.

Use the standard `--` delimiter before an interactive prompt that starts with
a dash, so Pi treats it as research text rather than another option:

```bash
hypatia -- "- summarize the strongest evidence first"
```

For one-shot mode, attach a dash-leading value directly to `--prompt`:

```bash
hypatia --prompt="- summarize the strongest evidence first"
```

In the chat TUI, `/idea <goal>` (alias `/experiments generate <goal>`) prepares native ideas using Hypatia model/auth, and `/experiments create <goal>` prepares benchmark contracts in chat. No AutoResearch clone is needed for native ideas. Without a goal, these commands prefill the composer. `/experiments create-json <contract-file>` loads a saved contract, and `import-json <idea-file> --contract <contract-file>` combines a selected idea with one. Generation and benchmark execution have separate approvals.
