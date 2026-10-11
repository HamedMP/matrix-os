# Empty database images in shared Bot and collaboration fixtures

## Goal

Apply the tested empty initdb snapshot helper to the two central unit-fixture
helpers. Linux profiling identified Bot integration tools, collaboration owner
source, and direct sessions as expensive suites using these helpers. This layer
changes only local PGlite engine creation; controlled Linux benchmarks must measure
the resulting wall-time and memory change.

## Preserved behavior

Both helpers call `createTestPGlite()` to receive a fresh independent engine and
dialect from one immutable empty initialized PostgreSQL image per isolated Vitest
module. Snapshot bytes, resource bounds, retry, and template closure are governed
by [the gateway fixture contract](gateway-db-fixtures.md). No application schemas,
rows, or sequence mutations are cached; the helper itself adds no seed data.

The collaboration helper still returns an empty public schema for callers to
bootstrap. The Bot helper still bootstraps Chat on every call, and bootstraps Bot
unless `migrate:false`. That option leaves the Chat schema available and every Bot
migration unapplied, preserving migration and upgrade contracts. Caller bootstrap,
seeding, and teardown are unchanged. Both real PostgreSQL fixture functions remain
byte-for-byte unchanged, including isolated schemas, pool limits, and cleanup.

## Validation and documentation

Focused contracts first demonstrate shared template reuse and actual independent
Bot/collaboration data and sequences, empty pre-bootstrap engines, unchanged
`migrate:false`, and closure of every clone through existing teardown. Run every
unit suite importing either central helper; report existing native PostgreSQL
variants as skipped when `MATRIX_TEST_POSTGRES_URL` is unavailable. No test cases
or production behavior are removed. The companion public testing guide update
is tracked in [matrix-os-site #224](https://github.com/FinnaAI/matrix-os-site/pull/224).
