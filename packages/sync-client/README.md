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
matrix run -it -- codex   # creates a tab in the current project's workspace
matrix run -it --project main -- gh auth login
matrix shell list         # list tabs grouped by project
matrix shell connect --project main --tab <tab-id>
matrix forward 5173       # forward a Matrix computer dev server to local loopback
matrix peers              # list connected peers
matrix logout             # clear local credentials
```

All three bin entries are installed: `matrix`, `matrixos`, `mos`.

Use `mos shell attach <session>` rather than running `zellij attach` directly
when handing a live session between Matrix surfaces. The CLI command
participates in gateway ownership, size coordination, and renderer revocation.
See [Terminal session ownership](../../docs/dev/terminal-session-ownership.md)
for supported clients and the single-gateway deployment constraint.

## Requirements

- Node.js 20 or newer for npm package runners and global npm installs
- No Node.js install is required when using the standalone binary from `get.matrix-os.com`
- A Matrix OS account — sign up at [app.matrix-os.com](https://app.matrix-os.com)

## License

AGPL-3.0-or-later.
