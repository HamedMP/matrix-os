# Snapshot route precedence qualification

ENG-418 host-layer CI failed in `golden-snapshot-worker-wiring.test.ts` because
its source-text assertion expected `createHostBundleRoutes` inside `main.ts`.
The complete bundle route family now lives behind `mountHostBundleRoutes`.
The assertion therefore compared a valid index against `-1` even though the
production registration order was unchanged.

Removed that representation-only assertion. Its intended protection is retained
and strengthened in the existing injected-environment HTTP test in
`golden-snapshot-routes.test.ts`: enqueue a snapshot build through real Platform
composition, read its exact build status, and reject the release credential on
the operator-only status route. No separate duplicate suite or local router
replica was added; the app telemetry shutdown is awaited before DB teardown.

Mutation proof: temporarily moving `mountHostBundleRoutes` ahead of snapshot
routes makes the real GET `/system-bundles/snapshot-builds/:buildId` return503
instead of200. The focused assertion fails. That temporary mutation was restored
before qualification or commit. Merely reading `/snapshots` would not prove the
order because its single path component does not overlap the bundle catch-all;
that weaker trial is not counted as regression evidence.

The retained fixture uses the repository's existing native-platform fixture
manager (PGlite fallback locally, dedicated Postgres in configured CI). This
proves HTTP composition and credential separation, not a real cloud snapshot,
customer login, paid provisioning or collaboration journey. Full-suite results
are recorded in the PR after execution; selected mutation runs intentionally
exclude unrelated tests and are not counted as full-suite qualification.
