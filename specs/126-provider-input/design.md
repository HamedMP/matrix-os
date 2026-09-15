# Design

Reuse structured user-input contracts from coding agents where compatible. Preserve structured questions in canonical events and derive pending/resolved cards from persisted events. Introduce a canonical authenticated input endpoint and adapter control method, following existing approval control ownership and idempotency rules. Validate answers against the pending request and bind them to owner/chat/run/request identity. Native control completes the existing run; never send the answer as a fresh turn.

Provider transports are researched before implementation. Preserve old title-only events as non-actionable history with explicit unavailable state. Provider limitations must not silently leave an actionable-looking card.

Auth: POST /api/chats/:chatId/runs/:runId/inputs/:requestId uses existing Chat owner authentication, boundary Zod validation and body limits. Mutations use the existing run control locking/transaction patterns. Persist canonical state via existing Postgres event repository.

| Boundary | Authentication and authorization | Public |
| --- | --- | --- |
| `POST /api/chats/:chatId/runs/:runId/inputs/:requestId` | Existing verified gateway principal. Personal owner comes from its user ID; repository and live adapter checks bind owner, Chat, run and request before delivery. Zod validates IDs and answers; request body is limited to 40 KiB. | No |
| Canonical Chat detail and event reads | Existing verified gateway principal, owner-scoped repository reads and event-stream filtering. | No |
| Native input controls | Controls are bound to the admitted owner and run. Codex/Pi use process-local transport, Hermes its local control socket, and OpenCode an authenticated loopback endpoint. | No |

No public or anonymous endpoint is introduced. Native callbacks do not replace gateway authentication. Confirmed pre-delivery failures reopen only their exact durable claim under the Chat row lock; ambiguous delivery remains fenced against replay.
