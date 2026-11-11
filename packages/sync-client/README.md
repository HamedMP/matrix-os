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

## Work with a Chat by ID

```sh
matrix chats read chat_example --profile cloud --json
matrix chats read chat_example --profile cloud --cursor chatcur_from_previous_read --json
matrix chats send chat_example --profile cloud --message "Continue with the next step"
matrix chats watch chat_example --profile cloud --timeout 60
matrix chats export chat_example --profile cloud --output ./chat.json
matrix chats export chat_example --profile cloud --format markdown --output ./chat.md
```

`get` is an alias for `read`. Use the profile for the computer that owns the
Chat; `--gateway` preserves `/vm/<handle>` and runtime routing. Read returns
up to 200 messages and an earlier-history cursor. Watch emits NDJSON events and
content only for the chosen Chat, reconnects with its cursor, and detaches on
Ctrl-C without stopping the remote response. `--cursor <event-number>` resumes
a watch; replay gaps emit a fresh snapshot rather than hiding missing updates.

Send starts a remote response using the model already selected in the Chat.
The default permission mode is `supervised`; use `--permission` and
`--interaction` only for modes that model supports. Uncertain admission returns
a request ID: read the Chat, then reuse `--request-id req_...` if retrying.
Sending again with a new ID can create a second message.

Export fetches all message pages, including retrieved tool activity in JSON.
It creates a new mode-0600 file and refuses overwrites. Referenced files and
private original/provider archives are not downloaded. Exports fail explicitly
if the Chat changes during pagination or exceeds 10,000 messages / 64 MiB.

## Update the CLI

```bash
matrix update          # install the latest stable CLI
matrix update --check  # check without changing anything
```

The updater preserves Matrix profiles and sign-ins. Standalone macOS/Linux
installs verify the release checksum and executable before replacing the CLI,
and restore the previous binary if final validation fails. Homebrew and
recognized pnpm global installs use their package manager. Other managed
installs should be updated with their original package manager.

For an older CLI that has no `update` command, rerun the official installer in
its existing CLI directory:

```bash
curl -fsSL https://get.matrix-os.com | MATRIX_INSTALL_DIR="$(dirname "$(command -v matrix)")" sh
```

CLI updates do not update your Matrix computer or change its release channel.

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
matrix mcp serve          # expose Matrix computers to a coding agent over stdio
matrix peers              # list connected peers
matrix logout             # clear local credentials
```

All three bin entries are installed: `matrix`, `matrixos`, `mos`.

Use `matrix shell connect --project <project> --tab <tab-id>` rather than
running `zellij attach` directly when handing a live tab between Matrix OS
views. The CLI command participates in gateway ownership, size coordination,
and renderer attachment lifecycle.
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


### Import local Chat transcripts

Matrix CLI 0.3.21 supports Codex and Claude Code JSONL transcripts with a
compatible Matrix gateway:

```bash
matrix chats discover --project /absolute/path/to/repository --json
matrix chats import claude /absolute/path/session.jsonl --json
matrix chats import claude /absolute/path/session.jsonl --apply --sha256 <preview-hash>
```

Use `codex` instead of `claude` for Codex transcripts. Discovery lists metadata
from active, archived, and subagent transcript roots without uploading or
reading message previews. Imports preserve original bytes in a private archive
and reconstruct readable Chat history, including saved tools and supported
embedded media. External files are not followed automatically. Imports remain
private until their owner chooses sharing. The same unchanged source resumes an
interrupted upload; distinct changed snapshots and earlier text-only imports
require reconciliation rather than automatic re-import.
