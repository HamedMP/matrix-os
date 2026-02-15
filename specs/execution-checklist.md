# Matrix OS Execution Checklist (Planning Only)

This is a consolidation of tasks and checklists from:

- `specs/003-architecture/*`
- `specs/004-concurrent/*`
- `specs/005-soul-skills/*`
- `specs/006-channels/*`
- `specs/007-proactive/*`
- `specs/008-cloud/*`
- `specs/009-platform/*`
- `specs/010-demo/*`
- `specs/011-new-computing/*`
- `specs/012-onboarding/*`
- `specs/013-distro/*`
- `specs/014-skills-library/*`
- `specs/015-multi-session/*`
- `specs/016-memory/*`
- `specs/017-media/*`
- `specs/018-cli/*`
- `specs/019-browser/*`
- `specs/020-signup-redesign/*`
- `specs/021-prebuilt-apps/*`
- `specs/022-whitepaper/*`
- `specs/023-landing-page/*`
- `specs/024-app-ecosystem/*`
- `specs/web4-vision.md`
- `specs/matrixos-vision.md`

No implementation is included in this document.

## Current State

**003-architecture**: 81/89 tasks done (Phases 1-6 complete, 207 tests). 8 unchecked are stubs moved to forward specs (agent prompts -> 005, module proxy -> 010).
**004**: Complete (T053-T056). Serial + concurrent dispatch. 307 tests after phase.
**005**: Complete (T100-T105, T100d-T100j). 245 tests after phase.
**006**: Telegram path done (T106-T112, T117, T119). WhatsApp/Discord/Slack deferred. 292 tests after phase.
**007**: Complete (T120-T129). Cron service + heartbeat runner + IPC tool. 349 tests after phase.
**008A**: T130-T135 done. T136 (deployment docs) remaining. 362 tests after phase.
**008B**: Platform service built (Clerk auth, orchestrator, lifecycle, admin, social). T140-T164 scope. Auth uses Clerk + Inngest (not Passkeys/TOTP from original spec). Security hardened: platform API auth middleware (T160), Inngest 409 idempotency (T161), lifecycle manager wired (T162), PostHog flush (T163), real health check (T164).
**009 P0**: T200-T204 done. T205 crash loop deferred.
**009 P1**: T210-T216, T220-T222, T224, T230-T234 done. T223 conflict resolution deferred.
**010**: Not started. See sections below.
**011**: Spec written. Not started.
**012**: Core + stretch complete (T400-T412 except T410). Mission Control, Cmd+K, welcome tour.
**013A**: T500-T501 done. T502-T506 remaining.
**013B**: Not started.
**014**: Complete (T600-T614). 13 skills, schema refinement. 20 tests.
**015**: Complete (T620-T636). Multi-session + approval gates. 36 tests.
**016**: Complete (T640-T652). Memory/RAG with FTS5. 35 tests.
**017**: Complete (T660-T678). Image gen + voice. 41 tests.
**018**: Complete (T680-T689). CLI with 6 commands. 20 tests.
**019**: Complete (T690-T695). Browser automation MCP. 12 tests.
**020**: Complete (T700-T709). Signup redesign.
**021**: Complete (T710-T720). Prebuilt apps + parser + icons. 15 tests.
**022**: Complete (T730-T739). Whitepaper.
**023**: Complete (T740-T752). Landing page narrative + agent showcase.
**024**: Complete (T760-T770). AI button, app store, desktop modes, task manager. 29 tests.

**v0.3.0 tagged at earlier commit. 666 tests passing across 59 test files (demo release complete).**

## Critical Fixes (from 2026-02-13 audit)

- [x] T053 (004) Serial dispatch queue -- prevents concurrent state corruption.
- [x] T100i (005) Implement gitSnapshotHook -- self-healing safety net.
- [x] T100j (005) System prompt token budgeting.
- [x] T133 (008A) Auth token validation (bearer token middleware, 8 tests).
- [x] T160 (008B) Platform API auth middleware (PLATFORM_SECRET bearer token, all routes).
- [x] T161 (008B) Inngest 409 idempotency (retry-safe provisioning).
- [x] T162 (008B) Lifecycle manager wired into platform startup.
- [x] T163 (008B) PostHog flush in serverless contexts.
- [x] T164 (008B) Container health check verifies gateway, not just DB status.

## 0) Program-Level Checklist

- [ ] Choose one canonical execution spec for runtime behavior conflicts (`003/FINAL-SPEC.md` vs `004-010/*`).
- [ ] Freeze source-of-truth policy for process/task state (SQLite tasks table as authoritative, generated file views secondary).
- [ ] Define required quality gates per phase: unit tests, integration tests, security checks, and runtime smoke checks.
- [ ] Define "done" criteria per phase before merge (acceptance criteria + checkpoint scenario from each phase spec).
- [x] Define release policy: git tags, SemVer, `docs/dev/releases.md`.

## 1) Vision Alignment Checklist (Web4 + Matrix OS)

- [ ] Every capability must be file-first and editable by user (`apps/`, `data/`, `system/`).
- [ ] Every generated app must have transparent source + data files, no opaque runtime-only state.
- [ ] Every major workflow must be available in at least one conversational shell + web shell.
- [x] Identity must be explicit (`handle`, `aiHandle`, profile files) before social/multi-user rollout.
- [x] Proactive behavior must exist (cron + heartbeat) before platform-level social features.
- [x] Observability and safe-mode must exist before multi-tenant public onboarding.

## Completed Phases (2-8)

(Phases 005-008A, 004, 007, 012 -- see individual spec folders for detailed task lists. All checkpoints met.)

## 9) Phase 010: Demo Readiness

Source: `specs/010-demo/tasks.md`

- [ ] T057 pre-seeded demo apps (superseded by 021-prebuilt-apps T712-T717)
- [ ] T058 code editor component (superseded by 021 T716)
- [ ] T059 file browser component
- [ ] T060 voice gateway (superseded by 017-media T668-T674)
- [ ] T061 dynamic agent creation validation
- [ ] T062 demo script validation
- [ ] T063 `demo-safe` git tag
- [ ] T064 demo recording

## 10) Phase 011: New Forms of Computing

Source: `specs/011-new-computing/tasks.md`

- [ ] T300-T304 Living Software (usage telemetry, evolution skill, cron integration, approval UX)
- [ ] T305-T308 Socratic Computing (ambiguity detection, dialogue lineage, socratic skill)
- [ ] T310-T314 Intent-Based Interfaces (intent file format, matching, channel-specific rendering)
- [ ] T315-T317 Progressive Depth (Bruner's modes, beginner mode, context-aware suggestions)

## 11) Phase 013: Linux Distro + Docker Deployment

Source: `specs/013-distro/tasks.md`

Phase A (Docker): T500-T501 done. T502-T506 remaining.
Phase B (Distro image): T510-T517 not started.

## 12) Phase 009 P2: Platform Expansion (POST-MVP)

- [ ] T240-T244 multi-user
- [ ] T245-T249 inter-profile messaging + privacy
- [ ] T250-T254 app marketplace
- [ ] T255-T258 AI social
- [ ] T259-T261 distribution

---

## NEW: Demo Release Specs (014-024)

### Parallelization Map

```
PARALLEL GROUP 1 (immediate, no deps):
  014 Skills Library      (T600-T614)  -- file-only, no code changes for most
  020 Signup Redesign     (T700-T709)  -- www/ only
  022 Whitepaper          (T730-T739)  -- content creation
  023 Landing Page        (T740-T752)  -- www/ only
  018 CLI                 (T680-T689)  -- new package, consumes existing APIs

PARALLEL GROUP 2 (no deps between them, but some touch shared files):
  015 Multi-Session       (T620-T629)  -- touches dispatcher, ConversationStore
  016 Memory / RAG        (T640-T652)  -- touches DB schema, ipc-server, prompt
  017 Media: Image Gen    (T660-T667)  -- new module + ipc tool

PARALLEL GROUP 3 (deps on Group 2):
  017 Media: Voice        (T668-T678)  -- after image gen infra (shares usage tracker)
  021 Prebuilt Apps       (T710-T725)  -- after T661 (image gen) for icon generation

SEQUENTIAL (ordered deps):
  015 Approval Gates      (T630-T636)  -- after multi-session (shares shell patterns)
  019 Browser             (T690-T699)  -- after voice (per user request)
  024 App Ecosystem       (T760-T779)  -- after prebuilt apps + approval gates

DEFERRED:
  Device pairing         -- after browser (019)
  Additional channels    -- Telegram sufficient for demo
  Multi-model providers  -- Anthropic only
```

### 13) Phase 014: Skills Library (T600-T614) -- COMPLETE

Source: `specs/014-skills-library/tasks.md`

- [x] T600 Research skill formats
- [x] T601 Refine skill frontmatter schema (category, tools_needed, channel_hints)
- [x] T602-T605 Productivity skills: web-search, calculator, translator, note-taker
- [x] T606-T608 Coding skills: code-review, git-helper, debug
- [x] T609-T610 Knowledge skills: research, explain
- [x] T611-T612 Media skills: image-gen, screenshot
- [x] T613-T614 System skills: system-admin, app-builder

13 skills total, 20 tests. Commit: 86857a9.

### 14) Phase 015: Multi-Session + Approval Gates (T620-T636) -- COMPLETE

Source: `specs/015-multi-session/tasks.md`

Multi-Session (T620-T629):
- [x] T620a Tests: multi-session ConversationStore
- [x] T621 Extend ConversationStore: create, delete, search across sessions
- [x] T622 IPC tools: new_conversation, search_conversations
- [x] T623 Dispatcher: session routing, POST/DELETE /api/conversations, WS switch_session
- [x] T624 Shell: useChatState createSession(), ChatPanel new chat via API

Approval Gates (T630-T636):
- [x] T630a-T630b Tests: approval policy + gateway approval flow
- [x] T631 Approval policy types + shouldRequireApproval()
- [x] T632 Approval hook (PreToolUse, async requestApproval callback)
- [x] T633 WebSocket approval protocol (request/response)
- [x] T634 Shell ApprovalDialog component
- [x] T635 Approval policy in config.json
- [ ] T636 Telegram inline keyboard approval (deferred)

36 tests. Commit: e4e50c2.

### 15) Phase 016: Memory / RAG (T640-T652) -- COMPLETE

Source: `specs/016-memory/tasks.md`

- [x] T640a-T640b Tests: memory store + prompt integration
- [x] T641 SQLite memories table + FTS5 virtual table
- [x] T642 createMemoryStore: remember, recall, forget, listAll, exportToFiles
- [x] T643 IPC tools: remember, recall, forget, list_memories
- [x] T644 Auto-extraction from conversations (configurable)
- [x] T645 System prompt injection (top-N relevant memories, 300 token cap)
- [x] T646 Memory file export to ~/system/memory/

35 tests.

### 16) Phase 017: Media (T660-T678) -- COMPLETE

Source: `specs/017-media/tasks.md`

Image Generation (T660-T667):
- [x] T660a-T660b Tests: image gen + usage tracker
- [x] T661 fal.ai client wrapper (FLUX models)
- [x] T662 Usage tracker (JSONL, daily/monthly totals, limits)
- [x] T663 generate_image IPC tool
- [x] T664 Platform API key injection (env or config)
- [x] T665 GET /api/usage endpoint
- [x] T666 Image serving (content-type headers)
- [x] T667 Shell inline image rendering

Voice (T668-T678):
- [x] T668a Tests: voice service
- [x] T669 ElevenLabs TTS client
- [x] T670 Voice WebSocket endpoint (/ws/voice)
- [x] T671 speak/transcribe IPC tools
- [x] T672 Shell useVoice hook (mic recording + playback)
- [x] T673 InputBar mic button
- [x] T674 Voice config in config.json

24 + 17 = 41 tests. Commits: d0dab36 (image), cced192 (voice).

### 17) Phase 018: CLI (T680-T689) -- COMPLETE

Source: `specs/018-cli/tasks.md`

- [x] T680a Tests: CLI argument parser + formatters
- [x] T681 CLI entry point (bin/matrixos.ts, node:util.parseArgs)
- [x] T682 `matrixos start` (spawn gateway + shell)
- [x] T683 `matrixos send "message"` (POST /api/message, stream response)
- [x] T684 `matrixos status` (health, system info, channels, cron)
- [x] T685 `matrixos doctor` (diagnostics: Node version, API key, DB, disk)
- [x] T686 Package.json bin field + build config

20 tests. Commit: ff7183e.

### 18) Phase 019: Browser Automation (T690-T699) -- COMPLETE

Source: `specs/019-browser/tasks.md`

- [x] T690a Tests: browser MCP tools (mocked Playwright)
- [x] T691 MCP browser server (packages/mcp-browser/, Playwright)
- [x] T692 Browser config + mcpServers wiring
- [x] T693 Playwright installation docs
- [x] T694 Screenshot serving + shell inline rendering
- [x] T695 Builder agent integration (browse reference sites)

12 tests. Commit: 34c3502.

### 19) Phase 020: Signup Redesign (T700-T709) -- COMPLETE

Source: `specs/020-signup-redesign/tasks.md`

- [x] T700 AuthLayout component (split-screen grid)
- [x] T701 FeatureShowcase component (animated cards/slider)
- [x] T702 Signup page redesign (features left, Clerk right)
- [x] T703 Login page redesign (matching treatment)
- [x] T704 Mobile responsive (stacked)
- [x] T705 Polish (transitions, loading, error states)

Commit: 89810eb.

### 20) Phase 021: Prebuilt Apps + App Theming (T710-T725) -- COMPLETE

Source: `specs/021-prebuilt-apps/tasks.md`

- [x] T710-T710a matrix.md schema + parser (TDD)
- [x] T711 Shell reads matrix.md (GET /api/apps, dock icons)
- [x] T712-T715 Single-file apps: expense tracker, notes, todo, pomodoro
- [x] T716-T717 Rich apps: code editor (CodeMirror), browser (iframe)
- [x] T718 Static icon set (home/system/icons/)
- [ ] T719 Icon generation skill (deferred -- fal.ai runtime)
- [x] T720 Update home/ template with all prebuilt apps

6 apps, 15 icons, 15 tests. Commits: 6a27de3 (apps), f1db19f (GET /api/apps).

### 21) Phase 022: Whitepaper (T730-T739) -- COMPLETE

Source: `specs/022-whitepaper/tasks.md`

- [x] T730 Whitepaper content (8 sections)
- [x] T731 Research citations
- [x] T732 Web page (www/src/app/whitepaper/page.tsx)
- [x] T733 PDF generation (print CSS)
- [ ] T734 Audio version (deferred -- needs runtime ElevenLabs)
- [x] T735 Navigation links (LP, footer, dashboard)

~4500 words. Commit: 89810eb.

### 22) Phase 023: Landing Page Story + Agent Showcase (T740-T752) -- COMPLETE

Source: `specs/023-landing-page/tasks.md`

- [x] T740 Rewrite LP copy as narrative arc
- [x] T741 Update hero (stronger headline, animated mockup)
- [x] T742 Achievement-oriented tech strip
- [x] T743 Agent showcase section (5 agents, animated flow)
- [ ] T744 Interactive demo element (deferred)
- [x] T745 Skills showcase grid
- [ ] T746 Theme variation showcase (deferred)
- [ ] T747 Malleable LP concept (deferred -- stretch)
- [x] T748 Updated CTA (whitepaper link, GitHub badge)
- [ ] T749 Performance + SEO (deferred -- needs runtime Lighthouse)
- [x] T750 Mobile LP polish

Commits: 89810eb, 381ad2c, 4ac86e7.

### 23) Phase 024: App Ecosystem (T760-T779) -- COMPLETE

Source: `specs/024-app-ecosystem/tasks.md`

AI Button (T760-T762):
- [x] T760-T760a AI button component + customize dispatch test
- [x] T761 Kernel customization flow (modify existing app)
- [ ] T762 Component-level selection (deferred -- stretch)

App Store (T763-T766):
- [x] T763 App store data model (app-store.json)
- [x] T764 Prompt library
- [x] T765 App store shell component
- [ ] T766 Leaderboard (deferred -- needs platform)

Desktop Modes (T767-T769):
- [x] T767 Mode system (Zustand: desktop, ambient, dev, conversational)
- [x] T768 Mode layouts
- [x] T769 Mode persistence

Task Manager App (T770):
- [x] T770 Task manager as prebuilt app

29 tests. Commits: a1665fa (AI+store), 4796822 (modes), 34c3502 (task manager).

---

## Cross-Cutting Security + Quality Checklist

- [x] Verify all filesystem read/write endpoints enforce home-path containment.
- [x] Add auth + authorization boundaries for HTTP, WS, and channel entrypoints. (T133 gateway auth, T160 platform API auth)
- [ ] Define and enforce realistic test/coverage thresholds aligned with actual scope.
- [ ] Add non-empty integration test suite and CI signal for `test:integration`.
- [ ] Add structured logging for kernel invocations, tool usage, and failures.
- [ ] Add crash-loop protection and rollback/safe-mode entry criteria.

## Cross-Phase Dependencies (Updated)

Original:
- **dispatcher.ts**: T109 -> T054. Done.
- **prompt.ts**: T110 -> T056. Done.
- **config.json**: T112 -> T126. Done.

New:
- **ipc-server.ts**: T622 (new_conversation) + T643 (memory tools) + T663 (generate_image) + T671 (voice tools). These add tools to the same file but are additive (no conflicts). Can be done in parallel with care.
- **prompt.ts**: T645 (memory injection). Adds a new section, must respect T100j token budget.
- **config.json**: T635 (approval policy) + T664 (fal.ai key) + T674 (voice config). Additive sections.
- **ConversationStore**: T621 (multi-session). Extended interface, backwards compatible.
- **server.ts**: T633 (approval WS) + T665 (usage endpoint) + T670 (voice WS). New endpoints, no conflicts.
- **home/ template**: T720 (prebuilt apps). Large change to template. Coordinate with T718 (icons).

## Execution Order (Updated)

Completed:
- [x] T053 serial dispatch queue
- [x] Phase 005 SOUL + skills
- [x] Phase 006 Telegram path
- [x] Phase 004 concurrent dispatch
- [x] Phase 007 cron + heartbeat
- [x] Phase 012 onboarding core + stretch
- [x] Phase 008A single-user cloud
- [x] Phase 008B multi-tenant platform (Clerk, orchestrator, lifecycle, admin)
- [x] Phase 009 P0 observability
- [x] Phase 009 P1 identity + sync + mobile

Demo release (Groups 1-4, completed in single swarm session):

**Group 1 (completed):**
- [x] 014 Skills Library (T600-T614)
- [x] 020 Signup Redesign (T700-T709)
- [x] 022 Whitepaper (T730-T739)
- [x] 023 Landing Page (T740-T752)
- [x] 018 CLI (T680-T689)

**Group 2 (completed):**
- [x] 015 Multi-Session (T620-T629)
- [x] 016 Memory / RAG (T640-T652)
- [x] 017 Media: Image Gen (T660-T667)

**Group 3 (completed):**
- [x] 017 Media: Voice (T668-T678)
- [x] 021 Prebuilt Apps (T710-T725)
- [x] 015 Approval Gates (T630-T636)

**Group 4 (completed):**
- [x] 019 Browser Automation (T690-T699)
- [x] 024 App Ecosystem (T760-T779)

**Remaining / Deferred:**
- [ ] Phase 013A Docker (T502-T506)
- [ ] Phase 011 new computing (T300-T317)
- [ ] Phase 013B distro image (T510-T517)
- [ ] Phase 009 P2 platform expansion (T240-T261)
- [ ] Phase 010 demo recording (T062-T064)
- [ ] Device pairing
