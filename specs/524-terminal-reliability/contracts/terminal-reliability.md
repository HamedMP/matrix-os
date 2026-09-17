# Terminal reliability contract

Existing workspace/tab HTTP and WebSocket endpoints remain unchanged. Legacy scalar session paths are not an acceptance entrypoint.

## Authorization matrix

| Actor/state | Observe | Text/binary input | Canonical resize |
|---|---|---|---|
| Owner with required project/Chat access, current graphical writer | Yes | Yes | Existing authorized mode only |
| Authorized graphical observer | Yes | No | No hard resize |
| Revoked graphical writer | Yes while authorized | No | No |
| Different owner or missing project/Chat binding | No | No | No |
| Authorized headless agent/controller | Existing agent contract | Existing agent contract | Existing agent contract |

Every frame retains schema validation. Batch admission retains current principal, terminal reference, project, attachment and live lease checks. Credentials and raw terminal data never enter public diagnostics.

## Ordered input and resource bounds

Adjacent text or binary input may coalesce only for the same terminal and encoding. Resize, ping, detach and other-reference messages are barriers. Binary concatenation means decoded-byte concatenation, not concatenation of padded base64 strings. Independently encoded surrogate halves retain their original meaning. Never modify an in-flight batch.

The first repair retains 32 batches including in-flight work, 1 MiB serialized bytes including in-flight work, and 64 KiB merged input batches. Malformed and excessive traffic fails closed. Legitimate 33/259 small startup replies must not be mistaken for control-frame overload. Shutdown, socket close, error and overflow clear pending work. A late native attach after socket closure detaches its viewer.

## Connection and output state

Transport-open alone is not terminal readiness. Distinguish attached, writer/observer, render/replay readiness, retrying and unavailable. Preserve bounded reconnect backoff and truthful terminal failure state. Do not replay queued commands from a dead connection into a new process. Replay and snapshot fixes require separate sequence-level evidence before implementation.

## Observability

Use bounded event names, reason codes, frame/byte counts, durations and private correlation identifiers. No terminal content, credentials, raw filesystem paths or customer-identifying public artifacts. Gateway overflow may close with 1013 and a generic reason. A successful attach does not prove the first render or user input succeeded.
