# Native fixture rollout

The qualified golden fixtures reduce 122 unchanged cases from 38 seconds to
11–12 seconds on the same Linux image and two workers. Expand only DB-only
per-case consumers; run both default and native paths with existing assertions.

The platform facade retains its existing public API and cached PGlite fallback.
Its bounded lifecycle is reusable with an honest database interface containing
`ready` and owner `destroy`, plus explicit startup/fallback functions. Gateway
integration routes use a separate module-owned closed template. Their existing
`migrate()` still runs on the template and every fresh clone; no platform schema
or live database is shared with gateway fixtures. Default gateway initialization
restores the already-qualified empty initdb image and runs that same migration.

All managers use `MATRIX_PLATFORM_FIXTURE_POSTGRES_URL`, whose exact disposable
admin database is `matrix_ci_platform_fixture_admin`. It accepts literal loopback
only and rejects URL options. Leave `MATRIX_TEST_POSTGRES_URL` unset so existing
native migration/integration gates retain their collected scope. Each module has
one closed template, at most four clones, max-one pools, bounded startup/queries,
and owner shutdown verification. Scalar INT8 retains the qualified per-pool parser.
Template publication first closes its owner pool and denies new connections,
then waits up to five monotonic seconds for exactly zero server sessions, polling
every 100 ms. Date-only test clocks cannot freeze that bound. Client closure can
precede server backend release; a persistent session
still fails closed and removes the failed template before retry.

Stage normal platform imports in batches of at most 26 files. Keep migration,
schema-generation, PGlite `instance` consumers, shared `beforeAll` fixtures, and
full fake-timer suites on their existing helper. Golden snapshot recovery also
retains PGlite: its provider call holds an admission transaction while an outside
query must read the committed machine claim, which needs more than the native
fixture's one connection. Do not expand that cap in this rollout.
Keep shared proxy helpers unchanged;
qualify the expensive DB-only proxy suite through explicit local setup instead.
Preserve each test body, assertion, timeout, and production bootstrap path.

Completion requires native contracts plus each staged unchanged suite, then the
complete collected unit suite on the final Linux image. Record exact counts,
source, image, worker count and native cluster settings. Local checks alone do
not establish the five-minute target. The companion engineering handbook in
FinnaAI/matrix-os-site PR224 documents fixture selection and evidence separately.
