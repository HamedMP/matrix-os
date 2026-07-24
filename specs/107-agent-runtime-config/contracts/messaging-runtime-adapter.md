# Messaging Runtime Adapter Contract

This internal contract normalizes Hermes and OpenClaw. It is not a public pass-through API.

## Interface

```ts
type AgentRuntimeId = "hermes" | "openclaw";

interface MessagingRuntimeAdapter {
  readonly id: AgentRuntimeId;
  probe(signal: AbortSignal): Promise<RuntimeDescriptor>;
  catalog(signal: AbortSignal): Promise<AgentProviderDescriptor[]>;
  selection(signal: AbortSignal): Promise<MessagingSelection>;
  configure(input: RuntimeConfigureInput, signal: AbortSignal): Promise<MessagingSelection>;
  prepare(signal: AbortSignal): Promise<void>;
  activate(signal: AbortSignal): Promise<void>;
  deactivate(signal: AbortSignal): Promise<void>;
  dashboard(signal: AbortSignal): Promise<MessagingDashboard | null>;
  close(): Promise<void>;
}
```

Every result crosses a strict Zod boundary before orchestration or response use. Methods throw typed internal errors; the route mapper emits provider-neutral safe errors.

## Configure Input

```ts
interface RuntimeConfigureInput {
  provider: string;
  model: string;
  baseUrl?: string;
  expectedConfigRevision?: string;
}
```

- Provider/model must appear together in the adapter's current catalog.
- A provider's effective `authKind` must be present in its non-empty `supportedAuthKinds` list.
- `baseUrl` is allowed only when that provider advertises `base_url`.
- Config revision is runtime-internal concurrency metadata and is never exposed as a credential.
- API keys and OAuth login use separate write-only/setup methods, not `configure`.

## Lifecycle Guarantees

- `probe`, `catalog`, `selection`, and `dashboard` are read-only and must not install, start, stop, or mutate a runtime.
- `prepare` validates install/config/admission without claiming Matrix work.
- `activate` may start the fixed service and enable work claiming only after the controller has paused delivery.
- `deactivate` stops new claims before service stop and is idempotent.
- `close` aborts outstanding RPC, closes sockets, clears timers and correlation entries, and may be called more than once.

## Hermes Mapping

| Adapter method | Existing Hermes operation |
|----------------|---------------------------|
| `probe` | dashboard status + model info, normalized |
| `catalog` | model options, normalized/capped |
| `selection` | model info |
| `configure` | model set with `scope: main` |
| `dashboard` | normalized platforms/config summary |
| lifecycle | fixed Matrix runtime controller action |

Hermes env/config reads remain redacted. No generic Hermes route is added.

## OpenClaw Mapping

| Adapter method | Allowlisted OpenClaw RPC/controller operation |
|----------------|----------------------------------------------|
| `probe` | `health`, `channels.status`, fixed service status |
| `catalog` | `models.list` + `models.authStatus` |
| `selection` | `config.get`, selected model fields only |
| `configure` | `config.get` hash + `config.patch` selected model/base URL |
| `dashboard` | normalized health/channel/model summary |
| lifecycle | fixed Matrix runtime controller action |

No arbitrary RPC method, JSON path, plugin operation, raw schema, auth profile, or config object reaches callers.

## Delivery Envelope

The V1 adapter does not expose Matrix room access directly. Matrix OS hands the selected runtime a sanitized envelope after current permission checks:

```ts
interface MessagingWorkEnvelope {
  workId: string;
  roomId: string;
  eventId: string;
  permissionRevision: number;
  kind: "draft_reply" | "summarize" | "classify" | "automation";
  body: string;
  deadlineAt: string;
  capability: string;
}
```

Limits:

- Body maximum 64 KiB and no attachment bytes inline.
- Capability is short-lived, scoped to work id/room/event/action, signed by Matrix, and never placed in a model prompt.
- Runtime output must include `workId`; output from the wrong transition/runtime id or after deadline is discarded.
- Matrix rechecks permission revision and room mapping before any reply send.

## Error Contract

Internal error kinds:

- `not_installed`
- `not_configured`
- `authentication_required`
- `unreachable`
- `timeout`
- `invalid_response`
- `conflict`
- `resource_limit`
- `transition_failed`

Internal errors may retain a cause for server logging, but routes expose only the safe mapper codes defined in the HTTP contract.
