---
status: active
---
# Shared terminal keyboard and Zellij panes

Implement the user-approved Mac editing/navigation shortcuts and Zellij-owned pane controls across Web Canvas, Web Desktop, and Electron Desktop. Preserve existing terminal sessions and saved legacy multi-session layouts; new pane actions operate inside the focused session. xterm remains the renderer.

## Contracts

`TerminalPaneAction`: discriminated `type`: split(direction right/down), focus(direction left/right/up/down), resize(direction left/right/up/down), fullscreen, scroll(edge top/bottom), close. Endpoint `POST /api/terminal/sessions/:name/pane-actions`, with the existing shell-route mount/auth source verified during implementation. Frontends use their existing authenticated client/gateway origin. Server validates session and payload, scopes actions to that session, uses bounded existing command runner; no shell interpolation.

`TerminalKeyboardPreferences`: profile `mac` | `standard` | `passthrough`, default mac; bounded optional command shortcut overrides. Persist in existing owner-controlled global shell preference file, exposed by existing preferences APIs. Shared UI renders editable bindings and pane toolbar. Shortcuts consumed only when terminal focused, ignore IME/composition; prevent browser defaults and duplicate PTY input. Repeated split/close/toggle actions suppressed. mac word/line editing must reach shell through Zellij; no inference of focused application from outer alternate-screen state.

## Implementation units

### U1 Gateway pane actions and Zellij keymap
Goal: validated actions execute through Zellij including user-systemd adapter; preserve word-editing keys and provide pane discovery/focus correctness.
Files: packages/gateway/src/shell/{zellij.ts,user-systemd-zellij-adapter.ts,routes.ts,zellij-config.ts,preferences.ts}, extracted pane-action helpers, relevant gateway tests.
Approach: extend existing adapter/routes with a bounded discriminated action; verify session through registry; preserve auth and safe errors. Configure Zellij so Alt arrows/b/f/backspace and line editing pass through in normal/locked modes; retain deliberate prefix access.
Execution note: test-first.
Test scenarios: action args; malformed/oversized bodies and invalid sessions; unavailable backend; failure propagation; managed generation delegation; keybinding collision prevention and preferences validation.
Verification: targeted Vitest gateway suites, real installed Zellij CLI/config smoke.

### U2 Shared contracts, controller, toolbar and shortcut settings
Goal: one keybinding resolver, event lifecycle and settings UI consumed by renderers.
Files: packages/contracts/src/terminal-keyboard.ts, packages/contracts/src/index.ts; packages/ui/src/terminal/*, packages/ui/src/index.ts; tests/contracts/terminal-keyboard.test.ts, tests/ui/terminal-controls.test.tsx.
Approach: pure action resolution plus React hook taking injected authenticated request/send/focus methods; shared toolbar/settings and bounded preferences. Prefix Ctrl+g with timeout/Escape cancellation, editing and pane commands, platform-aware modifiers and overrides.
Execution note: test-first.
Test scenarios: Mac editing, all pane actions, profiles and overrides; IME/AltGraph, event phases, repeat, modifier conflicts; stale target/cancelled load, safe action errors, failed save retains previous preference.
Verification: contract and UI tests, types.

### U3 Electron integration
Goal: shared controls and keyboard handling across TerminalView consumers without remounting buffers; existing clipboard behavior retained.
Files: desktop/src/renderer/src/features/terminal/TerminalView.tsx, extracted keyboard/controller integration, TerminalsTab.tsx only if needed; relevant desktop tests.
Approach: shared hook/controller with connection API and attach manager; toolbar near terminal, disabled on inactive/disconnected/observer surfaces. Expose configurable shortcut settings from shared UI.
Execution note: test-first.
Test scenarios: Cmd/Option editing sends once, pane actions address selected session, failure safe, no action while inactive, clipboard unaffected, settings persistence.
Verification: desktop terminal tests and typecheck.

### U4 Web integration and legacy layout preservation
Goal: same controls across Web Canvas and Web Desktop; new split/close actions invoke focused Zellij session.
Files: shell/src/components/terminal/{TerminalPane.tsx,TerminalApp.tsx,TerminalAppContext.tsx,TerminalPaneView.tsx}, new focused helpers, relevant tests.
Approach: extract existing giant-file keyboard and action logic; use shared controller. Keep old session layouts readable; replace split toolbar/shortcuts with server pane actions rather than appending frontend PTYs. Gate disconnected actions and preserve state until server success.
Execution note: test-first.
Test scenarios: parity, proper gateway/session target, existing layouts restore, split doesn't create a new frontend session, errors don't clear state, browser shortcuts suppressed only on consumed events.
Verification: shell component suites and typecheck/build.

### U5 Validation, review and public documentation
Goal: test real shell input through Zellij and review all changes; open implementation PR plus separate public docs PR.
Files: tests/integration or scripts/spikes scoped terminal smoke; docs/dev terminal documentation; private FinnaAI/matrix-os-site content/docs terminal page in separate manual worktree.
Approach: owned disposable Zellij sessions, bounded timeouts/explicit cleanup; validate Web Canvas then Web Desktop then Electron where runtime available. Review contracts/auth/lifecycle/regressions. Preserve unfinished worktrees; no deployment/merge is implied.
Verification: relevant tests, lint/pattern checks, real Zellij smoke, implementation and docs PRs with invariants and observed limitations.

## Auth and invariants

Existing shell route authentication remains authoritative. New POST requires the same principal/session authorization as neighboring terminal actions, bodyLimit before parse, strict Zod schema, validated session name and runtime lookup. Configuration belongs to owner files. No new DB persistence. UI errors generic; failed actions cannot discard sessions or input. New actions must resolve the managed generation adapter and target the attached session. Existing multi-session layouts remain readable; conversion does not terminate owner processes.

| Route | Authentication and authorization | Public |
| --- | --- | --- |
| POST /api/terminal/sessions/:name/pane-actions | Existing gateway runtime authentication; standalone registry excludes Chat-bound sessions. With chatId, canonical Chat principal, binding and live incarnation checks precede dispatch. | No |
| POST /api/sessions/:name/pane-actions (compatibility mount) | Same authenticated route implementation and checks. | No |
| GET /api/terminal/preferences | Existing authenticated owner runtime preferences route. | No |
| PUT /api/terminal/preferences | Existing authenticated owner runtime preferences route, bounded body and strict keyboard schema. | No |
