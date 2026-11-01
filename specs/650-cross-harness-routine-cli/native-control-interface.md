# Anonymous keeper-to-daemon control transport

This foundation extends the existing Linux native helper. It supplies transport observations, never routine/source authorization. Keeper/controller/session routing and native policy/canonical binding remain deferred.

## Signatures and contracts

- controlPair(): { channel, child, uid, gid }. Two separately owned opaque socket handles; both endpoints enable SO_PASSCRED before any spawn. Both are CLOEXEC; only the parent channel is nonblocking.
- controlChildFd(child): number. Exposes only the child-role descriptor for fixed-role inheritance, without duplication or another reader. The intentionally inherited child fd is not CLOEXEC after dup2; its receiving private role must restore CLOEXEC before later children.
- Existing receive(channel), send(channel, Buffer), close(handle), retainChild(actualChild.pid) and childAlive(birth) retain their existing semantics. The channel uses the existing strict receive/send role; a child handle cannot be used as that role or as a stdout handle.

The existing shared128-handle cap, explicit/idempotent close and GC finalizer apply across old and control roles. UID/GID are observations, not asserted identity. A caller must retain its actual spawn return and birth handle and compare every received writer against it; JSON PID fields and socketpair creator identity do not establish the spawned writer. No arbitrary-fd receive API, listener, daemon or authority flag is added.

## Validation and errors

| Boundary | Behavior |
| --- | --- |
| Unsupported/privileged context, invalid role, exhausted shared cap or setup failure | Coarse native unavailable error; close owned partial setup |
| Valid receive | Bounded bytes plus actual per-receive kernel writer metadata |
| Missing, duplicate, truncated or unexpected ancillary metadata | Reject and close control |
| Delivered SCM_RIGHTS | Close every delivered descriptor and reject control |
| EOF | Close this role; native child may remain alive |
| Child birth no longer alive | Consumer obligation (test-only guard here): reject even authentic queued bytes; never adopt a PID or retry |

Product source admission remains deferred. No syscall/readiness result proves a listener, initialized session, native stop or current executable image. PIDFD and SCM credentials alone do not detect same-PID exec. Failed proof must remain unavailable rather than alter native/background/integration permission.

## Cases and required assertions

Good: create the pair before direct spawn, pass only the child descriptor to its fixed role, close the parent's child copy, retain actual birth and check sender/currentness before parsing. Base: legacy stdout and Terminal APIs remain unchanged. Bad: accept a forged PID in the payload, use SO_PEERCRED creator as the child, or treat close/ACK as native exit.

Actual tests first produced one required-API-absence failure after all three C compiles passed. Final Linux ARM64 Node24 lane passed20 mandatory control tests and34 retained stdout/Terminal tests, zero skips. They cover queued-before-spawn credentials, foreign copied writers, rights cleanup, strict metadata faults, real EOF/exit, original consumer budget, spawn failures and GC. Mixed legacy/control odd127 occupancy and reverse exhaustion enforce the shared cap. A disposable max_open-1 guard fault fails exactly the odd127 two-slot reservation assertion; shipping code stays unchanged.

The separate actual helper-to-Zellij bootstrap probe checks writer/birth, an original two-second correlation budget and EOF-with-child-alive, then explicitly stops/waits the owned process. It does not initialize a session or execute a keeper/harness/account. It requires separately reviewed built artifacts and fails on missing prerequisites.

```sh
node --expose-gc tests/gateway/native-control-runtime.mjs --addon /reviewed/control.node --fault-addon /reviewed/control-fault.node --actor /reviewed/control-actor
node tests/gateway/native-control-owned-bootstrap.mjs /reviewed/control.node /reviewed/zellij /owned/evidence.json <reviewed-zellij-sha256>
```

Wrong: ACK means started/stopped or source authorized. Correct: ACK correlates a private exchange; retain the original reservation/unknown outcome until the actual owning lifecycle and canonical authorization settle. These tests grant no source, background-model or integration permission. Full manager/keeper/shipped-target/account acceptance remains separate.
