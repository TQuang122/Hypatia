---
name: research-ideation
description: Brainstorm a small, evidence-aware set of research directions when the user explicitly asks to explore ideas, find a fresh angle, or get unstuck. For one bounded proposal use /idea instead.
license: MIT
source: Adapted from Orchestra Research's brainstorming-research-ideas
---

# Research Ideation

Use this skill for broad, chat-based exploration of research directions. It helps the user compare candidate questions before choosing one for a structured proposal.

## Use boundaries

- Use when the user explicitly asks to brainstorm, explore multiple directions, find a fresh angle, or get unstuck on a research problem.
- If the user already has a specific falsifiable question and wants one bounded proposal, use the `/idea` workflow instead.
- If the main need is source coverage, use `/lit` or deep research. Brainstorming alone cannot establish novelty or what a field has not studied.
- Do not start separate Idea Forge panel calls, execute code, or create files from this skill. The user can choose a candidate and continue with `/idea`.

## Process

1. Use the user's project context and stated constraints. Do not restart with a questionnaire. Ask one grouped clarification only if missing information would substantially change the directions; otherwise state a brief assumption and proceed.
2. Choose two or three useful lenses, not every lens:
   - **Problem or solution first:** start from a real unmet need, or test whether a new capability solves a meaningful problem.
   - **Tension or trade-off:** look for goals commonly treated as incompatible and ask whether the trade-off is fundamental.
   - **Boundary or failure case:** identify where a method, assumption, or benchmark breaks down.
   - **Cross-field analogy:** borrow a mechanism only when the structural mapping is clear and yields a testable prediction.
   - **Composition or decomposition:** combine complementary methods or isolate which component causes an observed effect.
   - **Changed conditions:** consider new data, tools, compute, or policy only when those changes are provided or verified; never invent a recent development.
3. Generate **3–5 distinct candidates**. Keep each concise and specific to the user's domain and resources.
4. Compare candidates by problem relevance, falsifiability, feasibility, and the largest unresolved assumption. Use qualitative judgments; do not invent numeric scores.
5. Recommend at most one candidate with a short reason and state what evidence or prerequisite could change that recommendation. The user makes the final choice.

## Candidate format

For each candidate provide:

- **Question or hypothesis:** one testable sentence.
- **Why it may be useful:** the problem or tension it addresses.
- **Smallest informative test:** a pilot-scale comparison or observation, not a full experiment contract.
- **Main uncertainty:** the assumption, data, source, or resource that remains unresolved.

End with a brief comparison and a suggested next step. Mark ideas as exploratory. Do not describe them as novel, high-impact, or literature gaps unless those claims have been checked against sources. Do not treat model judgment as validation or imply that choosing an idea authorizes a benchmark.

## Attribution

Adapted from Orchestra Research's `brainstorming-research-ideas` skill, distributed under the MIT License.
