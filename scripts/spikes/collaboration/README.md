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
