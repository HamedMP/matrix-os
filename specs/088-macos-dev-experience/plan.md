# Implementation Plan: macOS Developer Experience

**Branch**: `088-macos-native-shell` | **Date**: 2026-06-07 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `specs/088-macos-dev-experience/spec.md`

## Summary

Build a world-class developer workspace in the Matrix OS macOS app by hardening the existing SwiftTerm terminal path, adding explicit renderer/editor boundaries, using Monaco as the target engine for the VS Code-class editor surface, retaining CodeMirror for lightweight preview/editing, and planning a Ghostty/libghostty terminal spike before any renderer replacement. The workspace keeps Matrix-owned terminal, file, language-service, and layout state as the source of truth while the native app provides polished macOS windows, menus, commands, and AppKit bridges.

## Technical Context

**Language/Version**: Swift 6 / SwiftUI / AppKit for `macos/`; TypeScript 5.5+ strict, Node.js 24+, React 19, Next.js 16, Hono gateway for shared shell/backend surfaces  
**Primary Dependencies**: Existing SwiftTerm macOS terminal dependency, WKWebView/AppKit bridges, existing `@xterm/xterm` web terminal path, existing CodeMirror preview-window path, planned Monaco spike for native editor WKWebView, planned Ghostty/libghostty spike  
**Storage**: Owner-controlled Matrix runtime stores: Postgres/Kysely for canonical workspace/app data where applicable; files for identity/config/layout exports; no new embedded database or ORM  
**Testing**: SwiftPM tests for macOS modules, Vitest for gateway/shell contracts, Playwright for shell-visible editor/terminal smoke tests, react-doctor for React changes  
**Target Platform**: macOS 14+ native app plus Matrix gateway/web shell compatibility  
**Project Type**: Monorepo feature across native macOS app, gateway contracts, and shell editor/terminal reuse  
**Performance Goals**: Terminal input echo under 50 ms p95 on healthy runtime connection; editor opens supported files under 2 MB in under 1 second after content receipt; terminal output remains responsive under bursty agent/zellij output  
**Constraints**: Canvas/headless Matrix source of truth, no raw client errors, bounded terminal/editor buffers, no direct unvalidated path access, no blocking language tooling on editor input  
**Scale/Scope**: One native user workspace can hold multiple terminal/editor surfaces; terminal caps must respect existing gateway limits unless changed with tests; language services are project-scoped and bounded

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
| --- | --- | --- |
| Data Belongs to Its Owner | PASS | Workspace layout stores recoverable references only; terminal sessions, file content, and project data remain owner-scoped through Matrix runtime contracts. |
| AI Is the Kernel | PASS | The workspace exposes agent and terminal surfaces without moving AI orchestration into local-only app state. |
| Headless Core, Multi-Shell | PASS | Native macOS is one renderer over shared terminal/file/language contracts also usable by web/mobile/CLI shells. |
| Defense in Depth | PASS WITH REQUIRED TASKS | File paths, terminal frames, language sessions, and command payloads need boundary validation, body limits, resource caps, and generic error mapping. |
| TDD | PASS WITH REQUIRED TASKS | Implementation must start with failing terminal lifecycle, editor conflict, renderer boundary, and route/frame validation tests. |
| Quality Over Shortcuts | PASS | Reuses proven terminal/editor engines; no custom terminal parser or code editor core. |
| Worktree/PR/Greptile | PASS | Work is in manual worktree `matrix-os-088-macos-native-shell`; later implementation must ship by PR and reach Greptile 5/5. |

## Project Structure

### Documentation (this feature)

```text
specs/088-macos-dev-experience/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── checklists/
│   └── requirements.md
└── contracts/
    └── macos-dev-workspace-contracts.md
```

### Source Code (repository root)

```text
macos/
├── Sources/
│   ├── App/
│   │   ├── WebShellView.swift
│   │   ├── SyntaxHighlightedCodeEditor.swift
│   │   └── [planned editor host / workspace command surfaces]
│   ├── Terminal/
│   │   ├── TerminalSession.swift
│   │   ├── TerminalPanelView.swift
│   │   └── [planned terminal renderer abstraction]
│   └── Net/
│       └── [planned file/editor/language service clients]
└── Tests/
    ├── TerminalTests/
    ├── NetTests/
    └── [planned editor/workspace tests]

packages/gateway/
├── src/
│   ├── terminal/
│   ├── files/
│   └── [planned language-service/workspace command contracts]
└── tests/

shell/
├── src/components/terminal/
├── src/components/preview-window/CodeEditor.tsx
└── [planned Monaco/CodeMirror shared editor decisions where web reuse applies]
```

**Structure Decision**: Keep native workspace behavior in `macos/`, keep canonical file/session/language-service contracts in `packages/gateway/`, and reuse shell editor/terminal components only where a web surface is the right engine. The macOS app should own native windows, menus, settings, commands, and AppKit bridges.

## Phase 0: Research

See [research.md](./research.md). Key decisions:

- SwiftTerm remains the launch-safe terminal renderer.
- Ghostty/libghostty is the long-term terminal target after a focused spike.
- CodeMirror remains valid for lightweight preview/editing.
- Monaco is the target for the VS Code-class workspace editor.
- Renderer/editor boundaries come before engine swaps.
- Language tooling is bounded, restartable, and non-blocking.

## Phase 1: Design & Contracts

See [data-model.md](./data-model.md) and [contracts/macos-dev-workspace-contracts.md](./contracts/macos-dev-workspace-contracts.md).

### Implementation Tracks

1. **Terminal Foundation**
   - Add a narrow terminal renderer abstraction around existing SwiftTerm.
   - Add tests for session identity, reconnect state, resize de-duplication, output coalescing, and close/detach semantics.
   - Keep xterm.js web terminal parity through existing gateway session contracts.

2. **Ghostty Spike**
   - Build a throwaway Swift/AppKit bridge that links or embeds the smallest viable Ghostty/libghostty surface.
   - Prove input, output, resize, font/theme, scrollback, search feasibility, build packaging, and license obligations.
   - Promote only after spike tests and manual rendering checks pass.

3. **Editor Foundation**
   - Preserve current native TextKit editor and CodeMirror web preview roles.
   - Define an editor engine boundary that can host CodeMirror, Monaco, or native TextKit without changing file lifecycle state.
   - Add conflict-aware save states and tests before expanding editor features.

4. **Monaco Spike**
   - Host Monaco in a local/offline WKWebView with workers functioning under app packaging.
   - Prove file load/save bridge, theme sync, keybindings, find/replace, multi-file tabs, and language-service integration.
   - Keep CodeMirror as fallback for lightweight previews and lower-cost app surfaces.

5. **Workspace Integration**
   - Persist project workspace layout and recoverable references.
   - Expand command palette commands for open file, focus terminal, run command, start agent, and show diagnostics.
   - Add safe stale-resource recovery for missing sessions/files.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| Multiple editor engines during transition | Needed to keep current lightweight CodeMirror/TextKit flows while proving Monaco | A single immediate swap would risk breaking file preview/editing before the Monaco package/runtime spike is proven. |
| Multiple terminal renderers during transition | Needed to keep SwiftTerm launch stability while proving Ghostty/libghostty | Replacing SwiftTerm directly would couple release risk to an unproven native renderer integration. |

## Post-Design Constitution Check

| Principle | Status | Notes |
| --- | --- | --- |
| Data Belongs to Its Owner | PASS | Design stores layout/references locally only where appropriate; canonical terminal/file state remains owner-scoped. |
| Headless Core, Multi-Shell | PASS | Contracts are shell-agnostic and preserve web/mobile/CLI parity. |
| Defense in Depth | PASS WITH TASK REQUIREMENTS | Contracts identify auth, validation, body limits, frame schemas, caps, and error policy. |
| TDD | PASS WITH TASK REQUIREMENTS | Each implementation track starts with focused failing tests. |
| Quality Over Shortcuts | PASS | Proven engines are used for terminal/editor cores; custom core implementations are explicitly rejected. |

## Next Tasks To Generate

1. Terminal renderer protocol and SwiftTerm adapter tests.
2. Terminal lifecycle hardening tests for resume/detach/end/reconnect.
3. File editor state model tests for dirty/conflict/save/revert.
4. Editor engine protocol with current native editor adapter.
5. Monaco WKWebView spike behind a feature flag.
6. Ghostty/libghostty spike in a throwaway target or separate spike branch.
7. Gateway file save contract hardening with body limits, path validation, and revision checks.
8. Workspace layout persistence and stale reference recovery tests.
9. Command palette command registry for editor/terminal actions.
10. Docs update under `www/content/docs/` after implementation.
