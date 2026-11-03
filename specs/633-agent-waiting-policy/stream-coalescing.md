# Native subscription stream coalescing

## Problem and decision

ENG-344's paired Electron subscription sends each yielded chunk as a separate
HTTP reply and waits for its consumption receipt. Small upstream reads therefore
pay one cross-network round trip each, even when much more output is available.
The observed QA run delivered 1,592 characters in 112.799 seconds, with 210
successful reply requests. A no-model/no-renderer reproduction using the actual
parser and peer spends about 101 seconds on 200 small frames with 500ms ACKs.
These measurements do not establish upstream model generation latency.

Read ahead independently of the current reply's ACK and coalesce the next batch.
Keep one HTTP sender and the existing sequence/receipt/retransmission contract.
This is an Electron-only change: no new endpoints, DTOs, Host or central Relay
deployment, credential, funding, provider selection or permission changes.

## Bounds and failure behavior

- First nonempty source item is immediate. Later batches flush within 50ms,
  when full, or on source completion/failure; no minimum payload is required.
- Each source item, pending batch and current immutable reply is at most 64KiB.
  A producer waiting for a partially filled batch to drain may hold one source
  item. Retained raw payload is thus at most 192KiB per inference, excluding
  existing parser memory, JS object/string overhead and JSON encoding copies.
  No unbounded queue or stream-wide accumulation is introduced.
- Reading pauses when pending capacity is exhausted. The original single
  consumption ACK and negotiated identical-byte retransmission remain intact.
- Stop, return/409 and source change abort the producer and drop unsent bytes.
  Pending read/space waits wake on cancellation; a non-cooperative next/return
  cannot prevent local cancellation. Late promise outcomes remain observed.
- A source error can deliver already-received partial bytes, then fails without
  a success end. Terminal SSE frames remain withheld by the existing parser
  until actual EOF and source validation. No model POST is replayed.
- Existing input/parse bounds, 10-second POST deadlines, retry/capacity budgets,
  signed-session checks, idle semantics and funds remain authoritative.

## Regression and release qualification

The actual parser/peer regression must fail on the old serial read/send loop and
deliver the same ordered UTF-8 bytes with at most four HTTP replies and under
2.1 seconds of virtual time for 200 pre-generated small frames and 500ms ACKs.
Separate cases cover sparse 50ms flushing, bounded prefetch, multibyte ordering,
full-buffer cancellation, stale source, partial failure and non-cooperative
iterator cleanup. Existing EOF, lost ACK, receipt, source and idle suites remain
required. Fake time verifies the transport mechanism, not live provider speed.

After local checks, rebuild the matching dedicated QA Electron without changing
the existing Host. Repeat the original bounded synthetic live prompt, record
client SHA, Host SHA, run identity, text size and elapsed time, and distinguish
Host completion from visible UI completion. Retain failed evidence. Current-head
Greptile/CI and human review remain merge gates; no production deployment or merge
is part of this correction. Rollback is the previous Electron artifact; the
Host/Relay protocol remains unchanged.
