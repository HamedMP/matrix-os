# Spec 036: Builder Speed + Skills Quality

**Goal**: Make app generation fast, reliable, and impressive for the viral demo moment. A user types "build me X" and gets a working app in under 15 seconds.

## Problem

1. Builder agent reads `app-generation.md` (17KB) on every build -- redundant file I/O
2. No domain-specific skill guidance (e.g., "building a todo? use this data pattern")
3. Templates re-read from knowledge files every time instead of being cached/injected
4. Build process (pnpm install + build) takes 15-30s, with failed builds adding another cycle
5. `app-builder.md` skill is generic -- doesn't cover common app patterns
6. Skill frontmatter lacks validation schema
7. No composable skill bundles (can't load "app-builder + data-schema + theme" together)

## Solution

### A: Knowledge Caching + Prompt Injection

Inject scaffold templates directly into the builder agent's system prompt so it doesn't need to read knowledge files. Cache `app-generation.md` content at kernel boot time in memory.

### B: Domain-Specific App Skills

Create skill files for common app types with specific patterns:
- `build-react-app.md` -- React module scaffold (the templates, already known)
- `build-html-app.md` -- HTML app scaffold
- `build-dashboard.md` -- data visualization patterns
- `build-crud-app.md` -- CRUD patterns with bridge API
- `build-game.md` -- simple game patterns (canvas, p5.js)

Each skill includes: data schema patterns, component architecture, common pitfalls, theme integration specifics for that app type.

### C: Build Pipeline Optimization

- Pre-install common dependencies in a shared `node_modules` cache
- Use `pnpm install --prefer-offline` to skip registry checks
- Consider pre-built template projects that get copied + modified (fastest path)
- Detect simple apps that can be HTML-only (skip entire build step)

### D: Skill System Improvements

- Zod schema validation for skill frontmatter in `loadSkills()`
- `examples` field in frontmatter for better trigger matching
- `composable_with` field to define skill bundles
- Batch-preload hot skills at kernel boot (cache in memory)

## Non-Goals

- Changing the Agent SDK query mechanism
- Adding new agent types
- Modifying the IPC protocol

## Success Metrics

- App generation (HTML): < 5 seconds end-to-end
- App generation (React): < 15 seconds end-to-end
- Zero redundant file reads during build
- Skill validation catches malformed frontmatter at boot
