# Attachment steering and acknowledged composer cleanup

User-approved bugfix scope, 2026-10-26. Continue PR2912; no production rollout.

## Design

Managed Chat and Bot share the same provider-neutral Pi worker. Capture submitted uploads with the existing owner/run-bound immutable input reader. Stage additional inputs on that run, with aggregate retained-byte/image/count bounds. File contents remain available only via exact artifact aliases; images use the existing authenticated chunk reader. Extend the steer command with an optional bounded image range, never file paths or base64 in supervisor frames. Worker ACK follows hydration and a final same-run/cancellation check. A definite refusal releases staged bytes; uncertain delivery retains them until run cleanup and never retries automatically. Old workers reject unknown image fields without consuming the canonical queue. Group and isolated restrictions remain.

Only clear submitted composer contents after server acknowledgement. Preserve failed submissions, drafts edited during the request, other conversations and identities. Reproduce the reported residue before selecting a fix. Extract submission bookkeeping rather than adding another responsibility to the large workspace component.

Confirmed offline residue: refreshing the authenticated client object after Queue submission but before its acknowledgement caused the old callback to skip both text and attachment cleanup. Retained signed-in drafts now settle by the unchanged authenticated identity/runtime generation and captured draft revision; local unretained drafts still require the original client. The ordinary success path already cleared correctly. Original Electron observations showed delayed UI refresh, so that observation alone is not attributed to this race or counted as final Queue acceptance.

## Verification sequence

1. RED tests: actual upload bytes and worker native image content; attachment aliases; ACK false, Stop during hydration, wrong owner/generation, cumulative limits, transport uncertainty. Exercise Chat and Bot adapter wiring.
2. GREEN: staged run-input helper, optional protocol range, worker hydration/loop content and shared adapter wiring. Retain source/funding/cancellation protections.
3. Composer regression: signed-in real workspace, delayed upload/ACK, focus/edit and failure races. Fix only the reproduced state transition.
4. Run targeted gateway/runtime/contract/Electron tests and affected TypeScript projects. Existing live results apply only to their recorded source SHA.
5. Build a matching Host/worker and Electron pair, reuse the existing private preview, then perform English full-window Electron QA when GUI is available. No additional VM, shared Relay or production change.
6. Update existing Draft PR evidence. Separate public behavior documentation PR in FinnaAI/matrix-os-site remains a release deliverable; no private incident identifiers in public docs. Human review precedes new formal CI/Greptile requests.

## Authority and lifecycle

No new public endpoint. Broker uses the existing authenticated owner/chat/run/runtime/generation binding and source revalidation. Upload paths are captured without symlink traversal. Collections retain at most the existing eight attachments / 20MiB, four native images and source-specific image byte budget per active run; all are released on Stop/terminal cleanup. A single pending attachment steer per run prevents competing range allocation. No silent truncation of file aliases. Rollback requires a matched prior Host/Electron pair; additive optional image fields fail closed against old workers.

## Follow-up acceptance: retained partial replies

Actual canonical Matrix Chat/Bot keeps partial assistant text after Stop/failure, but its terminal notice replaces the final message row and the retained work row omitted metadata/Copy. Reproduce against the shared transcript (including a later tool and Steer timeline), then expose Copy only on that terminal partial assistant row. Keep the stopped/failed notice, pending controls and active/completed commentary behavior unchanged. Reopen and Copy the existing synthetic stopped turn in the dedicated Electron; no new inference or Host/Relay rollout is needed for this renderer-only correction. Public behavior docs remain the separate site PR release deliverable above.

The two-poll failure exhaustion / abort / replacement-session cleanup is expected fail-closed behavior under the approved bounded recovery policy. Its underlying response-body delivery delay remains a transport investigation item; it is not by itself an implementation P1 or a reason to change retry, TLS, funding or Cancel protections. It does not block the remaining acceptance cases.

## Follow-up acceptance: stale upload validation feedback

Electron preflight correctly refuses 20 MiB plus one byte before upload, but the previous submission error remains after removing the extra file and even after navigating to another conversation. Extract only submission-error ownership from the large workspace into a small hook. Bind its one retained error to the current draft scope/revision and attachment IDs; changed input or route hides the old error, unchanged refresh preserves it, and a callback from an old scope cannot replace current feedback. Do not clear canonical admission/recovery errors or retry a request. RED the actual Bot composer removal and navigation paths, retain draft/files and zero upload/admission, then check the focused error/Queue regressions and renderer types. Repackage only the dedicated Electron and repeat preflight with synthetic local files; no Host/Relay deployment or model request. Public behavior documentation remains the separate site PR release deliverable.

## Formal CI: composed supervisor fixture

The new real-PostgreSQL qualification exposed a missing `renewRuntime` port in the Slack/Pi fake supervisor. Its fast single-session path could finish before the initial asynchronous renewal reached that port. Make the first synthetic provider result wait for the initial renewal so the incomplete fixture fails deterministically, then implement only the fake supervisor's renewal reply and verify the exact runtime/generation were created by that fixture. Keep the real admission/root checks, authority, 60-second batch gate and funding policy unchanged. This correction changes tests/spec only; it needs fresh CI/review qualification, not another Host/Electron deployment.

## Formal review: uncertain delivery and early access answers

Both Chat and Bot must distinguish an explicit worker refusal from a supervisor failure or missing acknowledgement. Only an explicit boolean `acknowledged: false` releases newly staged inputs. Any unknown outcome throws the existing generic unavailable error, keeps the already bounded inputs until Stop/terminal cleanup, and never replays the command. Exercise the actual Chat adapter and Bot orchestrator, including reads of staged aliases after unknown delivery and rejection after cleanup.

Account choices, connect requests and action approvals record the requesting run; a derived account choice preserves that run. Settlement of a completed source turn leaves its task waiting when a blocking interaction is still pending, or its unexpired resolved continuation belongs to that exact source run. A subsequent answer run completes normally. Canonical answer admission still requires the same owner, bot, chat, responder, exact saved continuation, waiting task and unexpired interaction; every explicit source run must match. Stop, other terminal states, later runs and changed answers remain refused. Regression cases cover answers queued or already admitted before source settlement, derived choices and final completion without duplicate integration calls. These Gateway changes require a new matched Host qualification; older Electron observations do not qualify the new source.

The canonical queue must also retain its existing durable pending-steer fence on unknown delivery, including thrown socket/timeout failures. Otherwise the normal terminal queue drain would replay a possibly accepted command. Extract delivery classification and callback-failure persistence from the large orchestration entrypoint into `steering-delivery.ts`; it only wires those helpers. Extract terminal pending-steer cleanup into `queued-steer-cleanup.ts` rather than adding policy to the large queue repository. No schema or wire protocol is added. Owner cancellation remains forbidden while the source run is active or missing; after the exact source run is terminal, the existing owner/chat transaction can mark the pending attempt failed and cancel its queued item atomically. Normal definite refusal remains retryable. Tests must cover no automatic drain/re-steer/edit, active-run cancellation refusal and explicit terminal queue removal.
