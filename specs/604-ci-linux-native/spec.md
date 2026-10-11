# Linux CI and native TypeScript

Goal: reduce the full required CI path toward five minutes using the assigned
Helsinki bare-metal host, without dropping tests or changing release guarantees.
This extends the existing CI stack in `specs/603-ci-fast-hetzner/plan.md`.

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
- Single-node runs may opt into longest-first profile scheduling with
  `MATRIX_TEST_PROFILE_SORT=1`, guarded by `CI=true`/`CI=1` or
  `MATRIX_TEST_BENCHMARK=1`. Local and default unsharded runs retain Vitest sorting;
  shard assignment stays unchanged. Unknown files use the profile median and
  deterministic declaration identities retain every collected test. Enable the
  option for qualification, update durations only from complete passing reports,
  and measure any scheduling improvement before claiming a speedup.
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

## Incremental compiler cache lifecycle

Each package build creates its own output and `.matrix-build-cache` directories,
then atomically publishes a populated owner lock before reading or writing cache
state. Competing builds wait at most 120 monotonic seconds. Startup sweeps only
known temporary stamp names and aged preparations with dead owners; disappearing
preparations are expected races, while other I/O errors fail the build. Symlinks
are never followed for cleanup, manifests or compiler state. Live writers and
uncertain populated reaper locks are never stolen.

The wrapper records a separate compiler supervisor before permitting compilation.
That supervisor owns a POSIX process group, forwards cancellation, and enforces
a ten-minute compiler timeout followed by a five-second forced-stop deadline.
The primary lock remains owned until compiler termination is proved. A crashed
wrapper can be recovered only when both its PID and the recorded compiler group
are absent; an uncertain group or a Windows crash record requires operator
recovery after all writers stop. Compiler errors invalidate state and output
stamps, propagate a failing status, and release only proven inactive ownership.

The compiler always checks source/options/version. Reuse additionally requires
intact output hashes; missing, malformed or oversized manifests cause cold emit.
State is capped at 16 MiB, manifests at 2 MiB, output at 10,000 entries/128 MiB,
individual output files at 16 MiB and traversal depth at 128. A successful build
atomically replaces its stamp and removes its own temporary file. Startup cleanup
runs on every build; unknown files are preserved. Host-bundle staging removes
package caches before release metadata, incremental object generation and archive
creation, leaving source caches and external symlink targets untouched. Docker
copies the helper before package compilation. Focused contracts cover real
compiler cancellation, orphan ownership, sweep races and staged-cache exclusion.

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

## Temporary Electron Desktop bundler bridge

Pin `rolldown-vite@7.3.1` only for Electron Desktop and Electron-Vite's Vite
peer, with Electron explicitly external in main and preload. The unchanged
Linux Electron, clipboard, grid and security lanes passed: 116 tests passed,
with two macOS-only skips. Exploratory cold builds fell from 52–53 seconds to
7 seconds; integrated 66 contracts and all eight native type checks also passed.
This does not establish whole-CI timing or macOS packaging/signing parity.

The registry marks this preview package deprecated in favor of Vite 8; it is a
temporary compatibility bridge, not a maintained security minor. The current
stable Electron-Vite 5.0.0 peer range accepts Vite 5–7; its Vite 8 successor is
still beta. [Vite's migration guide](https://vite.dev/guide/migration.html)
documents this intermediate path. Follow up with supported stable Vite 8 and a
compatible stable Electron-Vite release, repeating unchanged runtime/security
and macOS packaging checks before removing the alias and scoped override.
Keep the seven-day release-age policy; root unit-test Vite remains unchanged.

## Web build scheduling and compilation

Start the production Web build alongside unit, mechanical, browser and Electron
lanes in full/qualification runs. Standalone `checks` retains its build; every
lane remains awaited and any failure fails qualification. Existing per-package
compiler locks serialize shared brand/observability output safely.

Explicit Next Webpack workers allow server/edge compilation and build tracing
to overlap despite the required source-extension hook. Optimize only the
`@hugeicons/core-free-icons` barrel: the application uses 216 leaf icons, while
the baseline trace traversed all 6,025 icon files in both server and browser
compilations. Preserve aliases, React Compiler, PostHog wrapping and Next's
built-in import optimizations. These options are experimental; require canonical
production builds and runtime regression checks before activation.

The same passing source built Web in 257 seconds during full qualification but
60 seconds alone. Worker-only builds measured 54 seconds alone, cold and repeat;
these single samples do not establish whole-CI improvement. Static generation
was under two seconds and already used 15 workers for eight pages. Additional
test shards must be compared within a fixed aggregate CPU/RAM budget, using the
same passing duration profile and exact file/assertion identity parity. Never
infer a five-minute result from shard labels or theoretical worker scaling.
