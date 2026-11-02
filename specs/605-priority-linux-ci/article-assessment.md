# CI speed article assessment

Task: [ENG-240](https://linear.app/matrix-os/issue/ENG-240/ship-fast-ci-priority-linux-queue-and-native-typescript-checks).
Source: [Owen Gretzinger's CI article](https://x.com/owengretzinger/status/2116291924219060319), read 2 November 2026.

## Decision

Adopt dependency-cache seeding, restore-only refresh reads and the measured
native platform-fixture opt-in for hosted shards. Preserve compiler choices,
existing test coverage/isolation, Linux/hosted admission and qualification rules. Pin the
E2E host version for compatibility. Engineering-owner review of the cache and
fixture trust boundaries is recommended.

| Article idea | Matrix assessment |
| --- | --- |
| Alternate/bigger runners | Dedicated Linux already exists. Measure queue plus full qualification before buying capacity or changing providers. |
| Oxlint | Main CI has Pattern Scan and React Doctor, not an ESLint job. A migration needs rule parity and local lint benchmarks; it does not address this measured critical path. |
| Faster typecheckers | Eight standalone checks already use native TypeScript 7; keep TS5 for builds. Benchmark any replacement against diagnostics, framework and declaration compatibility. |
| Sharding and bounded concurrency | Four duration-balanced hosted shards and explicit worker limits already exist. Refresh timing profiles only from complete passing reports. |
| Disable Vitest isolation | Defer: many Matrix tests mutate mocks, environment and singleton state. A global switch needs explicit leak probes, teardown and order-randomized full-suite qualification. |
| Setup/cache reuse | Valid gap: read-only refreshes disable setup-node caching entirely; no independent main pnpm store seeder exists. Implement below. |
| Cache node_modules | Defer: global virtual-store links, native builds and install scripts require more compatibility inputs than a lockfile alone. Cache package-store bytes and retain frozen installs. |
| Blobless clone | Already used where full history matters in main classification; do not replace shallow checkout everywhere without a history requirement and measurement. |
| Parallel jobs / affected checks | Independent lanes and docs/parity selection already exist. Source-level skipping needs a dependency graph and fail-closed coverage probes before adoption. |
| Pre-push hooks | Potential separate work: needs an explicit opt-in installation and measured local budget. Retain CI enforcement; hooks can be bypassed. |

## Observed baseline

Main inspected: `231eff01cf7f67a0c135653848093c30fda3b90d`.
[Hosted refresh run 41421149970](https://github.com/HamedMP/matrix-os/actions/runs/41421149970)
was a **failed** PR refresh, not a successful qualification. Its frozen installs
took 38–111 seconds across the 12 installed job instances. Unit test commands
took 1,244–1,739 seconds; three unit shards and both E2E lanes failed. Setup is
an opportunity; the dominant unit runtime motivated the profiling below.
These are step durations, not summed end-to-end savings.

At inspection, the cache API returned one `node-cache-*` entry, scoped to a PR
merge ref, and none on main. Cache eviction can remove seeds; seeding cannot
guarantee a hit or establish a speedup without a matched hosted measurement.

## Implementation and trust boundary

### Combined profiling follow-up

The requester authorized profiling and shipping the improvements together on
ENG-240. Baseline JSON profiles attribute 5,769 seconds of 7,610 summed file
time to gateway/platform suites; these overlapping durations are diagnostic,
not wall-clock savings. Benchmark the existing native platform-fixture opt-in
against PGlite with identical source, file inventory and two workers. If the
same assertions pass faster, supply each hosted unit shard its own disposable
PostgreSQL 16 service and only `MATRIX_PLATFORM_FIXTURE_POSTGRES_URL`; preserve
the separate real-race collection gate `MATRIX_TEST_POSTGRES_URL` unset.
Require the existing native-fixture lifecycle/parity contracts and full hosted
qualification before adopting the change. Keep test isolation and assertions.

The local six-file/two-worker comparison passed the same 410 assertion identities
in all four reports. PGlite runs measured 112.12 / 103.04 seconds; native runs
83.48 / 92.33 seconds (median 107.58 versus 87.91, about 18% lower). These are
wall spans from Vitest start to the last file result on the same macOS arm64
host and Node 24.13.1. Local PostgreSQL was 17.10; hosted adoption uses the
existing PostgreSQL 16 mirror and requires its own green parity/full-suite
evidence. The first fallback run used the filesystem sandbox; its repeat and
both native runs had socket access. Report these limits rather than claiming
a production or full-CI gain. Sample files: `proxy-routing`, `billing-routes`,
`slack-app`, `customer-funded-paid-recovery`, `ai-funded-policy-routes`, and
`golden-snapshot-recovery`, all under `tests/platform/`. No measured file changed.

The hosted profile is incomplete/failed diagnostic evidence. Preserve the
checked-in duration manifest until complete passing reports exist. The 921
unprofiled files in the old manifest account for about 1,887 summed seconds;
do not train balancing on a failed run or silently omit those files.

Current hosted CI also exposes two setup/contract defects to repair: the pinned
Playwright rejects Ubuntu 26.04 selected by `ubuntu-latest`, and the backend
fallback contract treats optional restore-only cache steps as mandatory checks.
Pin the E2E job to supported Ubuntu 24.04, preserve every fallback validation
step, and permit optional read-only caching whenever its admitted job runs.

### Package cache

- Seed on main pushes and a daily main schedule, independently of Linux routing.
  Use a ten-minute deadline, read-only repository permissions and checkout
  without persisted credentials. Skip installation on an exact cache hit.
- Seed package bytes with pinned pnpm 10.33.4, Node 24 and a frozen install with
  lifecycle scripts disabled. Do not cache node_modules or claim test coverage.
- For each hosted lane whose setup-node cache writer is disabled, restore only
  the actual pnpm store using the same OS, Node architecture and lockfile key
  as setup-node v6. Use the restore-only action with no post-save hook. Share
  workflow-owned steps through YAML anchors: older accepted source checkouts
  must not need a new local helper action.
- Keep existing setup-node writers gated by `cache_write`. Refreshes may run
  PR code in a main-derived execution ref; they must never save shared caches.
- Keep frozen installs even after hits. Missing/evicted/incompatible caches use
  normal downloads; cache content never qualifies a source or replaces a check.
- The store-path step runs after pnpm/Node setup and before restore/install.
  GitHub bounds cache retention/eviction; job timeouts bound downloads and setup.
  No production endpoint, database or credential grant. After merge and green
  main, isolated refreshes need the existing reviewed-controller upgrade and
  tree-identical execution-ref procedure before the new workflow takes effect;
  that includes cache reads, native fixtures and the E2E host pin. Until then
  only main seeding is active. Operator activation follows merge and green main.

## Acceptance and documentation

1. Red/green workflow contracts cover all hosted consumers, real store-path
   discovery, exact setup-node key compatibility, restore-only refreshes and
   main-only script-free seeding. Retain existing cache-poisoning contracts.
2. Run pattern checks, affected CI contracts, root typecheck and required CI.
3. After merge, verify a main seed and an actual refresh hit, complete frozen
   install and unchanged qualification. Compare same-source job setup durations
   including restore overhead; do not promise an overall or 20x speedup.
4. Update `docs/dev/fast-ci.md` and open a separate documentation PR in
   `FinnaAI/matrix-os-site`, linked to this task and PR. Engineering CI guidance
   lives in `content/handbook/engineering/ci.mdx`; preserve that canonical split
   rather than duplicating it under product `content/docs/`.

No rendered surface changes: runtime screenshots/recordings are architecturally
inapplicable; reviewer acceptance of that classification is still needed.

References: [GitHub cache scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching),
[setup-node v6 key construction](https://github.com/actions/setup-node/blob/v6/src/cache-restore.ts),
[Vitest isolation](https://vitest.dev/config/isolate.html),
[Oxlint migration/parity](https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint).
