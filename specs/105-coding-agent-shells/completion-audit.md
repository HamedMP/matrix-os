# Completion Audit: Coding Agent Shells

**Audited commit**: `056b3da668ed6d1753712120316d2d5accfafdcf`
**Date**: 2026-07-10
**Scope**: Evidence review for the Matrix OS coding-agent desktop, mobile, browser, and gateway shell implementation checkpoint.

The audited commit includes the earlier `87bc72d0fdd9067fcec395c479de80fcaccfe641` deployment checkpoint as an ancestor. Repository CI, Docker, and Host Bundle Release evidence below is tied to that deployment checkpoint; later descendant PRs through audited commit `056b3da668` add the separately listed desktop/mobile smoke coverage and do not change what the earlier release evidence proves.

This audit records current evidence through the desktop operator palette smoke and mobile terminal handoff checkpoint. It does not mark the full rollout complete while real-device smoke and broader cross-shell validation remain outstanding. The 2026-07-10 product clarification also adds project-first navigation, same-thread turns, multi-thread tasks, and Conversation/Kanban views to the completion bar; those requirements are explicitly incomplete below.

## Evidence Matrix

| Requirement | Evidence | Status |
| --- | --- | --- |
| Shared Matrix-native contracts for runtime summaries, providers, threads, events, approvals, terminal summaries, files, reviews, previews, source control, notifications, and safe errors | `packages/contracts/src/index.ts`; `tests/contracts/coding-agents.test.ts`; `current-state.md` Shared Contracts section | Implemented |
| Gateway runtime summary and read-only hydration source for shells | `packages/gateway/src/coding-agents/runtime-summary.ts`; `packages/gateway/src/coding-agents/routes.ts`; `tests/gateway/coding-agents-summary.test.ts` | Implemented |
| Provider registry and normalized server-side adapters | `packages/gateway/src/coding-agents/provider-registry.ts`; `packages/gateway/src/coding-agents/workspace-provider.ts`; `tests/gateway/coding-agents-workspace-provider.test.ts` | Implemented behind flags |
| Thread create, replay, stream, abort, approval, input lifecycle, and startup-stopped session reconciliation | `packages/gateway/src/coding-agents/thread-store.ts`; `packages/gateway/src/coding-agents/thread-stream.ts`; `packages/gateway/src/workspace-startup-recovery.ts`; `tests/gateway/coding-agents-threads.test.ts`; `tests/gateway/coding-agents-thread-stream.test.ts`; `tests/gateway/coding-agents-session-stop-reconciler.test.ts`; `tests/gateway/workspace-startup-recovery.test.ts`; `tests/gateway/agent-session-manager.test.ts` | Implemented |
| Cross-shell terminal binding through canonical Matrix terminal sessions | `current-state.md` Terminal Session Surfaces section; desktop/mobile workspace tests listed there | Implemented without a forked terminal model |
| Desktop coding-agent workspace and trusted main-process bridge | `desktop/src/main/coding-agents/runtime-summary-client.ts`; `desktop/src/renderer/src/features/coding-agents/AgentWorkspace.tsx`; `tests/desktop/coding-agent-workspace.test.tsx`; `tests/desktop/coding-agent-runtime-client.test.ts` | Implemented |
| Mobile SDK 57 coding-agent workspace and phone-first routes | `apps/mobile/app/agents/index.tsx`; `apps/mobile/app/agents/[threadId].tsx`; `apps/mobile/components/AgentComposerScreen.tsx`; mobile tests listed in `current-state.md` | Implemented |
| Browser shell remains Canvas-first and read-only for coding-agent state | `shell/src/components/workspace/WorkspaceApp.tsx`; `tests/shell/workspace-app.test.tsx`; browser section in `current-state.md` | Implemented |
| File, review, diff, preview, and source-control surfaces remain gateway-owned with bounded shell clients | Gateway route inventory plus desktop/mobile review tests listed in `current-state.md` | Implemented |
| Notifications and attention routing use safe owner-scoped payloads and preferences | `packages/gateway/src/coding-agents/attention-notifications.ts`; `packages/gateway/src/coding-agents/notification-preferences.ts`; related gateway, desktop, and mobile tests listed in `current-state.md` | Implemented |
| Redacted diagnostics for coding-agent gateway/runtime and mobile client failure paths | `packages/gateway/src/coding-agents/diagnostics.ts`; `apps/mobile/lib/coding-agent-diagnostics.ts`; `tests/gateway/coding-agents-diagnostics.test.ts`; `apps/mobile/__tests__/coding-agent-diagnostics.test.ts`; route/summary/thread-stream/thread-store/attention-notification/mobile gateway-client callers | Implemented |
| Desktop renderer does not receive raw bearer/provider credentials | Trusted IPC and main-process client inventory in `current-state.md`; desktop runtime client tests | Implemented by architecture and tests |
| Mobile persistent state stores only bounded UI references | `apps/mobile/lib/agent-workspace-state.ts`; `apps/mobile/lib/mobile-shell-state.ts`; mobile state tests listed in `current-state.md` | Implemented |
| Public and internal docs | `docs/dev/coding-agent-shells.md`; `www/content/docs/coding-agents.mdx`; `current-state.md` | Implemented and must stay synchronized |
| Runtime summary hydrates real canonical projects and bounded task/thread projections | Current `packages/gateway/src/coding-agents/runtime-summary.ts` returns an empty project list; no project workspace projection exists | **Incomplete** |
| One visible chat is one resumable thread and follow-up messages create turns in that same provider conversation | Current follow-up path creates a new referenced thread; no turn mutation/provider resume route exists | **Incomplete** |
| One canonical task supports several independently selectable coding threads | Thread records can carry `taskId`, but no relation adapter/multi-thread task projection exists and legacy task UI has a singular session link | **Incomplete** |
| Desktop project/task/thread navigator with Conversation and Kanban modes | Current `AgentWorkspace.tsx` is a sectioned dashboard and existing Board is a separate surface | **Incomplete** |
| Mobile project-first task/thread navigation with Conversation and Kanban modes | Current `/agents` stack has recent work/thread detail but no project Kanban hierarchy | **Incomplete** |

The named evidence required to close these rows is in `acceptance-tests.md`. Existing checkpoint tests are regression evidence only and cannot be reused as proof of the clarified behavior unless they are extended to exercise the named fixture/cardinality.

## Specification Alignment Audit

The 2026-07-10 clarification package was checked before implementation:

- All 58 acceptance-test IDs in `acceptance-tests.md` are referenced by the active Phase 18-23 checklist, with no missing or orphan IDs.
- Every clarified functional requirement and buildable success criterion (`FR-006`, `FR-007`, `FR-020`, `FR-026` through `FR-029`, `FR-062`, `FR-066`, `FR-067`, `FR-070`, `FR-075` through `FR-077`, and `SC-011` through `SC-014`) appears in the acceptance requirement-coverage matrix.
- Relative Markdown links in the spec package resolve.
- The project/task/thread cardinality, same-thread turn behavior, canonical task-status rule, and Conversation/Kanban terminology agree across `SPEC.md`, `ARCHITECTURE.md`, `plan.md`, `tasks.md`, and `acceptance-tests.md`.
- Gate 0 remains intentionally open pending explicit product-owner confirmation. These checks prove specification alignment only, not implementation.

## Validation Evidence

GitHub CI for `87bc72d0fdd9067fcec395c479de80fcaccfe641` completed successfully:

- Pattern Scan
- React Doctor
- Type Check
- Shell Production Build
- Sync Client Package
- Unit Tests shards 1/4, 2/4, 3/4, and 4/4
- E2E Tests
- CI Results

Docker Tests and Host Bundle Release completed successfully for the same commit. The Host Bundle Release built the bundle, published the release, and triggered the exact-version VPS deploy job.

Platform Cloud Run completed successfully for the browser Workspace implementation checkpoint commit `87ce9e8cc2a6357a122ea0fd9120487702ea9323`. The later `87bc72d0fdd9067fcec395c479de80fcaccfe641` checkpoint changed gateway/spec state and did not require a platform app-shell deploy.

Focused local validation on `87bc72d0fdd9067fcec395c479de80fcaccfe641` also passed:

- `pnpm exec vitest run tests/contracts/coding-agents.test.ts tests/gateway/coding-agents-summary.test.ts tests/gateway/coding-agents-threads.test.ts tests/gateway/coding-agents-thread-stream.test.ts tests/gateway/coding-agents-session-stop-reconciler.test.ts tests/gateway/agent-session-manager.test.ts tests/gateway/workspace-startup-recovery.test.ts`
- `pnpm exec vitest run tests/desktop/coding-agent-runtime-client.test.ts tests/desktop/coding-agent-thread-stream.test.ts tests/desktop/coding-agent-workspace.test.tsx tests/desktop/ipc-contract.test.ts`
- `pnpm --filter matrix-os-mobile exec jest __tests__/agents-screen.test.tsx __tests__/agent-thread-screen.test.tsx __tests__/agents-preview-screen.test.tsx __tests__/agent-workspace-state.test.ts __tests__/gateway-client.test.ts --runInBand`

The desktop operator smoke checkpoint in PR #866 added and passed focused PR validation:

- `bun run build:desktop`
- `pnpm --filter desktop run typecheck`
- `xvfb-run -a bun run test:e2e tests/e2e/desktop/operator.e2e.test.ts`

That automated desktop smoke covers the stubbed sign-in/device-auth flow, project board hydration, canonical terminal attach and echo, the current Agents workspace summary and create path, the Terminal Shells workspace, Apps, Settings, Chat, and hosted-shell detach behavior.

The mobile terminal handoff checkpoint in PR #868 added and passed focused PR validation:

- `pnpm --filter matrix-os-mobile exec jest __tests__/agent-thread-screen.test.tsx --runInBand`
- `pnpm --filter matrix-os-mobile exec jest __tests__/agents-screen.test.tsx __tests__/agent-thread-screen.test.tsx __tests__/agent-workspace-state.test.ts --runInBand`
- `pnpm --filter matrix-os-mobile exec tsc --noEmit`
- `pnpm --filter matrix-os-mobile run lint`
- `bun run check:patterns`

That mobile validation confirms a coding-agent thread detail handoff persists both the last active terminal session and the explicit terminal handoff reference without storing terminal output or transcript data.

The desktop palette and menu-entry checkpoint in PR #869 added and passed focused PR validation:

- `pnpm exec vitest run tests/desktop/menu-template.test.ts tests/desktop/shortcuts.test.ts`
- `pnpm exec vitest run tests/desktop/menu-template.test.ts tests/desktop/shortcuts.test.ts tests/desktop/command-palette.test.tsx`
- `bun run build:desktop`
- `pnpm --filter desktop run typecheck`
- `xvfb-run -a bun run test:e2e tests/e2e/desktop/operator.e2e.test.ts`
- `bun run check:patterns`

That automated desktop smoke now also covers opening the Agents workspace from the command palette after the terminal smoke path, and unit coverage confirms the native Agents menu accelerator matches the renderer shortcut.

## Remaining Validation

- Run manual desktop smoke against a real Matrix computer for runtime switch, native menu entry points, review/file/preview paths, notification click-through, non-stub provider setup, and cross-shell terminal binding. The automated desktop operator smoke now covers sign-in, project board, terminal attach, current Agents workspace create, command-palette Agents entry, Terminal, Apps, Settings, Chat, and hosted-shell detach through the stub gateway.
- Run manual mobile SDK 57 device smoke for chat, mission control, terminal, apps, agents workspace, thread detail, terminal handoff, review/file/preview paths, approvals/input, notification tap routing, offline/reconnect state, and persisted safe references.
- Keep `docs/dev/coding-agent-shells.md`, `www/content/docs/coding-agents.mdx`, and this audit synchronized when provider/runtime behavior changes.

## Security Notes

- New shell routes and clients use shared Zod 4 contracts at the boundary.
- Mutating gateway routes use body limits, validation, ownership checks, and safe error mapping.
- WebSocket thread streams authenticate before success, validate frames, cap subscribers, and clean up stale streams.
- Gateway coding-agent diagnostics are bounded and redacted before logging paths, tokens, URLs, private hosts, database details, or provider/runtime failure text.
- Mobile gateway-client diagnostics are bounded and redacted before logging paths, tokens, URLs, private hosts, database details, raw response bodies, or gateway/runtime failure text.
- No new embedded database persistence was added.
- Gateway/runtime remains the source of truth; desktop, mobile, and browser shells are resumable clients.
