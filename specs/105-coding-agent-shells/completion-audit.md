# Completion Audit: Coding Agent Shells

**Audited commit**: `87ce9e8cc2a6357a122ea0fd9120487702ea9323`
**Date**: 2026-07-08
**Scope**: Evidence review for the Matrix OS coding-agent desktop, mobile, browser, and gateway shell implementation checkpoint.

This audit records current evidence. It does not mark the full rollout complete while release workflows, device smoke, and broader cross-shell validation remain outstanding.

## Evidence Matrix

| Requirement | Evidence | Status |
| --- | --- | --- |
| Shared Matrix-native contracts for runtime summaries, providers, threads, events, approvals, terminal summaries, files, reviews, previews, source control, notifications, and safe errors | `packages/contracts/src/index.ts`; `tests/contracts/coding-agents.test.ts`; `current-state.md` Shared Contracts section | Implemented |
| Gateway runtime summary and read-only hydration source for shells | `packages/gateway/src/coding-agents/runtime-summary.ts`; `packages/gateway/src/coding-agents/routes.ts`; `tests/gateway/coding-agents-summary.test.ts` | Implemented |
| Provider registry and normalized server-side adapters | `packages/gateway/src/coding-agents/provider-registry.ts`; `packages/gateway/src/coding-agents/workspace-provider.ts`; `tests/gateway/coding-agents-workspace-provider.test.ts` | Implemented behind flags |
| Thread create, replay, stream, abort, approval, and input lifecycle | `packages/gateway/src/coding-agents/thread-store.ts`; `packages/gateway/src/coding-agents/thread-stream.ts`; `tests/gateway/coding-agents-threads.test.ts`; `tests/gateway/coding-agents-thread-stream.test.ts` | Implemented |
| Cross-shell terminal binding through canonical Matrix terminal sessions | `current-state.md` Terminal Session Surfaces section; desktop/mobile workspace tests listed there | Implemented without a forked terminal model |
| Desktop coding-agent workspace and trusted main-process bridge | `desktop/src/main/coding-agents/runtime-summary-client.ts`; `desktop/src/renderer/src/features/coding-agents/AgentWorkspace.tsx`; `tests/desktop/coding-agent-workspace.test.tsx`; `tests/desktop/coding-agent-runtime-client.test.ts` | Implemented |
| Mobile SDK 57 coding-agent workspace and phone-first routes | `apps/mobile/app/agents/index.tsx`; `apps/mobile/app/agents/[threadId].tsx`; `apps/mobile/components/AgentComposerScreen.tsx`; mobile tests listed in `current-state.md` | Implemented |
| Browser shell remains Canvas-first and read-only for coding-agent state | `shell/src/components/workspace/WorkspaceApp.tsx`; `tests/shell/workspace-app.test.tsx`; browser section in `current-state.md` | Implemented |
| File, review, diff, preview, and source-control surfaces remain gateway-owned with bounded shell clients | Gateway route inventory plus desktop/mobile review tests listed in `current-state.md` | Implemented |
| Notifications and attention routing use safe owner-scoped payloads and preferences | `packages/gateway/src/coding-agents/attention-notifications.ts`; `packages/gateway/src/coding-agents/notification-preferences.ts`; related gateway, desktop, and mobile tests listed in `current-state.md` | Implemented |
| Desktop renderer does not receive raw bearer/provider credentials | Trusted IPC and main-process client inventory in `current-state.md`; desktop runtime client tests | Implemented by architecture and tests |
| Mobile persistent state stores only bounded UI references | `apps/mobile/lib/agent-workspace-state.ts`; `apps/mobile/lib/mobile-shell-state.ts`; mobile state tests listed in `current-state.md` | Implemented |
| Public and internal docs | `docs/dev/coding-agent-shells.md`; `www/content/docs/coding-agents.mdx`; `current-state.md` | Implemented and must stay synchronized |

## Validation Evidence

GitHub CI for `87ce9e8cc2a6357a122ea0fd9120487702ea9323` completed successfully:

- Pattern Scan
- React Doctor
- Type Check
- Shell Production Build
- Sync Client Package
- Unit Tests shards 1/4, 2/4, 3/4, and 4/4
- E2E Tests
- CI Results

Platform Cloud Run completed successfully for the same commit.

Host Bundle Release was still in progress and Docker Tests were still queued when this audit PR was prepared. Treat those as release-readiness gates that still need live workflow evidence.

## Remaining Validation

- Run manual desktop smoke for sign-in, runtime switch, settings, menu/palette entry points, terminal attach, review/file/preview paths, and notification click-through.
- Run manual mobile SDK 57 device smoke for chat, mission control, terminal, apps, agents workspace, thread detail, review/file/preview paths, approvals/input, notification tap routing, offline/reconnect state, and persisted safe references.
- Confirm Host Bundle Release and Docker Tests complete for the checkpoint commit before broad rollout.
- If runtime managers add autonomous process-exit detection beyond explicit workspace `session.stopped` events, route those events through the existing completion reconciliation path.
- Keep `docs/dev/coding-agent-shells.md`, `www/content/docs/coding-agents.mdx`, and this audit synchronized when provider/runtime behavior changes.

## Security Notes

- New shell routes and clients use shared Zod 4 contracts at the boundary.
- Mutating gateway routes use body limits, validation, ownership checks, and safe error mapping.
- WebSocket thread streams authenticate before success, validate frames, cap subscribers, and clean up stale streams.
- No new embedded database persistence was added.
- Gateway/runtime remains the source of truth; desktop, mobile, and browser shells are resumable clients.
