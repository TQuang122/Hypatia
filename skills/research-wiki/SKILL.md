---
name: research-wiki
description: Use when the current workspace contains `wiki/` and a research task could benefit from prior project synthesis, or the user asks to maintain that wiki. Verify critical claims against the linked original sources.
---

# Project Research Wiki

- If `wiki/` exists, read `wiki/README.md` and `wiki/index.md` first, then open only pages relevant to the current question. Do not scan the whole wiki by default.
- Treat wiki pages as a navigation aid and prior synthesis, never as primary evidence. Follow their source IDs/URLs and check original sources for critical, disputed, or potentially stale claims before using them.
- For `/lit`, `/deepresearch`, `/compare`, and `/replicate`, consult relevant indexed pages before planning and record the relative page paths in the plan and final artifact or provenance. Keep these workflows read-only with respect to the wiki.
- When delegating to `evidence-scout`, the lead selects only pages relevant to that task and writes a brief with each page path, relevant claim/status, source ID and original URL, and the question to verify. The scout uses these as navigation leads, verifies original sources, and records the wiki paths consulted in its output; the scout never edits the wiki.
- For `/idea`, pass up to 12 relevant indexed `wiki/concepts/*.md` and `wiki/sources/*.md` paths as `knowledgePaths` to both preflight and the create contract. Exclude `wiki/.proposals/`; the bounded bundle and page hashes are frozen for the user's approval review.
- Preserve competing claims, scope limits, and labels such as `provisional`, `contested`, or `superseded`; do not turn a prior summary into a verified fact.
- Do not edit canonical wiki pages directly. Use `/wiki ingest` to prepare a proposal and `/wiki apply` for the user's explicit review and approval.
- Do not create a wiki automatically when none exists. Offer `/wiki init` only when project-level knowledge persistence would help or the user asks for it.
