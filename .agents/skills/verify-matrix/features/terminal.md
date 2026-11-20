# Terminal

Terminal opens project workspaces with tabs backed by the Zellij terminal runtime. Users run shells and coding agents there.

## Sub-features

- `terminal-open` opens the Terminal window on the `main` workspace.
- `terminal-tab-new` adds a tab from the `+` menu.
- `terminal-type` runs a command and shows its output.

## How to get to it (user POV)

- Double-click `Terminal` in `navigation "Desktop apps"`.
- App Launcher > `Terminal`.

## Driving it with matrix-verify

Preconditions:

- A terminal runtime socket the gateway can reach. The local stack has none, so this feature is blocked locally.

- **Open.** Double-click `Terminal`. Locally the window opens but no tab can attach; `gateway.log` shows `Terminal runtime reconciliation failed: connect EACCES /run/matrix/terminal-runtime.sock` (or `ENOENT` on machines without `/run/matrix`).
- **Where to verify instead.** A preview VPS (`preview-env` skill) runs the real runtime. Terminal e2e suites in `tests/e2e/desktop/terminal-*.e2e.test.ts` cover Electron Desktop against a stub gateway.

## Gotchas

- This is a missing precondition, not an app bug. Report it as unverified locally; never weaken the journey to pass.
- Close Settings first if it is open; its overlay intercepts the Terminal icon double-click.
