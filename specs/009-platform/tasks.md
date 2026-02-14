# Tasks: Web 4 Platform Vision

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T200-T260 (new tasks)

## User Stories

- **US11** (P0): "I can see what my OS is doing and how much it costs" -- Observability
- **US12** (P0): "When things break badly, safe mode fixes it" -- Safe Mode
- **US13** (P1): "My OS has a handle and my AI has a handle" -- Identity
- **US14** (P1): "My files sync between local and cloud" -- Git Sync
- **US15** (P1): "I can use Matrix OS from my phone" -- Mobile
- **US16** (P2): "Other people can sign up and use Matrix OS" -- Multi-User
- **US17** (P2): "I can message other users and their AIs" -- Inter-Profile
- **US18** (P2): "I can publish and install apps" -- Marketplace
- **US19** (P2): "My AI has a public profile" -- AI Social
- **US20** (P2): "I can install Matrix OS as a system shell" -- Distribution

---

## Phase 13: Observability + Safety (P0)

### Tests

- [x] T200a [P] [US11] Write `tests/gateway/logger.test.ts` -- 8 tests: JSONL logging, append, truncation, timestamps, query, filter by source, cost totaling, missing file handling

- [x] T200b [P] [US12] Write `tests/kernel/safe-mode.test.ts` -- 5 tests: sonnet model, restricted tools, diagnostic prompt, error context, graceful fallback

### Implementation

- [x] T200 [US11] Implement interaction logger in `packages/gateway/src/logger.ts` -- structured JSON logs to `~/system/logs/YYYY-MM-DD.jsonl`. Fields: timestamp, source, sessionId, prompt (truncated), tools_used, tokens_in, tokens_out, cost_usd, duration_ms, result.

- [x] T201 [US11] Add `GET /api/logs` endpoint -- query logs by date, filter by source. Returns entries + totalCost.

- [x] T202 [US11] Cost tracker integrated into logger (`totalCost()`) and `GET /api/system/info` (todayCost field).

- [x] T203 [P] [US11] Create `home/system/logs/.gitkeep` -- logs directory in home template

- [x] T204 [US12] Implement safe mode agent in `packages/kernel/src/safe-mode.ts` -- agent def (sonnet, disallowed agents), diagnostic prompt with activity.log context.

- [ ] T205 [US12] Add safe mode trigger in `packages/gateway/src/server.ts` -- crash counter + auto-switch to safe mode (deferred: needs crash loop detection in dispatcher).

---

## Phase 14: Identity System (P1)

### Tests

- [x] T210a [P] [US13] Write `tests/kernel/identity.test.ts` -- 5 tests: empty handle, load from JSON, derive AI handle, save, corrupt file

### Implementation

- [x] T210 [US13] Create handle registry at `home/system/handle.json` -- empty by default, populated on first setup.

- [x] T211 [US13] Implement `loadHandle()` in `packages/kernel/src/identity.ts` -- reads handle.json, derives AI handle (`{handle}_ai`), returns Identity

- [x] T212 [US13] Create `home/system/profile.md` -- human profile template (display name, bio, timezone, language)

- [x] T213 [US13] Create `home/system/ai-profile.md` -- AI profile template (personality, skills, capabilities)

- [x] T214 [US13] Modify `buildSystemPrompt()` to include handle -- "You are @{handle}_ai:matrix-os.com, the AI assistant for @{handle}:matrix-os.com"

- [x] T215 [US13] Add `GET /api/profile` and `GET /api/ai-profile` endpoints -- serve profile markdown

- [x] T216 [P] [US13] Add setup wizard for first boot -- if handle.json is empty, kernel asks user to set their handle on first interaction

---

## Phase 15: Git Sync (P1)

### Tests

- [ ] T220a [P] [US14] Write `tests/gateway/git-sync.test.ts` -- test sync logic: commit, push, pull, conflict detection, .gitignore management

### Implementation

- [ ] T220 [US14] Implement `GitSync` in `packages/gateway/src/git-sync.ts` -- `commit()`, `push()`, `pull()`, `addRemote()`, `removeRemote()`, `status()`. Uses child_process `git` commands.

- [ ] T221 [US14] Add auto-sync on changes -- debounced (30s after last change): `git add -A && git commit && git push`. Triggered by file watcher events for significant changes (not activity.log).

- [ ] T222 [US14] Add `matrixos sync` support via kernel -- user says "sync my files" -> kernel runs git push/pull via Bash. Or "add a backup to GitHub" -> kernel runs `git remote add`.

- [ ] T223 [P] [US14] Implement conflict resolution -- on pull conflict, kernel reads conflict markers, makes a decision, commits resolution. Falls back to manual if unsure.

- [ ] T224 [P] [US14] Create `.gitignore` template in `home/` -- ignore `system/logs/`, `system/whatsapp-auth/`, `node_modules/`, `*.sqlite`, large media files

---

## Phase 16: Mobile Experience (P1)

- [ ] T230 [US15] Make web shell responsive -- CSS media queries for mobile breakpoints (<768px)
- [ ] T231 [P] [US15] Mobile dock -- bottom tab bar replacing left dock on narrow screens
- [ ] T232 [P] [US15] Mobile windows -- full-screen cards with swipe navigation
- [ ] T233 [P] [US15] Touch-friendly input bar -- larger touch targets, swipe for suggestions
- [ ] T234 [US15] Add PWA manifest (`shell/public/manifest.json`) -- installable on home screen, app icon, splash screen

---

## Phase 17: Multi-User Platform (P2)

- [ ] T240 [US16] Design multi-user auth service -- signup, login, handle registration, JWT tokens
- [ ] T241 [US16] Per-user container isolation -- Docker container per user with isolated home dir
- [ ] T242 [US16] User dashboard -- manage instance, view usage, billing
- [ ] T243 [P] [US16] Handle discovery API -- search users by handle
- [ ] T244 [P] [US16] Admin panel -- manage instances, monitor resources

---

## Phase 18: Inter-Profile Messaging (P2)

- [ ] T245 [US17] Design message routing between instances -- API endpoint for incoming external messages
- [ ] T246 [US17] Implement sandboxed context (call center model) -- external requests get curated public context only
- [ ] T247 [US17] Privacy controls -- owner configures what's public vs private in `~/system/privacy.json`
- [ ] T248 [P] [US17] Rate limiting per external sender
- [ ] T249 [P] [US17] Notification system -- alert owner when their AI receives external messages

---

## Phase 19: App Marketplace (P2)

- [ ] T250 [US18] Design app packaging format -- zip with manifest, dependencies, preview screenshot
- [ ] T251 [US18] Implement app registry -- git-based or API-backed catalog
- [ ] T252 [US18] `matrixos install <app>` / `matrixos publish <app>` via kernel
- [ ] T253 [P] [US18] Marketplace UI in web shell -- browse, search, install, rate
- [ ] T254 [P] [US18] Monetization -- Stripe integration, revenue split

---

## Phase 20: AI Social (P2)

- [ ] T255 [US19] Implement AI activity feed -- public posts derived from notable kernel actions
- [ ] T256 [US19] Follow/unfollow AIs -- subscribe to another AI's activity feed
- [ ] T257 [P] [US19] AI capability browser -- discover AIs by skills
- [ ] T258 [P] [US19] Social API -- `GET /api/feed`, `POST /api/feed`

---

## Phase 21: Distribution (P2)

- [ ] T259 [US20] `matrixos` CLI command -- natural language shell, falls through to bash for unrecognized commands
- [ ] T260 [P] [US20] Linux packages -- installer script, .deb/.rpm, snap
- [ ] T261 [P] [US20] Desktop integration -- Linux desktop entry, custom login screen

---

## Priority Summary

| Priority | Phase | Tasks | Target |
|----------|-------|-------|--------|
| P0 | 13: Observability + Safety | T200-T205 | Hackathon |
| P1 | 14: Identity | T210-T216 | Hackathon |
| P1 | 15: Git Sync | T220-T224 | Hackathon stretch |
| P1 | 16: Mobile | T230-T234 | Hackathon stretch |
| P2 | 17: Multi-User | T240-T244 | Post-hackathon |
| P2 | 18: Inter-Profile | T245-T249 | Post-hackathon |
| P2 | 19: Marketplace | T250-T254 | Post-hackathon |
| P2 | 20: AI Social | T255-T258 | Post-hackathon |
| P2 | 21: Distribution | T259-T261 | Post-hackathon |
