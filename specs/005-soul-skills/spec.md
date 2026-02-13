# 005: SOUL Identity + Skills System

## Problem

Matrix OS currently has no personality. Every response is generic. Users can't customize how the OS communicates, and the OS can't learn new behaviors without code changes.

## Solution

Two complementary systems:

1. **SOUL** -- a file at `~/system/soul.md` that defines the OS identity (personality, values, communication style). Injected into every prompt at L0 cache level (never evicted).

2. **Skills** -- markdown files at `~/agents/skills/*.md` that teach the kernel new behaviors. Skills are prompt injections, not tools. They expand what the OS knows how to do without code changes.

## SOUL Identity

### What SOUL Is

A markdown file that defines WHO the OS is. Not capabilities (those are skills) or state (that's `state.md`), but identity.

### Location

`~/system/soul.md` -- follows Everything Is a File principle. User can edit directly or ask the OS to change it ("be more formal", "your name is Jarvis").

### Default SOUL

```markdown
# Matrix OS

## Identity
I am Matrix OS -- a personal operating system and AI assistant. I run on your machine (or your server), I generate software from conversation, and I'm always here when you need me.

## Personality
- Direct and clear. I don't waste words.
- Curious about your needs. I ask when something is ambiguous.
- Proactive. I suggest improvements and notice patterns.
- Honest about limitations. I say when I can't do something.

## Values
- Your data is yours. Everything is a file you own.
- Privacy first. I don't phone home.
- Transparency. I explain what I'm doing and why.
- Reliability. I'd rather do less than promise more than I can deliver.

## Communication Style
- Concise responses for simple questions
- Detailed explanations when building something complex
- I adapt to the channel: shorter for messaging, richer for web
- I use the user's language and tone
```

### How SOUL Loads

`buildSystemPrompt()` reads `~/system/soul.md` and injects it after the core identity section, before state/knowledge. SOUL is L0 -- always present, never compressed. Cost: ~300-500 tokens per request.

## Skills System

### What Skills Are

Markdown files that teach the kernel new behaviors. NOT tools (tools are code). Skills are prompt injections that expand capability.

### Format

```markdown
---
name: weather
description: Look up current weather for any location
triggers:
  - weather
  - forecast
  - temperature
---

# Weather Lookup

When the user asks about weather:
1. Use WebSearch to find current weather
2. Extract: temperature, conditions, humidity, wind
3. Format based on channel (concise for messaging, detailed for web)
```

### Loading

1. On boot, kernel scans `~/agents/skills/*.md`
2. Parses frontmatter: `name`, `description`, `triggers`
3. Builds skills TOC (~5 tokens per skill) injected into system prompt
4. On matching request, loads full skill body via `load_skill` IPC tool
5. Skill body injected into current turn context

### Built-in Skills

| Skill | Triggers | What it does |
|-------|----------|-------------|
| `summarize.md` | summarize, tldr, summary | Summarize text/articles/conversations |
| `weather.md` | weather, forecast, temperature | Weather lookup via web search |
| `reminder.md` | remind, reminder, alarm, schedule | Create cron reminders |
| `skill-creator.md` | learn, new skill, teach | Meta-skill: create new skill files |

### Self-Expanding

The `skill-creator.md` meta-skill teaches the kernel how to create new skills. "Learn how to check my GitHub stars" -> kernel writes `~/agents/skills/github-stars.md` -> available on next interaction.

## Dependencies

- Phase 3 (Kernel) -- complete
- `buildSystemPrompt()` exists in `packages/kernel/src/prompt.ts`
- Agent frontmatter parser exists in `packages/kernel/src/agents.ts`
- IPC MCP server exists in `packages/kernel/src/ipc.ts`

## Inspired By

- Nanobot's `SOUL.md` (workspace/SOUL.md)
- Nanobot's `skills/` (YAML frontmatter + markdown body)
- OpenClaw's agent identity system
