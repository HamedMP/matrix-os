# Spec 083 — World-Class Default Apps

## Goal

Every Matrix OS default app should feel like a serious standalone product — indistinguishable in
polish and depth from its named benchmark competitor. No mock UI, no placeholder metrics, no generic
dashboards. Real interaction models, Matrix-owned Postgres persistence where appropriate, the light
Matrix product language, keyboard support, and tests.

## How this is built

A swarm of agents, one per app, each owning a disjoint app directory. Shared coordination files
(`home/apps/_shared/default-apps.tsx` mock renderer, `theme.css`, manifest tests, shell wiring) are
owned by the lead and reconciled after agents land. Every agent reads `agent-brief.md` first.

`default-apps.tsx` is a **temporary mock fallback renderer** with fake metrics. As each real app ships
(real `src/App.tsx` + build), the lead removes that app from the mock registry so the real build serves.

## Quality gates (enforced by `tests/default-apps/manifest-quality.test.ts`)

Every `home/apps/**/matrix.json` (excluding `_*` templates and build output) must:
1. set `runtime: "vite"` with a `build` block whose `output` is `dist`;
2. declare a `slug` matching its directory and an `icon` slug that has a shipped
   `home/system/icons/<icon>.(svg|png)`;
3. if the app is in the durable-data set below, declare a non-empty `storage.tables`.

## App-by-app product briefs

Format: **slug** — benchmark → what "world-class" means here. (DB = durable Postgres tables.)

### Productivity core
- **notes** — Notion + OneNote. Document workspace: sidebar doc list (pinned + search + tags), rich
  block editor (existing Tiptap), markdown/source toggle, slash-command affordance, autosave, page
  metadata, conflict-safe persistence. DB: `notes(title text, content text, content_json jsonb, pinned boolean, tags text)`.
- **task-manager** — Trello / Linear boards. Columns + draggable cards, labels, due dates, checklist,
  filters, board persisted. DB: board/columns/cards (see existing `task-board-model.ts`).
- **todo** — Things 3 / Todoist. Fast inbox capture (Enter to add), Today/Upcoming/Projects, priorities,
  recurring tasks, keyboard-first. DB: `tasks(title text, notes text, due timestamptz, priority integer, project text, status text, recur text)`.
- **expense-tracker** — Monarch / Copilot / YNAB. Spend dashboard (month total, by-category breakdown),
  transaction list with add/edit/delete, categories, monthly budgets, recurring bills. DB:
  `expenses(amount float, category text, note text, spent_at timestamptz, recurring boolean)`,
  `budgets(category text, monthly_limit float)`.

### Games (real rule engines + animations + persisted best scores)
- **2048** — classic 2048. Real 4x4 merge engine, keyboard + swipe, tile spawn/merge animation, best
  score. DB: `scores(score integer, best integer)` or KV for best score.
- **snake** — Google Snake / Nokia. Keyboard control, growth, self/wall collision, speed levels, high score.
- **tetris** — Tetris Guideline. 10x20 grid, 7-bag randomizer, SRS-ish rotation, line clears, next queue,
  score/level/lines, gravity. Hold piece optional.
- **minesweeper** — Windows Minesweeper. Real reveal/flood-fill, flagging, difficulty selector, timer,
  mine counter, first-click safety, best times per difficulty.
- **chess** — Lichess / Chess.com. Use `chess.js` for legal-move generation/validation, board with
  coordinates, click/drag moves, move history (SAN), captured pieces, check/checkmate/stalemate, local
  two-player. (AI optional/deferred.)
- **solitaire** — Microsoft Solitaire. Klondike rules, draw pile, foundations, tableau, click/drag moves,
  undo, auto-complete, win detection, stats.
- **backgammon** — Backgammon Galaxy. Legal-move engine, dice, bearing off, hit/bar, local two-player,
  match/pip display. (Doubling cube deferred.)

### Utilities
- **calculator** — Numi / Soulver / PCalc. Expression evaluation with history rail, keyboard input,
  copy result, clear/delete, scientific mode toggle. Persist history (DB `history(expression text, result text)` or KV).
- **clock** — Apple Clock. Tabs: World clock (timezone search + saved zones), Alarms, Timer(s),
  Stopwatch with laps. Persist alarms/timers/zones. DB or KV.
- **weather** — Apple Weather / Carrot. Current conditions, hourly + daily forecast, saved locations,
  expressive visual weather state. Use Open-Meteo (no API key) via the bridge fetch with
  `AbortSignal.timeout`; graceful offline/demo fallback with seeded data. Persist saved locations.
- **whiteboard** — Excalidraw / FigJam. Freehand draw, sticky notes, shapes (rect/ellipse/arrow/line),
  text, select/move/delete, color, undo/redo, export PNG. Persist scene (DB jsonb or KV).

### Platform / identity
- **symphony** — Linear / Retool dev control surface. Already a real Vite app; elevate to a polished
  developer/integration dashboard: action status, connected services, logs, safe admin controls.
  Respect existing routes/integrations; do not regress wiring.
- **games** (Game Center) — Apple Arcade / Steam Library. Game library grid with per-game icons, recently
  played, best scores/achievements pulled from each game's DB/KV, launch cards (`window.MatrixOS.openApp`).
- **profile** — Linear / GitHub profile. Identity card (handle, avatar, bio), connected services,
  privacy/export controls. Reads Matrix identity; edits persist.
- **social** — Bluesky / Threads / Slack activity. Local feed, compose, reactions, app publish/activity
  cards. Matrix-owned social schema.

## Out of scope here (builtins / kernel, not iframe apps)
- **Workspace** (`__workspace__`) is a shell builtin (tldraw canvas), not an `home/apps/*` app — track separately.
- **Hermes** is the kernel agent, not an iframe app — track separately.

## Icon art direction

All default app icons should follow the same light, premium iOS/macOS-inspired skeuomorphic style.
This replaces the earlier flat sage/clay prompt.

Canonical generation prompt:

> Light premium iOS/macOS skeuomorphic source artwork for an app icon. Render a complete full-square
> 1:1 image with four visible 90-degree square corners; the bright warm off-white or pale pastel
> background must continue uninterrupted all the way into every corner. This is source artwork that
> Matrix clips later, not the final masked icon. Absolutely no rounded canvas corners, no rounded-square
> tile, no app-icon frame, no corner mask, no black/dark/transparent corners, no vignette hiding the
> corners, and no border radius baked into the image. Use subtle ceramic/glass depth, soft bevels,
> glossy highlights, realistic studio shadows, and one large tactile 3D object or symbol that clearly
> represents the app. Use refined Apple-like product rendering, light neumorphism, dimensional
> glass/plastic/ceramic materials, crisp high-detail edges, friendly premium colors, and consistent
> lighting across the icon family. Do not include text, letters, numbers unless the app identity truly
> requires it, logos, watermarks, transparent background, black/dark dock backgrounds, visible
> rounded-square frame, or empty padding.

Per-app subject guidance:

- **calculator**: elegant calculator face with soft glowing keys.
- **clock**: precision analog clock rings.
- **expense-tracker**: premium wallet/card and coin mark.
- **games**: arcade portal/controller gem.
- **2048**: four raised merge tiles; avoid tiny unreadable text.
- **backgammon**: dice and board points.
- **chess**: glossy knight chess piece.
- **minesweeper**: polished mine orb and grid.
- **snake**: curled green snake path.
- **solitaire**: layered playing cards with heart/spade.
- **tetris**: floating tetromino blocks.
- **notes**: cream notebook with bookmark/ribbon.
- **pomodoro**: timer dial with tomato-red accent.
- **profile**: refined avatar silhouette badge.
- **social**: connected speech bubbles/network nodes.
- **symphony**: developer orchestration console/gem.
- **task-manager**: kanban columns/cards.
- **todo**: checkmark list badge.
- **weather**: sun/cloud/rain glass weather glyph.
- **whiteboard**: pen stroke and sticky note.
