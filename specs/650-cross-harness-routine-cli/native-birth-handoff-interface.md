# Retained process birth handoff

## Scope and trigger

The approved keeper path must preserve a real process lifetime across its private channel. A sampled PeerIdentity DTO or PID in a payload cannot do that. This increment adds only a Linux native-helper transport primitive; no production receiver, keeper, initializer, source authorization or model invocation is enabled.

## Signature

controlSendChildBirth(channel, payload: Buffer, birth) -> writtenByteCount

channel must be the opaque parent endpoint created by controlPair. An internal zero-default marker distinguishes it from ordinary accepted Terminal kind2 sockets. birth must be a live opaque retainChild handle. There is no raw descriptor, supplied PID, descriptor list, source flag or serialized proof parameter.

## Contracts

The helper sends exactly one genuine pidfd through SCM_RIGHTS with1..8192 payload bytes. Sender credentials come from the kernel. The original birth remains owned by its caller; the receiver owns its independently installed descriptor and must close it on rejection/teardown. No sender-side handle is allocated, so the existing shared128-handle limit remains unchanged.

The caller must create birth from its actual retained spawn return. retainChild(pid) alone is an observation primitive, not proof of spawn provenance. Expected identity must never come from the received payload, first connector, process label or descendant scan. A legitimate pidfd proves a process lifetime; it does not prove executable continuity, current native policy, canonical owner/Computer/private Chat/Bot/run or routine approval.

## Validation and error matrix

| Condition | Result |
| --- | --- |
| Wrong role, closed/dead birth, invalid buffer/size or privileged context | Coarse unavailable error before bytes; no permission repair |
| Positive sendmsg return | Preserve actual written byte count, including partial delivery |
| EAGAIN/EWOULDBLOCK/EINTR before bytes | Return0 and retain the open control/birth |
| Other write error | Close only the control role and return a coarse error |
| Target exits after write | Caller rechecks original birth/currentness; delivered bytes cannot be undone |

The syscall is nonblocking and suppresses SIGPIPE. Incoming public receive remains strict and rejects all rights. A future separately typed private receiver must validate its actual parent and original deadline, accept only its exact pidfd role with MSG_CMSG_CLOEXEC, and own all received descriptors. This increment does not implement that receiver.

## Good, base and bad cases

Good: retain actual childA, hand its birth over a dedicated control to a receiver, and compare kernel observations with independently retained A. Base: old control/stdout/Terminal APIs retain their semantics. Bad: put another PID or verified:true in payload and treat it as authority, upgrade an ordinary Terminal channel, or equate a closed handle/ACK with native exit.

## Required tests and evidence

Tests preceded implementation: actual helper/receiver C compiles passed, then the old helper failed exactly its missing required API. The actual Linux ARM64 Node24 lane passes11 mandatory handoff cases plus20 existing control and34 stdout/Terminal cases, no skips or pending cleanup. It exercises genuine pidfd receipt, wrong body identity, independently owned copies, real child exit, role/input/dead-proof rejection, exact payload bounds, shared-handle exhaustion, receiver cleanup and EAGAIN/peer loss.

Command completion waits for both its ACK and command-specific stdout result; independent pipes have no shared delivery order. Failed cases drain their own resources before subsequent cases, preserving the global cleanup fallback. Fault qualification must distinguish its intended assertion failure from secondary fixture/resource effects. Receiver C is an isolated observation fixture, not product source admission.

```sh
node --expose-gc tests/gateway/native-birth-handoff-runtime.mjs --addon /reviewed/birth.node --receiver /reviewed/birth-receiver
```

Source/syscall flags are independently inspected. A cap0-only runner does not prove denial in a privileged context; removing DONTWAIT alone is redundant with an already nonblocking descriptor. Do not claim those mutations are detected without an additional qualified boundary test.

## Wrong versus correct ownership

Wrong: retry the complete rights-bearing message after a partial write or lost reply. Correct: retain the original operation/deadline/reservation, send remaining bytes without another right after the first positive transfer, and preserve an unknown outcome when delivery may have occurred. No new UUID, readiness claim, native-stop claim, background grant or source restoration follows.
