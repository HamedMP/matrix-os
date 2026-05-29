# Research: Matrix CLI TUI Action Console Follow-Up

## Decision: Preserve Parent 084 as a Contract

**Rationale**: The user complaint is specifically that the follow-up changed or removed parent TUI behavior. The first implementation layer must encode parent preservation as a regression contract before adding new actions.

**Alternatives considered**: Rebuilding the home screen around quick actions was rejected because it can erase the prompt-first design and mascot work from the parent stack.

## Decision: Home Shortcuts Execute Real Actions

**Rationale**: The local test showed visible actions such as login felt broken because they did not do anything observable. Every shortcut needs an execution, navigation, or unavailable state.

**Alternatives considered**: Keeping shortcuts as discovery-only labels was rejected because it creates silent no-op UX.

## Decision: Keep Matrix Session Language With Zellij-Style Operations

**Rationale**: Zellij is the substrate, but the parent spec intentionally frames the UX as Matrix sessions spanning shell and coding work. The follow-up should expose zellij-style operations without narrowing the product language to shell sessions only.

**Alternatives considered**: A shell-only sessions screen was rejected because it removes coding/session cockpit scope from 084.

## Decision: Setup Wizard Previews Migration Before Writes

**Rationale**: Local agent configuration may include secrets or unsupported vendor formats. Preview-first migration lets the user choose Codex/Claude setup while preserving owner control and avoiding accidental credential copying.

**Alternatives considered**: Auto-copying local `.agent`, `.codex`, and `.claude` directories was rejected because it risks moving secrets and unrelated settings.

## Decision: Local Laptop States Are First-Class

**Rationale**: Local source testing can lack gateway, platform auth, zellij, or sync services. The TUI should distinguish these capability states so a laptop does not look broken merely because services are not running.

**Alternatives considered**: Treating local source mode as identical to a provisioned VPS was rejected because it hides prerequisites and causes confusing failures.
