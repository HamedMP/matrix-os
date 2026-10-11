# Optional native platform test fixtures

A private disposable Linux spike passed identical seed/default, constraint,
rollback, row and sequence-isolation assertions against both fixture backends.
Across three warm repetitions, creation/startup averaged 399.603 ms with the
existing PGlite snapshot helper and 32.169 ms with native database clones. Full
fixture lifecycle including assertions/teardown averaged 409.884 ms and
48.319 ms respectively; the concurrent pair measured 786.107 ms and 114.795 ms.
These are fixture measurements, not whole-suite or CI completion claims.

## Scope and invariants

Only golden-snapshot repository (66 cases) and service (56 cases) import the new
fixture facade; their test bodies and assertions remain unchanged. The facade
returns `{ db }`, without pretending native Postgres is a KyselyPGlite instance.
Five existing consumers of instance/client APIs and all migration contracts
continue using their original helpers. No production database code changes.

An unset `MATRIX_PLATFORM_FIXTURE_POSTGRES_URL` delegates creation and teardown
to the original cached PGlite helper. An explicitly set empty/invalid value
fails closed. Native admission permits only PostgreSQL URLs on literal
`127.0.0.1` or `::1`, naming exactly `matrix_ci_platform_fixture_admin`, with
no URL query/fragment. This distinct setting does not enable unrelated tests
controlled by `MATRIX_TEST_POSTGRES_URL`. It must identify a fresh disposable
loopback server inside the bounded benchmark container, never a host/customer
service or data directory.

Each isolated Vitest module owns one native migrated template. Its owning pool
closes before publication; zero connections are verified and template
connections are disabled. Every test receives a newly cloned database, a fresh
max1 pool/dialect, and unchanged `createPlatformDb(...).ready`. Clone tables,
rows, sequences and connections are never shared or reused. Physical database
name slots may be reused only after closing and dropping the prior database.

The module has exactly five allowlisted generated names (template plus four
clone slots), four pending factories, four live native clones, and at most four
fallback fixtures. Cached template size is capped at 64 MiB. Maps/sets are
bounded and evicted on teardown; closed DB callbacks use weak references.
Connections, statements, locks, operations and cleanup have explicit deadlines.
Failed initialization resets the template promise and disposes partial resources;
startup plus cleanup failures are logged and preserved together. Cleanup failures
remain eligible for another drain. Fallback fixtures enter the bounded owner
registry before the first teardown attempt, including a late startup invalidated
by an earlier drain; failed destruction retains that exact database for retry.
Existing per-case destruction is preserved,
with module-level afterEach and afterAll drains, database absence verification,
and admin pool closure as additional owner cleanup. Each coalesced drain invalidates
all previously admitted factories with a bounded epoch token, including template
and fallback startup that outlives its deadline. Admission pauses during drain;
subsequent tests may create new fixtures after it completes. Late factories close
owned resources rather than publishing them into a later test. Cleanup retains
the exact resource identity so a late factory cannot drop a new database that
reuses its released name slot. Hook budgets cover the individual operation
deadlines plus cleanup, rather than terminating before owner cleanup completes.

## Scalar integer compatibility

The first native 122-case golden run passed 120 cases; two unchanged assertions
exposed scalar PostgreSQL INT8 decoding differences (931 and 102 were strings).
Direct queries against the existing PGlite fixture confirm that scalar INT8
values within the signed JavaScript safe-integer bounds decode as numbers;
values outside those bounds, including both PostgreSQL INT8 extrema, decode as
exact `bigint`s. Scalar NULL remains NULL.

Each owned native pool supplies its own text INT8 parser matching that baseline.
It parses to BigInt first and converts only proven-safe values to Number. No
production parser, global `pg.types` registry, or unrelated connection changes.
All other OIDs and binary formats retain pg defaults, including NUMERIC, JSON,
and arrays. This layer covers scalar integers used by the two golden suites;
they contain no BIGINT-array queries. The spike also found that PGlite's current
BIGINT-array parser throws on NULL elements; the fixture does not reproduce that
array defect or broaden this fix to array decoding.

A local behavioral contract derives expected values from an actual PGlite query,
checks every owned pool's connection parser, and verifies unrelated connections
and global parsers remain unchanged. A separate real-native roundtrip contract
checks the same safe/out-of-range signed boundary values and NULL on the server.

## Validation and delivery

TDD contracts cover default fallback selection, URL guards, template reuse and
closure, failed initialization retry, cleanup error preservation, pending
fallback shutdown, cleanup after pending drain deadlines, rejection of late
publication after late template/fallback startup, resumed admission, coalesced
drains, cleanup of reused name slots, rejection of pool creation after late DDL,
template size limits, clone startup failure, and four-slot
admission. Optional real-native contracts preserve schema/defaults/seed data,
concurrent rows/sequences, rollback and final database/pool cleanup. Local
validation runs both unchanged golden suites with the setting unset. The three
real-native contracts require the explicitly provisioned disposable server and
are reported as skipped when absent. Final local focused validation passed all
143 cases (122 unchanged golden cases plus 21 helper contracts), with the three
real-native contracts skipped; the owned helper/contracts also passed standalone
strict NodeNext TypeScript validation.

Next validation is a same-image/source/workers comparison of all unchanged
66+56 golden cases under both backends after independent review. No hosted CI
configuration or additional callers migrate until those results justify it.
The engineering-handbook documentation deliverable is in the separate
[FinnaAI/matrix-os-site PR #224](https://github.com/FinnaAI/matrix-os-site/pull/224).
