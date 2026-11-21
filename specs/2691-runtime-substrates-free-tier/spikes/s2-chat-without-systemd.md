# S2 spike: managed Pi chat without host systemd

Branch `spike/2691-s2` in `/Users/hamed/dev/claude-tools/matrix-os-2691-spike-s2`.
Commits: `1c0f94aa66` (launcher and harness), `096686f02f` (sandbox matrix), `b89fc065b2`
(security fixes in the fake gateway). Not pushed.

## Verdict: partial pass

Pass condition: "Real funded chat turn with tool use completes; workload has no network
and no gateway secrets."

- **Tool-use turn and isolation: pass.** In a non-root container (uid 61184) with
  `--cap-drop ALL` and `no-new-privileges`, a bubblewrap launcher completed a managed Pi
  turn with tool use. Pi called `write_artifact`, then `read_artifact`, then replied
  "Read back: sandbox ok". Status `completed`, 2 tool actions, 3 inference calls. 22 of 22
  isolation probes pass, including the host-changing path probe added in `b89fc065b2`.
- **Real funded turn: not exercised.** The gateway broker sent requests to the real
  providers with the key added on the gateway side, but both local keys were out of quota.
  Anthropic answered 400 ("workspace API usage limits", resets 2026-12-01) and Gemini 402
  ("prepayment credits depleted"). The completed turn used a scripted model that streams
  Anthropic Messages SSE. The Matrix funded relay (`matrix_included`) was not used.
- **Real code in the turn:** the supervisor controller and server, the new
  `ScopeRuntimeLauncher`, the bundled Pi bot worker and its inference bridge, and the
  gateway's `createScopeRuntimeBrokerServer`.
- **Stubbed:** the bot registry and authorizer, the session store, and the artifact tool
  execution (`spikes/2691-s2/fake-gateway.ts`).

## Sandbox mechanism × container privileges

Scripted model, non-root uid 61184. Probe totals are out of 21 (the matrix run came before
the 22nd probe was added).

- P1: Docker default
- P2: P1 + `--security-opt no-new-privileges --cap-drop ALL`
- P3: P2 + a seccomp profile that is Docker's default plus `unshare`, `clone`, `mount`,
  `umount2`, `pivot_root` and `setns`
- P4: P3 + `--security-opt systempaths=unconfined`

| Mechanism | P1 | P2 | P3 | P4 |
|---|---|---|---|---|
| bwrap, fresh `/proc` | fails: user namespaces blocked | fails | fails: cannot mount proc | turn completes, 21/21 |
| bwrap, no `/proc` | fails | fails | turn completes, 21/21 (22/22 after the fixes) | not run |
| unshare + mount script | fails: `unshare` EPERM | fails | fails: no proc, so the nested uid map fails | turn completes, 21/21 |
| Landlock + seccomp helper | turn completes, 19/21 | same | same | same |
| plain child, env scrubbed | worker refuses to start; probe 5/21 | same | same | same |

- **bwrap and unshare:** every passing run blocked all of these:
  - internet over TCP, UDP and DNS
  - container loopback (gateway :4000, Postgres :5432) and the container's eth0 address
  - `supervisor.sock`, the Postgres Unix socket and the gateway's abstract socket
  - the gateway's `/proc/<pid>/environ` and signals to gateway PIDs
  - `~/system`, `/var/lib/matrix-scope-runtime`, `/etc/passwd` and the gateway code
  - writes to the read-only runtime mount

  The workload's environment held only HOME, PATH and MATRIX_SCOPE_RUNTIME.
- **Landlock:** both failures are Unix sockets reached by file path (`supervisor.sock`,
  Postgres). Landlock (ABI 8, kernel 7.0) does not control `connect()` on those.
- **Plain:** the workload read ANTHROPIC_API_KEY, GEMINI_API_KEY and DATABASE_URL from the
  gateway's process environment. It also reached the internet and loopback Postgres, and
  read the home secret. The existing worker boundary check refuses to start in this mode,
  which is the correct fail-closed behaviour.
- **Docker default seccomp also blocks:**
  - `sethostname`, so bwrap's `--hostname` was dropped
  - `chroot` under `--cap-drop ALL`, so the unshare script uses `pivot_root` instead
  - the `fsopen`/`fsmount` family, so libmount needs `LIBMOUNT_FORCE_MOUNT2=always`

## Systemd launcher properties versus the bwrap launcher

**Matched:**
- private network, PID, IPC and UTS namespaces, plus a user namespace
- a fresh read-only tmpfs root holding only the systemd profile's bind mounts: `/usr/lib`,
  `/usr/bin/env`, node, the bot runtime, the broker socket, the ready file, the command
  directory and the worktree
- tmpfs `/tmp` (64 MB) and `/workspace` (10 GB), with `/workspace` as working directory
- `env -i` with the fixed environment, no capabilities, no-new-privileges, fixed uid 61184
- `BindsTo` replaced by `--die-with-parent`: SIGKILL of the supervisor killed the worker.
  A plain spawned child survived the same test.

**The loopback bridge needed no change.** The workload never uses TCP loopback. The broker
socket is bind-mounted in, the worker serves its own inference socket inside the view, and
Pi's fetch goes over a Unix socket.

**Weakened:**
- The per-unit dynamic user becomes one fixed uid. Outside the namespace it is the same
  kernel uid as the gateway, so namespaces are the only separation and a user-namespace
  escape exposes everything the gateway holds.
- There is no `RestrictAddressFamilies` equivalent and no extra seccomp filter.

**Dropped:**
- Memory, CPU and task limits, because `/sys/fs/cgroup` is read-only in the container.
  Only a 768 MB V8 heap cap and the container's own cgroup remain, so a fork bomb shares
  the gateway's process budget.
- `ProtectProc`, because the no-`/proc` variant has no `/proc` at all.

## Are unprivileged user namespaces required?

Yes, for the namespace mechanisms. Docker's default seccomp profile blocks them for a
non-root user even without dropping capabilities. CAP_SYS_ADMIN is not needed. bwrap needs
only the six syscalls listed under P3, and `/proc` can be left out of the view.

The fallback without user namespaces is Landlock plus seccomp. It needs:
- kernel 6.12 or newer (Landlock ABI 6 or higher)
- the supervisor and gateway sockets moved to abstract names, and Postgres reached over
  TCP only
- one runtime at a time, because the worker hardcodes its paths

Plain child processes are not an acceptable fallback.

For provider choice:
- S1's "supports whatever S2's launcher needs" should become a hard check: the provider
  must not block those six syscalls for a non-root user.
- MicroVMs where we control the guest (Fly, Firecracker on Hetzner) should pass by
  construction. Not verified.
- Container platforms that apply Docker-like seccomp fail.
- gVisor was not tested.

## Production launcher (Stack B2): effort, risk, plan.md changes

About 2–3 weeks, medium-high risk. The risk comes from provider support for user
namespaces, the missing per-workload limits, and CI hosts: as far as I know Ubuntu 24.04's
AppArmor restricts user namespaces on GitHub runners, but I did not check that.

Changes to `plan.md`:
1. Make the S1 criterion the concrete syscall check above.
2. Let the shared-chat profile be omitted. The capability schema requires at least one
   adapter (`packages/scope-runtime/src/protocol.ts:176-180`), so the spike advertises
   `claude-code` and then refuses to start it.
3. The worker's forbidden-path check uses `access(F_OK)`, which Landlock does not block.
   The spike switches it to `open()` in `worker-common.ts`; that change is spike-only.
4. Add a decision on per-workload resource limits, with cgroup delegation as a soft
   provider criterion.
5. B2's tests should reuse `spikes/2691-s2/probe.mjs` for the network, environment and
   database checks.
6. Add the two broker requirements in the next section.

## Security findings in the spike fake gateway (fixed in `b89fc065b2`)

### Finding 1: the upstream URL was built from a workload-supplied path

- **Before:** `https://api.anthropic.com${frame.path}`. A path such as
  `@evil.example/x` changes the host, and the `x-api-key` header went with the request.
- **Fix:**
  - Validate every routed frame against the production schemas
    (`ScopeRuntimeBotInferenceRequestSchema`, `BotBrokerRequestSchema`).
  - Allow one fixed path per action. Build the URL with `new URL(path, base)`, then check
    the protocol, hostname, port and userinfo.
  - Send with `redirect: "error"` and `AbortSignal.timeout` (120 seconds).
- **Verified:** a new in-sandbox probe sends `path: "@evil.example/v1/messages"` to the
  broker socket. The broker closed the connection without a reply.

### Finding 2: the workspace containment check could be bypassed with a symlink

- **Before:** `resolve()` followed by `startsWith`, which a symlink inside the workspace
  bypasses.
- **Fix:**
  - Validate path segments, rejecting `.`, `..` and over-long or odd names.
  - Check every directory component with `lstat` and refuse symlinks.
  - Require `realpath(parent)` to sit under `realpath(workspace)`.
  - Write with `O_CREAT|O_EXCL|O_NOFOLLOW`; read with `O_NOFOLLOW` plus an `fstat`
    regular-file and size check.
- **Verified:** with `S2_SYMLINK_ATTACK=1` the gateway plants `notes -> ~/system`. Both
  `artifact.write` and `artifact.read` were refused (`invalid_arguments`) and nothing was
  written outside the workspace.
- **Residual:** the workload has the workspace mounted read-write, so it can still swap an
  intermediate directory between the walk and the open.

### Does the production broker have either weakness? (checked)

**Finding 1 (upstream path): no.**
- The workload-supplied path is only ever a schema literal or enum:
  - shared broker: `packages/scope-runtime/src/broker-protocol.ts:25`
    (`/api/hello`, `/v1/messages?beta=true`) and `:57` (`/v1/responses`)
  - bot frames: `packages/scope-runtime/src/broker-protocol.ts:90-92`
- It is parsed before use:
  - `packages/gateway/src/collaboration/scope-runtime-broker.ts:610`
    (`ScopeRuntimeBrokerRequestSchema.parse`)
  - `packages/gateway/src/bots/broker-actions.ts:277`
    (`ScopeRuntimeBotInferenceRequestSchema.safeParse`)
- The URL is still built by string concatenation at `scope-runtime-broker.ts:303` and
  `packages/gateway/src/bots/broker-inference.ts:299`, but with `redirect: "error"`
  (`scope-runtime-broker.ts:307`, `broker-inference.ts:300`) and timeouts
  (`scope-runtime-broker.ts:302`, `broker-inference.ts:295-297`).
- The base URL comes from the gateway's credential launch environment
  (`scope-runtime-broker.ts:288`, `broker-inference.ts:267`), not from the workload. Owner
  key and profile launches delete `ANTHROPIC_BASE_URL`
  (`packages/gateway/src/kernel-credentials.ts:123,131,137,143`).
- Defense-in-depth gap: no `new URL` origin check after concatenation.
- The in-sandbox bridge forwards the raw `request.url`
  (`packages/scope-runtime/src/inference-bridge.ts:138`), but it holds no key and the
  broker schemas above reject anything else.

**Finding 2 (symlink bypass): no, with a narrower race.**
- The artifact tools in `packages/gateway/src/bots/tool-dispatcher.ts`:
  - validate segments (`:85-91`)
  - walk directories with `lstat` and refuse symlinks (`directoryFor`, `:94-108`)
  - open reads with `O_NOFOLLOW|O_NONBLOCK` (`:317`)
  - stage writes with `O_CREAT|O_EXCL|O_NOFOLLOW` (`:267`), then publish with `link`
    (managed, `:288-292`) or `rename` (`:301`), both of which do not follow a symlink on
    the final component
- Residual: the same check-then-use race on intermediate directories. A path is checked
  (`:96-104`), then opened, linked or renamed by path string. Under the systemd profile and
  under the container launcher the workload has the worktree mounted read-write
  (`packages/scope-runtime/src/sandbox.ts`, the `BindPaths` entry in
  `SANDBOX_PROPERTY_TEMPLATE`), so it can swap a checked directory for a symlink in that
  window. The managed path re-checks `directoryFor` before `link` (`:285`), which narrows
  the window but does not close it.

### Explicit requirements for the production broker and bridge (Stack B2)

1. **Workload input never chooses the upstream host.**
   - Parse every frame with the strict schemas before routing, including routed bot frames.
   - Map each action to a fixed path and base. Build with `new URL(path, base)` and assert
     protocol, hostname, port and no userinfo before attaching any credential.
   - Send with `redirect: "error"` and `AbortSignal.timeout`.
   - Add a regression test with a host-changing path such as `@evil.example/...`.
2. **Gateway file I/O on workload-writable trees never follows a workload-planted link.**
   - Validate segments, refuse symlinks on every component, and confirm the parent's
     `realpath` stays under the workspace's `realpath`.
   - Open with `O_NOFOLLOW` (`O_EXCL`/`wx` for new files) and `fstat` the result.
   - Close the intermediate-component race with an fd-relative walk: `openat2` with
     `RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS`, or a per-component `O_NOFOLLOW|O_DIRECTORY`
     walk. Node has no `openat2`, so this needs a small native helper or a
     symlink-swap race test proving the current approach holds.

## Reproduce

```
cd /Users/hamed/dev/claude-tools/matrix-os-2691-spike-s2 && pnpm install --frozen-lockfile && sh spikes/2691-s2/build.sh
S=$PWD/spikes/2691-s2/seccomp-default-plus-userns.json
S2_BWRAP_PROC=0 S2_PROVIDER=stub spikes/2691-s2/run-matrix.sh bwrap P3 --security-opt no-new-privileges --cap-drop ALL --security-opt seccomp=$S
S2_BWRAP_PROC=0 S2_PROVIDER=stub spikes/2691-s2/run-matrix.sh bwrap P3 --security-opt no-new-privileges --cap-drop ALL --security-opt seccomp=$S -e S2_SYMLINK_ATTACK=1
spikes/2691-s2/matrix.sh /tmp/s2-matrix
```

For a real-provider attempt, run the first `run-matrix.sh` command with
`S2_PROVIDER=anthropic` (or `gemini`). It reads the key from
`/Users/hamed/dev/claude-tools/matrix-os/.env` at run time and redacts it from the output.
