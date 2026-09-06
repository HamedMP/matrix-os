# @finnaai/matrix

Command-line client for [Matrix OS](https://matrix-os.com).

## Run without installing

```bash
# npm package runner
npx --yes @finnaai/matrix login --profile cloud
npx --yes @finnaai/matrix whoami

# pnpm package runner
pnpm dlx @finnaai/matrix login --profile cloud
pnpm dlx @finnaai/matrix whoami
```

Package-runner commands use the same CLI entrypoint as an installed `matrix`
binary. Auth and profile files are stored in `~/.matrixos/`, so a later global
install, Homebrew install, or package-runner invocation reuses the same login.

## Install permanently

```bash
# Homebrew (macOS/Linux)
brew install finnaai/tap/matrix

# npm
npm install -g @finnaai/matrix

# curl (auto-detects platform)
curl -sL get.matrix-os.com | sh
```

## Usage

```bash
matrix login              # device-code flow against app.matrix-os.com
matrix sync ~/matrixos    # start the sync daemon against the logged-in instance
matrix run -it -- claude  # attach local TTY to Claude on your Matrix VPS
matrix run -it -- codex   # same shared zellij session primitive for Codex
matrix run -it --session setup -- gh auth login
matrix forward 5173       # forward a Matrix computer dev server to local loopback
mos shell attach setup    # reattach the same session from local CLI or web terminal
matrix mcp serve          # expose Matrix computers to a coding agent over stdio
matrix peers              # list connected peers
matrix logout             # clear local credentials
```

All three bin entries are installed: `matrix`, `matrixos`, `mos`.

Use `mos shell attach <session>` rather than running `zellij attach` directly
when handing a live session between Matrix surfaces. The CLI command
participates in gateway ownership, size coordination, and renderer revocation.
See [Terminal session ownership](../../docs/dev/terminal-session-ownership.md)
for supported clients and the single-gateway deployment constraint.

## Coding-agent MCP

The Matrix OS plugin starts `matrix mcp serve --profile cloud` automatically.
For a manual MCP client configuration, run the same command as a local stdio
server after `matrix login`. Credentials stay in the Matrix CLI profile and are
never placed in MCP configuration or tool arguments.

The server exposes tools to:

- list owner-authorized computers and explicitly target a `runtimeSlot`;
- run captured argv commands or work through persistent zellij terminals/tabs;
- list, read, download, and upload bounded Matrix-home file content; and
- list, search, and inspect Matrix chats without mutating them.

`run_command` is best for short commands that need stdout, stderr, and exit
status. Persistent terminal tools are best for long-running work the user wants
to observe or reattach. Tab creation returns a stable tab ID, and tab selection
uses that ID rather than the mutable display position. MCP file download returns at most 1 MiB as base64 and
does not write a local path; use `matrix download` for larger files.

Every computer-scoped call requires the `runtimeSlot` returned by
`list_computers`. The server never silently chooses a different computer. MCP
also cannot disable a coding agent's built-in local shell; disable that host
tool separately when enforcing a remote-only workflow.

## Requirements

- Node.js 20 or newer for npm package runners and global npm installs
- No Node.js install is required when using the standalone binary from `get.matrix-os.com`
- A Matrix OS account — sign up at [app.matrix-os.com](https://app.matrix-os.com)
- A coding-agent host with local stdio MCP support for `matrix mcp serve`

## License

AGPL-3.0-or-later.
