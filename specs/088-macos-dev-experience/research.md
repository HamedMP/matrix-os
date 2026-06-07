# Research: macOS Developer Experience

## Decision: Keep SwiftTerm for launch, spike Ghostty/libghostty next

**Rationale**: The current macOS app already has a SwiftTerm-backed `TerminalPanelView` and `TerminalSession` model that coalesces output, tracks reconnect/exited states, de-duplicates resize, and preserves terminal identity across tab switches. That is the safest launch baseline. Ghostty is the right long-term quality target because its architecture separates a native macOS UI from `libghostty`, with fast terminal emulation, font handling, and rendering behind a C-compatible API.

**Alternatives considered**:

- Replace SwiftTerm immediately with Ghostty/libghostty: rejected because `libghostty` integration, build packaging, API stability, Swift lifecycle ownership, and renderer embedding need a spike before becoming a launch dependency.
- Keep xterm.js in a WKWebView for native terminal panes: useful for web parity, but it will not reach the same native macOS feel as a direct AppKit/Metal terminal surface.
- Build a terminal parser/renderer from scratch: rejected. Terminal emulation correctness is a product in itself.

## Decision: Use Monaco for VS Code-class editing, CodeMirror for lightweight editing

**Rationale**: CodeMirror 6 is already present in the web preview-window code path and is a strong fit for lightweight previews, quick edits, markdown/source views, and constrained bundle size. Monaco is the better default for a "VS Code-level" coding workspace because it brings the editor model, worker architecture, keybinding surface, multi-cursor behavior, minimap, and language-service expectations closest to VS Code. The native app should host Monaco in a local/offline WKWebView editor surface, while keeping CodeMirror for lightweight shell file preview and fallback paths.

**Alternatives considered**:

- CodeMirror-only for all editing: rejected for the primary workspace because the requested bar is VS Code-class; recreating enough VS Code behavior around CodeMirror would push complexity into Matrix-owned code.
- Monaco everywhere: rejected for lightweight previews and small app surfaces where CodeMirror is simpler, faster to initialize, and already integrated.
- Native TextKit editor only: useful for small Swift-native edits, but too costly for language tooling, multi-language syntax, and VS Code-class expectations.

## Decision: Editor and terminal share Matrix-owned project/session contracts

**Rationale**: The macOS app must be one shell over Matrix-owned state. Terminal sessions, file revisions, project roots, and language service sessions should be resolved through gateway/native IPC contracts with owner-scoped validation. The UI may cache layout and recoverable references, but it must not become the canonical source of terminal or file state.

**Alternatives considered**:

- Local-only project metadata in the macOS app: rejected because it conflicts with Matrix OS data ownership and multi-shell parity.
- Direct filesystem access from the app as the primary path: acceptable only for explicitly local projects; customer runtime projects must use Matrix gateway contracts to preserve auth, audit, and ownership boundaries.

## Decision: Introduce explicit renderer/editor abstractions before swapping engines

**Rationale**: The current terminal and editor implementations are concrete. A narrow `TerminalRenderer` and `EditorEngine` boundary lets Matrix keep session lifecycle, safety checks, settings, telemetry, and recovery stable while experimenting with SwiftTerm, Ghostty/libghostty, CodeMirror, Monaco, and native TextKit surfaces.

**Alternatives considered**:

- Swap implementations in-place: rejected because terminal/editor state bugs are high-impact and hard to review.
- Abstract every UI pane up front: rejected. Only renderer/editor seams need abstraction now.

## Decision: Language tooling runs behind bounded, restartable services

**Rationale**: Language intelligence must never block editing or corrupt save state. LSP/project services should have explicit lifecycle, project scope, resource caps, safe error mapping, and restart behavior. The editor can show degraded state when services are unavailable.

**Alternatives considered**:

- Run language logic inside the WKWebView only: useful for TypeScript/Monaco defaults, but insufficient as the long-term cross-language project model.
- No language tooling in the native app: rejected because the target is a daily coding environment.
