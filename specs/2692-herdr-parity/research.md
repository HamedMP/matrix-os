# Research: Herdr Parity

## Sources (2026-11-11)

- `herdrdev/herdr-app` `defaults/AGENTS.md`: the guide Herdr writes into
  `~/.config/herdr-app/AGENTS.md` on every start (window model, commands,
  status, sub-agents, settings, programs, mods).
- `hc --skill` and `hc schema` from `hc` 0.1.20 (OpenRPC methods: `terminal.run
  list get kill rm keep label read attach send wait keys interrupt put`,
  `machine.exec add list connect rename rm`, `file.read write edit`,
  `doc.get set`, `events.subscribe`, `templates.list`, `server.*`).
- Matrix inventory of `packages/gateway/src/shell/`, `packages/terminal-runtime/`,
  `desktop/src/main/local-terminals/`, `packages/sync-client/` (CLI + MCP).

## Spike S1: does zellij forward OSC 7501?

Setup: zellij 0.44.3, a private config dir, a background session, a client
attached under `script` to capture raw client bytes. A command pane ran
`printf '\033]7501;working\007\033]2;TITLEX\007'; echo MARK42`.

Result: `MARK42` reached the client, but neither `ESC ]7501` nor
`ESC ]2;TITLEX` did. `list-panes --json` didn't expose the title either.
Zellij consumes unknown OSC sequences in its own terminal emulator and
re-renders the screen, so no attached client (and no gateway attachment) can
see Herdr's status reports.

Decision: status comes from a file-based reporter keyed by the
`ZELLIJ_SESSION_NAME` + `ZELLIJ_PANE_ID` environment variables (present in every
pane), an opt-in pass-through OSC tap for agents Matrix launches, and the
existing agent hooks. Patching zellij is rejected because it would mean maintaining a fork.

## What Matrix already has

- **Tabs**: create with name, cwd, command and agent; list, rename, reorder,
  delete; pane actions; paste assets; ui-state (`workspace-routes.ts`).
- **Runtime**: `writeInput`, `getSnapshot` (checkpointed viewport and
  scrollback from the zellij observer), `getCommandState`/`getCommandResult`
  (from `list-panes`), `attach` with viewer leases (`terminal-runtime/src/runtime.ts`).
- **Agent hooks**: Claude, Codex, OpenCode and Pi events give started,
  running, waiting, completed and ended. They are keyed by
  `ZELLIJ_SESSION_NAME`, which is one per workspace, so in canonical
  workspaces they aren't per tab (`shell/agent-session-bridge-cli.ts:89`).
- **Electron**: `hc` client over a framed socket using `terminal.list run kill
  attach`. Status words come from hc reports.
- **CLI/MCP**: `matrix shell ls/new/connect/rm`, `matrix run -it`; MCP
  `create_terminal`, `send_terminal_input`, `run_command`, file read and upload.

## Gaps by layer

See the parity matrix in `spec.md`.
