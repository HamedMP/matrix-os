# Plan 047: Terminal App

## Implementation Phases

### Phase 1: Backend (gateway changes)
1. Modify `createPtyHandler` to accept `cwd` parameter
2. Update `/ws/terminal` WebSocket route to pass `cwd` query param
3. Add `/api/files/tree` endpoint with git status
4. Add `/api/terminal/layout` endpoint (GET/PUT for terminal-layout.json)
5. Tests for all backend changes

### Phase 2: State Management (Zustand store)
6. Create `useTerminalStore` with tabs, panes, sidebar state
7. Implement pane tree operations (split, close, focus)
8. Layout persistence (load/save to terminal-layout.json via API)
9. Tests for store

### Phase 3: Core Terminal Components
10. Create `TerminalPane` component (xterm.js + WebSocket, theme-aware)
11. Create `PaneGrid` component (recursive split rendering, draggable dividers)
12. Create `TerminalTabBar` component (tabs, splits, Claude Code button)
13. Tests for components

### Phase 4: Sidebar
14. Create `TerminalSidebar` component (file tree, git status, icon bar collapse)
15. Tests for sidebar

### Phase 5: TerminalApp + Integration
16. Create `TerminalApp` (assembles sidebar + tabs + panes)
17. Wire into BottomPanel (replace old Terminal)
18. Register as standalone window app
19. Keyboard shortcuts
20. Final integration tests

## Dependencies
- Phase 2 depends on Phase 1 (API endpoints)
- Phase 3 depends on Phase 2 (store)
- Phase 4 can run in parallel with Phase 3
- Phase 5 depends on Phases 3 + 4

## Files to Create
- `packages/gateway/src/files-tree.ts` -- file tree endpoint logic
- `shell/src/components/terminal/TerminalApp.tsx`
- `shell/src/components/terminal/TerminalPane.tsx`
- `shell/src/components/terminal/TerminalTabBar.tsx`
- `shell/src/components/terminal/TerminalSidebar.tsx`
- `shell/src/components/terminal/PaneGrid.tsx`
- `shell/src/stores/terminal-store.ts`
- `tests/gateway/files-tree.test.ts`
- `tests/gateway/pty-cwd.test.ts`
- `tests/shell/terminal-store.test.ts`
- `tests/shell/terminal-app.test.ts`

## Files to Modify
- `packages/gateway/src/pty.ts` -- accept cwd param
- `packages/gateway/src/server.ts` -- wire cwd param + add /api/files/tree route
- `shell/src/components/BottomPanel.tsx` -- swap Terminal for TerminalApp
- `shell/src/components/Desktop.tsx` -- register terminal as built-in app (optional)
