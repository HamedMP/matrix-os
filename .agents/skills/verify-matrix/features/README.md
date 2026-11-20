# Matrix OS verification map

The maintained source for verifying user-facing Matrix OS behavior on **Web Desktop**. Read this index before driving, then use the matching feature file as the recipe. Commands assume the repo root and `V=.agents/skills/verify-matrix/scripts/matrix-verify`.

## Baseline preconditions

- A run started by `$V launch` in this checkout, with `$V doctor` all `ok`.
- The run's scratch home was seeded by gateway first boot: home contains `agents`, `apps`, `plugins`, `system`, `templates`, `temporary`, `CLAUDE.md`.
- No Postgres, no Clerk session (auth bypass), no terminal runtime socket, no Matrix AI. Features that need them say so under `Gotchas`.
- Never drive an instance this skill did not launch.

## Driving conventions

- Start every journey from a fresh page load of the Desktop (the runner does this).
- Prefer ARIA roles and accessible names. Treat quoted names as literal.
- Open apps the way a user does: double-click the Desktop icon in `navigation "Desktop apps"`, or use the App Launcher.
- Window positions persist across reloads; after `page.reload()` a window may already be open. Check before opening it again.
- Use unique names (timestamp suffix) for anything you create so reruns and stale state cannot fake a pass.

## Proof and skip reporting

- UI proof: a screenshot of the action and of the result, plus an ARIA snapshot of the region that changed.
- Side-effect proof: the matching file or config under the scratch home (`home(rel)` in a journey).
- Persistence proof: the result is still visible after a reload or reopen.
- Every artifact lands under `~/.cache/matrix-verify/evidence/<run-id>/<journey>/` with `journey.log`.
- Report an unreachable path with the command tried and the unmet precondition. Do not report a skipped entry point as verified via another one.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph of user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with matrix-verify`, `Gotchas`. Bullets marked **(proven)** were executed end to end by a journey; the rest are recipes from observed ARIA handles that still need their first run.

## Features

- [Files](./files.md) covers creating folders and files from the Create menu, on-disk side effects, and persistence. Journey: `journeys/files-create.mjs` **(proven)**.
- [Desktop and App Launcher](./desktop-launcher.md) covers opening apps from icons and the launcher, window chrome, and switching to Web Canvas.
- [Settings](./settings.md) covers the Settings overlay and its sections.
- [Chat](./chat.md) covers the Matrix chat panel and its unavailable-AI state locally.
- [Terminal](./terminal.md) is blocked on the local stack; recipe kept for preview VPS runs.
