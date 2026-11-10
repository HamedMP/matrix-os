# Chat access for apps

**Linear:** [ENG-435](https://linear.app/matrix-os/issue/ENG-435/featapps-give-apps-scoped-access-to-chat)

## Goal

Matrix should be self-expandable: an owner can build any Chat experience, such as a
kanban board of Chats or a complete replacement Chat app, as an ordinary app. Today
the app sandbox blocks all Chat data, so only native surfaces can do this.

## Behavior

- `MatrixOS.chats` and `MatrixOS.openChat({ view: "chat", chatId })` are available on
  Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile.
- Requests use the existing capability contract, `{ kind: "chats", request }`. Raw
  Chat routes remain closed to app frames.
- Operations are an allowlist. Each one maps to the native Chat route, so request
  validation, ownership, projections and error mapping have one implementation.
- Scopes are `read`, `organize`, `send`, `approve` and `delete`.

## Authorization matrix

| Boundary | Authentication and authorization | Public |
| --- | --- | --- |
| App frame -> host | Exact registered frame/session; host stamps the app identity | No |
| Host -> `POST /api/bridge/capabilities` | Authenticated computer owner | No |
| Capability route -> Chat operation | Fresh trust and policy read; scope required per operation | No |
| Chat operation -> native route | Owner principal from the authenticated request | No |
| `openChat` -> native Chat surface | Host checks `read` under the stamped identity first | No |

Owner-built visible personal first-party apps hold every scope, following the
constitution's "self-built apps get full access". Any other app holds only scopes
the owner lists in `system/app-capabilities.json`, and a policy entry without
`chats` grants none. Approval and deletion are separate scopes so a grant can
exclude them.

## Safety and resource limits

- Strict request schemas, 256 KiB Chat requests, 8 MiB replies and a 30 second
  gateway deadline. Non-Chat capability kinds keep the 64 KiB limit.
- Chat budget of 600 requests per minute and 16 concurrent requests, separate from
  integrations. At most eight waiting event polls, each at most 25 seconds.
- Event replies carry metadata only. Persisted stream content is never returned,
  because it can predate a Chat being shared.
- Platform approval proofs are never forwarded, so browser and Custom MCP approvals
  fail closed for apps.
- Internal errors are mapped to safe codes and messages.
- Older hosts reject the new input kind, and `capabilities()` is unchanged because
  its strict schema is parsed by shipped Electron clients. Apps detect support with
  `MatrixOS.chats`.

## Not included

Chat sharing, provider credentials, imports, attachment upload and the token-level
content stream. Non-Chat native domains such as files, terminal and memory are also
outside this spec and need their own authorization design.

## Verification

- Contract, gateway authorization and dispatch, event, web bridge, Electron and
  Native Mobile tests.
- Live evidence on each affected surface is still required before merge.
