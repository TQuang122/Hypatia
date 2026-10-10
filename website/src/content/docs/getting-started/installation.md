---
title: Installation
description: Install Hypatia on macOS, Linux, or Windows with curl, PowerShell, or npm.
section: Getting Started
order: 1
---

Hypatia installs either as a standalone bundle or as an npm package. The standalone installer is the simplest path: it downloads a prebuilt bundle with its own Node.js runtime and verifies the release SHA-256 before installing.

## One-line installer (recommended)

On **macOS or Linux**:

```bash
curl -fsSL https://raw.githubusercontent.com/TQuang122/hypatia/main/scripts/install/install.sh | bash
```

The installer supports macOS (Apple Silicon and Intel) and Linux (x64 and arm64). It installs the launcher to `~/.local/bin`, unpacks the bundle into `~/.local/share/hypatia`, and updates your `PATH` when needed.

If you previously installed Hypatia with npm and your shell still runs the old binary, run `which -a hypatia`, then `hash -r`, or launch `~/.local/bin/hypatia` directly.

On **Windows**, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/TQuang122/hypatia/main/scripts/install/install.ps1 | iex
```

This installs the Windows x64 bundle under `%LOCALAPPDATA%\Programs\hypatia` and adds its launcher to your user `PATH`. Windows 11 on Arm runs the same bundle through x64 emulation.

Hypatia runs shell commands with Bash, so on Windows also install [Git for Windows](https://git-scm.com/download/win), which provides it. Without Bash, research runs fail at the first shell command with `No bash shell found`. To use another Bash (MSYS2, Cygwin), set `shellPath` in `~/.hypatia/agent/settings.json`.

## Alternative: npm

To install into an existing Node.js environment instead:

```bash
npm install -g @TQuang122/hypatia
```

This uses your local Node.js, which must satisfy `>=22.22.0`. npm installs Hypatia's Pi runtime as a peer dependency, so if your npm config sets `legacy-peer-deps`, add `--legacy-peer-deps=false`.

## Updating

Rerun the installer you originally used to get the latest tagged release. For npm installs:

```bash
npm install -g @TQuang122/hypatia@latest
```

`hypatia update` only updates optional Pi packages you installed with `hypatia packages install`. The core packages update with Hypatia itself.

## Pinned releases

To install an exact version:

Use a version listed in the Hypatia GitHub Releases page. Replace `<published-version>` below with that version, without the leading `v`.

```bash
VERSION="<published-version>"
curl -fsSL https://raw.githubusercontent.com/TQuang122/hypatia/main/scripts/install/install.sh | bash -s -- "$VERSION"
```

On Windows:

```powershell
$Version = "<published-version>"
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/TQuang122/hypatia/main/scripts/install/install.ps1))) -Version $Version
```

## Uninstalling

Hypatia has no `uninstall` command. Remove the launcher and bundle, and optionally the Hypatia home directory (settings, sessions, installed packages) and `~/.ahub` (alphaXiv login).

On macOS or Linux:

```bash
rm -f ~/.local/bin/hypatia
rm -rf ~/.local/share/hypatia
# optional: settings, sessions, and installed packages
rm -rf ~/.hypatia
# optional: alphaXiv login
rm -rf ~/.ahub
```

On Windows PowerShell:

```powershell
Remove-Item "$env:LOCALAPPDATA\Programs\hypatia" -Recurse -Force
# optional: settings, sessions, and installed packages
Remove-Item "$HOME\.hypatia" -Recurse -Force
# optional: alphaXiv login
Remove-Item "$HOME\.ahub" -Recurse -Force
```

Then remove `%LOCALAPPDATA%\Programs\hypatia\bin` from your user `PATH`.

For npm installs:

```bash
npm uninstall -g @TQuang122/hypatia
```

## Skills only

To install only Hypatia's research skills, without the terminal app, into `~/.codex/skills/hypatia` for Codex:

```bash
curl -fsSL https://github.com/TQuang122/hypatia/releases-skills | bash
```

To name the target explicitly, use `--codex`. For a repo-local install into `.agents/skills/hypatia`, or an OpenCode install into `.opencode/skills/hypatia`, pass a scope:

```bash
curl -fsSL https://github.com/TQuang122/hypatia/releases-skills | bash -s -- --codex
curl -fsSL https://github.com/TQuang122/hypatia/releases-skills | bash -s -- --repo
curl -fsSL https://github.com/TQuang122/hypatia/releases-skills | bash -s -- --opencode
```

On Windows:

```powershell
irm https://github.com/TQuang122/hypatia/releases-skills.ps1 | iex
& ([scriptblock]::Create((irm https://github.com/TQuang122/hypatia/releases-skills.ps1))) -Scope Codex
& ([scriptblock]::Create((irm https://github.com/TQuang122/hypatia/releases-skills.ps1))) -Scope Repo
& ([scriptblock]::Create((irm https://github.com/TQuang122/hypatia/releases-skills.ps1))) -Scope OpenCode
```

These installers copy the `skills/` and `prompts/` trees plus `AGENTS.md` and `CONTRIBUTING.md`. They do not install the Hypatia terminal, its Node.js runtime, or Pi packages.

## After installing

Check the install:

```bash
hypatia --version
```

Then run `hypatia setup` to connect a model provider (see [Setup](/hypatia/docs/getting-started/setup)). `hypatia doctor` diagnoses configuration, authentication, and runtime problems.
