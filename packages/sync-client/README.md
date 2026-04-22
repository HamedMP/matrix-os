# @finnaai/matrix

Command-line client for [Matrix OS](https://matrix-os.com).

## Install

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
matrix peers              # list connected peers
matrix logout             # clear local credentials
```

All three bin entries are installed: `matrix`, `matrixos`, `mos`.

## Requirements

- Node.js 24 or newer
- A Matrix OS account — sign up at [app.matrix-os.com](https://app.matrix-os.com)

## License

AGPL-3.0-or-later.
