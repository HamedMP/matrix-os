# Resource Management

## Published Caps

| Resource | Limit | Enforcement |
|----------|-------|-------------|
| Agent settings request body | 16 KiB | Hono `bodyLimit` before parse |
| Provider credential DELETE body | 1 KiB | Hono `bodyLimit` before handler |
| OpenClaw RPC request | 16 KiB serialized | Adapter rejects before send |
| OpenClaw RPC response | 1 MiB frame; parsed normalized output capped further | WebSocket max payload + schema |
| Runtime descriptors | 2 | Fixed enum |
| Provider descriptors | 32 | Normalize then truncate deterministically |
| Models per provider | 128 | Normalize then truncate deterministically |
| Total models per response | 256 | Global response cap |
| Model capabilities | 12 | Schema |
| Runtime capabilities | 16 | Schema |
| Concurrent runtime transitions | 1 | Exclusive `wx` lock |
| Runtime transition duration | 75 seconds hard deadline | Controller timeout |
| Active-work drain | 5 seconds | Controller deadline + abort |
| Runtime status cache | 2 runtimes, TTL 5 seconds | Fixed keys, replace in place |
| In-flight OpenClaw RPC | 8 total | Correlation ceiling; excess returns busy/retry |
| OpenClaw config writes | At most 3 per rolling 60 seconds per device/IP | One serialized owner queue; debounce/coalesce compatible pending patches and reject excess work with a bounded retry state |
| Setup/login sessions | 4 owner-local, TTL 10 minutes | Bounded registry + recurring sweep |
| Diagnostic events | 500 entries or 30 days | Owner-local capped rotation |

## Timeouts

- Agent settings aggregate read: 3 seconds hard budget.
- Individual runtime health/config/catalog probe: 2 seconds.
- Kernel/provider config mutation without a runtime switch: 10 seconds.
- Provider credential validation: 10 seconds.
- Custom endpoint validation/probe if enabled after DNS-pinning decision: 10 seconds, redirect error.
- Host runtime control action: 70 seconds, within the 75-second transition budget.
- OpenClaw post-activation readiness probe: 10 seconds, within the same transition budget.
- WebSocket connect and authenticated handshake: 2 seconds.
- Terminal setup session creation: existing terminal API timeout, no hidden background wait.

Timeouts use abort signals or process kill/termination. A timed-out subprocess is reaped; a timed-out RPC closes or invalidates the connection before reuse.

## Runtime Admission

Before OpenClaw installation or activation:

- At least 1 GiB filesystem free space.
- At least 768 MiB available memory.
- Messaging feature floor remains 2 vCPU, 4 GiB RAM, 40 GiB disk per spec 077.
- Package/runtime version must match the host-bundle-pinned supported version.
- Plugin allowlist is explicit and the official Matrix plugin version matches the core package when installed.

Admission failure returns unavailable/action-required and does not affect Hermes or Chat.

## Process Lifecycle

- systemd owns process start, restart, signal propagation, and log capture.
- OpenClaw uses `Restart=on-failure`, bounded `StartLimitIntervalSec`/`StartLimitBurst`, and a memory limit initially set from preview measurements with headroom.
- Both adapters implement `close()`; gateway shutdown drains/aborts RPCs, closes WebSockets, clears timers, and stops accepting transitions before dependent services are destroyed.
- The gateway does not create one runtime process per request.
- Health polling is demand-driven with a 5-second cache, not a perpetual browser-driven tight loop.

## In-Memory State

No unbounded `Map` or `Set` is allowed.

- Runtime status cache has two fixed enum keys.
- RPC correlation map caps at 8 entries, rejects excess, deletes on response/timeout/close, and sweeps any entry older than 10 seconds.
- Login/setup registry caps at 4 entries and sweeps every minute; the timer is unref'd where supported and cleared on shutdown.
- Delivery subscriber registries retain spec 077 caps, last-touched eviction, failed-sender eviction, and explicit shutdown drain.

## Files and Cleanup

- Transition state lives in an owner-only directory with mode 0700; files use 0600.
- Lock files use exclusive create, hold an fd, and are unlinked in `finally`. Startup treats a leftover path as untrusted and uses `lstat`; symlinks are rejected.
- Any installer download uses a unique temp file, maximum expected bytes, 30-second download timeout, signature/integrity verification where published, and deletion in `finally`.
- Runtime config writes are delegated to the runtime's atomic API. Matrix never leaves partial config files.
- OpenClaw config writes are serialized and debounced so Matrix never attempts more than the runtime's 3-per-60-second device/IP limit; a rejected or non-coalescible excess write leaves the last confirmed config active.
- Diagnostic rotation uses async filesystem APIs outside request critical sections and recurring symlink-safe cleanup.
- OpenClaw/Hermes cache/state retention follows their owner-local policies; Matrix reports size but does not sweep unknown runtime-owned files.

## Catalog Determinism

Catalog truncation sorts by:

1. selected provider/model first;
2. configured/ready providers;
3. stable provider id;
4. available models before unavailable;
5. stable model id.

This ensures the active selection is not accidentally dropped and clients see stable results across refreshes.

## Load and Failure Tests

- 100 concurrent Agent settings reads reuse bounded probes and do not create 100 runtime connections.
- 20 concurrent mutations yield one active transition and bounded conflicts; no queued unbounded work.
- Oversized catalogs and frames are rejected/capped without memory spikes.
- Gateway shutdown during health polls, login sessions, and transitions drains all registries and reaps subprocesses.
- Repeated absent-runtime reads do not create temp files, timers, processes, or log floods.
