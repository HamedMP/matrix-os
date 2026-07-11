# Completion Audit: Coding Agent Shells

**Audited implementation head**: `f6322b3ab`
**Date**: 2026-07-11
**Scope**: Evidence review for the Matrix OS coding-agent desktop, mobile, browser, and gateway shell implementation checkpoint.

The audited stack is PR #911 at `653f0e465b069be1f3226a95d8fde40ec472c981`, PR #912 at `c8dae7439023691099258ff3d7a585279e0e6a38`, PR #913 at `443acc88002cd794a77881955aeecfc996e03b5e`, and PR #914 at implementation commit `f6322b3ab`. Each upper branch contains its current lower branch as an ancestor. It includes the earlier `87bc72d0fdd9067fcec395c479de80fcaccfe641` deployment checkpoint as an ancestor. Repository CI, Docker, and Host Bundle Release evidence below is tied to that earlier checkpoint; the open stacked PR evidence is listed separately and does not change what the earlier release evidence proves.

This audit records current evidence through the project-first mobile Conversation/Kanban stack, its remote-computer chooser, and the exact-version preview deployment. It does not mark the full rollout complete while interactive physical-device, physical-tablet, desktop, and broader cross-shell validation remain outstanding.

## Evidence Matrix

| Requirement | Evidence | Status |
| --- | --- | --- |
| Shared Matrix-native contracts for runtime summaries, providers, threads, events, approvals, terminal summaries, files, reviews, previews, source control, notifications, and safe errors | `packages/contracts/src/index.ts`; `tests/contracts/coding-agents.test.ts`; `current-state.md` Shared Contracts section | Implemented |
| Gateway runtime summary and read-only hydration source for shells | `packages/gateway/src/coding-agents/runtime-summary.ts`; `packages/gateway/src/coding-agents/routes.ts`; `tests/gateway/coding-agents-summary.test.ts` | Implemented |
| Provider registry and normalized server-side adapters | `packages/gateway/src/coding-agents/provider-registry.ts`; `packages/gateway/src/coding-agents/workspace-provider.ts`; `tests/gateway/coding-agents-workspace-provider.test.ts` | Implemented behind flags |
| Thread create, replay, stream, abort, approval, input lifecycle, and startup-stopped session reconciliation | `packages/gateway/src/coding-agents/thread-store.ts`; `packages/gateway/src/coding-agents/thread-stream.ts`; `packages/gateway/src/workspace-startup-recovery.ts`; `tests/gateway/coding-agents-threads.test.ts`; `tests/gateway/coding-agents-thread-stream.test.ts`; `tests/gateway/coding-agents-session-stop-reconciler.test.ts`; `tests/gateway/workspace-startup-recovery.test.ts`; `tests/gateway/agent-session-manager.test.ts` | Implemented |
| Cross-shell terminal binding through canonical Matrix terminal sessions | `current-state.md` Terminal Session Surfaces section; desktop/mobile workspace tests listed there | Implemented without a forked terminal model |
| Desktop coding-agent workspace and trusted main-process bridge | `desktop/src/main/coding-agents/runtime-summary-client.ts`; `desktop/src/renderer/src/features/coding-agents/AgentWorkspace.tsx`; `tests/desktop/coding-agent-workspace.test.tsx`; `tests/desktop/coding-agent-runtime-client.test.ts` | Implemented |
| Mobile SDK 57 coding-agent workspace and phone-first routes | `apps/mobile/app/agents/index.tsx`; `apps/mobile/app/agents/projects/[projectId]/index.tsx`; `apps/mobile/app/agents/projects/[projectId]/board.tsx`; `apps/mobile/app/agents/[threadId].tsx`; `apps/mobile/components/agents/agent-project-workspace-screen.tsx`; focused tests listed under Phase 22 in `acceptance-tests.md` | Implemented; physical-device gate pending |
| Browser shell remains Canvas-first and read-only for coding-agent state | `shell/src/components/workspace/WorkspaceApp.tsx`; `tests/shell/workspace-app.test.tsx`; browser section in `current-state.md` | Implemented |
| File, review, diff, preview, and source-control surfaces remain gateway-owned with bounded shell clients | Gateway route inventory plus desktop/mobile review tests listed in `current-state.md` | Implemented |
| Notifications and attention routing use safe owner-scoped payloads and preferences | `packages/gateway/src/coding-agents/attention-notifications.ts`; `packages/gateway/src/coding-agents/notification-preferences.ts`; related gateway, desktop, and mobile tests listed in `current-state.md` | Implemented |
| Redacted diagnostics for coding-agent gateway/runtime and mobile client failure paths | `packages/gateway/src/coding-agents/diagnostics.ts`; `apps/mobile/lib/coding-agent-diagnostics.ts`; `tests/gateway/coding-agents-diagnostics.test.ts`; `apps/mobile/__tests__/coding-agent-diagnostics.test.ts`; route/summary/thread-stream/thread-store/attention-notification/mobile gateway-client callers | Implemented |
| Desktop renderer does not receive raw bearer/provider credentials | Trusted IPC and main-process client inventory in `current-state.md`; desktop runtime client tests | Implemented by architecture and tests |
| Mobile persistent state stores only bounded UI references | `apps/mobile/lib/agent-workspace-state.ts`; `apps/mobile/lib/mobile-shell-state.ts`; mobile state tests listed in `current-state.md` | Implemented |
| Public and internal docs | `docs/dev/coding-agent-shells.md`; `www/content/docs/coding-agents.mdx`; `current-state.md` | Implemented and must stay synchronized |
| Runtime summary hydrates real canonical projects and bounded task/thread projections | `packages/gateway/src/coding-agents/project-summary.ts`; `packages/gateway/src/coding-agents/project-workspace.ts`; authenticated route wiring; `tests/gateway/coding-agents-project-summary.test.ts`; `tests/gateway/coding-agents-project-workspace.test.ts` | Implemented |
| One visible chat is one resumable thread and follow-up messages create turns in that same provider conversation | The bounded turn route/store/dispatcher persists idempotent accepted turns, server-only resume state, one-active-turn ownership, timeout/abort/restart release, fake-provider continuity, workspace-session resume, and production route/capability wiring. Phase 22.2 adds the mobile capability-gated same-thread client/composer with busy, offline, retry, reconnect, foreground, and duplicate-submit coverage; desktop and real-process cross-shell smoke remain incomplete | **Partial** |
| One canonical task supports several independently selectable coding threads | The gateway project workspace projects several threads per task, separates project chats, validates new shell-created relations, supports one-time idempotent adoption of legacy unassigned threads, and publishes post-persistence projection events. Phase 22.1 and 22.3 mobile tests open both threads on one task with exact project/task/thread identity; desktop navigation and real cross-shell smoke remain incomplete | **Partial** |
| Desktop project/task/thread navigator with Conversation and Kanban modes | Current `AgentWorkspace.tsx` is a sectioned dashboard and existing Board is a separate surface | **Incomplete** |
| Mobile project-first task/thread navigation with Conversation and Kanban modes | Phase 22.1 adds gateway-validated project hydration, project/task/thread routes, multi-thread task groups, safe selected-reference persistence, and foreground/reconnect reconciliation. Phase 22.2 adds the capability-gated same-thread Conversation composer while retaining bounded replay/stream, approval/input, review, preview, and canonical terminal paths. Phase 22.3 adds a capability-gated Conversation/Kanban control, canonical visible task columns, phone/tablet layouts, bounded gateway aggregates, exact multi-thread routing, and cross-view identity preservation. Phase 22.4 consumes the canonical owner-scoped Matrix computer inventory through a credential-free native chooser. `MB-001` through `MB-011` have automated evidence in `acceptance-tests.md`; interactive physical-device evidence remains outstanding | **Partial** |
| Complete durable transcript pagination and provider-session discovery/import | Current snapshots/replay expose bounded event windows; no stable backward/forward transcript store or safe discovery/import contract exists | **Not implemented** |
| Explicit pending queue, steering/interrupt, and parent/child execution graph | Busy conflicts and abort exist, but queue editing/order, normalized steering, and durable child-run projections do not | **Not implemented** |
| Several role-labelled canonical terminals per project/task/thread/run | Canonical terminal handoff exists, but the coding workspace has no many-binding relation or bind/unbind lifecycle | **Not implemented** |
| Complete repository, review-comment, and attachment backend | Bounded files/diffs/commit/PR foundations exist; repository status/full Git operations, durable comments, and attachment objects remain incomplete | **Incomplete** |
| Durable attention inbox, runtime handoff, and collaboration roles | Safe notifications/attention summaries exist; paged acknowledgement, handoff saga, and owner/editor/viewer access do not | **Not implemented** |
| Canonical shared computer inventory and isolated end-to-end preview authority | Desktop/mobile candidate branches use incompatible inventory contracts; current preview platform/VPS lanes do not share isolated credentials, database, routing authority, and teardown lifecycle | **Not implemented** |
| Owner export/delete and personal/org/shared separation for complete workspace state | Current bounded personal thread projection has no V2 export/delete adapter or collaboration scope model | **Not implemented** |

The named evidence required to close these rows is in `acceptance-tests.md`. Existing checkpoint tests are regression evidence only and cannot be reused as proof of the clarified behavior unless they are extended to exercise the named fixture/cardinality.

## Specification Alignment Audit

The 2026-07-10 clarification package was checked before implementation:

- All 58 original Phase 18-23 acceptance-test IDs are referenced by that checkpoint checklist. The expanded acceptance catalog and its planned coverage are tracked separately in `full-workspace-coverage.md`.
- Every clarified functional requirement and buildable success criterion (`FR-006`, `FR-007`, `FR-020`, `FR-026` through `FR-029`, `FR-062`, `FR-066`, `FR-067`, `FR-070`, `FR-075` through `FR-077`, and `SC-011` through `SC-014`) appears in the acceptance requirement-coverage matrix.
- Relative Markdown links in the spec package resolve.
- The project/task/thread cardinality, same-thread turn behavior, canonical task-status rule, and Conversation/Kanban terminology agree across `SPEC.md`, `ARCHITECTURE.md`, `plan.md`, `tasks.md`, and `acceptance-tests.md`.
- Gate 0 passed on 2026-07-10 after explicit product-owner confirmation. These checks prove specification alignment only; implementation evidence remains tracked separately below.

The proposed Full Workspace expansion is not covered by that earlier Gate 0.
Its requirement/task/test mapping is in `full-workspace-coverage.md` and remains
planned until product-owner Gate B0 confirmation. No existing checkpoint, open
shell PR, or preview environment closes a V2 row without the named current-head
evidence.

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

The real-runtime smoke helper checkpoint in PR #879 added repeatable read-only deployed-runtime validation:

- `pnpm exec vitest run tests/scripts/coding-agent-real-runtime-smoke.test.ts`
- `git diff --check`
- sanitized forbidden-reference scan over the touched script, tests, and docs
- `bun run check:patterns`
- `bun run typecheck`

That helper validates authenticated deployed-runtime `summary`, `threads`, `reviews`, and `notification-preferences` responses through bounded schemas, preserves `/vm/<handle>` base paths, rejects token CLI arguments, redacts bearer material, caps response bodies, and prints no raw response bodies. The stacked assertion slice keeps the helper read-only while adding optional checks for required capabilities, ready providers, minimum active thread/terminal/preview/review counts, review pagination, and an existing thread snapshot. It is not evidence that a human has completed the desktop or mobile visual smoke on a deployed runtime.

The Phase 22 mobile implementation is split into ready-for-review stacked PRs with exact-head review evidence:

- PR #911, `653f0e465b069be1f3226a95d8fde40ec472c981`, implements project-first routes, bounded safe-reference persistence, hydration, and stale-reference reconciliation. Review follow-up now resolves a valid routed project through its authoritative workspace even when it is beyond the first summary page, exposes all three bounded pagination cursors, and gates every create affordance on `codingAgentsThreadCreate`. The focused screen/client run passed 65 tests; mobile lint and TypeScript passed. The six addressed review threads are resolved, every exact-head check passed, and Greptile reported 5/5.
- PR #912, `c8dae7439023691099258ff3d7a585279e0e6a38`, implements the capability-gated same-thread turn composer, retry/idempotency/offline recovery, and project-aware new-chat creation. Review follow-up parses the route's actual `{ error: CreateAgentTurnError }` envelope, resolves composer project context beyond the first summary page, and scopes generated request counters to each composer instance. Focused project/composer/client coverage, mobile lint, and mobile TypeScript passed. The four addressed review threads are resolved, every exact-head check passed, and Greptile reported 5/5.
- PR #913, `443acc88002cd794a77881955aeecfc996e03b5e`, implements Conversation/Kanban routing, canonical task columns, bounded aggregates, multi-thread routing, tablet-width rendering, and cross-view identity continuity. Review follow-up explicitly seeds the normal project route as Conversation so persisted Kanban state cannot reopen on that URL. Four focused suites passed 89 tests; mobile lint and TypeScript passed. The four addressed review threads are resolved, the current check set passed, and Greptile reported 5/5.
- PR #914 through reviewed implementation head `bf7e174ced0cc9664831394a6aac3a0cbd6d4404` adds the authenticated computer projection and native chooser needed to test the stack on the disposable preview computer and contains the exact lower stack as ancestors. It also removes the native portrait lock so the required phone/tablet landscape layouts can be exercised. The canonical-origin mobile run passed 42 suites / 422 tests; mobile lint and TypeScript passed. Every check passed, all review threads are resolved, and Greptile reviewed that exact implementation head at 5/5.

Deployment evidence for the exact top stack head is deliberately non-production:

- Preview VPS workflow run `29126211996` built and deployed `v2026.07.10-pr914-00909cc-r29126211996` to `pr-914`.
- Exact reviewed-head workflow run `29131576445` built, published, and deployed `v2026.07.10-pr914-bf7e174-r29131576445` to `pr-914`.
- Platform Cloud Run run `29128264329` built and smoke-tested zero-traffic candidate revision `matrix-platform-00296-man` from `00909ccf8431`; the promote and promoted-traffic verification steps were skipped.
- The local physical-phone build intentionally overrides only the computer-list origin to that zero-traffic candidate. The override is not committed or included in any PR.
- The Expo SDK 57 dev client is installed on the paired physical iPhone 14 Pro, Metro bundled the exact top stack successfully, and the computer chooser route was opened. User confirmation of the rendered list, runtime switch, and subsequent project/task/thread walkthrough is still pending and is not inferred from deployment success.
- The orientation fix was built and signed for the physical iPhone with zero errors, installed directly through CoreDevice, and launched with the `matrixos://computers` payload. The built app's `Info.plist` contains portrait plus both landscape orientations for iPhone and iPad. Direct rotated-layout inspection remains user-confirmed evidence because the physical device does not expose CoreDevice remote-orientation control.
- A read-only physical app-container audit found exactly the two expected React Native AsyncStorage records. Both decoded records passed the production contract schemas and strict allowlisted object shapes, with zero forbidden transcript/event/output/file/diff/approval/credential/token/provider/resume key-name matches. Values were not added to the evidence log, and the temporary manifest copy was deleted immediately after inspection.

## Remaining Validation

- Run the Manual Desktop Real-Runtime Smoke checklist in `docs/dev/coding-agent-shells.md` against a real Matrix computer for runtime switch, native menu entry points, review/file/preview paths, notification click-through, non-stub provider setup, and cross-shell terminal binding. The automated desktop operator smoke now covers sign-in, project board, terminal attach, current Agents workspace create, command-palette Agents entry, Terminal, Apps, Settings, Chat, and hosted-shell detach through the stub gateway.
- On the physical phone, confirm the owner-scoped chooser lists and switches to the preview computer, then verify project selection, project chats, a task with two independently selectable chats, same-thread steering, Conversation/Kanban identity continuity, terminal handoff, review/file/diff/preview paths, approvals/input, keyboard and safe areas, portrait/landscape, foreground/background, offline/reconnect, auth continuity, and persisted safe references.
- Run the tablet-width interaction checklist on physical tablet hardware. Automated width coverage exists for the wrapped board, but it is not a substitute for the required physical-device layout, orientation, keyboard, and overlap checks.
- Keep `docs/dev/coding-agent-shells.md`, `www/content/docs/coding-agents.mdx`, and this audit synchronized when provider/runtime behavior changes.

## Security Notes

- New shell routes and clients use shared Zod 4 contracts at the boundary.
- Mutating gateway routes use body limits, validation, ownership checks, and safe error mapping.
- WebSocket thread streams authenticate before success, validate frames, cap subscribers, and clean up stale streams.
- Gateway coding-agent diagnostics are bounded and redacted before logging paths, tokens, URLs, private hosts, database details, or provider/runtime failure text.
- Mobile gateway-client diagnostics are bounded and redacted before logging paths, tokens, URLs, private hosts, database details, raw response bodies, or gateway/runtime failure text.
- No new embedded database persistence was added.
- Gateway/runtime remains the source of truth; desktop, mobile, and browser shells are resumable clients.
