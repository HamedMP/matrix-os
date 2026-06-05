# Contract: Shell Terminal WebSocket Protocol

Source of truth: `packages/gateway/src/shell/ws.ts` (+ `@finnaai/matrix/shell-protocol`). The native `ShellWSClient` (T024/T025) implements this exactly.

## Connection
- Upgrade to the gateway shell WS route (path confirmed in Phase 0 / T001).
- **Auth (S1)**: send the principal token in the `Authorization` header (or token-bearing subprotocol) on the upgrade — NOT in the query string. The gateway resolves the principal via `requireRequestPrincipal(c)` (same pattern as the canvas WS).
- Attach targets a zellij session by name (the task's `linkedSessionId`); the gateway validates the session name (safe-name rules).

## Client → server messages
| `type` | fields | meaning |
|---|---|---|
| `input` | `data: string` | keystrokes/bytes to the PTY |
| `resize` | `cols: number, rows: number` | terminal dimensions |
| `detach` | — | leave the session running, close the socket |
| `ping` | — | keepalive |

## Server → client messages
| `type` | fields | meaning |
|---|---|---|
| `attached` | (attach ack) | session attached; replay begins |
| `output` | `seq: number, data: string` | ordered PTY output; **track the last `seq`** |
| `exit` | `code: number` | session/process exited |
| `error` | `code: string, message: string` | generic error (never surface raw text to the user beyond the provided message) |
| `pong` | — | keepalive ack |

## Scrollback & resume (F1)
- Constants: `SHELL_ATTACH_RECENT_REPLAY_EVENTS = 50`; sentinel `SHELL_ATTACH_LIVE_TAIL_FROM_SEQ`.
- On a fresh attach for live tail, pass `fromSeq = SHELL_ATTACH_LIVE_TAIL_FROM_SEQ` → server replays roughly the last 50 events then live output (`ShellReplayBuffer.replayFromSeq`).
- On reconnect, pass `fromSeq = lastSeq + 1` to resume exactly where the client left off.
- If the requested seq is older than the buffer, the server emits a `replay-evicted` event → client MUST clear its buffer and re-attach at `SHELL_ATTACH_LIVE_TAIL_FROM_SEQ` (accept the gap is unrecoverable; never duplicate).

## Client requirements
- Bounded reconnect backoff (cap). Bounded scrollback ring buffer with eviction (R1).
- Coalesce `output` application to the UI (batch flushes) to keep 60fps under fast output.
- Resize is sent on window/pane size change and once immediately after `attached`.
