# Native Claude scheduling in ordinary Chat

## Outcome

An ordinary personal Claude Chat can create native Cron tasks, finish its current interaction, and receive a later native result in that same Chat. Claude Code remains the only scheduler. Matrix owns bounded native-session lifetime, fresh canonical phase admission and normal result persistence.

This is distinct from Matrix Bot routines. Their approval, background authorization, source/action proof, cancellation and execution semantics remain unchanged.

## Verified cause and protocol boundary

The per-turn adapter sends stdin EOF at a native terminal result. The child exits before a later Cron deadline. Actual native 2.1.317 CronCreate/CronList records confirm creation; the same executable with open stdin triggers in stream-json print mode. Therefore merely exposing tools is insufficient, and an absent task in a later process is not evidence that it fired or was cancelled.

Current 2.1.317 can restore qualified recurring tasks after a confirmed Gateway stop and startup. Claude owns future timing. An unconfirmed stop, an expired session, an in-flight occurrence, a one-shot job or a source that no longer qualifies cannot be recovered by this path.

Chat labels native task creation “Schedule in this Claude session” and explains that the session lasts at most seven days and can stop during a Computer restart or update. A host bundle update that stops Gateway drains its retained Claude processes. A retained transcript and a prior successful tool receipt do not show that a task is running after the service starts again. The private Chat denies project-wide native CronCreate requests before effect; the native project inventory does not carry the private Chat's authority.

Actual native scheduled prompts pass through UserPromptSubmit before inference. A host can hold that callback while validating and admitting a new canonical phase. Native initialization during that pending callback cancels the prompt, even though the initialization ACK succeeds. Do not reinitialize or replay it. Install the native hooks once and route the current phase through a private registrar that retains exact callback/session/prompt/tool correlation.

The same native version supports replacing a named MCP server through mcp_set_servers while the prompt is held. Qualification must establish that replacement is ACKed, the old child cannot use the new grant, and exactly one native model request follows hook release. Native transport qualification with a synthetic API/MCP server does not qualify a real Matrix backend or account flow.

## Session and phase ownership

- A completed canonical phase revokes all of its MCP grants, routine source, approval/input controllers and browser handles. A retained native process is independently owned by a bounded pool; phase completion is not a simulated process exit.
- Retention requires exact qualified native protocol, confirmed native jobs and an installed host scheduled-phase handler. Invalid proof, unsupported surfaces or full capacity deny CronCreate before its effect. Ordinary non-Cron Chat remains available.
- Before selecting retained transport, qualify the exact resolved launch executable with a bounded version query in the selected environment. Only 2.1.317 enters the qualified path, which still requires actual hook/MCP ACKs. Unsupported or unknown versions use the existing ordinary per-turn transport with CronCreate added to existing tool denials. A cancelled query or unconfirmed child cleanup cannot fall through into a new launch. Never retry a submitted prompt.
- Bind owner type/id, private Chat, instance, native session, execution root, exact selection/permission policy and freshly verified credential principal. Never derive Matrix identity from native prompt text or callback IDs.
- Cap sessions globally and per owner; cap jobs at the native limit of 50. Do not silently evict a live retained session. Close idle children after the last confirmed job is removed. Apply an absolute session limit no greater than native recurring expiry; never refresh an existing funded/absolute deadline between phases.
- Native timers alone decide when to submit due work. Matrix timers only bound control waits and resource cleanup; they never enqueue scheduled prompts.
- Because the qualified native prompt hook supplies prompt text rather than a job ID, deny duplicate prompt creation before effect, including accepted creates awaiting native receipts. The original job remains usable. Pending creates count against the native task cap and release their reservation when the native receipt settles.

## Scheduled phase admission

A qualified native UserPromptSubmit must match an actual held session and a previously confirmed native job prompt. Its host-owned owner/Chat/source identity is passed to a server-only entry point. Wait only a bounded interval for the preceding canonical phase to commit, then lock and revalidate current owner/private active Chat, source run, provider binding, latest native checkpoint, selection and root. A busy, stale, disabled, shared or unsupported source fails closed without replay.

Admit the exact generic system input `Scheduled task triggered.` plus a fresh turn/run in one transaction, with outbox writes and a request identity derived from native session/prompt ID. Raw native prompt text stays private and is represented by a hash for request identity. The ordinary public turn endpoint continues to require a real user input. Start the new canonical projection against the held native prompt; never dispatch another copy of that prompt.

Each phase uses new input/approval controllers and new run-scoped MCP capabilities. Reconnect MCP children with their fresh explicit scoped environment before releasing the held native prompt. Old tokens never regain validity. Preserve the existing routine hook and terminal-result/settlement revocation; a host registrar may translate only its opaque callback registration under the same actual session and current prompt/tool identities.

A native background agent can outlive a terminal result and later carry the new foreground prompt ID. Prompt/session equality alone is insufficient. Record tools only after the current prompt is bound; require explicit native root metadata or a bounded, complete current-phase Agent/Task ancestry. Gate every PreToolUse, including auto-approved MCP tools, and raw permission requests before adapter parsing. Suppress output from foreign/unknown nested sources. These gates return no permission approval; ordinary native permissions and B's delegated-routines denial remain authoritative. Browser MCP replacement must receive the current token and port explicitly, rather than expanding the retained child's old environment.

The retained process starts without the initial `--mcp-config` pair. The first acknowledged `mcp_set_servers` supplies that phase's configuration, just as later replacement does; avoid launching children once through argv and immediately replacing them through control.

## Auth matrix

| Entry | Authority | Exposure |
| --- | --- | --- |
| Existing Chat create/turn/cancel/input/approval routes | Existing owner principal, body limits and schemas | Unchanged |
| Native scheduled-phase admission | Private server closure plus current owner/Chat/source validation and exact native occurrence | No HTTP endpoint |
| Native hook response | Exact installed callback/session/prompt/tool correlation plus fresh canonical phase | Process-private stdio |
| Matrix MCP calls | New current-run scoped grant and existing action approvals | Existing broker only |

No new public endpoint, credential source, background consent, scheduler or provider is introduced. Native owner-account scheduling must not reactivate retired Matrix-funded Claude SDK routes or borrow Matrix Bot consent.

## Lifecycle and compatibility

Explicit native CronDelete, canonical cancellation/abort, actual child failure, source/account drift, failed preparation, control timeout, bounds and shutdown drain the exact owned process and pending callbacks. Cleanup failures remain failures until actual process termination is confirmed. Do not infer cancellation from absence.

Closing a browser interaction or detaching a terminal leaves the owned process independent. During graceful Gateway shutdown the pool can hand off a fully attested idle recurring inventory after physical child close and exact process-scope drain. The owner Postgres receipt carries the original deadline, source and job digests, and a monotonic generation. Optional replay inputs are sealed using the existing owner tool-output key. Startup claims a released generation exclusively after run reconciliation and rechecks the latest successful private Chat source, current provider selection, root and owner credential fingerprint.

The protected Linux launcher supplies only sealed job receipts and bounded committed text from the same canonical Chat. The pinned process keeps the default owner profile and working directory. Its private resume configuration excludes project-wide job inventory and disables writes to the original native transcript. It receives empty MCP at idle, then uses the existing per-phase capability checks and admission transaction on a future native callback. A later foreground phase uses the live protected process while it is qualified. If it has retired, canonical Chat history seeds a fresh ordinary session.

The implementation stacks on the exact qualified Schedule B head. Shared hotspots are the Claude adapter and canonical phase composition. No duplicate routines hook, authority widening or changes to other-provider dispatch are allowed. Public docs in the private site repository must describe the final accepted behavior and limits through a separate PR.

## Acceptance

1. Tests first reproduce per-turn loss and prove bounded session/phase ownership, no prompt replay, fresh permissions, stream output, correct-Chat routing, cancellation and actual cleanup.
2. Transaction tests cover idempotency, owner/session/source/binding/root/selection drift, busy Chat, late/replayed callbacks and the unchanged ordinary turn contract.
3. Real native evidence pins source head, executable/version/hash and actual process/task/result timeline. A native due result is read back in the intended Chat after the original interaction ends; cancellation is observed across the next due boundary.
4. Check formatting/timezone independently. Compare actual observation timestamps with model-written time; do not treat generated text as an authoritative clock.
5. Report head-specific CI/Greptile, installed artifact provenance, real screenshots/recording and all unverified lifecycle cases. A Draft-skipped product job is not a pass; a protocol probe is not product acceptance.
