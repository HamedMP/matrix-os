# Tasks: SOUL Identity + Skills System

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T100-T105 (from original plan)

## User Story

- **US7** (P0): "The OS knows who it is and has a personality"

## Tests (TDD -- write FIRST)

- [ ] T100a [P] [US7] Write `tests/kernel/soul.test.ts` -- test `loadSoul()`: returns soul content from file, returns empty string if file missing, stays under 500 tokens, content is included in `buildSystemPrompt()` output

- [ ] T100b [P] [US7] Write `tests/kernel/skills.test.ts` -- test `loadSkills()`: parses frontmatter from `~/agents/skills/*.md`, returns array of `{name, description, triggers, body}`, handles empty dir, handles malformed frontmatter gracefully

## Implementation

- [ ] T100 [US7] Create `home/system/soul.md` -- default SOUL identity. Personality: helpful, direct, curious. Values: user privacy, accuracy, transparency. Communication: clear and concise, adapts to channel.

- [ ] T101 [US7] Implement `loadSoul()` in `packages/kernel/src/soul.ts` -- reads `~/system/soul.md`, returns content string. Called by `buildSystemPrompt()`. If file missing, returns empty string.

- [ ] T102 [US7] Modify `buildSystemPrompt()` in `packages/kernel/src/prompt.ts` -- insert SOUL content after core identity section, before state/knowledge. SOUL is L0 cache (never evicted).

- [ ] T103 [P] [US7] Implement `loadSkills()` in `packages/kernel/src/skills.ts` -- scans `~/agents/skills/*.md`, parses frontmatter (`name`, `description`, `triggers`), returns skill definitions. Builds skills TOC for system prompt.

- [ ] T104 [P] [US7] Create initial skills: `home/agents/skills/summarize.md`, `weather.md`, `reminder.md`, `skill-creator.md`

- [ ] T105 [US7] Wire skills into kernel -- add skills TOC to system prompt, add `load_skill` IPC tool so kernel can dynamically load full skill body when needed

## Agent Prompts (moved from 003)

These agents have dispatch logic wired up but lack dedicated prompt files in `home/agents/custom/`.

- [ ] T100d [US1] Write builder agent prompt `home/agents/custom/builder.md` -- instructions for generating HTML apps in `~/apps/`, structured modules in `~/modules/`, theme integration, IPC tool usage, module.json creation
- [ ] T100e [P] [US1] Write researcher agent prompt `home/agents/custom/researcher.md` -- instructions for gathering information, WebSearch/WebFetch, returning findings via `send_message` IPC tool
- [ ] T100f [P] [US1] Write deployer agent prompt `home/agents/custom/deployer.md` -- instructions for deploying to hosting platforms, reading deployment knowledge
- [ ] T100g [US3] Write healer agent prompt `home/agents/custom/healer.md` -- diagnosis workflow, patch patterns, rollback on test failure. Dispatch logic exists in gateway.
- [ ] T100h [US4] Write evolver agent prompt `home/agents/custom/evolver.md` -- safety constraints, git snapshot before changes, protected files awareness. Dispatch logic exists in gateway.

## Checkpoint

Kernel boots, reads `soul.md`, responds with personality. Ask "What skills do you have?" -- kernel lists available skills. Ask "Summarize this article" -- kernel loads summarize skill and executes it. Say "Be more casual" -- kernel edits `soul.md`, personality changes.
