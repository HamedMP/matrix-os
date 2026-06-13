# IPC Contract (renderer ↔ trusted core)

Every channel is zod-validated on BOTH sides (`desktop/src/main/ipc/contract.ts` is the single
schema source, imported by main + preload). Unknown or malformed messages are rejected and
logged (FR-081). The preload exposes exactly this surface via `contextBridge` as
`window.operator` — nothing else. The credential never crosses this boundary.

## Invoke channels (renderer → main, request/response)

| Channel | Request | Response | Notes |
|---|---|---|---|
| `auth:start-device-flow` | `{}` | `{userCode, verificationUri, expiresIn}` | main opens system browser |
| `auth:poll` | `{}` | `{status: "pending"\|"authorized"\|"expired", profile?}` | profile = `{handle, userId}` — no token |
| `auth:status` | `{}` | `{signedIn, handle?, runtimeSlot, platformHost}` | |
| `auth:sign-out` | `{}` | `{ok}` | clears credential + embed partitions (FR-006) |
| `runtime:select` | `{slot: string(1-64)}` | `{ok}` | triggers socket teardown→rebuild broadcast |
| `state:get` | `{key: enum}` | JSON value | window/layout/appearance reads |
| `state:set` | `{key: enum, value (bounded)}` | `{ok}` | atomic write |
| `embed:open` | `{kind: "hosted-shell"\|"app", slug?, bounds}` | `{embedId}` \| typed error | main performs handoff/token fetch |
| `embed:set-bounds` | `{embedId, bounds}` | `{ok}` | renderer reports panel rect |
| `embed:close` | `{embedId}` | `{ok}` | |
| `embed:retry-auth` | `{embedId}` | `{ok}` \| typed error | at most one auto retry happened already |
| `notify` | `{threadId, title(≤80), body(≤200), kind}` | `{ok}` | main coalesces per thread |
| `badge:set` | `{count: int 0-999}` | `{ok}` | dock badge |
| `shell:open-external` | `{url}` | `{ok}` | https-only allowlist check in main |
| `update:check` | `{}` | `{status}` | no-op without feed |

## Event channels (main → renderer, one-way)

| Channel | Payload | Notes |
|---|---|---|
| `auth:changed` | `{signedIn, handle?}` | sign-in/out, credential expiry |
| `runtime:changed` | `{slot}` | after teardown completes |
| `embed:state` | `{embedId, state: "loading"\|"ready"\|"auth-required"\|"failed"}` | inline sign-in trigger (FR-061) |
| `notification:clicked` | `{threadId}` | deep-link focus (FR-071) |
| `update:available` / `update:ready` | `{version}` | background download, apply on relaunch |
| `window:focus-changed` | `{focused}` | notification suppression while focused |

## Validation & bounds

- All strings carry max lengths; bounds objects are `{x,y,width,height}` ints within
  [-16384, 16384]; arrays capped.
- `embed:*` channels accept only known `embedId`s issued by main (random ids, not guessable
  enumeration).
- `state:set` values are size-capped (64KB) and schema-checked per key.
- Failures return typed error categories (the same `AppError` enum as the renderer mapper);
  raw Error messages never cross the boundary.

## Network-layer contract (not IPC, but part of the trust design)

- Main injects `Authorization` header via `webRequest.onBeforeSendHeaders` ONLY for the
  renderer session AND only when the request origin equals the active gateway origin.
- Embed partitions never receive header injection; they authenticate via their own cookie jars
  (hosted shell) or session-token launch URLs (apps).
- CSP on the renderer: `default-src 'self'`, `connect-src 'self' <gateway-origin> ws(s)://<gateway-origin>`,
  no remote scripts.
