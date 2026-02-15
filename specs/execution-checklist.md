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
**008B**: Platform service built (Clerk auth, orchestrator, lifecycle, admin). T140-T159 scope.
**009 P0**: T200-T204 done. T205 crash loop deferred.
**009 P1**: T210-T216, T220-T222, T224, T230-T234 done. T223 conflict resolution deferred.
**010**: Not started. See sections below.
**011**: Spec written. Not started.
**012**: Core + stretch complete (T400-T412 except T410). Mission Control, Cmd+K, welcome tour.
**013A**: T500-T501 done. T502-T506 remaining.
**013B**: Not started.
**014-024**: New specs. Not started. See sections below.

**v0.3.0 tagged at HEAD. 479 tests passing across 44 test files.**

## Critical Fixes (from 2026-02-13 audit)

- [x] T053 (004) Serial dispatch queue -- prevents concurrent state corruption.
- [x] T100i (005) Implement gitSnapshotHook -- self-healing safety net.
- [x] T100j (005) System prompt token budgeting.
- [x] T133 (008A) Auth token validation (bearer token middleware, 8 tests).

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

### 13) Phase 014: Skills Library (T600-T614)

Source: `specs/014-skills-library/tasks.md`
**Parallel**: YES (Group 1). No code deps.

- [ ] T600 Research skill formats (Anthropic, skills.sh, user repos)
- [ ] T601 Refine skill frontmatter schema (category, tools_needed, channel_hints). TDD: update skills.test.ts.
- [ ] T602-T605 Productivity skills: web-search, calculator, translator, note-taker
- [ ] T606-T608 Coding skills: code-review, git-helper, debug
- [ ] T609-T610 Knowledge skills: research, explain
- [ ] T611-T612 Media skills: image-gen (needs T661), screenshot (needs T691)
- [ ] T613-T614 System skills: system-admin, app-builder

Checkpoint: Kernel lists 15+ skills. Skills with missing tool deps degrade gracefully.

### 14) Phase 015: Multi-Session + Approval Gates (T620-T636)

Source: `specs/015-multi-session/tasks.md`
**Parallel**: PARTIAL (Group 2 for sessions, Group 3 for approval gates).

Multi-Session (T620-T629):
- [ ] T620a Tests: multi-session ConversationStore
- [ ] T621 Extend ConversationStore: create, delete, search across sessions
- [ ] T622 IPC tools: new_conversation, search_conversations
- [ ] T623 Dispatcher: session routing, POST/DELETE /api/conversations, WS switch_session
- [ ] T624 Shell: useChatState createSession(), ChatPanel new chat via API

Approval Gates (T630-T636):
- [ ] T630a-T630b Tests: approval policy + gateway approval flow
- [ ] T631 Approval policy types + shouldRequireApproval()
- [ ] T632 Approval hook (PreToolUse, async requestApproval callback)
- [ ] T633 WebSocket approval protocol (request/response)
- [ ] T634 Shell ApprovalDialog component
- [ ] T635 Approval policy in config.json
- [ ] T636 Telegram inline keyboard approval

Checkpoint: Create new sessions, search across chats. Destructive tool calls trigger approval dialog.

### 15) Phase 016: Memory / RAG (T640-T652)

Source: `specs/016-memory/tasks.md`
**Parallel**: YES (Group 2). Independent module.

- [ ] T640a-T640b Tests: memory store + prompt integration
- [ ] T641 SQLite memories table + FTS5 virtual table
- [ ] T642 createMemoryStore: remember, recall, forget, listAll, exportToFiles
- [ ] T643 IPC tools: remember, recall, forget, list_memories
- [ ] T644 Auto-extraction from conversations (configurable)
- [ ] T645 System prompt injection (top-N relevant memories, 300 token cap)
- [ ] T646 Memory file export to ~/system/memory/

Checkpoint: "Remember I prefer dark themes" -> new chat -> "What theme?" -> correct answer.

### 16) Phase 017: Media (T660-T678)

Source: `specs/017-media/tasks.md`
**Parallel**: Image (Group 2) and Voice (Group 3) independent of each other.

Image Generation (T660-T667):
- [ ] T660a-T660b Tests: image gen + usage tracker
- [ ] T661 fal.ai client wrapper (FLUX models)
- [ ] T662 Usage tracker (JSONL, daily/monthly totals, limits)
- [ ] T663 generate_image IPC tool
- [ ] T664 Platform API key injection (env or config)
- [ ] T665 GET /api/usage endpoint
- [ ] T666 Image serving (content-type headers)
- [ ] T667 Shell inline image rendering

Voice (T668-T678):
- [ ] T668a Tests: voice service
- [ ] T669 ElevenLabs TTS client
- [ ] T670 Voice WebSocket endpoint (/ws/voice)
- [ ] T671 speak/transcribe IPC tools
- [ ] T672 Shell useVoice hook (mic recording + playback)
- [ ] T673 InputBar mic button
- [ ] T674 Voice config in config.json

Checkpoint: Generate image inline. Speak to OS and hear response.

### 17) Phase 018: CLI (T680-T689)

Source: `specs/018-cli/tasks.md`
**Parallel**: YES (Group 1). Fully independent.

- [ ] T680a Tests: CLI argument parser + formatters
- [ ] T681 CLI entry point (bin/matrixos.ts, node:util.parseArgs)
- [ ] T682 `matrixos start` (spawn gateway + shell)
- [ ] T683 `matrixos send "message"` (POST /api/message, stream response)
- [ ] T684 `matrixos status` (health, system info, channels, cron)
- [ ] T685 `matrixos doctor` (diagnostics: Node version, API key, DB, disk)
- [ ] T686 Package.json bin field + build config

Checkpoint: `matrixos start` launches OS. `matrixos send "2+2"` returns answer.

### 18) Phase 019: Browser Automation (T690-T699)

Source: `specs/019-browser/tasks.md`
**Parallel**: NO -- sequential after 017 Voice (T674). MCP server approach.

- [ ] T690a Tests: browser MCP tools (mocked Playwright)
- [ ] T691 MCP browser server (packages/mcp-browser/, Playwright)
- [ ] T692 Browser config + mcpServers wiring
- [ ] T693 Playwright installation docs
- [ ] T694 Screenshot serving + shell inline rendering
- [ ] T695 Builder agent integration (browse reference sites)

Checkpoint: "Search the web for X" returns results. "Screenshot this URL" renders inline.

### 19) Phase 020: Signup Redesign (T700-T709)

Source: `specs/020-signup-redesign/tasks.md`
**Parallel**: YES (Group 1). www/ only.

- [ ] T700 AuthLayout component (split-screen grid)
- [ ] T701 FeatureShowcase component (animated cards/slider)
- [ ] T702 Signup page redesign (features left, Clerk right)
- [ ] T703 Login page redesign (matching treatment)
- [ ] T704 Mobile responsive (stacked)
- [ ] T705 Polish (transitions, loading, error states)

Checkpoint: Split-screen signup with feature showcase. Auth flow works end-to-end.

### 20) Phase 021: Prebuilt Apps + App Theming (T710-T725)

Source: `specs/021-prebuilt-apps/tasks.md`
**Parallel**: PARTIAL (Group 3). T710 matrix.md spec first, then apps in parallel.

- [ ] T710-T710a matrix.md schema + parser (TDD)
- [ ] T711 Shell reads matrix.md (GET /api/apps, dock icons)
- [ ] T712-T715 Single-file apps: expense tracker, notes, todo, pomodoro
- [ ] T716-T717 Rich apps: code editor (CodeMirror), browser (iframe)
- [ ] T718 Static icon set (home/system/icons/)
- [ ] T719 Icon generation skill (fal.ai, needs T661)
- [ ] T720 Update home/ template with all prebuilt apps

Checkpoint: Fresh install shows 5-6 working apps in dock. Code editor can edit other apps.

### 21) Phase 022: Whitepaper (T730-T739)

Source: `specs/022-whitepaper/tasks.md`
**Parallel**: YES (Group 1). Content creation, no code deps.

- [ ] T730 Whitepaper content (8 sections: intro, related work, architecture, paradigms, implementation, vision, evaluation, conclusion)
- [ ] T731 Research citations
- [ ] T732 Web page (www/src/app/whitepaper/page.tsx)
- [ ] T733 PDF generation (print CSS)
- [ ] T734 Audio version (stretch, needs T669 ElevenLabs)
- [ ] T735 Navigation links (LP, footer, dashboard)

Checkpoint: matrix-os.com/whitepaper renders full document. PDF download works.

### 22) Phase 023: Landing Page Story + Agent Showcase (T740-T752)

Source: `specs/023-landing-page/tasks.md`
**Parallel**: YES (Group 1). www/ only.

- [ ] T740 Rewrite LP copy as narrative arc
- [ ] T741 Update hero (stronger headline, animated mockup, 479 tests)
- [ ] T742 Achievement-oriented tech strip
- [ ] T743 Agent showcase section (5 agents, animated flow)
- [ ] T744 Interactive demo element (scripted animation)
- [ ] T745 Skills showcase grid
- [ ] T746 Theme variation showcase (toggle themes)
- [ ] T747 Malleable LP concept (stretch)
- [ ] T748 Updated CTA (whitepaper link, GitHub badge)
- [ ] T749 Performance + SEO (Lighthouse > 90)
- [ ] T750 Mobile LP polish

Checkpoint: LP tells compelling story. Agent showcase shows team. Lighthouse > 90.

### 23) Phase 024: App Ecosystem (T760-T779)

Source: `specs/024-app-ecosystem/tasks.md`
**Parallel**: PARTIAL (Group 3+). Lower priority, incremental.

AI Button (T760-T762):
- [ ] T760-T760a AI button component + customize dispatch test
- [ ] T761 Kernel customization flow (modify existing app)
- [ ] T762 Component-level selection (stretch)

App Store (T763-T766):
- [ ] T763 App store data model (app-store.json)
- [ ] T764 Prompt library
- [ ] T765 App store shell component
- [ ] T766 Leaderboard (stretch, needs platform)

Desktop Modes (T767-T769):
- [ ] T767 Mode system (Zustand: desktop, ambient, dev, conversational)
- [ ] T768 Mode layouts
- [ ] T769 Mode persistence

Task Manager App (T770):
- [ ] T770 Task manager as prebuilt app

Checkpoint: AI button modifies apps live. App store browse + install. Desktop modes switch.

---

## Cross-Cutting Security + Quality Checklist

- [x] Verify all filesystem read/write endpoints enforce home-path containment.
- [ ] Add auth + authorization boundaries for HTTP, WS, and channel entrypoints.
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

Next (parallel groups):

**Group 1 (start immediately, all parallel):**
- [ ] 014 Skills Library (T600-T614)
- [ ] 020 Signup Redesign (T700-T709)
- [ ] 022 Whitepaper (T730-T739)
- [ ] 023 Landing Page (T740-T752)
- [ ] 018 CLI (T680-T689)

**Group 2 (start immediately, parallel with Group 1 and each other):**
- [ ] 015 Multi-Session (T620-T629)
- [ ] 016 Memory / RAG (T640-T652)
- [ ] 017 Media: Image Gen (T660-T667)

**Group 3 (after Group 2 deps):**
- [ ] 017 Media: Voice (T668-T678) -- after T662 usage tracker
- [ ] 021 Prebuilt Apps (T710-T725) -- after T661 image gen for icons
- [ ] 015 Approval Gates (T630-T636) -- after T620-T629 sessions

**Group 4 (after Group 3):**
- [ ] 019 Browser Automation (T690-T699) -- after T674 voice
- [ ] 024 App Ecosystem (T760-T779) -- after T720 prebuilt apps

**Deferred:**
- [ ] Phase 013A Docker (T502-T506) -- user working on this
- [ ] Phase 011 new computing (T300-T317) -- after demo release
- [ ] Phase 013B distro image (T510-T517)
- [ ] Phase 009 P2 platform expansion (T240-T261)
- [ ] Phase 010 demo recording (T062-T064) -- after all above
- [ ] Device pairing -- after 019 browser
