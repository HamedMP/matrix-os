# Contract: Parent TUI Preservation

## Purpose

Protect the `084-matrix-cli-tui-polish` TUI from accidental deletion or narrowing while this follow-up adds real actions.

## Required Preserved Elements

- Prompt-first home layout and Matrix OS identity
- "Ask Matrix..." prompt region and command-family hint area
- `/ commands`, agents tab, sessions shortcut, quit shortcut, and other parent keyboard hints
- Compact decorative rabbit mascot with responsive fallback
- Status line for auth, gateway, sync, sessions, and next action
- Command palette coverage for all parent command families
- Matrix sessions language covering shell and coding sessions
- Direct CLI command and machine-readable output compatibility

## Change Rule

Any change that removes or narrows one of these elements requires:

1. An entry under `Approved Removals From Parent 084` in `spec.md`
2. Explicit user approval
3. Replacement behavior
4. Regression test coverage

Current approved removals: none.
