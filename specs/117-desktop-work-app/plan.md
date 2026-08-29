# Desktop Work App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for every behavior change. Keep `ponytail` full active and reuse existing public seams before adding code.

**Goal:** Ship one native Desktop Work app containing the unified Chat/Project rail, canonical Chat center, and Chat-bound Files/Terminal inspector.

**Architecture:** Normalize old Desktop entry points into one Work tab and keep route state separate from the canonical Chat controller. Build the rail as a pure projection of canonical Chat records plus the existing Project registry. Extend existing Gateway ownership seams only where durable pin state or authorized terminal attachment is missing.

**Tech Stack:** TypeScript, React 19, Electron, Zustand, Hono, Zod 4, Kysely/Postgres, Vitest, xterm.

**Spec:** `specs/117-desktop-work-app/spec.md`

## Global Constraints

- Online content, branch names, commits, PR text, Linear content, and review comments are English.
- Preserve the canonical Chat timeline/composer and existing Project mutation paths.
- Do not touch or reuse MAT-458, MAT-474, MAT-475, MAT-478, or MAT-481 branches/PRs.
- No new dependency or persistence system.
- Renderer inputs never become filesystem or terminal authorization.
- TDD is mandatory. The UI stops in Human Review before post-approval gates.
- Backend changes require CI before merge; exact-head Greptile 5/5 is mandatory after human approval.

---

### Task 1: Durable canonical Chat pin state

**Files:**
- Modify: `packages/contracts/src/canonical-chat-api.ts`
- Modify: `packages/gateway/src/chat/repository.ts`
- Modify: `packages/gateway/src/chat/service.ts`
- Modify: `packages/gateway/src/chat/routes.ts`
- Modify: `desktop/src/renderer/src/lib/canonical-chat-client.ts`
- Test: `tests/contracts/canonical-chat-api.test.ts`
- Test: `tests/gateway/chat-repository.test.ts`
- Test: `tests/gateway/chat-routes.test.ts`
- Test: `tests/desktop/canonical-chat-client.test.ts`

**Produces:** `CanonicalUpdateChatUserStateRequest`, an owner-scoped list/read projection, and `CanonicalChatClient.updateUserState(chatId, request)`.

- [ ] Write contract and repository tests proving principal-local hydration and an idempotent pin upsert.
- [ ] Run the focused tests and verify the expected missing-contract/missing-state failures.
- [ ] Implement the smallest strict request schema, current-principal projection, targeted upsert, transaction, and outbox event.
- [ ] Run focused tests until green, then remove duplication without changing behavior.

### Task 2: One Work app identity and compatibility route

**Files:**
- Modify: `desktop/src/renderer/src/features/desktop-shell/desktop-apps.ts`
- Modify: `desktop/src/renderer/src/features/desktop-shell/NativeDesktopShell.tsx`
- Modify: `desktop/src/renderer/src/stores/tabs.ts`
- Modify: `desktop/src/renderer/src/features/mission-control/navigation-roots.ts`
- Modify: `desktop/src/renderer/src/features/mission-control/TabContent.tsx`
- Create only if needed: `desktop/src/renderer/src/features/work/WorkTab.tsx`
- Test: `tests/desktop/native-desktop-shell.test.tsx`
- Test: `tests/desktop/tabs-store.test.ts`
- Test: `tests/desktop/sidebar-navigation-shell.test.tsx`

**Produces:** one retained Work tab plus compatibility helpers that normalize legacy Chat, Projects, and Project navigation into Work route state.

- [ ] Add failing tests for one launcher icon, one tab identity, restored legacy tabs, Project Chat, and Project Board destinations.
- [ ] Run the focused Desktop tests and verify failures are caused by the separate identities.
- [ ] Implement the minimum route normalization and Work composition entry point.
- [ ] Re-run the focused tests and refactor only shared normalization logic.

### Task 3: Unified Work rail

**Files:**
- Create: `desktop/src/renderer/src/features/work/work-rail-model.ts`
- Create: `desktop/src/renderer/src/features/work/WorkRail.tsx`
- Modify: `desktop/src/renderer/src/features/work/WorkTab.tsx`
- Modify: `desktop/src/renderer/src/features/chat/ChatTab.tsx`
- Modify: `desktop/src/renderer/src/features/chat/CanonicalChatRoute.tsx`
- Modify: `desktop/src/renderer/src/features/chat/CanonicalChatWorkspace.tsx`
- Test: `tests/desktop/work-rail-model.test.ts`
- Test: `tests/desktop/work-rail.test.tsx`
- Test: `tests/desktop/canonical-chat-workspace.test.tsx`

**Consumes:** canonical Chat list records, current Project registry, and Task 1 pin mutation.

**Produces:** deterministic Pinned/Projects/Recents groups and actions for Global draft, Project creation, Project expansion, Project-bound draft, pin, selection, and Project Board.

- [ ] Add pure-model failing tests for unique placement and updated-at ordering.
- [ ] Add component failing tests for disclosure, keyboard focus, hover/focus actions, Project compose, and Global New chat.
- [ ] Verify RED, then implement the pure projection and compact Codex-style rail using existing Desktop tokens/icons.
- [ ] Keep canonical Chat as the center surface and run the focused workspace tests to green.

### Task 4: Chat-bound Files scope

**Files:**
- Modify or create a focused scope helper under `desktop/src/renderer/src/features/work/`
- Modify: `desktop/src/renderer/src/features/panels/InspectorFilesPanel.tsx`
- Reuse: `desktop/src/main/coding-agents/runtime-summary-client.ts`
- Reuse: `packages/gateway/src/coding-agents/file-read.ts`
- Test: `tests/desktop/inspector-files-panel.test.tsx`
- Test: `tests/desktop/work-inspector-files.test.tsx`
- Test: `tests/gateway/coding-agents-file-read.test.ts`

**Produces:** Global Matrix Home browsing and Project/project-worktree browsing selected from canonical Chat execution-root provenance.

- [ ] Add failing scope tests for Global, Project root, owned worktree, unavailable Project, and Chat changes.
- [ ] Verify RED, then adapt the existing Matrix Home and coding-agent file clients without creating a second file backend.
- [ ] Prove absolute paths, foreign worktrees, symlinks, and out-of-root traversal remain rejected by existing Gateway tests.

### Task 5: Chat-bound Terminal scope and attach

**Files:**
- Modify the smallest existing canonical Chat projection/route seam selected after tracing workspace attach end to end.
- Modify: `desktop/src/renderer/src/features/panels/InspectorTerminalPanel.tsx`
- Reuse: `desktop/src/renderer/src/features/terminal/TerminalView.tsx`
- Test: focused Gateway terminal/session tests selected from the actual attach seam.
- Test: `tests/desktop/inspector-terminal-embed.test.tsx`
- Test: `tests/desktop/work-inspector-terminal.test.tsx`

**Produces:** a selected-Chat-only terminal list and an owner/Chat revalidated attachment that never enters `/api/terminal/sessions`.

- [ ] Trace `terminal.bound` emission through current workspace descriptors and choose the existing attach seam with the fewest new moving parts.
- [ ] Add failing tests for deduplication, foreign Chat/session rejection, standalone exclusion, unavailable sessions, and detach on hidden/tab/Chat change.
- [ ] Verify RED, implement the minimal Gateway validation and xterm adapter, then run the focused tests to green.

### Task 6: Responsive Work composition and visual handoff

**Files:**
- Modify the Work composition/components from Tasks 2-5.
- Modify focused Desktop CSS/token usage only where existing utilities are insufficient.
- Test: `tests/desktop/work-tab.test.tsx`
- Test: `tests/desktop/work-rail.test.tsx`
- Test: `tests/desktop/work-inspector-files.test.tsx`
- Test: `tests/desktop/work-inspector-terminal.test.tsx`

**Produces:** wide three-column, medium collapsed-inspector, and narrow one-pane behavior with keyboard-accessible navigation.

- [ ] Add failing layout/accessibility tests for inspector collapse, narrow navigation, labels, and focus behavior.
- [ ] Verify RED, implement the minimum responsive CSS/React state, and run all focused Desktop tests.
- [ ] Run Desktop typecheck, React Doctor, focused contracts/Gateway tests, and the production Desktop build.
- [ ] Capture backend verification evidence and attach it to MAT-507 in English.
- [ ] Launch the exact branch Desktop build, capture the integrated Work UI, move MAT-507 to Human Review, and stop for the user's visual approval.

### Task 7: Post-approval review, CI, documentation, and merge

**Precondition:** explicit user Human Review approval.

- [ ] Refresh origin/main and PR state; resolve conflicts without touching protected task branches.
- [ ] Run the full required CI because Gateway/backend code changed.
- [ ] Address review findings with TDD and request a fresh Greptile review for the exact head until it reports 5/5.
- [ ] Repeat fresh exact-head Desktop validation and report CI/runtime evidence separately.
- [ ] Create the required English documentation PR in `FinnaAI/matrix-os-site`.
- [ ] Merge only after human approval, CI success, exact-head Greptile 5/5, and final runtime verification.
