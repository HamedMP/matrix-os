# Spec 038: App Platform

**Goal**: Full-stack app runtime that supports any framework (Next.js, Vite, Python, Rust, etc.), bundles heavyweight desktop apps (Chrome, VS Code), ships polished pre-installed apps and games, and provides an AI skill library for building Matrix OS apps.

**Supersedes**: 021-prebuilt-apps (T710-T725), 024-app-ecosystem Part A/B (T760-T766). Those were hackathon-era stubs; this is the production spec.

## Problem

1. Current apps are HTML-only iframes -- can't run Next.js, Python, Rust, or anything requiring a server process
2. No container-based app runtime -- each app needs its own port, process management, lifecycle
3. No bundled heavyweight apps (browser, IDE) -- users can't browse the web or write code inside Matrix OS
4. Pre-installed apps are basic HTML demos -- not polished enough for virality
5. No agent skills for building Matrix OS apps -- AI doesn't know best practices
6. Skills are only local -- no way to publish, discover, or install community skills

## Solution

### A: Container-Based App Runtime

Each non-trivial app runs in its own container (or process) inside the user's Matrix OS container. This enables any stack:

- **Static apps** (HTML/CSS/JS): served directly by gateway, no container needed (existing behavior)
- **Node apps** (Next.js, Vite, Express): `pnpm dev` or `node server.js` in the app directory, gateway reverse-proxies to the app port
- **Python apps** (Flask, FastAPI, Streamlit): Python process with virtualenv, gateway proxies
- **Rust/Go/compiled**: build step, then run binary, gateway proxies

App manifest (`matrix.json`):
```json
{
  "name": "My Dashboard",
  "runtime": "node",
  "entry": "pnpm dev",
  "port": 3100,
  "framework": "nextjs",
  "permissions": ["network", "database"],
  "resources": { "memory": "256MB", "cpu": 0.5 }
}
```

The gateway's module proxy (`/modules/*`) already reverse-proxies to app ports -- this extends that system with lifecycle management, health checks, and resource limits.

### B: Bundled Desktop Apps

Two heavyweight apps that make Matrix OS feel like a real OS:

**Chromium Browser** (via Kasm/noVNC):
- Full Chromium instance running headless in the container
- Rendered via noVNC/websockify into a Matrix OS window
- Usable by both the user (browsing) and the AI agent (WebMCP, Playwright)
- The AI can "see" what the user sees and help navigate, scrape, fill forms
- Premium feature (resource-heavy: ~500MB RAM)

**VS Code** (via code-server):
- Full VS Code running in the container via `code-server`
- Rendered in an iframe (code-server already provides web UI)
- Connected to the user's `~/matrixos/` file system
- Extensions pre-installed: TypeScript, Python, Markdown, themes
- The AI agent can read/write the same files the user edits

Both register as apps in the dock with full matrix.json manifests.

### C: Pre-Installed Apps and Games

**Core Utilities** (always installed):
- File Manager: browse ~/matrixos/, drag-drop upload
- Calculator: scientific calculator
- Calendar: date picker, events (syncs with cron jobs)
- Clock/Weather: ambient widget

**Polished Games** (for virality):
- Solitaire (Klondike): drag-drop cards, animations, win detection, leaderboard
- Chess: vs AI (stockfish.js) or vs friend (shareable link)
- Backgammon: vs AI, dice physics, doubling cube
- Snake: classic, increasing speed, high score persistence
- 2048: swipe/keyboard, score tracking
- Minesweeper: classic, multiple difficulty levels
- Tetris: standard rules, level progression, ghost piece

Each game: polished animations, sound effects, persistent high scores via bridge API, matrix.json with metadata. Quality bar: "would I play this for 10 minutes?"

**Productivity** (persona-based, see 012-onboarding):
- Notes, Todo, Pomodoro, Budget Tracker (upgraded from 021 HTML versions to React apps)

### D: App Skills for AI Agent

Pre-bundled skills that teach the AI how to build Matrix OS apps:

- `build-for-matrix.md`: Master skill -- matrix.json format, app lifecycle, bridge API, theming, permissions
- `build-nextjs-app.md`: Next.js 16 app scaffold for Matrix OS
- `build-vite-app.md`: Vite + React app scaffold
- `build-python-app.md`: FastAPI/Flask app scaffold
- `build-game.md`: Game development patterns (canvas, p5.js, physics)
- `design-matrix-app.md`: UX/UI guidelines specific to Matrix OS apps (window sizes, theme vars, responsive)

### E: Skills Store

Skills are publishable, discoverable, and installable -- just like apps:

- Skills live in `~/agents/skills/*.md` (existing)
- Publish: `publish_skill` IPC tool pushes skill metadata to the registry
- Install: `install_skill` IPC tool copies skill from registry to local skills directory
- Store UI: browse/search skills in the App Store (shared catalog with apps)
- Categories: app-building, automation, data-processing, communication, custom
- Version: skills have `version` in frontmatter, updates notified

### F: Local Dev Sync

Build apps anywhere, push to Matrix OS:

- **CLI**: `matrix push ./my-app` -- uploads directory to `~/apps/my-app/` via gateway API
- **Git**: user's `~/matrixos/` is a git repo; push to remote triggers app registration
- **Upload**: drag folder into shell or chat; gateway extracts and registers
- **Chat**: paste code into chat; AI installs it as an app
- **API**: `POST /api/apps` with multipart form data

## Non-Goals

- Building a full container orchestrator (use existing Docker/process management)
- Mobile-native app development (apps run server-side, accessed via web)
- Replacing code-server with a custom IDE
- Offline app runtime (VPS-only model)

## Dependencies

- 036-builder-speed: skill system improvements (composable skills, validation)
- 037-kernel-logging: usage tracking for per-app resource billing
- Existing: module proxy in gateway, matrix.md convention (021), OS bridge API

## Success Metrics

- New user sees 10+ polished apps in dock on first boot
- User plays a game within 30 seconds of first login
- AI builds a working Next.js app via chat in under 60 seconds
- Chrome and VS Code open and are usable inside Matrix OS windows
- Community skill installed from store works on first try
