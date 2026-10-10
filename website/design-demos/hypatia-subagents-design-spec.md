# Design Spec · Hypatia Subagent Introduction

## Purpose and audience

Create a review-only homepage section that introduces Hypatia's five bundled subagents to visitors who are meeting the product for the first time. The section should explain the job each role performs without requiring the visitor to already understand agent orchestration. The audience is research-oriented developers, scientists, and students evaluating whether Hypatia can support evidence gathering, drafting, critique, and verification. The core message is that Hypatia can call a focused specialist when a workflow benefits from delegation, while narrow requests remain lead-owned. The layout must not imply that all five agents always run on every task or that they form one mandatory linear pipeline.

## Content system

Use English copy, matching the existing website. Use the official names and factual descriptions from the five local agent docs. Keep the first line short enough to scan, then reveal the more detailed explanation on hover, keyboard focus, or touch. The role set is Auditor, Evidence Scout, Scribe, Critic, and Reviser. The small uppercase label may describe the role in plain language, but the role name remains the recognizable title. Reuse the same content and agent ordering across all design directions so that visual differences can be compared fairly. Do not add statistics, fabricated outcomes, user quotes, unsupported quality claims, or claims of autonomous execution that are absent from the documentation.

## Brand and source material

Use the current warm dark theme from `src/styles/global.css`: a near-black brown background, warm off-white text, muted brown-gray surfaces and borders, and a restrained coral-red primary accent. Use the existing local Hypatia mark as an embedded image. The website already loads Playfair Display, Cinzel, and VT323; use Playfair Display for editorial headlines, Cinzel sparingly for the brand signature, and a monospace face for small role labels. Use the supplied five-agent screenshot as the visual source for the illustrated direction only. The other two directions must demonstrate how the same content can work without character portraits.

## Three visual directions

1. **Portrait dossiers:** five illustrated, vertically oriented role cards, closest to the supplied reference. Keep the artwork dominant, titles clear, and copy concise. On wide screens show all five; progressively reflow on tablet and mobile. Details expand on hover/focus, with a tap target for touch screens.
2. **Evidence ledger:** an editorial, asymmetrical layout with a strong section introduction and five ruled entries. Numbers and role names create hierarchy; descriptions and extra detail remain typographic. Use no character art, so the content and reading rhythm carry the page.
3. **Agent index:** a compact role index paired with one detail panel. Hovering or focusing an index item updates the description panel; clicking also works on touch. Use typography, spacing, and the site’s existing mark rather than portrait art or invented icons. The arrangement is an index, not a process flow.

The three directions must differ in layout skeleton, not only color or type. Put all three in one self-contained HTML file, because the user asked for a single file to review before adding anything to the site. A top-level preview selector changes the displayed direction; it is not part of the production section. Include a brief explanation that this is a standalone preview and has not been integrated.

## Form, behavior, and technical constraints

The content-specific visual motif is a checkable trail from source to claim: the coral accent can mark focus and provenance, while thin rules and deliberate spacing keep roles distinct. Do not connect the five roles with arrows or numbered workflow steps. The likely homepage placement is after the hero and before Workflows; treat this as an assumption inside the preview, not a page edit. The target review size is a desktop browser around 1440×900, with responsive behavior down to 375px. Keep text readable, provide visible focus states, and reveal detail through hover, focus, and click/tap. Respect reduced-motion preferences and avoid horizontal overflow. No framework, remote scripts, production routes, or modifications to the homepage are included. The final deliverable for this phase is one standalone `.html` preview with three selectable directions and screenshots for visual review; production integration waits until the user selects a direction.
