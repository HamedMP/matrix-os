# Workspace keeper private launch channel

Status: transport foundation only; source admission remains disabled. This layer reuses the existing systemd-run anonymous pipe. It does not start a workspace keeper, initialize a Zellij session, retain a native process or issue routine authority. The existing managed-agent and Terminal wrappers retain their validators and protocol schemas.

## Signatures and contracts

`@matrix-os/terminal-runtime/held-launch-channel` exposes the bounded pipe mechanics. Its trusted caller supplies separate strict host, child and first-frame schemas, plus reserved ready/end types. The first frame is decoded with that wrapper's handshake schema. Gateway keeps launch-spec validation and its managed-agent/Terminal wrappers; terminal-runtime does not import Gateway.

`@matrix-os/terminal-runtime/workspace-launch-protocol` exposes the workspace-only wrapper. Every frame has `v: 1` and rejects unknown properties.

| Direction | Type | Fields besides v/type | Meaning |
| --- | --- | --- | --- |
| Keeper to host | workspace.keeper.ready | keeper UUID, channel UUID, digest (64 lowercase hex) | Pipe correlation only |
| Host to keeper | workspace.host.ready | Same keeper/channel/digest | Correlation reply |
| Host to keeper | workspace.fence | requestId UUID, nonce (64 lowercase hex), deadlineNs | Request authority fencing under the original deadline |
| Keeper to host | workspace.fenced | Matching correlation shape, outcome: unknown | Never proves native stop or completed dispatch |
| Host to keeper | workspace.disconnect | None | Close this private role |
| Keeper to host | workspace.end | None | End this private role |

`deadlineNs` is a canonical positive decimal u64 string for the original monotonic deadline. Schema validation only checks representation/range; the future keeper must enforce expiry at every asynchronous boundary. This foundation has no preparation/release/template API and does not validate operation correlation or execute fence requests by itself. Model-supplied owner, Computer, Chat, Bot, run, PID, policy or source/proof flags are not accepted in these messages.

## Limits and failures

The extraction preserves the existing limits: 196608-byte frame/buffer bound, a ten-second startup handshake, four subscribers, 16384 bytes of stderr and the existing two-frame writable-queue backpressure check. Repeated ready, unexpected first frame, digest mismatch, invalid/oversized JSON, stream errors/EOF and explicit end close the channel. Subscriber failures fence it and notify its remaining close subscribers.

The returned ChildProcess belongs to the systemd-run relay. A matching digest or generation string does not identify the service, keeper, daemon, native harness or canonical Matrix action. Channel closure closes its anonymous pipe; it does not signal, restart or stop the service. A closed/unknown operation must not be retried with another UUID. Actual lifetime and cleanup require separate retained ownership observations.

## Verification

Tests were added before implementation. The original implementation produced the expected missing-module API-absence failure, with the old protocol rejection control passing. After extraction, the focused suite passed 37 tests with no skips, including retained managed/Terminal regressions and a real no-account Node stdio child. That child is a pipe/lifetime control, not an actual systemd or keeper integration. A disposable hardcoded-first-frame regression failed the explicit non-managed handshake case; production bytes were restored unchanged. Terminal-runtime and Gateway targeted typechecks passed.

```sh
pnpm exec vitest run tests/terminal-runtime/keeper-shared-transport.test.ts tests/terminal-runtime/workspace-launch-protocol.test.ts tests/gateway/background-agent-runtime.test.ts tests/gateway/terminal/launch-protocol.test.ts --maxWorkers=1 --no-file-parallelism
```

Actual manager pipe probes, owned Zellij entry tests, keeper/session initialization, protected native executable continuity, current policy and canonical action binding are separate evidence lanes. This transport result qualifies none of those lanes and grants no background-model or integration permission.

## Validation and error matrix

| Input or event | Result |
| --- | --- |
| Matching strict first-frame schema/digest | Resolve the correlated channel and send its typed reply |
| Wrong first-frame role, unknown fields, wrong digest or duplicate ready | Close; startup rejects with Private launch unavailable if unresolved |
| Invalid host frame or exceeded writable threshold | send returns false and closes |
| Child end/EOF/error, oversized input/stderr or throwing subscriber | Fence/close; notify close subscribers; no native stop claim |
| Invalid deadline syntax, zero or greater than u64 | Schema rejects without throwing a BigInt conversion error |

## Good, base and bad cases

Good: an explicitly supplied non-managed handshake works through the shared transport. Base: existing managed/Terminal wrappers retain their original schemas and close semantics. Bad: requiring a managed-wrapper ready type inside shared mechanics breaks another strict wrapper. A caller-supplied source flag is invalid, even on a correlated channel.

## Required tests and common mistake

Retain assertions for distinct handshake roles, matching digest, repeated-ready rejection, unknown properties, malformed deadlines, exact byte/error/backpressure/subscriber bounds, split UTF8 and EOF. Keep the real stdio child alive after channel close, then explicitly clean it up. Required manager/keeper/native acceptance must execute its real boundary separately and fail when prerequisites are absent.

Wrong: decode every first frame with ManagedShimFrameSchema. Correct: decode with protocol.handshakeSchema and validate its digest before sending the typed reply. The named disposable regression must fail the explicit non-managed-handshake test.
