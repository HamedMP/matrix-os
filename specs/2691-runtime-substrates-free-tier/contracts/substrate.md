# Contract: runtime substrate and capabilities

Proposed location: `packages/contracts/src/runtime-substrate.ts` (schemas) and
`packages/platform/src/substrates/` (implementations). Schemas use Zod 4.

## Substrate interface (platform)

```ts
type SubstrateKind = "vps" | "container";

interface RuntimeRef {
  machineId: string;
  handle: string;
  runtimeSlot: string;
  generation: number;
}

interface RuntimeSubstrate {
  readonly kind: SubstrateKind;
  /** Upstream for proxying, or null when the runtime is not routable right now. */
  resolveUpstream(machine: RoutableMachine): RuntimeUpstream | null;
  /** True when a stopped runtime can be started on request. */
  readonly startsOnDemand: boolean;
  ensureRunning(ref: RuntimeRef, signal: AbortSignal): Promise<EnsureRunningResult>;
  stop(ref: RuntimeRef, signal: AbortSignal): Promise<void>;
  destroyCompute(ref: RuntimeRef, signal: AbortSignal): Promise<void>;
  listCompute(signal: AbortSignal): Promise<SubstrateComputeRecord[]>;
}

interface RuntimeUpstream {
  url: string;              // built from platform records only
  hostHeader: string;
  tlsServerName?: string;
}

type EnsureRunningResult =
  | { state: "running" }
  | { state: "starting" }
  | { state: "busy" }       // capacity
  | { state: "failed"; code: "start_timeout" | "provider_unavailable" | "needs_recovery" };
```

Rules:

- `vps` implements `resolveUpstream` with today's behaviour, including the recovering
  case, and has `startsOnDemand = false`. `ensureRunning` returns the current state
  without side effects.
- Errors are typed codes. Provider names and addresses never cross this interface into
  client responses.
- Every method takes an `AbortSignal`; callers pass `AbortSignal.timeout(...)`.
- Substrates are constructed at startup. A substrate with incomplete configuration is
  not registered, and routing to a runtime of that kind returns a 503-class response.

## Capability projection (gateway)

`GET /api/runtime/capabilities` returns:

```ts
interface RuntimeCapabilitiesV1 {
  version: 1;
  substrate: SubstrateKind;
  capabilities: Record<CapabilityId, {
    state: "available" | "disabled-by-policy" | "unsupported"
         | "setup-required" | "temporarily-unavailable";
    upgradeUnlocks?: boolean;
  }>;
}

type CapabilityId =
  | "chat.matrix_ai" | "chat.coding_harness" | "apps.build" | "apps.node_runtime"
  | "files" | "terminal" | "code_editor" | "channels" | "cron" | "bots"
  | "integrations" | "sites.publish";
```

The set is computed once at gateway startup from the runtime profile and is immutable
for the process. Clients gate UI on it and never on plan or substrate.

## Runtime state (platform to clients)

Added to the existing journey and computers responses:

```ts
type RuntimeState =
  | "ready" | "waking" | "restoring" | "busy" | "limit_reached"
  | "failed" | "migrating" | "waitlisted";
```

`limit_reached` carries a coarse reason: `ai_allowance`, `storage`, or `compute`.
