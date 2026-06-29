# Task 5 — CLI docs page report

**Status: DONE**

## Commands documented and source files verified

| Command / section | Source file |
|---|---|
| `matrix login` — device flow, `--profile`, `--platform`, `--gateway` | `commands/login.ts` |
| `matrix login --dev` / `--profile local` — bypass device flow, write stub token | `commands/login.ts` (`ctx.args.dev` branch) |
| `matrix logout` | `commands/logout.ts` |
| `matrix run -it -- <cmd>` — interactive, TTY, named sessions (`--session`), `--cwd` / `-C`, `--no-mouse` | `commands/run.ts` |
| `matrix shell ls` / `list` — list sessions | `commands/shell.ts` (`listCommand`) |
| `matrix shell new <name>` — create session; `--attach`, `--cwd`, `--layout`, `--cmd` | `commands/shell.ts` (`new` subcommand) |
| `matrix shell connect <name>` / `attach <name>` — attach; `-c` / `--create` create-if-missing flag | `commands/shell.ts` (`attachCommand`) |
| `matrix shell rm <name>` — remove session; `--force` | `commands/shell.ts` (`rm` subcommand) |
| `matrix sync [path]` — start daemon, default path `~/matrixos/`, `--path` / `-p`, `--folder` / `-f` | `commands/sync.ts` |
| `matrix sync status` / `pause` / `resume` | `commands/sync.ts` |
| `matrix upload <local> <remote>` — `--force`, `--secret` | `commands/upload.ts` |
| `matrix download <remote> <local>` — `--force`, `--secret` | `commands/download.ts` |
| `matrix port forward <spec>` — port spec format (`<port>`, `<local>:<remoteHost>:<remotePort>`), loopback-only constraint | `commands/port.ts`, `port-forward.ts` (`parseForwardSpec`) |
| `matrix forward <spec>` — top-level alias for `port forward` | `commands/port.ts` (`forwardAliasCommand`) |
| `matrix status` — profile, gateway URL, auth state | `commands/status.ts` |
| `matrix whoami` — authenticated identity, handle | `commands/whoami.ts` |
| `matrix doctor` — 5 checks: profile, auth, daemon, gateway, shell-backend | `commands/doctor.ts` |
| Binary names: `matrix`, `matrixos`, `mos` all point at same entrypoint | `package.json` (`bin` field) |

## Commands in source NOT documented (intentionally out of scope for this Guides page)

- `matrix setup` — provisioning/retry flow (`commands/setup.ts`) — better suited for onboarding docs
- `matrix instance info|restart|logs` — instance ops (`commands/instance.ts`) — low discoverability for a Guides intro page; left out rather than mislead
- `matrix peers` — list connected sync peers (`commands/peers.ts`) — niche; omitted
- `matrix agent auth scan` — scan local AI agent credentials (`commands/agent.ts`) — very specific; omitted
- `matrix profile ls|use|show|set` — profile management (`commands/profile.ts`) — mentioned in global flags but not a full section
- `matrix shell tab` / `pane` / `layout` subcommands — documented thoroughly in the legacy guide `/docs/guide/cli`; left out of this Guides intro to avoid bloat
- `matrix completion` — shell completions (`commands/completion.ts`) — not read; assumed present from the legacy guide

## Uncertainties

1. **Install URLs**: The Homebrew tap (`finnaai/tap/matrix`) and the curl install script (`https://get.matrix-os.com`) are copied from the existing `cli.mdx` and the legacy guide — they were not verifiable from the source code alone. If these are still correct should be confirmed externally.
2. **`matrix login --profile local` shortcut**: The source shows `--dev` writes to the `"local"` profile explicitly. The flag `--profile local` alone does NOT bypass the device flow — `--dev` is required for that. The docs reflect this correctly.
3. **`secret` flag semantics for upload/download**: Both `upload.ts` and `download.ts` accept `--secret` and pass it through to `uploadLocalFile`/`downloadRemoteFile`, but the underlying storage handling is in `file-transfer-client.ts` (not read). The docs say "affects storage handling" which is intentionally vague to avoid inventing behavior.
4. **`matrix sync` default local path**: The source uses `defaultSyncPath()` from `lib/config.ts` (not read). The legacy guide says `~/matrixos/`. The docs reproduce that claim — should be verified against `defaultSyncPath()` if precision is needed.
