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

## Execution Order

1. **Phase D first** (social backend) - unblocks Phase E
2. **Phase A** (chat UX) - immediate daily UX improvement
3. **Phase B** (games) - highest visual impact, standalone
4. **Phase C** (utility apps) - polish existing apps
5. **Phase E** (social/messaging apps) - connects to Phase D APIs
6. **Phase F** (AI build quality) - improves future app generation

Total: 56 tasks across 6 phases.
