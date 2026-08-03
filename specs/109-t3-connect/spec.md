# Direct T3 Code Pairing

## Goal

Let a user pair the official T3 Code desktop, web, or mobile client with a T3 server running on
their Matrix OS computer without a T3 account, a managed T3 Connect relay, or a Matrix-specific T3
fork.

## User flow

1. The user chooses **Matrix OS** in T3 Code Connections settings.
2. T3 Code opens `app.matrix-os.com` with the canonical Terminal launch and fixed `t3-connect`
   action.
3. Matrix OS authenticates and routes the user to their computer, opens a visible canonical
   Terminal tab, and asks before installing the pinned official T3 CLI.
4. If the owner-scoped T3 server is already running, Matrix runs `t3 pair` and prints a fresh
   one-time pairing URL and QR code. Otherwise Matrix starts `t3 serve` on `127.0.0.1:3773` and
   prints its initial pairing URL and QR code.
5. The public URL points to
   `https://app.matrix-os.com/vm/<handle>/api/integrations/t3/`. Matrix routes only the bounded T3
   protocol namespace to the loopback server.
6. The user scans the QR code in the T3 mobile app or pastes the pairing URL in a T3 desktop/web
   client. T3 exchanges the one-time credential and saves its normal environment session.
7. The canonical Terminal session keeps the server alive. Reopening setup mints another pairing
   link without restarting a running server.

## Requirements

- Use the canonical `__terminal__` built-in in Canvas, Desktop, and the mobile shell.
- The setup query selects an allowlisted action; it never contains a command, credential, or host.
- Keep T3 state under `${MATRIX_HOME:-$HOME}/system/t3code`.
- Bind T3 to loopback and expose no customer VPS port directly.
- Require terminal confirmation before downloading or running the pinned official CLI.
- Preserve only the exact fixed handoff through authentication, billing, and provisioning, then
  consume it to prevent reload replay.
- Preserve T3 bearer, DPoP, Origin, and WebSocket-ticket data across the scoped proxy, while
  stripping Matrix cookies, platform proofs, hop-by-hop headers, and upstream cookies.
- Keep HTTP upstream waits bounded to 30 seconds. Cap request bodies at 10 MiB, WebSocket frames at
  1 MiB, queued WebSocket data at 2 MiB per connection, and active proxied sockets at 100. Drain the
  socket registry during gateway shutdown.
- Return generic errors to clients and log only coarse error kinds for loopback failures.
- Depend on generic upstream T3 support for path-prefixed reverse proxies and
  `--pairing-base-url`; do not add Matrix-specific transport or authentication code to T3.

## Auth matrix

| Route or boundary | Public to Matrix auth? | Authentication source of truth |
|---|---:|---|
| T3 client → Matrix setup URL | No | Existing Matrix OS web authentication and runtime ownership |
| `GET .../t3/.well-known/t3/environment` | Yes | T3 intentionally exposes its coarse environment descriptor |
| `POST .../t3/oauth/token` | Yes | T3 one-time pairing credential and proof exchange |
| `OPTIONS .../t3/{oauth,api}/...` | Yes | Bounded CORS preflight; no data access |
| `.../t3/api/**` | Yes | T3 bearer or DPoP session authorization and per-RPC scopes |
| `GET .../t3/ws?wsTicket=...` upgrade | Yes | T3 short-lived, single-purpose WebSocket ticket |
| Gateway proxy → `127.0.0.1:3773` | Internal only | Fixed loopback target and exact path allowlist |

“Public to Matrix auth” means the platform does not require a Clerk/Matrix credential on that
capability route. It does not make T3 APIs public: T3 remains the sole verifier for pairing and
environment sessions. Matrix never receives a T3 account token because this flow has no T3 account
sign-in.

## Non-goals

- T3 Connect account discovery, Clerk sign-in, or Cloudflare managed relay setup.
- Silent pairing or exchanging Matrix and T3 credentials.
- Automatic environment discovery after returning from Matrix; the user scans or pastes the
  one-time link using T3's existing pairing UI.
- A background service in the first iteration. The visible canonical Terminal session is the
  lifecycle owner.

## Success criteria

- The full public HTTP path reaches the correct active Matrix VPS without Matrix credentials, while
  retaining only T3 credentials.
- The public WebSocket path reaches the same VPS and then the loopback T3 server with its
  `wsTicket` intact.
- Unknown methods, neighboring prefixes, encoded paths, and traversal attempts are rejected.
- Reopening Matrix setup prints a new working pairing link for an existing process.
- Focused protocol, routing, lifecycle, shutdown, and UI tests pass in both repositories.
