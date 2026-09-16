# Provider authentication Terminal actions (OM-255)

## Problem and diagnosis

Electron Desktop retains a non-closable Terminal root tab when its window is
closed. Restoring a saved OS view can therefore produce an existing tab with a
`closed` surface. Provider setup selected that tab but did not activate the
surface. The native shell intentionally ignores closed surfaces during automatic
active-tab reconciliation, so a successful terminal creation was invisible.

## Behavior

- Provider setup explicitly activates Terminal before requesting its exact
  canonical session. This also applies to opening an existing provider session.
- Runtime changes during workspace/session creation must not adopt or foreground
  a session belonging to the previous runtime.
- Settings disables setup actions during bounded API requests and displays a
  generic error on failure. Returning to Settings refreshes provider state.
- Installed, authenticated CLI providers expose Disconnect in place of Connect.
  The gateway derives actions from normalized authoritative credential state;
  Electron and canonical web Chat consumers receive the same action.
- Claude uses `claude auth logout`, Codex uses `codex logout`, and OpenCode uses
  `opencode auth logout`. Pi requires interactive `/logout` account selection;
  its terminal explains that step before opening Pi. Positional `pi /logout`
  must never be used because Pi interprets it as a prompt.
- Missing, expired, or unknown credentials retain Connect. Providers without a
  validated terminal capability do not gain a synthetic executable action.
- Shared web Agents & providers keeps its existing account-management flow;
  this change targets CLI provider actions rather than replacing that contract.

## Validation

- Red/green regression: restored closed Terminal root does not show a window
  before the fix; minimized control case already works.
- Real pre-fix Electron reproduction: terminal creation succeeds, existing root
  becomes active, but its surface stays closed.
- Unit/component coverage: cold restore, existing-session reopening, stale runtime
  completions, delayed double clicks, generic failures, Settings return refresh,
  and provider install/auth action selection.
- Built Electron E2E uses a separate profile and fixture gateway: close Terminal,
  Connect, verify visible session, change authoritative auth status, return to
  Settings, Disconnect, verify command and visible session, then restore Connect.
  This does not claim live CLI logout or mutate any real account credentials.
- Human Review must use the exact commit/build. No release, deployment, or merge
  is implied by passing automated checks.
