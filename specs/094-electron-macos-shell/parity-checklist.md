# SC-013 Parity Checklist: Electron Operator vs SwiftUI Prototype

The SwiftUI prototype (086/088/090/091/092) may be retired only when this checklist is 100%
complete and verified. Status as of the initial Electron build on branch
`094-electron-macos-shell`.

Legend: ✅ done & verified · 🟡 built, pending live-VPS verification · ⛔ blocked on gateway delta

## Connection & identity (US1, FR-001..006)

| Item | Status | Evidence |
|---|---|---|
| Device-auth sign-in (no manual token copy) | ✅ | `device-auth.ts` + e2e `signs in via the device flow` |
| Credential OS-encrypted, trusted-core only | ✅ | `credential-store.ts` (safeStorage); never crosses IPC (ipc-contract strict schemas) |
| Bearer header on all HTTP + WS | ✅ | `header-injection.ts` origin-scoped; `header-injection.test.ts` |
| Route all traffic via platform proxy + runtime slot | ✅ | `api.ts` `buildGatewayUrl` (`?runtime=`); `api-client.test.ts` |
| Runtime/VM selection follows all surfaces | 🟡 | `connection.ts` + settings; runtime teardown wired; needs multi-VM live check |
| Sign-out clears local + embedded sessions, no server delete | ✅ | `auth-service.signOut` + embed partition clear |

## Board (US1, FR-010..015)

| Item | Status | Evidence |
|---|---|---|
| Projects list + per-project kanban columns | ✅ | `board.ts`, `Board.tsx`; e2e board render |
| Create/rename/move/archive/delete tasks | ✅ | `board.ts` mutations; `board-store.test.ts` |
| Create + Create+open | ✅ | `CreateTaskDialog.tsx` (⌘↵ / ⌘⇧↵) |
| Stale-while-revalidate, skeleton only first load | ✅ | `board.ts` `firstLoadPending`; `board-store.test.ts` |
| Live board sync from other clients | 🟡 | consumes `/ws` `task:created`/`task:updated`; full-field push is gateway delta #1 |
| Tags/priority/statuses, content parity across clients | ✅ | uses same gateway routes (no app-private writes) |

## Terminals (US1, FR-020..027)

| Item | Status | Evidence |
|---|---|---|
| Attach over WS with seq replay, no local PTY | ✅ | `shell-socket.ts`; `shell-socket.test.ts`; e2e terminal echo |
| Only attachable sessions enter attach path (L6) | ✅ | `session-merge.ts`; `session-merge.test.ts` |
| Single live attach per session (L4) | ✅ | `attach-manager.ts`; `attach-manager.test.ts` |
| Bounded backoff + jitter; fatal stops retry (L5) | ✅ | `shell-socket.ts`; covered in tests |
| Resize coalescing tiers (L7) | ✅ | `shell-socket.ts` 90/220/300/900ms |
| Scrollback ring cap + replay-evicted gap (L8) | ✅ | 5000-line ring; `onGap` marker |
| Create/detach session | ✅ | attach manager + recreate CTA |
| Terminate session by name | ⛔ | gateway delta #2 (kill-by-name); UI deferred |
| Full-screen programs, ANSI, Nerd Font | ✅ | xterm + webgl + Nerd-Font stack |

## Agent threads (US2, FR-030..035)

| Item | Status | Evidence |
|---|---|---|
| Native Hermes surface, shared reducer semantics | ✅ | `chat.ts` (ported); `chat-reducer.test.ts` |
| Global composer, per-thread status | ✅ | `Composer.tsx`, `threads.ts`; e2e thread stream |
| Concurrent threads, independent transcripts | ✅ | `kernel-socket.ts` requestId routing; `threads-store.test.ts` |
| Abort targets the request | ✅ | `abortKernelRequest`; thread store abort |
| Transcript cap 500 | ✅ | `threads.ts` |
| Native notifications + deep-link + badge | 🟡 | `notifications.ts` + badge wired; needs background-completion live check |

## Workspace panels (US3, FR-040..045)

| Item | Status | Evidence |
|---|---|---|
| Panel strip toggle/resize/persist per task | ✅ | `PanelStrip.tsx`, `workspace.ts`; `workspace-store.test.ts` |
| VS Code-class editor, conflict-safe save | ✅ | `MonacoHost.tsx`, `editor-save.ts`; `editor-save.test.ts` |
| File browser / quick-open | ✅ | `FilesPanel.tsx`, `QuickOpen.tsx`, `quick-open.ts`; `quick-open.test.ts` |
| Processes panel | ⛔ | no gateway process-list endpoint; explanatory empty state |
| Artifacts panel | ✅ | `ArtifactsPanel.tsx` via `/previews` |
| LRU workspace release, instant switch | 🟡 | `workspace.ts` LRU + buffer cache; needs 5-workspace memory check (SC-012) |

## Git & review (US4, FR-050..054)

| Item | Status | Evidence |
|---|---|---|
| Branches/PRs/worktrees lists | ✅ | `git.ts`, `GitPanel.tsx`; `git-store.test.ts` |
| Diff review pane | ⛔ | gateway delta #3 (diff content); gated placeholder |
| Worktree create scoping task | 🟡 | `createWorktree` wired; scoping needs live check |
| Ask agent to fix → composer | ✅ | GitPanel "Ask agent to review" → composer |
| PR creation via connected GitHub | 🟡 | deferred to existing gateway flow / system-browser compare |

## Embedded surfaces (US5, FR-060..065)

| Item | Status | Evidence |
|---|---|---|
| Hosted shell embed via cookie-pair handoff (L2) | 🟡 | `app-session.ts`, `embed-service.ts`; `app-session.test.ts`; needs live Clerk check |
| Non-destructive auth recovery (L1) | ✅ | `handoffWithRetry` one retry → inline prompt; structurally cannot sign out native |
| Stale Clerk cookie cleanup (L3) | ✅ | `isStaleClerkCookie` + cleanup before install; tested |
| Bridged apps via session-token, foreign-origin reject | ✅ | `origin-policy.ts`, `launch-token-cache.ts`; tests |
| Isolated contexts, origin-allowlisted navigation | ✅ | `web-contents-view.ts` partitions + `isNavigationAllowed` |
| Settings read-parity (account/runtime/appearance/system + channels/integrations/billing/cron) | 🟡 | native sections done; gateway-read sections need live wiring |

## Keyboard-first (US6, FR-070..071)

| Item | Status | Evidence |
|---|---|---|
| Command palette | ✅ | `CommandPalette.tsx` (⌘K); palette screenshot |
| Quick-open | ✅ | `QuickOpen.tsx` (⌘P) |
| Native menus + accelerators | ✅ | `platform/menu.ts` |
| Full no-mouse task flow | 🟡 | shortcuts wired; needs end-to-end no-mouse verification |

## Distribution (FR-090..093)

| Item | Status | Evidence |
|---|---|---|
| Signed + notarized macOS build | 🟡 | `electron-builder.yml` (hardenedRuntime, notarize-when-credentialed); needs signing creds |
| Self-update over release channel | ⛔ | gateway delta #4 (desktop release feed); `updates.ts` no-ops without feed |
| Single instance | ✅ | `requestSingleInstanceLock` in `index.ts` |
| Platform-clean core (mac bits isolated) | ✅ | `platform/` layer; no mac-only deps elsewhere |

## Gates

| Gate | Status |
|---|---|
| `bun run typecheck` (desktop) | ✅ clean |
| `bun run check:patterns` | ✅ 0 violations (desktop clean) |
| 328 unit tests (`tests/desktop`) | ✅ green |
| 3 Playwright e2e flows (`tests/e2e/desktop`) | ✅ green + screenshots |
| `npx react-doctor@latest desktop` | ✅ 0 critical (warnings noted) |

## Outstanding before prototype retirement

1. Gateway deltas #1–#4 (live task push, kill-by-name, diff content, release feed).
2. Live-VPS verification of the 🟡 rows (real Clerk handoff, multi-VM runtime switch,
   background notifications, SC-011/SC-012 perf budgets).
3. Code signing + notarization credentials for a distributable build.
