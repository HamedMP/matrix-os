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

Version 1 accepts Git hexadecimal revisions or `unknown`, and `sourceSync` equal to `unknown` or `external-one-way`. An external preparer owns truthful source metadata. The adapter does not update or verify the applied revision. Worktree and manifest paths must be canonical and symlink-free. Manifest files must belong to the current user with mode `0600`; permissions are checked on the opened descriptor. Nonblocking, no-follow opens reject symlinks and nonregular inputs (including writerless FIFOs) before reading. Manifest input and serialized metadata are each bounded to 16 KiB. Records have a separate 64 KiB serialized UTF-8 byte limit. Preview URLs require HTTPS without credentials/query/fragment. Each retained registration reserves its worktree, machine and normalized preview URL under the same lock. Host case and the default HTTPS port do not distinguish previews. Different explicit runtime paths on one origin are supported.

The preparer must separately establish `/opt/matrix/.devstack-owner` inside that machine with this exact identity:

```json
{"version":1,"machine":"devstack-feature-a","purpose":"ENG-432-local-worktree","id":"feature-a","worktree":"/absolute/canonical/git-worktree"}
```

The marker must be a root-owned regular file with no group/world write permissions (prefer `0600`). Its id and host worktree binding prevent a second registry from adopting the same machine for a different instance. Preflight verifies the private manifest, protected marker and declared fixed units without writing a claim or invoking readiness. Registration repeats preflight before admission. First adoption additionally requires every declared fixed unit to report `inactive`; stop the prepared units before registering. Active, transitioning, failed or unknown activity is rejected without creating a claim. These guest activity queries run outside the global admission lock under the target instance lock. Re-registering an identical existing running instance remains idempotent, but the current Git-directory identity must still match its stored pin. Identity comparisons use bounded original marker bytes; display redaction never transforms ownership data. Marker inspection runs with `orb -m <machine> -u root`. Every mutation rechecks the marker, canonical Git worktree and pinned Git-directory identity. A `devstack-*` name alone is insufficient. Only explicitly prepared machines with both fixed systemd units are eligible. `managedUnits` may additionally end with `matrix-devstack-shell.service`; no other units or orders are accepted.

Claims live under `~/.matrixos/devstack` with private permissions; `DEVSTACK_STATE_DIR` selects a separate private directory and must be absolute; relative overrides are rejected when the adapter is constructed, before filesystem writes. An exclusive global `.lock` covers only claim admission, active-capacity reservation and selection writes; guest calls run outside it. Per-instance `.<id>.lock` files serialize commands, logs and lifecycle work for that instance while peers remain independent. Global contention waits at most two seconds without reclaiming locks; same-instance guest contention fails immediately. A crashed process leaves its lock and any active reservation requiring operator inspection before manual removal. No stale lock is automatically reclaimed. `DEVSTACK_CAPACITY` sets the active-instance budget (default 3, configurable up to 100), not a retained-registration count or product limit. Up to 100 private registrations may retain ownership/data independently of that active budget. Stopped and failed instances retain their machine/worktree claim; successful stop releases only their active-capacity lease. Start/resume atomically reserves capacity before service writes; stop preserves its prior lease while attempting cleanup and cannot grant an unleased claim admission permission. A failed stop retains that prior lease value, so a subsequent start of a previously unleased claim still checks C; starting/running/stopping and potentially live failed instances remain counted. Starting an already leased instance uses its existing slot. Lowering the budget never evicts existing instances. Old running/starting/stopping/failed records without an explicit lease field are conservatively counted until an explicit lifecycle operation establishes their outcome. Repeat registration of an identical manifest is idempotent; conflicting claims fail. Admission reads private retained claim metadata without probing finished peer worktrees; the target worktree and marker still receive full validation before every guest operation. There is no automatic eviction or unregister/reset/delete command in this initial adapter.

Start/resume starts the scope supervisor before Gateway, then the optional Shell. Stop uses the reverse order. These operations control services only: owner data, databases, source and machine remain intact. Start/resume snapshots initial activity and skips already active units. A later failure stops only attempted units that were initially inactive or failed, in reverse order, including a failed unit that might have partially activated. Previously active units and data remain intact; every rollback stop rechecks ownership. Failed-start rollback releases capacity only when the complete initial snapshot had no active units and every attempted-unit rollback succeeded. Unknown initial activity, preexisting active units or incomplete start rollback retain a conservative active lease. A failed stop preserves a genuine existing or legacy lease; it never manufactures one for an unleased claim. Partial failures retain the claim, failed unit/exit and rollback results; inspect status and finite logs before resuming. Logs are observational and preserve lifecycle failure evidence. Exec/test feedback lives separately under `lastCommand`. Recorded `running` means systemctl start succeeded, not full product readiness.

Exec/test runs the explicit argument array as unprivileged `matrix` in `/opt/matrix/app` using OrbStack's `--workdir`; no interpolated remote shell is used. Exit codes, including failing tests, propagate through the CLI. Commands have a five-minute timeout, 1 MiB capture bound and at most 8 KiB of serialized UTF-8 JSON per returned stream, including quote/control-character escaping. Persistent diagnostics share these bounds, and a complete record is byte-checked before atomic replacement. Common token/password/Bearer patterns are redacted, but arbitrary command output cannot be guaranteed secret-free; do not request credential dumps. ORBENV forwarding is disabled. Logs read only the declared fixed owned units, with 200 lines and no follow mode. When that journal output exceeds the public byte budget, logs retain the most recent suffix after full redaction, so new compiler/runtime errors remain visible. Generic exec/test stdout keeps its existing prefix behavior. Authoritative ownership bytes are never sent through this display transformation. Output never proves paid provider or full-stack readiness.

Adapter verification:

```sh
flox activate -- node --test tests/scripts/devstack-local.test.mjs
```

These tests use real temporary Git roots and an injected OrbStack command runner. They prove adapter claim/ownership/lifecycle/feedback behavior, not machine bootstrap, one-way source synchronization, live provider execution or surface parity. Public website documentation belongs in a separate `FinnaAI/matrix-os-site` PR when this operator workflow is ready for public delivery.

## Preparing a source Shell

The Shell, Platform and Relay can run as ordinary Node services in Docker. Native
Kernel workloads and Terminal still need the prepared Linux execution environment.
Reuse an unchanged production Shell build across worktrees; start a separate
development Shell only for a worktree that changes frontend code. Its source,
dependencies, `.next` directory, port and process ownership must remain separate
from the shared baseline. Keep its API and WebSocket URLs bound to the explicit
runtime route, including when another preview is open in the same browser.

Set `MATRIX_DEVSTACK_ASSET_PREFIX` to the exact `/vm/<handle>/~runtime/<slot>`
route for a development Shell. Set `MATRIX_ALLOWED_DEV_ORIGINS` to its exact
external hostname. These settings do not create routing, TLS or authentication.
Preserve the public Host **including its port** through the trusted proxy chain;
dropping a development port can fail Next's Server Actions origin checks.

Next 16.4 also expects that asset prefix on its upstream `/_next/hmr` upgrade.
Platform strips the explicit runtime prefix before forwarding to a runtime, so
the prepared runtime proxy must restore the selected Shell's prefix for that
HMR path. Keep ordinary API/Terminal WebSocket routing unchanged. Preserve
Upgrade/Connection headers, authentication, strict TLS and restrictive upstream
cache directives. A normal page returning 200 does not prove HMR works: observe
the authenticated browser connection and a visible source edit without reloading.

Warm a source Shell before replacing a working preview route. Keep the baseline
available when startup or compilation fails. In local qualification a cold
Webpack build exceeded a 5 GiB native machine budget; raising memory alone did
not establish a usable frontend loop. A Docker source Shell with an explicit
heap budget was qualified separately. Count heavy frontend watchers separately
from lightweight native runtime slots and set capacity for available resources.
The adapter's numeric active-instance limit is not a memory admission controller.

Machine preparation, vendor configuration, source transport, Shell-mode routing,
native Terminal installation and private test-credit allocation remain operator
steps. The local adapter does not provision these prerequisites. Replaying
identity initialization must preserve owner data, existing integration mappings,
credentials, funding balances, policy limits and expiry; never replenish credits
as part of start, resume or source synchronization.
