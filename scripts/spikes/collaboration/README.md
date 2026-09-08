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

The experiment must run twice against the same release candidate:

1. An intentionally unrestricted non-root baseline must fail the isolation
   checks. This proves that the harness detects exposed owner files, processes,
   environment, sockets or egress instead of producing a vacuous pass.
2. The candidate fixed-profile supervisor boundary must pass every check,
   including the child-process inheritance pass.

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
- a spawned child inherits the same boundary.

The supervisor acceptance harness must additionally inject malformed and
oversized IPC, crash the supervisor during a request, restart it, and verify a
bounded shutdown drain. The gateway tests exercise the same lifecycle in
isolation, but they do not replace this real-host record.
