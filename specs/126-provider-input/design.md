# Design

Reuse structured user-input contracts from coding agents where compatible. Preserve structured questions in canonical events and derive pending/resolved cards from persisted events. Introduce a canonical authenticated input endpoint and adapter control method, following existing approval control ownership and idempotency rules. Validate answers against the pending request and bind them to owner/chat/run/request identity. Native control completes the existing run; never send the answer as a fresh turn.

Provider transports are researched before implementation. Preserve old title-only events as non-actionable history with explicit unavailable state. Provider limitations must not silently leave an actionable-looking card.

Auth: POST /api/chats/:chatId/runs/:runId/inputs/:requestId uses existing Chat owner authentication, boundary Zod validation and body limits. Mutations use the existing run control locking/transaction patterns. Persist canonical state via existing Postgres event repository.
