---
status: completed
---

# Matrix app builder craft and agent orientation

Improve generated app quality using researched design iteration, the owner's Postgres data, and the locally available design and animation skills. Keep native harness prompts intact and expose only capabilities actually present on each route.

## U1: Shipped design skills and builder workflow

Goal: ship the missing local skill dependencies and make builder instructions select them deliberately; design for the user's main task, persist via MatrixOS.db, verify the real app and refine it.
Files: skills/matrix/**; scripts/install-agent-matrix-skills.sh; scripts/install-hermes-matrix-skills.sh; scripts/sync-matrix-agent-skills.sh; tests/platform/matrix-agent-skills-sync.test.ts; tests/kernel/app-skills.test.ts; docs/dev/agent-matrix-skills.md.
Approach: vendor emil-design-eng, apple-design, animate and animate's locally available supporting skills with relative resources and provenance; preserve user-managed installations. Add trigger metadata. Avoid eagerly loading every skill body. Correct obsolete VPS/container and persistence advice.
Execution note: test-first for sync/installation behavior; instructional changes validated through scenarios and resource-link checks.
Verification: canonical pack discovery, all harness installation paths, user-owned collision preservation, no missing relative references; scenario review of a real tracker with persistence and reduced motion.

## U2: Shared orientation and consistent data guidance

Goal: give kernel Claude, Chat Claude Code and Chat Codex the same concise Matrix orientation with truthful route-specific capabilities; remove conflicting file-database instructions.
Files: packages/kernel/src/prompt.ts; packages/kernel/src/skills.ts; packages/kernel/src/agents.ts; packages/gateway/src/agent-launcher.ts; packages/gateway/src/coding-agents/*instructions.mjs; home/CLAUDE.md; home/agents/system-prompt.md; relevant tests.
Approach: dependency-free shared instruction resource consumed by kernel and both harness launch paths, bounded text, no new auth or endpoint behavior; discover workflows through skill descriptions and native tools, do not advertise unavailable kernel tools on Chat routes.
Execution note: failing tests before prompt/loader/launch behavior changes.
Verification: assembled kernel prompt and Claude launch args / Codex thread-start and resume payloads carry orientation; template prompt under 7K estimated tokens; related skill metadata parsing; structured app-data summary no longer infers Postgres state from JSON files.

## U3: Research, validation and documentation

Goal: preserve primary-source findings and document observable product behavior.
Files: specs/543-app-builder-craft/research.md; separate FinnaAI/matrix-os-site content/docs documentation PR.
Approach: cite Lovable design directions/design systems/browser testing and Replit Design Canvas/DESIGN.md; describe transferable workflows as inferences, not secret prompts. Keep Matrix's Vite/React, sandbox, Matrix theme and Postgres architecture.
Verification: focused tests, type checks, independent code/skill review, Matrix OS PR and separate site documentation PR. No customer deployment or merge in this task.

## Boundaries

No new preview canvas/editor product, database APIs, external credentials, or runtime permission expansion. Browser evidence for actual generated app quality requires a live authenticated Matrix session; report unavailable evidence accurately.
