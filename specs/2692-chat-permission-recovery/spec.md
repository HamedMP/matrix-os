# Apply owner permission changes consistently

Ticket: [ENG-267](https://linear.app/matrix-os/issue/ENG-267).
Related: [original approval specification](../628-supervised-tool-approval/spec.md).

## Verified problem

At main `5ac81c7f4`, approval-card Full access updates only the local composer
selection and submits an ordinary one-time approval. The active run retains its
admitted Supervised mode, sandbox, MCP authority and Browser lease. The next tool
therefore asks again. Navigation discards the draft and restores the admitted
Supervised value. No failed permission-save request is involved: none is sent.

## Required journey

An owner selecting Full access must perform an authenticated authority change,
receive a confirmed outcome, and see the same effective mode after navigation
or reload. The pending tool and subsequent tools must use that confirmed mode.
An unsupported adapter must not expose a misleading live-upgrade action.
Composer preferences alone never authorize a run. Keep Supervised as the default.

The original admission capability snapshot remains immutable provenance.
Persist and project the effective permission transition separately. Reconcile
same-run changes in every renderer; do not require a new run ID or chat switch.
Reject stale/cross-chat/cross-owner actions and safely display failure without
leaving an optimistic Full Access label or approving a tool independently.

## Native protocol spike

Two initialization/control-only spikes against installed Claude Code 2.1.278
used isolated temporary directories, cleaned afterward. No model prompt or tool
ran. Without `--allow-dangerously-skip-permissions`, bypass mode was rejected.
With that flag, initialization remained in default mode; acknowledged
`apply_flag_settings` disabled the sandbox, then `set_permission_mode` accepted
`bypassPermissions`. `get_settings` confirmed sandbox disabled. Implement bounded,
validated control responses; the flag alone must never enable Full access.

## Security and integration plan

Add `POST /api/chats/:chatId/runs/:runId/permission-mode` using the existing
owner-authenticated canonical control transport and a separate signed mode proof.
The bounded body contains `clientRequestId` and `permissionMode` (Supervised or
Full access); bind proof to the exact owner, chat, run, mode and request ID.
Existing Custom MCP approval proofs and decisions remain unchanged. Native controls,
integration authority and Browser lease must all reflect the same explicit grant.
Do not widen custom-MCP, integration or Browser approval decisions implicitly.
Serialize transitions with run controls, bound pending state/timeouts, revoke
run-scoped authority on shutdown/cancellation, and abort on uncertain partial
native changes rather than continuing under a false permission claim.

| Boundary | Authority and admission | Failure behavior |
| --- | --- | --- |
| Canonical permission-mode POST | Authenticated owner, exact active chat/run, supported live modes, signed intent; bodyLimit and Zod boundary validation | Reject missing, expired or mismatched proof; no mutation on an unsupported adapter |
| Gateway to live adapter | Active matching owner/run and supported control | No implicit grant; cancel on partial change |
| Native control protocol | Exact request/response ID and bounded acknowledgement | Timeout/error aborts transition |
| Durable effective controls | Existing owner-scoped Postgres and canonical events | Atomic related writes; no snapshot rewrite |
| Client presentation | Confirmed canonical state | Generic error and authoritative reconciliation |

The dedicated response identifies chat/run, effective mode and accepted/already
applied status. Repeating the same request must not replay native effects.
Capability advertisement is optional, backed by the eligible live adapter; older
catalog clients must retain compatibility through existing version negotiation.

The implementation plan must identify the exact transaction/event boundary and
live capability-update methods before production edits. No new persistence
technology, global communication channel, silent prompt replay or production
permission change is allowed.

## Acceptance and delivery

Regression tests must fail before the fix: two sequential native tool requests,
owner upgrade on the first, no redundant second approval; confirmed controls
survive navigation/reload; forged/stale/mismatched proofs, cancellation, failed
acknowledgements and partial failures never produce authority. Preserve ordinary
Allow once/decline behavior and next-turn supported-mode selection.

Assess Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile
separately. Capture exact-build screenshots and recordings on reviewed test
runtimes; fixtures/protocol spikes are not full live qualification. Include
affected regression tests, coverage, typechecks, pattern scan, React Doctor and
production builds. Recommend engineering/security review of authority changes
and product review of permission semantics. Publish a companion public-docs PR
in `FinnaAI/matrix-os-site/content/docs/`. Missing required evidence remains a
review-readiness blocker. No merge or customer deployment is requested.
