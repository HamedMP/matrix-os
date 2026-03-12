# Spec 043: Quality, UX, and Social

Consolidates remaining work from specs 036, 038, 039, 041 and adds new Chat UX requirements.

## Problem

1. **Chat UX is noisy**: Tool calls show as individual lines ("Edit", "Edit", "Edit" x20) with no context. No grouping, no collapsibility, no file paths shown.
2. **Pre-installed apps are stubs**: Games, calculator, social, profile, messages are placeholder HTML. Not production quality.
3. **Social network doesn't work**: No backend API endpoints. Social/messages/profile apps fetch endpoints that don't exist.
4. **AI-built apps are low quality**: Generated apps lack theming, responsiveness, bridge API integration.
5. **Parallel messages work but responses aren't multiplexed**: User can send while busy, but streaming responses can't be attributed to specific requests.

## Goals

- Every pre-installed app is polished, themed, responsive, and functional
- Social network has working feed, posts, follows, profiles
- Messaging app works with real conversation data
- Chat panel groups tool calls, shows context, supports collapsing
- AI generates high-quality apps with proper Matrix OS integration
- User can send multiple messages and see responses independently
- Game Center hub that auto-discovers games, shows scores, opens games in separate windows
- Apps inherit shell theme dynamically via injected CSS variables
- Design system: guidelines + `@matrix-os/ui` component library for Vite apps
- Vite-built app runtime: scaffold, develop with HMR, build to static files
- Core template sync with file-level versioning (update changed files without overwriting user edits)
- AI Elements components integrated into shell chat (latest from ai-elements registry)
- Matrix OS frontend design skill for AI-built apps (inspired by Claude Code's frontend-design skill)

## Non-Goals

- External platform connectors (X, Instagram, GitHub) - future
- Matrix homeserver deployment (Conduit) - infrastructure
- S3 sync, PostgreSQL addon - infrastructure (spec 040)
- Chromium/VS Code Docker containers - infrastructure
- App marketplace monetization - future
- Skills store / publishing - separate scope
- Full git merge conflict resolution for template sync (Phase B only, git merge is future)

## Architecture

### Chat UX

The ChatPanel renders messages as a flat list. Tool-type messages need to be grouped by assistant turn and rendered as a collapsible block showing count + summary. Each tool call should display: tool name, primary argument (file path for Edit/Read, command for Bash), and status. The group defaults to collapsed, expandable on click.

For parallel responses: each `dispatch()` call tags the kernel with a `requestId`. Kernel events on the WebSocket include this ID. The shell tracks multiple active responses and renders them in separate sections or interleaved with clear attribution.

### Pre-installed Apps

All apps in `home/apps/` are self-contained HTML files served via `/files/apps/`. They must:
- Use CSS custom properties for theming (`--matrix-bg`, `--matrix-fg`, `--matrix-accent`, `--matrix-border`, `--matrix-card-bg`)
- Be responsive (work in 320px-wide windows and full-screen)
- Use `/api/bridge/data` for persistence (scoped by app name)
- Have smooth animations and polished visuals
- Include proper error states and loading states

### Social Network

Gateway gets new routes under `/api/social/` backed by SQLite tables (Drizzle ORM):
- `posts` table: id, authorId, content, type, parentId, createdAt
- `follows` table: followerId, followeeId, createdAt
- `likes` table: userId, postId, createdAt

Social app rebuilt as a polished HTML app that fetches these endpoints. Profile app fetches `/api/profile` + `/api/social/posts?author=`. Messages app uses existing `/api/conversations` endpoints.

### AI App Building

Improved build skills in `home/agents/skills/` that produce apps with:
- matrix.json manifest
- CSS variable theming (inherits OS theme)
- Bridge API persistence
- Responsive layout
- Error handling

### Game Center

The games launcher (`home/apps/games/index.html`) becomes a dynamic Game Center hub. Instead of a hardcoded game list, it fetches `/api/apps?category=games` to discover all games (pre-installed and user-built). Any app with `"category": "games"` in its `matrix.json` auto-appears.

The Game Center displays score summaries per game (fetched from Bridge API), categories/tags, and search. Clicking "Play" sends a `window.MatrixOS.openApp(name, path)` bridge message to the shell, which opens the game in its own window. Multiple games can be open simultaneously (each has a unique path).

New Bridge API method: `window.MatrixOS.openApp(name, path)` - any app can request the shell to open another app. The shell's `AppViewer.tsx` already injects `buildBridgeScript`; we add `openApp` to the postMessage protocol. `useWindowManager` already supports one window per unique path.

Future: leaderboards (cross-game, backed by social API), achievements system, friend challenges.

### Theme Injection & Design System

Apps currently define their own dark theme CSS. This creates inconsistency with the shell's light lavender theme. The fix:

1. **Theme injection**: `AppViewer.tsx` injects a `<style>` tag into each iframe with `--matrix-*` CSS variables derived from the current shell theme. When the user changes theme (via settings or chat), the shell re-injects updated variables via `postMessage`. Apps that use `--matrix-*` variables automatically adapt.

2. **Design system guidelines**: A comprehensive knowledge file (`home/agents/knowledge/matrix-design-system.md`) inspired by Claude Code's frontend-design skill. Covers typography (distinctive fonts, not generic), color (inherit from `--matrix-*`), motion (150-300ms, ease-out enter), spatial composition, and visual details. This guides the AI when building apps.

3. **`@matrix-os/ui` package**: A shared component library for Vite-built apps. Provides Button, Card, Input, Dialog, etc. styled with Matrix OS design tokens. Ships as an internal workspace package (`packages/ui/`). Simple HTML apps use the CSS variables directly; Vite apps can import the component library.

### Vite App Runtime

Games and complex apps should be Vite-built rather than raw HTML. The workflow:

1. **Scaffold**: AI runs `pnpm create vite ~/apps/chess --template react-ts` (or a Matrix OS template)
2. **Develop**: `vite dev` with HMR at a temp port, proxied by gateway
3. **Build**: `vite build` outputs to `~/apps/chess/` as static files (index.html + assets/)
4. **Serve**: Gateway serves the built output via `/files/apps/chess/index.html` as usual

The build skill generates a `vite.config.ts` that outputs to the app directory. The result is indistinguishable from a static HTML app at runtime, but developers get TypeScript, React, hot reload, and `@matrix-os/ui` imports during development.

### Core Template Sync (File-Level Versioning)

Current `syncTemplate()` only adds new files, never updates existing ones. This means bug fixes to skills, improved agent prompts, and new features in existing files never reach users.

**Phase 1 (file-level versioning)**: Add `home/.template-manifest.json` containing a hash for each template file. On boot, `syncTemplate()` compares:
- Template hash unchanged + user file matches old hash = **auto-update** (user hasn't touched it)
- Template hash changed + user file differs from old hash = **skip + log** (user customized it)
- Template hash changed + user file matches old hash = **auto-update** (user hasn't touched it)
- New file not in manifest = **add** (current behavior)

After sync, update the manifest with new hashes. Commit with message `"OS update: {N} files updated, {M} new"`. Log skipped files to `~/system/logs/template-sync.log` so the user knows what they're missing.

**Phase 2 (future)**: Git merge strategy with healer agent resolving conflicts. Template updates come as git commits; `git merge` with `--no-commit`, healer reviews conflicts, applies resolution.

### AI Elements Integration

The shell has 4 custom AI components (message, conversation, tool, code-block). The AI Elements registry (`ai-elements` npm package) has 40+ components we should evaluate. Priority additions:

- **Chatbot**: attachments, chain-of-thought, reasoning, suggestion, prompt-input, sources, plan, task
- **Code**: artifact, file-tree, terminal, test-results, web-preview, sandbox
- **Voice**: speech-input (for voice commands to the OS)

Install via `npx ai-elements@latest` or `shadcn` CLI. Components land in `shell/src/components/ai-elements/` and integrate with the existing Streamdown + Shiki rendering stack.

## Migrated Tasks

From spec 038 (App Platform): T1420-T1427 (games), T1430-T1433 (utilities), T1440-T1445 (build skills)
From spec 039 (App Store): T1490-T1493 (personal websites)
From spec 041 (Social): T1560-T1572 (social core + activity), T1590-T1594 (messaging)
From spec 036 (Builder Speed): T1310-T1315 (domain skills), T1322 (HTML fast path)
