---
name: app-builder
description: Build apps with theme integration, icons, and data directories
triggers:
  - build app
  - create app
  - make app
  - new app
  - build me
  - webapp
  - build tool
  - create tool
  - make tool
category: system
tools_needed:
  - read_state
  - Bash
channel_hints:
  - web
examples:
  - build me a todo app
  - create an app to track my workouts
  - make a pomodoro timer
  - build a habit tracker
  - create a weather widget
  - make me a budget tool
  - build a recipe manager
  - create a kanban board
  - make a note-taking app
  - build a simple calculator
composable_with:
  - build-react-app
  - build-html-app
---

# App Builder

When the user asks to build an app, this skill enhances the builder agent with conventions:

## Before Building
1. Clarify what the app should do. Ask 1-2 follow-up questions if the request is vague.
2. Decide the app type:
   - **React module** (default): full Vite + React + TypeScript app in `~/modules/<name>/`
   - **HTML app** (simple): single HTML file in `~/apps/<name>.html` for trivial tools
3. Choose an appropriate name: lowercase, hyphenated, descriptive.

## Decision Guide

| Signal | Output Type | Estimated Time |
|--------|------------|----------------|
| Default (no preference) | React module | ~15s |
| Multi-screen, complex state | React module | ~15s |
| Dashboard with charts | React module | ~15s |
| CRUD/data management | React module | ~15s |
| "quick", "simple", "just a..." | HTML app | ~3s |
| Calculator, clock, widget | HTML app | ~3s |
| Game (canvas/p5.js) | HTML app (simple) or React (complex) | ~5-15s |

## Theme Integration
All apps must use CSS custom properties for theming:
- `var(--bg)` -- background color
- `var(--fg)` -- foreground/text color
- `var(--accent)` -- accent/primary color
- `var(--surface)` -- card/surface background
- `var(--border)` -- border color
Set sensible defaults in `:root` for standalone viewing. Support both light and dark themes.

## Data Directory
If the app needs persistent data:
- Use the bridge API (`/api/bridge/data`) for read/write from the app iframe
- Data stored in `~/data/<app-name>/`

## Module Registration
After building:
- Add entry to `~/system/modules.json`
- For React modules: `{ "name": "<name>", "type": "react-app", "path": "~/modules/<name>", "status": "active" }`
- For HTML apps: `{ "name": "<name>", "type": "html-app", "path": "~/apps/<name>.html", "status": "active" }`

## Verification
- For React modules: verify `dist/index.html` exists after `pnpm build`
- Read back modules.json to confirm the entry

## Domain-Specific Skills
For specialized app types, load the companion skill for better guidance:
- **Dashboard/analytics**: load `build-dashboard` for chart patterns
- **CRUD/data management**: load `build-crud-app` for data patterns
- **Games**: load `build-game` for canvas/input/score patterns

Tips:
- Start simple and iterate. Get a working version first, then add features.
- Use `pnpm install --prefer-offline` for faster installs.
- If build fails, read error, fix, rebuild. Max 2 retries before falling back to HTML.
