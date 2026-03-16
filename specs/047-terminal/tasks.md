# Tasks 047: Terminal App

## Phase 1: Backend

- [x] T1: Modify `createPtyHandler` to accept `cwd` parameter + update `/ws/terminal` route
- [x] T2: Add `GET /api/files/tree` endpoint with git status parsing
- [x] T3: Add `GET/PUT /api/terminal/layout` endpoint for terminal-layout.json
- [x] T4: Backend tests (pty cwd, files-tree, terminal layout) -- 23 tests

## Phase 2: State Management

- [x] T5: Create `useTerminalStore` Zustand store (tabs, panes, sidebar, persistence)
- [x] T6: Tests for terminal store -- 19 tests

## Phase 3: Core Components

- [x] T7: Create `TerminalPane` component (xterm.js + WebSocket + theme)
- [x] T8: Create `PaneGrid` component (recursive splits + draggable dividers)
- [x] T9: Create `TerminalTabBar` component (tabs + splits + Claude Code button)
- [x] T10: Tests for core components

## Phase 4: Sidebar

- [x] T11: Create `TerminalSidebar` component (file tree + git status + collapse)
- [x] T12: Tests for sidebar

## Phase 5: Integration

- [x] T13: Create `TerminalApp` (assemble all components)
- [x] T14: Wire into BottomPanel + register as standalone app + keyboard shortcuts
- [x] T15: Final integration tests -- 8 tests

## Summary

- **50 new tests** (23 backend + 27 frontend)
- **2187 total tests passing** (up from 1942)
- Pre-existing QMD integration timeout unrelated to changes
