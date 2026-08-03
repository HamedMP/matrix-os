# Security Architecture

## Trust Boundaries

```text
Web / mobile renderer ─┐
Electron renderer ─────┼─ authenticated Matrix gateway ─ typed runtime adapters
                       │                                  ├─ Hermes dashboard, loopback
Electron main/preload ─┘                                  └─ OpenClaw gateway, loopback + token

Matrix messaging ingestion ─ permission/revision gate ─ selected runtime delivery
```

- Renderers are untrusted for secrets and privileged service control.
- Gateway is trusted to validate owner requests and normalize runtime data.
- Hermes and OpenClaw are external processes with runtime-specific state; they are not trusted as Matrix authorization sources.
- The Matrix messaging permission repository remains authoritative for room access, cancellation, replies, and audit.

## Auth Matrix

| Interface | Authentication | Authorization | Body limit | Client response |
|-----------|----------------|---------------|------------|-----------------|
| `GET /api/settings/agent` | Existing Matrix request principal | Current computer owner | N/A | Additive safe view |
| `PUT /api/settings/agent` | Existing Matrix request principal | Current computer owner | 16 KiB before parse | Safe view or coarse error |
| `POST /api/settings/api-key` | Existing Matrix request principal | Current computer owner | Existing 16 KiB or stricter | Status only; legacy Anthropic path |
| `POST /api/settings/agent/providers/:providerId/api-key` | Existing Matrix request principal | Current computer owner; provider must advertise `api_key` | 16 KiB before parse | Status only |
| `POST /api/settings/agent/providers/:providerId/login` | Existing Matrix request principal | Current computer owner; provider must advertise `oauth_login` | 4 KiB before parse | Setup action/status only |
| `DELETE /api/settings/agent/providers/:providerId/credential` | Existing Matrix request principal | Current computer owner | 1 KiB before handler | Status only |
| Chat WebSocket `/ws` message | Existing authenticated WS principal/query-token path | Current computer owner/session | Existing frame cap plus strict schema | Existing event stream or generic validation error |
| `GET /api/conversations/:id` | Existing Matrix request principal | Conversation owner on this computer | N/A | Stored transcript only |
| Hermes adapter -> dashboard | Fixed loopback destination; gateway-only | Allowlisted method/path | Adapter-specific max | Normalized subset only |
| OpenClaw adapter -> gateway | Loopback plus owner-only token file | Allowlisted RPC method | RPC request max 16 KiB | Normalized subset only |
| Runtime controller | Gateway invokes fixed executable/action | Exact runtime enum; fixed unit mapping | N/A | Bounded JSON status |
| Messaging delivery -> runtime | Short-lived Matrix capability and current permission revision | Room read/reply flags rechecked immediately | 64 KiB message envelope | No credential/runtime detail |

## Input Validation

- All public request bodies, path params, query params, WebSocket frames, runtime RPC results, controller JSON, and persisted config reads use strict Zod schemas.
- Conversation identifiers use a bounded safe reference schema and reject separators, traversal, NULs, empty parts, and identifiers outside the store grammar.
- Runtime identifiers are an enum, never arbitrary service names.
- Provider ids are safe slugs; model ids use a bounded provider-reference grammar and reject control characters, paths, and traversal.
- Runtime catalogs are parsed item-by-item and truncated to published caps; malformed items are logged by type/count and dropped. The response never forwards raw objects.
- Mutating HTTP routes install Hono `bodyLimit` before JSON parsing, including DELETE.
- WebSocket model and effort overrides are validated against the kernel allowlists at frame parse time and revalidated by the dispatcher before constructing `KernelConfig`.

## Secret Handling

- Provider keys are write-only. No read contract includes a value, prefix, suffix, account identifier, environment variable name, token file path, or profile name.
- API-key bodies are held only for the validation/write operation and never logged, included in diagnostics, analytics, errors, or component state after completion.
- Web/mobile never persist a key in local storage, IndexedDB, URL state, analytics, or crash reporting.
- Electron renderer never reads runtime credential files or invokes service control directly. Trusted main/preload exposes typed, allowlisted operations if an action cannot use the authenticated gateway.
- OpenClaw gateway tokens live in an owner-only file or systemd credential, mode 0600, and are read by the gateway adapter only. Tokens are never returned by status/config RPC.
- Platform-billed credentials remain inherited server environment and appear only as coarse readiness.

## External Calls and SSRF

- Hermes destination defaults to fixed `http://127.0.0.1:9119`; startup validation rejects non-loopback configuration.
- OpenClaw destination is a fixed loopback WebSocket URL and token-authenticated.
- Every adapter request has an abort timeout; redirects are not applicable to WebSocket RPC and are rejected on HTTP probes.
- User-supplied base URLs accept HTTPS only in the first release. Before any probe, parse, resolve all addresses, and reject loopback, link-local, private, carrier-grade NAT, multicast, unspecified, documentation, and internal ranges for IPv4 and IPv6.
- Revalidate every redirect by using `redirect: "error"`; no redirects are followed.
- DNS preflight is not DNS pinning. The implementation must either use an address-pinning dispatcher or document and test the residual DNS-rebinding boundary before enabling live probes. Until then, save validated URLs without server-side reachability fetch and let the runtime apply its own outbound policy.

## Safe Errors and Observability

Client error codes are bounded, provider-neutral values such as:

- `agent_config_invalid`
- `agent_config_conflict`
- `runtime_unavailable`
- `runtime_switch_failed`
- `authentication_required`
- `provider_setup_failed`
- `conversation_not_found`

Safe messages do not contain provider names, model service errors, HTTP status details, hostnames, IPs, filesystem paths, database/runtime error text, tokens, stack traces, or commands. Server logs may include a runtime id and error class/name, but never request secrets or raw upstream bodies.

Analytics record only coarse action/result/runtime enums and elapsed buckets. Session replay stays disabled on Chat, Terminal, and credential entry surfaces.

## Messaging Permission Enforcement

- Runtime selection is not a permission grant.
- The selected adapter receives only sanitized events after the current `HermesPermission`/future runtime-neutral permission revision is checked.
- Enqueue, dispatch, and pre-reply-send each check current permission and room mapping.
- Revocation transactionally cancels queued work, marks running work for abort, and cancels unsent replies before the adapter is notified.
- Runtime-specific Matrix plugins remain disabled for direct room ingestion in V1. If enabled later, a separate threat model must prove E2EE key, history, revocation, and duplicate-delivery parity.

## Desktop Privilege Boundary

Renderer responsibilities:

- Render normalized catalog/status.
- Submit typed settings/auth requests.
- Ask for a visible setup terminal through an allowlisted action.

Trusted main/preload responsibilities:

- Resolve the active gateway and terminal dependency at registration time.
- Validate IPC payloads with shared schemas.
- Launch only canonical `__terminal__` flows or fixed runtime actions.
- Never accept raw commands, unit names, file paths, or URLs from renderer IPC.

## Security Tests

- Auth matrix tests for anonymous/session/bearer/device contexts.
- Strict body/path/query/WS validation and body-limit ordering.
- Secret-canary tests across JSON, error, log test sinks, analytics payloads, and UI state.
- Runtime RPC malicious/oversized/malformed response tests.
- Fixed-loopback and user-base-url SSRF/redirect/DNS tests.
- Controller injection tests for runtime/action/unit arguments.
- Permission revocation, switch-race, replay, and duplicate-delivery tests.
- Older-client patch tests proving omitted extended fields cannot be cleared.
