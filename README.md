<p align="center">
  <img src="assets/hypatia-readme-logo.png" alt="Hypatia logo" width="120" />
</p>

<h1 align="center">Hypatia</h1>
<p align="center"><strong>Research, made traceable.</strong><br />Open-source AI research agent for scientific work.</p>

<p align="center">
  <a href="https://tquang122.github.io/hypatia/"><img alt="Documentation" src="https://img.shields.io/badge/docs-read%20the%20docs-0d9668?style=for-the-badge&logo=readthedocs&logoColor=white" /></a>
  <a href="https://github.com/TQuang122/hypatia/blob/main/LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-4b5563?style=for-the-badge" /></a>
  <a href="https://deepwiki.com/TQuang122/hypatia"><img alt="Ask DeepWiki" src="https://img.shields.io/badge/Ask-DeepWiki-2563eb?style=for-the-badge" /></a>
</p>

<p align="center">
  <img src="assets/hypatia-readme-banner-console.png" alt="Hypatia research workflows in the terminal" width="960" />
</p>

Hypatia extends Pi with source-backed workflows to discover, compare, verify, and reproduce research, with reports and provenance saved to your workspace.

## Quick start

Requires Node.js 22.22 or newer.

```bash
npm install -g @tquang122/hypatia
hypatia setup
hypatia "what do we know about scaling laws"
```

<p align="center">
  <img src="assets/hypatia-quickstart.gif" alt="Hypatia Quick Start: install, choose a model, approve a research plan, and open the report with its provenance." width="960" />
</p>

Use `hpt` as a shorter alias. See the [installation guide](https://tquang122.github.io/hypatia/docs/getting-started/installation/) for standalone installers, pinned versions, and skills-only setup. The [setup guide](https://tquang122.github.io/hypatia/docs/getting-started/setup/) covers providers and local models.

## Research workflows

| Goal | Commands |
| --- | --- |
| Find and synthesize literature | `/lit`, `/deepresearch` |
| Compare sources or review a paper | `/compare`, `/review`, `/audit` |
| Plan replication or training | `/replicate`, `/recipe` |
| Draft or explore research ideas | `/draft`, `/idea` |
| Run a bounded experiment | `/autoresearch`, `/experiments` |
| Grow a project research wiki | `/wiki init`, `/wiki ingest`, `/wiki apply`, `/wiki query`, `/wiki lint` |
| Reuse project wiki context | `/lit`, `/deepresearch`, `/compare`, `/replicate`, `/idea` |

`/wiki init` creates empty source/concept folders; ingested knowledge remains a proposal until reviewed and applied.
When research workflows delegate, the lead can pass selected wiki pages, claim status, and original source URLs to the evidence-scout; the scout verifies the originals and records which wiki pages it consulted.

Reports and provenance are saved in `outputs/`; paper-style drafts go in `papers/`. Use `/outputs` to search and preview them alongside drafts and other research artifacts.

The built-in `research-diagrams` skill guides source-grounded Mermaid diagrams for chat and saved research artifacts.

## Chat TUI

<p align="center">
  <img src="assets/hypatia-readme-ban.png" alt="Hypatia fullscreen research chat" width="850" />
</p>

The fullscreen chat includes searchable `/help`, citation browsing with `/sources`, and research-agent progress above the composer. The pinned prompt uses a subtle theme-matched background and a muted divider on taller terminals. When scrolled up, Pi's single built-in `↓ Jump to latest message · Esc` control returns to the newest output. In fullscreen mode, `Esc` is assigned to this scroll action and takes precedence over Pi's normal interrupt shortcut. Clicking the control preserves any draft. Pi 1.2 validates themes at startup and fixes inline images in Herdr, mouse-wheel handling around focused fullscreen overlays, and custom-editor compaction colors. The `/sources` citation list and `/idea` model selector also respond to the mouse wheel. `/outputs` opens a searchable artifact browser with text previews and report/provenance pairing; `/compact` and summarized `/tree` navigation preserve research context.

Chat equations use Pi's built-in LaTeX-to-Unicode rendering for supported notation. Write display equations as standalone `$$...$$` or `\[...\]` blocks; they keep normal upright text styling. Saved transcript text and exports stay unchanged.

Configure per-role model, fallback, and thinking choices with `/model-routes` or `hypatia model routes`. See the [model routing guide](https://tquang122.github.io/hypatia/docs/getting-started/configuration/#subagent-model-overrides).

## Sources and evaluation

Hypatia searches scholarly databases, public code, the web, and Hugging Face, and reads local PDFs and documents. AlphaXiv public search supports semantic, keyword, and fast title modes, date filters, ranking choices, and result limits. Public paper reading and linked GitHub implementation lookup also work without sign-in; agentic search, PDF Q&A, and repository file reading remain optional account features. Hypatia can also recover legal open-access copies for paywalled papers. See the [tool documentation](https://tquang122.github.io/hypatia/docs/reference/package-stack/).

```bash
hypatia alpha search --mode title "Attention Is All You Need"
hypatia alpha search --published-after 2025-01-01 --prioritize recency --limit 20 "long-context retrieval"
hypatia alpha implementations 1706.03762
```

Optional local Kev advice is off by default. When enabled, `hypatia_kev_advisory` returns scores and a separate suggested order without changing source results. Each suggestion includes its source rank, suggested rank, and signed `kevRankDelta` (positive means moved up); scores are ranking signals, not calibrated confidence. It accepts loopback services only; see the [Kev setup and limits](https://tquang122.github.io/hypatia/docs/getting-started/configuration/#optional-local-kev-advisory).

Benchmark details and score adapters are documented in [evals/README.md](evals/README.md). Telemetry is off unless you opt in with `HYPATIA_TELEMETRY=1` and your own PostHog key; prompts, model output, paper text, and tool arguments are excluded.

## Contributing

```bash
git clone https://github.com/TQuang122/hypatia.git
cd hypatia
npm install
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) · [Documentation](https://tquang122.github.io/hypatia/) · [Release notes](RELEASES.md) · [MIT License](LICENSE)
