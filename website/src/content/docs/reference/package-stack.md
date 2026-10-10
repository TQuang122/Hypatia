---
title: Package Stack
description: Core and optional Pi packages bundled with Hypatia.
section: Reference
order: 3
---

Hypatia is built on stock Pi and uses curated Pi packages for its capabilities. Hypatia itself is a Pi package: its `package.json` `pi` manifest declares its extension, prompts, skills, theme, and subagent definitions. Hypatia launches Pi with `PI_CODING_AGENT_DIR=~/.hypatia/agent` and lists itself and its core packages in `~/.hypatia/agent/settings.json` as local-path packages, so subagents load the same tools as the main session.

See Pi's upstream docs for [packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md), [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), and [skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md).

## Core packages

These are npm dependencies of Hypatia, installed with it and loaded unmodified from its install directory.

| Package | Purpose |
| --- | --- |
| `pi-subagents` | The `subagent` tool, `/subagents`, and `/run`; powers delegated and parallel research runs |
| `pi-web-access` | `web_search`, `source_check`, `fetch_content`, and `get_search_content` for web search and page, PDF, and GitHub retrieval |
| `pi-docparser` | `document_parse`, `document_search`, and `document_screenshot` for local PDFs, Office documents, spreadsheets, and images |
| `pi-btw` | `/btw` side conversations while the main research agent is busy |
| `@companion-ai/alpha-hub` | alphaXiv client library behind Hypatia's `alpha_*` tools and `hypatia alpha` |

They update when you upgrade Hypatia. You do not need to install them individually.

## Bundled research extension

Hypatia's own extension registers these tools and commands:

| Group | Contents |
| --- | --- |
| AlphaXiv tools | `alpha_search`, `alpha_get_paper`, `alpha_ask_paper`, `alpha_read_code`, `alpha_annotate_paper`, `alpha_list_annotations` |
| Science database search | `hypatia_science_database_search` over Semantic Scholar, OpenAlex, arXiv IDs, PubMed, Europe PMC, bioRxiv/medRxiv, Crossref, CORE, and DOAB |
| Hugging Face Hub tools | `hf_dataset_info`, `hf_repo_files`, `hf_repo_read_file` |
| Commands | `/help`, `/init`, `/outputs`, `/model-routes`, `/tools`, `/service-tier` |

## Optional packages

Install on demand with `hypatia packages install <preset>`.

| Package | Preset | Purpose |
| --- | --- | --- |
| `@samfp/pi-memory` | `memory` | Preference and correction memory across sessions |
| `@luxusai/pi-hindsight` | `hindsight` | Hindsight-backed long-term memory. Requires a Hindsight server or Hindsight Cloud account |

To search past Hypatia sessions without a package, search the session files directly:

```bash
rg -n "protein folding" ~/.hypatia/sessions
```

## Installing and managing packages

List core packages and optional presets:

```bash
hypatia packages list
```

Install a specific optional preset:

```bash
hypatia packages install memory
```

## Updating packages

Update the optional packages you installed, through Pi's own `pi update --extensions`:

```bash
hypatia update
```

Update one package, by preset name or Pi package source:

```bash
hypatia update memory
```

Core packages are not touched by `hypatia update` because they ship with Hypatia; to update them, upgrade Hypatia itself (rerun the installer from the [Installation guide](/hypatia/docs/getting-started/installation), or `npm install -g @TQuang122/hypatia@latest`).

## Runtime versions

The package manifest targets Pi 1.1.0 and bundles `pi-subagents` 0.74.0, `pi-web-access` 0.35.0, `pi-docparser` 4.0.0, `pi-btw` 0.7.1, and Alpha Hub 0.1.6. Pi is declared through peer dependencies; the other packages are installed with Hypatia and loaded unmodified. Every release is checked by booting the installed CLI in Pi RPC mode on Linux, macOS, and Windows.
