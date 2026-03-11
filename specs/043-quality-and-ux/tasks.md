# 043: Quality, UX, and Social - Tasks

## Phase A: Chat UX (5 tasks)

- [ ] T2000 - Group tool calls in ChatPanel (collapsible ToolCallGroup component)
- [ ] T2001 - Show tool context (file path for Edit/Read, command preview for Bash)
- [ ] T2002 - Request ID tagging for parallel response multiplexing
- [ ] T2003 - Parallel response rendering in ChatPanel (per-request sections)
- [ ] T2004 - Verify input always sendable during busy + add test

## Phase B: Pre-installed Games (8 tasks)

- [ ] T2010 - Snake: canvas, smooth movement, keyboard+touch, high scores
- [ ] T2011 - 2048: tile animations, merge effects, swipe controls, best score
- [ ] T2012 - Tetris: wall kicks, ghost piece, hold, level system, line clear fx
- [ ] T2013 - Chess: legal moves, minimax AI, check/checkmate, move history
- [ ] T2014 - Solitaire: drag-drop cards, auto-complete, undo, win animation
- [ ] T2015 - Minesweeper: cascade reveal, flagging, difficulty, timer
- [ ] T2016 - Game launcher: grid cards, high scores, responsive
- [ ] T2017 - Backgammon: board, dice animation, AI opponent

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

- [ ] T2030 - Social database schema (posts, follows, likes tables via Drizzle)
- [ ] T2031 - Social API: posts CRUD (GET/POST/DELETE /api/social/posts)
- [ ] T2032 - Social API: feed (GET /api/social/feed, paginated, follow-based)
- [ ] T2033 - Social API: follows (POST/DELETE/GET followers/following)
- [ ] T2034 - Social API: likes (POST toggle, GET likers)
- [ ] T2035 - Social API: user discovery (GET /api/social/users, profiles+stats)
- [ ] T2036 - Activity auto-posting (app creation, game scores -> social posts)
- [ ] T2037 - Social config file (~/system/social-config.json controls)

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

- **Total tasks:** 41
- **Phase A (Chat UX):** 5 tasks
- **Phase B (Games):** 8 tasks
- **Phase C (Utilities):** 8 tasks
- **Phase D (Social Backend):** 8 tasks
- **Phase E (Social Apps):** 6 tasks
- **Phase F (AI Build):** 6 tasks

## Execution Order

D (social backend) -> A (chat UX) -> B (games) -> C (utilities) -> E (social apps) -> F (AI build)
