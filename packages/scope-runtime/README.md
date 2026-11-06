# Scope runtime lifecycle

Matrix Bot and managed Pi Chat use separate fixed profiles. Version 2 of both
profiles replaces the worker's total 900-second lifetime with a renewable
900-second supervisor lease. A busy turn has no total wall-clock RPC deadline.
This does not extend a provider credential, grant new access, or reserve funds.
The broker still authorizes each inference/tool action under its existing policy.

## Lease and cleanup

- The gateway renews an active runtime every 30 seconds. `runtime.renew` accepts
  only its existing handle and execution generation. It cannot select a root,
  profile, duration or capability. Only the two Pi profiles qualify.
- Renewal returns the same handle/generation with `state: "running"`. Expired,
  stopped, absent, wrong-generation or wrong-profile runtimes are rejected;
  the gateway client throws `ScopeRuntimeClientError("runtime_unavailable")`.
- Renewal must arrive before expiry. With a responsive supervisor, its
  30-second sweep stops lost runtimes within 930 seconds of the last renewal.
  A stalled supervisor is handled by the independent watchdog below. Use after expiry
  is refused immediately even if the sweep has not run yet.
  These process-local deadlines use monotonic elapsed time, so host wall-clock
  adjustments neither extend a lost lease nor expire a live one early.
- Stop revokes renewal before stopping the unit. A failed stop remains revoked
  and is retried by the bounded sweep. Shutdown clears timers and drains work.
- A restarted supervisor stops reconciled Pi units instead of adopting an
  unproven gateway lease. Old profile provenance cannot qualify as version 2.
- Pi workers retain their fixed UID, network, mount, memory, CPU and task
  isolation. Their `RuntimeMaxSec=infinity` is paired with both `BindsTo` and
  `After=matrix-scope-runtime.service`, so supervisor stop/failure removes them.
- The supervisor keeps `Type=simple`, with `WatchdogSec=60` and
  `NotifyAccess=all`. Only its own cgroup's trusted notifier child can notify;
  workers live in separate units. After server startup, a normal event-loop
  timer invokes fixed `/usr/bin/systemd-notify WATCHDOG=1` every 15 seconds,
  bounded to five seconds and one child. Outside the real system-service
  watchdog environment this helper does nothing. Shutdown clears its timer
  and aborts the notifier. A blocked event loop cannot send heartbeats;
  systemd fails/restarts the supervisor using its existing termination grace.

## RPC bounds and cancellation capacity

The client reserves four independent lanes: 32 ordinary requests, 32 renewals,
32 `bot.cancel` requests and 32 hard Stop requests. Pending cancellation cannot
occupy hard Stop slots. The validated RPC type determines the lane;
ordinary methods cannot select emergency capacity. Excess requests fail with
`client_capacity`; slots are released on success, error, abort or close. The
supervisor caps sockets and outstanding operations at 128. The worker retains
its existing four-connection cap. This does not raise the 32-runtime limit.
Other local callers can still exhaust the supervisor socket cap; access to
that socket remains the existing trusted gateway/host boundary.
The worker's four sockets are shared by run and control commands; if those are
occupied, hard Stop still operates through the host supervisor rather than
the worker command socket.

`bot.run` uses one newline-delimited request on a full-duplex connection, held
open until its reply. Closing it aborts all relay sockets and releases pending
supervisor operations. It does not independently grant authority or replace
the gateway's Stop/release path. Extra frames close the connection. Control
requests retain EOF framing and bounded timers. Connection establishment,
initial frame reads, controls and individual inference calls remain bounded.
The shared-Chat fixed profile and its lifetime remain unchanged.

The gateway, supervisor and Pi worker must ship together with the version-2
profile catalog. The older half-closed long-turn transport is not version-2
compatible. No source-level test is evidence of deployment or live systemd
behavior.

## Verification boundary

`tests/scope-runtime/pi-runtime-turn-transport.test.ts` exercises real local
Unix sockets across client, supervisor, launcher and worker with fake time:
42 minutes of busy work survives renewal; lost leases, Stop and caller abort
release resources. Lease, watchdog and capacity suites cover fail-closed
renewal, startup cleanup, notifier failure/close, fixed isolation, independent
control slots and overflow. No real model, long wait or systemd is required.

Live acceptance remains necessary for systemd watchdog attribution, actual
unit dependency shutdown, provider behavior and a packaged client. The
production supervisor acceptance script pins both version-2 digests but its
shared-Chat model check does not prove a long Pi turn. Public documentation
should be updated separately in `FinnaAI/matrix-os-site` before release.

## Inherited command directories

The current Chat3, Bot4 and managed Pi4 command policy requires PID1-declared
root:matrix state and `runtimes` anchors at `02700`, and runtime IPC anchors at
`02770`. Private per-runtime roots inherit `02700`; their command leaves inherit
`02733` from a single exclusive `0733` mkdir. The fixed `/usr/bin/mkdir` child
uses pinned parent/executable descriptors, fixed arguments and a sterile
environment. It does not change the supervisor's `0007` or workload's `0077`
mask, capabilities, groups, or `RestrictSUIDSGID=yes`.

Creation has one active child, at most 31 queued calls, a five-second queue
wait, a three-second child deadline, and a 1 KiB combined output limit. Slots
and descriptors are retained until child close; controller shutdown fences new
requests and awaits its accepted operations. Missing/wrong inheritance,
collisions and uncertain outcomes fail closed. Failed creates can retain owned
orphans for quiesced reconciliation; no foreign leaf is chmodded or recursively
removed by creation error recovery. Source tests model Darwin setgid explicitly
and do not replace hardened Linux execution of the final compiled helpers.

A failed launcher start fences new creates for that supervisor incarnation.
Existing runtime controls remain available, and already-admitted work drains
within the 32-runtime admission bound. Naturally exited runtimes release their
slots only after ownership-checked cleanup; failed cleanup retains the slot.
Prune, Stop, lease expiry and shutdown share at most one cleanup per handle, and
shutdown drains admitted creates through any post-close cleanup. No timer or
successful Stop clears the fence. A fresh controller must complete ownership-checked startup reconciliation
before admitting creates again; failed recovery leaves the artifacts intact.
