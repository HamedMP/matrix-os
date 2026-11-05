# Owned local DevStack operations

The local adapter adopts an **already prepared**, owner-marked OrbStack Linux machine for an explicit Git worktree. It does not provision machines, install runtime components, synchronize sources, grant provider access or change browser/peer routing. Preparation and real runtime qualification remain separate acceptance steps. Production Main and Dev machines are outside this adapter.

Use Node 24 from the repository Flox environment:

```sh
flox activate -- ./scripts/staging-slot.sh local preflight /absolute/private/instance.json
flox activate -- ./scripts/staging-slot.sh local register /absolute/private/instance.json
flox activate -- ./scripts/staging-slot.sh local status feature-a
flox activate -- ./scripts/staging-slot.sh local switch feature-a
flox activate -- ./scripts/staging-slot.sh local preview
flox activate -- ./scripts/staging-slot.sh local start feature-a
flox activate -- ./scripts/staging-slot.sh local test feature-a -- bun run test
flox activate -- ./scripts/staging-slot.sh local exec feature-a -- git status --short
flox activate -- ./scripts/staging-slot.sh local logs feature-a
flox activate -- ./scripts/staging-slot.sh local stop feature-a
flox activate -- ./scripts/staging-slot.sh local resume feature-a
```

`switch` selects the CLI's current instance and prints its HTTPS preview. It never opens a browser or changes routing. Status reports the recorded adapter state and declared source metadata, without paid readiness or live health checks. Unknown source revisions remain unknown; registration does not certify a source transport or deployed revision.

Prepare a private manifest outside source projections (replace the example path and preview):

```json
{
  "version": 1,
  "id": "feature-a",
  "worktree": "/absolute/canonical/git-worktree",
  "machine": "devstack-feature-a",
  "preview": "https://feature-a.example.test",
  "sourceRoot": "/opt/matrix/app",
  "managedUnits": ["matrix-scope-runtime.service", "matrix-devstack-gateway.service"],
  "sourceSHA": "unknown",
  "appliedRevision": "unknown",
  "capabilities": { "sourceSync": "unknown" }
}
```

Version 1 accepts Git hexadecimal revisions or `unknown`, and `sourceSync` equal to `unknown` or `external-one-way`. An external preparer owns truthful source metadata. The adapter does not update or verify the applied revision. Worktree and manifest paths must be canonical and symlink-free. Manifest files must belong to the current user with mode `0600`; permissions are checked on the opened file, and symlink opens are rejected. Manifest input and serialized metadata are each bounded to 16 KiB. Records have a separate 64 KiB serialized UTF-8 byte limit. Preview URLs require HTTPS without credentials/query/fragment.

The preparer must separately establish `/opt/matrix/.devstack-owner` inside that machine with this exact identity:

```json
{"version":1,"machine":"devstack-feature-a","purpose":"ENG-432-local-worktree","id":"feature-a","worktree":"/absolute/canonical/git-worktree"}
```

The marker must be a root-owned regular file with no group/world write permissions (prefer `0600`). Its id and host worktree binding prevent a second registry from adopting the same machine for a different instance. Preflight verifies the private manifest, protected marker and declared fixed units without writing a claim or invoking readiness. Registration repeats preflight before admission. Marker inspection runs with `orb -m <machine> -u root`. Every mutation rechecks the marker, canonical Git worktree and pinned Git-directory identity. A `devstack-*` name alone is insufficient. Only explicitly prepared machines with both fixed systemd units are eligible. `managedUnits` may additionally end with `matrix-devstack-shell.service`; no other units or orders are accepted.

Claims live under `~/.matrixos/devstack` with private permissions; `DEVSTACK_STATE_DIR` selects a separate private directory. An exclusive global `.lock` covers only admission/selection writes; guest calls run outside it. Per-instance `.<id>.lock` files serialize commands, logs and lifecycle work for that instance while peers remain independent. A crashed process leaves its lock requiring operator inspection before manual removal. No stale lock is automatically reclaimed. `DEVSTACK_CAPACITY` sets an operator admission budget (default 3, maximum safety bound 100), not a product limit. Stopped and failed instances retain their machine/worktree claim. Repeat registration of an identical manifest is idempotent; conflicting claims fail. There is no unregister/reset/delete command in this initial adapter.

Start/resume starts the scope supervisor before Gateway, then the optional Shell. Stop uses the reverse order. These operations control services only: owner data, databases, source and machine remain intact. Start/resume snapshots initial activity and skips already active units. A later failure stops only attempted units that were initially inactive or failed, in reverse order, including a failed unit that might have partially activated. Previously active units and data remain intact; every rollback stop rechecks ownership. Partial failures retain the claim, failed unit/exit and rollback results; inspect status and finite logs before resuming. Logs are observational and preserve lifecycle failure evidence. Exec/test feedback lives separately under `lastCommand`. Recorded `running` means systemctl start succeeded, not full product readiness.

Exec/test runs the explicit argument array as unprivileged `matrix` in `/opt/matrix/app` using OrbStack's `--workdir`; no interpolated remote shell is used. Exit codes, including failing tests, propagate through the CLI. Commands have a five-minute timeout, 1 MiB capture bound and at most 8 KiB of serialized UTF-8 JSON per returned stream, including quote/control-character escaping. Persistent diagnostics share these bounds, and a complete record is byte-checked before atomic replacement. Common token/password/Bearer patterns are redacted, but arbitrary command output cannot be guaranteed secret-free; do not request credential dumps. ORBENV forwarding is disabled. Logs read only the declared fixed owned units, with 200 lines and no follow mode. Output never proves paid provider or full-stack readiness.

Adapter verification:

```sh
flox activate -- node --test tests/scripts/devstack-local.test.mjs
```

These tests use real temporary Git roots and an injected OrbStack command runner. They prove adapter claim/ownership/lifecycle/feedback behavior, not machine bootstrap, one-way source synchronization, live provider execution or surface parity. Public website documentation belongs in a separate `FinnaAI/matrix-os-site` PR when this operator workflow is ready for public delivery.
