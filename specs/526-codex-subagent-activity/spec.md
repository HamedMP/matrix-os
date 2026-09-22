# Codex subagent activity (OM-283)

Issue: https://linear.app/matrix-os/issue/OM-283/display-codex-subagent-activity-in-the-chat-frontend

## Behavior and reference

Use the installed Codex compact subagent row as the reference: avatar, name, observed status and expandable attributed details. Several children remain visible. Shared DOM rendering covers Web Canvas, Web Desktop, Electron Desktop and Web Mobile; Native Mobile uses the same derived status and details.

A completed spawn/interaction tool is not a completed child. Only child lifecycle/receiver state or the native completed marker establishes completion. Waiting requires actual provider evidence. If a parent run ends without child completion evidence, show status unavailable. Never infer child success from parent success. Child results remain separate from parent assistant prose. Preserve one stable activity identity through streaming, replay and reload.

## Provider verification

A real local Codex 0.153.4 app-server spike on 2026-09-21 spawned an arithmetic child while the parent computed independently. It emitted `subAgentActivity` started markers, child `turn/started`, `thread/status/changed`, child `turn/completed` with a final answer, and a `subAgentActivity` completed marker. Parent and child had distinct thread and turn IDs. No child read/subscription RPC was needed. The generated TS marker-kind union omitted `completed` although the runtime emitted it; accept the observed runtime variant explicitly. Parent marker completion alone does not establish child completion. Legacy `collabAgentToolCall.agentsStates` is supported from the same validated owner run. Unknown fields/statuses do not create fabricated evidence.

## Invariants and authorization

Native markers are admitted only from the active parent run or an already observed child. Child native IDs are hashed as display references, never routes or new execution authority. No endpoints, permission-mode changes or cross-owner reads are introduced. Existing owner-scoped Chat activity persistence and read/replay authorization remain the source of truth. Child prose must never enter the parent's assistant message stream. Rejected optional text must not discard the child identity/status. Raw errors, sensitive paths and secrets are excluded using existing display guards.

The per-run child registry is bounded to 128 entries with oldest-entry eviction and reset between parent runs. Details are bounded. Late child-turn events cannot overwrite a newer child turn. Unresolved or evicted children are acceptable partial states, never invented success.

## Delivery and verification

- Failing-first tests for child lifecycle, status/privacy boundaries, stable replay, and simultaneous expandable rows.
- Full provider-runner → normalized event → canonical adapter → persisted activity presentation wiring verification.
- Real delegated-run acceptance and Electron Desktop Human Review; completion/failure/reload must not duplicate rows or parent text.
- Dedicated implementation PR and a separate public documentation PR in `FinnaAI/matrix-os-site` (`content/docs/`).
- No VPS resource-limit changes, resizing, full-suite workload experiments or automatic merge/deployment.

## Human Review environment

Build the checked-out PR head with `flox activate -- pnpm --filter desktop run build`, then run `flox activate -- pnpm exec tsx scripts/dev/review-codex-subagents.ts`. This launches the real built Electron renderer against synthetic, owner-isolated fixture data, not a production computer. Open Chat → Subagent activity review → Worked for; expand Arithmetic and verify its result, Failed on Tests, and Status unavailable on the unresolved Review child. Reload and confirm each row appears once. Ctrl-C closes this fixture and removes its temporary profile. Actual provider event behavior is separately verified by the live Codex spike and runner integration regression.


### Type icons and component Preview

Use a search icon for observed explorer/research roles, code for worker/implementer,
and shield/check for reviewer. Missing or custom roles use a generic branch icon;
never infer roles from names. Optional `thread/started` role metadata is accepted
only for already attributed child threads. For runtimes without child metadata notifications,
request metadata-only `thread/read` once for each admitted child, capped at 128 requests
per run with a five-second timeout. Send without awaiting in the serial event consumer;
project replies in that consumer only while the same parent turn is active, and require
the returned child ID and parent ID to match attribution. No arbitrary thread reads
or new execution authority. Unconfigured roles continue to use the generic icon.

Run `flox activate -- pnpm exec tsx scripts/dev/preview-codex-subagents.ts` to open
`http://127.0.0.1:5187/`. This renders the production shared component with synthetic
role/status examples; it is not a full Web Desktop integration test. The Electron
review launcher exercises the full Chat interface with the same schema. Both bind
only to localhost and clean up servers on Ctrl-C.

### Hermes finite-turn integration

Matrix owns one Hermes process per canonical run and closes it after `message.complete`.
Set `HERMES_SINGLE_QUERY_SESSION=1` for that process: Hermes's native finite-session
contract joins delegated children within the turn instead of dispatching background
results to a future notification consumer. Child tasks can still execute in parallel.
The installed Preview revision `ea0c2b820bd30bace020a3791d8aef0b44002e0d`
checks this marker in `tools/delegate_tool_dispatch.py::_resolve_async_wake_sid`.
Do not emulate persistence with a sleep or retry the parent's prompt.

Project Hermes child start/completion frames into the shared subagent schema, retaining
bounded safe goal/result text and opaque identities. Keep concurrent children separate;
an identity-free legacy completion may resolve only a single unambiguous child. A
128-child per-run cap evicts oldest entries. Do not infer roles from task names: the
observed Hermes payload has no role field. Unavailable roles use the branch icon.

Regression coverage includes process mode, reverse-order concurrent completion,
duplicate starts, ambiguous/unrelated completion, sensitive-text exclusion and capacity.
Real Preview acceptance must demonstrate child results delivered to the parent in the
same run, distinct expanded result rows, and persistent replay without duplicate rows.

A second real Codex 0.153.4 spike registered an explorer description through a
process-local config override. The spawn schema then exposed the role selector,
and `thread/read` returned `agentRole=explorer` while still emitting no child
`thread/started` event. Upstream tool construction gates `agent_type` on a nonempty
configured role registry. Preserve user configuration; do not fabricate a role
from a task name or install default role overrides on the user's behalf.
