# Quickstart: macOS Developer Experience

## Goal

Validate the planned terminal/editor architecture in the `088-macos-native-shell` worktree before implementation tasks are generated.

## Baseline Checks

```bash
swift test --package-path macos
bun run test
bun run typecheck
```

When React files change later, run the required React audit for the affected project directory:

```bash
npx react-doctor@latest shell
```

## Manual Spike Checklist

1. Launch the native app and sign in through the existing native auth callback.
2. Open a project workspace.
3. Open a SwiftTerm terminal, run an interactive program, switch tabs, and return.
4. Relaunch the app and verify terminal session recovery behavior.
5. Open several files in the current native editor and record missing editor affordances.
6. Spike Monaco in a local/offline WKWebView editor surface.
7. Keep CodeMirror as a lightweight editor/preview fallback and compare startup time, large file behavior, search, and theme integration.
8. Spike Ghostty/libghostty separately behind a terminal renderer boundary; do not replace SwiftTerm until build, lifecycle, rendering, input, resize, and packaging are proven.

## Ship Readiness

- Terminal and editor tests are written before implementation.
- Mutating file/session/language-service endpoints have body limits.
- User-controlled paths are validated within project roots.
- External calls have timeouts.
- No client-visible raw provider, filesystem, database, or Zod errors.
- Workspace layout restores useful references and marks stale resources as recoverable.
