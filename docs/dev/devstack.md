# DevStack native qualification

The native acceptance harness qualifies a source-built, namespaced scope-runtime on an explicitly selected Linux/x64 systemd host. It exercises the real Claude Agent SDK and native executable through the existing supervisor/worker transport with an in-process fake inference broker. It makes no provider request and needs no production credential.

This is one Stage 2 gate. It does not establish real-account inference, accounting, Preview activation, Web Canvas/Web Desktop/Electron Desktop parity, or production rollout. The canonical public documentation lives in the separate site repository; its linked documentation PR is a controller delivery gate.

## Ownership boundary

For `--namespace=native-proof`, the shared scope-runtime resolver requires:

| Resource | Exact placement |
| --- | --- |
| Source checkout | `/var/lib/matrix-devstack/native-proof/app` |
| Owner home | `/var/lib/matrix-devstack/native-proof/home` |
| Supervisor runtime | `/run/matrix-devstack/native-proof/scope-runtime` |
| Worker command sockets | `/run/matrix-devstack/native-proof/c` |
| State | `/var/lib/matrix-devstack/native-proof/scope-runtime` |
| Supervisor | `matrix-devstack-native-proof-scope-runtime.service` |
| Workers | `matrix-devstack-native-proof-scope-runtime-<32hex>.service` |

The namespace is a lowercase slug, at most 32 characters. The marker and receipts stay at the namespace root, outside the worker-writable command directory. Source paths, namespace parents and resolved executable/dependency paths must be root-owned, without group/other write permission or symlinked ancestors. pnpm package links are resolved before checking their protected targets. Worker `worker.js` must be world-readable; the mounted SDK/native directories and their entry files must be readable/executable by a DynamicUser.

The harness never stops, restarts, kills or edits installed Matrix services, their `/opt/matrix` artifacts or environment files. Installed Node is a read-only runtime dependency. Existing disposable acceptance scripts are protocol references and are neither imported nor executed. Native execution must use the independently verified existing operator transport, after the controller verifies the host identity and privileged capability baseline. A missing capability is a blocker.

## Prepare the isolated source

Preparation belongs to the controller. Use an acknowledged clean Git checkout at the exact canonical source root, a root-owned home, Linux/x64 Node 24+, systemd, cgroup v2, `git`, `nsenter`, `systemd-notify`, `env` and the existing `matrix` group. Do not copy dependencies, compiled files, credentials or environment files from the installed application.

A minimal native scope-runtime build uses the frozen workspace lockfile and existing package build. A full Shell/host bundle build is unnecessary for this gate. Run the following only inside the prepared checkout, with the indicated directories owned by this namespace:

```sh
export PATH=/opt/matrix/runtime/node/bin:/usr/bin:/bin
export HOME=/var/lib/matrix-devstack/native-proof/build-home
export COREPACK_HOME=/var/lib/matrix-devstack/native-proof/corepack
corepack pnpm --version # must be 10.33.4
corepack pnpm install --frozen-lockfile --ignore-scripts \
  --config.enableGlobalVirtualStore=false \
  --store-dir=/var/lib/matrix-devstack/native-proof/pnpm-store
corepack pnpm --filter @matrix-os/scope-runtime build
chmod 0644 packages/scope-runtime/dist/worker.js
```

`build` runs TypeScript and the repository's esbuild worker bundler. The SDK and Linux/x64 native package must resolve at `node_modules/@anthropic-ai/claude-agent-sdk` and `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64`; their versions must match. Workspace hoisting supplies these from the frozen install. This Chat workload does not need Bot builds, a gateway native addon or a Shell release build. Keep all caches inside the namespace. If a tool or optional package is unavailable, stop and report the missing prerequisite; do not borrow an installed artifact or change the lockfile.

Use a protected controller-prepared marker at `/var/lib/matrix-devstack/native-proof/.native-acceptance-owner.json`, with exactly these keys and reviewed values:

```json
{
  "version": 1,
  "purpose": "matrix-devstack-native-acceptance",
  "namespace": "native-proof",
  "appRoot": "/var/lib/matrix-devstack/native-proof/app",
  "home": "/var/lib/matrix-devstack/native-proof/home",
  "sourceSha": "<reviewed 40 lowercase hexadecimal Git SHA>",
  "lockfileSha256": "<reviewed 64 lowercase hexadecimal SHA-256>"
}
```

It must be a root-owned `0600`, single-link regular file with no symlinked ancestors. The harness reads it with `O_NOFOLLOW`; it never creates or rewrites the marker. The checked-out source and lockfile must match. Git checks disable optional index-refresh locks so preflight remains read-only.

## Preflight and run

Invoke the script from the prepared canonical checkout. Preflight reports JSON on stdout and exits 0 only when ready, otherwise 2. It creates no directories, marker, receipt or units and executes only read-only systemd discovery, source checks and filesystem checks.

```sh
node scripts/ops/devstack-native-acceptance.mjs \
  --namespace=native-proof \
  --app-root=/var/lib/matrix-devstack/native-proof/app \
  --home=/var/lib/matrix-devstack/native-proof/home \
  --mode=preflight
```

After code review and a separately verified controller baseline, run once with explicit acknowledgements:

```sh
node scripts/ops/devstack-native-acceptance.mjs \
  --namespace=native-proof \
  --app-root=/var/lib/matrix-devstack/native-proof/app \
  --home=/var/lib/matrix-devstack/native-proof/home \
  --mode=run \
  --ack-source=<reviewed-40hex> \
  --ack-lockfile=<reviewed-64hex>
```

Run requires Linux/x64/root. Existing supervisor units, worker unit files, live/inactive workers, runtime/command/state directories or an active lock cause refusal. It reserves the namespace with an exclusive lock, rechecks vacancy while holding that lock, and uses the existing hardened supervisor unit's service properties, moving only owned namespace/source/home/runtime/state placement. Both runtime and command directories are explicitly writable; the marker remains outside both. Commands have timeouts and bounded output, sockets have frame/connection limits and timeouts, and the supervisor has a 180-second maximum lifetime.

The proof requires an actual worker SDK response and observed fake-broker traffic, validates fixed worker systemd limits and cgroups, verifies distinct mount/network namespaces, and runs content-free network/path denial checks with the worker's UID in its actual root/mount/network namespaces. It crashes only its own supervisor, requires a new generation with reconciled worker state, then verifies graceful worker/socket drain. It never records process environments or reads credential file contents.

## Receipts and cleanup

A run that reserves the namespace retains `native-acceptance-receipt-<invocation>.json` there, mode `0600`, including failure cases. It records source/lockfile/build/SDK/native/Node hashes and versions, SDK result, boundary and recovery checks, and before/after installed/peer service invocation IDs, PIDs, restart counts, artifact hashes and socket metadata. Any peer/installed change fails acceptance. Receipts contain metadata and fixed fixture text, not raw user data or credentials.

Cleanup runs in `finally`. Before stopping the exact transient supervisor it checks the unique invocation description and transient flag. Worker cleanup is allowed only after that invocation's supervisor ownership was proved; it checks exact unit identity, transient/DynamicUser state and canonical root before stopping each exact name. It never mutates a wildcard selection. A lost/foreign ownership check prevents cleanup and fails the receipt. The broker binds a short socket in an exclusive `0700` directory under the protected namespace runtime parent, then publishes its canonical socket through an exclusive same-filesystem hardlink. Node closes only its private bind path; published-socket cleanup checks inode/device and preserves a foreign replacement. Link failure has no path/symlink fallback. The private directory stays outside the worker command root and is removed only by exact owned-directory cleanup.

Source, home, marker, receipts and remaining state directories are retained for review. The active lock is removed only when its inode still matches the invocation. Rerunning against retained/partial state is deliberately blocked: review the receipt and controller-owned state before choosing a fresh namespace. Do not use the disposable scripts, broad service stops or recursive host cleanup as a workaround.
