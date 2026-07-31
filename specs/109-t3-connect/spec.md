# T3 Code Connect

## Goal

Let a user start the official T3 Connect setup on their Matrix OS computer from T3 Code's web,
desktop, or mobile Settings, then use that persistent environment from every T3 client.

## User flow

1. The user chooses **Connect Matrix OS** in T3 Code Settings.
2. T3 Code opens `app.matrix-os.com` with the canonical Terminal launch and the fixed
   `t3-connect` action.
3. Matrix OS authenticates and routes the user to their computer as usual.
4. Matrix OS opens a visible Terminal tab and asks for explicit approval before installing the
   pinned official T3 CLI.
5. After approval, Matrix OS runs `t3 connect --headless` and consumes the launch query so a reload
   cannot replay it.
6. The user authorizes T3 Connect and accepts its background-service prompt.
7. The Matrix OS computer appears through the existing T3 Connect environment discovery flow on
   desktop, web, and mobile.

## Requirements

- The handoff must use the canonical `__terminal__` built-in in Canvas, Desktop, and the mobile
  shell.
- The query parameter must select an allowlisted action, never contain a command or credential.
- T3 state must live under `${MATRIX_HOME:-$HOME}/system/t3code`.
- The setup must remain visible and interactive so the user can review the relay-client download,
  T3 authorization, and background-service prompts.
- Authentication, billing, and provisioning redirects must preserve only the exact fixed handoff
  pair and discard unrelated query data.
- Visiting the handoff URL is a request, not authorization to install code: execution requires a
  terminal confirmation and uses the pinned `t3@0.0.31` package version.
- Matrix OS must not receive, proxy, or persist the user's T3 account token.
- T3 Code must not receive a Matrix OS token; it opens a normal HTTPS URL and Matrix OS applies its
  existing authentication and runtime-routing gates.

## Auth matrix

| Boundary | Authentication source of truth | Data passed |
|---|---|---|
| T3 client → Matrix OS | Existing Matrix OS web authentication | Fixed launch/action names only |
| Matrix Terminal → T3 Connect | Existing T3 out-of-band OAuth | T3-issued one-time authorization code |
| T3 clients → Matrix environment | Existing T3 Connect relay/session authorization | Existing T3 protocol traffic |

## Non-goals

- A new T3 transport, provider adapter, or Matrix-specific T3 protocol.
- Silent authorization or exchanging bearer tokens between the products.
- Exposing a public inbound port on a Matrix OS computer.
- Automatically connecting a T3 client before the normal T3 Connect discovery completes.

## Success criteria

- Unknown `terminal_action` values are ignored.
- Partial, duplicated, or malformed auth/billing handoffs are discarded.
- Reloading after the action is queued does not replay it.
- The fixed action opens and queues correctly on both Matrix shell renderers.
- T3 web/desktop and mobile expose the same Matrix OS setup URL.
- Focused tests and type checks pass in both repositories.
