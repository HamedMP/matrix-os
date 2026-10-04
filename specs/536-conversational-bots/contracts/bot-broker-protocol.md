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
| Mounts | Pinned bot-runtime bundle (`packages/bot-runtime/dist`, one self-contained `bot-worker.mjs` built with esbuild) read-only at `/opt/matrix/scope-sdk/bot-runtime`, in place of the Claude SDK, native binary, and Chat worker file; node prefix read-only; bot workspace from the sandbox manifest at `/workspace/project`; broker socket; readiness file; command directory |
| Allowed workspace roots | `~/bots` only. Shared-chat roots (`~/projects`, `~/worktrees`) never apply to `bot_agent`, and bot roots never apply to `chat_ai` |
| Supervisor visibility | The supervisor unit uses `ProtectHome=tmpfs` with one read-only bind of `/home/matrix/home/bots`, so it can validate a bot mount before systemd binds it. Provisioning and updates create that directory before the supervisor starts |

The supervisor advertises both profiles:

```json
{ "profiles": [{ "profileId": "scope-runtime-chat-v1", "profileDigest": "...", "adapters": [...] }, { "profileId": "scope-runtime-bot-v1", "profileDigest": "...", "adapters": [{ "adapterId": "matrix-bot", "harnessVersion": "...", "workloads": ["bot_agent"] }] }] }
```

The gateway rejects a supervisor whose advertised digest for a profile differs from the digest pinned in the gateway build.

## Launch

`runtime.create` adds `profileId` and, for `bot_agent`, a mandatory manifest (the existing sandbox manifest schema; a bot is never launched without one):

```json
{ "version": 1, "scopeHandle": "scope_<32 hex>", "actorId": "bot_...", "worktree": { "hostPath": "<resolved bot/group root>", "mode": "rw", "fingerprint": "sha256" }, "network": "broker_only" }
```

- Private handles are derived as described in research R4. Group runs use the shared scope's handle.
- The supervisor checks the handle, the allowed root, and that the path exists without symlinks. The lifetime comes from the profile (`RuntimeMaxSec=900`), not the manifest.
- The worker receives only `runtimeHandle`, `scopeHandle`, `bot_agent`, `matrix-bot`, the pinned harness version, and `executionGeneration` as arguments. It holds no credential. Run identity arrives with each relayed `bot.run`.
- The supervisor's capability reply keeps `profile` (the Chat profile, for older gateways) and adds `profiles`. The bot profile is listed only when the bundled worker and the bot root are present. Units that exit on their own (for example at `RuntimeMaxSec`) are dropped from the runtime map before a create is refused for capacity.

## Worker commands (supervisor → worker, per-runtime command socket)

The gateway sends `runtime.bot { runtimeHandle, executionGeneration, command }` to the supervisor, which relays the command to the worker's command socket and returns `runtime.bot.result { reply }`. Relayed commands carry identifiers and steering text only; they never carry prompt content, so supervisor frames stay under their 128 KiB cap. Unlike the single-use Chat socket, a bot command socket keeps one long `bot.run` connection open while steer and cancel use their own connections (at most four). Refusals are allowlisted: `busy`, `invalid_command`, `unavailable`.

| Command | Payload | Result |
|---|---|---|
| `bot.run` | `{ runId }`. The worker then loads the run with `bot.run.load` (route, system prompt, capabilities, limits, and `turn: { kind: "prompt", text≤64KiB, imageCount≤4 } \| { kind: "continue" }`) and reads each image with `bot.input.image` | streams events over the broker, then `{ runId, status: "completed" \| "waiting_person" \| "blocked" \| "failed" \| "cancelled" \| "uncertain", sessionRevision?, toolActions, failureCode?, blockedReason? }` |
| `bot.steer` | `{ text≤8KiB }` | `{ acknowledged }`. Refused once the turn stops taking input. An accepted steer the turn could not answer (blocking question, budget, cancel) is saved as a person message |
| `bot.cancel` | `{}` | `{ status: "cancelled" \| "uncertain" }` |

## Broker actions (worker → gateway broker)

Frames are newline-delimited JSON on the broker Unix socket, not HTTP. Model SDKs inside the workload call the shared loopback inference bridge (`packages/scope-runtime/src/inference-bridge.ts`, extracted from `worker.ts`), which translates HTTP to `inference.*` frames; the bot runtime sends `bot.*` frames directly. Authentication is the existing pair of unguessable `runtimeHandle` and current `executionGeneration`. The broker resolves the owning registry: `BotRuntimeRegistry` or `SharedAiRuntimeRegistry`.

| Action | Request | Rules |
|---|---|---|
| `inference.messages` | Anthropic Messages body; `tools` ≤64 allowed for bot runtimes only | Access source from the run binding; credential injected by the broker; funded requests pass through the local funded queue (class from the task) |
| `inference.responses` | OpenAI Responses body; tools allowed for bot runtimes | Same |
| `inference.chat_completions` | OpenAI chat-completions body; tools allowed | New; managed Cloudflare Workers AI route |
| `bot.tool` | `{ toolCallId, capability, args }`. M1 capabilities: `integration.inventory`, `integration.call`, `memory.propose`, `memory.search`, `interaction.create`, `artifact.write`, `artifact.read`. M3 adds `handoff.create` and M4 adds `computer.act` |  Zod-validated per capability; checkpoint written `prepared` before and `observed_complete`/`effect_unknown` after; grant, audience, and approval checks before dispatch |
| `bot.event` | `{ seq, event: assistant_delta (≤16 KiB) \| tool_progress \| activity }` | Projected into canonical `assistant.delta`, `agent.activity`, `tool.progress`, `tool.output`, and `interaction.requested` events; ≤64 KiB per event; ordered by `seq`. The runtime combines text deltas (at most one send per 250 ms, or at a message or tool boundary) and sends at most 2,000 events per turn; the last one is an `activity` notice that live updates paused, and the gateway renders the final reply from the saved session |
| `bot.run.load` | `{}` | Returns the run spec bound to this runtime and `runId`; ≤160 KiB |
| `bot.input.image` | `{ index 0-3, offset }` | Returns `{ mimeType, totalChars, data }` with `data` ≤384 KiB of base64, so every reply stays under the frame cap; the worker stops after a bounded number of chunks and fails a run whose chunks disagree |
| `bot.session.load` | `{}` | Returns `{ revision, messages, needsRecompaction: boolean }`; the flag is required, including for managed Pi sessions. Missing metadata fails worker decoding; the reply may reach 576 KiB |
| `bot.session.save` | `{ baseRevision, messages, compactedThroughSeq?, recompactionHandled?: true }` | Revision-checked write to the corresponding Bot or managed Pi session; the acknowledgement clears invalidation only in the successful CAS write. The transcript is ≤512 KiB and the frame ≤576 KiB. Saved history keeps a text placeholder instead of image bytes, and the runtime cuts oversized tool payloads with a visible note when a transcript would not fit |

Every successful Bot memory forget advances session revision, even while invalidation is already pending. Before inference, a flagged worker discards tagged derived summaries and historical summaries recognized by the original first-turn envelope; later literal person quotations and canonical Chat history remain intact. Only a revision-checked save can acknowledge cleanup. Strict worker/broker snapshot decoding fails closed during mixed-version operation; upgrade both together. An already-admitted standing-memory prompt is not retroactively cancelled.

Managed Chat artifact creates use private service-owned staging outside child mounts, complete and sync bytes, revalidate the admitted root, then publish with an exclusive atomic hard link and sync the target directory. Existing paths are never replaced. Bot staged rename/replacement remains unchanged. Failed or lost publication acknowledgement never deletes the final target; cleanup removes only the stage, with bounded recurring symlink-safe TTL recovery. Cross-filesystem publication fails closed.

Non-read integration calls preserve transport/timeout/cancellation or unreadable-result uncertainty after transport entry as durable `effect_unknown`, without same-call replay. Internal `effectUnknown` is not a client error or authority. Authenticated route 400/401/403/404/409 pre-action refusals and safe reads retain their definitive mapping; already-cancelled calls do not enter transport. Grants, approvals, credentials and financial settlement remain unchanged.

Limits:

- Request body 256 KiB, except `bot.session.save` frames and `bot.session.load` replies, which may reach 576 KiB (the 512 KiB session plus envelope headroom). The broker reads bot lines up to that bound. Inference response 512 KiB buffered; 8 in-flight requests and 64 connections, shared with the existing broker.
- Timeouts: inference 30 seconds per request, integration calls 10 seconds, artifact writes 30 seconds.
- `egress.fetch` stays disabled for bot runtimes. Web access goes through `integration.call` or the M4 computer service.

Error results use allowlisted codes only: `denied`, `not_granted`, `approval_required`, `invalid_arguments`, `unavailable`, `timeout`, `budget_exhausted`, `stale_generation`. Tool error text returned to the model is generic. Internal errors are logged on the gateway with a correlation ID.

## Capability arguments (examples)

- `integration.call`: `{ service, action, connectionId, params ≤32KiB }`. The broker resolves the action risk from the integration catalog and requires a grant whose effects include that risk and whose audience matches the run.
- `memory.propose`: `{ kind, scope, content ≤4KiB, source }`. Items sourced from tool results are stored `confirmed: false`.
- Every `bot.tool` request is bounded to 240 KiB once serialized, so JSON escaping cannot push it past the 256 KiB broker limit.
- `artifact.write`: `{ relPath ≤256, content ≤192 KiB (UTF-8), mimeType (text/markdown, text/plain, text/csv, application/json, text/html), replace?: { baseRevision } }`. The cap leaves room for the envelope inside the 256 KiB broker request limit. The path must resolve within the run's workspace root; exclusive create unless `replace` is given.
- `interaction.create`: `{ kind, payload, blocking }`. The server validates the payload per kind and designates the responder.
