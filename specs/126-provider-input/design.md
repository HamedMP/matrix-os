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

## Steering while asynchronous questions remain open

The canonical Run may outlive its native execution phase while waiting for an
answer. A steering request in this interval must resume the same native
conversation with the correction, preserving the canonical Run and Turn IDs.
It must not call a native steering registry that has already been released.
Answers and idle-phase corrections share a bounded FIFO continuation queue.
Outstanding questions remain answerable; a correction is not an answer or an
approval. Each resumed phase has a distinct continuation identity.

During a live native phase, steering uses the provider's native path only when
there are no earlier queued continuations. A typed, definite non-delivery from a
released native registry may enqueue a continuation; it must wait for the phase
to finish successfully before resuming. An uncertain native delivery is never
replayed automatically. Continuation steering reports success only after the
resumed provider produces response evidence, rather than at in-memory enqueue.
Cancellation rejects unconfirmed receipts and drains pending continuations.
Owner, Chat, Run, and Turn identity must match.

The orchestrator serializes answers and steering for the same owner/Chat/Run
before their first asynchronous admission read, through delivery confirmation.
Independent Runs remain concurrent. Both the per-Run queue and total active
control queues are bounded; idle entries are evicted and shutdown rejects queued
controls. Cancellation bypasses that queue so it can interrupt pending delivery.

Regression coverage: `tests/gateway/chat-async-steer.test.ts`,
`tests/gateway/chat-ordered-controls.test.ts`, and
`tests/gateway/chat-control-admission.test.ts`. Real Hermes
validation must cover native phase completion with a question still pending,
accepted steering, and a subsequent model response to that correction without
resolving the question as answered.
