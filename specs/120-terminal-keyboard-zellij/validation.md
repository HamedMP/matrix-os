# Terminal keyboard and Zellij validation

Validated on 2026-09-06 with Node 24.13.1, xterm 6, and Zellij 0.44.3.

## Automated checks

- Shared resolver and controller tests cover Mac line/word movement and deletion, history, split/focus/resize/maximize, remapping, conflicts, passthrough, composition, prefix modifier ordering, repeat suppression, target changes, failed saves and transport-refresh serialization.
- Web component tests exercise clipboard/paste privacy, focus/lease gating, session rename, sizing/zoom, existing layouts and Zellij action dispatch. Electron tests exercise the mounted terminal integration and authenticated transport.
- Gateway tests cover fixed CLI argv, managed generations, strict payload limits, safe errors, and Chat owner/binding/incarnation authorization before dispatch.
- Broad terminal regression run: 1,058 passed; one generated-wrapper smoke exceeded its old one-second subprocess deadline after emitting the expected output. Its isolated rerun passed; the deadline is now five seconds to tolerate concurrent test load. The final wrapper/installer subset passed 47 tests with those three installer smoke cases explicitly skipped.
- Three existing installer-to-interactive-Bash smoke cases timed out locally and were excluded from the final broad rerun. The install implementation is unchanged by this PR. No such test subprocesses remained after the run.
- Gateway, shared UI, and Web TypeScript checks passed. Electron TypeScript reports an existing unrelated `PostHog.shutdown` type error in `DesktopSupportWidget.tsx:503`.
- Scoped ESLint: zero errors, eleven existing warnings in the large Web terminal components.

## Real Zellij / PTY smoke

An isolated node-pty session used the generated Matrix Zellij configuration and production action-argument helper. Four Bash/readline assertions verified Command line-start/end, Option word movement, Option word deletion, and Command deletion to line start.

Fourteen pane actions passed semantic checks: two split geometries, all four focus directions, all four resize directions, maximize/restore, history top/bottom, and close. Scrolling verified the first and last markers from 120 numbered output lines. Temporary sessions, processes and runtime directories were removed.

## Rendered checks

The shared controls were rendered in an isolated browser preview at wide and 375-pixel widths, in light/dark colors. Split dispatch, edited shortcut saving, close confirmation/cancellation, and disconnected disabled state worked. The narrow control container had no horizontal overflow.

The separate public documentation change passed 51 site tests. Both affected Next.js pages rendered at 375, 768 and 1200 pixels without page-level horizontal overflow.

## Review and limits

Twelve review domains covered correctness, tests, maintainability, project standards, agent access, prior learnings, security, API contracts, reliability, adversarial cases, frontend races and performance. Five P2 findings were fixed and verified; no actionable findings remained.

The browser preview used an injected test transport; it was not a live authenticated Matrix runtime. Automated renderer integration and real Zellij/PTy tests are separate evidence. Full authenticated Web Canvas/Web Desktop and packaged Electron end-to-end tests, deployment, and merge are outside the completed local validation.

Rebased onto main at eb8b8e91e, including the verified Codex 0.153.4 compatibility update from #1546. Implementation PR: https://github.com/HamedMP/matrix-os/pull/1545. Public docs PR: https://github.com/FinnaAI/matrix-os-site/pull/78.

## Greptile follow-up

The Chat authorization result now carries the verified creation timestamp to the managed adapter. The adapter rejects a mismatched descriptor and dispatches only through the checked generation and immutable runtime name; concurrent display-name replacement cannot redirect the command. Unmanaged adapters fail closed for incarnation-bound actions.

Regression tests reproduce replacement between authorization and dispatch, verify immutable targeting after lookup, and verify the unmanaged fallback rejects dispatch. All 66 focused authorization, Chat wiring, action-route and managed-adapter tests pass.

## CI follow-up

The full CI run caught a native Node package-entrypoint failure: the new terminal keyboard export used a `.js` relative path in the source-only contracts package. It now uses the existing package import-map pattern. The native runtime regression was reproduced before the fix; all 220 contract tests and the contracts typecheck pass after it.

CI also caught the new broad Vitest UI alias shadowing the package's CSS subpath exports. Removed the alias so workspace package exports resolve normally. The existing Electron settings regression was reproduced before the fix; it and the terminal renderer/control suites pass afterward (107 tests across eight files).
