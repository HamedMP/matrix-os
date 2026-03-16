# Spec 048: File Browser

Finder-class file manager for Matrix OS. Shell-native React component with directory browsing, file preview/editing, Quick Look, full search, and trash.

## Goals

- Browse the home directory (`~/`) with Icon, List, and Column views
- Preview and edit files inline: markdown (rendered + WYSIWYG), code (CodeMirror), images, PDF, audio/video
- Quick Look overlay on Space for instant preview without opening
- Tabbed Preview Window that accumulates opened files
- Full file operations: create, rename, move, copy, delete (trash), restore
- Name + content search across the entire home directory
- Real-time reactivity via WebSocket file watcher

## Non-Goals

- Remote file systems or cloud storage integration
- Version control UI (git history, diff viewer)
- Gallery view (media-focused filmstrip view)
- Tags / labels / smart folders (future)
- Compress / extract archives
- Share / export functionality

## Architecture

Shell-native component suite in `shell/src/components/file-browser/`. Uses existing `useWindowManager` for windowing, existing WebSocket file watcher for reactivity, existing `GET/PUT /files/*` for read/write. New gateway endpoints for directory listing, search, and file operations.

### Why Shell-Native

The file browser needs deep OS integration: spawning windows, Dock presence, file watcher reactivity, Zustand store access, theme integration, keyboard shortcut registration via command palette. Iframe-sandboxed apps can't do any of this. MissionControl, Settings, and Terminal follow the same pattern.

## Layout

The file browser opens as a standard `AppWindow` managed by `useWindowManager`.

```
+---------------------------------------------------------------+
| Toolbar: [< >] ~/agents/skills    [Icons|List|Columns] [Search]|
+----------+------------------------------------+---------------+
|          |                                    |               |
| Sidebar  |  Content Area                      | Preview Panel |
|          |  (Icon / List / Column view)        |  (file info,  |
| Favorites|                                    |   metadata,   |
| Locations|                                    |   thumbnail)  |
| Filters  |                                    |               |
| Trash    |                                    |               |
|          |                                    |               |
+----------+------------------------------------+---------------+
| Status: 8 items - 4 folders, 4 files          2.4 KB selected |
+---------------------------------------------------------------+
```

### Toolbar

- Back/forward navigation buttons (history stack)
- Breadcrumb path: clickable segments, each navigates to that directory
- View mode toggle: Icon / List / Columns (segmented control)
- Search input: expands on focus, debounced 300ms, searches name + content

### Sidebar

Four sections:

1. **Favorites**: user-pinned folders (drag to add, right-click to remove). Default: Home, Documents (if exists)
2. **Locations**: fixed shortcuts to key OS directories: Agents, Apps, System, Plugins, Modules, Data
3. **Smart Filters**: Recent (last 7 days modified), Markdown (all .md), Media (images + audio + video)
4. **Trash**: opens TrashView with restore/empty actions

Sidebar is collapsible (toggle button or drag to zero width). Collapsed state persists.

### Content Area

Three view modes:

**Icon View** (default): grid of file/folder icons. Folders show colored gradient backgrounds. Files show type-based icons. Thumbnails for images. File names below, truncated with ellipsis. Grid auto-flows, responsive to window resize.

**List View**: table with sortable columns: Name, Size, Date Modified, Type. Click column header to sort (toggle asc/desc). Disclosure triangles for folders (expand inline). Row selection highlighting. Alternating row backgrounds for readability.

**Column View** (Miller columns): each column shows one directory level. Selecting a folder opens its contents in the next column. Selecting a file shows preview in the rightmost column. Columns scroll horizontally. Column width adjustable by dragging dividers.

### Preview Panel

Right sidebar showing metadata for the selected file:

- File type icon (large)
- File name and extension
- File type label and size
- Modified date, created date
- Full path
- Content preview snippet: first ~20 lines for text, thumbnail for images, first page for PDF

Toggle-able: Cmd+Shift+I (Info panel) or toolbar button. State persists.

### Status Bar

Bottom bar showing: item count (X items, Y folders, Z files), selection info (size of selected items), current path (when breadcrumbs are truncated).

## Quick Look

Pressing Space on a selected file opens a modal overlay:

- Centered over the file browser window (75% width, max 600px)
- Frosted glass background (backdrop-filter: blur)
- Header: file icon, name, size, path, "Open" button
- Content: rendered preview based on file type (same renderers as Preview Window)
- Footer: "Space to dismiss -- Enter to open -- Arrow keys to navigate"

Interactions:
- Space: toggle on/off
- Escape: dismiss
- Arrow Up/Down: navigate to adjacent files while Quick Look stays open (content swaps with crossfade)
- Enter or "Open" button: open file in Preview Window tab, dismiss Quick Look
- Animation: scale from 0.95 + fade in (200ms ease-out), fade out on dismiss (150ms ease-in)

## Preview Window

A separate `AppWindow` (managed by `useWindowManager`) that opens on double-click or Enter. Accumulates tabs -- subsequent file openings add tabs instead of spawning new windows.

### Tab Bar

Horizontal tab strip at the top. Each tab shows: file type icon, file name, close button (X), unsaved indicator (amber dot before name). Active tab has blue bottom border. Tabs are drag-reorderable. Middle-click closes a tab. Closing last tab closes the window.

### Editor Toolbar

Below the tab bar. Content depends on file type:

- **Markdown**: mode toggle (Source / Preview / WYSIWYG), file encoding, file type label, Save button
- **Code/Text**: mode toggle (Source / Preview where applicable), encoding, language label, Save button
- **Images**: dimensions, format, file size, zoom controls (-, percentage, +, Fit)
- **PDF**: page navigation (prev/next, page number input, total pages), zoom controls
- **Audio/Video**: native HTML5 controls (play/pause, scrub, volume, fullscreen for video)

### Viewers/Editors

**CodeMirror 6** (text/code files): syntax highlighting, line numbers, active line highlight, bracket matching, search/replace (Cmd+F), word wrap toggle. Language extensions loaded per file type: markdown, json, javascript, typescript, python, html, css, yaml, toml, shell. Theme matches Matrix OS theme (dark mode by default).

**Markdown Preview**: `react-markdown` with `rehype-highlight` for code blocks, `remark-gfm` for GitHub Flavored Markdown (tables, task lists, strikethrough). Styled to match Matrix OS typography.

**WYSIWYG Editor** (markdown files): Milkdown or Tiptap-based. Toolbar with bold, italic, headings, lists, code blocks, links, images. Outputs standard markdown. Toggle between WYSIWYG and Source preserves content.

**Image Viewer**: CSS `object-fit: contain` with zoom/pan. Checkerboard background for transparency. Zoom: scroll wheel, pinch, +/- buttons. Fit button resets to fit-in-window. Drag to pan when zoomed.

**PDF Viewer**: `pdfjs-dist` rendering to canvas. Page-by-page navigation. Zoom controls. Text selection for copy.

**Media Player**: native `<audio>` / `<video>` elements with controls attribute. No custom player chrome needed.

### Save Behavior

- `Cmd+S` saves via `PUT /files/{path}` with the editor content as raw text body
- Unsaved changes: amber dot on tab, "Unsaved changes" label in toolbar
- Close tab with unsaved changes: confirmation dialog ("Save / Don't Save / Cancel")
- Close window with multiple unsaved tabs: lists all unsaved files in confirmation

## Gateway API

### New Endpoints

All paths are relative to the home directory. All validated through `resolveWithinHome()`.

#### GET /api/files/list

Extend the existing `GET /api/files/tree` endpoint (in `files-tree.ts`) with additional metadata fields. The current endpoint returns name, type, size, and git status. We add: `modified`, `created`, `mime`, and `children` count. The old `/api/files/tree` route becomes an alias for this endpoint for backwards compatibility.

Query params:
- `path` (required): directory path relative to home (e.g., `agents/skills`)

Response:
```json
{
  "path": "agents/skills",
  "entries": [
    {
      "name": "study-timer.md",
      "type": "file",
      "size": 1240,
      "modified": "2026-03-16T14:23:00.000Z",
      "created": "2026-03-10T09:00:00.000Z",
      "mime": "text/markdown"
    },
    {
      "name": "knowledge",
      "type": "directory",
      "modified": "2026-03-15T11:00:00.000Z",
      "children": 3
    }
  ]
}
```

Errors: 404 if path not found, 400 if path is a file (not directory), 403 if path escapes home.

#### GET /api/files/stat

Single file/directory metadata.

Query params:
- `path` (required): file path relative to home

Response:
```json
{
  "name": "builder.md",
  "path": "agents/custom/builder.md",
  "type": "file",
  "size": 2400,
  "modified": "2026-03-16T14:23:00.000Z",
  "created": "2026-03-10T09:00:00.000Z",
  "mime": "text/markdown"
}
```

#### GET /api/files/search

Recursive file name and content search.

Query params:
- `q` (required): search query string
- `path` (optional): starting directory (default: home root)
- `content` (optional): `true` to search file contents, not just names (default: `false`)
- `limit` (optional): max results (default: 100, max: 500)

Response:
```json
{
  "query": "telegram",
  "results": [
    {
      "path": "system/config.json",
      "name": "config.json",
      "type": "file",
      "matches": [
        { "line": 3, "text": "  \"telegram\": {", "type": "content" }
      ]
    },
    {
      "path": "agents/knowledge/channel-routing.md",
      "name": "channel-routing.md",
      "type": "file",
      "matches": [
        { "line": 1, "text": "channel-routing.md", "type": "name" },
        { "line": 12, "text": "Telegram uses polling via node-telegram-bot-api", "type": "content" }
      ]
    }
  ],
  "truncated": false
}
```

Search implementation: recursive `readdir` + `stat` for names, line-by-line `readline` for content. Skip binary files (detect via extension). Skip files larger than 1MB for content search. Timeout at 5 seconds. Skip `.trash/`, `node_modules/`, `.git/`, and all dotfiles/dotdirs.

Search requests are cancellable: the client sends an `AbortController` signal, and the gateway aborts the in-progress search when a new query arrives. This prevents stale results from slow searches overlapping with new queries.

V2 consideration: upgrade to QMD-based indexed search for instant results on large home directories.

#### POST /api/files/mkdir

Create a directory (recursive).

Body: `{ "path": "projects/new-app" }`
Response: `{ "ok": true, "path": "projects/new-app" }`

#### POST /api/files/touch

Create an empty file.

Body: `{ "path": "agents/new-agent.md", "content": "" }`
Response: `{ "ok": true, "path": "agents/new-agent.md" }`

Content is optional (defaults to empty string). This is distinct from `PUT /files/*` because it returns JSON and handles conflicts. Errors: 409 if file already exists.

#### POST /api/files/duplicate

Duplicate a file or directory in the same location with auto-generated name.

Body: `{ "path": "agents/builder.md" }`
Response: `{ "ok": true, "newPath": "agents/builder copy.md" }`

Naming: appends " copy" before the extension (or " copy 2", " copy 3" if copies exist). For directories: appends " copy" to the folder name.

#### POST /api/files/rename

Rename or move a file/directory.

Body: `{ "from": "agents/old.md", "to": "agents/new.md" }`
Response: `{ "ok": true }`

Errors: 404 if source not found, 409 if destination exists.

#### POST /api/files/copy

Copy a file or directory (recursive for directories).

Body: `{ "from": "agents/builder.md", "to": "agents/builder-backup.md" }`
Response: `{ "ok": true }`

#### POST /api/files/delete

Move file/directory to trash.

Body: `{ "path": "agents/old.md" }`
Response: `{ "ok": true, "trashPath": ".trash/old.md" }`

Implementation: moves to `~/.trash/` with collision handling (append timestamp if name exists). Records original path and deletion time in `~/.trash/.manifest.json`.

Atomicity: manifest reads/writes use atomic rename (write to `.manifest.json.tmp`, then `rename()` over the original). Trash operations are serialized via a mutex in the gateway to prevent concurrent delete/restore from corrupting the manifest.

Manifest format:
```json
[
  {
    "name": "old.md",
    "originalPath": "agents/old.md",
    "deletedAt": "2026-03-16T15:00:00.000Z",
    "trashPath": ".trash/old.md"
  }
]
```

#### GET /api/files/trash

List trash contents.

Response:
```json
{
  "entries": [
    {
      "name": "old.md",
      "originalPath": "agents/old.md",
      "deletedAt": "2026-03-16T15:00:00.000Z",
      "size": 1200,
      "type": "file"
    }
  ]
}
```

#### POST /api/files/trash/restore

Restore a file from trash to its original location.

Body: `{ "trashPath": ".trash/old.md" }`
Response: `{ "ok": true, "restoredTo": "agents/old.md" }`

If original location has a file with the same name: 409 conflict, client must resolve.

#### POST /api/files/trash/empty

Permanently delete all trash contents.

Response: `{ "ok": true, "deleted": 3 }`

## Component Tree

```
shell/src/components/file-browser/
  index.ts                 # Public exports
  FileBrowser.tsx           # Main window content: toolbar + sidebar + content + preview + status
  FileBrowserToolbar.tsx    # Back/forward, breadcrumbs, view toggle, search
  FileBrowserSidebar.tsx    # Favorites, Locations, Smart Filters, Trash link
  FileBrowserContent.tsx    # Switch on viewMode: renders IconView | ListView | ColumnView
  IconView.tsx              # CSS grid of FileIcon components
  ListView.tsx              # Table with sortable column headers, disclosure triangles
  ColumnView.tsx            # Horizontal scroll container of directory columns
  FileIcon.tsx              # Single item: icon/thumbnail + name + selection state
  PreviewPanel.tsx          # Right sidebar: metadata + content snippet
  QuickLook.tsx             # Modal overlay with file preview
  ContextMenu.tsx           # Right-click menu (uses shadcn ContextMenu)
  SearchResults.tsx         # Flat result list with match highlights
  TrashView.tsx             # Trash listing with restore/empty buttons

shell/src/components/preview-window/
  index.ts
  PreviewWindow.tsx         # Window container with tab bar
  PreviewTab.tsx            # File type detection + renderer dispatch
  CodeEditor.tsx            # CodeMirror 6 wrapper
  MarkdownViewer.tsx        # react-markdown rendered view
  WysiwygEditor.tsx         # Milkdown/Tiptap rich editor
  ImageViewer.tsx           # Zoom/pan image display
  PdfViewer.tsx             # pdfjs-dist page renderer
  MediaPlayer.tsx           # HTML5 audio/video wrapper

shell/src/hooks/
  useFileBrowser.ts         # Zustand store: navigation, view, selection, search, clipboard
  usePreviewWindow.ts       # Zustand store: tabs, active tab, unsaved state
```

## State Management

### useFileBrowser (Zustand)

```typescript
interface FileBrowserState {
  // Navigation
  currentPath: string;
  history: string[];
  historyIndex: number;

  // View
  viewMode: 'icon' | 'list' | 'column';
  sortBy: 'name' | 'size' | 'modified' | 'type';
  sortDirection: 'asc' | 'desc';
  showPreviewPanel: boolean;
  sidebarCollapsed: boolean;

  // Content
  entries: FileEntry[];
  loading: boolean;
  error: string | null;

  // Selection
  selectedPaths: Set<string>;
  lastSelectedPath: string | null;

  // Sidebar
  favorites: string[];

  // Quick Look
  quickLookPath: string | null;

  // Search
  searchQuery: string;
  searchResults: SearchResult[] | null;
  searching: boolean;

  // Clipboard
  clipboard: { paths: string[]; operation: 'copy' | 'cut' } | null;

  // Actions
  navigate(path: string): void;
  goBack(): void;
  goForward(): void;
  refresh(): void;
  setViewMode(mode: 'icon' | 'list' | 'column'): void;
  select(path: string, multi?: boolean, range?: boolean): void;
  search(query: string): void;
  copy(paths: string[]): void;
  cut(paths: string[]): void;
  paste(): void;
  rename(from: string, to: string): void;
  delete(paths: string[]): void;
  duplicate(paths: string[]): void;
  createFolder(name: string): void;
  createFile(name: string): void;
  toggleFavorite(path: string): void;
}
```

### usePreviewWindow (Zustand)

```typescript
interface PreviewWindowState {
  tabs: PreviewTab[];
  activeTabId: string | null;
  unsavedTabs: Set<string>;

  openFile(path: string): void;       // Add tab or focus existing
  closeTab(id: string): void;
  setActiveTab(id: string): void;
  setMode(id: string, mode: 'source' | 'preview' | 'wysiwyg'): void;
  markUnsaved(id: string): void;
  markSaved(id: string): void;
  reorderTabs(fromIndex: number, toIndex: number): void;
}

interface PreviewTab {
  id: string;
  path: string;
  name: string;
  type: 'text' | 'code' | 'markdown' | 'image' | 'pdf' | 'audio' | 'video';
  mode?: 'source' | 'preview' | 'wysiwyg'; // Only for text/code/markdown types. Undefined for image/pdf/audio/video.
}
```

## Keyboard Shortcuts

All shortcuts scoped to file browser focus container (`<div tabIndex={0}>`). Only intercepted when file browser has focus; browser defaults pass through otherwise.

### Navigation
| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+F` | Open file browser (global, via command palette) |
| `Cmd+[` / `Cmd+]` | Back / Forward in history |
| `Cmd+Down` | Open folder / Open file in Preview Window |
| `Cmd+Up` | Go to parent directory |
| Arrow keys | Navigate selection |

### Quick Look
| Shortcut | Action |
|----------|--------|
| `Space` | Toggle Quick Look |
| `Escape` | Dismiss Quick Look |
| Arrow Up/Down (Quick Look open) | Navigate files, preview follows |
| `Enter` (Quick Look open) | Open in Preview Window |

### File Operations
| Shortcut | Action |
|----------|--------|
| `Cmd+C` | Copy |
| `Cmd+X` | Cut |
| `Cmd+V` | Paste |
| `Cmd+Shift+D` | Duplicate (remapped from Cmd+D to avoid browser bookmark) |
| `Cmd+Delete` | Move to Trash |
| `Cmd+Shift+N` | New folder |
| `Cmd+A` | Select all |
| `Enter` | Rename selected (single selection, after brief delay) |
| `F2` | Rename selected (alternative) |

### Preview Window
| Shortcut | Action |
|----------|--------|
| `Cmd+S` | Save current file |
| `Cmd+Shift+W` | Close current tab (remapped from Cmd+W) |
| `Cmd+Shift+[` / `]` | Switch tabs |
| `Cmd+Shift+P` | Toggle Preview mode (remapped from Cmd+P) |

### Enter Key Behavior

`Enter` has two roles depending on context:
- **Quick Look open**: opens the file in Preview Window (immediate)
- **Quick Look closed, single file selected**: enters rename mode after 300ms delay (matching macOS behavior). The delay distinguishes a single Enter (rename) from a rapid double-click (open). `F2` is an alternative that enters rename immediately without delay.
- **Quick Look closed, folder selected**: opens the folder (navigates into it)

### Context Menu

Right-click shows context-specific menu items (using shadcn ContextMenu):

**On a file:**
- Open
- Open in Preview Window
- Quick Look
- ---
- Copy
- Cut
- Duplicate
- Rename
- ---
- Copy Path
- Open in Terminal (opens Terminal `cd`'d to file's directory)
- ---
- Move to Trash

**On a folder:**
- Open
- ---
- Copy
- Cut
- Duplicate
- Rename
- ---
- Copy Path
- Open in Terminal
- ---
- Move to Trash

**On empty space (no selection):**
- New File (submenu: .md, .txt, .json, .html, .js, .ts)
- New Folder
- Paste (if clipboard has content)
- ---
- Sort By (submenu: Name, Size, Date Modified, Type)
- View As (submenu: Icons, List, Columns)

**On multiple selected items:**
- Copy
- Cut
- ---
- Move to Trash

## File Type Handling

| Extensions | Viewer | Edit Mode | Quick Look |
|-----------|--------|-----------|------------|
| `.md` | MarkdownViewer | Source (CodeMirror) / WYSIWYG | Rendered markdown |
| `.txt`, `.log`, `.csv` | CodeEditor | Source (CodeMirror) | First 50 lines |
| `.json`, `.yaml`, `.toml` | CodeEditor | Source (CodeMirror, language mode) | Syntax highlighted |
| `.js`, `.ts`, `.jsx`, `.tsx`, `.py`, `.html`, `.css`, `.sh` | CodeEditor | Source (CodeMirror, language mode) | Syntax highlighted |
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg` | ImageViewer | View only | Full image |
| `.pdf` | PdfViewer | View only | First page |
| `.mp3`, `.wav` | MediaPlayer | View only | Audio player |
| `.mp4`, `.webm` | MediaPlayer | View only | Video player |
| Other | CodeEditor (plain text) | Source | First 50 lines |

## Dependencies (New)

| Package | Purpose | Size |
|---------|---------|------|
| `@codemirror/view` | Editor core | ~150KB |
| `@codemirror/state` | Editor state | ~50KB |
| `@codemirror/lang-*` | Language support (js, json, markdown, html, css, python) | ~20KB each |
| `@codemirror/theme-one-dark` | Dark theme (or custom Matrix OS theme) | ~5KB |
| `react-markdown` | Markdown rendering | ~30KB |
| `rehype-highlight` | Code block syntax highlighting in markdown | ~10KB |
| `remark-gfm` | GitHub Flavored Markdown (tables, task lists) | ~5KB |
| `@milkdown/core` + plugins | WYSIWYG markdown editor | ~200KB |
| `pdfjs-dist` | PDF rendering | ~400KB |

Total new bundle: ~900KB (lazy-loaded per viewer type, not upfront).

All viewers lazy-loaded via `React.lazy()` + `Suspense` so the file browser itself loads fast, and heavy dependencies (PDF, WYSIWYG) only load when needed.

## Reactivity

The file browser subscribes to the existing WebSocket file watcher. When a `file:change` event arrives:

- `add` / `unlink` in current directory: refresh directory listing
- `change` to a file open in Preview Window: show "File changed externally" banner with Reload / Ignore options
- `change` to currently previewed file in Preview Panel: auto-refresh preview

This is already implemented in the gateway (chokidar watcher broadcasts to all WS clients). The file browser just needs to filter events by current path.

## Persistence

Persisted state (survives browser refresh):

- `viewMode`, `sortBy`, `sortDirection`: saved to `/api/bridge/data` with app key `file-browser`
- `favorites`: saved to `/api/bridge/data`
- `sidebarCollapsed`, `showPreviewPanel`: saved to `/api/bridge/data`
- Window position/size: handled by existing `useWindowManager` layout persistence
- Preview Window tabs: saved to `/api/bridge/data` (restore open tabs on relaunch)

## Integration Points

- **Dock**: file browser icon registered as a built-in app (like Terminal, MissionControl, Settings)
- **Command Palette**: `Cmd+K` > "Open File Browser" action
- **Context from Chat**: AI can suggest "open ~/agents/skills/study-timer.md in file browser" via bridge message
- **Open in Terminal**: context menu action opens Terminal window `cd`'d to the file's directory
- **Drag to Desktop**: drag files from file browser onto desktop to create shortcut (future)

## MIME Type Detection

File MIME types are determined by extension lookup using a static `Record<string, string>` map. No external library needed -- the map covers all supported file types:

```typescript
const MIME_MAP: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.jsx': 'text/jsx',
  '.tsx': 'text/tsx',
  '.py': 'text/x-python',
  '.html': 'text/html',
  '.css': 'text/css',
  '.sh': 'text/x-shellscript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
```

Unknown extensions default to `application/octet-stream`.

## Symlink Handling

Symlinks are followed transparently: use `stat()` not `lstat()` so symlinks resolve to their target type (file or directory). Display the target's type and size. No special symlink indicator in v1 -- they appear as regular files/folders.

## Column View Limits

Column View shows a maximum of 5 visible columns. As the user navigates deeper, earlier columns scroll off to the left. A horizontal scrollbar allows navigating back. Each column has a minimum width of 180px and can be resized by dragging the divider between columns.

## File Watcher Notes

The chokidar watcher in `watcher.ts` must be updated to ignore `.trash/` in addition to the existing `node_modules` and `.git` ignores. Without this, moving files to trash would fire spurious `add` events for the trash directory.

The existing `listDirectory()` in `files-tree.ts` already skips dotfiles (`if (entry.name.startsWith(".")) continue`), so `.trash` won't appear in normal directory listings.

## Accessibility

- Icon and List views use `role="grid"` with `role="row"` and `role="gridcell"` for items
- Column View uses `role="tree"` with `role="treeitem"` for entries
- All toolbar buttons have `aria-label` attributes
- Quick Look modal has `role="dialog"` with `aria-modal="true"` and focus trap (Tab cycles within modal)
- Status bar uses `aria-live="polite"` for announcing selection changes and item counts
- File operations announce results via `aria-live` region (e.g., "3 files moved to Trash")
- Focus management: opening Quick Look moves focus into modal, dismissing returns focus to the previously selected file

## Store Serialization Notes

`selectedPaths` (`Set<string>`) and `unsavedTabs` (`Set<string>`) don't JSON-serialize natively. Selection state does not need persistence (cleared on navigation). `unsavedTabs` is transient (only matters while the window is open). For any future persistence needs, convert Sets to arrays at the serialization boundary.

## Testing Strategy

- Unit tests for Zustand stores (navigation, selection, clipboard, search state)
- Unit tests for file type detection, MIME mapping, path utilities
- Unit tests for gateway endpoints (list, stat, search, mkdir, rename, copy, delete, trash, touch, duplicate)
- Unit tests for trash manifest atomicity (concurrent delete/restore)
- Integration tests for gateway file operations (create, modify, delete, restore cycle)
- Component tests for view switching, keyboard shortcuts, context menu actions
- Target: 99%+ coverage following project TDD requirements
