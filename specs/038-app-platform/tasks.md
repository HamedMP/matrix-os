# Tasks: App Platform

**Spec**: spec.md
**Task range**: T1400-T1459
**Parallel**: Partially -- games (T1420-T1429) are independent of runtime (T1400-T1409). Skills (T1440-T1449) are independent of everything.
**Deps**: Existing module proxy, OS bridge, matrix.md convention

## User Stories

- **US62**: "My Matrix OS runs Next.js, Python, and Rust apps -- not just HTML"
- **US63**: "I can browse the web and write code inside my OS using real Chrome and VS Code"
- **US64**: "I have fun, polished games to play right away -- solitaire, chess, backgammon"
- **US65**: "The AI knows how to build Matrix OS apps properly because it has skills for it"
- **US66**: "I can install skills from other users to teach my AI new things"
- **US67**: "I can build an app on my laptop and push it to my Matrix OS"

---

## Phase A: App Runtime (T1400-T1409)

### Tests (TDD)

- [ ] T1400a [US62] Write `tests/gateway/app-runtime.test.ts`:
  - Parse matrix.json manifest (name, runtime, port, entry, permissions)
  - Validate manifest schema (Zod)
  - Default values for missing fields (runtime: "static", port: auto-assign)
  - App lifecycle: start -> healthy -> stop
  - Module proxy routes to app port correctly

### T1400 [US62] matrix.json manifest schema
- [ ] Create `packages/gateway/src/app-manifest.ts`
- [ ] Zod schema: name, description, runtime (static|node|python|rust|docker), entry, port, framework, permissions, resources
- [ ] `loadAppManifest(appDir)` reads and validates matrix.json
- [ ] Backward compatible with matrix.md (read matrix.md if no matrix.json, convert)
- [ ] Auto-assign port from range 3100-3999 if not specified

### T1401 [US62] App process manager
- [ ] Create `packages/gateway/src/app-manager.ts`
- [ ] `startApp(appDir, manifest)`: spawn process based on runtime type
- [ ] Node: `cd appDir && pnpm install && pnpm dev` (or manifest.entry)
- [ ] Python: `cd appDir && pip install -r requirements.txt && python main.py`
- [ ] Static: no process needed (served by gateway)
- [ ] Health check: poll app port until responding (timeout 30s)
- [ ] `stopApp(appName)`: graceful kill (SIGTERM, then SIGKILL after 5s)
- [ ] Track running apps in memory Map

### T1402 [US62] App lifecycle integration with gateway
- [ ] On gateway boot: scan `~/apps/`, auto-start apps with `autoStart: true` in manifest
- [ ] On file watcher: detect new app directory -> register, optionally start
- [ ] `GET /api/apps`: returns app list with status (running/stopped/error)
- [ ] `POST /api/apps/:name/start` and `POST /api/apps/:name/stop`
- [ ] Module proxy (`/modules/:name/*`) routes to running app port (existing, verify works)

### T1403 [US62] Resource limits
- [ ] Per-app memory limit (manifest.resources.memory, default 256MB)
- [ ] Per-app CPU limit (manifest.resources.cpu, default 0.5)
- [ ] Enforce via `child_process` options or cgroups (if running in Docker)
- [ ] Kill app if exceeding limits, log event, notify user

---

## Phase B: Bundled Desktop Apps (T1410-T1414)

### T1410 [US63] Chromium browser app
- [ ] `home/apps/browser/` directory with matrix.json
- [ ] Runtime: docker (Kasm Chromium image) or native chromium + websockify
- [ ] noVNC client embedded in app HTML (connects to websockify port)
- [ ] Gateway proxies VNC websocket to browser container
- [ ] AI integration: Playwright connects to same Chromium instance for WebMCP
- [ ] matrix.json: `{ "name": "Browser", "runtime": "docker", "image": "kasmweb/chromium", "port": 6901 }`
- [ ] Resource limits: 512MB RAM, 1 CPU

### T1411 [US63] VS Code app (code-server)
- [ ] `home/apps/vscode/` directory with matrix.json
- [ ] Runtime: node (code-server binary)
- [ ] Entry: `code-server --bind-addr 0.0.0.0:3101 --auth none ~/matrixos`
- [ ] Pre-install extensions: TypeScript, Python, Markdown, Git Lens, theme
- [ ] Gateway proxies to code-server port
- [ ] matrix.json: `{ "name": "VS Code", "runtime": "node", "entry": "code-server ...", "port": 3101 }`
- [ ] Resource limits: 512MB RAM, 1 CPU

### T1412 [US63] Desktop app window integration
- [ ] Shell: render noVNC and code-server in resizable, draggable windows
- [ ] Window title from matrix.json name
- [ ] Dock icons for Browser and VS Code
- [ ] Handle keyboard shortcuts (prevent shell shortcuts from capturing IDE/browser keys)

---

## Phase C: Pre-Installed Games (T1420-T1429)

All games: polished UI, animations, sound effects (Web Audio API), persistent high scores via bridge API, matrix.json with metadata. Each is a standalone HTML/JS app in `home/apps/games/`.

### T1420 [US64] Solitaire (Klondike)
- [ ] `home/apps/games/solitaire/index.html`
- [ ] Drag-and-drop cards, auto-complete detection, undo
- [ ] Win animation (cascade), move counter, timer
- [ ] High scores persisted via bridge API
- [ ] Responsive: works on desktop and mobile widths

### T1421 [US64] Chess
- [ ] `home/apps/games/chess/index.html`
- [ ] vs AI: stockfish.js (WASM) with difficulty levels (beginner/intermediate/expert)
- [ ] vs Friend: shareable game link (both players need Matrix OS account)
- [ ] Legal move highlighting, check/checkmate detection, move history
- [ ] Piece drag-and-drop, board flip

### T1422 [US64] Backgammon
- [ ] `home/apps/games/backgammon/index.html`
- [ ] vs AI with 3 difficulty levels
- [ ] Animated dice roll, valid move highlighting, doubling cube
- [ ] Bear-off logic, gammon/backgammon win conditions

### T1423 [US64] Snake
- [ ] `home/apps/games/snake/index.html`
- [ ] Classic grid, increasing speed per food, wall and self collision
- [ ] High score leaderboard (personal + global via platform API)

### T1424 [US64] 2048
- [ ] `home/apps/games/2048/index.html`
- [ ] Keyboard + swipe input, tile merge animations
- [ ] Score tracking, best score persistence, win/lose states

### T1425 [US64] Minesweeper
- [ ] `home/apps/games/minesweeper/index.html`
- [ ] 3 difficulty levels (beginner 9x9, intermediate 16x16, expert 30x16)
- [ ] Right-click flag, chord click, first-click-safe, timer

### T1426 [US64] Tetris
- [ ] `home/apps/games/tetris/index.html`
- [ ] Standard 7-bag randomizer, ghost piece, hold, wall kicks
- [ ] Level progression (speed increase), line clear animations
- [ ] Score system: single/double/triple/tetris multipliers

### T1427 [US64] Game launcher app
- [ ] `home/apps/games/index.html` -- grid view of all games with icons/previews
- [ ] Click to launch game in its own window
- [ ] Shows personal high scores per game
- [ ] matrix.json: `{ "name": "Games", "category": "games" }`

---

## Phase D: Core Utility Apps (T1430-T1434)

### T1430 [US64] File Manager
- [ ] `home/apps/file-manager/index.html`
- [ ] Browse `~/matrixos/` tree via gateway file API
- [ ] Create/rename/delete files and folders
- [ ] Drag-drop upload from desktop
- [ ] File preview (text, images, markdown rendered)
- [ ] Context menu: open with VS Code, open with app

### T1431 [US64] Calculator
- [ ] `home/apps/calculator/index.html`
- [ ] Scientific calculator (trig, log, power, parentheses)
- [ ] Keyboard input, history tape
- [ ] Clean iOS-calculator-inspired design

### T1432 [US64] Calendar
- [ ] `home/apps/calendar/index.html`
- [ ] Month/week/day views
- [ ] Events from cron jobs (`GET /api/cron`)
- [ ] Create events that become cron jobs
- [ ] Today indicator, mini calendar in corner

### T1433 [US64] Weather/Clock widget
- [ ] `home/apps/clock/index.html`
- [ ] Analog + digital clock, timezone support
- [ ] Weather via free API (OpenWeather or wttr.in)
- [ ] Ambient mode: full-screen dark clock

---

## Phase E: AI Skills for App Building (T1440-T1449)

### T1440 [US65] `home/agents/skills/build-for-matrix.md`
- [ ] Master skill: matrix.json format, app lifecycle, bridge API, theming
- [ ] How to register an app, set permissions, choose runtime
- [ ] Common patterns: data persistence, API calls, window communication
- [ ] composable_with: all build-* skills

### T1441 [US65] `home/agents/skills/build-nextjs-app.md`
- [ ] Next.js 16 scaffold for Matrix OS
- [ ] App Router, server components, proxy setup
- [ ] How to connect to Matrix OS bridge API from server components
- [ ] Port assignment, matrix.json for Next.js apps

### T1442 [US65] `home/agents/skills/build-vite-app.md`
- [ ] Vite + React scaffold for Matrix OS
- [ ] HMR configuration, port setup, proxy
- [ ] Theme variable integration

### T1443 [US65] `home/agents/skills/build-python-app.md`
- [ ] FastAPI/Flask scaffold for Matrix OS
- [ ] requirements.txt, virtualenv setup
- [ ] Bridge API access from Python (HTTP calls to gateway)

### T1444 [US65] `home/agents/skills/design-matrix-app.md`
- [ ] UX/UI guidelines for Matrix OS apps
- [ ] Window size constraints, responsive patterns
- [ ] Theme CSS variables, dark/light mode
- [ ] Accessibility requirements

### T1445 [US65] Update `build-game.md` skill
- [ ] Canvas game patterns, physics (matter.js), p5.js
- [ ] Leaderboard integration via bridge API
- [ ] Sound effects (Web Audio API patterns)
- [ ] Touch input for mobile

---

## Phase F: Skills Store (T1450-T1454)

### Tests (TDD)

- [ ] T1450a [US66] Write `tests/kernel/skills-store.test.ts`:
  - publish_skill creates registry entry from local skill file
  - install_skill copies skill from registry to local skills directory
  - Skill versioning: install specific version, upgrade notification
  - Duplicate detection: can't install same skill twice

### T1450 [US66] Skill registry data model
- [ ] Skills in registry: `{ name, version, author, description, category, downloads, content_hash }`
- [ ] Platform API: `GET /api/store/skills`, `GET /api/store/skills/:name`
- [ ] Stored in platform database (Drizzle/SQLite)

### T1451 [US66] publish_skill IPC tool
- [ ] Reads local skill file, extracts frontmatter + body
- [ ] Validates skill format (Zod schema from 036)
- [ ] Pushes to platform registry via API
- [ ] Returns published URL

### T1452 [US66] install_skill IPC tool
- [ ] Fetches skill from registry by name
- [ ] Writes to `~/agents/skills/{name}.md`
- [ ] Adds to local skill index
- [ ] Notifies user of successful install

### T1453 [US66] Skills browse UI (in App Store)
- [ ] Tab in App Store: "Skills" alongside "Apps" and "Games"
- [ ] Grid of available skills with name, description, install count
- [ ] One-click install button
- [ ] "My Skills" section showing installed skills

---

## Phase G: Local Dev Sync (T1460-T1464)

### Tests (TDD)

- [ ] T1460a [US67] Write `tests/gateway/app-upload.test.ts`:
  - POST /api/apps with multipart uploads directory
  - App registered in modules.json after upload
  - Duplicate app name handled (overwrite with confirmation)
  - Invalid manifest rejected with clear error

### T1460 [US67] Upload API
- [ ] `POST /api/apps` -- multipart form data (zip or directory)
- [ ] Extract to `~/apps/{name}/`
- [ ] Validate matrix.json if present
- [ ] Auto-register in modules.json
- [ ] Return app URL

### T1461 [US67] CLI tool (`matrix push`)
- [ ] `packages/cli/` -- small Node.js CLI
- [ ] `matrix push ./my-app` -- zips directory, POSTs to gateway
- [ ] `matrix push ./my-app --name custom-name`
- [ ] Auth: uses MATRIX_AUTH_TOKEN or interactive login
- [ ] Published to npm as `@matrix-os/cli`

### T1462 [US67] Chat-based install
- [ ] User pastes code or attaches files in chat
- [ ] AI detects app intent, creates directory, writes files
- [ ] Registers app and opens in window
- [ ] "Install this app" command in chat

### T1463 [US67] Drag-drop upload in shell
- [ ] Shell: drop zone on desktop area
- [ ] Detect dropped folder/zip
- [ ] Upload via `POST /api/apps`
- [ ] Show progress indicator, open app on completion

---

## Checkpoint

1. [ ] `bun run test` passes with all new tests
2. [ ] Fresh boot: 10+ apps visible in dock (games, utilities, productivity)
3. [ ] Play solitaire for 2 minutes -- smooth, fun, scores persist
4. [ ] Chess vs stockfish.js AI works at 3 difficulty levels
5. [ ] Open Chrome browser inside Matrix OS -- browse google.com
6. [ ] Open VS Code inside Matrix OS -- edit a file, save, see change
7. [ ] AI builds a Next.js app via chat -- opens in window, hot reloads
8. [ ] Install a skill from the store -- AI can use it immediately
9. [ ] `matrix push ./my-app` from laptop -- app appears in Matrix OS
10. [ ] All games have matrix.json manifests with correct metadata
