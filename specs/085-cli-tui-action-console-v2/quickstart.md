# Quickstart: Matrix CLI TUI Action Console Follow-Up

## Purpose

Validate the replacement plan locally before implementation and later use the same scenarios as acceptance checks.

## Local Evaluation States

1. Source-only checkout: launch the TUI without gateway/auth/zellij and verify degraded states are explicit.
2. Gateway running: launch the TUI and verify status/doctor actions can reach the local gateway.
3. Authenticated profile: verify login state refreshes and auth-required actions become available.
4. Zellij/session-ready: create a shell session, list sessions, attach/observe, detach, and stop with confirmation.

## Preservation Check

Compare against the parent `084-matrix-cli-tui-polish` branch:

- Home prompt and product identity remain visible.
- Rabbit mascot remains present and compact.
- Parent keyboard hints remain visible.
- Command palette still exposes the 084 command-family surface.
- Sessions still use Matrix session language.
- Direct CLI commands still bypass the TUI when explicitly invoked.

## Setup Wizard Check

Use a temporary home directory with fixture `.agent`, `.codex`, and `.claude` files:

- Codex is selected by default.
- Claude is opt-in.
- Migration preview appears before writes.
- Secrets and unsupported files are skipped.
- Cancel leaves files unchanged.
- Completion offers a terminal handoff or next action.
