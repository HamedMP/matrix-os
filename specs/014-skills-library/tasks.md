# Tasks: Skills Library Expansion

**Task range**: T600-T614
**Parallel**: YES -- fully independent of all other specs. No code changes required for most tasks (just .md files in `home/agents/skills/`).
**Deps**: None. Existing skills infrastructure (T103-T105) handles loading.

## User Story

- **US-SK1**: "The OS has rich built-in capabilities out of the box, comparable to a mature personal AI assistant"

## Research (do FIRST)

- [ ] T600 [P] [US-SK1] Research skill formats: Anthropic Claude skills (`docs/agent-sdk/`), skills.sh website, user-provided repos. Document canonical patterns and best practices. Output: `specs/014-skills-library/research.md`.

## Skill Template Refinement

- [ ] T601 [US-SK1] Review and refine skill frontmatter schema. Current: `name`, `description`, `triggers`. Consider adding: `category` (productivity, coding, media, utility, knowledge), `tools_needed` (list of IPC tools the skill may invoke), `channel_hints` (web, telegram, any). Update `packages/kernel/src/skills.ts` `SkillMeta` type if schema changes. Write test for new fields in `tests/kernel/skills.test.ts`.

## Skills (file-only, no code changes)

Each skill is a `.md` file in `home/agents/skills/` with frontmatter + body.

Productivity:
- [ ] T602 [US-SK1] `home/agents/skills/web-search.md` -- search the web, summarize results, cite sources. Uses WebSearch/WebFetch tools.
- [ ] T603 [US-SK1] `home/agents/skills/calculator.md` -- math calculations, unit conversions, currency. Use Bash for complex math.
- [ ] T604 [US-SK1] `home/agents/skills/translator.md` -- translate text between languages. Handle idioms, formality levels.
- [ ] T605 [US-SK1] `home/agents/skills/note-taker.md` -- create, search, organize notes in `~/data/notes/`. Markdown files with date headers.

Coding:
- [ ] T606 [US-SK1] `home/agents/skills/code-review.md` -- review code files for bugs, style, security. Read file, analyze, return structured feedback.
- [ ] T607 [US-SK1] `home/agents/skills/git-helper.md` -- git operations guidance. Uses `sync_files` IPC tool. Commit, branch, status, diff explanations.
- [ ] T608 [US-SK1] `home/agents/skills/debug.md` -- systematic debugging. Read error, trace cause, suggest fix. Step-by-step diagnostic.

Knowledge:
- [ ] T609 [US-SK1] `home/agents/skills/research.md` -- deep research on a topic. Multi-source, synthesize findings, produce structured report in `~/data/research/`.
- [ ] T610 [US-SK1] `home/agents/skills/explain.md` -- explain concepts at user's level. Bruner's modes: enactive (do), iconic (visualize), symbolic (formal). Adapt to user.md role.

Media:
- [ ] T611 [US-SK1] `home/agents/skills/image-gen.md` -- generate images via fal.ai. Requires T661 (generate_image IPC tool). Prompt engineering for good results. Save to `~/data/images/`.
- [ ] T612 [US-SK1] `home/agents/skills/screenshot.md` -- take screenshots of URLs or apps. Requires T691 (browse_web IPC tool). Save to `~/data/screenshots/`.

System:
- [ ] T613 [US-SK1] `home/agents/skills/system-admin.md` -- manage Matrix OS itself. Check health, view logs, manage cron, restart services. Uses `read_state`, `manage_cron` IPC tools.
- [ ] T614 [US-SK1] `home/agents/skills/app-builder.md` -- enhanced app building skill. matrix.md conventions, theme integration, icon selection, data directory setup. Complements the builder agent prompt.

## Implications

- T611 depends on T661 (image gen IPC tool from 017-media). Skill file can exist before the tool -- kernel will report tool unavailable gracefully.
- T612 depends on T691 (browser tool from 019-browser). Same graceful degradation.
- If T601 changes SkillMeta schema, update `tests/kernel/skills.test.ts` first (TDD).
- Token budget: 15+ skills means longer TOC in system prompt. T100j budgeting already handles truncation, but verify skills TOC stays reasonable (~200 tokens for 15 skills).

## Checkpoint

- [ ] `bun run test` passes after T601 schema changes.
- [ ] Kernel lists 15+ skills when asked "What can you do?"
- [ ] Skills with external deps (T611, T612) degrade gracefully when tool not available.
