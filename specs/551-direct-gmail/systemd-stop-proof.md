# Verified systemd stop acknowledgements

ENG-355: continuation of the managed Pi stop authority. The existing launcher is oversized; extract only its stop verification into `systemd-stop.ts`, leaving launch/readiness/reconciliation behavior in place.

The internal supervisor passes the generation retained for the exact runtime handle. Before issuing any stop, the launcher requires its existing validated, host-owned provenance and an exact systemd unit identity. A known activating, deactivating, inactive or failed unit always receives a bounded `systemctl stop`; `is-active` exit codes are not stop evidence.

A successful acknowledgement requires all of:

- Unchanged runtime handle, generation and measured profile provenance throughout verification.
- A terminal `inactive/dead` or `failed/failed` unit, zero main/control PIDs, no pending job and zero or explicitly unset task accounting.
- The expected cgroup v2 hierarchy, no live processes in the group **or descendants** (`cgroup.events: populated 0`), and an empty direct process list. A removed cgroup qualifies only after verifying the cgroup v2 root; missing accounting files in an existing group fail closed.
- A second terminal unit observation after filesystem checks. Unknown identity, foreign cgroup, symlink, incomplete properties, command failure, or timeout preserves runtime files and returns no stopped ACK. A failed stop command can qualify only when subsequent checks prove the known unit and its cgroup are absent.

The host-only inspection seam permits a disposable filesystem and command runner in tests. It is never populated from a client body, header or model argument. The default overall deadline is 15 seconds (maximum 30), individual production commands already have a 10-second timeout, and all property/file reads are bounded. A late command after the deadline cannot delete evidence. No registry/cache is introduced.

This proves stopped execution only within the trusted system manager's runtime namespace; another privileged host actor replacing units/cgroups is outside this authority model. Random handles are not reused by normal launches. Retention still needs the managed runtime execute/cleanup drain, awaited durable stopped-receipt persistence, and the host admission/purge fence described in `managed-pi-stop-authority.md`. Reconciliation absence or terminal chat status alone remains insufficient.

Primary behavior references: [systemctl states and exit codes](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html), [cgroup v2 populated semantics](https://docs.kernel.org/admin-guide/cgroup-v2.html), and systemd's [`Job` serialization](https://github.com/systemd/systemd/blob/main/src/systemctl/systemctl-show.c) / [`TasksCurrent` unset serialization](https://github.com/systemd/systemd/blob/main/src/shared/bus-print-properties.c). Fixtures use these wire formats; they do not establish deployed Linux/systemd qualification.

Public documentation deliverable remains the existing ENG-355 site connection/retention documentation PR. No additional customer-facing behavior or new endpoint is introduced by this internal proof layer. Actual worker stop, generation, descendant drain, durable receipt and retention ordering must be exercised on an isolated Linux pilot before live qualification.
