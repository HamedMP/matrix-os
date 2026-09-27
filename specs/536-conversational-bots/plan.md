# Implementation Plan: Conversational Recipe Bots

**Branch**: `codex/535-conversational-bots` (spec `536-conversational-bots`; run Spec Kit scripts with `SPECIFY_FEATURE=536-conversational-bots`) | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/536-conversational-bots/spec.md`, with [technical-design.md](technical-design.md), [spike-plan.md](spike-plan.md), and [recipe-coverage.md](recipe-coverage.md).

## Summary

Selecting a recipe creates a durable, named rabbit bot with a direct chat and a private workspace. The bot sets itself up through conversation, asks for integrations progressively under per-bot grants, remembers scoped preferences, and runs tool-using work on Pi (`pi-agent-core`/`pi-ai` 0.86.1). That work runs inside a new no-network scope-runtime bot profile, where all model, tool, memory, and artifact access goes through the gateway broker. Funded Matrix AI priority is enforced at the platform reservation point. Later milestones add routines (M2), group collaboration (M3), computer use (M4), and messaging-channel hosting (M5). Delivery is a GitHub native PR stack, one layer per phase below. Each milestone's layers merge only after the matching spike-stage evidence is recorded.

## Technical Context

**Language/Version**: TypeScript 5.9 strict, ES modules, Node.js 24 (Pi requires ≥22.19)
**Primary Dependencies**:
- New:
  - `@earendil-works/pi-agent-core@0.86.1` and `@earendil-works/pi-ai@0.86.1`, exact, with overrides for `chord` and `pi-telemetry` 0.86.1
  - `typebox` 1.3.27 (transitive)
  - Playwright Chromium in the M4 computer service only
- Existing:
  - Hono, Zod 4 (`zod/v4`), Kysely/Postgres, undici (gateway)
  - scope-runtime supervisor and broker
  - the integrations platform proxy
  - canonical Chat and Provider V3

**Storage**:
- Owner Postgres through versioned `bot_schema_migrations` (tables in [data-model.md](data-model.md))
- Bot definition files through the existing `agent-store.ts`
- Bot workspaces at `~/bots/<botId>/`
- Platform Postgres: the `request_class` column and `ai_funded_priority_claims`

**Testing**:
- Vitest; in-process `kysely-pglite` for unit tests, with `*-postgres.test.ts` gated on `MATRIX_TEST_POSTGRES_URL`
- Fake pi-ai provider for bot-runtime tests
- Fake systemd command runner for scope-runtime tests
- Live evidence on a disposable VPS and a platform preview, per [spike-plan.md](spike-plan.md)

**Target Platform**: Customer VPS (Ubuntu 24.04, systemd, VPS-native host bundles) and the platform service with the funded relay (Cloud Run)
**Project Type**: Monorepo: contracts, platform, gateway, scope-runtime, a new `packages/bot-runtime`, a new `packages/computer-service` (M4), shared UI, shell, desktop, and mobile
**Performance Goals**:
- Instantiation p95 under 1.5 s from request to `bot.created`, excluding the model.
- First bot question streamed within 5 s of chat open on the managed route.
- Broker overhead p95 under 50 ms per tool dispatch, excluding the provider.

**Constraints**:
- Kernel and bot system prompt under 7K tokens.
- Workload `MemoryMax` 1 GiB and `RuntimeMaxSec` 900.
- The broker's existing 256 KiB request and 512 KiB response caps.
- Every external call has an `AbortSignal` timeout (API 10 s, inference 30 s, downloads 30 s).
- No network from workloads.
- Pinned versions only.

**Scale/Scope**:
- 100 bots and 2 concurrent bot workers per owner.
- 32 pending interactions and 2,000 memory items per bot.
- 8 bots per group (M3).
- One graphical session per owner (M4) until measured.
- Eight launch-set recipes validated for M1.

## Constitution Check

*GATE: must pass before Phase 0 research, and again after Phase 1 design.*

| Principle | Status | Evidence |
|---|---|---|
| I. Data belongs to its owner | Pass | Bot definitions and workspaces are owner files. Runtime state is in owner Postgres (Kysely). Memory, grants, and routines are exportable (FR-011). No SQLite or JSONL source of truth. |
| II. AI is the kernel, model-agnostic | Pass, with a noted deviation | Bots resolve access sources through Provider V3 and use multi-provider pi-ai. They do not use the Claude Agent SDK kernel; justified in Complexity Tracking. |
| III. Headless core, multi-shell | Pass | Services and routes are headless in the gateway. Shared UI lives in `packages/ui` with a contracts view model. Web Canvas, Web Desktop, Electron Desktop, and Web Mobile/Native Mobile parity is qualified per milestone (FR-014). |
| IV. Self-healing | Pass | Reconciliation of creation operations, checkpoints, connect requests, and expired leases runs at startup and periodically. |
| V. Quality over shortcuts | Pass | No truncation of recipe skills beyond the existing caps. Blocked states are truthful. |
| VII. Multi-tenancy | Pass | Every owner row is keyed by `owner_id`. Group access (M3) goes through collaboration authority and guest AI permission (spec 535). |
| VIII. Defense in depth | Pass | Auth matrix in [contracts/bots-http-api.md](contracts/bots-http-api.md). `bodyLimit` on all mutations, Zod at every boundary, typed error mapper, no-network workloads, broker-only credentials, pinned-DNS egress (M4), bounded registries, and fenced leases. |
| IX. TDD | Pass | Every task list item starts with failing tests. Target 99-100% coverage for new gateway, scope-runtime, and bot-runtime logic. |
| X. Worktree, PR, Greptile 5/5 | Pass | Each layer is its own manual worktree and PR in a GitHub stack. Greptile 5/5 is required on the current head of every layer before merge. |
| Documentation-driven | Pass | Separate `FinnaAI/matrix-os-site` `content/docs/` PR per milestone. |

Post-design re-check: pass. The design adds no alternative database or ORM. It uses `globalThis` nowhere, and there are no unbounded Maps or Sets: registries, queues, and caches all have caps and TTLs listed in [technical-design.md](technical-design.md#resource-limits-and-failure-modes).

## Project Structure

### Documentation (this feature)

```text
specs/536-conversational-bots/
├── spec.md, technical-design.md, spike-plan.md, recipe-coverage.md
├── plan.md                 # this file
├── research.md             # Phase 0
├── data-model.md           # Phase 1
├── quickstart.md           # Phase 1
├── contracts/
│   ├── bots-http-api.md
│   ├── bot-broker-protocol.md
│   ├── funded-priority.md
│   └── chat-events.md
├── checklists/requirements.md
└── tasks.md                # Phase 2 (/speckit.tasks)
```

### Source Code (repository root)

```text
packages/contracts/src/bots/           # bot, interaction, grant, memory, task, authority, broker schemas
packages/contracts/src/{canonical-chat-primitives,canonical-chat-api,chat-agent-context,funded-ai}.ts   # additive changes
packages/platform/src/                 # funded class + priority claims (repository, routes, migration)
packages/bot-runtime/                  # NEW: Pi loop wrapper, broker transport, tool proxy, event projection, session codec
packages/scope-runtime/src/            # bot profile, multi-profile supervisor, bot_agent worker entry, ~/bots root
packages/gateway/src/bots/             # NEW: migrations, repositories, instantiation, workspace, admission, registry,
                                       #      broker capabilities, interactions, grants, connect, memory, authority,
                                       #      routines (M2), participants/handoffs (M3), computer client (M4)
packages/gateway/src/scope-runtime-host/  # NEW: broker + supervisor client composition shared by shared-AI and bots
packages/gateway/src/funded-ai/        # local funded queue; credential manager per class
packages/computer-service/             # NEW (M4): display, Chromium, egress proxy, leases
packages/ui/src/chat-agents/           # bot cards, interaction cards, authority panel, remembered part
shell/src/components/ChatApp.tsx       # Web Canvas + Web Desktop wiring
desktop/src/renderer/src/...           # Electron Desktop wiring
apps/mobile/lib/                       # Native Mobile transcript projection
distro/customer-vps/                   # bot-runtime bundle mount, matrix-computer.service (M4)
tests/{contracts,platform,gateway,scope-runtime,bot-runtime,ui,shell,desktop}/bots...
```

**Structure decision**: Extend existing packages along their current ownership lines. Add `packages/bot-runtime`, a worker bundle mounted into the sandbox, and `packages/computer-service` (M4) as new packages, because both run in separate processes with separate dependency surfaces. A new gateway directory, `packages/gateway/src/bots/`, keeps files under 500 lines each. Modified files that are already large, such as `server.ts`, `shared-ai-runtime.ts`, and `ai-funded-metering-repository.ts`, get extraction first rather than new behavior. In particular, the `ScopeRuntimeHost` extraction precedes any bot wiring.

## Delivery Stack (GitHub native stacked PRs)

The stack is managed with `gh stack` (research R15).

- **Bottom layer**: PR #1940 (spec, plan, and tasks), targeting `main`.
- **Adding layers**: each layer is created from the previous one with `gh stack add` inside its own manual worktree. Layers are submitted with `gh stack submit` and kept current with `gh stack sync` or `gh stack rebase`.
- **Merging**:
  - Merge bottom-up only, when a layer's base is `main`.
  - Never delete branches while upper layers are open, and never loop merges.
  - Each layer merges only with Greptile 5/5 on its current head.
- **Milestone merge gate**: a milestone's layers can be built and reviewed before its spike stage completes, but they merge only after that stage's evidence is recorded in the spike report.
- **Size limit**: every layer stays under 3,000 additions and 50 files.

| Layer | Content | Milestone / gate | Est. additions |
|---|---|---|---:|
| L0 | Spec, research, design, contracts, plan, tasks (PR #1940) | Docs | 1,500 |
| L1 | Contracts: bot schemas, `bot_workspace` root kind, `matrix_bot` driver kind, event additions, funded class schemas | M1 / S0 | 1,500 |
| L2 | Platform: `request_class`, priority claims in `authorize`, cleanup, migration revision | M1 (funded) / Spike B | 1,300 |
| L3 | Gateway: per-class funded leases, caller classification, local funded queue | M1 (funded) / Spike B | 1,300 |
| L4 | `packages/bot-runtime`: Pi wrapper, broker fetch transport, tool proxy, event projection, session codec, compaction; S0 probe script | M1 / S0 | 2,000 |
| L5 | Scope runtime: bot profile, multi-profile supervisor, `bot_agent` worker, `~/bots` root, bundle packaging, digest pins | M1 / S0 | 2,200 |
| L6 | Gateway bot state: versioned migrations and repositories for all M1 tables | M1 / Spike A | 2,600 |
| L7 | Gateway `ScopeRuntimeHost` extraction, `BotRuntimeRegistry`, bot broker actions, `bot_workspace` resolver, private admission | M1 / Spike A | 2,600 |
| L8 | Gateway instantiation route, `matrix_bot` canonical adapter, task orchestration, checkpoints, recover/detach, reconciliation | M1 / Spike A | 2,800 |
| L9 | Gateway interactions, integration grants, connect correlation, approvals, memory, authority route | M1 / Spike A | 2,800 |
| L10 | Shared UI and Web Canvas/Web Desktop wiring: recipe → bot, interaction cards, authority panel, remembered part | M1 / Spike A | 2,500 |
| L11 | Electron Desktop, Web Mobile, and Native Mobile wiring | M1 / surface parity | 2,000 |
| L12 | Routines: tables, durable scheduler, conversational activation, pause/resume | M2 / Spike A wakeup | 2,000 |
| L13 | Groups part 1: participants, collaboration admission, mention routing, coordinator, group authority subset | M3 / Spike B | 2,400 |
| L14 | Groups part 2: handoffs, task workspaces, budgets, cancellation cascade, attribution UI | M3 / Spike B | 2,400 |
| L15 | Computer service package, systemd unit, installer oneshot, pinned-DNS egress proxy | M4 / Spike C | 2,500 |
| L16 | Gateway computer actions, leases and fencing, WebSocket stream, takeover UI, capacity gate | M4 / Spike C | 2,500 |
| L17 | Channel hosting of bot conversations (Telegram first) with exact-proposal approvals | M5 | 1,800 |
| L18 | `/update-docs` sync of repo docs (`docs/dev/coding-agent-shells.md`, bot runtime doc, AGENTS.md notes) | All | 800 |

The site documentation is a separate PR in `FinnaAI/matrix-os-site` per milestone, outside this stack.

## Surface matrix (target per milestone)

| Surface | M1 | M2 | M3 | M4 | M5 |
|---|---|---|---|---|---|
| Web Canvas | L10 | L12 | L13-14 | L16 | N/A (channel) |
| Web Desktop | L10 | L12 | L13-14 | L16 | N/A |
| Electron Desktop | L11 | L12 | L13-14 | L16 | N/A |
| Web Mobile | L11 | L12 | L13-14 | View and takeover only (L16) | N/A |
| Native Mobile | L11 | L12 | L13-14 | View only; takeover recorded as a platform limitation | N/A |

## Complexity Tracking

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Bots run on Pi, not the Claude Agent SDK kernel | The managed default model is not an Anthropic model; checkpoints need a loop Matrix owns; Provider V3 must offer several providers | The Claude SDK serves Anthropic models only and owns its loop |
| Second scope-runtime profile | Tool-using, multi-minute runs need tools through the broker and a longer lifetime | Changing `scope-runtime-chat-v1` changes its digest and invalidates shared-chat eligibility and queued turns |
| New driver kind `matrix_bot` | The canonical registry allows one adapter per driver kind, and `pi` belongs to the coding adapter | Reusing `pi` collides; relabeling was rejected by the spec |
| Platform schema change for funded priority | Owner-wide priority needs one authority at the reservation point | A gateway-only queue cannot order other runtimes or processes that call the relay directly |
| GitHub native stacks instead of Graphite (AGENTS.md default) | The owner explicitly requested GitHub stacked PRs for this feature | Graphite remains the repository default; the bottom-up merge safety rules are kept |
| 19-layer stack | The PR size limit (3,000 additions, 50 files) and milestone gates | Fewer layers would exceed limits or mix gated milestones |
