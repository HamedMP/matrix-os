# Linux CI and native TypeScript

Goal: reduce the full required CI path toward five minutes using the assigned
Helsinki bare-metal host, without dropping tests or changing release guarantees.
This extends the existing CI stack in `specs/ci-fast-hetzner/plan.md`.

## Changes

- Pin native TypeScript 7.0.2 for the eight standalone no-emit checks. Retain
  TypeScript 5.9.3 for declaration builds and framework compiler APIs. Preserve
  the previous ambient-type and side-effect-import scope; fix real diagnostics.
- Reuse isolated native PostgreSQL fixtures in safe database-only test suites.
  Keep migration, fresh-schema, shared-instance and timer-sensitive contracts
  on their original setup until separately verified. Preserve every assertion.
- Cache dependency and browser bytes in a root-owned immutable runner image.
  Each run receives its own writable package store, disposable database and
  resource-bounded container. No host credentials or Docker socket enter it.
- Run independent validation lanes concurrently. Qualify one complete pass;
  measure separate cold/warm passes for profiling. Type errors fail qualification.
- Use incremental shared-package emit with output integrity checks. Deleted or
  corrupted output invalidates compiler state; the compiler always checks inputs.
- Replace hosted heavy validation only for admitted same-repository PRs after
  authenticating the dedicated controller and the exact current merge commit.
  Forks, main pushes, merge queues and unsupported stack bases remain hosted.
  Funded PostgreSQL/root contracts, Pattern Scan and React Doctor remain required.

## Security and ownership

The protected default-branch controller owns the SSH dispatch key; PR code gets
no secrets. The host dispatcher validates exact SHAs and allowlisted suites,
snapshots the immutable image digest and admits one run at a time. Private and
host egress remain blocked. Fixtures own their connections, schemas and cleanup.
Compiler caches are local, ignored, bounded and excluded from release bundles.

## Acceptance

1. Native and legacy compilers pass the same eight project scopes.
2. Focused fixture contracts pass against disposable PostgreSQL, with unchanged
   migrated-suite assertions; the complete unit report has no failures.
3. Real Linux qualification passes all covered lanes, with accepted source SHA,
   image digest, test counts, timing artifacts and cleanup evidence.
4. CI Results fails on missing, stale, wrong-source or failed dedicated evidence;
   protected hosted lanes still contribute to the aggregate result.
5. Publish measured before/after timings in the separate engineering handbook
   through the existing `FinnaAI/matrix-os-site` documentation PR.

Five minutes is a measured target, not a release promise. Baseline Linux unit
tests take about twelve minutes; native no-emit A/B measured about 61 seconds
versus 16 seconds before the four gateway inference fixes. Final combined
measurements and opt-in activation follow validation and reviewed-stack landing.
Stakeholder review of the CI routing and retained coverage is recommended.
