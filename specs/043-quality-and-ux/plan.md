# 043: Quality, UX, and Social - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every pre-installed app production-quality, build the social network backend, fix chat UX for tool call grouping and parallel responses, and improve AI app generation.

**Architecture:** Gateway gets new `/api/social/*` routes backed by Drizzle/SQLite. Shell ChatPanel groups tool calls into collapsible turns. All apps use CSS custom properties for theming and `/api/bridge/data` for persistence. Dispatcher tags kernel events with requestId for response multiplexing.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, SQLite, React 19, Next.js 16, Vitest, Zod 4

---

## Phase A: Chat UX (T2000-T2004)

Fix the chat experience: group tool calls, show context, support parallel responses.

**Key files:**
- `shell/src/components/ChatPanel.tsx` - message rendering
- `shell/src/hooks/useChatState.ts` - message state management
- `packages/gateway/src/dispatcher.ts` - request ID tagging
- `packages/gateway/src/server.ts` - WebSocket event routing

### Task T2000: Group tool calls in ChatPanel

**Problem:** 20 individual "Edit" lines with no context. Should be one collapsible group.

**Files:**
- Modify: `shell/src/components/ChatPanel.tsx`
- Create: `shell/src/components/ToolCallGroup.tsx`
- Test: `tests/shell/tool-call-group.test.ts`

**Implementation:**
- In ChatPanel, group consecutive tool-type messages between assistant messages into a `ToolCallGroup`
- ToolCallGroup shows: "{N} tool calls" with expand/collapse toggle
- Each tool call in expanded view shows: icon + tool name + primary arg + status
- Primary arg extraction: Edit/Read -> file path, Bash -> first 60 chars of command, Write -> file path
- Default state: collapsed if > 3 tool calls, expanded if <= 3
- Animation: 150ms ease-out for expand/collapse

### Task T2001: Show tool context in chat messages

**Problem:** Tool calls just show "Edit" with no indication of what file.

**Files:**
- Modify: `shell/src/components/ChatPanel.tsx`
- Modify: `shell/src/hooks/useChatState.ts` (parse tool args from kernel events)

**Implementation:**
- Kernel events already include tool name and input. Parse `tool_start` events to extract:
  - `Edit`: `input.file_path` -> show basename
  - `Read`: `input.file_path` -> show basename
  - `Write`: `input.file_path` -> show basename
  - `Bash`: `input.command` -> show first 60 chars
  - Other: show tool name only
- Store parsed context in message state
- Render as: "Edit calculator/index.html" instead of "Edit"

### Task T2002: Request ID for parallel response multiplexing

**Problem:** WebSocket streams all kernel events without attribution. Can't tell which response belongs to which request.

**Files:**
- Modify: `packages/gateway/src/dispatcher.ts` - add requestId to events
- Modify: `packages/gateway/src/server.ts` - pass requestId in WebSocket messages
- Modify: `shell/src/hooks/useSocket.ts` - parse requestId
- Modify: `shell/src/hooks/useChatState.ts` - track per-request responses
- Test: `tests/gateway/dispatcher-request-id.test.ts`

**Implementation:**
- `dispatch()` generates a `requestId` (nanoid) and includes it in all WebSocket events
- WebSocket event format: `{ type: "kernel_event", requestId, event: { ... } }`
- Shell tracks `activeRequests: Map<string, Message[]>` to separate interleaved responses
- ChatPanel renders responses grouped by request, with clear visual separation

### Task T2003: Parallel response rendering in ChatPanel

**Files:**
- Modify: `shell/src/components/ChatPanel.tsx`
- Modify: `shell/src/hooks/useChatState.ts`

**Implementation:**
- When multiple requests are active, show a tab bar or stacked sections
- Each active response gets its own streaming section
- Completed responses merge into the main conversation flow
- Visual indicator: colored dot or label showing "Response 1", "Response 2"

### Task T2004: Input always sendable during busy

**Files:**
- Verify: `shell/src/components/InputBar.tsx` (already works - send not blocked by busy)
- Test: `tests/shell/input-bar-parallel.test.ts`

**Implementation:**
- Verify InputBar submit is not gated on `busy` state
- Add visual indicator when messages are queued (already shows queue count)
- Ensure WebSocket `message` type correctly creates new dispatch entries

---

## Phase B: Pre-installed Games (T2010-T2017)

Rebuild all 6 games to high quality. Each game must have: smooth animations, score tracking, keyboard + touch controls, responsive layout, CSS variable theming, bridge API persistence for high scores.

**Key patterns:**
- All games are single HTML files in `home/apps/games/{name}/index.html`
- Each has a `matrix.json` manifest
- Use canvas or DOM rendering (no external dependencies)
- Persist high scores via `POST /api/bridge/data` with `app: "games-{name}"`
- Theme via CSS variables: `--matrix-bg`, `--matrix-fg`, `--matrix-accent`

### Task T2010: Snake game

**Files:** `home/apps/games/snake/index.html`
- Canvas-based rendering, smooth movement interpolation
- Arrow keys + WASD + swipe touch controls
- Score display, high score persistence
- Speed increases with score
- Game over screen with restart
- 300+ lines, polished animations

### Task T2011: 2048 game

**Files:** `home/apps/games/2048/index.html`
- Grid-based tile rendering with merge animations
- Slide animations (CSS transforms, 150ms)
- New tile pop-in animation
- Score + best score with persistence
- Keyboard + swipe touch controls
- Win (2048 tile) and game over detection

### Task T2012: Tetris game

**Files:** `home/apps/games/tetris/index.html`
- 10x20 grid, 7 tetrominoes with wall kicks
- Smooth drop animation, ghost piece preview
- Next piece + hold piece display
- Level system (speed increases), line clear animation
- Score: singles/doubles/triples/tetris scoring
- Keyboard + touch (tap rotate, swipe move/drop)

### Task T2013: Chess game

**Files:** `home/apps/games/chess/index.html`
- 8x8 board with piece rendering (Unicode chess symbols or SVG)
- Legal move highlighting, click-to-move
- Basic AI opponent (minimax with alpha-beta, depth 3)
- Check/checkmate/stalemate detection
- Move history panel
- Captured pieces display

### Task T2014: Solitaire (Klondike)

**Files:** `home/apps/games/solitaire/index.html`
- Card rendering with suits and values
- Drag-and-drop between tableau/foundation/stock
- Auto-complete when possible
- Undo support (at least 1 level)
- Win animation
- Move counter + timer

### Task T2015: Minesweeper

**Files:** `home/apps/games/minesweeper/index.html`
- Grid with mine placement (first click safe)
- Left click reveal, right click flag
- Cascade reveal for empty cells
- Difficulty selector (9x9/16x16/30x16)
- Timer + mine counter
- Win/loss detection with mine reveal

### Task T2016: Game launcher

**Files:** `home/apps/games/index.html`
- Grid of game cards with icons, names, descriptions
- Click opens game in same window (iframe or navigation)
- Shows high score for each game
- Responsive grid layout

### Task T2017: Backgammon

**Files:** `home/apps/games/backgammon/index.html`, `home/apps/games/backgammon/matrix.json`
- Board rendering (24 points, bar, off)
- Dice rolling with animation
- Valid move highlighting
- Basic AI opponent
- Doubling cube (optional)

---

## Phase C: Core Utility Apps (T2020-T2027)

Rebuild calculator, clock, and productivity apps to production quality.

### Task T2020: Calculator

**Files:** `home/apps/calculator/index.html`
- Standard + scientific modes toggle
- Keyboard input (numbers, operators, Enter, Escape, Backspace)
- Expression display (shows full expression, not just result)
- History panel (last 20 calculations, persisted via bridge API)
- Smooth button press animations
- Responsive: works in narrow windows

### Task T2021: Clock

**Files:** `home/apps/clock/index.html`
- Analog clock face (canvas, smooth second hand)
- Digital display with date
- Stopwatch tab (start/stop/lap/reset, lap list)
- Timer tab (set time, countdown, alarm sound)
- World clock tab (add timezones)
- Timezone auto-detection

### Task T2022: Notes app

**Files:** `home/apps/notes.html` -> move to `home/apps/notes/index.html` + `matrix.json`
- Sidebar with note list (title + preview + date)
- Markdown editor with live preview toggle
- Create/rename/delete notes
- Persistence via bridge API (`app: "notes"`)
- Search across notes
- Auto-save (debounced 1s)

### Task T2023: Todo app

**Files:** `home/apps/todo.html` -> move to `home/apps/todo/index.html` + `matrix.json`
- Task list with checkbox, title, due date, priority
- Add task inline (Enter to create)
- Filter: All / Active / Completed
- Drag-to-reorder
- Persistence via bridge API
- Subtle animations on complete/delete

### Task T2024: Pomodoro timer

**Files:** `home/apps/pomodoro.html` -> move to `home/apps/pomodoro/index.html` + `matrix.json`
- Large circular timer display
- Work (25min) / Short break (5min) / Long break (15min) modes
- Auto-advance between work and break
- Session counter (pomodoros completed today)
- Notification sound on timer end
- History persistence via bridge API

### Task T2025: Expense tracker

**Files:** `home/apps/expense-tracker.html` -> move to `home/apps/expense-tracker/index.html` + `matrix.json`
- Transaction list (amount, category, date, note)
- Add transaction form
- Category breakdown (pie chart or bar, pure CSS/canvas)
- Monthly summary with total
- Persistence via bridge API
- Filter by category/date range

### Task T2026: Code editor

**Files:** `home/apps/code-editor.html` -> move to `home/apps/code-editor/index.html` + `matrix.json`
- Textarea with monospace font and line numbers
- Syntax highlighting for common languages (basic regex-based)
- File open/save via bridge API
- Tab size toggle (2/4 spaces)
- Dark theme by default (respects OS theme)
- Find/replace

### Task T2027: File manager

**Files:** Create `home/apps/file-manager/index.html` + `matrix.json`
- Directory listing from `/files/` API
- Navigate folders (breadcrumb path)
- File preview (text, images, JSON)
- Create file/folder
- Rename/delete with confirmation
- Grid and list view toggle

---

## Phase D: Social Network Backend (T2030-T2037)

Build the social API endpoints in the gateway, backed by Drizzle/SQLite.

### Task T2030: Social database schema

**Files:**
- Create: `packages/gateway/src/social-schema.ts`
- Modify: `packages/gateway/src/db.ts` (add social tables)
- Test: `tests/gateway/social-schema.test.ts`

**Tables:**
- `social_posts`: id, authorHandle, content, type (text/image/link/activity), parentId (for comments), createdAt
- `social_follows`: id, followerHandle, followeeHandle, createdAt (unique constraint)
- `social_likes`: id, userHandle, postId, createdAt (unique constraint)

### Task T2031: Social API - Posts

**Files:**
- Modify: `packages/gateway/src/server.ts` (add routes)
- Create: `packages/gateway/src/social.ts` (business logic)
- Test: `tests/gateway/social-posts.test.ts`

**Endpoints:**
- `GET /api/social/posts` - list posts (query: ?author=, ?type=, ?limit=, ?offset=)
- `GET /api/social/posts/:id` - single post with comments
- `POST /api/social/posts` - create post `{ content, type?, parentId? }`
- `DELETE /api/social/posts/:id` - delete own post

### Task T2032: Social API - Feed

**Files:**
- Modify: `packages/gateway/src/social.ts`
- Test: `tests/gateway/social-feed.test.ts`

**Endpoints:**
- `GET /api/social/feed` - posts from followed users, reverse chronological, paginated
- Falls back to recent posts from all users if no follows

### Task T2033: Social API - Follows

**Files:**
- Modify: `packages/gateway/src/social.ts`
- Test: `tests/gateway/social-follows.test.ts`

**Endpoints:**
- `POST /api/social/follows` - follow user `{ handle }`
- `DELETE /api/social/follows/:handle` - unfollow
- `GET /api/social/followers/:handle` - list followers
- `GET /api/social/following/:handle` - list following

### Task T2034: Social API - Likes

**Files:**
- Modify: `packages/gateway/src/social.ts`
- Test: `tests/gateway/social-likes.test.ts`

**Endpoints:**
- `POST /api/social/posts/:id/like` - toggle like
- `GET /api/social/posts/:id/likes` - list likers

### Task T2035: Social API - User discovery

**Files:**
- Modify: `packages/gateway/src/social.ts`
- Test: `tests/gateway/social-users.test.ts`

**Endpoints:**
- `GET /api/social/users` - list users (from platform or local handles)
- `GET /api/social/users/:handle` - user profile + stats (post count, follower count)

### Task T2036: Activity auto-posting

**Files:**
- Create: `packages/gateway/src/social-activity.ts`
- Modify: `packages/gateway/src/dispatcher.ts` (hook after kernel completes app creation)
- Test: `tests/gateway/social-activity.test.ts`

**Implementation:**
- After kernel creates/modifies an app, auto-post activity: "Built {app name}"
- After game high score (bridge API write for games-*), auto-post: "Scored {score} in {game}"
- Configurable via `~/system/social-config.json` (share_app_publishes, share_game_scores, etc.)

### Task T2037: Social config file

**Files:**
- Create: `home/system/social-config.json`
- Modify: `packages/gateway/src/social.ts` (read config)

**Default config:**
```json
{
  "share_app_publishes": true,
  "share_game_scores": true,
  "share_ai_activity": false,
  "auto_post_frequency": "normal"
}
```

---

## Phase E: Social & Messaging Apps (T2040-T2045)

Rebuild the social, messages, and profile apps to connect to real APIs.

### Task T2040: Social app rebuild

**Files:** `home/apps/social/index.html` (complete rewrite, ~500+ lines)
- Feed tab: fetch `/api/social/feed`, render post cards, infinite scroll
- Compose: textarea + post button, calls `POST /api/social/posts`
- Post card: avatar, handle, timestamp, content, like/comment/share buttons
- Like: calls `POST /api/social/posts/:id/like`, updates count optimistically
- Comments: expand to show, inline reply
- Explore tab: fetch `/api/social/posts` (all), trending section
- Profile tab: fetch own posts, follower/following counts

### Task T2041: Messages app rebuild

**Files:** `home/apps/messages/index.html` (complete rewrite, ~400+ lines)
- Conversation list: fetch `/api/conversations`, show last message preview
- Chat view: fetch conversation messages, render bubbles
- Send message: post to WebSocket or `/api/message`
- Real-time: connect to `/ws` for incoming messages
- New conversation button
- Search conversations

### Task T2042: Profile app rebuild

**Files:** `home/apps/profile/index.html` (complete rewrite, ~300+ lines)
- Fetch `/api/identity` for handle, display name, avatar
- Fetch `/api/social/users/:handle` for stats (posts, followers, following)
- Fetch `/api/social/posts?author=handle` for user's posts
- Edit profile button (opens chat with "update my profile" prompt)
- Published apps section (fetch `/api/apps` filtered by author)
- Follow/unfollow button for other users' profiles

### Task T2043: Browser app polish

**Files:** `home/apps/browser/index.html`
- URL bar with proper navigation (Enter to go)
- Back/forward/refresh buttons that work
- Loading indicator
- Bookmarks bar (persisted via bridge API)
- Handle iframe security gracefully (show error for blocked sites)

### Task T2044: Weather/Clock widget

**Files:** Create `home/apps/weather/index.html` + `matrix.json`
- Current weather from free API (Open-Meteo, no key needed)
- 5-day forecast
- Location auto-detect or search
- Hourly breakdown
- Clean card-based layout

### Task T2045: Personal website template

**Files:** `home/apps/profile/index.html` (already serves as personal website)
- When accessed publicly (not logged in), show polished profile page
- Name, avatar, bio, links, published apps
- Clean typography, responsive
- Matrix OS branding in footer

---

## Phase F: AI App Building Quality (T2050-T2055)

Improve the skills and prompts that generate apps when users ask the AI to build things.

### Task T2050: Master build skill

**Files:** `home/agents/skills/build-for-matrix.md`
- Matrix.json manifest generation
- CSS variable theming (inherit from OS)
- Bridge API for persistence
- Responsive layout patterns
- Error states and loading states
- Keyboard shortcuts

### Task T2051: HTML app skill

**Files:** `home/agents/skills/build-html-app.md`
- Single-file HTML app pattern
- Inline CSS with CSS custom properties
- Inline JS with bridge API helpers
- Template: DOCTYPE, viewport meta, font stack, theme variables
- Quality checklist: responsive, themed, accessible, animated

### Task T2052: Game building skill

**Files:** `home/agents/skills/build-game.md`
- Canvas or DOM game patterns
- Game loop (requestAnimationFrame)
- Input handling (keyboard + touch)
- Score tracking + high score persistence
- Game states (menu, playing, paused, game over)
- Sound effects (Web Audio API, optional)

### Task T2053: React/Next.js app skill

**Files:** `home/agents/skills/build-react-app.md`
- Vite or Next.js scaffolding
- Component patterns for Matrix OS
- Data fetching from bridge API
- Theme integration
- Module registration in modules.json

### Task T2054: App generation knowledge file

**Files:** `home/agents/knowledge/app-generation.md`
- Reference for all available APIs (bridge, files, social, conversations)
- CSS variable reference
- matrix.json schema reference
- Example apps (links to pre-installed apps as reference)
- Quality standards checklist

### Task T2055: Build pipeline - HTML fast path

**Files:**
- Modify: `packages/kernel/src/ipc-server.ts` (optimize write_file for apps/)
- Modify: gateway file watcher to auto-register new apps

**Implementation:**
- When kernel writes to `apps/{name}.html` or `apps/{name}/index.html`, auto-create matrix.json if missing
- Auto-add to `/api/apps` listing without restart
- File watcher triggers shell notification: "New app: {name}"

---

## Phase G: Game Center + Multi-Window (T2060-T2064)

Turn the static games launcher into a dynamic Game Center hub. Enable multi-window app launching.

**Key files:**
- `shell/src/lib/os-bridge.ts` - bridge protocol
- `shell/src/components/AppViewer.tsx` - bridge script injection
- `shell/src/hooks/useWindowManager.ts` - window opening
- `shell/src/components/Desktop.tsx` - app launching
- `home/apps/games/index.html` - Game Center UI
- `packages/gateway/src/apps.ts` - app discovery

### Task T2060: openApp bridge method

**Problem:** Games launcher navigates within its own iframe (`window.location.href`). Need to open games in separate windows.

**Files:**
- Modify: `shell/src/lib/os-bridge.ts` (add `openApp` to bridge protocol)
- Modify: `shell/src/components/AppViewer.tsx` (handle `os:open-app` postMessage)
- Modify: `shell/src/components/Desktop.tsx` (expose `openWindow` to AppViewer handler)
- Test: `tests/shell/os-bridge-open-app.test.ts`

**Implementation:**
- Add `window.MatrixOS.openApp(name, path)` to the bridge script injected into iframes
- When called, sends `postMessage({ type: 'os:open-app', payload: { name, path } })`
- AppViewer listens for this message, calls `openWindow(name, path)` on the Desktop
- Shell's `useWindowManager` already prevents duplicate windows per path

### Task T2061: Game Center launcher rebuild

**Problem:** Hardcoded game list. No dynamic discovery.

**Files:**
- Rewrite: `home/apps/games/index.html` (~400 lines)
- Test: verify with `/api/apps?category=games`

**Implementation:**
- Fetch `/api/apps?category=games` on load to discover all games
- Grid cards: icon, name, description, best score (fetched from bridge API per game)
- Click "Play" calls `window.MatrixOS.openApp(gameName, gamePath)` to open in own window
- Search/filter bar at top
- "Recently Played" section (track in bridge API `app: "game-center"`)
- Responsive: 1-4 columns depending on window width
- Empty state if no games: "No games installed. Ask your AI to build one!"

### Task T2062: Game Center categories + filtering

**Files:**
- Modify: `home/apps/games/index.html`
- Modify: game `matrix.json` files (add `tags` field)

**Implementation:**
- Add `"tags": ["puzzle", "board", "arcade", "strategy"]` to matrix.json schema
- Category filter tabs: All, Puzzle, Board, Arcade, Strategy
- Sort: A-Z, Recently Played, Highest Score
- Tag display on game cards

### Task T2063: Game Center leaderboard API

**Files:**
- Create: `packages/gateway/src/leaderboard.ts`
- Modify: `packages/gateway/src/server.ts` (add routes)
- Test: `tests/gateway/leaderboard.test.ts`

**Endpoints:**
- `GET /api/games/leaderboard` - cross-game leaderboard (aggregated from bridge data)
- `GET /api/games/leaderboard/:game` - per-game leaderboard
- Reads from `~/data/games-*/best.json` files

### Task T2064: User-built game auto-registration

**Implementation:**
- When kernel writes an app with `"category": "games"` in manifest, it auto-appears in Game Center
- File watcher already triggers app list refresh
- Game Center polls `/api/apps?category=games` or listens for watcher events
- Auto-post to social: "Built a new game: {name}"

---

## Phase H: Theme Injection + Design System (T2070-T2076)

Foundation for consistent, beautiful apps. Theme injection makes apps adapt to user's theme. Design system guides AI and human developers.

**Key files:**
- `shell/src/components/AppViewer.tsx` - iframe injection
- `shell/src/app/globals.css` - shell CSS variables
- `home/agents/knowledge/` - AI knowledge files
- `home/agents/skills/` - AI build skills

### Task T2070: Theme variable injection into iframes

**Problem:** Apps define their own dark theme. Shell is light lavender. No connection between them.

**Files:**
- Modify: `shell/src/components/AppViewer.tsx` (inject theme style tag)
- Modify: `shell/src/lib/os-bridge.ts` (add theme to bridge script)
- Test: `tests/shell/theme-injection.test.ts`

**Implementation:**
- Read current theme from shell CSS variables (getComputedStyle on :root)
- Build a `<style>` tag with `:root { --matrix-bg: ...; --matrix-fg: ...; ... }`
- Variables: `--matrix-bg`, `--matrix-fg`, `--matrix-accent`, `--matrix-border`, `--matrix-card-bg`, `--matrix-card-fg`, `--matrix-input-bg`, `--matrix-font-sans`, `--matrix-font-mono`, `--matrix-radius`
- Inject into iframe via `buildBridgeScript()` (append style element to head)
- Also expose `window.MatrixOS.theme` object with current values

### Task T2071: Dynamic theme updates via postMessage

**Files:**
- Modify: `shell/src/components/AppViewer.tsx`
- Modify: `shell/src/lib/os-bridge.ts`

**Implementation:**
- When shell theme changes (user picks preset, or AI changes via chat), broadcast `{ type: 'os:theme-update', payload: themeVars }` to all open app iframes
- Bridge script listens and updates the injected `<style>` tag
- Apps using `var(--matrix-*)` automatically re-render with new colors

### Task T2072: Matrix OS design system knowledge file

**Files:** Create `home/agents/knowledge/matrix-design-system.md`

**Content (~300 lines):**
- CSS variable reference (all `--matrix-*` vars with descriptions)
- Color system: primary, accent, semantic (success/warning/error), surface hierarchy
- Typography: recommended fonts (distinctive, not generic), scale, weights
- Spacing: 4px grid, standard sizes (xs=4, sm=8, md=16, lg=24, xl=32)
- Layout patterns: card grids, sidebars, overlays, responsive breakpoints
- Animation: timing (150ms enter, 100ms exit), easing (ease-out/ease-in), transform-only
- Component patterns: buttons, inputs, cards, modals, empty states, loading states
- Accessibility: focus visible, touch targets 44x44, contrast 4.5:1
- Bridge API integration patterns
- Anti-patterns: don't use generic fonts, don't hardcode colors, don't skip animations

### Task T2073: Matrix OS frontend design skill

**Files:** Create `home/agents/skills/design-matrix-frontend.md`

Inspired by Claude Code's `frontend-design` skill. The skill the AI uses when building any UI for Matrix OS.

**Content:**
- Design thinking: purpose, tone, constraints, differentiation
- Matrix OS aesthetic: warm, organic, distinctive (NOT generic AI slop)
- Typography: characterful font choices, pair display + body fonts
- Color: inherit from `--matrix-*`, dominant + accent strategy
- Motion: orchestrated page load, staggered reveals, scroll-triggered
- Spatial composition: asymmetry, overlap, generous negative space
- Visual details: gradients, textures, patterns, glass-morphism
- Quality checklist: responsive, themed, accessible, animated, empty states
- Anti-patterns: no Inter/Roboto defaults, no purple gradients, no cookie-cutter layouts

### Task T2074: @matrix-os/ui component library

**Files:**
- Create: `packages/ui/` workspace package
- Create: `packages/ui/src/` (Button, Card, Input, Dialog, Badge, Tooltip, Select, Tabs)
- Create: `packages/ui/package.json`
- Modify: `pnpm-workspace.yaml` (add packages/ui)

**Implementation:**
- Workspace package: `@matrix-os/ui`
- Components built on Radix primitives + Tailwind (same as shell's shadcn components)
- Exports themed components that use `--matrix-*` CSS variables
- Vite apps import: `import { Button, Card } from '@matrix-os/ui'`
- Ships with a `styles.css` that defines the variable defaults

### Task T2075: Migrate existing apps to --matrix-* variables

**Files:** All files in `home/apps/`

**Implementation:**
- Replace hardcoded `--bg: #0a0a0a` etc. with `--matrix-bg` fallbacks:
  `background: var(--matrix-bg, #0a0a0a)`
- This way apps work standalone (fallback) AND adapt when theme is injected
- Update `design-matrix-app.md` skill to reference new variable names
- Test: open apps with different theme presets, verify colors change

### Task T2076: Design system documentation page

**Files:** Create `www/content/docs/guide/design-system.mdx`

**Content:**
- CSS variable reference table
- Color palette with swatches
- Typography scale
- Component gallery (screenshots of Button, Card, Input, etc.)
- Code examples for common patterns
- Link to knowledge file and skill

---

## Phase I: Vite App Runtime (T2080-T2084)

Enable Vite-built apps: full TypeScript + React + HMR during development, static output at runtime.

### Task T2080: Vite app scaffold skill

**Files:** Create `home/agents/skills/scaffold-vite-app.md`

**Content:**
- Triggers: "build a react app", "create a vite app", "scaffold app with typescript"
- Steps: create directory, init Vite+React+TS, add @matrix-os/ui, configure build output
- `vite.config.ts` template: `build.outDir` points to `~/apps/{name}/`, `base: '/files/apps/{name}/'`
- matrix.json generation with `"runtime": "vite"`
- Bridge API client setup

### Task T2081: Vite dev proxy in gateway

**Files:**
- Modify: `packages/gateway/src/server.ts` (add dev proxy route)
- Modify: `packages/gateway/src/apps.ts` (detect running Vite dev servers)

**Implementation:**
- When an app has `"runtime": "vite"` and a dev server is running, proxy to it
- Detect via `~/apps/{name}/.vite-dev-port` file (Vite writes port on start)
- Gateway route: `/dev/apps/{name}/*` -> `http://localhost:{port}/*`
- AppViewer uses dev URL when available, falls back to built static files

### Task T2082: Vite build integration

**Files:**
- Create: `packages/gateway/src/vite-build.ts`
- Test: `tests/gateway/vite-build.test.ts`

**Implementation:**
- IPC tool: `build_app { name }` - runs `vite build` in app directory
- Output goes to same directory (in-place build): `~/apps/{name}/index.html` + `~/apps/{name}/assets/`
- Auto-runs on kernel "deploy" or "build" commands
- Cleans dev artifacts (.vite-dev-port, node_modules not needed at runtime)

### Task T2083: Matrix OS Vite template

**Files:** Create `home/templates/vite-app/` (template directory)

**Contents:**
- `vite.config.ts` - configured for Matrix OS (base path, build output)
- `src/main.tsx` - entry with @matrix-os/ui provider
- `src/App.tsx` - starter component
- `src/bridge.ts` - typed Bridge API client
- `package.json` - dependencies (@matrix-os/ui, react, vite)
- `tsconfig.json` - strict mode
- `matrix.json` - manifest template

### Task T2084: Migrate pre-installed games to Vite

**Files:** All `home/apps/games/*/`

**Implementation:**
- Convert each game from single HTML to Vite+React+TS project
- Use @matrix-os/ui components where appropriate (buttons, dialogs, cards)
- Build output replaces current HTML files
- Same functionality, better code organization, TypeScript, shared design tokens
- NOTE: this is a large task, can be done incrementally (1-2 games first as proof of concept)

---

## Phase J: Core Template Sync (T2090-T2094)

File-level versioning so existing users get core updates without losing customizations.

### Task T2090: Template manifest generation

**Files:**
- Create: `home/.template-manifest.json`
- Modify: `packages/kernel/src/boot.ts` (read manifest)
- Test: `tests/kernel/template-manifest.test.ts`

**Implementation:**
- Script/function: walk `home/` directory, compute SHA-256 hash for each file
- Output: `{ "system/soul.md": "abc123...", "agents/skills/weather.md": "def456...", ... }`
- Run as part of release process (or auto-generate on boot if missing)
- Exclude: `.gitkeep`, `node_modules/`, `.DS_Store`

### Task T2091: Smart syncTemplate with hash comparison

**Files:**
- Modify: `packages/kernel/src/boot.ts` (rewrite syncTemplate)
- Test: `tests/kernel/smart-sync.test.ts`

**Implementation:**
- Load `home/.template-manifest.json` (template hashes) and `~/.template-manifest.json` (installed hashes)
- For each template file:
  - Compute current user file hash
  - If user hash matches installed hash (untouched): update file + update installed hash
  - If user hash differs from installed hash (customized): skip, log to sync report
  - If file not in installed manifest (new): add file, add to installed manifest
- Write updated `~/.template-manifest.json`
- Commit: `"OS update: {N} files updated, {M} new, {S} skipped (customized)"`

### Task T2092: Template sync logging

**Files:**
- Modify: `packages/kernel/src/boot.ts`
- Test: verify log output

**Implementation:**
- Write sync report to `~/system/logs/template-sync.log` (append, timestamped)
- Format: `[2026-03-12T10:00:00Z] Updated: agents/skills/weather.md (v1.0->v1.1)`
- Format: `[2026-03-12T10:00:00Z] Skipped: system/soul.md (customized by user)`
- Format: `[2026-03-12T10:00:00Z] Added: agents/skills/new-skill.md`

### Task T2093: Sync notification to user

**Files:**
- Modify: `packages/gateway/src/main.ts` (emit sync summary on boot)
- Modify: shell (show notification on connect if updates happened)

**Implementation:**
- After `ensureHome()`, if sync performed updates, store summary in `~/system/last-sync.json`
- Gateway sends sync summary via WebSocket on client connect: `{ type: "os:sync-report", ... }`
- Shell shows a non-intrusive toast: "OS updated: 3 files updated, 1 skipped"
- Click toast to see details (which files, what changed)

### Task T2094: Template version file

**Files:**
- Create: `home/.matrix-version` (contains semver, e.g., `0.4.0`)
- Modify: `packages/gateway/src/server.ts` (`/api/system/info` includes template version)

**Implementation:**
- `.matrix-version` in template root, updated on each release
- `~/` copy tracks installed version
- `/api/system/info` returns both `templateVersion` (latest) and `installedVersion` (user's)
- If mismatch, UI can show "Update available" indicator

---

## Phase K: AI Elements + Shell Enhancements (T2100-T2105)

Integrate modern AI chat components from the ai-elements registry.

### Task T2100: Install AI Elements package

**Files:**
- Modify: `shell/package.json`
- Run: `npx ai-elements@latest` in shell/
- Verify: components land in `shell/src/components/ai-elements/`

**Implementation:**
- Install the `ai-elements` package
- Compare with our 4 existing custom components (message, conversation, tool, code-block)
- Keep our custom implementations where they're better (Streamdown integration)
- Add new components that don't conflict

### Task T2101: Attachments component

**Files:**
- Install: `npx ai-elements add attachments` (or manual)
- Modify: `shell/src/components/InputBar.tsx` (add file upload button)

**Implementation:**
- Add file upload button to InputBar (paperclip icon)
- Attachments preview row above input
- Files uploaded to `~/uploads/` via bridge API
- Reference in message payload for kernel processing

### Task T2102: Chain-of-thought / reasoning display

**Files:**
- Install: reasoning, chain-of-thought components
- Modify: `shell/src/components/ChatPanel.tsx`

**Implementation:**
- Detect `thinking` blocks in assistant responses
- Render as collapsible "Thinking..." section (collapsed by default)
- Expand to show reasoning steps
- Integrate with existing ToolCallGroup for a unified "process" view

### Task T2103: Suggestion chips in chat

**Files:**
- Install: suggestion component
- Modify: `shell/src/components/ChatPanel.tsx`
- Modify: `shell/src/components/InputBar.tsx`

**Implementation:**
- After assistant response, show contextual suggestion chips
- Kernel can include `suggestions: string[]` in response metadata
- Clicking a chip sends that text as a new message
- Examples: "Show me the code", "Run tests", "Deploy this"

### Task T2104: Plan + Task components

**Files:**
- Install: plan, task components
- Modify: `shell/src/components/ChatPanel.tsx`

**Implementation:**
- Render structured plans as interactive checklists (not just markdown)
- Task components show status (pending/in-progress/done) with progress
- Integrate with Mission Control task board for consistency

### Task T2105: Voice input component

**Files:**
- Install: speech-input component
- Modify: `shell/src/components/InputBar.tsx`

**Implementation:**
- Microphone button in InputBar
- Web Speech API for transcription
- Visual feedback (waveform or pulsing indicator)
- Transcribed text goes into input field for review before sending
- Future: direct voice-to-kernel pipeline

---

## Execution Order

1. **Phase D** [DONE] (social backend) - unblocks Phase E
2. **Phase A** [DONE] (chat UX) - immediate daily UX improvement
3. **Phase B** [DONE] (games) - highest visual impact, standalone
4. **Phase H** (theme + design system) - FOUNDATION for everything else
5. **Phase G** (game center) - depends on H for theme injection + openApp bridge
6. **Phase C** (utility apps) - polish existing apps with new design system
7. **Phase I** (vite runtime) - enables higher-quality future apps
8. **Phase E** (social/messaging apps) - connects to Phase D APIs
9. **Phase F** (AI build quality) - improves future app generation with new skills
10. **Phase J** (template sync) - infrastructure, independent
11. **Phase K** (AI elements) - shell enhancements, independent

Total: 69 tasks across 11 phases (18 done, 51 remaining).
