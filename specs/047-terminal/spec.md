# Spec 047: Terminal App

## Overview

Replace the existing minimal Terminal component (127-line xterm.js wrapper) with a full IDE-grade terminal app. The terminal is always IDE-grade regardless of window size, with a responsive sidebar that collapses to an icon bar when narrow. Users can install and use Claude Code by logging in with their own account.

## Goals

1. Provide a high-quality coding terminal inside Matrix OS
2. Enable users to run Claude Code alongside their own shell sessions
3. Support tabs, split panes, and a project file tree with git status
4. Inherit the active Matrix OS desktop theme (adaptive styling)
5. Persist terminal layout across sessions

## Non-Goals

- No Claude Code auto-detection or special rendering
- No API key management or proxy integration (users bring their own account)
- No full file browser (separate future spec)
- No built-in code editor (files open in existing code-editor app if needed)
- No file search in sidebar (future)

## Architecture

### Component Tree

```
TerminalApp (top-level, registered as built-in app)
├── TerminalSidebar (file tree, collapsible)
│   ├── Icon bar mode (when collapsed or width < 500px)
│   └── Full tree mode (lazy-loaded from /api/files/tree)
├── TerminalTabBar
│   ├── Tab[] (label, dot indicator, close button, drag-reorder)
│   ├── Split buttons (horizontal ⊞, vertical ⊟)
│   └── "Claude Code" launch button (green)
└── PaneGrid (CSS grid, recursive splits)
    └── TerminalPane[] (each wraps one xterm.js + one WebSocket)
```

### State Management

Zustand store `useTerminalStore`:

```typescript
interface TerminalStore {
  tabs: TerminalTab[]
  activeTabId: string
  sidebarOpen: boolean
  sidebarWidth: number
  sidebarSelectedPath: string | null
}

interface TerminalTab {
  id: string
  label: string
  paneTree: PaneNode
}

type PaneNode =
  | { type: 'pane'; id: string; cwd: string }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; children: [PaneNode, PaneNode]; ratio: number }
```

Terminal-internal layout (tabs, pane trees, cwds, sidebar state) persists to `~/system/terminal-layout.json`, separate from window layout. Loaded by the Zustand store on mount, saved on change (debounced 500ms).

### Pane Tree (Recursive Splits)

Each tab contains a pane tree. Splitting a pane replaces it with a split node containing the original pane and a new pane:

```
Tab "myapp"
└── Split (horizontal)
    ├── Pane 1: claude
    └── Split (vertical)
        ├── Pane 2: npm run dev
        └── Pane 3: npm test --watch
```

Max 4 panes per tab. No limit on tabs.

## Backend Changes

### 1. Add `cwd` parameter to `/ws/terminal`

Accept a query parameter to set the PTY working directory:

```
/ws/terminal?cwd=/home/matrixos/home/projects/myapp
```

- Validate `cwd` is within `$MATRIX_HOME` using existing `resolveWithinHome` (prevent path traversal)
- Default to `$MATRIX_HOME` if not provided or invalid

### 2. Add `/api/files/tree` endpoint

```
GET /api/files/tree?path=projects/myapp
```

Response:

```json
[
  {"name": "src", "type": "directory", "gitStatus": null, "changedCount": 3},
  {"name": "index.ts", "type": "file", "size": 1240, "gitStatus": "modified"},
  {"name": "README.md", "type": "file", "size": 890, "gitStatus": null}
]
```

- Lazy-loaded: returns one level at a time (children fetched on expand)
- Git status: run `git status --porcelain` once per request at the nearest `.git` root, parse full output into a map, derive per-entry status from that map. Cache result for 2 seconds to avoid re-running on rapid folder expansions.
- `changedCount`: number of changed files inside a directory (derived from the status map)
- `gitStatus` values for files: `"modified"`, `"added"`, `"deleted"`, `"untracked"`, `"renamed"`, `null` (clean)
- `gitStatus` for directories: always `null` (use `changedCount` instead)
- Path scoped to `$MATRIX_HOME` only (reject traversal attempts via `resolveWithinHome`)
- Sorted: directories first, then files, alphabetical within each group

### 3. Modify PTY handler to accept `cwd`

The WebSocket upgrade handler for `/ws/terminal` must pass the `cwd` query parameter to `createPtyHandler`. Each pane opens an independent WebSocket that spawns a new PTY -- no PTY sharing or multiplexing.

### 4. No changes needed to:

- Window manager: terminal app is just another app in the existing window system
- Auth: no new auth required

## App Registration

The TerminalApp replaces the current Terminal component in the BottomPanel. The existing BottomPanel "Terminal" tab renders the new TerminalApp instead of the old Terminal.tsx. The TerminalApp is also registered as a launchable built-in app (slug: `terminal`, title: "Terminal") so it can be opened as a standalone window from the dock or Cmd+K palette.

When opened as a standalone window, the BottomPanel terminal can optionally be hidden (user preference).

## Frontend Components

### TerminalApp

Top-level component. Renders sidebar + tab bar + pane grid in a flex layout. Reads theme from the existing theme system (desktop.json / theme.json). Used both inline (BottomPanel) and as a standalone window.

### TerminalSidebar

- Default root: `~/projects/`
- Can navigate up to `~/` (full home). Path bar shows current root. "Up" button disabled at `~/` (API also rejects traversal).
- Expand/collapse folders (lazy-load children via `/api/files/tree`)
- Git status colors: green (new/added), yellow (modified), red (deleted), gray (ignored)
- Folder badges: count of changed files inside
- Click folder context action: "Open terminal here" (new tab with that cwd)
- Auto-collapse to icon bar when TerminalApp container width < 500px (ResizeObserver on the app container, not viewport)
- Toggle via icon bar click or keyboard shortcut

### TerminalTabBar

- Tab label: set at creation time from cwd basename (e.g., "myapp"). Claude Code tabs labeled "Claude Code". Duplicate labels allowed (users can rename via context menu). Labels do not auto-update on `cd`.
- Colored dot: green (WebSocket connected), gray (WebSocket disconnected)
- Close button per tab
- Drag to reorder (native HTML drag-and-drop with `draggable` attribute, array reorder in Zustand)
- Context menu: rename, duplicate, close others
- `+` button: new tab
- Split buttons: `⊞` horizontal, `⊟` vertical (split focused pane)
- "Claude Code" button: green, opens new tab running `claude` in sidebar-selected directory or `~/projects/`

### TerminalPane

- Wraps xterm.js (`@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links`)
- One WebSocket connection to `/ws/terminal?cwd=<path>` per pane
- Resize observer triggers `addon-fit` recalculation
- Theme colors inherited from Matrix OS theme
- Font: monospace system stack (user can configure in settings)

### PaneGrid

- CSS grid layout driven by the pane tree structure
- Draggable dividers between panes for resize
- Stores split ratios in the pane tree (persisted with layout)
- Focus ring on active pane
- Focus navigation: click or keyboard shortcuts

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| New tab | `Ctrl+Shift+T` |
| Close pane (then tab) | `Ctrl+Shift+W` |
| Split horizontal | `Ctrl+Shift+D` |
| Split vertical | `Ctrl+Shift+E` |
| Next pane | `Ctrl+Shift+]` |
| Previous pane | `Ctrl+Shift+[` |
| Toggle sidebar | `Ctrl+Shift+B` |
| Launch Claude Code | `Ctrl+Shift+C` |

Note: `Cmd+T`/`Cmd+W` are reserved by the browser and cannot be intercepted. All shortcuts use `Ctrl+Shift` prefix which does not conflict with browser or terminal shortcuts. On macOS in a PWA/Electron context, `Cmd` variants could be added later.

## Visual Design

Adaptive theme: the terminal inherits all colors from the active Matrix OS desktop theme. This includes:

- Background, foreground, cursor, selectionBackground from theme
- Tab bar and sidebar use the same surface/border colors as the desktop
- ANSI 16-color palette: use a pre-defined dark or light palette selected based on the theme's background lightness. Only `background`, `foreground`, `cursor`, and `selectionBackground` are mapped from the theme directly. The 16 ANSI colors (black, red, green, yellow, blue, magenta, cyan, white + bright variants) are fixed defaults chosen to have good contrast with both dark and light theme backgrounds.
- When the user changes their desktop theme, the terminal updates in real-time

The existing 6 theme presets (and any custom themes) automatically apply.

## Session Lifecycle

- **Open terminal app**: restores tab/split/cwd layout from `~/system/terminal-layout.json`. Each pane spawns a fresh PTY (no reconnection to old PTYs -- they are killed on WebSocket close, matching current behavior).
- **Close terminal window**: all WebSocket connections close, all PTY processes are killed. This is intentional -- PTY reconnection would require a session registry and is deferred to a future spec.
- **Page reload**: same as close + reopen. Layout restores, fresh PTYs spawn. Running processes are lost.
- **New tab default directory**: sidebar-selected folder > `~/projects/` > `~/`

## Claude Code Integration

Minimal by design:

1. "Claude Code" button in tab bar opens a new tab and runs `claude`
2. `Ctrl+Shift+C` keyboard shortcut does the same
3. Claude Code is pre-installed in the Docker container
4. Users authenticate with their own Claude account (OAuth flow in terminal)
5. No special detection, wrapping, or enhanced rendering

## Testing Strategy

- Unit tests for `useTerminalStore` (tab CRUD, pane tree splits/closes, layout persistence)
- Unit tests for `PaneGrid` rendering (split ratios, focus management)
- Unit tests for `/api/files/tree` endpoint (directory listing, git status parsing, path traversal rejection)
- Unit tests for `/ws/terminal?cwd=` parameter validation
- Integration test: open terminal, create tab, split, close (WebSocket lifecycle)
