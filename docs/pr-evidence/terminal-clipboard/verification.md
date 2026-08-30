# Terminal Clipboard Verification Record

## Feature checks

- Focused Vitest matrix after restacking onto current main: 15 files, 295 tests passed.
- Packaged Electron Playwright journey after restacking: 1 test passed in 53.70 seconds.
- Desktop production package build: passed.
- TypeScript builds/typechecks for all workspace packages: passed.
- Pattern scanner: passed with zero violations.
- React Doctor: no new findings in the changed terminal components; remaining
  diagnostics are pre-existing project findings.
- New shared clipboard policy: 100% statements, branches, functions, and lines
  in the focused V8 coverage report.
- Feature source coverage run: all 281 coverage-selected tests passed. The repository-wide
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

## Acceptance mapping

- SC-001 and SC-005: shortcut classifier, native/web component suites, and the
  packaged Electron journey cover exact Copy parity and exactly-once Paste.
- SC-002: the packaged journey performs 50 consecutive single-line, multiline,
  wrapped, Unicode, and Select All context-menu trials.
- SC-003: the packaged SGR any-motion journey retains selection for at least ten
  seconds; plain-shell behavior is covered by the same xterm path.
- SC-004: renderer tests cover native Canvas scales 0.5, 1, and 2 and web Canvas
  scales 0.25, 0.5, 1, 1.5, and 3, plus fitted zoom and Desktop layouts.
- SC-006: denial, stale ownership, unmount, zero-write, privacy, and exactly-once
  retry paths are covered in both renderers.
- SC-007: the deterministic first-attempt proxy is the zero-failure 50-trial
  packaged journey. Representative-user research remains a post-release product
  measurement rather than a local automated-test assertion.
