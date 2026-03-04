# Tasks: Builder Speed + Skills Quality

**Spec**: spec.md
**Task range**: T1300-T1329
**Parallel**: Partially -- skills (T1310-T1319) are independent of each other. Code changes (T1300-T1309) are sequential.

## User Stories

- **US55**: "When I say 'build me X', the app appears fast -- not 30+ seconds of waiting"
- **US56**: "The builder knows best practices for common app types without me explaining"
- **US57**: "Skills have consistent quality and validated format"

---

## Phase A: Skill System Hardening (T1300-T1304)

### Tests (TDD)

- [ ] T1300a [US57] Write `tests/kernel/skills-validation.test.ts`:
  - loadSkills validates frontmatter with Zod schema
  - Missing `name` field throws descriptive error
  - Missing `description` field throws descriptive error
  - Optional fields (category, triggers, tools_needed, channel_hints) have correct types
  - Malformed YAML still handled gracefully (skip file, log warning)
  - New fields: `examples` (string[]), `composable_with` (string[]) parsed correctly

### T1300 [US57] Skill frontmatter Zod schema
- [ ] Add Zod schema for SkillMeta in `packages/kernel/src/skills.ts`
- [ ] Validate all skills at boot time, log warnings for invalid ones
- [ ] Add `examples` field: array of example user messages that trigger the skill
- [ ] Add `composable_with` field: array of skill names to auto-load together
- [ ] Backward compatible: existing skills without new fields still load

### T1301 [US55] Skill memory cache
- [ ] Add in-memory Map<string, string> cache for skill bodies in `packages/kernel/src/skills.ts`
- [ ] On `loadSkills()`, optionally pre-cache hot skills (app-builder, web-search, code-review)
- [ ] `loadSkillBody()` checks cache before disk read
- [ ] Cache invalidation: file watcher clears cache entry on skill file change

### T1302 [US55] Knowledge file caching
- [ ] Cache `app-generation.md` content at kernel boot in memory
- [ ] Expose cached knowledge via new `getKnowledge(name)` function
- [ ] Builder agent reads from cache instead of disk
- [ ] Cache invalidation on file change (via file watcher)

### T1303 [US56] Composable skill loading
- [ ] When `load_skill` is called, check `composable_with` field
- [ ] Auto-load companion skills in same response
- [ ] Example: loading `build-react-app` also loads `app-builder` + `theme-integration`
- [ ] Prevent circular loading (track loaded set)

### T1304 [US55] Builder prompt optimization
- [ ] Inject core scaffold templates (package.json, vite.config.ts, tsconfig.json) directly into builder agent definition
- [ ] Remove need for builder to read app-generation.md on every run
- [ ] Keep builder prompt under 4K tokens (templates are compact)
- [ ] Update agent definition in `packages/kernel/src/agents.ts`

---

## Phase B: Domain-Specific App Skills (T1310-T1319)

Each skill is a `.md` file in `home/agents/skills/`. All independent -- can be written in parallel.

### T1310 [US56] `home/agents/skills/build-react-app.md`
- [ ] Complete React module scaffold recipe
- [ ] Component architecture patterns (single page, multi-view with tabs, sidebar+content)
- [ ] State management patterns (useState for simple, useReducer for complex)
- [ ] Bridge API integration for persistent data
- [ ] Theme CSS variables injection
- [ ] Common pitfalls and how to avoid them
- [ ] composable_with: [app-builder]

### T1311 [US56] `home/agents/skills/build-html-app.md`
- [ ] Single-file HTML app recipe
- [ ] CDN import patterns (esm.sh for React, unpkg for utilities)
- [ ] Inline CSS theming with custom properties
- [ ] When to choose HTML over React (decision guide)
- [ ] composable_with: [app-builder]

### T1312 [US56] `home/agents/skills/build-dashboard.md`
- [ ] Data visualization patterns (charts, tables, KPIs)
- [ ] Chart library recommendations (Chart.js via CDN, or recharts for React)
- [ ] Responsive grid layouts
- [ ] Real-time data refresh patterns
- [ ] composable_with: [app-builder, build-react-app]

### T1313 [US56] `home/agents/skills/build-crud-app.md`
- [ ] CRUD patterns with bridge API (`/api/bridge/data`)
- [ ] Data schema design (JSON files in ~/data/<app>/)
- [ ] List/detail view pattern
- [ ] Form validation patterns
- [ ] Optimistic updates
- [ ] composable_with: [app-builder, build-react-app]

### T1314 [US56] `home/agents/skills/build-game.md`
- [ ] Simple game patterns (canvas 2D, requestAnimationFrame loop)
- [ ] Game state management
- [ ] Input handling (keyboard, touch, mouse)
- [ ] Score tracking with bridge API persistence
- [ ] p5.js via CDN for quick prototypes
- [ ] composable_with: [app-builder]

### T1315 [US56] Update `app-builder.md` skill
- [ ] Add `composable_with: [build-react-app, build-html-app]`
- [ ] Add `examples` field with 10+ example trigger messages
- [ ] Improve decision guide with clearer signals
- [ ] Add estimated build time hints

---

## Phase C: Build Pipeline Speed (T1320-T1324)

### T1320 [US55] pnpm offline-first builds
- [ ] Configure pnpm store path in home directory (`~/system/.pnpm-store`)
- [ ] Use `pnpm install --prefer-offline` in builder
- [ ] Pre-populate store with common deps (react, react-dom, vite, @vitejs/plugin-react, typescript)
- [ ] Measure: first build vs subsequent build times

### T1321 [US55] Template project strategy
- [ ] Create `home/templates/react-app/` with pre-built scaffold
- [ ] Builder copies template, modifies App.tsx + App.css only
- [ ] Skip `pnpm install` if node_modules exist in template (symlink or copy)
- [ ] Measure: template-based build vs from-scratch build

### T1322 [US55] HTML app fast path
- [ ] Detect when HTML app is sufficient (simple skill, single screen)
- [ ] Skip pnpm entirely for HTML apps
- [ ] Write file + register in modules.json = done
- [ ] Target: < 3 seconds for HTML apps

### T1323 [US55] Build error recovery
- [ ] On build failure: parse error, attempt single fix, rebuild
- [ ] Max 2 retry attempts (not infinite loop)
- [ ] If still failing: fall back to HTML app and inform user
- [ ] Log build failures with error details for debugging

---

## Checkpoint

1. [ ] `bun run test` passes with new skill validation tests
2. [ ] Skill loading at boot: no disk reads for cached skills
3. [ ] Builder generates React app in < 15s (measured)
4. [ ] Builder generates HTML app in < 5s (measured)
5. [ ] `loadSkills()` rejects malformed frontmatter with clear error
6. [ ] `load_skill("build-react-app")` also loads `app-builder` (composable)
7. [ ] Domain skills cover: react, html, dashboard, crud, game
