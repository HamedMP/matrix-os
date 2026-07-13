# Spec 104: Native Linux Apps MVP

## Summary

Native Linux Apps lets the Matrix shell open curated Linux desktop apps running on the user's Matrix VPS/cloud runtime. The MVP supports `xterm` and `xcalc`, launched as the non-root runtime user through `xpra`, and streamed back into a Matrix window through same-origin authenticated gateway routes.

This is intentionally not a general native app platform. There is no manifest-supplied command execution, app store installation, custom Wayland/WebRTC compositor, or broad filesystem/network permission UI in this slice.

## Goals

- Add a `linux-native` runtime surface for curated apps.
- List curated native apps alongside normal Matrix apps.
- Launch curated `xterm` and `xcalc` apps through `xpra` with bounded display and port allocation.
- Embed the xpra HTML5 stream inside Canvas, Desktop, and mobile shell windows.
- Enforce owner-bound sessions, short TTL cleanup, max sessions per user, non-root launch, and generic client errors.
- Document the security model, enablement steps, and limitations.

## Non-Goals

- Arbitrary command execution from app manifests.
- Public/native app store support.
- Chrome, Spotify, or third-party app installation flows.
- Wayland/WebRTC streaming.
- Docker Compose production rollout.
- Root-launched apps.
- Full kernel namespace, seccomp, or network/filesystem sandboxing.
- Clipboard/filesystem/network permission UI beyond hardcoded MVP defaults.

## Architecture

Native apps run on the user's Matrix VPS as the runtime user. The gateway owns in-memory session records and exposes authenticated JSON APIs. `xpra` owns the X display and HTML5 stream. The shell embeds the stream URL in a Matrix window.

The MVP registry contains:

```json
{
  "id": "xterm",
  "name": "Xterm",
  "command": ["xterm"],
  "runtime": "linux-native",
  "enabled": true,
  "defaultWidth": 900,
  "defaultHeight": 640,
  "permissions": {
    "filesystem": "none",
    "network": false,
    "clipboard": false
  }
}
```

The gateway launches `xpra` using argv form, not shell strings:

```text
xpra start :<display> --start-child=xterm --exit-with-children --bind-tcp=127.0.0.1:<port> --html=on --daemon=no --clipboard=no
```

Display numbers and ports are allocated from bounded local pools and released on explicit termination, TTL cleanup, process exit, or gateway shutdown.

## API Contract

| Method | Route | Auth | Body | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/api/native-apps` | Matrix gateway auth | none | `{ apps }` curated enabled registry |
| `POST` | `/api/native-apps/:appId/sessions` | Matrix gateway auth + `bodyLimit` | `{ width?: number, height?: number }` | `201 { session }` plus scoped HttpOnly stream cookie |
| `GET` | `/api/native-apps/sessions/:sessionId` | Matrix gateway auth | none | `{ session }` for owner only |
| `DELETE` | `/api/native-apps/sessions/:sessionId` | Matrix gateway auth + `bodyLimit` | ignored | `{ session }` after termination |
| `GET/ALL` | `/api/native-apps/sessions/:sessionId/stream/*` | scoped stream cookie, or launch-returned bootstrap token that mints the cookie | proxied | same-origin proxy to loopback xpra |

`appId`, `sessionId`, and stream bootstrap tokens are validated at the route boundary. Launch bodies are strict: command payloads or unknown keys are rejected.

## Security Model

- Commands come only from the curated in-process registry.
- User input is never appended to shell commands.
- `spawn()` is called with argv arrays.
- Launch refuses if the gateway process is running as uid `0`.
- Session IDs are unguessable `session_*` values.
- Stream access uses a per-session HttpOnly cookie scoped to the exact stream path. The launch response also returns a same-origin bootstrap stream URL so the first stream request can mint the cookie if an app-domain proxy or browser path drops the launch `Set-Cookie`.
- Bootstrap stream tokens are unguessable `stream_*` values, tied to the session, validated at the route boundary, and stripped before proxying to `127.0.0.1`.
- The bearer/JWT auth middleware bypasses only `/api/native-apps/sessions/:id/stream/*`; that route performs stream-cookie or bootstrap-token validation before proxying to `127.0.0.1`.
- Client responses use generic errors. Detailed process/xpra errors are logged server-side only.
- In-memory session state is capped and TTL-cleaned.
- Max active sessions per owner defaults to `3`.
- Session TTL defaults to 30 minutes.
- Gateway shutdown terminates native sessions.
- No wildcard CORS is introduced.
- No server-side user-controlled URL fetch is introduced.

## Limitations

The registry declares `filesystem: "none"` and `network: false` for `xterm`, but this MVP does not provide hard isolation for arbitrary commands typed inside xterm. The enforcement in this slice is limited to curated launch commands, non-root execution, no extra mounts/env secrets, localhost-only xpra binding, disabled clipboard, owner-bound stream access, and lifecycle limits.

Before enabling browsers, Spotify, or third-party native apps, Matrix OS needs a stronger native-app sandbox, likely Linux namespaces plus seccomp/cgroups, or a Wayland/WebRTC compositor with explicit capability mediation.

## Enabling On A VPS

Install only the MVP dependencies on the user runtime host:

```bash
sudo apt-get update
sudo apt-get install -y xpra xpra-html5 xterm x11-apps
```

Then restart the Matrix gateway so `/api/native-apps` can detect `xpra`:

```bash
sudo systemctl restart matrix-gateway
```

Production rollout still follows the VPS-native host bundle path. Do not use Docker Compose as the customer runtime deployment path.

## Validation

Automated coverage:

- Registry only returns curated enabled apps.
- Invalid app IDs and arbitrary command payloads are rejected.
- Max sessions per owner is enforced.
- Owners cannot inspect or terminate another owner's session.
- TTL cleanup terminates child processes.
- Missing `xpra` returns a generic unavailable client error.
- Canvas routes `native:xterm` to `NativeAppViewer`, not `AppViewer`.

Manual validation:

- Confirm `xpra` and `xterm` are installed on the Linux runtime.
- Start Matrix dev or VPS services.
- Open Xterm from the Matrix shell.
- Confirm it appears in Canvas first, then Desktop/mobile.
- Close the Matrix window and verify `xpra`/`xterm` processes exit.
- Verify all JSON APIs require auth.

## Follow-Up Work

- Add process-level sandboxing for filesystem/network policies.
- Add stronger resource controls with cgroups.
- Add explicit permission UI before broader native app support.
- Replace xpra with a Wayland/WebRTC path for lower-latency graphics.
- Add native-app install/update UX for curated packages.
- Add browser-specific hardening before enabling Chrome.
