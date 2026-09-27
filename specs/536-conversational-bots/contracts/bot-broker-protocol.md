# Bot Workload and Broker Protocol

Contract between the scope-runtime supervisor, the `bot_agent` worker, and the gateway broker (research R2-R4, R9). Schemas are Zod 4 in `packages/scope-runtime/src/bot-protocol.ts` and `packages/contracts/src/bots/broker.ts`. Existing `scope-runtime-chat-v1` messages are unchanged.

## Profile

| Field | Value |
|---|---|
| Profile ID | `scope-runtime-bot-v1`, version 1, with its own digest |
| Workload | `bot_agent` |
| Adapter | `matrix-bot`, harness version = bot-runtime bundle version |
| Isolation | Same fixed properties as `scope-runtime-chat-v1` (`DynamicUser`, `PrivateNetwork=yes`, private root, `ProtectSystem=strict`, `ProtectHome=yes`, no capabilities, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` with no network namespace route) |
| Lifetime | `RuntimeMaxSec=900`, `MemoryMax=1073741824`, `CPUQuota=200%`, `TasksMax=256` |
| Mounts | Pinned bot-runtime bundle read-only at `/opt/matrix/scope-sdk/bot-runtime`; node prefix read-only; workspace root read-write at `/workspace`; broker socket; readiness file; command directory |
| Allowed workspace roots | `~/projects`, `~/worktrees`, and `~/bots` |

The supervisor advertises both profiles:

```json
{ "profiles": [{ "profileId": "scope-runtime-chat-v1", "profileDigest": "...", "adapters": [...] }, { "profileId": "scope-runtime-bot-v1", "profileDigest": "...", "adapters": [{ "adapterId": "matrix-bot", "harnessVersion": "...", "workloads": ["bot_agent"] }] }] }
```

The gateway rejects a supervisor whose advertised digest for a profile differs from the digest pinned in the gateway build.

## Launch

`runtime.create` adds `profileId` and, for `bot_agent`, a manifest:

```json
{ "scopeHandle": "scope_<32 hex>", "actorId": "bot_...", "worktree": { "hostPath": "<resolved bot/group root>", "mode": "rw", "fingerprint": "sha256" }, "network": "broker_only", "limits": { "maxRunMs": 600000 } }
```

- Private handles are derived as described in research R4. Group runs use the shared scope's handle.
- The supervisor checks the handle, the allowed root, and that the path exists without symlinks.
- The worker receives `runtimeHandle`, `executionGeneration`, `taskId`, and `runId` as arguments. It holds no credential.

## Worker commands (supervisor → worker, per-runtime command socket)

| Command | Payload | Result |
|---|---|---|
| `bot.run` | `{ sessionRevision, turn: { kind: "prompt", text≤64KiB, images≤4 (≤2MiB each) } \| { kind: "continue" } \| { kind: "resume_after_interaction", interactionId }, tools: ToolDescriptor[] ≤64, systemPromptRef }` | streams events over the broker, then `{ status: "completed" \| "waiting_person" \| "waiting_capacity" \| "blocked" \| "failed", checkpointSeq }` |
| `bot.steer` | `{ text≤8KiB }` | ack |
| `bot.cancel` | `{}` | `{ status: "cancelled" \| "uncertain" }` |

## Broker actions (worker → gateway broker)

Frames are newline-delimited JSON on the broker Unix socket, not HTTP. Model SDKs inside the workload call the shared loopback inference bridge (`packages/scope-runtime/src/inference-bridge.ts`, extracted from `worker.ts`), which translates HTTP to `inference.*` frames; the bot runtime sends `bot.*` frames directly. Authentication is the existing pair of unguessable `runtimeHandle` and current `executionGeneration`. The broker resolves the owning registry: `BotRuntimeRegistry` or `SharedAiRuntimeRegistry`.

| Action | Request | Rules |
|---|---|---|
| `inference.messages` | Anthropic Messages body; `tools` ≤64 allowed for bot runtimes only | Access source from the run binding; credential injected by the broker; funded requests pass through the local funded queue (class from the task) |
| `inference.responses` | OpenAI Responses body; tools allowed for bot runtimes | Same |
| `inference.chat_completions` | OpenAI chat-completions body; tools allowed | New; managed Cloudflare Workers AI route |
| `bot.tool` | `{ toolCallId, capability, args }`. M1 capabilities: `integration.inventory`, `integration.call`, `memory.propose`, `memory.search`, `interaction.create`, `artifact.write`, `artifact.read`. M3 adds `handoff.create` and M4 adds `computer.act` |  Zod-validated per capability; checkpoint written `prepared` before and `observed_complete`/`effect_unknown` after; grant, audience, and approval checks before dispatch |
| `bot.event` | `{ seq, event: assistant_delta (≤16 KiB) \| tool_progress \| activity }` | Projected into canonical `assistant.delta`, `agent.activity`, `tool.progress`, `tool.output`, and `interaction.requested` events; ≤64 KiB per event; ordered by `seq` |
| `bot.session.save` | `{ baseRevision, messages delta, compactedThroughSeq? }` | Revision-checked write to `bot_agent_sessions`; ≤512 KiB total |

Limits:

- Request body 256 KiB; inference response 512 KiB buffered; 8 in-flight requests and 64 connections, shared with the existing broker.
- Timeouts: inference 30 seconds per request, integration calls 10 seconds, artifact writes 30 seconds.
- `egress.fetch` stays disabled for bot runtimes. Web access goes through `integration.call` or the M4 computer service.

Error results use allowlisted codes only: `denied`, `not_granted`, `approval_required`, `invalid_arguments`, `unavailable`, `timeout`, `budget_exhausted`, `stale_generation`. Tool error text returned to the model is generic. Internal errors are logged on the gateway with a correlation ID.

## Capability arguments (examples)

- `integration.call`: `{ service, action, connectionId, params ≤32KiB }`. The broker resolves the action risk from the integration catalog and requires a grant whose effects include that risk and whose audience matches the run.
- `memory.propose`: `{ kind, scope, content ≤4KiB, source }`. Items sourced from tool results are stored `confirmed: false`.
- `artifact.write`: `{ relPath ≤256, content ≤192 KiB (UTF-8), mimeType (text/markdown, text/plain, text/csv, application/json, text/html), replace?: { baseRevision } }`. The cap leaves room for the envelope inside the 256 KiB broker request limit. The path must resolve within the run's workspace root; exclusive create unless `replace` is given.
- `interaction.create`: `{ kind, payload, blocking }`. The server validates the payload per kind and designates the responder.
