---
name: verify-matrix
description: Drive Matrix OS like a user to prove a change works. Launches a disposable local gateway + Next.js shell on scratch ports with a scratch Matrix home, drives Web Desktop in headless Chromium with Playwright, captures screenshots/ARIA/on-disk side effects outside the repo, and tears down only what it started. Use when asked to verify, smoke-test, or prove a shell/gateway change in the running app, not just in unit tests.
---

# Verify Matrix OS

Scripted way to launch Matrix OS locally, drive **Web Desktop** the way a user does, and keep proof. Everything lives in this directory:

- `scripts/matrix-verify`: `launch`, `doctor`, `drive`, `stop`, `list`. Run `scripts/matrix-verify --help`.
- `scripts/drive.mjs`: Playwright runner used by `matrix-verify drive`. You do not call it directly.
- `features/`: the verification map. Read `features/README.md` before driving; each feature file is a recipe. `features/journeys/*.mjs` are runnable journeys.

All commands below run from the repo root (a manual `git worktree`, per AGENTS.md). `V=.agents/skills/verify-matrix/scripts/matrix-verify`.

## Surfaces

- **Primary: Web Desktop** (browser, `http://127.0.0.1:<shell-port>/`). This skill drives it.
- Web Canvas is reachable from the same run through the App Launcher's `Web Canvas` button; it has no journey yet.
- Electron Desktop: not covered. Its own Playwright `_electron` suites live in `tests/e2e/desktop/` (need `bun run build:desktop`) against a stub gateway.
- Web Mobile / Native Mobile: not covered. See `docs/dev/mobile-shell.md`.
- A Web Desktop capture is not evidence for any other surface (AGENTS.md "Live visual evidence").
- This is local proof only. PR review evidence still needs a live preview (`preview-env` skill).

## Isolation (read before launching)

- Another Matrix instance may already be running on this machine (commonly shell `:3000`, gateway `:4000`, Postgres `:5432`). Never drive, restart, or kill it.
- `launch` defaults to gateway `:4410` and shell `:3410` and refuses if either port is taken. Pick others with `--gateway-port/--shell-port` (or `MATRIX_VERIFY_GATEWAY_PORT/MATRIX_VERIFY_SHELL_PORT`).
- Each run gets its own `MATRIX_HOME` under `~/.cache/matrix-verify/runs/<run-id>/home` (override root with `MATRIX_VERIFY_ROOT`). The real `~/matrixos` is never touched.
- Each server is started under `setsid`; `stop` kills only the two recorded process groups. Never `pkill node`/`pkill next`.
- `next dev` locks `shell/.next` per checkout. Do not launch while someone else runs `bun run dev`/`dev:shell` in the same checkout; use a separate worktree.
- Two runs can coexist on different ports from different worktrees.

## Launch

Prerequisites: `pnpm install --frozen-lockfile` done; Playwright's headless Chromium installed once with `pnpm exec playwright install --only-shell chromium`.

```bash
$V launch --run my-check          # ~1-2 min: builds deps, starts gateway, compiles Desktop page
```

What it does:

1. Builds gateway workspace deps (`pnpm --filter '@matrix-os/gateway^...' --filter '@matrix-os/brand' build`). Plain `bun run dev:gateway` in a fresh worktree fails with `Cannot find module .../@matrix-os/terminal-runtime/dist/index.js`; this step fixes that. Pass `--skip-build` on later runs in the same checkout.
2. Starts the gateway (`pnpm --dir packages/gateway run dev`) with `PORT`, scratch `MATRIX_HOME`, and `MATRIX_AUTH_ALLOW_INSECURE_DEV=1` (no bearer token). First boot seeds the home from `home/` templates.
3. Starts the shell (`next dev --webpack -p <port> -H 127.0.0.1`) with `GATEWAY_URL` pointing at our gateway and `E2E_TEST_BYPASS=1`/`NEXT_PUBLIC_E2E_TEST_BYPASS=1` so Clerk sign-in is skipped.
4. Ready means usable: gateway `/health` is `"status":"ok"`, the shell compiled and served `/` (first compile ~50 s), and the shell proxies `/health` to our gateway.

It prints the run id last. A failed launch prints the log to read and leaves state for `stop`; always run `$V stop --run <id>` after a failed launch.

No `.env` is needed or loaded from a fresh worktree (the gateway only reads repo-root `.env` if present). Without Postgres (`DATABASE_URL` unset) the app DB layer is off: the Files, Settings, Desktop and launcher paths work; DB-backed apps do not.

## Doctor

Run first whenever anything looks off. Read-only.

```bash
$V doctor [--run my-check]
```

Checks both process groups are alive, each port is owned by this run's process group (not someone else's server), gateway `/health` is ok, the gateway's home is this run's scratch home, the shell proxies to it, and `/` renders. It prints the build SHA the run launched with versus current `HEAD`: if they differ, the shell hot-reloaded but rebuilt deps did not, so relaunch for dependency changes. Exit 1 means do not drive; read `~/.cache/matrix-verify/runs/<id>/logs/{build,gateway,shell}.log`, stop, relaunch.

## Drive

```bash
$V drive .agents/skills/verify-matrix/features/journeys/files-create.mjs [--run my-check]
```

A journey is an ES module `export default async ({ page, step, shot, aria, home, check, exists, readText, shellUrl }) => {}`. The runner opens `shellUrl` at 1440x900, waits for the `Desktop apps` navigation, then calls it.

- `step(label, fn)` labels a user action in `journey.log`.
- `shot(label)` / `aria(label, locator?)` write numbered PNGs and ARIA snapshots.
- `home(rel)` resolves a path inside the scratch `MATRIX_HOME` (refuses escapes) for side-effect checks with `exists`/`readText`.
- `check(label, ok, detail)` records PASS/FAIL; a FAIL fails the journey (exit 1) and takes a `failure` screenshot.

Write new journeys next to the existing ones and add them to the feature map. Use stable handles seen in the app:

- Desktop icons: `getByRole("navigation", { name: "Desktop apps" }).getByRole("button", { name: "<App>", exact: true }).dblclick()`.
- Taskbar: `getByRole("navigation", { name: "Running apps" })` holds `Open App Launcher` / `Focus <App>` / `Open <App>`.
- Top bar: `getByRole("navigation", { name: "Desktop controls" })` (`Search`, `Inbox`, `Help`, `Support`).
- Window chrome: buttons `Close`, `Minimize`, `Fullscreen`.
- When you do not know a handle, write a throwaway journey that calls `aria("probe")` and read the snapshot. Do not guess CSS selectors or coordinates.

## Evidence

- Evidence goes to `~/.cache/matrix-verify/evidence/<run-id>/<journey>/`: numbered screenshots, `*.aria.txt`, `journey.log` (steps, PASS/FAIL, build SHA, shell URL), `console-errors.txt`. `stop` also copies the run's `logs/` there.
- Never write evidence inside the repo, and never commit captures (AGENTS.md: attach them to the PR or a comment instead).
- Proof standards:
  - Drive the real user path: icons, menus and dialogs, not `fetch` to `/api/*` or store setters.
  - Capture the action and the resulting state, not only the final screen.
  - Verify the side effect too: a file in the scratch home, a changed config file, a gateway response.
  - Confirm persistence from a second view: reload the page or reopen the window.
  - Report the feature id and entry point you drove. Do not claim an entry point you skipped.
- The local stack is a stand-in. It differs from a customer VPS in auth (bypass, no Clerk session), no Postgres, no terminal runtime socket, and no Matrix AI relay. Name the gaps when reporting.

## Cleanup

```bash
$V stop [--run my-check]
```

Stops the shell and gateway process groups (TERM, then KILL after 10 s), warns if a port is still held, copies logs into evidence, and deletes the run dir including its scratch home. It restores `shell/next-env.d.ts` and removes `shell/AGENTS.md` only when this run's `next dev` created those changes. Evidence is kept. `$V list` shows leftover runs and evidence dirs. Delete old evidence with `rm -rf ~/.cache/matrix-verify/evidence/<run-id>` when you no longer need it.

## Maintaining the map

When a user-visible flow changes, update its `features/*.md` and journey in the same PR. Use `/pstack:maintain-verification-skill` to audit the map against the app.
