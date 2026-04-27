# Research: Zellij-Native Shell and Unified CLI

## Decision: Use zellij CLI as the v1 session engine

**Rationale**: Zellij is already installed and pinned in the Matrix OS Docker images. It provides the persistent session/tab/pane model users need, and using it avoids inventing another terminal multiplexer. The gateway can invoke zellij with bounded `execFile`/`spawn` calls inside the user container where the sessions live.

**Alternatives considered**:

- Continue raw PTY sessions only: rejected because browser/CLI/editor would keep separate session models.
- Use zellij plugin/RPC integration immediately: rejected because the v1 need is control-plane operations and attach; a plugin adds complexity before stable pane/session requirements prove it is needed.
- Replace `matrix ssh` tmux at the same time: rejected because bastion SSH is a separate surface and would expand scope.

## Decision: Split daemon control plane from terminal data plane

**Rationale**: Daemon IPC should expose stable one-shot operations for CLI/editor integrations, while terminal byte streams should attach directly to the gateway WebSocket. This matches zellij's native multi-client attach model and keeps the daemon stateless for large terminal streams.

**Alternatives considered**:

- Proxy all terminal bytes through the daemon: rejected because resize, input demux, and multi-client behavior would duplicate zellij/gateway responsibilities.
- Make the CLI call gateway HTTP for all operations directly: rejected because editor integrations need a local stable contract and the daemon already owns local sync state.

## Decision: Keep current raw PTY endpoints during migration

**Rationale**: The existing web shell depends on `/api/terminal/sessions` and `/ws/terminal` behavior. Keeping deprecated compatibility avoids breaking the browser while the zellij-native foundation lands. The later web-shell rewrite can migrate browser tabs onto named sessions.

**Alternatives considered**:

- Migrate all existing raw PTY sessions to zellij immediately: rejected because sessions are ephemeral and migration adds failure risk.
- Remove old endpoints immediately: rejected because it breaks current shell users before replacement UI is ready.

## Decision: Store session registry and layouts as owner-controlled files

**Rationale**: Matrix OS constitution requires owner-controlled state. Zellij is authoritative for live session existence; a shadow registry records Matrix-created metadata such as names, tab indices, layout references, timestamps, and attached-client counts. Layouts live under `~/system/layouts/*.kdl`.

**Alternatives considered**:

- Store shell state in SQLite/Postgres: rejected for v1 because terminal/layout state is per-user system configuration and file-backed state is easier to inspect, export, and recover.
- Trust only zellij output: rejected because zellij CLI output does not expose every Matrix-level metadata field needed for list and layout UX.

## Decision: Validate layout content through bounded zellij validation before save

**Rationale**: Native Node APIs are preferred unless a dependency is necessary. Because zellij is already pinned, v1 can validate layout content by writing a temp candidate and invoking zellij in a bounded subprocess rather than adding a KDL parser dependency. If zellij cannot validate a specific layout operation reliably, tasks may introduce the smallest maintained KDL parser with tests and lockfile update.

**Alternatives considered**:

- Add a KDL parser immediately: deferred to avoid a dependency unless zellij validation is insufficient.
- Accept layout text without validation: rejected because malformed layouts would fail later and violate input validation requirements.

## Decision: Profile-scoped CLI configuration replaces legacy global auth/config

**Rationale**: The same `matrix` binary must target cloud and local stacks. Profiles make the target explicit and let users switch without editing files. Legacy `~/.matrixos/auth.json` and `~/.matrixos/config.json` migrate to `~/.matrixos/profiles/cloud/` once when the profile file is first created.

**Alternatives considered**:

- Keep global config plus environment overrides: rejected because users need durable local/cloud switching and integrations need a stable active profile.
- Make `--dev` a separate command mode: rejected because it preserves the old split mental model.

## Decision: Version every machine-readable contract from day one

**Rationale**: CLI JSON output, daemon IPC, and stream events are public contracts for scripts and editor integrations. Adding `"v": 1` now gives future changes an explicit compatibility path.

**Alternatives considered**:

- Version only daemon IPC: rejected because shell scripts consume CLI JSON too.
- Rely on command names as implicit versions: rejected because errors and streams need schema evolution too.

## Decision: Fail explicit attach on missing session

**Rationale**: `matrix shell new <name>` already creates and attaches. Making `attach` auto-create would duplicate semantics and make typo behavior surprising.

**Alternatives considered**:

- Auto-create on attach: rejected as ambiguous and harder to script safely.

## Decision: Use `Ctrl-\ Ctrl-\` as the default wrapper detach sequence

**Rationale**: The sequence is uncommon and does not overlap with zellij's normal `Ctrl-q` leader or native detach behavior. It can be made configurable in profile CLI settings if needed.

**Alternatives considered**:

- Use zellij's native detach only: rejected because the wrapper needs a consistent way to close the CLI attach without requiring users to know zellij internals.
- Use `Ctrl-c`: rejected because it commonly terminates foreground processes.
