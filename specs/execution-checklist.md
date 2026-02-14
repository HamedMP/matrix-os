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
**008B-010**: Not started. See sections below.
**011**: Spec written. Not started.
**012**: Core complete (T400-T407, T404a-T404i). Remaining: T408 shell chips, T411 welcome tour, T412 re-onboarding (stretch).
**013A**: T500 (Dockerfile) + T501 (compose) done (shared with 008A T130/T131). User working on additional distro scaffolding.
**013B**: Not started.

## Critical Fixes (from 2026-02-13 audit)

These must be addressed before or during the next phases. Task IDs are assigned to the appropriate spec.

- [x] T053 (004) Serial dispatch queue -- prevents concurrent state corruption. Must be done before 006 (channels).
- [x] T100i (005) Implement gitSnapshotHook -- self-healing safety net is currently hollow.
- [x] T100j (005) System prompt token budgeting -- will exceed 7K as SOUL + skills grow.
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

- [x] T100a `tests/kernel/soul.test.ts`
- [x] T100b `tests/kernel/skills.test.ts`
- [x] T100 `home/system/soul.md`
- [x] T101 `packages/kernel/src/soul.ts` loadSoul
- [x] T102 `packages/kernel/src/prompt.ts` inject SOUL in system prompt
- [x] T103 `packages/kernel/src/skills.ts` loadSkills + frontmatter parsing
- [x] T104 `home/agents/skills/` initial skills (`summarize.md`, `weather.md`, `reminder.md`, `skill-creator.md`)
- [x] T105 wire skills TOC + `load_skill` IPC tool
- [x] T100d-T100h agent prompts (builder, researcher, deployer, healer, evolver)
- [x] T100i gitSnapshotHook (audit critical fix)
- [x] T100j system prompt token budgeting (audit critical fix)

Checkpoint:

- [x] Kernel can list skills and dynamically load skill body at runtime.

## 3) Phase 006: Multi-Channel Messaging (Telegram First)

Source: `specs/006-channels/tasks.md`

Infrastructure:

- [x] T106a `tests/gateway/channels/manager.test.ts`
- [x] T106b `tests/gateway/channels/telegram.test.ts`
- [x] T106c `tests/gateway/channels/message-format.test.ts`
- [x] T106 `packages/gateway/src/channels/types.ts`
- [x] T107 `packages/gateway/src/channels/manager.ts`
- [x] T108 `packages/gateway/src/channels/format.ts`
- [x] T109 `packages/gateway/src/dispatcher.ts` channel-aware dispatch context
- [x] T110 prompt channel context + channel-routing knowledge

Adapters:

- [x] T111 Telegram adapter
- [x] T112 `home/system/config.json` channels section
- [ ] T113 WhatsApp adapter
- [ ] T114 WhatsApp QR flow endpoint
- [ ] T115 Discord adapter
- [ ] T116 Slack adapter

Integration:

- [x] T117 wire ChannelManager in gateway startup/shutdown + `/api/channels/status`
- [ ] T118 shell channel status indicators
- [x] T119 `home/agents/knowledge/channel-routing.md`

Checkpoint:

- [x] Telegram inbound/outbound works and appears in web shell conversation stream.

## 4) Phase 004: Concurrent Kernel Dispatch

Source: `specs/004-concurrent/tasks.md`. Deferred until after channels -- concurrent dispatch becomes useful when web shell + Telegram can send messages simultaneously.

Pre-requisite (serial queue -- must be done before 006):

- [x] T053a `tests/gateway/dispatcher-queue.test.ts`
- [x] T053 serial dispatch queue in `dispatcher.ts` (FIFO mutex, no parallelism)

Full concurrent dispatch (after 006):

- [x] T054a `tests/gateway/dispatcher-concurrent.test.ts`
- [x] T054 `packages/gateway/src/dispatcher.ts` concurrent dispatch + maxConcurrency option
- [x] T055 process registration in SQLite tasks table via dispatcher
- [x] T056 `packages/kernel/src/prompt.ts` conflict avoidance via active process context

Checkpoint:

- [x] "Build me a CRM" and "Make the theme darker" run in parallel without file conflicts.

## 5) Phase 007: Cron + Heartbeat

Source: `specs/007-proactive/tasks.md`

Cron:

- [x] T120a `tests/gateway/cron/service.test.ts`
- [x] T120b `tests/gateway/cron/store.test.ts`
- [x] T120 `packages/gateway/src/cron/service.ts`
- [x] T121 `packages/gateway/src/cron/store.ts`
- [x] T122 `packages/kernel/src/ipc-server.ts` manage_cron IPC tool
- [x] T123 `home/system/cron.json`

Heartbeat:

- [x] T120c `tests/gateway/heartbeat/runner.test.ts`
- [x] T124 `packages/gateway/src/heartbeat/runner.ts`
- [x] T125 `packages/gateway/src/heartbeat/prompt.ts`
- [x] T126 active-hours behavior in config + runtime logic
- [x] T127 route heartbeat outputs to channels

Integration:

- [x] T128 wire cron + heartbeat startup/shutdown + health status
- [x] T129 update default `home/agents/heartbeat.md`

Checkpoint:

- [x] Reminder created by kernel appears in cron store and is delivered by heartbeat cycle.

## 6) Phase 008A: Single-User Cloud Deployment

Source: `specs/008-cloud/tasks.md` (Part A)

- [x] T130 `Dockerfile` (multi-stage, Alpine, native addons)
- [x] T131 `docker-compose.yml` (volume, env, healthcheck)
- [x] T132 `scripts/matrixos.service` (systemd unit)
- [x] T133 `packages/gateway/src/auth.ts` (bearer token middleware, 8 tests)
- [x] T134 `scripts/setup-server.sh` (Node 22, pnpm, systemd)
- [x] T135 `packages/gateway/src/system-info.ts` + endpoint (5 tests)
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

- [x] T200a, T200b tests for logger (8 tests) and safe mode (5 tests)
- [x] T200 interaction logger (JSONL, daily rotation, truncation)
- [x] T201 logs query API (GET /api/logs with date/source filter)
- [x] T202 cost tracker (totalCost in logger + /api/system/info)
- [x] T203 logs directory template
- [x] T204 safe mode agent (sonnet, restricted tools, diagnostic prompt)
- [ ] T205 safe mode trigger + crash loop detection

P1 (next product-critical):

- [x] T210-T216 identity system complete (handle.json, loadHandle, profiles, prompt, endpoints, setup wizard).
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

## 11) Phase 012: Personalized Onboarding

Source: `specs/012-onboarding/tasks.md`

Tests:

- [x] T400a `tests/kernel/onboarding.test.ts` (parseSetupPlan)
- [x] T400b `tests/kernel/onboarding.test.ts` (getPersonaSuggestions)
- [x] T400c covered by `tests/gateway/provisioner.test.ts` (T404b)

Phase A (bootstrap):

- [x] T400 `home/system/bootstrap.md` rewrite (full onboarding flow)
- [x] T401 `home/system/user.md` role field

Phase B (persona engine):

- [x] T402 `packages/kernel/src/onboarding.ts` getPersonaSuggestions
- [x] T403 `packages/kernel/src/onboarding.ts` parseSetupPlan + writeSetupPlan

Phase C (provisioning):

- [x] T404 provisionFromPlan (T404a-T404i: batch dispatch, provisioner, task board, shell integration)
- [x] T405 IPC tools (get_persona_suggestions, write_setup_plan)
- [x] T406 wire onboarding progress into buildSystemPrompt

Phase D-G (stretch):

- [x] T407 skill templates (study-timer.md, budget-helper.md, enhanced reminder.md)
- [x] T408-T409 shell UX (role chips in SuggestionChips, task board in dock overlay)
- [ ] T410 parallel builds (needs T054)
- [x] T411-T412 welcome tour (role-specific first actions) + re-onboarding (setup-wizard.md skill)

Checkpoint:

- [ ] Fresh install triggers onboarding flow, builds persona-specific apps.

## 12) Phase 013: Linux Distro + Docker Deployment

Source: `specs/013-distro/tasks.md`

Phase A (Docker):

- [x] T500 Dockerfile (multi-stage build) -- shared with T130
- [x] T501 docker-compose.yml -- shared with T131
- [ ] T502 multi-arch build
- [ ] T503 container networking
- [ ] T504 idle/wake lifecycle
- [ ] T505 API key proxy + cost tracking
- [ ] T506 GitHub Actions CI

Phase B (Distro image):

- [ ] T510 systemd service files
- [ ] T511 Plymouth boot splash
- [ ] T512 mkosi configuration (x86)
- [ ] T513 rpi-image-gen (ARM64 Pi)
- [ ] T514 first-boot setup
- [ ] T515 UTM testing
- [ ] T516 USB live boot
- [ ] T517 OTA updates

Checkpoint:

- [ ] Docker image boots, distro image boots in UTM.

## 13) Cross-Cutting Security + Quality Checklist

- [x] Verify all filesystem read/write endpoints enforce home-path containment. (Fixed: /files/* uses resolveWithinHome(), commit 3919f3f.)
- [ ] Add auth + authorization boundaries for HTTP, WS, and channel entrypoints.
- [ ] Define and enforce realistic test/coverage thresholds aligned with actual scope.
- [ ] Add non-empty integration test suite and CI signal for `test:integration`.
- [ ] Add structured logging for kernel invocations, tool usage, and failures.
- [ ] Add crash-loop protection and rollback/safe-mode entry criteria.

## 14) Cross-Phase Dependencies

These tasks touch the same files and must be sequenced:

- **dispatcher.ts**: T109 (006 channel-aware dispatch) -> T054 (004 concurrent dispatch). Complete channel dispatch first, then add parallelism.
- **prompt.ts**: T110 (006 channel prompt context) -> T056 (004 conflict avoidance). Complete channel context injection first, then add process awareness.
- **config.json**: T112 (006 channels config) -> T126 (007 heartbeat active hours). Both add sections to the same config file.

## 15) Execution Order Checklist (No Timeline)

- [x] T053 serial dispatch queue (critical fix, before channels).
- [x] Complete Phase 005 fully (SOUL + skills + agent prompts + audit critical fixes T100i/T100j).
- [x] Complete Phase 006 Telegram path end-to-end (minimum one channel production-ready).
- [x] Complete Phase 004 concurrent dispatch (needed once channels + web shell both send messages).
- [x] Complete Phase 007 cron + heartbeat end-to-end.
- [x] Complete Phase 012 onboarding core (T404 provisioning + T407 skill templates). Stretch: T408, T411, T412.
- [x] Complete Phase 008A single-user cloud deploy (T130-T135). T136 docs remaining.
- [ ] Complete Phase 013A Docker deployment (T502-T506 remaining).
- [x] Complete Phase 009 P0 observability + safe-mode (T200-T204). T205 crash loop deferred.
- [ ] Complete Phase 009 P1 identity + sync + mobile.
- [ ] Start Phase 011 new computing (Living Software, Socratic, Intent-based -- incremental).
- [ ] Complete Phase 013B distro image (T510-T517).
- [ ] Start Phase 008B/009 P2 platform expansion.
- [ ] Finalize Phase 010 demo polish and recording.
