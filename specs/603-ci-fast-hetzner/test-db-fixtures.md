# Fresh platform test database snapshots

The platform test helper caches one immutable, fully migrated PGlite database
image per isolated Vitest module. Every fixture call restores that image into a
new engine, dialect, and Kysely connection, then invokes the unchanged platform
startup path and awaits its schema revision validation. Tests share no mutable
database, data, sequence, transaction, or lifecycle state.

The template includes the normal migration-generated schema, constraints,
defaults, revision records, and seed data. It is dumped without compression and
closed before the image becomes available. A single initialization promise
coalesces concurrent calls. The retained image is bounded at 64 MiB; failures
reset initialization for retry and close acquired resources. There are no disk
artifacts or timers; the image expires with the Vitest module lifecycle.

Migration contracts explicitly call `createTestPlatformDb({ freshSchema: true })`
to bypass template creation/reuse and run the complete fresh-schema bootstrap.
Direct Chat fixtures and production database behavior are outside this change.

Contracts verify independent/concurrent data, schema, and sequences; bootstrap
defaults/constraints/seed/revision preservation; template reuse/closure; explicit
fresh mode; and cleanup/retry after startup, dump, and size-limit failures.
Validate existing golden snapshot, customer VPS, billing, and funded proxy suites
after the helper contracts. Linux cold/warm benchmarks must use the same product
source when comparing this fixture layer; local fixture timing is not an
end-to-end CI speed claim.

The companion [public testing documentation PR](https://github.com/FinnaAI/matrix-os-site/pull/224)
will explain fresh snapshot semantics and the migration-contract opt-out in the
canonical developer testing guide.
