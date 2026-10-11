# Benchmark E2E lane parity

The hosted general lane runs `test:e2e:run` before building Electron Desktop.
Thirty-four native-only files skip their whole suite unless Desktop main exists.
The full dedicated benchmark built Desktop first, enabling additional native
suites (including operator and Hermes) that hosted general CI never executes.
Its generic selection could also duplicate the required native regressions.

The benchmark now supplies exact exclusions for those 34 build-gated files to
both general passes and standalone general benchmarks. Browser-only files and
flag-gated files remain discoverable, including the eight other files under
`tests/e2e/desktop/`; no directory wildcard hides shared coverage. The exclusion
list is explicit, checked against the source suite gates, and needs review when
new build-gated files are added. This changes benchmark selection only; it does
not change application code, any E2E assertion, or hosted workflow selection.

The required Electron lane keeps the hosted workflow's exact 13 regression
paths, required flags, and separate native terminal grid command. Desktop still
builds once per cold/warm pass. General and Electron timings remain separately
reported. A generic general timing represents hosted general scope, rather than
all optional native E2E suites. Optional operator and Hermes native suites are
not part of this benchmark's required coverage and remain available separately.

## Validation

Tests first reproduced cold/warm native discovery and missing exact exclusions.
The contracts verify both full passes, standalone `e2e`/`e2e-general`, all 34
source gates, absence of broad exclusions, and unchanged ordered 13-file hosted
Electron selection. Existing failure propagation, two-pass collection, worker
budget, and isolation/artifact contracts remain required. Linux timing validation
must use the committed driver after the current benchmark completes; local mock
contracts establish selection and orchestration, not real browser performance.

Public testing-guide documentation is delivered in the companion
[FinnaAI/matrix-os-site PR #224](https://github.com/FinnaAI/matrix-os-site/pull/224),
including the dedicated benchmark's hosted-lane scope and optional native suites.
