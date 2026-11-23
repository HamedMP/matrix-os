# Deliver completed Chat replies promptly

Tracking: [ENG-540](https://linear.app/matrix-os/issue/ENG-540/perfchat-cut-codex-send-overhead-from-20-s-to-near-raw-codex).

## Problem and scope

Runtime investigation found a greeting generated within seconds but persisted to
canonical Chat much later. The exact historical queue blocker is unproven. The
Codex bridge currently checkpoints every native line, including ignored lines;
each checkpoint parses and rewrites the complete legacy thread store and awaits
project projections. This amplifies shared-queue contention as history grows.

This change removes per-line persistence and adds opt-in delivery timings. It
does not change models, reasoning, account proofs, tool availability, permissions,
or the existing storage format. The bridge ingestion logic will be extracted
into a focused module before adding batching. No behavior is added to the large
thread-store entrypoint without extracting its queue/persistence orchestration.

## Implementation

1. Reproduce excessive checkpoint writes with the real bridge and thread store.
2. Batch complete native records up to the existing 100-consumer-event contract.
   Advance a native record's byte checkpoint only after all of its expanded
   events are committed. Ordinary batches commit events, native conversation
   identity and the final complete-record offset together.
3. Flush at native terminal boundaries so usage remains associated with the
   correct completion. Preserve deterministic event IDs, generation checks,
   retry deduplication, incomplete-line handling and restart recovery.
4. Add opt-in timing for queued store work, reads, mutations, writes, projections,
   and bridge ingestion under `MATRIX_CODEX_SEND_TIMINGS`. Emit opaque hashes,
   fixed stage names, counts and durations only, never transcript content.
5. Run focused regression and lifecycle suites, fault injection, pattern checks
   and type checks. Benchmark a synthetic retained history with identical inputs
   before and after. Keep raw benchmark/capture artifacts outside the repository.
6. Publish a draft PR with test evidence and request engineering review. Recommend
   review by the Chat/runtime owner for checkpoint and lifecycle semantics.
7. Prepare a separate public documentation PR in `FinnaAI/matrix-os-site` under
   `content/docs/` documenting delivery diagnostics and supported recovery.

## Acceptance and invariants

- A small greeting and terminal output already present in one drain require one
  durable checkpoint. A larger drain respects the existing event batch limit.
- A failed write or lost acknowledgement followed by restart preserves every
  assistant fragment, native identity and terminal usage exactly once.
- Partial UTF-8/JSONL records never advance the durable byte checkpoint.
- Ownership and observation generation remain checked by the production store.
- There are no new endpoints or authority grants. Existing owner checks and
  provider boundaries remain authoritative. Existing legacy JSON is retained;
  no new persistence store is introduced.

| Scenario | Boundary | Evidence |
| --- | --- | --- |
| Greeting and completion | Real bridge → real thread store → reload/event sink | Regression red/green and persisted offset |
| Batch overflow and partial final line | Native JSONL → consumer events/checkpoint | Exact ordered text and byte offsets |
| Failed commit or lost acknowledgement | Real durable state → restarted bridge/store | No lost/repeated text or terminal usage |
| Hibernation, continuation and generation fencing | Existing runtime lifecycle suites | Existing assertions continue to execute |
| Visible greeting delivery | Matching runtime on Web Canvas, Web Desktop, Electron Desktop, Web Mobile, Native Mobile | Separate exact-build screenshots/recordings required before review/merge readiness |

Live surface qualification requires runtime/device access; unit/integration tests
cannot substitute for it. Do not mark the PR ready without required evidence or
an architecturally justified reviewer-approved exception. Post the same captures
and ticket/PR links to Slack `#tech` and link the permalink back to the PR when
an authorized Slack tool is available.

## Remaining architecture work

These changes reduce avoidable writes; they do not establish sub-500 ms delivery
under arbitrary load. Use the stage timings to identify residual blocking. Move
legacy thread records/events to owner Postgres with a transactional delivery
outbox, target writes to one thread, and move provider calls outside shared store
critical sections with revalidation before committing results. Those migrations
need their own bounded implementation and concurrent-connection tests, plus
upgrade/rollback and cross-surface runtime qualification.
