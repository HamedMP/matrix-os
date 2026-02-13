# Plan: SOUL Identity + Skills System

**Spec**: `specs/005-soul-skills/spec.md`
**Depends on**: Phase 3 (complete)
**Estimated effort**: Medium (6 tasks + TDD)

## Approach

TDD throughout. Two parallel tracks: SOUL (kernel identity) and Skills (expandable capabilities).

### Track 1: SOUL Identity

1. Write tests for `loadSoul()` -- returns content, handles missing file, stays under 500 tokens
2. Create default `home/system/soul.md`
3. Implement `loadSoul()` in `packages/kernel/src/soul.ts`
4. Modify `buildSystemPrompt()` to inject SOUL at L0

### Track 2: Skills System

1. Write tests for `loadSkills()` -- parses frontmatter, returns skill array, handles empty dir
2. Create initial skills in `home/agents/skills/`
3. Implement `loadSkills()` in `packages/kernel/src/skills.ts`
4. Add `load_skill` to IPC tools
5. Wire skills TOC into system prompt

## Files to Create

- `packages/kernel/src/soul.ts` -- SOUL loader
- `packages/kernel/src/skills.ts` -- skills loader
- `home/system/soul.md` -- default SOUL identity
- `home/agents/skills/summarize.md` -- summarize skill
- `home/agents/skills/weather.md` -- weather skill
- `home/agents/skills/reminder.md` -- reminder skill
- `home/agents/skills/skill-creator.md` -- meta-skill
- `tests/kernel/soul.test.ts`
- `tests/kernel/skills.test.ts`

## Files to Modify

- `packages/kernel/src/prompt.ts` -- inject SOUL + skills TOC
- `packages/kernel/src/ipc.ts` -- add `load_skill` tool

## Testing

- Unit: `loadSoul()` returns content from file, empty string if missing
- Unit: `loadSkills()` parses frontmatter, returns structured array
- Unit: `buildSystemPrompt()` includes SOUL content and skills TOC
- Integration: kernel responds with personality, loads skill on matching request
