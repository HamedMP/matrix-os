# Contract: TUI User Flows

## Home

- Prompt-first layout with compact status and next action.
- Shows logged-out, healthy, degraded, busy, and blocked states.
- Mascot is compact and disappears before critical text is hidden.

## Command Palette

- Opens with `/` and command shortcut.
- Supports search by command, alias, intent, and object name.
- Selecting an action opens a view, starts a flow, runs a direct command equivalent, or attaches externally.

## Confirmation Overlay

- Opens without layout shift.
- Escape cancels.
- Confirm requires a second deliberate action.
- Exact-phrase actions require typing the phrase.

## Sessions Cockpit

- Shows shell and coding sessions in one switcher with kind, status, context, age, and attention state.
- Enter opens details or default attach action according to selected row type.
- Attach/takeover/observe actions return the user to the TUI after detach when possible.

## First Run

- Logged-out home shows login as primary action.
- Login completion refreshes profile/auth/instance/sync state.
- Missing sync setup offers default sync root and manual entry.

## Accessibility

- Keyboard-only operation.
- 80x24 usable layout.
- No-color mode retains status readability.
- Decorative glyphs are never required for comprehension.
