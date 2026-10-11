# Clipboard display isolation in the CI benchmark

The UTF-8 Linux image's required Electron cold run passed 47 cases, failed one
clipboard edge-scroll case, and retained two existing macOS-only skips. The
failed assertion expected `MOUSE-EDGE-SCROLL-070`; captured selection started at
076. This is a measured failure, not proof of a particular focus/timer cause.

Hosted CI runs `terminal-clipboard.e2e.test.ts` alone in its own `xvfb-run`
invocation (`.github/workflows/ci.yml`, required clipboard step). The benchmark
combined all 13 required files with two Vitest workers under one display.
Production selection code registers a window-blur handler that cancels the
gesture, stops its 40 ms edge-scroll interval, and releases its listeners. A
competing Electron window can therefore interfere with a held drag. Actual
focus/visibility/timer diagnostics are still needed to attribute the observed
failure precisely; this layer restores the verified hosted clipboard boundary.

## Change and invariants

Each cold/warm pass runs the existing common 12 files with two workers, followed
by clipboard alone with one worker and a fresh `xvfb-run --auto-servernum`
invocation. Clipboard retains `MATRIX_DESKTOP_E2E_REQUIRED=1`. The common group
retains its existing required/provider flags. No Electron launch flags,
production selection behavior, E2E assertions, dwell times, or timeouts change.

The exact required 13-file union is preserved once per pass, alongside the
existing six-case terminal-grid suite. Other common-file display boundaries
remain grouped and are not claimed to match every hosted step. The full
eight-core budget remains four unit workers plus two check workers; this layer
does not change that allocation or Desktop build reuse.

`e2e-electron-{cold,warm}` measures the common group and the new
`e2e-clipboard-{cold,warm}` measures clipboard separately. Every group and both
passes continue after a failure so timings remain available, then failures
propagate to the benchmark exit status. No additional artifact allowlist or
host credential access is introduced.

## Validation and delivery

TDD shell-harness contracts first reproduced missing isolated clipboard calls
and timing records. They exercise actual benchmark execution, record each
display invocation, verify exact common/clipboard membership and worker caps,
preserve the hosted required-file union and grid calls, and require clipboard
failures to fail both full and standalone benchmarks after both complete passes.
All 64 focused runner/bridge/controller contracts passed locally, including 23
benchmark contracts; standalone strict NodeNext TypeScript, shell syntax, and
diff checks passed.

After independent review, rebuild only the trusted benchmark image layer and
run the same required Electron cold/warm files on the isolated Linux host.
Report those actual results before claiming the flaky case resolved. The
engineering-handbook companion documentation is tracked in
[FinnaAI/matrix-os-site PR #224](https://github.com/FinnaAI/matrix-os-site/pull/224).
