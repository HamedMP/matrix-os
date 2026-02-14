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
- `specs/web4-vision.md`
- `specs/matrixos-vision.md`

No implementation is included in this document.

## Current State

**003-architecture**: 81/89 tasks done (Phases 1-6 complete, 207 tests). 8 unchecked are stubs moved to forward specs (agent prompts -> 005, module proxy -> 010).
**004-011**: Not started. See sections below.

## Critical Fixes (from 2026-02-13 audit)

These must be addressed before or during the next phases. Task IDs are assigned to the appropriate spec.

- [ ] T053 (004) Serial dispatch queue -- prevents concurrent state corruption. Must be done before 006 (channels).
- [ ] T100i (005) Implement gitSnapshotHook -- self-healing safety net is currently hollow.
- [ ] T100j (005) System prompt token budgeting -- will exceed 7K as SOUL + skills grow.
- [ ] T133 (008A) Auth token validation -- MATRIX_AUTH_TOKEN documented but never checked. Already in 008 task list.

## 0) Program-Level Checklist

- [ ] Choose one canonical execution spec for runtime behavior conflicts (`003/FINAL-SPEC.md` vs `004-010/*`).
- [ ] Freeze source-of-truth policy for process/task state (SQLite tasks table as authoritative, generated file views secondary).
- [ ] Define required quality gates per phase: unit tests, integration tests, security checks, and runtime smoke checks.
- [ ] Define "done" criteria per phase before merge (acceptance criteria + checkpoint scenario from each phase spec).
- [ ] Define release policy: local dev, single-user cloud, multi-tenant platform, public distribution.

## 1) Vision Alignment Checklist (Web4 + Matrix OS)

- [ ] Every capability must be file-first and editable by user (`apps/`, `data/`, `system/`).
- [ ] Every generated app must have transparent source + data files, no opaque runtime-only state.
- [ ] Every major workflow must be available in at least one conversational shell + web shell.
- [ ] Identity must be explicit (`handle`, `aiHandle`, profile files) before social/multi-user rollout.
- [ ] Proactive behavior must exist (cron + heartbeat) before platform-level social features.
- [ ] Observability and safe-mode must exist before multi-tenant public onboarding.

## 2) Phase 005: SOUL Identity + Skills

Source: `specs/005-soul-skills/tasks.md`

- [ ] T100a `tests/kernel/soul.test.ts`
- [ ] T100b `tests/kernel/skills.test.ts`
- [ ] T100 `home/system/soul.md`
- [ ] T101 `packages/kernel/src/soul.ts` loadSoul
- [ ] T102 `packages/kernel/src/prompt.ts` inject SOUL in system prompt
- [ ] T103 `packages/kernel/src/skills.ts` loadSkills + frontmatter parsing
- [ ] T104 `home/agents/skills/` initial skills (`summarize.md`, `weather.md`, `reminder.md`, `skill-creator.md`)
- [ ] T105 wire skills TOC + `load_skill` IPC tool
- [ ] T100d-T100h agent prompts (builder, researcher, deployer, healer, evolver)
- [ ] T100i gitSnapshotHook (audit critical fix)
- [ ] T100j system prompt token budgeting (audit critical fix)

Checkpoint:

- [ ] Kernel can list skills and dynamically load skill body at runtime.

## 3) Phase 006: Multi-Channel Messaging (Telegram First)

Source: `specs/006-channels/tasks.md`

Infrastructure:

- [ ] T106a `tests/gateway/channels/manager.test.ts`
- [ ] T106b `tests/gateway/channels/telegram.test.ts`
- [ ] T106c `tests/gateway/channels/message-format.test.ts`
- [ ] T106 `packages/gateway/src/channels/types.ts`
- [ ] T107 `packages/gateway/src/channels/manager.ts`
- [ ] T108 `packages/gateway/src/channels/format.ts`
- [ ] T109 `packages/gateway/src/dispatcher.ts` channel-aware dispatch context
- [ ] T110 prompt channel context + channel-routing knowledge

Adapters:

- [ ] T111 Telegram adapter
- [ ] T112 `home/system/config.json` channels section
- [ ] T113 WhatsApp adapter
- [ ] T114 WhatsApp QR flow endpoint
- [ ] T115 Discord adapter
- [ ] T116 Slack adapter

Integration:

- [ ] T117 wire ChannelManager in gateway startup/shutdown + `/api/channels/status`
- [ ] T118 shell channel status indicators
- [ ] T119 `home/agents/knowledge/channel-routing.md`

Checkpoint:

- [ ] Telegram inbound/outbound works and appears in web shell conversation stream.

## 4) Phase 004: Concurrent Kernel Dispatch

Source: `specs/004-concurrent/tasks.md`. Deferred until after channels -- concurrent dispatch becomes useful when web shell + Telegram can send messages simultaneously.

Pre-requisite (serial queue -- must be done before 006):

- [ ] T053a `tests/gateway/dispatcher-queue.test.ts`
- [ ] T053 serial dispatch queue in `dispatcher.ts` (FIFO mutex, no parallelism)

Full concurrent dispatch (after 006):

- [ ] T054a `tests/gateway/dispatcher-concurrent.test.ts`
- [ ] T054 `packages/gateway/src/dispatcher.ts` concurrent dispatch + request multiplexing
- [ ] T055 `packages/kernel/src/index.ts` kernel process registration in SQLite tasks table
- [ ] T056 `packages/kernel/src/prompt.ts` conflict avoidance via active process context

Checkpoint:

- [ ] "Build me a CRM" and "Make the theme darker" run in parallel without file conflicts.

## 5) Phase 007: Cron + Heartbeat

Source: `specs/007-proactive/tasks.md`

Cron:

- [ ] T120a `tests/gateway/cron/service.test.ts`
- [ ] T120b `tests/gateway/cron/store.test.ts`
- [ ] T120 `packages/gateway/src/cron/service.ts`
- [ ] T121 `packages/gateway/src/cron/store.ts`
- [ ] T122 `packages/kernel/src/ipc.ts` add cron IPC tool
- [ ] T123 `home/system/cron.json`

Heartbeat:

- [ ] T120c `tests/gateway/heartbeat/runner.test.ts`
- [ ] T124 `packages/gateway/src/heartbeat/runner.ts`
- [ ] T125 `packages/gateway/src/heartbeat/prompt.ts`
- [ ] T126 active-hours behavior in config + runtime logic
- [ ] T127 route heartbeat outputs to channels

Integration:

- [ ] T128 wire cron + heartbeat startup/shutdown + health status
- [ ] T129 update default `home/agents/heartbeat.md`

Checkpoint:

- [ ] Reminder created by kernel appears in cron store and is delivered by heartbeat cycle.

## 6) Phase 008A: Single-User Cloud Deployment

Source: `specs/008-cloud/tasks.md` (Part A)

- [ ] T130 `Dockerfile`
- [ ] T131 `docker-compose.yml`
- [ ] T132 `scripts/matrixos.service`
- [ ] T133 gateway auth token middleware
- [ ] T134 `scripts/setup-server.sh`
- [ ] T135 `/api/system/info` endpoint
- [ ] T136 `docs/deployment.md`

Checkpoint:

- [ ] Cloud instance reachable, persistent, and authenticated.

## 7) Phase 008B: Multi-Tenant Platform

Source: `specs/008-cloud/tasks.md` (Part B). T137-T139 reserved.

Infrastructure + auth:

- [ ] T140-T143 platform service, auth/session/db

Orchestration:

- [ ] T144-T147 container lifecycle + Caddy routing

Product surfaces:

- [ ] T148-T150 landing/signup/login

Economics + social:

- [ ] T151-T154 API proxy/quota/social/community panel

Matrix interop:

- [ ] T155-T156 homeserver + per-instance Matrix client

Admin/deploy:

- [ ] T157-T159 admin/health/deploy

Checkpoint:

- [ ] User signup provisions isolated container and routes to user subdomain.

## 8) Phase 009: Platform Vision Backlog (P0/P1/P2)

Source: `specs/009-platform/tasks.md`

P0 (must-have before broad launch):

- [ ] T200a, T200b tests for logger and safe mode
- [ ] T200 interaction logger
- [ ] T201 logs query API
- [ ] T202 cost tracker
- [ ] T203 logs directory template
- [ ] T204 safe mode agent
- [ ] T205 safe mode trigger + API

P1 (next product-critical):

- [ ] T210-T216 identity system
- [ ] T220-T224 git sync
- [ ] T230-T234 mobile experience + PWA

P2 (POST-MVP -- each item below is its own product. Revisit after 008B is stable.):

- [ ] T240-T244 multi-user
- [ ] T245-T249 inter-profile messaging + privacy
- [ ] T250-T254 app marketplace
- [ ] T255-T258 AI social
- [ ] T259-T261 distribution

## 9) Phase 010: Demo Readiness

Source: `specs/010-demo/tasks.md`

- [ ] T057 pre-seeded demo apps
- [ ] T058 code editor component
- [ ] T059 file browser component
- [ ] T060 voice gateway (stretch)
- [ ] T061 dynamic agent creation validation
- [ ] T062 demo script validation
- [ ] T063 `demo-safe` git tag
- [ ] T064 demo recording

Checkpoint:

- [ ] 7-act demo runs end-to-end without manual patching.

## 10) Phase 011: New Forms of Computing

Source: `specs/011-new-computing/tasks.md`

Three paradigms that make Matrix OS a new medium, not just faster app generation.

Living Software:

- [ ] T300-T304 usage telemetry, evolution skill, cron integration, approval UX

Socratic Computing:

- [ ] T305-T308 ambiguity detection, dialogue lineage, socratic skill, cross-channel continuity

Intent-Based Interfaces:

- [ ] T310-T314 intent file format, matching, channel-specific rendering, example intent

Progressive Depth:

- [ ] T315-T317 Bruner's modes, beginner mode, context-aware suggestions

Checkpoint:

- [ ] Expense tracker evolves from usage, Socratic questions before ambiguous builds, same intent renders differently on web vs Telegram.

## 11) Cross-Cutting Security + Quality Checklist

- [x] Verify all filesystem read/write endpoints enforce home-path containment. (Fixed: /files/* uses resolveWithinHome(), commit 3919f3f.)
- [ ] Add auth + authorization boundaries for HTTP, WS, and channel entrypoints.
- [ ] Define and enforce realistic test/coverage thresholds aligned with actual scope.
- [ ] Add non-empty integration test suite and CI signal for `test:integration`.
- [ ] Add structured logging for kernel invocations, tool usage, and failures.
- [ ] Add crash-loop protection and rollback/safe-mode entry criteria.

## 12) Cross-Phase Dependencies

These tasks touch the same files and must be sequenced:

- **dispatcher.ts**: T109 (006 channel-aware dispatch) -> T054 (004 concurrent dispatch). Complete channel dispatch first, then add parallelism.
- **prompt.ts**: T110 (006 channel prompt context) -> T056 (004 conflict avoidance). Complete channel context injection first, then add process awareness.
- **config.json**: T112 (006 channels config) -> T126 (007 heartbeat active hours). Both add sections to the same config file.

## 13) Execution Order Checklist (No Timeline)

- [ ] T053 serial dispatch queue (critical fix, before channels).
- [ ] Complete Phase 005 fully (SOUL + skills + agent prompts + audit critical fixes T100i/T100j).
- [ ] Complete Phase 006 Telegram path end-to-end (minimum one channel production-ready).
- [ ] Complete Phase 004 concurrent dispatch (needed once channels + web shell both send messages).
- [ ] Complete Phase 007 cron + heartbeat end-to-end.
- [ ] Complete Phase 008A single-user cloud deploy path (includes T133 auth).
- [ ] Complete Phase 009 P0 observability + safe-mode.
- [ ] Complete Phase 009 P1 identity + sync + mobile.
- [ ] Start Phase 011 new computing (Living Software, Socratic, Intent-based -- incremental).
- [ ] Start Phase 008B/009 P2 platform expansion.
- [ ] Finalize Phase 010 demo polish and recording.
