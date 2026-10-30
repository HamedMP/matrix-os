# ENG-93 private Bot routine integration boundary

Ticket: [ENG-93](https://linear.app/matrix-os/issue/ENG-93/enable-and-validate-recurring-tasks-on-the-launch-agent).
This is the backend handoff for the separate CLI entry-point work. It adds no
CLI or MCP implementation and does not authorize cross-harness execution.

## Baselines and ownership

- Existing backend contract: `3db08492b9074606eac2213b9d86c0f58581d685`,
  draft native stack #3020, PRs #3017 → #3018 → #3019. This is not a merged API.
- Local native consent implementation: `61e81069c456ef3d8f576cf3a1a60fd0e065bf53`.
  It adds explicit current-Computer background permission; it is not present
  in the above published draft head.
- The routines schemas, services and routes are identical at these two commits.
  Use the exact referenced source, not a moving branch name, for integration.
- First-stage external harnesses are request entry points. Scheduled work still
  enters canonical Matrix Bot execution. Arbitrary Claude/Codex/Hermes/OpenCode
  executor selection is outside this contract.
- Suggest engineering/security review of the identity adapter and product review
  of approval/archival copy before extending these boundaries. This document
  does not add a separate approval gate to already authorized ENG-93 work.

## Existing request and response contracts

Source: `packages/contracts/src/bots/routines.ts`,
`packages/bot-runtime/src/tools.ts:SPECS`, and
`packages/gateway/src/bots/tool-dispatcher.ts:dispatch`.

`propose_routine` maps to broker capability `routine.propose`:

```ts
{
  name: string;                 // 1..120 characters
  prompt: string;               // 1..4096 characters
  schedule:
    | { kind: "once"; at: string } // ISO datetime with an offset
    | { kind: "interval"; everyMs: number } // 60,000..31 days
    | { kind: "cron"; expr: string; tz: string }; // five fields, valid timezone
  selection: { instanceId: "matrix_chatgpt_plan"; model: string };
  authorizedEffects: Array<"read" | "write" | "send">; // nonempty, unique
}
```

The strict schema rejects owner/account/grant identity supplied as arguments.
The proposal has a bounded encoded size. The native tool returns JSON text
`{ interactionId, status: "pending" }` and ends the turn for human approval.
It does not return an active routine ID or create background authorization.

`routine_control` maps to capability `routine.control`:

```ts
{ operation: "list" }
// or
{
  operation: "control";
  routineId: string; // rt_ followed by 24 hexadecimal characters
  baseRevision: number;
  status: "active" | "paused" | "archived";
}
```

The native list returns a JSON-text array of routine summaries. Native control
returns the internal `BotRoutine` record, including identity/approval references;
do not publish that internal object as a new general-purpose CLI DTO.

Existing HTTP routes are in `packages/gateway/src/bots/routine-routes.ts`:

| Route | Body | Result |
| --- | --- | --- |
| `GET /api/chat-agents/:agentId/routines` | None | `{ routines: [{ routineId, name, schedule, status, nextFireAt, revision, lastFire, requiresReview }] }` |
| `POST /api/chat-agents/:agentId/routines/:routineId/control` | `{ baseRevision, status }` | `{ routineId, status, revision }` |

These routes validate IDs and derive the owner from authenticated
`RequestPrincipal.userId`. Control uses the current revision. Generic error codes
are `invalid_request`/400, `not_found`/404, `conflict`/409,
`rate_limited`/429 and `unavailable`/503; the 64 KiB body limit returns 413.
Missing authentication is 401; missing trusted principal setup is a server
error. A list for an unknown valid Bot ID may be empty. Foreign control targets
return 404, not another owner's state.

There is no ordinary routine create, content-update or hard-delete HTTP route.
Repository `create()` is explicitly internal to the approval handler.

## Identity, approval and background authority

Source: `runtime-registry.ts:BotRuntimeBinding`,
`routine-authorization.ts:hasLiveRoutineChat`, and
`routine-approval.ts:createBotRoutineApprovals` in `packages/gateway/src/bots/`.

1. Native tools use a server-admitted runtime handle/generation and the bound
   owner, Bot, Chat, task and run. The worker cannot widen that identity.
2. Routine tools currently require an interactive private Bot run. Group runs,
   ordinary `managed_chat` Pi bindings and background tool calls are rejected.
3. Proposal creation requires a running matching task and a live direct Bot Chat
   owned personally by the user, with no collaboration and no removed binding.
4. A usable personal `matrix_chatgpt_plan` background source must already exist
   even before proposing. There is no funded/API-key fallback in this contract.
5. The exact proposal and account/Computer/grant/definition revisions are bound
   into the approval digest. The designated owner resolves it through
   `POST /api/chats/:chatId/interactions/:interactionId/resolve` with
   `{ kind: "approval", baseRevision, decision: "approve" | "deny" }`.
   The result contains the interaction ID/status/revision. This is a human
   responder boundary, not an agent auto-approval tool.
6. Each fire and execution rechecks the live Chat, standing approval, Bot
   definition revision, source identity, model and grant revision. Each effect
   must also satisfy the routine effects and existing account permissions.

Native background consent is separate: `desktop/src/shared/chatgpt-plan-ipc.ts`
defines trusted-main-frame `chatgpt-plan:set-grant`. Main derives the owner and
Computer from its current signed-in session; positive background intent requires
the current account ID and base revision. Only saved positive grants produce
signed background authority; an unconfirmed downgrade may advertise reduced
authority. Unconfirmed native downgrades survive Computer/owner/session changes
within the app process and surface as optional `grantSaveUnconfirmed` status so
a fresh Settings client can explicitly retry. They are not claimed durable
until a successful full-record write. New connections and explicit reconnects default to background off.
Do not expose this IPC or credentials as an agent/CLI scheduling tool.

## Controls, cancellation and recovery

Source: `routine-execution.ts:control/stopFire/prepareRun/completeRun`,
`repositories/routines.ts:control/finish/recover`, and
`continuations.ts:createBotRoutineCanonicalRunner`.

- Pause stops future scheduling and cancels this routine's queued/running fires
  through canonical queue/run cancellation. It does not cancel unrelated Chat work.
- Archive does the same and retains history. Existing control rejects transitions
  from archived; archive is not hard deletion and is not silently reversible.
- Resume requires the existing exact authorization and rejects any uncertain fire.
  It is not approval for changed timing, prompt, model or effects. There is no
  in-place content-update contract; a changed proposal needs fresh approval.
- A cancellation acknowledgement alone is not worker exit. If cancellation or a
  non-read effect cannot be confirmed, preserve `uncertain`/review state.
- A durable fire is unique per owner/routine/occurrence. Only proven pre-dispatch
  capacity failures receive bounded retry (at most three attempts total).
  Expired dispatched leases with unknown outcomes are never automatically replayed.
- Native background revocation increments revision, stops the peer and aborts
  in-flight inference. It invalidates subsequent routine authorization; it does
  not archive the routine or erase history.
- `chatgpt-plan:cancel` cancels connection setup, not a routine. Bot integration
  grant deletion is also distinct: `grants-service.ts:revoke` fences the next
  effect rather than immediately cancelling all active runs.

## Adapter work owned by the separate CLI task

Reuse `createBotRoutineApprovals` and `createBotRoutineExecution`, the existing
owner Postgres state, scheduler, broker checks and canonical runner. Do not call
the raw repository create function or add another scheduler.

The adapter still needs trusted caller-to-Matrix identity/context mapping,
least-privilege Bot scope, bounded public DTOs and duplicate/unknown-result
handling. If it cannot establish the required admitted context, fail closed;
never manufacture a `BotRuntimeBinding` from user-supplied IDs.

Capability discovery must describe effective availability for this authenticated
context and live source, rather than advertise a static global capability set.
Creation should mean proposal-only (`pending_approval`). Deletion should be named
archive, or explicitly document archival semantics. Keep human approval and
background consent outside agent auto-approval. MCP remains documentation-only
for the separate first-stage CLI task unless its scope is explicitly changed.

Do not adapt legacy `manage_cron`, `/api/cron` or direct `system/cron.json`
writes. Those are different paths; `security/tool-deny.ts` already denies
`manage_cron`. They do not provide this routine authority/execution contract.

Content-update/replacement semantics and non-Bot callers remain explicit design
questions, not existing endpoints. Changes to this handoff's backend schemas or
service signatures must be called out to the CLI task before publication.
