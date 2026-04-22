# @matrix-os/cli

Command-line client for [Matrix OS](https://matrix-os.com).

## Install

```bash
npm install -g @matrix-os/cli
```

Or run the platform-detecting installer which fetches the signed macOS `.pkg`
when appropriate:

```bash
curl -sL get.matrix-os.com | sh
```

## Usage

```bash
matrix login              # device-code flow against app.matrix-os.com
matrix sync ~/matrixos    # start the sync daemon against the logged-in instance
matrix peers              # list connected peers
matrix logout             # clear local credentials
```

Both `matrix` and `matrixos` bin entries are installed.

## Requirements

- Node.js 24 or newer
- A Matrix OS account — sign up at [app.matrix-os.com](https://app.matrix-os.com)

## License

AGPL-3.0-or-later.
