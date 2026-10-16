---
description: Maintain a project-local research wiki with source-linked updates and initialized source/concept folders.
args: [init|ingest <source>|apply <proposal>|query <question>|lint]
argument-hint: "[init|ingest <source>|apply <proposal>|query <question>|lint]"
section: Project & Session
topLevelCli: false
---
# Project Research Wiki

Use this workflow only for the current workspace's explicit `wiki/` directory. It is a durable, human-readable synthesis layer between original research sources and future questions. It is not global memory, a session log, or a replacement for `outputs/`, `papers/`, or source retrieval.

## Layout

- `wiki/index.md` — linked catalog of concept and source pages.
- `wiki/README.md` — page schema and guardrails for other research workflows.
- `wiki/sources/<slug>.md` — source identity, URL or DOI/PMID/arXiv ID, retrieval date, local artifact path when present, and a concise source-grounded summary.
- `wiki/concepts/<slug>.md` — evolving synthesis, with important claims linked to source pages and original references.
- `wiki/log.md` — append-only record of initialization, accepted updates, and lint findings. Do not log query text unless the user asks.
- `wiki/.proposals/<slug>.md` — pending ingest proposals; never treat these as accepted knowledge.

Raw research source files remain authoritative and immutable. Do not copy full papers into the wiki. Link to the original source and existing local artifact. A report's `.provenance.md` can help trace its citations, but the report itself is not primary evidence.

## Page conventions

Document this schema in `wiki/README.md` and keep it consistent:

- A source page records a stable source ID, canonical URL, title, observed retrieval date (or `not recorded`), local artifact path when available, access/read status, scope, and a concise evidence summary.
- A concept page has a short current synthesis, a claims table (`claim`, `status`, `source page`, `original citation/locator`), disagreements or scope boundaries, and open questions. Use only `supported`, `provisional`, `contested`, or `superseded` as claim statuses.
- Use relative Markdown links for pages within `wiki/`; include DOI/PMID/arXiv IDs and original URLs for external evidence. Never invent a locator, status, or date to fill a blank field.

## Operations

Interpret `$@` as one of `init`, `ingest <source>`, `apply <proposal>`, `query <question>`, or `lint`. If the operation or target is missing, ask one concise question before writing anything.

### `init`

Inspect the workspace first. If `wiki/` already exists, read and preserve it; never replace existing pages or templates. In both the existing and new wiki cases, run `mkdir -p wiki/sources wiki/concepts`, then verify both directories exist with `test -d wiki/sources && test -d wiki/concepts`. This only creates missing directories and preserves all existing content. For a new wiki, also create a concise `README.md` documenting the source/concept page schema and evidence labels, an `index.md` explaining the page categories, and an empty `log.md`. Do not copy session transcripts or automatically ingest existing files.

### `ingest <source>`

Accept a workspace artifact path, stable scholarly identifier, or URL. For a path, confirm it is inside the workspace and read any adjacent `.provenance.md`. Retrieve external sources through Hypatia's existing tools when needed. If the source cannot be read or verified, mark the gap rather than filling it from memory.

Read `wiki/index.md` and only the relevant source/concept pages. Draft a source note and focused updates to existing or new concept pages. Keep these distinctions explicit:

- A wiki synthesis is not evidence. Map each substantive claim to source IDs/URLs and, where available, the relevant local artifact and locator.
- Label claims `supported`, `provisional`, `contested`, or `superseded`; identify the basis and limits of that status.
- Preserve disagreements as competing claims with their supporting sources. Do not silently overwrite an older conclusion or describe consensus where sources conflict.
- Avoid unsupported quotations, invented metadata, and fabricated retrieval dates. Keep the raw source unchanged.

Write one proposal to `wiki/.proposals/<slug>.md` containing the source identity, files to create/update, complete proposed page contents, a concise change summary, evidence links, and unresolved questions. **Do not edit `wiki/index.md`, source pages, concept pages, or `wiki/log.md` during ingest.** Show the proposal path and summary; wait for the user to invoke `/wiki apply <proposal>`.

### `apply <proposal>`

Read the exact proposal from `wiki/.proposals/`. Re-read every target page and source link; if a target changed since the proposal was prepared, stop and regenerate the proposal. Show the paths and concise before/after summary, then ask the user to explicitly confirm this application. On refusal, make no canonical changes. After confirmation, apply only the listed changes, update the index and append a dated log entry. Re-read all changed pages and verify the links before reporting success. Keep the proposal as review history.

### `query <question>`

Read the index, search for relevant pages, and follow their source links. Missing `wiki/sources/` or `wiki/concepts/` directories count as empty categories; check that a directory exists before scanning it and do not let an empty category cause a shell error. Answer from the wiki as a navigation aid, but cite original source URLs/identifiers for factual claims. Mark stale, provisional, contested, or unverified material clearly. If the wiki lacks enough evidence, say so and offer the relevant Hypatia search workflow. Do not modify files for a query.

### `lint`

Read-only audit: find broken local links, unindexed/orphan pages, source notes missing stable identifiers or URLs, concept claims without source links, and unresolved contradictions or staleness markers. Return findings with paths and a proposed fix; do not edit files or auto-resolve conflicts.

## Boundaries

- Never access or modify `~/.hypatia`, another workspace, or session transcripts as part of this project wiki.
- Never make canonical wiki edits during `query` or `lint`.
- Do not promote a generated summary to `supported` without checking its cited source evidence.
- If a source is inaccessible, report the exact blocked/unverified item; do not fabricate a wiki page for it.
