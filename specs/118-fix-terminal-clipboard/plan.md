# Implementation Plan: Reliable Terminal Clipboard and Selection

**Branch**: `118-fix-terminal-clipboard` | **Date**: 2026-08-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/118-fix-terminal-clipboard/spec.md`

## Summary

Make terminal selection and clipboard actions deterministic in the native Electron desktop and the shared web terminal used by Canvas and compatibility Desktop. The implementation will treat xterm's logical selection as the sole source of truth, classify terminal-owned shortcuts through a shared pure policy, capture right-click before xterm can replace the range, and shield a completed selection from passive mouse reports emitted by mouse-aware TUIs. Copy and paste will return typed outcomes, remain pane-local, preserve existing image paste behavior, and expose only generic failure feedback.

## Technical Context

**Language/Version**: TypeScript 5.9 strict ES modules; React 19; Node.js 24+ build/runtime tooling
**Primary Dependencies**: `@xterm/xterm` 6.0.0, Electron 41, Next.js 16 shell, existing Matrix terminal link/context-menu helpers, `@matrix-os/contracts`
**Storage**: N/A; selection, context-menu snapshots, and clipboard operation state are transient and must not be persisted
**Testing**: Vitest 4, React Testing Library, Playwright Electron E2E, shell browser/component tests, manual macOS acceptance
**Target Platform**: Native Matrix Electron Canvas/Desktop on macOS as the reported surface; Matrix Web Canvas/Desktop; regression coverage for existing Windows/Linux shortcuts
**Project Type**: Multi-surface React frontend with a shared pure contracts package
**Performance Goals**: Handled clipboard feedback within one second; no per-pointer-move React state updates; retain responsive 60 fps pointer behavior at interactive Canvas zoom levels
**Constraints**: Clipboard text never enters telemetry, persistence, or error messages; no duplicate paste writes; preserve existing image paste; use public xterm APIs; do not disrupt non-terminal shortcuts or TUI mouse reporting when no selection exists
**Scale/Scope**: Multiple simultaneous panes/windows; native scrollback of 5,000 lines and web scrollback of 10,000 lines; native Canvas zoom 0.5–2; interactive web Canvas zoom 0.25–3 plus preservation across preview zoom transitions

## Constitution Check

*GATE: Passed before Phase 0 research. Re-checked after Phase 1 design below.*

| Principle | Gate result |
|---|---|
| I. Data Belongs to Its Owner | PASS — clipboard and selection data remain ephemeral in the renderer and are never persisted, synchronized, logged, or emitted to analytics. |
| II. AI Is the Kernel | PASS — this shell interaction fix does not alter agent execution, routing, prompts, or session persistence. |
| III. Headless Core, Multi-Shell | PASS — the terminal transport remains headless and unchanged; native Electron and web Canvas/Desktop renderers implement one shared interaction contract. |
| IV. Self-Healing and Self-Expanding | PASS — the event-ordering regression and the previous mock blind spot are captured as durable automated tests; no protected state or runtime self-patching path changes. |
| V. Quality Over Shortcuts | PASS — the design covers exact selection fidelity, focus, errors, rich-paste preservation, real-xterm E2E, Canvas zoom, and visual evidence rather than a shortcut-only patch. |
| VI. App Ecosystem | PASS — no app manifest, permission, sandbox, install, or app-data contract changes. |
| VII. Multi-Tenancy | PASS — the existing owner-authenticated terminal session boundary is unchanged; selection and clipboard state cannot cross panes, sessions, users, or organizations. |
| VIII. Defense in Depth | PASS — clipboard APIs are treated as a failing trust boundary, outcomes are explicit, error copy is allowlisted/generic, and terminal content is excluded from logs. No endpoint, WebSocket, IPC, or file-I/O contract is added. Existing authenticated terminal transports and bounded paste/upload paths remain unchanged. |
| IX. Test-Driven Development | PASS — shared policy, renderer regression, real-xterm E2E, failure, multi-pane, and zoom tests are written red before behavior changes. |
| X. Worktree, PR, and Greptile 5/5 | PASS — work is in the persistent manual feature worktree; delivery requires a conventional PR, frozen review range, CI, and Greptile 5/5 before merge. |
| Delivery and documentation | PASS — implementation ships from the existing manual worktree via conventional PR; user documentation ships as a separate private docs-repository PR. |

## Project Structure

### Documentation (this feature)

```text
specs/118-fix-terminal-clipboard/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── terminal-clipboard-interactions.md
├── checklists/
│   └── requirements.md
└── tasks.md                              # Created later by /speckit.tasks
```

### Source Code (repository root)

```text
packages/contracts/
├── package.json                          # Add package-local terminal clipboard import
└── src/
    ├── index.ts                          # Export the shared policy
    └── terminal-clipboard.ts             # Pure shortcut and pointer-routing decisions

desktop/src/
├── main/platform/menu-template.ts        # Preserve standard non-terminal Edit behavior
└── renderer/src/features/terminal/
    ├── TerminalView.tsx                  # Native xterm ownership and event routing
    ├── TerminalLinkContextMenu.tsx       # Terminal Copy/Select All and focus restoration
    ├── terminal-link-actions.ts          # Typed copy result and safe fallback
    └── terminal-rich-paste.ts            # Existing image/text paste path reused by shortcuts

desktop/src/renderer/src/features/
├── desktop-shell/DesktopSurfaceFrame.tsx # Native Canvas scale source
├── mission-control/TabContent.tsx         # Forward scale to terminal surfaces
└── terminal/TerminalsTab.tsx              # Forward scale to retained terminal views

shell/src/components/terminal/
├── TerminalPane.tsx                      # Web Canvas/Desktop xterm event routing
├── TerminalLinkContextMenu.tsx           # General terminal menu plus optional link actions
└── terminal-rich-paste.ts                 # Typed, exactly-once paste result

tests/
├── contracts/terminal-clipboard.test.ts
├── desktop/
│   ├── terminal-view.test.tsx
│   ├── terminal-link-actions.test.ts
│   ├── terminal-link-context-menu.test.tsx
│   ├── native-desktop-shell.test.tsx
│   └── terminals-tab.test.tsx
├── shell/
│   ├── terminal-pane-clipboard.test.tsx
│   ├── terminal-pane-zoom-correction.test.ts
│   └── terminal-link-context-menu.test.tsx
└── e2e/desktop/terminal-clipboard.e2e.test.ts
```

**Structure Decision**: Keep one shared DOM-independent policy in the existing contracts package because native Desktop and the web shell currently drift on the same shortcuts and xterm event rules. Renderer components keep platform-specific clipboard, image upload, focus, menu, and transport behavior. No new package, service, endpoint, persistence layer, or global terminal registry is introduced.

## Phase 0: Research Decisions

Research and alternatives are recorded in [research.md](./research.md). The decisive findings are:

1. xterm 6 defaults `rightClickSelectsWord` to true on macOS and mutates the selection in its child `contextmenu` listener before Matrix's current bubble listener snapshots it.
2. xterm labels passive SGR mouse reports as user input; its selection service clears completed drag and Select All ranges when Codex or another mouse-aware TUI receives pointer motion.
3. Native Desktop supports only unshifted Command+C and Ctrl+Shift+C. The web terminal supports only Ctrl+Shift+C/V and clears a copied selection before clipboard success.
4. Native Electron Canvas/Desktop and Web Canvas/Desktop are separate validation surfaces. Electron owns `TerminalView`; the two web layouts share `TerminalPane`. Native Canvas currently computes `visualScale` but does not forward it through terminal tab/view paths.
5. The earlier partial desktop copy fix tested a mocked host-level event and therefore missed xterm's earlier child listener and mouse-report side effects.

## Phase 1: Design

### Requirement traceability

| Requirement group | Design owner | Verification layer |
|---|---|---|
| FR-001–FR-005, FR-019: exact shortcuts and terminal precedence | Shared command classifier plus focused renderer executor | Contract tests, native/web component tests, native-menu regression, Electron E2E |
| FR-006–FR-008, FR-011–FR-012: exact selection, right-click, Select All | Xterm-owned selection plus capture-phase immutable menu snapshot | Realistic xterm mock, context-menu tests, wrapped/Unicode E2E |
| FR-009–FR-010: stable selection and normal TUI mouse behavior | Selection-aware capture shield | Pure pointer policy, SGR movement component test, real-xterm E2E |
| FR-013–FR-015: renderer, zoom, and pane parity | Native/web scale wiring and pane/session generation guards | Native Canvas 0.5–2, web Canvas 0.25–3, both Desktop modes, multi-pane tests |
| FR-016–FR-018: safe clipboard failures and privacy | Typed outcomes, generic feedback, zero-write failure paths | Clipboard rejection/absence/stale-target tests and log/UI assertions |
| FR-020: automated regression breadth | Layered TDD and explicit post-build E2E CI invocation | Targeted Vitest, Electron Playwright, full gates, React audits |

### Shared interaction policy

Add a pure policy module to `@matrix-os/contracts` that accepts a small DOM-independent key or pointer description and returns a typed decision. It will recognize exact terminal-owned copy, paste, and Select All combinations; reject repeats and unrelated modifiers; and decide whether a pointer event must be shielded while a completed selection exists. The policy contains no clipboard text, browser globals, xterm instance, React state, or transport.

The active renderer executes the decision against its own xterm. Keyboard and context-menu Copy snapshot `terminal.getSelection()` once and never clear it as part of copying. Select All delegates to `terminal.selectAll()`. Text Paste uses xterm's public `paste()` path or the renderer's existing bounded rich-paste path, captures the initiating pane/session before asynchronous clipboard reads, and writes exactly once only if that target is still valid. Existing image-paste upload behavior is routed through the same platform-specific executor rather than being disabled by the new Command+V handler.

### Context-menu ordering and focus

Both xterm constructors explicitly set `rightClickSelectsWord: false`. A capture-phase host listener handles secondary-button/context-menu events before xterm's own listener, preserves the exact current xterm selection, resolves an optional terminal link, and opens the existing menu at raw viewport coordinates. The menu owns an immutable, pane-local snapshot until action or dismissal. Copy enablement derives from that snapshot, while Select All calls the originating terminal. Closing, Escape, light dismiss, or completing an action restores focus only if the originating terminal is still mounted and active.

Canvas scale is wired to terminal surfaces in the native renderer as well as the existing web renderer. Pointer correction synthesizes only the xterm cell events that need transformed-cell correction. Context-menu placement and proportional link hit testing stay in viewport coordinates so they are not unscaled twice. Tests cover native zoom 0.5, 1, and 2; web interactive zoom 0.25, 0.5, 1, 1.5, and 3; and prove that zoom changes do not recreate xterm or redirect actions to another pane.

### Selection protection and TUI mouse behavior

When xterm has a completed selection, a capture-phase event shield stops no-button passive `mousemove` and secondary-button down/up reports before xterm can forward them as TUI user input and clear the selection. Left-button actions, typing, paste, buffer changes, and deliberate new selections continue to use normal xterm behavior. As soon as the selection is absent, all mouse reports pass through unchanged, satisfying mouse-aware application behavior without patching xterm internals or reconstructing fragile wrapped/Unicode ranges.

### Clipboard outcomes and privacy

Renderer helpers return a bounded result such as `success`, `empty`, `unavailable`, `stale-target`, or `failed`; they do not silently swallow a rejection. User feedback is generic (for example, “Copy failed. Try again.”), rendered in the existing terminal status/error region, and does not contain selected text, clipboard text, filenames, filesystem paths, provider details, or raw errors. Diagnostic logging is limited to a fixed operation/error category. A failed copy keeps the selection; a failed or stale paste writes nothing.

### Integration wiring

Startup and ownership remain local:

1. A terminal renderer creates xterm with the explicit options.
2. It registers capture-phase pointer/context-menu protection, then the shared shortcut handler, link provider, selection observation, and existing transport attachment.
3. The focused renderer classifies and executes a command against its own xterm and captured transport generation.
4. Copy talks only to the local clipboard adapter. Paste emits through the existing authenticated terminal connection or existing bounded image-upload endpoint.
5. Cleanup removes every listener, invalidates pending operation generations, clears transient menu/error state, disposes xterm/add-ons, and restores no stale focus.

There is no new auth matrix because no new route, WebSocket message, IPC command, or file operation is introduced. Existing terminal session authorization, input framing, upload validation/body limits, and timeouts stay authoritative and must remain covered by their current tests.

### Failure modes and resource management

- Clipboard permission denial or API absence returns a typed failure, preserves selection, and inserts nothing.
- A pane that closes, changes session, or loses ownership during an asynchronous read invalidates the operation; the result is discarded without writing to a replacement pane.
- A disconnected terminal transport makes paste fail safely before a write; retries create one new operation rather than replaying the old one.
- Context-menu dismissal clears its text snapshot immediately. No clipboard/selection registry, queue, timer, `Map`, or `Set` is introduced.
- Unmount removes capture listeners and cancels or invalidates pending UI work so a detached terminal is never focused or mutated.
- Buffer trim, resize, or terminal buffer switches may invalidate a selection through normal xterm behavior; the host does not reconstruct stale coordinates.

### Test-first implementation sequence

1. Add failing contract tests for exact shortcuts, repeat/modifier rejection, and pointer shielding.
2. Upgrade fake xterm behavior so right-click and passive SGR movement reproduce xterm's real ordering; add failing native and web renderer tests.
3. Add failing copy/paste outcome, safe-error, context snapshot, focus, multi-pane, Select All, and Canvas zoom tests.
4. Add the real Electron E2E journey and ensure CI explicitly runs it after the desktop build instead of allowing a missing build to skip it.
5. Implement the smallest shared policy and renderer changes, then refactor duplication while all regression tests remain green.
6. Run the full quality gates, React audits for both changed projects, macOS smoke matrix, and capture screenshot/recording evidence before review.

## Post-Design Constitution Check

PASS. Phase 1 adds no persistence, endpoint, unbounded resource, provider dependency, prompt behavior, or hidden cross-package global. Clipboard input is bounded by existing terminal paste limits; private content remains renderer-local; asynchronous pane ownership and cleanup are explicit; failure feedback is safe; and tests precede each production change. The plan remains within one cohesive code PR under the repository size limits, plus the constitution-required separate private documentation PR.

## Complexity Tracking

No constitution violations require justification.
