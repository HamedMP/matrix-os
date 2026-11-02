# Keeper-local owned Root startup

Status: source-only isolated adapter under validation. It has no production keeper/controller caller, managed-generation capability, source admission or account qualification. The old keeper remains unchanged. This module does not propose/approve a routine, enable a background model or grant an integration permission.

## Scope and exact dependencies

The Matrix source base is native transport commit `cfa7baf0ed6b426651f84195f9962ee860c07449` (#3085). The actual addon source is `5001a747a8860936d4d27ffeb3cc5fb1ca9c77f053787fb06eaf160dfd94adec`. The locally qualified, unpublished Linux ARM64 default-feature Root is based on Zellij v0.44.3 commit `55a2121b73dce4be624cda425a960e893000777c`, with executable SHA256 `0c61fea8def5ef81a50144c2dc7339c5b798f77133132ed2901ad4a6e9125dfb`. An official v0.44.3 download does not contain this private extension. Installed x64-musl and real user-systemd qualification remain separate.

`owned-root-startup.mjs` owns one directly spawned initializer and foreground daemon. It is intended to be bundled into the existing protected generation; a raw copied keeper must not resolve mutable application modules. The future trusted caller supplies canonical descriptor/generation configuration and both execution-eligibility checks. Owner/Computer/private Chat/Bot/run and actual harness identity stay in their existing authenticated admission paths; they are not startup inputs or inferred from these children.

## Internal API

`createOwnedRootStartup(options)` validates its native dependencies and creates one retained operation. Options contain the native addon, absolute executable/cwd/layout/socket paths, canonical session, exact initial environment, selected generation, original monotonic deadline, mandatory initial/daemon execution validators and synchronous actual-child supervision callback. The operation generates its own private nonce. It accepts no caller PID, source flag, model identity or permission assertion.

| Method | Meaning |
| --- | --- |
| `start()` | One cached promise of `{disposition: "first_frame_complete" \| "unsent" \| "unknown"}`. Repetition cannot create another initializer or daemon. Runtime failures are coarse dispositions. |
| `fence()` | Close private roles/refuse new work. It neither kills a workload nor changes a settled result. |
| `observe()` | Coarse initializer/daemon lifecycle and fenced state. An exit requires an actual child wait; missing proof is unknown. This is not a source proof. |
| `waitForExit(role, observationDeadlineNs)` | At most one pending observation per role. Observe an actual child exit `{code, signal}`. Concurrent attempts and timeouts reject; it does not synthesize stopped state or extend the startup budget. |
| `disposeExited()` | Release actually settled resources. Unresolved children stay retained. It does not signal or stop them. |

The supervision callback receives the actual internally returned `ChildProcess` and a frozen borrowed `{alive()}` view. The operation exclusively owns the raw native birth handle. The callback records the child before querying that view; a failed retain makes `alive()` unavailable, never permission to reopen a received PID. Callback failure cannot discard the actual child. These are local lifecycle observations, not the intended harness native root or a Matrix action binding.

## Producer/consumer flow

The trusted workspace caller first creates its owned canonical socket parent. That directory is IO configuration, not identity. The producer uses one original budget of at most five seconds. It validates the initial execution configuration, directly spawns the blocked private initializer, retains its actual returned child and sends `MXZPREP` kind 1 on an anonymous socket. Every positive reply chunk must match that retained initializer's kernel writer credentials and current birth.

Only a complete, bounded, independently correlated environment reply permits the daemon execution check. The daemon receives exactly that map, without filtering or reapplying defaults. It is directly spawned in private foreground mode and independently retained. Its bootstrap ACK is correlation only. Observing the owned socket path does not establish identity; the initializer's one connection verifies the real retained daemon birth/peer.

The target carries the genuine daemon pidfd on the first positive send only. Remaining bytes do not duplicate rights or renew the deadline. The producer conservatively records possible handoff before the first native attempt. Normal initializer exits 0/69/75 mean checked first-frame completion / known first-frame Unsent / Unknown. Completion is not initialized-session readiness; Unsent does not mean no daemon or no earlier IO effects. Unexpected loss after possible handoff remains Unknown, with no retry, replacement UUID or ordinary-launch fallback.

The binary codec reuses the private Rust protocols: 8 KiB configuration/bootstrap/target frames, 64 KiB environment reply, 48 KiB aggregate environment, 512 entries, 256-byte keys and 16384-byte values. It rejects malformed/trailing/duplicate data, wrong correlation, invalid UTF8, unsorted/duplicate keys, invalid syntax and digest mismatch. Valid UTF8 bytes are preserved. Raw environment buffers are wiped; transient private JavaScript strings are not claimed physically zeroized. Raw environment, stderr and process identifiers are not result fields or persisted authority.

## Qualification

Portable tests cover wire data and dependency admission; they do not constitute native execution. The required Linux fixture uses the real addon and exact patched Root:

```sh
node tests/gateway/owned-root-startup/run.mjs \
  --addon <actual-built-addon> --zellij <exact-patched-Root> \
  --producer <owned-root-startup.mjs> --evidence <fresh-directory>
```

Missing prerequisites, producer, assertions or required cases fail. Actual direct-child ownership, per-write credentials, exact initializer/daemon exec environments, initialized Screen/native PTY and actual child waits require their own evidence. Isolated execution validators are fixtures, not production image/namespace/native-policy proof. Physical Unknown, copied writers, late validators and lost-control effects must remain separately identified; a kill/fence ACK is not an observed process exit.

Full host-to-keeper same-socket transport and legitimate manager/keeper proof, versioned dual-unit reservation compatibility, protected generation packaging, current native harness policy, canonical private context, human routine approval, independent background/integration permission, real account acceptance and the conditional demo video remain open.

## Recorded isolated evidence

The missing producer/codecs first failed as explicit API absence after the actual addon compiled/loaded and the patched Root hash matched. Portable wire/dependency tests then passed 16 assertions. A focused existing-transport regression run passed 53 assertions across six files, without skips; canonical test preparation, repository typecheck and patterns passed.

The required Linux lane passed all seven actual cases: full initializer/daemon/Screen/PTY flow and duplicate startup, credentialled malformed reply, copied kernel writer with a valid reply, both late-validator stages, bounded exit observation and possible-handoff loss retaining Unknown plus a live daemon. Signals in the last case are explicit fixture actions on actual owned children; it does not establish actual stock-frame effects, Root exit75 or a ready session.

Two real regressions were first reproduced and fixed: the parent duplicate endpoint closed too late, and timed-out exit observers could accumulate unresolved Promise reactions. The fixed lane enforces one pending observer per role and releases capacity after timeout. Named isolated faults removing sender-PID equality, the initial environment snapshot or the possible-handoff latch each caused its intended assertion failure while other cases passed. The worktree's production bytes remained unchanged by those faults.

Retain the earlier setup failure: the fixture had omitted the versioned socket parent, so the foreground daemon exited before target handoff. A single fixture-directory correction made the same production bytes pass. That failure and its diagnostic trace are not counted as successful integration. Independent reviews checked the byte deltas, required cases, genuine process/writer boundaries and actual cleanup.

These are isolated producer components. They do not close production execution eligibility, failed-retain/callback-failure qualification, installed x64/systemd, legitimate manager/keeper and actual harness proof, canonical account/routine acceptance or video gates.
