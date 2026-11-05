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

Every existing component of both runtime/state placement trees is checked before unit submission; missing owned parents are created exclusively and checked under the invocation lock. The submission boundary repeats these checks and rejects any namespace unit before starting.

The harness never stops, restarts, kills or edits installed Matrix services, their `/opt/matrix` artifacts or environment files. Installed Node is a read-only runtime dependency. Existing disposable acceptance scripts are protocol references and are neither imported nor executed. Native execution must use the independently verified existing operator transport, after the controller verifies the host identity and privileged capability baseline. A missing capability is a blocker.

## Prepare the isolated source

Preparation belongs to the controller. Use an acknowledged clean Git checkout at the exact canonical source root, a root-owned home, Linux/x64 Node 24+, systemd, cgroup v2, `git`, `nsenter`, `systemd-notify`, `env` and the existing `matrix` group. Do not copy dependencies, compiled files, credentials or environment files from the installed application.

A minimal native scope-runtime build uses the frozen workspace lockfile and existing package build. A full Shell/host bundle build is unnecessary for this gate. Run the following only inside the prepared checkout, with the indicated directories owned by this namespace:

```sh
native_build_home=/var/lib/matrix-devstack/native-proof/build-home
native_corepack_cache=/var/lib/matrix-devstack/native-proof/corepack
env -i HOME="$native_build_home" COREPACK_HOME="$native_corepack_cache" \
  PATH=/opt/matrix/runtime/node/bin:/usr/bin:/bin \
  /opt/matrix/runtime/node/bin/corepack pnpm --version # must be 10.33.4
env -i HOME="$native_build_home" COREPACK_HOME="$native_corepack_cache" \
  PATH=/opt/matrix/runtime/node/bin:/usr/bin:/bin \
  /opt/matrix/runtime/node/bin/corepack pnpm install --frozen-lockfile --ignore-scripts \
  --config.enableGlobalVirtualStore=false \
  --store-dir=/var/lib/matrix-devstack/native-proof/pnpm-store
env -i HOME="$native_build_home" COREPACK_HOME="$native_corepack_cache" \
  PATH=/opt/matrix/runtime/node/bin:/usr/bin:/bin \
  /opt/matrix/runtime/node/bin/corepack pnpm --filter @matrix-os/scope-runtime build
chmod 0644 packages/scope-runtime/dist/worker.js
```

`build` runs TypeScript and the repository's esbuild worker bundler. The SDK and Linux/x64 native package must resolve at `node_modules/@anthropic-ai/claude-agent-sdk` and `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64`; their versions must match. Workspace hoisting supplies these from the frozen install. This Chat workload does not need Bot builds, a gateway native addon or a Shell release build. Keep all caches inside the namespace. If a tool or optional package is unavailable, stop and report the missing prerequisite; do not borrow an installed artifact or change the lockfile.

Before preflight/run, the controller must also stage the two original package archives under the namespace root, using versions derived from the frozen lockfile:

```text
native-packages/claude-agent-sdk-<sdk-version>.tgz
native-packages/claude-agent-sdk-linux-x64-<native-version>.tgz
```

For the current lock these names end in `0.3.240.tgz`. Keep the acquisition/integrity receipt privately. Archives must be protected root-owned single-link regular files. The harness derives versions and SHA-512 SRI from the acknowledged lock's importer/package/snapshot graph, verifies archive integrity before parsing, then compares every installed regular member, size, executable bit and digest with the authenticated archive. Extra, missing or symbolic-link members fail. SDK/native targets and manifests must resolve inside this checkout's `node_modules/.pnpm`; an installed or unrelated checkout is refused even when its manifests agree. Archive parsing is streaming and capped at512 MiB,4096 files and8192 headers, with canonical paths and supported types enforced. Nothing is extracted over source; the verifier performs no network fetch. Only the existing installed Node runtime is an explicit external dependency exception.

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

Run requires Linux/x64/root. Existing supervisor units, worker unit files, live/inactive workers, runtime/command/state directories or an active lock cause refusal. It reserves the namespace with an exclusive lock, rechecks vacancy while holding that lock, and uses the existing hardened supervisor unit's service properties, moving owned namespace/source/home/runtime/state placement. For this harness alone, `RuntimeDirectoryMode` is tightened to `0700`; the IPC directory is also pinned and checked before publication/removal. Legacy service definitions and the fixed worker sandbox remain unchanged. This root-only fixture does not qualify non-root Gateway IPC. Both runtime and command directories are explicitly writable; the marker remains outside both. Commands have timeouts and bounded output, sockets have frame/connection limits and timeouts, and the supervisor has a 180-second per-incarnation runtime limit. Each runtime, command and state leaf must be exclusively created by this invocation; an empty protected leaf appearing after vacancy discovery is refused. The reservation pins those exact directory objects and requires empty leaves immediately before submission; replacement or foreign contents fail without removal.

The proof requires an actual worker SDK response and observed fake-broker traffic. Each successful create reply records the unit's manager InvocationID/PID before its separate isolation acceptance check. All three workers (SDK, peer control and drain) receive exact normalized fixed-property, bind, tmpfs, namespace/address-family, timeout and resource checks. Actual root directory identity is compared through open descriptors; cgroup membership and mount/network namespaces are observed. Supervisor properties are checked separately and retained.

Read-safe host connections prove the selected live peer/legacy command and runtime sockets exist and accept connections without sending a command. A controlled host-loopback TCP listener and synthetic protected file provide local positive controls. Inside the worker's actual root/mount/network namespaces and UID, its own broker must answer a positive fixture request; selected peer/legacy sockets and protected paths must return specific denial codes. TCP timeout or an unrelated error fails, and external interface/route absence is checked. The host fake-broker action test is explicitly a protocol mock test, not a worker-boundary claim.

Before any compiled runtime import, a bounded inventory protects and hashes every compiled JS module, including server.js; it is checked again before native execution and supervisor submission. The receipt retains that inventory even on later failure. Supervisor evidence includes LockPersonality=yes.

Only the recorded own supervisor is intentionally crashed. Its expected restart identity is captured independently of capability health and requires a new invocation with the same transient definition identity; reconciled worker identities must remain unchanged. Planned mutations recheck ownership immediately. Graceful drain sends an explicit main-process SIGTERM only after freshly proving all tracked worker incarnations and the absence of unknown or partial creates. It is verified against an independently created/configured own worker. Protocol worker-stop requests also freshly check manager dependency and stop-hook relationships before dispatch. The fixture sets and attests RemainAfterExit=yes so a successful supervisor process exit retains its unit evidence: active/exited, MainPID=0, original ExecMainPID and InvocationID, CLD_EXITED/status0 and Result=success. The drain gate also checks the controller's worker-stop result because the real controller logs a failed stop and can still exit zero. Before SIGTERM, the harness verifies both directories for each tracked worker and binds the live supervisor's stderr (PID fd 2) to an exclusively created `0600` file outside the reserved leaves. It verifies systemd's append mode and the 64 KiB hard and soft file limit. After the same invocation exits, the gate requires its socket and every worker's command and state directories to be gone under the same protected parents. The stderr interval starting immediately before SIGTERM must contain no fixed shutdown-stop-failed warning; ordinary optional adapter diagnostics are allowed. Missing, replaced, incomplete or full capture fails the proof. The receipt records file identity, byte offsets and teardown outcomes without log text; cleanup removes only the verified capture file. These checks also apply when systemd has already collected the worker. Supervisor collection/default not-found fields cannot prove a graceful exit. This proves process termination while the fixture unit remains retained, not installed lifecycle behavior. No process environment or credential contents are read.

## Receipts and cleanup

A run that reserves the namespace retains `native-acceptance-receipt-<invocation>.json` there, mode `0600`, including failure cases. Stdout contains a bounded status/path/gate summary; the file holds the full evidence. Each gate and per-resource check is recorded as it completes, so later SDK/recovery/drain/cleanup failure retains earlier passes while the overall result stays failed. Capability and SDK fields are allowlisted. It records source/lockfile/build/SDK/native/Node hashes and versions, SDK result, boundary and recovery checks, and before/after installed/peer service invocation IDs, PIDs, restart counts, unit fragment/drop-in hashes, artifact hashes (including installed scope wrapper and scope/gateway runtime entrypoints) and actual command/runtime socket metadata. Required service/artifact/legacy IPC baseline evidence must exist before the first native version execution; bounded optional absence is explicit. Any peer/installed change fails acceptance. Receipts contain metadata and fixed fixture text, not raw user data or credentials.

Cleanup runs in `finally` and attempts each conclusively recorded resource independently, even after a supervisor stop or isolation gate failure. It never obtains authority from inventory: only correlated create replies and a proven own supervisor create establish records. Before each mutation it checks the recorded manager InvocationID/PID; planned proof actions also require the original transient definition. The fixture supervisor uses observed KillSignal=SIGKILL: cleanup uses systemctl stop to suppress automatic restart and prevent JavaScript shutdown from draining tracked names. A retained active/exited own supervisor is eligible through the same invocation/definition and original ExecMainPID proof, without requiring a live main PID; a replacement remains untouched. RuntimeDirectoryPreserve=yes is inherited, observed and required before cold stop so systemd retains command/state paths. Every direct stop also requires empty observed dependency/stop-hook fields; unknown cascade state is retained as failed while independently proven workers remain eligible. A changed/foreign incarnation is preserved. Ambiguous partial creates and unrecorded namespace lookalikes are quarantined in the failed receipt, with observation only.

The broker binds a short socket in an exclusive `0700` directory under the protected namespace runtime parent, outside commandSocketRoot, then publishes through an exclusive same-filesystem hardlink. Both bind and public-directory identities are pinned/checked. Public removal checks inode/device and rechecks exclusive directory permission after the pathname read, preventing other directory writers from interleaving an unlink replacement. Node closes only its private bind path. Link failure has no fallback, and foreign replacements remain for review.

Source, home, marker, receipts and remaining state directories are retained for review. The active lock is removed only when its inode still matches the invocation. Rerunning against retained/partial state is deliberately blocked: review the receipt and controller-owned state before choosing a fresh namespace. Do not use the disposable scripts, broad service stops or recursive host cleanup as a workaround.
