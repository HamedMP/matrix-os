# Data Model: Mobile Shell

## Mobile Shell State

Represents the phone-oriented shell state for the authenticated owner.

Fields:

- `surface`: `"browser-shell" | "native-mobile"`
- `mode`: `"launcher" | "app" | "terminal" | "canvas"`
- `lastActiveAppSlug`: string or null
- `lastActiveTerminalSessionId`: string or null
- `canvasEnteredAt`: ISO timestamp or null
- `updatedAt`: ISO timestamp

Validation:

- App slugs must match the existing safe app slug rules.
- Terminal session IDs must be opaque IDs returned by the gateway.
- State loaded from device storage is advisory; the gateway must revalidate app/session existence before opening.

State transitions:

- `launcher -> app`: user taps an app.
- `launcher -> terminal`: user opens Terminal.
- `launcher -> canvas`: user explicitly opens Canvas.
- `app|terminal|canvas -> launcher`: user taps Home/back-to-launcher.
- `app -> launcher`: app unavailable or session token cannot be issued.

## Mobile App Surface

Represents one full-screen app opened from the mobile launcher.

Fields:

- `slug`: safe app slug
- `name`: display name from app inventory or manifest
- `kind`: `"native" | "runtime"`
- `launchUrl`: runtime URL or null for native routes
- `sessionExpiresAt`: epoch milliseconds or null
- `status`: `"loading" | "ready" | "reconnecting" | "unavailable" | "failed"`
- `safeMessage`: bounded user-visible message or null

Validation:

- Runtime URLs are produced by the gateway or native route resolver, not typed by the user.
- Raw gateway/provider errors are logged, not displayed.
- A stale `launchUrl` must be refreshed through `/api/apps/:slug/session-token`.

## Terminal Session

Represents a user-owned gateway terminal session visible to mobile.

Fields:

- `sessionId`: opaque session ID
- `title`: optional user/session title
- `cwd`: owner-scoped working directory, if exposed
- `processState`: `"running" | "exited"`
- `attachmentState`: `"attached" | "detached" | "reconnecting" | "failed-to-attach" | "ending"`
- `createdAt`: epoch milliseconds from the gateway
- `lastAttachedAt`: epoch milliseconds from the gateway
- `attachedClients`: non-negative integer
- `exitCode`: number or null

Validation:

- Session ownership is checked server-side for every list/resume/end/write action.
- CWD must be validated with existing owner-home path helpers before session creation.
- Session registries must remain bounded and evict stale or exited entries according to gateway policy.

State transitions:

- `attached -> detached`: mobile browser/app disconnects or user backgrounds without ending.
- `detached -> attached`: user resumes the session.
- `attached|detached -> ending`: user intentionally ends the session.
- `running -> exited`: shell process exits.
- `attached|detached -> failed-to-attach`: attach fails while the server session remains recoverable or is reported missing.

## Terminal Control Action

Represents one phone control bar action sent to a terminal session.

Fields:

- `type`: `"attach" | "input" | "resize" | "detach" | "destroy" | "ping"`
- `sessionId`: opaque terminal session ID
- `payload`: per-type bounded payload

Validation:

- Use a Zod discriminated union at the route/WebSocket boundary.
- Input payloads have byte limits; phone key/control/paste actions are translated to bounded `input` frames.
- Key/control values are allowlisted.
- Resize values are bounded positive integers.

## Canvas Access State

Represents explicit mobile Canvas entry.

Fields:

- `enteredFrom`: `"launcher" | "app" | "terminal"`
- `previousMode`: previous mobile shell mode
- `enteredAt`: ISO timestamp

Validation:

- Canvas access is a user action, not the phone default.
- Returning home always resolves to launcher mode, not a panned/zoomed trapped Canvas state.
