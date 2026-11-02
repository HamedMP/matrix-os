# CI speed article assessment

Task: [ENG-240](https://linear.app/matrix-os/issue/ENG-240/ship-fast-ci-priority-linux-queue-and-native-typescript-checks).
Source: [Owen Gretzinger's CI article](https://x.com/owengretzinger/status/2116291924219060319), read 2 November 2026.

## Decision

Adopt dependency-cache seeding and restore-only refresh reads. Preserve the
current compilers, test inventory, isolation, runner selection and qualification
rules. Engineering-owner review of the cache trust boundary is recommended.

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
an opportunity, but the dominant unit runtime/failures need separate profiling.
These are step durations, not summed end-to-end savings.

At inspection, the cache API returned one `node-cache-*` entry, scoped to a PR
merge ref, and none on main. Cache eviction can remove seeds; seeding cannot
guarantee a hit or establish a speedup without a matched hosted measurement.

## Implementation and trust boundary

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
  until then only main seeding is active. Operator activation is deferred.

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
