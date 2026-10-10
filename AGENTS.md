# Agents

TypeScript ESM CLI (`@TQuang122/hypatia`): research-first agent shell that wraps stock Pi. Entry: `src/index.ts` → `src/cli.ts` → `src/pi/launch.ts` + `src/pi/runtime.ts`. Pi wiring (extensions, prompts, skills, themes, subagents) is declared in the `"pi"` key in `package.json`.

## Setup

- Use Node `24.x` (`nvm use || nvm install`; `.nvmrc` pins it). Supported range is `22.22–25.x`.
- `npm install` from repo root. Never edit `node_modules` — Hypatia does not patch Pi; fix our code or report upstream.
- `src/cli.ts` auto-loads a cwd `.env` via `loadEnvFile`. Copy `.env.example` for keys. `HYPATIA_TELEMETRY=off` disables telemetry.
- No linter/prettier at repo root; `tsc` strict (`NodeNext`) is the static gate. (`website/` has its own eslint + prettier.)

## Verify (in this order)

```bash
npm test                    # node --test + tsx, concurrency 1, isolated TMPDIR via tests/isolate-tmpdir.ts
npm run typecheck
npm run build               # tsc -p tsconfig.build.json → dist/
npm run architecture:check  # file-size + import-boundary gate
node scripts/check-pi-rpc.mjs  # boots built CLI in Pi RPC mode, throwaway home, empty stderr
```

- Focused test: `node --import tsx --import ./tests/isolate-tmpdir.ts --test --test-concurrency=1 tests/<name>.test.ts`. Always keep the `isolate-tmpdir.ts` import — it isolates temp dirs and forces telemetry off.
- `git diff --check` must be clean (CI enforces).
- Website changes: `cd website && npm install && npm run build` (CI also runs its `lint` + `typecheck`).

## Where things go

- CLI/runtime: `src/`; Pi launch/runtime/settings: `src/pi/`.
- New workflow → `prompts/*.md` with frontmatter (`description`, `args`, `section`, `topLevelCli`). CLI help and docs derive from `metadata/commands.mjs` + `readPromptSpecs`, so update them together.
- Reusable capability → `skills/<name>/SKILL.md`, keep concise.
- Subagent behavior lives ONLY in `.hypatia/agents/*.md` (evidence-scout, scribe, auditor, critic, reviser). Never duplicate it here.
- `extensions/research-tools.ts` is the Pi extension entry.
- Research artifacts (`outputs/`, `papers/`, `notes/`, `experiments/`) are gitignored scratch space.

## Architecture gate

- `scripts/check-architecture.mjs`: files should stay under ~800 lines (fail at 1200); `src/cli.ts` is the one allowed oversize file — split new handlers out instead of growing it.
- Domain modules (`src/artifacts/`, `src/evidence/`, `src/papers/` when they exist) must not import `src/cli`, `src/commands/`, `src/setup/`, or `src/ui/`.

## Pi runtime changes

- Before touching telemetry, tools, extensions, package setup, model/prompt handoff, or child-process env, read the installed Pi version under `node_modules/@earendil-works/pi-coding-agent/docs/` and the matching source in `src/pi/`.
- Prefer an existing Pi extension/package over a local shim; record why it fails before writing our own.
- Verify via the real launch path (`src/pi/launch.ts`, `src/pi/runtime.ts`, `ensureHypatiaSettings` packages) plus `node scripts/check-pi-rpc.mjs`.
- Telemetry/observability must never include prompts, tool args, paper text, or file paths.

## Docs parity

User-visible changes require: `README.md`, `RELEASES.md`, `metadata/commands.mjs`, and `website/` docs/pages where they describe the changed command, setup, tool, or runtime. `CHANGELOG.md` and plan files are internal only.

## Feature scope

Every feature must serve a core research job (find/read/rank/verify/reproduce/synthesize research, or speed/provenance/reliability of that loop). Reject adjacent lanes (funding, sales, admin, generic writing, PM) unless explicitly scoped to an active run. Absorb into the smallest existing surface; state the job it serves before adding commands, prompts, tools, or docs pages.

## Research outputs (lead + subagents)

- `outputs/` = findings, `papers/` = paper-style drafts, `notes/` = session logs. Plans → `outputs/.plans/`.
- One run, one slug (lowercase, hyphens, ≤5 words, e.g. `cloud-sandbox-pricing`); prefix every file: plan `<slug>.md`, intermediates `<slug>-research-*.md`, draft `<slug>-draft.md`, brief `<slug>-brief.md`, verification `<slug>-verification.md`, final `outputs/<slug>.md` or `papers/<slug>.md`, provenance `<slug>.provenance.md`. Never generic names (`research.md`, `draft.md`).
- `/deepresearch` and `/lit` must ship a `.provenance.md` sidecar (sources + what was verified). Verification belongs in the `auditor` stage before delivery. Mark honest status: `verified` / `unverified` / `blocked` / `inferred`.
- Subagents write intermediates to disk; the lead reads them (no large inline dumps), reconciles completion, and records skipped/merged tasks in the plan. Adversarial verification pass for critical claims.
- `CHANGELOG.md` is the untracked local lab notebook (see `.gitignore`): read before resuming, append after real progress/failures/blockers with next step. Skip for trivial one-shots. Release notes live in `RELEASES.md`.
