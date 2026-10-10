# Hypatia · Brand Spec for homepage section previews

> Collected: 2026-10-07  
> Scope: standalone review files only; no production-page integration.  
> Status: partial, based on the current local website source and user-provided screenshots.

## Core assets

### Logo

- Mark: `website/public/favicon.png` (128×128 PNG). Use as an embedded `<img>` data URI in the standalone HTML so the preview remains portable.
- Wordmark: use the current Hypatia wordmark treatment visible in the supplied website screenshot. Keep it small and secondary to the section heading.
- Do not redraw or distort the existing mark.

### Product interface and visual reference

- Current site hero UI: `website/public/hypatia-hero.png`.
- The earlier subagent preview uses the user-provided five-agent illustration as a visual reference.
- The workflows preview is text-first. Workflow descriptions and command names carry the information, so it adds no illustrations.

## Palette from `website/src/styles/global.css`

- Background: `oklch(0.15 0.010 20)`
- Foreground: `oklch(0.92 0.010 60)`
- Card: `oklch(0.21 0.015 20)`
- Primary coral: `oklch(0.62 0.190 28)`
- Muted surface: `oklch(0.26 0.018 20)`
- Muted text: `oklch(0.65 0.012 50)`
- Border: `oklch(0.29 0.020 25)`

The site screenshot confirms the dark warm background, subdued gray copy, and restrained coral-red accent. Do not introduce cool blue or purple accents.

## Typography

- Display: `Playfair Display`, Georgia, serif (already loaded by the website).
- Wordmark: `Cinzel`, serif (already loaded by the website).
- Small utility labels: `VT323`, monospace (already loaded by the website).
- Body: site sans-serif stack; code labels: `SF Mono`, `Fira Code`, `JetBrains Mono`.

## Visual character and constraints

- Warm, dark, scholarly, precise, and slightly cinematic.
- Keep body copy at least 14px, with comfortable contrast and 1.5+ line-height.
- Avoid generic neon glows, violet gradients, invented metrics, fake testimonials, and claims that the agents always run together.
- Keep the section visually compatible with the existing homepage and make all three concepts responsive.
