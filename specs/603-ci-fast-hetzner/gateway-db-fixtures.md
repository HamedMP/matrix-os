# Empty PostgreSQL snapshots for Chat test fixtures

## Goal and measured scope

Reduce repeated PGlite initdb work in three existing Chat suites without changing
their assertions or application startup. A sequential local Node 24 spike measured
three warm raw-engine-plus-Chat-bootstrap repetitions at 585/537/522 ms, versus
155/141/143 ms restoring an empty initialized PostgreSQL image. This is a local
microbenchmark; Linux CI speed and memory still require controlled validation.

## Isolation and lifecycle

`tests/helpers/pglite-test-helper.ts` retains one immutable, uncompressed,
nonempty Blob capped at 64 MiB per isolated Vitest module. Concurrent requests
share only template initialization. The template contains no application schema,
data, or sequence mutations and closes before its bytes are published. Every call
restores a fresh independent engine, connection, and dialect. The existing Chat
`repository.bootstrap()` runs unchanged on every instance, including repeated
bootstrap and schema-contract assertions. Unlike a migrated platform snapshot,
an empty initdb image needs no `freshSchema` bypass: application migrations still
start from an empty public schema.

The caller owns its returned engine and retains its existing teardown. Snapshot
failure clears initialization for retry; template dump/cap failures trigger
closure. Logs contain bounded error messages, and simultaneous dump/cleanup
failures preserve both errors in an AggregateError. Closure failure prevents
publication. A failed individual restore does not invalidate the immutable image.

## Validation and boundaries

Contract tests use actual databases to verify empty public schemas, concurrent
independent tables/rows/sequences, fresh subsequent engines, and unchanged Chat
columns/indexes/constraints/defaults. Focused spies verify reuse, template closure,
retry, byte caps, and original-plus-cleanup failure handling. Run those contracts
and all cases in chat-repository, chat-orchestrator, and chat-agent-execution.
These large existing files receive setup extraction only. Production code and all
other fixture callers remain unchanged; no migrations or test cases are skipped.

The companion public testing guide update is tracked in
[matrix-os-site #224](https://github.com/FinnaAI/matrix-os-site/pull/224).
