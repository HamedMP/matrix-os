# Phase 0 Research: Reliable Terminal Clipboard and Selection

## Scope and evidence

The repository has two separate xterm owners and four required validation surfaces:

- Native Electron Canvas and Desktop: `desktop/src/renderer/src/features/terminal/TerminalView.tsx`
- Web Canvas: `shell/src/components/terminal/TerminalPane.tsx` rendered through `CanvasWindow`
- Web Desktop: the same `TerminalPane` rendered through the compatibility Desktop path

The user's “desktop app” symptoms match the native Electron implementation exactly, while the feature specification also requires Canvas/Desktop shell parity. Both implementations must change.

## Decision 1: Use xterm selection as the sole authority

**Decision**: Read selection only through xterm's public `hasSelection()`, `getSelection()`, `getSelectionPosition()`, `selectAll()`, and selection-change APIs.

**Rationale**: xterm already handles scrollback, wrapped lines, Unicode/wide cells, non-breaking-space normalization, and platform line boundaries. Shell-level Edit handlers currently use DOM selection or `execCommand`, which do not represent xterm's logical range, particularly under the WebGL renderer.

**Alternatives rejected**:

- `window.getSelection()`: does not reliably contain xterm's logical selection.
- Reconstructing text from buffer cells: duplicates xterm behavior and is error-prone for wrapping and Unicode.
- A global selection registry: adds stale ownership and lifecycle problems when pane-local xterm already owns the source of truth.

## Decision 2: Prevent right-click mutation before xterm sees it

**Decision**: Set `rightClickSelectsWord: false` and register terminal context-menu/secondary-button protection in capture phase. Snapshot the complete selection before opening the Matrix menu.

**Rationale**: xterm 6 defaults `rightClickSelectsWord` to true on macOS. Its child `contextmenu` listener calls its word-selection logic before Matrix's current bubble-phase host listener. Matrix then correctly copies the already-wrong one-word range, or observes no selection and disables Copy. The native regression came from commit `845c5c640`, whose mocked test dispatched on the host and never modeled xterm's earlier child listener.

**Alternatives rejected**:

- Snapshotting later in the current bubble listener: the range is already mutated.
- Restoring the previous selection after the menu opens: causes visible flicker and requires fragile coordinate reconstruction.
- Relying on the operating-system Edit menu: native menu enablement and DOM selection are not authoritative for xterm.

## Decision 3: Shield selected text from passive TUI mouse reports

**Decision**: While a completed xterm selection exists, intercept no-button pointer movement and secondary-button reports before xterm forwards them to the mouse-aware application. Forward events normally whenever no selection exists.

**Rationale**: In SGR/ANY-motion mode, xterm forwards passive `mousemove` as input and fires `onUserInput`; its selection service clears every active selection on that signal. The same applies to a right-button mousedown before `contextmenu`. This exactly explains Select All or drag selection disappearing when the pointer moves in Codex.

**Alternatives rejected**:

- Restore the range after every mouse report: wrapped/wide characters, resize, scrollback trimming, and alternate-buffer transitions make reconstruction unsafe and may flicker.
- Suppress all TUI mouse events: violates normal application behavior when no selection is active.
- Patch/fork xterm's `onUserInput` behavior: broad, upgrade-hostile, and risks changing keyboard/paste semantics.

**Accepted tradeoff**: Passive hover and secondary-click reports pause only while the user has a completed selection. They resume immediately after a deliberate action clears or replaces it.

## Decision 4: Share only deterministic policy

**Decision**: Add `packages/contracts/src/terminal-clipboard.ts` for pure shortcut classification and pointer-routing decisions. Keep execution in each renderer.

**Rationale**: Native and web implementations have already drifted: native recognizes only unshifted Command+C and Ctrl+Shift+C; web recognizes only Ctrl+Shift+C/V. Both depend on `@matrix-os/contracts`, which already contains the analogous pure terminal-link contract. A shared policy prevents another platform divergence without coupling renderers.

**Alternatives rejected**:

- Duplicate conditionals: smallest initial diff but preserves the cause of cross-shell drift.
- Put Clipboard API or xterm objects in contracts: violates package boundaries and makes the module environment-dependent.
- Create a new package: unnecessary for one compact pure policy.

## Decision 5: Make renderer clipboard execution explicit and pane-local

**Decision**: Exact handled shortcuts are Command+C, Command+Shift+C, Command+V, Command+A on macOS and the currently supported Ctrl+Shift+C/V combinations on other platforms. Ignore repeats and unrelated modifier combinations. Snapshot the initiating terminal/session, prevent competing handling only for a recognized action, and return a typed operation outcome.

**Rationale**: Native lacks Command+Shift+C and explicit Command+V. Web clears selection before copy succeeds. Async clipboard reads can otherwise settle after a different pane becomes active. xterm's public `paste()` provides normalized, bracket-aware, exactly-once terminal input; existing renderer-rich image paths must remain reachable.

**Alternatives rejected**:

- Depend solely on generic browser/Electron paste: it is focus-sensitive and is the behavior reported as broken.
- Clear selection after successful copy: the specification requires visible selection to remain usable and failure to be retryable.
- Allow key repeats: risks duplicated paste and violates exactly-once behavior.

## Decision 6: Preserve rich image paste without expanding scope

**Decision**: Refactor each renderer's existing paste executor so explicit Command+V can inspect supported clipboard items, route images through the existing bounded upload path, and otherwise paste text once. The `paste` event remains supported; one user action must claim only one route.

**Rationale**: The feature concerns text paste but explicitly requires preserving established rich/image behavior. Preventing the default key event without executing the image branch would be a regression. No new endpoint or clipboard format is needed.

**Alternatives rejected**:

- Text-only interception: would make image-only clipboard paste stop working.
- New cross-renderer upload service: the two surfaces already have valid platform-specific execution paths.

## Decision 7: Keep coordinate spaces explicit at Canvas zoom

**Decision**: Forward native Canvas `visualScale` through `TabContent` and `TerminalsTab` into `TerminalView`, and retain the web renderer's transformed pointer correction for xterm cell events. Keep context-menu placement and proportional link hit testing in raw viewport coordinates. Test native zoom 0.5, 1, and 2; web interactive zoom 0.25, 0.5, 1, 1.5, and 3; plus selection preservation when web Canvas passes through the below-0.25 preview state.

**Rationale**: Native Canvas scales 0.5–2 and already calculates `visualScale`, but terminal tab branches currently drop it. Web Canvas supports 0.1–3, with values below 0.25 using a non-interactive preview. Blindly applying pointer correction to `contextmenu` would double-unscale menu/link coordinates. Transform changes must not recreate xterm or lose its selection.

## Decision 8: Use layered tests, including real xterm ordering

**Decision**: Start with pure policy tests, then renderer tests whose fake xterm installs a child listener that reproduces right-click mutation and passive SGR clearing, then a packaged Electron Playwright journey using the native clipboard.

**Rationale**: Existing tests assert a host-level mocked selection and therefore pass despite the real event-ordering defect. Some Electron E2E suites can skip if the desktop build is missing, so CI must explicitly execute the new test after building.

**Alternatives rejected**:

- Unit mocks only: cannot prove listener ordering, native clipboard integration, or real xterm behavior.
- Manual macOS testing only: useful as final smoke evidence but not durable regression protection.

## Security and operational findings

- No new HTTP, WebSocket, IPC, database, or file-I/O interface is required.
- Existing terminal input authorization and image-upload validation/body/time limits remain unchanged.
- Selected and clipboard text must never appear in telemetry, logs, screenshots with real user data, or error messages.
- Context-menu snapshots must be discarded on close/unmount; pending clipboard work must be invalidated when its originating pane/session is gone.
- Generic failure categories may be logged, but raw browser/provider errors and copied content may not be shown to clients.

## Documentation decision

After implementation and validation, open a separate PR in the private `FinnaAI/matrix-os-site` documentation repository under `content/docs/`. Document the supported shortcuts, Select All, right-click behavior, and the temporary pause in TUI mouse reporting while text is selected. Do not place product documentation in the Matrix OS code PR.
