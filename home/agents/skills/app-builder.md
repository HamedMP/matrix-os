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
category: system
tools_needed:
  - read_state
  - Bash
channel_hints:
  - web
---

# App Builder

When the user asks to build an app, this skill enhances the builder agent with conventions:

## Before Building
1. Clarify what the app should do. Ask 1-2 follow-up questions if the request is vague.
2. Decide the app type:
   - **React module** (default): full Vite + React + TypeScript app in `~/modules/<name>/`
   - **HTML app** (simple): single HTML file in `~/apps/<name>.html` for trivial tools
3. Choose an appropriate name: lowercase, hyphenated, descriptive.

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
- Create `~/data/<app-name>/` for app-specific storage
- Use the bridge API (`/api/bridge/data`) for read/write from the app iframe
- Document the data format in a comment or README within the data directory

## Module Registration
After building:
- Add entry to `~/system/modules.json`
- For React modules: `{ "name": "<name>", "type": "react-app", "path": "~/modules/<name>", "status": "active" }`
- For HTML apps: `{ "name": "<name>", "type": "html-app", "path": "~/apps/<name>.html", "status": "active" }`

## Verification
- For React modules: verify `dist/index.html` exists after `pnpm build`
- Read back modules.json to confirm the entry
- Test the app loads at `http://localhost:4000/files/...`

Tips:
- Start simple and iterate. Get a working version first, then add features.
- Prefer React modules for anything interactive or multi-screen.
- Use HTML apps only for single-screen utilities (calculators, clocks, simple widgets).
- If the build fails, read the error output and fix before retrying.
