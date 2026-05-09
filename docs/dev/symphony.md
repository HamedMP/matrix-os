# Symphony setup

Matrix OS keeps its Symphony policy in [`WORKFLOW.md`](../../WORKFLOW.md).
The service itself runs from the private `FinnaAI/symphony` checkout and reads
this file at startup. Matrix OS does not vendor that Elixir service in this
repo.

## Requirements

- `LINEAR_API_KEY` with access to the Matrix OS Linear project
- GitHub SSH access to `git@github.com:HamedMP/matrix-os.git`
- `gh auth status` passing for PR creation and merge workflows
- `codex app-server` available in `PATH`
- Node 24+, pnpm 10, and bun available for Matrix OS validation
- `mise` available for the upstream Elixir Symphony reference service

## Install

```bash
git clone git@github.com:FinnaAI/symphony.git ~/code/symphony
cd ~/code/symphony/elixir
mise trust
mise install
mise exec -- mix setup
mise exec -- mix build
```

## Run directly

```bash
LINEAR_API_KEY=... mise exec -- ./bin/symphony \
  /Users/hamed/dev/claude-tools/matrix-os/WORKFLOW.md \
  --port 4066 \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails
```

Open `http://localhost:4066` for the optional dashboard.

For a detached local run, use a terminal multiplexer:

```bash
tmux new-session -d -s matrix-symphony \
  'set -a; source /Users/hamed/dev/claude-tools/matrix-os/.env; set +a; cd ~/code/symphony/elixir; mise exec -- ./bin/symphony /Users/hamed/dev/claude-tools/matrix-os/WORKFLOW.md --port 4066 --i-understand-that-this-will-be-running-without-the-usual-guardrails'
```

Attach with `tmux attach -t matrix-symphony`.

## Run from Matrix OS

Set a local Linear key in the Matrix gateway environment:

```bash
LINEAR_API_KEY=...
```

The gateway only forwards a small runtime environment to Symphony by default:
`LINEAR_API_KEY`, basic shell/toolchain variables, `MATRIX_HOME`, and
`MATRIX_SYMPHONY_RUN_ID`. If a local deployment needs additional non-gateway
secrets for the runner, set `MATRIX_SYMPHONY_ENV_ALLOWLIST` to a comma-separated
list of variable names.

Then open the Symphony app in Matrix OS. It uses the gateway's local
`/api/symphony/*` runner endpoints to start the Elixir service beside the
current Matrix instance.

Default runner contract:

- Symphony checkout: `~/code/symphony/elixir`
- Runner binary: `./bin/symphony`
- Workflow: `WORKFLOW.md` in the Matrix OS process working directory
- Dashboard: `http://127.0.0.1:4066`

## Repository contract

- Workspaces are created under `~/code/symphony-workspaces`.
- New workspaces clone this repository over SSH and run
  `pnpm install --frozen-lockfile`.
- Symphony dispatches Linear issues on team `MAT` in `Todo`, `In Progress`,
  `Merging`, and `Rework` only when they have the `symphony` label.
- Terminal issue states clean up matching workspaces.
- The Codex app-server command is configured in `WORKFLOW.md`.
- The long-term product shape is tracker adapters per Matrix instance: Linear
  for the internal team, GitHub Issues or a Matrix-native ticket board for
  other instances.

## Skills

Install or refresh the repo-local Symphony skills with:

```bash
npx skills add FinnaAI/symphony -a codex \
  -s linear land commit push pull debug --copy -y
```

The installed skills live under `.agents/skills/`:

- `linear`: narrow Linear GraphQL operations through Symphony's injected tool
- `commit`: Matrix OS commit conventions without AI attribution trailers
- `pull`: merge latest `origin/main` into a working branch
- `push`: push branches and create/update PRs with Matrix OS validation
- `land`: monitor review/CI and squash-merge approved PRs
- `debug`: structured debugging support for Symphony work
