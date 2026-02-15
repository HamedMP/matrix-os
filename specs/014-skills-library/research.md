# T600: Skill Format Research

## Anthropic Claude Agent SDK Skills

From `docs/agent-sdk/skills.md`:
- Skills are `SKILL.md` files with YAML frontmatter + Markdown body
- Stored in `.claude/skills/` directories (project or user level)
- Model-invoked: Claude autonomously chooses when to use them based on `description` field
- Metadata is discovered at startup; full content loaded when triggered (lazy loading)
- Tool restrictions via `allowed-tools` frontmatter (CLI only, not SDK)

Key pattern: description drives invocation. Triggers are a Matrix OS addition for explicit matching.

## Matrix OS Skill Format (Current)

Frontmatter fields:
- `name` (required): lowercase, hyphenated identifier
- `description` (required): one-line capability summary
- `triggers` (optional): array of keywords for matching

Body: Markdown instructions for the AI on how to execute the skill.

Loading: `loadSkills()` reads all `*.md` from `~/agents/skills/`, parses frontmatter, returns `SkillDefinition[]`. `loadSkillBody()` lazy-loads full content by name. `buildSkillsToc()` generates compact TOC for system prompt.

## Proposed Schema Additions (T601)

Three new optional fields:

1. **`category`**: Groups skills in the TOC. Values: `productivity`, `coding`, `knowledge`, `media`, `system`. Default: `utility`.

2. **`tools_needed`**: Lists IPC tools or capabilities the skill depends on. Enables graceful degradation -- if a tool is unavailable, the kernel can note this. Examples: `["manage_cron"]`, `["WebSearch"]`, `["generate_image"]`.

3. **`channel_hints`**: Where the skill works best. Values: `any`, `web`, `telegram`, `discord`, `slack`, `whatsapp`. Default: `any`. Allows the TOC builder to filter or annotate skills per channel.

## Design Decisions

- All three fields are optional for backward compatibility. Existing skills without them continue to work.
- `buildSkillsToc()` can optionally group by category but stays compact (one line per skill).
- `loadSkills()` parses the new fields but does not require them.
- Token budget: with 20 skills at ~15 tokens each, TOC is ~300 tokens. Well within the 7K system prompt budget.
