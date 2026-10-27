# App error recovery (ENG-400)

## Goal

Give a person a recoverable path from an app or shell error into a Matrix chat that has received useful, bounded context. Preserve their app state so they can retry the failed action.

## Contract and trust boundary

Apps may call `MatrixOS.repair({ operation, message })`. The host validates these short fields, binds the installed app identity and active computer, sanitizes diagnostic text, and opens a canonical managed Matrix chat. The call resolves with a chat ID only after the first turn is admitted. The diagnostic is explicitly labeled as untrusted in that turn. App code cannot choose another app, computer, provider, or gateway.

No new HTTP endpoint is added. The existing canonical Chat endpoints are used through the authenticated host:

| Route | Auth source | Input and limit |
| --- | --- | --- |
| `GET /api/chat-providers` | Host's active Matrix session | Catalog parsed by the shared contract; response capped at 1 MB |
| `POST /api/chats` | Same host session | Canonical chat schema; host-generated request ID and managed model selection |
| `POST /api/chats/{id}/turns` | Same host session | Host-formatted diagnostic, 500 character message excerpt, canonical admission schema |

Web uses the shell's authenticated gateway origin. Electron main uses its current owner token and registered embed sender. Native Mobile uses its current Clerk token and active computer gateway. Each request has a 12 second timeout, rejects redirects, and caps the response. The app bridge accepts at most 2,000 diagnostic characters and 80 operation characters; streams and pending requests retain the existing host limits. The authenticated canonical Chat API remains the final authorization boundary.

Web iframe, Electron `WebContentsView`, and Native Mobile WebView implementations use their existing authenticated bridge boundaries. The host also reports uncaught app errors and app startup failures through the same recovery UI. Matrix shell errors use the same UI and a host supplied diagnostic.

## Recovery interaction

The reusable recovery controls offer **Fix with Matrix**, **Try again**, and **Details**. Chat submission failures keep the controls visible. Retry reloads a failed app or repeats the failed persistence action without discarding the local draft. A repair chat is assistance, not proof that the save succeeded; users must retry and verify the data after reopening.

## Verification

- Unit tests exercise diagnostic redaction, bounded replies, confirmed chat admission, and Web/Electron/Native bridge identity checks.
- Integration wiring checks call the production bridge handler and broker with a bound app identity, simulate the canonical provider/create/admit sequence, and assert that only admitted turns resolve with a chat ID.
- Targeted typechecks and starter build protect the changed clients and template.
- Live visual evidence is required for Web Desktop, Web Canvas, Web Mobile, Electron Desktop, and Native Mobile before review readiness. Device or runtime access gaps are recorded explicitly.
- Public developer documentation ships in a separate `matrix-os-site` PR, cross-linked with the product PR.
