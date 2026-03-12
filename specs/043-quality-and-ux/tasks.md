# 043: Quality, UX, and Social - Tasks

## Phase A: Chat UX (5 tasks)

- [x] T2000 - Group tool calls in ChatPanel (collapsible ToolCallGroup component)
- [x] T2001 - Show tool context (file path for Edit/Read, command preview for Bash)
- [x] T2002 - Request ID tagging for parallel response multiplexing
- [x] T2003 - Parallel response rendering in ChatPanel (per-request sections)
- [x] T2004 - Verify input always sendable during busy + add test

## Phase B: Pre-installed Games (8 tasks)

- [x] T2010 - Snake: canvas, smooth movement, keyboard+touch, high scores
- [x] T2011 - 2048: tile animations, merge effects, swipe controls, best score
- [x] T2012 - Tetris: wall kicks, ghost piece, hold, level system, line clear fx
- [x] T2013 - Chess: legal moves, minimax AI, check/checkmate, move history
- [x] T2014 - Solitaire: drag-drop cards, auto-complete, undo, win animation
- [x] T2015 - Minesweeper: cascade reveal, flagging, difficulty, timer
- [x] T2016 - Game launcher: grid cards, high scores, responsive
- [x] T2017 - Backgammon: board, dice animation, AI opponent

## Phase C: Core Utility Apps (8 tasks)

- [ ] T2020 - Calculator: standard+scientific, keyboard, history, expression display
- [ ] T2021 - Clock: analog face, stopwatch, timer, world clock
- [ ] T2022 - Notes: sidebar list, markdown editor, search, bridge API persistence
- [ ] T2023 - Todo: inline add, filter, drag-reorder, bridge API persistence
- [ ] T2024 - Pomodoro: circular timer, work/break modes, session history
- [ ] T2025 - Expense tracker: transactions, categories, monthly chart
- [ ] T2026 - Code editor: line numbers, syntax highlighting, find/replace
- [ ] T2027 - File manager: directory listing, preview, create/rename/delete

## Phase D: Social Network Backend (8 tasks)

- [x] T2030 - Social database schema (posts, follows, likes tables via Drizzle)
- [x] T2031 - Social API: posts CRUD (GET/POST/DELETE /api/social/posts)
- [x] T2032 - Social API: feed (GET /api/social/feed, paginated, follow-based)
- [x] T2033 - Social API: follows (POST/DELETE/GET followers/following)
- [x] T2034 - Social API: likes (POST toggle, GET likers)
- [x] T2035 - Social API: user discovery (GET /api/social/users, profiles+stats)
- [x] T2036 - Activity auto-posting (app creation, game scores -> social posts)
- [x] T2037 - Social config file (~/system/social-config.json controls)

## Phase E: Social & Messaging Apps (6 tasks)

- [ ] T2040 - Social app rebuild: feed, compose, post cards, likes, comments, explore
- [ ] T2041 - Messages app rebuild: conversation list, chat bubbles, real-time, send
- [ ] T2042 - Profile app rebuild: identity, stats, user posts, follow button
- [ ] T2043 - Browser app polish: navigation, loading, bookmarks
- [ ] T2044 - Weather widget: Open-Meteo API, forecast, location, cards
- [ ] T2045 - Personal website template: public profile page, responsive, branded

## Phase F: AI App Building Quality (6 tasks)

- [ ] T2050 - Master build skill (build-for-matrix.md): manifest, theming, bridge API
- [ ] T2051 - HTML app skill: single-file pattern, CSS vars, bridge helpers
- [ ] T2052 - Game building skill: canvas/DOM patterns, game loop, scoring
- [ ] T2053 - React/Next.js app skill: Vite scaffold, components, theme
- [ ] T2054 - App generation knowledge file: API reference, examples, quality checklist
- [ ] T2055 - Build pipeline HTML fast path: auto-register, auto-manifest, file watcher

## Phase G: Game Center + Multi-Window (5 tasks)

- [ ] T2060 - openApp bridge method: shell receives postMessage, calls openWindow(name, path)
- [ ] T2061 - Game Center launcher: dynamic discovery via /api/apps?category=games, scores, search
- [ ] T2062 - Game Center categories + filtering: tags in matrix.json, filter UI, sort by recent/popular
- [ ] T2063 - Game Center services foundation: cross-game leaderboard API (/api/games/leaderboard)
- [ ] T2064 - User-built game auto-registration: any app with category=games auto-appears in Game Center

## Phase H: Theme Injection + Design System (7 tasks)

- [ ] T2070 - Theme variable injection: AppViewer injects --matrix-* CSS vars into iframes from shell theme
- [ ] T2071 - Dynamic theme updates: postMessage re-injection when user changes theme (settings or chat)
- [ ] T2072 - Matrix OS design system knowledge file: comprehensive guide for AI app building
- [ ] T2073 - Frontend design skill for Matrix OS: inspired by Claude Code's frontend-design skill
- [ ] T2074 - @matrix-os/ui package: shared component library (Button, Card, Input, Dialog, etc.)
- [ ] T2075 - Migrate existing apps to --matrix-* variables: update all home/apps/ to use injected theme
- [ ] T2076 - Design system docs page: add to www/content/docs/guide/design-system.mdx

## Phase I: Vite App Runtime (5 tasks)

- [ ] T2080 - Vite app scaffold skill: AI creates Vite+React+TS project in ~/apps/{name}/
- [ ] T2081 - Vite dev proxy: gateway proxies Vite dev server during development, serves built output after
- [ ] T2082 - Vite build integration: build command outputs static files to app directory
- [ ] T2083 - Matrix OS Vite template: pre-configured template with @matrix-os/ui, theme vars, bridge API
- [ ] T2084 - Rebuild pre-installed games as Vite apps: migrate games from raw HTML to Vite+React+TS

## Phase J: Core Template Sync (5 tasks)

- [ ] T2090 - Template manifest: generate home/.template-manifest.json with file hashes on release
- [ ] T2091 - Smart syncTemplate: compare hashes, auto-update untouched files, skip customized files
- [ ] T2092 - Sync logging: write skipped/updated files to ~/system/logs/template-sync.log
- [ ] T2093 - Sync notification: kernel notifies user of updates on boot (N updated, M skipped)
- [ ] T2094 - Template version file: home/.matrix-version with semver, shown in /api/system/info

## Phase K: AI Elements + Shell Enhancements (6 tasks)

- [ ] T2100 - Install AI Elements: add ai-elements package, install priority components
- [ ] T2101 - Attachments component: file upload in chat (images, documents)
- [ ] T2102 - Chain-of-thought / reasoning: collapsible thinking display in chat
- [ ] T2103 - Suggestion chips: contextual action suggestions below messages
- [ ] T2104 - Plan + Task components: render structured plans and task lists in chat
- [ ] T2105 - Voice input: speech-input component for voice commands to the OS

---

## Migrated From

| Original Task | Original Spec | New Task | Notes |
|---------------|--------------|----------|-------|
| T1420-T1427 | 038 App Platform | T2010-T2017 | Games, expanded scope |
| T1430-T1433 | 038 App Platform | T2020-T2021, T2027, T2044 | Utilities, expanded |
| T1440-T1445 | 038 App Platform | T2050-T2053 | Build skills |
| T1310-T1315 | 036 Builder Speed | T2050-T2054 | Domain skills, merged |
| T1322 | 036 Builder Speed | T2055 | HTML fast path |
| T1490-T1493 | 039 App Store | T2045 | Personal websites (core only) |
| T1560-T1567 | 041 Social | T2030-T2035, T2040, T2042 | Social core |
| T1570-T1572 | 041 Social | T2036-T2037 | Activity sharing |
| T1590-T1594 | 041 Social | T2041 | Messaging (consolidated) |

## Summary

- **Total tasks:** 69
- **Phase A (Chat UX):** 5 tasks [DONE]
- **Phase B (Games):** 8 tasks [DONE]
- **Phase C (Utilities):** 8 tasks
- **Phase D (Social Backend):** 8 tasks [DONE]
- **Phase E (Social Apps):** 6 tasks
- **Phase F (AI Build):** 6 tasks
- **Phase G (Game Center):** 5 tasks
- **Phase H (Theme + Design System):** 7 tasks
- **Phase I (Vite Runtime):** 5 tasks
- **Phase J (Template Sync):** 5 tasks
- **Phase K (AI Elements):** 6 tasks

## Execution Order

D [DONE] -> A [DONE] -> B [DONE] -> H (theme/design, foundation) -> G (game center) -> C (utilities) -> I (vite runtime) -> E (social apps) -> F (AI build) -> J (template sync) -> K (AI elements)
