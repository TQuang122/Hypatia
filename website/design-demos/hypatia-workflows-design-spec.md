# Design Spec · Hypatia Workflows Section

## Purpose and audience

This review artifact explores a new presentation for the Workflows section on Hypatia's homepage. The target visitor is a researcher, developer, or student who has reached the product page and wants to map a concrete task to one slash command. The current section presents nine commands in a three-column card grid, each with a short explanation. The implementation audit identified `/summarize` as a top-level research workflow, so the featured set will contain ten commands. The design goal is to make command names easier to scan, reduce repeated card framing, and preserve enough description for the visitor to make a useful choice without reading the documentation first.

The section remains part of the same landing page as the Hypatia hero and Agent Index. It should feel like a continuation of the warm dark brand system: near-black brown surfaces, warm gray body text, coral red for command emphasis, and Playfair Display for editorial display type. The current site uses English copy, so the preview uses English. Existing command names and descriptions are the source of truth; the preview may move them into different structures but must not invent extra capabilities, metrics, testimonials, or guarantees.

## Content rules

Keep all ten featured slash commands visible or discoverable in each direction. Preserve their current descriptions from `src/pages/index.astro`, including a concise `/summarize` description grounded in its prompt file. The commands are independent entry points; avoid arrows, step numbers, or copy that suggests a required sequence. The existing line about running commands in the REPL or shell remains available in all three concepts. Use concise navigation labels only to help scanning, and make clear when a label is an editorial grouping rather than a product taxonomy.

The exact set is `/deepresearch`, `/lit`, `/summarize`, `/review`, `/audit`, `/replicate`, `/recipe`, `/compare`, `/draft`, and `/autoresearch`. The preview should expose descriptions in the first view where possible. If an interactive control is included, it must work with pointer, keyboard focus, and touch. The navigation should not hide essential content on a small screen.

## Three directions inside one review file

1. **Intent clusters:** a three-part editorial layout that groups the commands by the visitor's apparent intent: explore sources, assess work, and produce or test an output. Add `/summarize` to Explore because it works directly on source material. These labels are a browsing aid, not a fixed workflow. Use a light typographic index and open separators rather than identical rounded cards.
2. **Command ledger:** a text-first directory of all ten commands, with a live filter field and a compact action label. The slash command is the strongest visual anchor; descriptions remain readable at 14px or larger. Filtering is an optional enhancement in the preview and should have a clear empty state.
3. **Workflow selector:** a command list beside a detail panel. Hovering, keyboard focus, or tapping a command changes the panel content. Keep the visual arrangement distinct from the Agent Index: the command name and task description should carry more weight than its role letter or label.

All directions share the same data and brand palette so the comparison focuses on layout and information hierarchy. Use a top-level selector in one standalone HTML file because the user asked for a single file to review. The preview controls are for design comparison and are not part of the final website section.

## Visual system and implementation constraints

Use the current design tokens from `src/styles/global.css`: background `oklch(0.15 0.010 20)`, foreground `oklch(0.92 0.010 60)`, card `oklch(0.21 0.015 20)`, primary `oklch(0.62 0.190 28)`, muted `oklch(0.26 0.018 20)`, muted text `oklch(0.65 0.012 50)`, and border `oklch(0.29 0.020 25)`. Use the local Hypatia favicon as an embedded image for the preview masthead. Keep body text legible, maintain visible focus states, and respect reduced motion. At desktop review size around 1440×1000, the section should read as one cohesive block; at mobile width around 375px, it should stack without horizontal scrolling.

No image is needed inside the workflows themselves: the content is a command directory, and portraits or decorative illustrations would not add information. The content-specific visual motif is the leading slash as a small command marker and the distinction between command syntax and task language. Avoid generic neon effects, excessive panels, decorative icons, and visual elements that imply telemetry or execution status. The final artifact for this phase is the single HTML review file. Production source remains untouched until the user selects a direction.
