# Contract: Home Actions

## Purpose

Define the observable behavior for shortcuts added to the parent prompt-first home.

## Minimum Actions

- Login or setup when auth/setup is missing
- New shell session
- Sessions list
- Doctor/status
- Command palette
- Quit

## Action Outcomes

Every action must resolve to exactly one observable outcome:

- Navigate to an actionable TUI view
- Start a bounded backend/client operation and show progress
- Complete with a success message and refreshed state
- Fail safely with a generic message and concrete next step
- Report unavailable/degraded state with the missing dependency
- Cancel without mutating state

Silent no-op behavior is invalid.
