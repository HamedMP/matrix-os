# Contract: Protected Route Principal Behavior

## HTTP Protected Routes

| Scenario | Expected Behavior |
|----------|-------------------|
| Valid JWT with safe `sub` | Route observes `RequestPrincipal { userId: sub, source: "jwt" }`. |
| Valid JWT plus configured identity | JWT `sub` wins. |
| No JWT, trusted configured `MATRIX_USER_ID` present | Route observes `source: "configured-container"`. |
| No JWT, no configured identity, local/dev auth disabled and production false | Route may observe `source: "dev-default"`. |
| No accepted identity after auth context ready | Route returns generic 401 unauthorized. |
| Principal accessor called before auth context ready | Route returns generic 500-style server misconfiguration error. |
| Malformed `userId` from any source | Route fails closed with generic client-visible error and logs coarse details server-side. |

## WebSocket Protected Routes

| Scenario | Expected Behavior |
|----------|-------------------|
| Browser WebSocket token path validates before upgrade behavior | Upgrade handler can read canonical principal. |
| Missing or invalid principal after token validation | Best-effort generic error frame, then close. |
| Accessor called before auth context ready | Best-effort generic error frame, then close; server logs misconfiguration. |

## Consumer Requirements

- Sync routes must keep existing fail-closed missing-identity behavior.
- Canvas routes must use the canonical accessor through their existing `getUserId` dependency or an equivalent principal dependency.
- Workspace routes must derive `{ type: "user", id: principal.userId }` instead of hardcoding `local`.
- Legacy resolver calls may remain only when documented and tracked; new or touched protected routes must not call the legacy raw fallback resolver directly.

## Security Requirements

- No route may expose JWT claims, auth tokens, env values, stack traces, filesystem paths, or internal route details in client responses.
- No trust decision may depend on request-controlled headers such as `Host`, `X-Forwarded-*`, or any client-supplied path/query/body value.
- Principal resolution must stay request-scoped and must not use `globalThis` or process-global mutable current-user state.
