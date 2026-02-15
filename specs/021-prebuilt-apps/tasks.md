# Tasks: Prebuilt Apps + App Theming

**Task range**: T710-T725
**Parallel**: YES -- mostly home/ template work and shell polish. Independent of kernel/gateway changes.
**Deps**: T661 (generate_image IPC tool) for icon generation. T710 (matrix.md spec) should be done first as other tasks reference it.

## User Story

- **US-PA1**: "New users see a useful, populated OS with real apps -- not an empty desktop"
- **US-PA2**: "Every app has consistent theming and metadata via matrix.md"

## Part A: matrix.md App Convention

### Architecture

Each app in `~/apps/` can have a companion `matrix.md` file that defines metadata. The shell reads this to render dock icons, window titles, and apply theme overrides.

Format: `~/apps/{app-name}/matrix.md` or `~/apps/{app-name}.matrix.md` (for single-file apps like `expense-tracker.html`).

### Implementation

- [ ] T710 [P] [US-PA2] Define matrix.md schema and parser:
  - Create `packages/kernel/src/app-meta.ts`:
    ```typescript
    interface AppMeta {
      name: string;           // Display name
      description?: string;   // One-line description
      icon?: string;          // Path to icon file, emoji, or "generate" (trigger fal.ai)
      category?: string;      // productivity, game, utility, social, media, dev
      theme?: {               // Theme overrides for this app's window
        accent?: string;      // Accent color
        background?: string;  // Background color
      };
      data_dir?: string;      // Data directory (default: ~/data/{app-name}/)
      author?: string;        // Creator (default: "system" for prebuilt)
      version?: string;       // App version
    }
    ```
  - `loadAppMeta(appPath)`: read and parse matrix.md frontmatter
  - Graceful fallback: if no matrix.md, derive name from filename, use default icon

- [ ] T710a [P] [US-PA2] Write `tests/kernel/app-meta.test.ts`:
  - `loadAppMeta()` parses valid matrix.md frontmatter
  - Returns defaults for missing fields
  - Returns null/defaults for apps without matrix.md
  - Handles malformed frontmatter gracefully

- [ ] T711 [US-PA2] Update shell to read matrix.md:
  - Gateway: `GET /api/apps` returns list of apps with metadata (reads matrix.md for each)
  - Shell Desktop: use AppMeta for dock icons, window titles, categories
  - Shell Dock: show icon (emoji or image), tooltip shows description

## Part B: Prebuilt Apps

### Single-File Apps (HTML)

Each prebuilt app is a self-contained HTML file with inline CSS/JS. Uses OS bridge (`window.MatrixOS`) for data persistence. Includes matrix.md companion.

- [ ] T712 [US-PA1] **Expense Tracker** -- `home/apps/expense-tracker.html`:
  - Features: add expenses with amount/category/date, list view, category totals, monthly summary
  - Data: `~/data/expense-tracker/expenses.json` via OS bridge
  - matrix.md: name "Expense Tracker", category "productivity", icon dollar-sign emoji
  - Polished UI matching design guide (warm palette, rounded corners, clean typography)

- [ ] T713 [US-PA1] **Notes** -- `home/apps/notes.html`:
  - Features: create/edit/delete notes, markdown rendering, search, tags
  - Data: `~/data/notes/` -- one .md file per note via OS bridge
  - matrix.md: name "Notes", category "productivity", icon notebook emoji

- [ ] T714 [US-PA1] **Todo List** -- `home/apps/todo.html`:
  - Features: add/complete/delete tasks, drag reorder, due dates, categories
  - Data: `~/data/todo/tasks.json` via OS bridge
  - matrix.md: name "Todo", category "productivity", icon check-square emoji

- [ ] T715 [US-PA1] **Pomodoro Timer** -- `home/apps/pomodoro.html`:
  - Features: 25/5 timer, session count, break reminders, sound notification
  - Data: `~/data/pomodoro/sessions.json` via OS bridge
  - matrix.md: name "Pomodoro", category "productivity", icon timer emoji
  - No external dependencies, pure JS timer

### Rich Apps (Components)

- [ ] T716 [US-PA1] **Code Editor** -- `home/apps/code-editor.html`:
  - Embed CodeMirror 6 from CDN (or Monaco Editor)
  - Features: open/edit/save files from `~/apps/`, syntax highlighting, multiple tabs
  - Uses OS bridge for file read/write
  - matrix.md: name "Code Editor", category "dev", icon code emoji
  - Important: this lets users inspect and modify their own apps

- [ ] T717 [US-PA1] **Web Browser** -- `home/apps/browser.html`:
  - Iframe-based web browser with URL bar
  - Features: navigate, back/forward, bookmarks (stored in ~/data/browser/bookmarks.json)
  - Sandbox: iframe with `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`
  - matrix.md: name "Browser", category "utility", icon globe emoji
  - Note: limited by iframe restrictions (CORS, X-Frame-Options)

## Part C: Icon System

- [ ] T718 [US-PA2] Static icon set:
  - `home/system/icons/` directory with SVG icons for common app categories
  - Ship 10-15 icons: document, code, calculator, globe, music, camera, chat, settings, terminal, game, chart, calendar, mail, folder, search
  - matrix.md `icon` field can reference: `icons/document.svg`, emoji string, or external URL

- [ ] T719 [US-PA2] Icon generation skill (fal.ai):
  - Update `home/agents/skills/app-builder.md` to include icon generation step
  - When building new app, generate custom icon via `generate_image` IPC tool
  - Prompt template: "Minimal flat icon for {app_name}, {description}, white background, SVG style, 256x256"
  - Save to `~/apps/{app-name}/icon.png`
  - Requires T661 (image gen). Graceful fallback to emoji if not available.

## Part D: Home Template Update

- [ ] T720 [US-PA1] Update `home/` template:
  - Add all prebuilt apps to `home/apps/`
  - Add matrix.md for each app
  - Add `home/system/icons/` with static icon set
  - Update `home/system/modules.json` to register prebuilt apps
  - First boot: user sees populated desktop with 5-6 working apps

## Implications

- **matrix.md is optional**: apps without it still work. Shell falls back to filename-based naming. This ensures backwards compatibility with existing apps.
- **OS bridge dependency**: prebuilt apps use `window.MatrixOS.readData()` / `writeData()`. This API must be stable. Currently defined in shell Desktop.tsx.
- **CDN dependencies**: Code Editor loads CodeMirror from CDN. Works offline? No. For offline: bundle or ship as node module. V1: CDN is fine.
- **iframe limitations for Browser app**: many sites block iframe embedding. This is a known limitation. App should show clear error when site blocks embedding.
- **App size**: keep each HTML file under 50KB. Inline CSS/JS, no build step. This is the Matrix OS philosophy: simple, transparent, editable files.
- **Future**: app marketplace (021-app-ecosystem) will build on matrix.md for app metadata, discovery, sharing.

## Checkpoint

- [ ] Fresh home directory has 5-6 apps visible in dock with icons.
- [ ] Each app opens, works, persists data.
- [ ] Code Editor can open and edit other apps' source code.
- [ ] `GET /api/apps` returns app list with matrix.md metadata.
- [ ] `bun run test` passes (app-meta parser tests).
