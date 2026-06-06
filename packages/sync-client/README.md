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
matrix shell connect setup # reattach the same session from local CLI or web terminal
matrix forward 5173       # forward a Matrix computer dev server to local loopback
matrix peers              # list connected peers
matrix logout             # clear local credentials
```

All three bin entries are installed: `matrix`, `matrixos`, `mos`.

## Requirements

- Node.js 24 or newer
- A Matrix OS account — sign up at [app.matrix-os.com](https://app.matrix-os.com)

## License

AGPL-3.0-or-later.
