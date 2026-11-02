# Inherited workspace control interface

Private Linux transport in the existing terminal-writer N-API helper. This is
**not source admission**; sources remain OFF until product wiring, protected
package/image continuity, current native policy and canonical owner/Computer/
private Chat/Bot/run joins qualify. ENG-93 approvals and background/integration
permissions remain separate. No new CLI framework, scheduler or MCP service.

## Fixed role and ownership

`inheritedControl()` takes no arguments. A single atomic attempt per process is
burned before validation, including failed or Worker attempts; recovery requires
relaunch. Only the main thread may adopt/use this role. It requires nonroot,
equal real/effective UID/GID, cap0, and fixed stdin/stdout referring to the same
anonymous Unix stream with SO_PASSCRED already enabled. No PID/FD/identity input,
proof getter, restoration file, first connector or descendant scan selects it.

The creator's SO_PEERCRED and direct SO_PEERPIDFD bind its retained kernel birth.
The keeper's actual parent may be the user-manager; it is not substituted for
the Gateway creator. Unsupported kernel capability fails unavailable, without
numeric PID reopening or permission repair. Actual Dev Linux6.8 capability was
observed separately; runtime support is not inferred from header constants.

The opaque role owns one CLOEXEC/nonblocking duplicate plus the creator pidfd,
charging both against the existing atomic128-FD budget. All construction failures,
explicit close and GC release owned descriptors. Raw0/1 remain process-owned.
Setting O_NONBLOCK and SHUT_RDWR affects all aliases: the protected caller must
provide dedicated endpoint use, no other readers/writers or stdin consumer, and
never forward private raw0/1 into later children. Explicit child stdio policy is
required; owned-descriptor CLOEXEC alone does not protect deliberate inheritance.

## Currentness and I/O

`inheritedControlCurrent(handle)` checks role, main thread, exact captured local
UID/GID, cap0 and retained creator life. Known HUP/RDHUP/ERR/NVAL fences even when
the creator lives and old bytes are queued. False closes/fences; closed/wrong
handles throw unavailable. True is a bounded observation, not authorization.

Existing `receive(handle)` and `send(handle, Buffer)` accept this distinct role
alongside their existing Terminal role. Receive rechecks before/after the syscall
and requires every positive read's actual kernel PID/UID/GID to match the creator.
Rights, automatic SCM_PIDFD, missing/foreign/truncated metadata are rejected and
all installed descriptors closed. Zero bytes is EOF/control loss, never a message
or native-exit result. Existing chunk/byte caps remain unchanged.

Send rechecks currentness before I/O and preserves its physical written-byte
count. Positive/partial bytes cannot be undone; transient zero is not completion.
Callers retain the original deadline, UUID and reservation and report Unknown
after possible effect/lost completion, without replay or a fresh identity.

`close(handle)` shuts down this socket and closes its owned duplicate/proof.
New writes through aliases fail; already queued raw bytes may remain readable.
They cannot restore the closed role or authorize dispatch. No keeper/daemon/
workload is signalled.
EOF, ACK or closed handles do not prove execution stopped. Existing explicit
stop and actual lifetime observation remain the stop path.

## Validation boundary

`tests/gateway/native-inherited-control-runtime.mjs` runs against the compiled
helper and separate real creator/relay/service processes. API-absence Red is
distinct from behavioral Red/Green. Real kernel descriptor ownership and close
checks preserve the existing handoff/control/stdout/Terminal regression lanes.
Test IPC carries fixture observations only. Manager socket capability checks,
isolated native tests, shipped x64, product keeper/initializer, real harness and
account acceptance are separate evidence; none may substitute for another.

## Validation and error matrix

| Condition | Result |
| --- | --- |
| Dedicated valid stdio, live exact creator, first main-thread attempt | Opaque cost2 role |
| Arguments, Worker, unsuitable stdio/domain or unsupported creator proof | Generic native unavailable; attempt remains spent |
| Wrong role or closed handle | Generic native unavailable |
| Observed creator/control loss | Role closed; current false on that first observation |
| Positive message from another actual writer, rights or invalid metadata | Role fenced and generic native unavailable |
| Nonblocking no-data or transient send | Existing null/zero result; no completion |
| Positive or partial physical send | Actual byte count; caller retains possible effect/Unknown |

These are internal transport results. The agent-facing routine CLI keeps its
existing structured errors and separately validates current canonical context.
No transport outcome approves a proposal or enables background authorization.

## Examples and required assertions

Good: a dedicated inherited stream's real creator differs from the service's
actual user-manager parent; the creator's genuine per-write frame is accepted.
Base: no data yields the existing transient result, with the original deadline.
Bad: a same-UID process copies the opposite endpoint and claims the creator PID
in JSON; its different actual kernel writer PID must fence the role.

Wrong: use `getppid()` or a body PID as the expected Gateway, or treat queued raw
bytes after shutdown as restored authority. Correct: obtain the creator birth
from that exact inherited endpoint, authenticate each positive writer and keep
the role closed after a loss observation.

Mandatory native assertions include indirect creator binding, copied-writer
refusal, live-creator control loss with queued bytes, rejection/closure of actual
automatic SCM_PIDFD, acquired-fd2 cleanup, explicit close and readoption refusal.
The same compiled Linux lane also exercises invalid-call attempt burn, actual
Worker refusal/exit and shared attempt burn, odd127 cost2 refusal, real GC
reclamation/alias fencing and wrong-role/getter rejection. Four corresponding
faults isolate failed-call burn, Worker burn, two-slot reservation and GC
shutdown, each with one intended failure.

Constructor-domain/stdio variants, creator death with copied endpoints,
allocation failures, cross-Worker capacity races and protected module/image
continuity remain separate qualification gates. Privileged/foreign-UID mutation
coverage must never be inferred from cap0-only tests.
