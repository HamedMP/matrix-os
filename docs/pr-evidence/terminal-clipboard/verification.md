# Terminal Clipboard Verification Record

## Feature checks

- Focused Vitest matrix: 14 files, 281 tests passed.
- Packaged Electron Playwright journey: 1 test passed in 75.68 seconds.
- Desktop production package build: passed.
- TypeScript builds/typechecks for all workspace packages: passed.
- Pattern scanner: passed with zero violations.
- React Doctor: no new findings in the changed terminal components; remaining
  diagnostics are pre-existing project findings.
- New shared clipboard policy: 100% statements, branches, functions, and lines
  in the focused V8 coverage report.
- Feature source coverage run: all 281 tests passed. The repository-wide
  threshold still exits non-zero because the root coverage configuration adds
  every kernel, gateway, platform, and desktop renderer source file even when
  the command selects only this feature's tests.

## Repository baseline observed

The full `pnpm test` command was run. Feature tests passed within it, but the
shared runner produced unrelated failures and long timeouts in existing suites,
including coding-agent runtimes, app-runtime process management, CLI commands,
heartbeat/network probes, session-registry temporary-home setup, and source
control tests. After the Vitest worker processes exited, the command retained an
open terminal handle and was stopped. No unrelated baseline files were changed.

## Visual evidence

- `selection-copy-enabled.png`: multiline synthetic selection with Copy enabled.
- `passive-selection-stability.webm`: complete synthetic packaged-Electron
  journey, including ten seconds of passive pointer movement in an SGR
  mouse-aware session.
