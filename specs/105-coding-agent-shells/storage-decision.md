# Coding Agent Thread Storage Decision

## Scope

This note covers the first gateway thread lifecycle slice: thread metadata, safe summaries, replayable events, idempotent create requests, and abort markers.

## Source Of Truth

The source of truth for this slice is the owner-controlled Matrix home file:

`system/coding-agents/threads.json`

This follows existing owner-file conventions for Matrix runtime metadata while avoiding a new embedded database. Desktop and mobile do not persist thread transcripts or event payloads; they read summaries and event windows from the gateway.

## Persisted Data

Persisted thread records include:

- owner ID
- thread ID
- provider ID
- safe title
- status and attention state
- optional project, task, terminal, and worktree references
- idempotency request IDs
- bounded typed events

The store intentionally does not persist create prompts, terminal output, file contents, diffs, provider logs, raw errors, credentials, tokens, hostnames, or filesystem paths.

## Transaction Boundary

Each create or abort operation runs through a per-store mutation queue:

- read and validate the persisted file
- apply the thread metadata and event change together in memory
- validate the full next persisted shape with Zod
- atomically write the next file with temp-file plus rename

For create, the thread record and initial events are written together. For abort, the terminal/provider process is not killed in this slice; only the thread lifecycle state is marked aborted.

## Idempotency

Thread creation is idempotent by `ownerId + clientRequestId`. A repeated create request returns the existing thread snapshot and does not append duplicate events.

Abort is idempotent by thread plus abort `clientRequestId`; repeated abort requests return the existing aborted snapshot and do not append duplicate events.

Legacy adoption is state-idempotent: only a thread with no project or task relation can be assigned, an exact relation retry returns `already_adopted`, and any attempt to move an assigned thread fails relation validation. Public thread projection changes are derived from the persisted next state and published through bounded workspace activity events only after the owner-file write succeeds.

## Bounds And Eviction

The first store caps persisted state to:

- 200 threads
- 500 events per retained thread
- 50 abort request IDs per thread
- 50 active threads in list responses
- 200 events in replay responses

When the thread cap is exceeded, the oldest updated threads are evicted from this owner-file projection along with their events. A future Postgres-backed store may preserve deeper history without changing the gateway contracts.

## Acceptable Orphan States

This slice may contain a thread marked `running` whose fake provider has no live external process, because provider execution is still behind a feature flag. Clients must treat thread status as runtime metadata and recover by refreshing the summary or replaying events.

If a write fails after validation, the previous file remains intact. If provider startup fails before the file write, no thread is committed for this slice.

## Event Streaming

Thread event streaming is gateway-owned and reuses the persisted event window. A stream attach validates the owner principal, replays events after the supplied cursor, then subscribes the socket to live events emitted after successful thread-store writes.

The stream registry is process-local and capped. It evicts the oldest subscriber when the cap is reached, evicts stale subscribers by TTL, removes failed senders after broadcast, and drains subscribers during gateway shutdown.

## Deferred Work

- real provider adapter start and abort behavior
- approval and input request state
- durable compaction beyond the bounded owner-file projection
