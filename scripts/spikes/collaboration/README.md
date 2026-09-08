# Collaboration scope-runtime proof

This directory contains the proof harness for PR2. It does **not** claim that
the proposed native boundary is safe yet. Shared execution stays disabled until
the real disposable-host experiment passes and the exact evidence below is
filled in.

## Safety and ordering

Run `scope-runtime-probe.ts` only on a disposable VPS-native Linux host. The
probe refuses to start unless `MATRIX_SCOPE_PROBE_DISPOSABLE=1` is present. It
actively tests loopback, link-local, private and public network denial and
writes a disposable sentinel inside the scope workspace. Never run it on an
owner's Matrix computer.

`native-isolation-acceptance.sh` is the root-side disposable-host harness. It
also refuses to start without the marker. The harness creates temporary broker
and supervisor sentinel sockets, runs the probe once as an intentionally
unrestricted numeric non-root identity, and requires that baseline to fail.
It then runs the same probe through one fixed systemd 255-compatible profile
with a minimal root, an isolated network, an exact broker socket mount, and
bounded CPU, memory, process, and scratch-storage quotas. It always stops the
transient unit and removes its sockets and temporary root on exit.

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
| Git commit | Pending |
| Host image and kernel | Pending |
| systemd version | Pending |
| Node version | Pending |
| Supervisor version | Pending |
| Profile ID/version/digest | Pending |
| Scope UID allocation | Pending |
| MemoryMax | Pending |
| CPUQuota | Pending |
| TasksMax | Pending |
| Writable storage maximum | Pending |
| Supported adapter and harness version | Pending |
| Unrestricted baseline result | Pending — must fail |
| Fixed-profile result | Pending — must pass |
| Timeout/crash/restart/shutdown result | Pending |

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
