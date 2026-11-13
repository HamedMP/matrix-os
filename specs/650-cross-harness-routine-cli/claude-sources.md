# Claude routine source execution boundary

Task 5a implements ordinary native Claude Chat and the existing delegated Claude task branch. Ordinary Codex Chat now has its own [source boundary](./codex-sources.md); other harness sources remain separate required work. This document describes the implementation contract; fixture tests and an offline native protocol probe do not establish live-account acceptance.

## Ordinary Claude Chat

The actual `createClaudeChatProviderAdapter` execution closure supplies the server-admitted owner, Chat, turn and run. A new unpredictable generation belongs to that exact held native execution. `registerChat` defaults to the explicit Claude provider seam (Codex selects its own validated provider); it validates the actual personal active non-collaborative Chat and matching `claude_code` run inside the caller's transaction, acquiring Chat before Run to match canonical lock order. Startup supplies the already constructed routine runtime, fixed published `matrix.mjs` path and local source-only HTTP endpoint. Model arguments cannot select these dependencies.

The native control router precedes the existing `can_use_tool` controller. It sends one random initialize request and callback registration, waits for the matching successful ACK with `hooks_applied: true`, then sends the original input exactly once. A timeout/error continues unrelated Chat with routine issuance disabled. The supported routine transport is currently the exact `2.1.240` system-init version plus Bash availability, an observed Bash stream tool-use identity and exact callback/request/tool-use correlation. Native callback session, prompt and agent IDs do not become Matrix identity. Subagent callback hints cannot create a Bot source. Unrelated Bash receives an empty hook response and retains native permission/safety checks.

Only a literal single `matrix|matrixos|mos routines` argv command is intercepted. Proposal stdin supports this deliberately small literal form:

```sh
matrix routines propose --input - --request-id <original-uuid> <<'MATRIX_ROUTINE_JSON'
<strict proposal JSON>
MATRIX_ROUTINE_JSON
```

Compound commands, expansion, wrappers, redirects, arbitrary executable/identity/gateway/profile flags and other shell grammar are rejected. The host invokes the actual published CLI without a shell; that CLI remains the intent parser and requests private authorization/capability through Task 3 IPC. It then calls the existing source HTTP consumer and backend. There is no direct routine mutation in the adapter.

A full-access row or native permission label does not prove unrestricted human/parent provenance. Mutations use the exact owner operation decision; known plan, review, shared, organization and unsupported ceilings deny them. Native plan can narrow the current ceiling and cannot later widen it. Database admission policy is rechecked during issue/consume/claim; a generic owner login, remembered destination, Bash approval or native hook entry is insufficient.

The native source survives a normal CLI/tool return. It is fenced at native turn completion, process settlement, Stop, steer, expiry or shutdown. Callback cancellation affects its invocation and cannot authorize a late response. A source that ends before target claim denies that claim; an already claimed canonical intent remains independent.

Only bounded sanitized display data is written to exclusive random artifacts. Files are not authority or receipt truth, including against same-UID modification. File/count/queue caps, recurring TTL and symlink-safe crash cleanup, and explicit close apply. The native allow rewrite contains only a fixed `/bin/cat` read and validated safe options. No user executable text, routine bearer, proof or provider environment enters it. A display/read failure after a possible mutation is an unknown outcome: retain the original UUID and read its receipt from a fresh authorized source; never retry the mutation automatically.

## Existing delegated Claude task

The existing restricted Claude executor retains `--tools ''` and only the existing `mcp__matrix_bot__call` tool. No Bash, new MCP server, scheduler or other native Bot executor is added.

The existing typed bridge now accepts an explicit top-level `requestId` UUID for routine mutations. It maps to optional internal `BotToolRequest.routineRequestId` only on the two existing routine capabilities. A random native `toolCallId` remains broker correlation and is never the durable mutation key. Non-routine calls keep their existing contract. Proposal/control without the required durable UUID is denied.

The executor's `onStart`/`onEnd` lifecycle fences a source for the actual held native child. `onEnd` is synchronous and idempotent at the first terminal result, actual process exit or relevant failure. Open/inherited stdio cannot extend authority. Result assembly, durable session persistence and profile lease release still wait for actual `close`; buffered result bytes after exit continue to drain. Its host child-invocation ID and actual parent execution generation remain distinct. An AsyncLocalStorage context binds the actual bridge call to that child and exact parsed request; concurrent ordinary parent tools cannot borrow it. Controller registration captures the actual binding's Bot/Chat as an immutable target ceiling for every read, proposal and control; a different owner-selected default cannot widen that parent capability. Generic Bot-child registration without that ceiling is denied. The source requires the actual live registered private interactive parent binding, `agent.task` and routine capability ceilings, matching Computer, task/run/runtime handle/generation, matching current personal Chat and default-mode Matrix Bot run. Unknown parent provenance requires the exact owner action. Unsupported routine authority disables routines while unrelated delegated task tools continue.

The existing broker admission/checkpoint path routes that typed branch through the same actual fixed CLI and source HTTP consumer. Canonical non-native tools retain their existing backend path. `registerBotChild` has no public registration endpoint and accepts no model-supplied owner/binding identity.

For the exact existing private target, `A.proposeWithin`, its real task's `waiting_person` transition, outbox and immutable pending receipt share one owning transaction. No new task, binding, canonical request ID or background-task workaround is created. Final source/signal failure escapes and rolls everything back. The source lifecycle validator accepts the waiting transition only for the exact stored consumed invocation whose just-inserted pending receipt references that real task/run/interaction. New prepare/issue calls while waiting receive no authority.

A committed direct pending receipt never runs the canonical submit hook. Recovery verifies the original receipt, real approval/interaction and task/run. Current progress uses an explicit safe projection:

```ts
proposal: {
  existingBinding: true,
  handoff: "pending_approval",
  approval: "pending" | "approved" | "denied" | "expired" | "cancelled" | null,
  routine: { routineId, status, revision } | null,
}
```

There is no invented dispatch revision. The original receipt stays `pending_approval` after later human approval; fresh reads project the actual standing routine through its real approval ID, including after a destination preference change. A normal worker completion preserves the already committed waiting task through this recovery contract.

## Retained transaction lock order

Control consumption takes the existing routine row gate before the source-generation/source/capability gates. Invalid, consumed, expired or operation-mismatched capabilities are rejected before requesting that routine lock, then checked again under their original locks. The original RequestService and canonical control checks remain authoritative.

Every actual controller lifecycle validation takes preference then owner gates before the producer locks its current Chat, Run and (for a delegated source) Task. Target validation retains the same owner gate before its Chat/binding locks. Remembered-target changes use preference → owner → Chat. Existing canonical control/scheduler paths retain routine → owner/Chat. Preparation, freshness and issuance never acquire a routine later in their transaction; they do not need an extra routine lock. All current-policy locks survive to commit, and owner-proof/UI waits hold no transaction.

## Qualification limits

Actual source tests execute canonical Chat/Bot admission, real task/private registrar and runtime registry, actual adapter/service/controller production code, published CLI processes/private IPC, local HTTP and owner PostgreSQL. Native protocol/model transport, external native authentication/readiness and background-authority snapshots are explicitly named fixtures. Separate isolated Linux ARM64 native probes qualify the exact SDK-native package 0.3.240 / reported CLI 2.1.240 hook transport, ACK field, system version and partial tool-use ordering. They do not qualify arbitrary PATH binaries, Darwin/x64, a live provider/account, or a combined native-process-to-Matrix end-to-end run. Delegated restricted native runtime qualification is distinct from that ordinary Bash probe.
