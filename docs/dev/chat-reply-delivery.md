# Diagnose delayed Codex Chat replies

Plan and regression evidence: [2710-chat-reply-delivery](../../specs/2710-chat-reply-delivery/plan.md).
Tracking: [ENG-540](https://linear.app/matrix-os/issue/ENG-540/perfchat-cut-codex-send-overhead-from-20-s-to-near-raw-codex).

The native provider can finish before the gateway delivers its output to Chat.
Measure generation, provider observation, durable ingestion and canonical Chat
publication separately before attributing a slow greeting to reasoning effort.

## Trace a delivery

Enable `MATRIX_CODEX_SEND_TIMINGS=1` on the diagnostic gateway process. The native
Codex launcher forwards that supported flag to the runner. Normal runs leave it
off. Existing `[chat-send-timing]` `runner_link` records connect a Chat run to a
hashed session, and runner timings use the same hash.

Delivery records carry that session hash, a fixed stage name and `durationMs`:

| Stage | Includes |
| --- | --- |
| `bridge_read` | Transcript checks and reading available complete JSONL records |
| `store_queue_wait` | Waiting for earlier shared legacy-store operations |
| `store_read` | Reading, parsing, validating and normalizing legacy thread state |
| `store_mutation` | Applying the batch to thread state |
| `store_write` | Retention trimming, validation and atomic file replacement |
| `store_projection` | Awaiting project summary event publication |
| `bridge_ingest` | The complete durable ingestion call, including the store stages above |

These durations overlap: do not add `bridge_ingest` to its constituent store
durations. Delivery timings begin when the bridge observes available bytes;
they do not measure time spent before a drain starts. Compare them with the
native runner's first-delta/terminal stages and canonical Chat dispatch timings.
Read-only operations outside the bridge are not instrumented by this context.
Stages still record elapsed time if the underlying operation throws; a timing
record alone is not proof of successful delivery.

The records contain no prompts, replies, paths, credentials or account names.
Keep captured logs and recordings outside the repository and redact unrelated
records before attaching them to a PR or support report.

## Persistence and recovery

The compatibility thread store still uses its existing JSON format. The bridge
now batches already available complete records within the existing 100-event
consumer limit. It adds no debounce delay. A greeting and terminal record in one
read normally need one durable write instead of one per native line.

Native terminal boundaries flush their own batch, preserving usage association
when a transcript contains multiple turns. An incomplete final line never
advances the checkpoint. A single native record expanding beyond the consumer
limit is written in bounded chunks; only its last chunk advances the durable
byte position. Earlier chunks retain deterministic IDs for deduplication after
a failed write or restart. Existing owner, session and generation checks remain
authoritative.

This removes write amplification; it does not remove the shared mutation queue,
full-history parsing, or synchronous project projection. The next architecture
step is targeted owner-Postgres writes with a transactional delivery outbox and
provider calls outside shared critical sections, with authority revalidation.
Do not claim sub-500 ms delivery without a matching-runtime measurement.
