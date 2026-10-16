# Collaboration scope-runtime proof

This directory contains the proof harness for PR2. The native/SDK boundary
experiment passed on the measured disposable host recorded below. This proves
the selected systemd primitives and installed SDK/harness combination; it does
not claim that the still-unimplemented production supervisor lifecycle is
complete. Shared execution remains disabled through PR2.

## Safety and ordering

Run `scope-runtime-probe.ts` only on a disposable VPS-native Linux host. The
probe refuses to start unless `MATRIX_SCOPE_PROBE_DISPOSABLE=1` is present. It
actively tests loopback, link-local, private and public network denial and
writes a disposable sentinel inside the scope workspace. Never run it on an
owner's Matrix computer.

`native-isolation-acceptance.sh` is the root-side disposable-host harness. It
also refuses to start without the marker. The harness creates temporary broker
and supervisor sentinel sockets, runs the probe once as the intentionally
unrestricted `matrix` service identity with only a fake sentinel secret, and
requires that baseline to fail.
It then runs the same probe through one fixed systemd 255-compatible profile
using `DynamicUser=matrix-scope-probe`, a minimal root, an isolated network, an
exact broker socket mount, and bounded CPU, memory, process, and scratch-storage
quotas. It always stops the transient unit and removes its sockets and temporary
root on exit.

The acceptance harness expects the reviewed native probe, Agent SDK probe, and
bounded broker fixture under `/var/tmp/` on the disposable host and the bundled
Node runtime at `/opt/matrix/runtime/node/bin/node`. It resolves the installed
`@anthropic-ai/claude-agent-sdk` and matching Linux x64 native harness, mounts
only those package directories read-only, and supplies no owner credential.
Install the probes through the repository's authenticated exact-head preview
acceptance channel; do not copy credentials or owner files into the profile. A
successful stdout record contains only bounded baseline/candidate reports,
measured versions, and quota values.

The experiment must run twice against the same release candidate:

1. An intentionally unrestricted non-root baseline must fail the isolation
   checks. This proves that the harness detects exposed owner files, processes,
   environment, sockets or egress instead of producing a vacuous pass.
2. The candidate fixed-profile supervisor boundary must pass every check,
   including the child-process inheritance pass.
3. The actual installed Agent SDK must start its matching native harness inside
   the same profile, complete a deterministic fake-provider turn through the
   exact Unix-socket broker action, and reject a non-allowlisted broker action.

Do not implement or advertise an adapter from mock results. Unknown supervisor,
profile-digest, Node, native harness or adapter-version combinations remain
unavailable.

## Required evidence record

Fill this table with public-safe facts from the disposable host. Do not record
tokens, hostnames, addresses, owner paths beyond the fixed negative test paths,
provider responses or private content.

| Evidence | Measured value |
| --- | --- |
| Git commit | `6ccdd768534d7bbd116784dd1e910067c4564128` |
| Evidence workflow | GitHub Actions run `34264153999`; artifact retained for 7 days |
| Host image and kernel | Ubuntu 24.04, Linux `6.8.0-138-generic`, x86_64 |
| systemd version | 255 |
| Node version | `v24.18.0` |
| Supervisor version | Not implemented; T078/T082 remain pending |
| Profile ID/version/digest | `scope-runtime-proof-v1`; SHA-256 `de0837f9a6a0c9e534d93fc375a30f1b30a9b6b641e88da367aa1b4cd89ad753` |
| Scope UID allocation | systemd dynamic service identity; measured UID 62632 for this run (never treated as stable) |
| MemoryMax | 1,073,741,824 bytes |
| CPUQuota | 200% |
| TasksMax | 256 |
| Writable storage maximum | 10,737,418,240 bytes isolated tmpfs |
| Supported adapter and harness version | `claude-code`; Agent SDK `0.3.240`; native harness `2.1.240` |
| Unrestricted baseline result | Failed as required: owner home, fake owner sentinel, foreign processes, direct network/DNS, and supervisor socket were exposed |
| Fixed-profile result | Passed every file, environment, process, descriptor, network, DNS, broker, supervisor-injection, and child-inheritance check |
| SDK/broker result | Passed one real `query()` turn through the Unix-socket `inference.messages` fixture; rejected `host.fetch` |
| Timeout/crash/restart/shutdown result | Pending production supervisor implementation and T082 acceptance |

The disposable host was still running bundle `v2026.09.07-1176` because the
current application bundle failed to activate independently of this experiment.
The workflow therefore uploaded the immutable probe scripts from the commit
above and required the host's installed Agent SDK to equal the same head's
pinned `0.3.240` dependency before accepting the result.

## Probe coverage

The JSON report contains only bounded public-safe status:

- forbidden owner, credential, database and service paths are absent;
- the scope root is writable and the process is non-root;
- no forbidden environment keys or inherited descriptors are present;
- the process namespace exposes no foreign UID and remains bounded;
- direct loopback, metadata, private, public and DNS access is denied;
- the bounded broker socket is reachable;
- the supervisor control socket is unreachable from the workload; and
- a spawned child inherits the same boundary; and
- the installed Agent SDK/native harness completes only through the bounded
  `inference.messages` broker fixture while an attempted `host.fetch` action is
  denied.

The supervisor acceptance harness must additionally inject malformed and
oversized IPC, crash the supervisor during a request, restart it, and verify a
bounded shutdown drain. The gateway tests exercise the same lifecycle in
isolation, but they do not replace this real-host record.

## Codex shared-Chat proof and rollback

The Codex adapter is accepted only when the production supervisor verifies the
installed native executable as exactly `codex-cli 0.154.0` beneath the trusted
runtime root. The worker runs `codex exec` as an ephemeral, single-turn process
inside the same fixed systemd profile. It ignores user configuration and rules,
has no owner credentials, cannot resume a private thread, and receives a fixed
loopback Responses provider. Shell, image, sleep, planning, user-input,
multi-agent, app, plugin, goal, web-search, and image-generation capabilities
are disabled. The host broker accepts only `POST /v1/responses`, rejects any
non-empty tool list, reauthorizes the current actor and exact owner Provider
binding, and injects the owner's supported file-backed Codex identity only in
the privileged upstream request.

The exact-head disposable preview workflow must report
`scope_runtime_codex_chat=passed`. That check launches the installed native
Codex binary inside a real DynamicUser/PrivateUsers/PrivateNetwork chroot,
observes a zero-tool Responses request at the fake broker, completes one bounded
turn, and restores the preview's supervisor to the exact enabled/active state
observed before the proof. Since #1602 activated shared AI, production bundles
ship the supervisor enabled and running with no `SCOPE_RUNTIME_DISABLED`
marker. The harness therefore stops an already-running supervisor only to obtain
a cold start whose broker socket it can own, starts it again afterwards, and
schedules a deferred `matrix-gateway` re-attach: the gateway executes the signed
acceptance command itself and loses its production broker socket whenever the
supervisor's runtime directory is recreated. The workflow then proves the
re-attach happened by observing a later gateway activation timestamp and the
recreated broker socket before it records a pass; a scheduled but unverified
re-attach fails the run. A legacy dormant preview that still
carries the marker is proved the same way and returned to dormant. A mock-only
or local pass is insufficient.

Rollback is fail-closed, Codex-specific, and does not rebind Chats. Removing or
changing the pinned Codex executable causes the supervisor to omit the Codex
adapter from eligibility while the Claude adapter keeps running; that is the
Codex rollback. Stopping the supervisor, or placing the `SCOPE_RUNTIME_DISABLED`
marker that production bundles no longer ship, is a host-wide emergency stop
that also clears Claude shared AI, so it must not be used as a Codex rollback.
In every case human discussion remains available. Existing `codex_default`
bindings stay immutable and shared AI reports unavailable; they are never
translated to `claude_shared`. Accepted work fenced to an older execution
generation or eligibility document is terminalized as unavailable, and an
uncertain active run is interrupted rather than replayed.

The initial shared Codex surface intentionally does not support attachments,
resources, tools, approvals, user input, steering, worktrees, session resume,
or persistent thread state. Owner identity support is limited to Codex's
file-backed API-key and ChatGPT OAuth forms; keyring-only, agent-identity,
Bedrock, and custom-provider credentials remain unavailable to shared Codex.
