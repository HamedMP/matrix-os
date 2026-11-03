# ENG-344: bounded complete Matrix Agent output

Continuation of the approved T3 direction; source baseline `6b72d1e`.

## Failure and implementation boundary

The worker's 2,000 lifetime event guard exhausted live text updates. Its
fallback waited for a 12 KiB chunk or an actual model/tool boundary, so an
otherwise healthy run appeared frozen. The canonical orchestrator separately
discarded all text after a 96 KiB encoded prefix, including the final answer.

Reuse existing owner Postgres Chat messages, delta outbox and pagination.
For `matrix_pi` and `matrix_bot`, rotate to another canonical assistant message
before its encoded text exceeds 96 KiB. Preserve exact text, pending/committed
state and run/turn binding. Do not increase the 128 KiB canonical message limit.
These drivers cover the Matrix Agent's funded and owner credential routes;
coding-agent CLI adapters are distinct and retain their credential-safe preview
policy. Do not rebind sealed credential envelopes to continuation identities.

Replace the worker's lifetime event count with independently bounded encoded
text (8 MiB per turn), one awaited send chain, a 12 KiB encoded text buffer,
and timed refresh (250 ms initially, one second after 1,600 text publications).
Full buffers and real model/tool boundaries also flush. Tool progress remains
bounded at 60 starts, three updates per tool and one terminal. There is no new
model call, lease renewal or financial allowance. This is a deliberate exchange
of a lifetime display-request ceiling for byte bounds and paced updates; very
long owner-funded runs may publish more than 2,000 broker requests.

The same 8 MiB encoded budget includes one visible retention-limit notice in
Chat. This is bounded complete output **within** that budget, not an unlimited
archive. Afterwards consume controls/terminal state without resuming text with
a missing middle. Keep at most 64 source identities and 192 segments per run;
the current worker uses one canonical source. State stores counters/identities,
not the full output. SDK listener backpressure is verified for the locked SDK.

## Security and wiring

No new endpoints, DB tables or authentication paths. Stored assistant text now accepts bounded whitespace-only parts; user/provider input parts retain their existing nonblank schema, with a strict user-role check on full stored messages. Read/export and credential-sidecar parsing use the stored-part schema. The wire shape is unchanged, but the accepted snapshot values expand.
Existing `/api/chats` owner checks, run-active row locks, transactional writes
and bounded delta outbox apply. Existing paginated message reads/reload/export return the segments; unauthorized owners must receive no messages. Continuation IDs use `<canonical-source>_continued_N`. A shared pure projection joins only consecutive segments in the same chat/turn/run, preserving partial-page identities and not mutating stored messages. Electron, Web and Native Mobile display/copy one logical reply rather than hiding the prefix as earlier commentary. Derived display messages may exceed wire-message bounds and must never be validated as or persisted back to canonical rows.
Stop and terminal state remain authoritative. Financial, permission, context,
attachment, per-frame SSE, inference and idle protections are unchanged.

Orchestrator extraction plan: keep the 1,200-line dispatch entrypoint limited
to selecting this helper; all new retention state/logic lives in a focused
`matrix-assistant-output.ts`. Add integration tests in a separate focused file
rather than growing the existing 2,000-line orchestrator suite.

## Validation and rollout

1. RED: a small delta after 2,100 live updates must appear without waiting for
   a message boundary; a Unicode/escaped reply over 96 KiB must survive reload
   including its final marker. Both failed on the baseline for these reasons.
2. GREEN: test exact limits, Unicode boundaries, sealed-envelope rejection,
   owner isolation, persisted state, cancellation and existing event/tool paths.
3. Targeted regression and configured typecheck; do not claim full repository
   or Native Mobile typecheck success.
4. Review, update existing private Host bundle and matching QA Electron only
   after offline checks. No central Relay change is required by this increment.
   All updated readers must ship together: older readers can collapse continuation prefixes or reject whitespace-only stored parts. Verify live refresh, final tail, Copy and reload in maximized Electron Chat with
   screenshots; offline tests are not GUI acceptance.
5. Retain the prior exact Host/QA artifacts. Rolling back to an old reader after new whitespace-only rows exist is not transparently safe: retain an updated reader or perform a separately reviewed data-preserving compatibility migration. Do not delete owner output to make rollback pass. Previously truncated text is not recoverable from the saved Chat prefix. Production compatibility remains a release gate; the isolated QA Preview is the rollout target here.
6. Production remains gated on user review, PR conflict resolution, required
   review/CI and a separate documentation PR in private
   `FinnaAI/matrix-os-site/content/docs/`; no production rollout in this task.
