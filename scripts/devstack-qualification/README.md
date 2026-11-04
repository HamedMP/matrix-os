# Credential-free source synchronization qualification

This is an explicit local experiment, not a Matrix service launcher. It creates
three or more real fixture Git worktrees, synchronizes them with independent
one-way Mutagen sessions, and checks source-to-HTTP propagation and correlated
log/test feedback. It does not use existing Matrix credentials or databases.

Prerequisites:

- Host Git, Node 24+, Docker CLI and an executable Mutagen binary.
- The local `orbstack` Docker context using an OrbStack Unix socket.
- An already running, explicitly owned container with a known `key=value` label.
- A non-root container user with Node 24+ and an installed `tsx/dist/cli.mjs`.
- A writable, canonical test base outside the checkout providing `tsx`.

Run the dependency-free initialization regressions with `pnpm run
test:devstack:qualification`. They check failed Git initialization, symlink-path
rejection and owner-marker failure cleanup using real temporary directories.

From the repository root:

```sh
node scripts/devstack-qualification/run.mjs --help
feedback_dir="$(mktemp -d /tmp/matrix-source-feedback.XXXXXX)"
pnpm run dev:qualify:source \
  --mutagen /absolute/path/to/mutagen \
  --container YOUR_LOCAL_CONTAINER \
  --owner-label YOUR_LABEL=VALUE \
  --target-root /absolute/container/private-test-base \
  --tsx /absolute/container/checkout/node_modules/tsx/dist/cli.mjs \
  --count 4 \
  --report "$feedback_dir/report.json"
```

The user defaults to `node`; use `--user` for another non-root user. The default
count is 3, with a safety range of 3–8 for this experiment, not a product limit.
The report path must be new and absolute. Missing prerequisites and failed
assertions exit nonzero; the report is created privately with mode `0600`.

The command checks repeated atomic saves, VCS/secret/generated-file exclusions,
independent worktree identities, bounded and redacted log/test receipts, negative
ownership cases and partial-start cleanup. It pauses and restarts one precisely
identified transport agent while peers keep updating, then removes one workspace
and verifies the peers still update. No manual flush is used for measured edits.

Source-to-HTTP latency includes synchronization, watching and process restart.
An intentionally failing fixture test is a negative case whose failure status
must be retained. Transport-agent stall/restart is not a WAN outage test.

The command removes its fixture processes, sessions, private Mutagen daemon and
local/remote test trees. It leaves the supplied container and tool checkout
running. Inspect the report's cleanup fields even when the run fails. Retained
reports are caller-owned; remove the private report directory after review.

Passing does not establish full-stack Matrix auth, data isolation, funded AI,
integrations, authenticated previews, native VPS behavior or shared-host capacity.
Those remain separate DevStack acceptance gates under ENG-432.
