# Routine CLI Full Access browser-origin transport

Status: owner-approved source and isolated tests. Shared deployment and live acceptance remain separate gates. This implements the Platform half of the approved Full Access origin design; the dependent Gateway owns explicit consent, replay protection, qualified Run/native binding and live leases.

Source baseline: `c93724c3991619ac44b3a816198d02fe9e8a1fb9` (#3094). That main source already includes the logical exact-operation owner-browser prerequisite from `ccdac762ff830e547d6b26ea18a98ccec6d31b3c`; this change adds Full Access transport and the shared verification bounds without reintroducing that prerequisite. It preserves main's funded/model-choice behavior, preview-pair exports/imports and Clerk `issuer`/millisecond `expiresAt`. The prerequisite's `tokenExpiresAt` remains a separate verified epoch-seconds field. The prior `066c4cb8bc2779550534109215f099b0866f2283`-based port is historical source qualification. Deployment of the new combined source is pending; an earlier source or image does not establish that its verifier is serving.

## Authentication and purpose

| Route | Authentication | Effect |
| --- | --- | --- |
| POST `/api/chats/:chatId/routine-cli/full-access/challenges/:challengeId/decision` through an existing runtime proxy | Independently verified current owner browser session and exact routed machine/slot | Attest strict decision body, Chat and server challenge reference; no consent minted by Platform |
| POST `/api/chats/:chatId/turns` through an existing runtime proxy | Same browser evidence plus nonsecret valid scope reference | Attest the exact canonical parsed request; no Run, source ceiling or lease created by Platform |
| POST `/internal/containers/:handle/routine-full-access/verify` | Existing per-Computer Platform verification token and separate purpose-specific proof | Verify strict tuple/signature/expiry plus current running authorized SQL owner/machine/slot; cannot mint consent |

Reuse `routineOwnerSession`: either an already signed strong browser provenance with current expiry, or a freshly verified matching Clerk owner, nonblank sid and positive unexpired safe-integer exp. Ordinary sync/device/native/runtime labels and `permissionMode` alone cannot establish this provenance. An independent valid Clerk cookie may supply browser evidence; the transport label itself cannot. This is browser-session evidence, not a claim of physical human presence.

Use existing signing material with HMAC domain `matrix-routine-cli-full-access-origin:v1\0`, purpose `routine_cli_full_access_origin`, version 1 and maximum 60-second lifetime bounded by the verified browser deadline. Kinds `scope_decision` and `turn` remain separate and cannot be substituted for exact-operation `routine_cli_owner_action` proofs. A caller-known per-Computer transport token cannot sign these proofs.

## Wire and propagation

Shared contracts are exported by `routine-full-access.ts`. Decision input is strict `{scopeDigest,decision,clientRequestId}`; challenge/scope IDs are `rcfull_` plus 32 lowercase hex characters. The route supplies Chat/challenge identity; server-selected routing supplies handle, runtime slot, machine and owner. The ordinary turn carries only `x-matrix-routine-full-access-scope` as an untrusted nonsecret selector, with no new request-body authority field.

Turn proof binds SHA-256 of `routineFullAccessTurnRequestIdentity(input)`, the exact `JSON.stringify(CanonicalCreateChatTurnRequestSchema.parse(input))` preimage, including request ID and base revision. Existing request IDs retain their canonical spelling. This digest is independent of the existing admission duplicate hash. Initial turn selection is limited to the existing Claude Code instance family and default/full_access input; the Gateway must still validate its actual catalog driver, newly accepted ordinary private Chat Run and native generation. A client instance-name prefix does not prove any of those facts.

The existing proxy proof dispatcher and header classifier are reused, so explicit VM, normal VPS and legacy/code proxy construction share the new header handling without a second routing framework. Strip incoming `x-matrix-routine-full-access-proof` in HTTP/code/generic and WebSocket builders, including missing-browser, unknown-path and unprivileged fallback paths. Only the existing authenticated HTTP proxy replaces it with a freshly minted proof. Collaboration socket relay already forwards only an explicit WebSocket protocol-header allowlist. Queued/retry/continuation/Bot/Terminal routes never mint this turn proof.

The verifier returns `{verified: RoutineFullAccessProof}` with private/no-store caching. Every expected tuple field, strict schema, kind, purpose, signature, body digest and expiry must match. It then rechecks the existing bounded read-only machine lookup against current SQL state and rejects a proof that expired during that lookup. Platform intentionally does not consume the nonce; the dependent Gateway must consume/reconcile it and redeem the exact current explicit consent. Repeated verification is not repeated grant acceptance.

## Bounds and failures

Decision body limit is 4000 bytes. Ordinary turn limit remains 128 KiB, matching the existing canonical turn boundary; collection uses a fixed-size buffer. Proxy body read deadline is five seconds. Malformed inputs do not mint; oversized/slow/invalid-UTF8 or failed body reads produce coarse bounded errors, cancel affected reads and never forward raw errors or caller proof.

Internal verification has Hono bodyLimit, an independent actual-byte cap even when Content-Length is false, a five-second stream deadline that also covers bodyLimit's own read, and at most eight active requests. Release admission on every exit. Reuse the existing machine lookup's pool, connection/query bounds and owner-only shutdown; add no pool, key, database schema, persistent grant, daemon, MCP or resource.

The exact-operation prerequisite and Full Access verification routes share this bounded authentication/body guard. Authenticate the existing per-Computer transport before collecting a body; both purposes recheck proof expiry after the current-machine lookup. This changes no signing domain, DTO, scope or grant, and does not alter unrelated browser, custom MCP or integration routes.

Missing/foreign/expired provenance or unavailable verification leaves the dependent source at its prior exact-operation ceiling. A proof cannot approve schedule activation, enable background models, grant integrations, change revisions, authorize a shared/foreign Chat or convert unknown/cancel-pending outcomes into success.

## Evidence and delivery

Failure-first tests exercise the actual existing proxy and actual registered `createApp` internal route. SQL integration fixtures use Kysely/PGlite, not a server PostgreSQL instance. Tests include device/legacy sessions, malformed/slow/oversized reads, caller-header stripping, wrong purpose/kind/tuple/digest, transport-key forgery, current machine changes, lookup outages and admission release. Local compilation and source imports are separate from a deployed matching verifier and live Gateway/Dev flow.

Deliver the Platform/contracts Draft separately from dependent Gateway/UI work. The public documentation update remains a separate Draft in the private Matrix OS site repository, coordinated by the root session; do not duplicate the documentation MCP/capability discovery work. A shared Platform rollout needs its own exact-source/image and rollback confirmation. No live account, deployment, permission or unattended-acceptance result is implied by this source patch.
