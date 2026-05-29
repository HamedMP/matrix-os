# Contract: TUI Shell Session Management

The TUI reuses the existing CLI shell client/gateway contract where possible.

## Existing Gateway APIs

| Operation | Method/Path | Used by TUI |
|-----------|-------------|-------------|
| List sessions | `GET /api/terminal/sessions` | Sessions view and home status |
| Create session | `POST /api/terminal/sessions` | New shell session quick action |
| Delete session | `DELETE /api/terminal/sessions/:name` | Confirmed remove/stop action |
| Attach session | `WS /ws/terminal/session?session=:name` | Attach handoff |

All calls use the existing authenticated profile token through `createShellClient`.

## TUI Session Row

```ts
type TuiSessionRow = {
  name: string;
  state: "running" | "stopped" | "unknown" | "unavailable";
  cwdLabel?: string;
  layoutLabel?: string;
  selected: boolean;
};
```

## Sessions View Keyboard Contract

| Key | Behavior |
|-----|----------|
| `up/down` | Move selection |
| `enter` | Attach selected session |
| `n` | Create new session |
| `r` | Refresh list |
| `k` | Confirm remove/stop selected session |
| `esc` | Return home |

## Empty And Failure States

Empty:

```text
No shell sessions
[n] new session   [r] refresh   [esc] back
```

Gateway unavailable:

```text
Gateway unavailable
Run doctor or check your active profile.
[d] doctor   [l] login   [r] retry   [esc] back
```

Unauthenticated:

```text
Login required
Run login before managing shell sessions.
[l] login   [esc] back
```

## Safety Rules

- Session names are validated through existing shell-session validation.
- Delete/remove requires confirmation.
- Attach errors return a safe message and reattach hint.
- Creating a session with a duplicate name shows a safe duplicate-session message and offers attach.
