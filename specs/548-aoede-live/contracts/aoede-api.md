# Aoede application boundaries

All endpoints use the auth matrix in ../plan.md. IDs are opaque, bounded application IDs; session IDs are UUIDs. No browser authority over provider configuration, funding or billing.

POST `/api/aoede/session`: `{clientRequestId, sdp}` → `{sessionId, providerSessionId, sdp}`. DELETE same route: `{sessionId}`. GET same route: latest session/recovery checkpoint; DELETE `/api/aoede/recovery`: removes saved recovery text without deleting Chat/facts. Each mutation is body-limited; safe errors only.

Internal POST `/internal/containers/:handle/aoede/session?runtimeSlot=...`: `{clientRequestId, sdp, instructions, input}` → `{providerSessionId, sdp}`. Internal DELETE `/internal/containers/:handle/aoede/sessions/:id?runtimeSlot=...`; trusted attach WS at that session path plus `/attach`. Runtime auth uses the existing speech token (machine/slot/epoch), not handle-only Gemini auth. Platform validates the session/reservation identity at close/attach.

## Existing /ws extension

Server frames carry `sessionId`; only the invoking shell acts on a matching session:
- `aoede:state`: state `active|closed|interrupted|superseded|error`.
- `aoede:ui`: `correlationId`, phase `resolve|execute`, action `open_app|close_app`, target (user name for resolve, installed slug for execute).
- `aoede:card`: `card` containing id/chatId/runId/queuedTurnId, title, status and optional canonical approval.
- `aoede:approval_decide`: chatId/runId/approvalId/decision/clientRequestId; only sole presented low-risk approval; shell HTTP only.

Client frames:
- `aoede:ready`: sessionId (greeting readiness only).
- `aoede:ui_result`: sessionId/correlationId, phase, status `ok|ambiguous|not_found|failed`, optional installed slug. Gateway revalidates resolved slug before execution; acknowledgements must originate from the bound shell connection.
- `aoede:approval_result`: sessionId/approvalId/clientRequestId/accepted. Gateway re-reads canonical state before confirmation.
- `aoede:cancel`: sessionId/cardId; canonical cancellation only.

Gateway session service exposes `start(principal, input)`, `close(principal, sessionId)`, `snapshot(principal)`, `clearRecovery(principal)`, `onClientMessage(principal, connectionId, frame)`, `shutdown()`. Session dispatch injection receives sessionId/principal/delegationId/recent transcript/append and emit; gateway composition binds canonical Chat and direct actions after lifecycle tests pass.

Direct actions module exposes strict action classifier and executor constructed with registry, owner app DB, profile path and session-correlated UI callback. It does not own socket routing or Chat admission. An unmatched phrase returns null and routes through canonical Chat.
