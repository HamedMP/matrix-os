# Tasks: Matrix OS CLI

**Task range**: T680-T689
**Parallel**: YES -- fully independent. New package or new entry point. Does not modify existing kernel/gateway/shell code (consumes their APIs).
**Deps**: None. Uses existing HTTP/WS endpoints.

## User Story

- **US-CLI1**: "I can control Matrix OS from my terminal -- start it, send messages, check status, diagnose issues"

## Architecture

CLI binary: `matrixos` (or `mos` alias). Connects to gateway HTTP/WS APIs. Can also start gateway + shell processes.

Options:
1. **New package**: `packages/cli/` with its own `package.json`, compiled with tsdown to a single binary. Links via pnpm workspace.
2. **Root bin**: `bin/matrixos.ts` at repo root, added to root `package.json` `bin` field.

Recommend option 2 (simpler, fewer packages). Can be extracted later.

Key files:
- `bin/matrixos.ts` (new -- CLI entry point)
- `packages/cli/` (new directory -- CLI implementation)
- `package.json` (add `bin` field)

## Tests (TDD -- write FIRST)

- [ ] T680a [P] [US-CLI1] Write `tests/cli/cli.test.ts`:
  - `parseArgs(["start"])` returns `{ command: "start" }`
  - `parseArgs(["send", "hello"])` returns `{ command: "send", message: "hello" }`
  - `parseArgs(["status"])` returns `{ command: "status" }`
  - `parseArgs(["doctor"])` returns `{ command: "doctor" }`
  - `parseArgs([])` returns `{ command: "help" }`
  - `formatStatus(info)` renders readable status output
  - `formatDoctor(checks)` renders diagnostic results

## Implementation

- [ ] T681 [US-CLI1] CLI entry point and argument parser:
  - `bin/matrixos.ts` with `#!/usr/bin/env node` shebang
  - Use `node:util.parseArgs()` (zero deps) for argument parsing
  - Commands: `start`, `send`, `status`, `doctor`, `help`, `version`
  - Global flags: `--gateway URL` (default http://localhost:4000), `--token TOKEN`

- [ ] T682 [US-CLI1] `matrixos start`:
  - Spawns gateway process (`node packages/gateway/src/main.ts`)
  - Optionally spawns shell (`next dev` in shell/ dir) with `--shell` flag
  - Prints URLs when ready (gateway: http://localhost:4000, shell: http://localhost:3000)
  - `--gateway-only`: skip shell
  - Handles SIGINT/SIGTERM: graceful shutdown of child processes

- [ ] T683 [US-CLI1] `matrixos send "message"`:
  - `POST /api/message` with `{ content: message }`
  - Streams response via WebSocket (connect, send, print tokens, disconnect)
  - `--session ID`: send to specific session
  - `--no-stream`: wait for complete response, print at once
  - Exit code: 0 on success, 1 on error

- [ ] T684 [US-CLI1] `matrixos status`:
  - `GET /health` -- gateway health
  - `GET /api/system/info` -- system info (uptime, version, costs)
  - `GET /api/channels/status` -- connected channels
  - `GET /api/cron` -- active cron jobs
  - Pretty-print as table/list in terminal
  - Exit code: 0 if gateway healthy, 1 if unreachable

- [ ] T685 [US-CLI1] `matrixos doctor`:
  - Check Node.js version (>= 22)
  - Check pnpm installed
  - Check ANTHROPIC_API_KEY set
  - Check gateway reachable (if running)
  - Check home directory exists and is git repo
  - Check SQLite works
  - Check disk space
  - Print pass/fail for each check with actionable fix suggestions

- [ ] T686 [US-CLI1] Build configuration:
  - Add `"bin": { "matrixos": "./bin/matrixos.ts" }` to root `package.json`
  - Add `"mos"` alias
  - Test: `pnpm exec matrixos --version` works locally
  - For npm distribution: tsdown bundle to `dist/matrixos.js`

## Implications

- CLI is a consumer of gateway APIs, not a new service. If gateway changes endpoints, CLI must update.
- `matrixos start` replaces `bun run dev` for users. Internally, it spawns the same processes.
- `matrixos send` enables scripting: `echo "What's on my schedule?" | matrixos send` or use in cron.
- Future: `matrixos install-skill URL`, `matrixos export`, `matrixos import`, `matrixos tui` (terminal UI like moltbot).
- No TUI in this phase (deferred). TUI would be a separate spec using ink or blessed.

## Checkpoint

- [ ] `matrixos --version` prints version.
- [ ] `matrixos start` launches gateway + shell, prints URLs.
- [ ] `matrixos send "What's 2+2?"` returns "4" from kernel.
- [ ] `matrixos status` shows gateway health and connected channels.
- [ ] `matrixos doctor` runs all checks and reports results.
- [ ] `bun run test` passes.
