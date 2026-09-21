# S05 receipt: transparent relay, tickets, direct sessions and revocation

**Tasks:** T025, T026, T027, T028, T029, T103. **Base:** `124/s04` @ `432e22bc4` (main `5f45b108f` + S20 six layers + S02 + S03 + S04). **Prerequisites verified:** S02 frozen contracts (`packages/contracts/src/collaboration-direct.ts`), S03 `controlAuthority.registerTransport` and `logicalRuntimeIdFor`, S04 gateway migration 8.

## Layers

| Layer | Branch | Tasks | Content |
| --- | --- | --- | --- |
| 1 | `124/s05` | T025 (platform), T026 | `packages/platform/src/collaboration/{ticket-crypto,runtime-endpoints,ticket-issuer,control-stream,control-upgrade,direct-routes,direct-wiring}.ts`; `organizationId` on directory events (contract, platform directory table, gateway outbox); composition in `wiring.ts`/`bootstrap.ts`; control upgrade hook in `platform-websocket-upgrade.ts` and `platform-startup.ts` |
| 2 | `124/s05-gateway` | T025 (gateway), T027, T028 | `packages/gateway/src/collaboration/{direct-crypto,direct-auth,direct-sessions,direct-routes,direct-websocket,control-client,runtime-identity}.ts`; gateway migration **9** (`collaboration_runtime_identity`); direct-session hook in `route-support.ts` (`authorize` accepts session credentials); direct socket paths in `auth.ts`; `clientOrigins`/`ownerId`/`relayHandle` in `config.ts`; composition and shutdown in `wiring.ts` |
| 3 | `124/s05-relay` | T103, T029 | `packages/platform/src/collaboration/relay.ts`; relay mounted ahead of the legacy proxy in `routes.ts` and for `/ws/collaboration/direct/...` in `platform-websocket-upgrade.ts`; `tests/e2e/collaboration-direct-transport.e2e.test.ts` |

## Tests

| Suite | RED | GREEN |
| --- | --- | --- |
| `tests/platform/collaboration-tickets.test.ts` (12) | module not found (`runtime-endpoints.js`) | 12/12 |
| `tests/gateway/collaboration-direct-sessions.test.ts` (9) | module not found (`direct-auth.js`) | 9/9 |
| `tests/platform/collaboration-relay.test.ts` (6) | written alongside the module (not RED-first) | 6/6 |
| `tests/e2e/collaboration-direct-transport.e2e.test.ts` (4) | written alongside the wiring (not RED-first) | 4/4 via `vitest run --config vitest.e2e.config.ts` after `pnpm --filter @matrix-os/observability build` |
| Regression: platform routes/websocket/bootstrap/wiring/proxy/internal-routes/repository, gateway foundation/org-precondition/routes/chat-events/terminal-websocket/wiring, contracts direct | – | pass (migration lists now 3–9 / 1–9; wiring registers 4 sockets) |

Pre-existing on the parent base, not touched here: `tests/gateway/collaboration-capabilities-postgres.test.ts › serializes concurrent accepts of different grants on one scope` and `tests/gateway/collaboration-authority.test.ts › resolves inherited membership only through an active project parent` fail identically on `124/s04` @ `432e22bc4`.

Deviation: tasks.md names the T029 file `collaboration-direct-transport.spec.ts`; the repository's e2e runner (`vitest.e2e.config.ts`) only includes `tests/e2e/**/*.e2e.test.ts`, so the file is `collaboration-direct-transport.e2e.test.ts`.

## Protocol decisions recorded

- Tickets: Ed25519 over canonical JSON (`matrix-collaboration-ticket-v2` domain), platform seed keyring from `MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID` / `MATRIX_COLLABORATION_TICKET_KEYS` / `MATRIX_COLLABORATION_TICKET_RETIRED_KEYS` (base64url 32-byte seeds, ≤ 8 keys; retired keys are published for verification only). Missing keys leave `POST /api/collaboration/connections` fail-closed (503) without skipping construction.
- Home identity: one Ed25519 pair per home in `collaboration_runtime_identity` (migration 9); the public half is registered at `POST /internal/collaboration/runtime-endpoints` with the enrollment identity (`x-matrix-runtime-id` + `UPGRADE_TOKEN`); the platform derives the relay handle from the machine record, never from the body.
- Sessions: one-use ticket + proof of possession (`matrix-collaboration-possession-v2`) at `POST /api/collaboration/direct-sessions`; identity session ≤ 300 s; organization evidence ≤ 20 s refreshed through the S20 precondition only on signed requests; request signature (`matrix-collaboration-request-v2`) binds method, path, query, body digest, conditional-header digest, nonce and time; nonces and ticket nonces share one bounded replay cache (10 000 entries, TTL then refuse).
- Streams: `/ws/collaboration/direct/scopes/:scopeId/{events,terminal}?ticket=<base64url signed ticket>`; possession proven in the first frame (`CollaborationDirectHandshakeFrameSchema`), ticket consumed once, connection counted (256/home, 32/scope, 4/actor/scope), five-second watchdog on session, evidence and generation.
- Control: `GET /internal/collaboration/control?ticket=…` with runtime headers; pushed denials end matching sessions and are acknowledged with a fence at the denial generation; generation frames move the home's generation; snapshots have a fixed 20 s lifetime and reconnect never extends them.
- Relay: `CollaborationRelay.forward` / `prepareSocket` forward only direct-protocol paths (session routes, scope/invitation/runtime paths, direct sockets) to the directory-resolved home; no proof is signed, no policy is read, no body or frame is parsed, only connection metadata is observable; upstream status codes pass through; limits 96 KiB request, 2 MiB response, 512 MiB export, 256 connections/home, 32/actor. Legacy proof-signing proxy paths remain until S18 removes them (T090).

## Review round 1 (Greptile on #1802 / #1803 / #1804)

- Tickets bind the resource's own authority generation (a project at N and a standalone Chat at 1 on one home get distinct bindings); the home compares it with the scope's `authority_generation` at exchange (`stale_generation`). Endpoint generation only gates registration.
- Home liveness: `collaboration_runtime_endpoints.last_control_at` is set on control attach and acknowledgement; the issuer answers `host_offline` (503 `host_offline`) for homes that never attached or went silent for 60 s.
- Control upgrade tickets are Postgres rows (`collaboration_control_upgrade_tickets`, hashed, one-use via conditional UPDATE) so any platform instance admits them; denial delivery to a runtime whose socket lives on another instance raises `ControlStreamNotConnectedError`, which the S03 control authority skips without spending an attempt (delimited edit in `control-authority.ts`).
- Runtime registration serializes per row (`INSERT … ON CONFLICT DO NOTHING` then `SELECT … FOR UPDATE`, merge, `UPDATE`); real-Postgres test `serializes concurrent registrations…` (skips without `MATRIX_TEST_POSTGRES_URL`).
- The gateway outbox reads `organization_id` inside the claim transaction; a lookup failure leaves the event unclaimed.
- Direct sessions: exchange denies while the control snapshot is stale (`controlFresh`), the signed `maxActions` is a per-session budget spent on every authorized request and stream input (`limit` on exhaustion, session ends), a pushed denial closes direct sockets through `subscribeEnded` and legacy sockets through the registries' `notifyRevoked`, stream tickets are re-checked for expiry when possession is proven, and the `ws` connector loads with `await import("ws")` (`loadDefaultConnector`, tested under ESM).
- Relay: session lifecycle routes (`/direct-sessions`, `/:id/renew`, `DELETE /:id`) resolve the home from `x-matrix-collaboration-runtime` (the ticket's logical runtime id, mapped through the endpoint registry), never a query parameter; the forwarded header allowlist uses the protocol names `x-matrix-client-request-id`, `x-matrix-expected-revision`, `x-matrix-expected-member-revision` (conditional DELETE test).

## Coordinator patches to know about

- `packages/gateway/src/auth.ts`: `COLLABORATION_WEBSOCKET_PATH` now also matches `/ws/collaboration/direct/scopes/<uuid>/{events,terminal}` (bypasses owner bearer auth the same way the relay-proof sockets do; the home verifies the ticket).
- `packages/gateway/src/collaboration/config.ts`: new `MATRIX_COLLABORATION_CLIENT_ORIGINS` (comma-separated https origins; empty means direct sessions fail closed) and `MATRIX_USER_ID` / `MATRIX_HANDLE` read as owner id and relay handle for registration.
- `packages/platform/src/platform-websocket-upgrade.ts`: control-stream upgrades are handled before session routing; direct sockets are relayed with `prepareSocket` headers (no proof).
- `packages/platform/src/collaboration/bootstrap.ts`: relay origin from `MATRIX_COLLABORATION_RELAY_ORIGIN` (default `https://app.matrix-os.com`), relay fetch through the customer-VPS dispatcher.

## Open gates

- Two disposable enrolled VPSes through the production relay (T029 VPS variant), ticket flow against real Clerk membership evidence, and the control-stream partition on a real host: **unrun**, need owner-approved fixtures.
- T028 fence checks inside queue claims, tool invocations and publication belong to the shared-AI runtime seams S08/S09 own; this packet exposes `DirectSessionService.revoke`, `describe` and the stream watchdog for them to consult. Denied isolated processes are terminated by S07's supervisor on lease loss.
- Rollback: dropping the platform `collaboration_runtime_endpoints` table and gateway migration 9 loses registration and identity state only; homes re-register and regenerate on next boot. The `organization_id` column on `collaboration_directory` is additive and nullable.
