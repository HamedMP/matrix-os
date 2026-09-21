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

## Review fixes (2026-09-21)

Security-review findings F1, F2 and F5 (gateway side), fixed test-first on the S05 layers. Receipt kept on the top layer only so the three S05 layers do not conflict on restack.

- **F1 control-stream liveness (P1), `124/s05` + `124/s05-gateway`.** RED `41573fa51`: an attached but idle home went `host_offline` after 60 s because the stream never sent anything on its own. GREEN `eb2d80044`: `CollaborationControlStream` sends a schema-validated, size-checked `generation` frame per attached socket every `evidenceRefreshTargetSeconds` (10 s, hard cap 10 s), reading the recorded authority generation once at attach; timers are per connection, unref'd, cleared on close and shutdown. RED `ac3351e63` / GREEN `c940ec900` on the gateway: the control client acknowledges every generation frame with its **unchanged** fence (`1970-01-01T00:00:00.000Z` before any denial, the last applied denial's time afterwards), so the ack records liveness without completing anything the platform did not deliver; the inbound frame refreshes the home's 20 s snapshot. Test: fake socket attached, clock +61 s → `host_offline`, one keepalive ack → `last_control_at` current and `issue()` resolves; gateway side: `controlFresh()` false after 21 s idle and `unavailable` from the verifier, true again after the frame with the ack shape asserted. Existing deny tests (`collaboration-tickets` host_offline, `collaboration-direct-sessions` stale snapshot) still pass.
- **F2 relay upgrade rejection (P1), `124/s05-relay`.** RED `853d2097e`: `prepareSocket` rejected on a directory database error and the platform upgrade listener let it escape with the client socket open. GREEN `8e329a27e`: `prepareSocket` catches, logs `error.name` only and resolves null; the direct branch of the upgrade listener wraps preparation plus the authority machine lookup, releases the reservation and destroys the socket. New `tests/platform/collaboration-direct-upgrade.test.ts` drives the real listener with a Clerk-only sync JWT and a rejecting relay; the relay unit test also asserts the connection-string message is never logged.
- **F5 departure cleanup (P2), `124/s04` + `124/s05-gateway`.** `endActorGrants` (transactional per scope, already on S04) was never called. RED `50ef4e5b1` / GREEN `ab36fb67f` on `124/s04`: `OrganizationMembershipClient.evict({ organizationId, actorId? })` drops cached evidence for an actor or a whole organization and marks in-flight lookups so their result is delivered but not cached. On `124/s05-gateway` (same RED/GREEN commits as F1): a pushed denial with organization and actor revokes direct sessions, evicts membership evidence, ends the actor's grants and activations, then acknowledges; if grant cleanup fails no fence is acknowledged and the denial completes at its lease deadline (access is already closed by the eviction). Wiring passes the capability repository and the membership client when it can evict (`isMembershipEvidenceEvictor`, so the layer compiles before the S04 restack). Test: org-wide grant accepted plus a member grant, pushed denial → member grant `revoked`, activation deleted, org grant intact, `authorize` → `not_found` at once while the platform's 20 s evidence would otherwise still be cached. Denials that name only a scope or only an actor evict nothing and end no grants (the platform fences departures with organization + actor).
- **Gates.** `124/s05`: `collaboration-tickets` + `collaboration-control-delivery-postgres` + `collaboration-wiring` 20/20 on real Postgres, platform `tsc` clean, full `bun run typecheck` exit 0, patterns 0 violations / 5 inherited warnings. `124/s05-gateway`: `collaboration-direct-sessions` 19/20 + `collaboration-wiring` 8/8 in the layer worktree, where the one failure is the F5 test needing `evict` from `124/s04` (`ab36fb67f`); in a disposable probe with that commit on top: 35/35 across direct-sessions, wiring and membership-client, gateway `tsc` clean, patterns clean; full `bun run typecheck` exit 0. `124/s05-relay`: `collaboration-relay` + `collaboration-direct-upgrade` + `preview-terminal-flow` + `collaboration-websocket` 26/26, platform `tsc` clean, patterns 0 violations.

## Greptile round 2 fixes (2026-09-21, PRs #1802 / #1803 / #1804)

Test-first on the owning layer; receipt kept on the top S05 layer. Commit subjects are stable across restacks.

**#1803 (`124/s05-gateway`)** — RED `test(collaboration): expose plaintext control origins, unbounded listeners and control-frame reordering`; GREEN `fix(collaboration): loopback-only plaintext control origin, bounded ended listeners, ordered control frames` + `fix(collaboration): close the control stream from the frame chain`.
- Plaintext control credentials: the control client's platform base URL now goes through `requireSecureCollaborationPlatformBaseUrl` (https, or http only to loopback); test asserts `http://platform.internal`, `http://10.0.0.5`, and a URL with credentials are refused while `http://127.0.0.1` and https are accepted.
- Listener registry unbounded (×2): `DirectSessionService.subscribeEnded` is capped at `connectionsPerHome + 16` (272) and refuses with `limit`; unsubscribe frees the slot.
- Control frames race: inbound control frames are applied strictly in arrival order through a per-stream promise chain; the chain logs and closes the stream on a rejected frame, while `receive()` still rejects for direct callers. Test: first denial's grant cleanup blocks, a second denial and a keepalive arrive, nothing is acknowledged until the first cleanup finishes, then acks arrive in order (2, 3, 3).
- Already fixed on the current head (evidence, no change): stale control state — `DirectTicketVerifier.verifyTicket` fails `unavailable` while `controlFresh()` is false, which gates create, renew and stream open (test "denies every exchange while the control snapshot is stale"); denials leave sockets active — wiring passes `onEnded` for legacy registries and every direct socket `subscribeEnded`s and shuts down at once (test "re-checks the stream ticket's expiry … and notifies subscribers on denial"); action limit discarded — `actionsRemaining` comes from the signed `maxActions`, `authorize` spends after local authorization, streams reserve/commit/rollback (tests "spends the ticket's signed maxActions…", "keeps the signed action budget…", "does not spend stream admission…", "reserves concurrent stream inputs…", "does not refund an old pending action…"); expired tickets complete authentication — `openStream` rejects an expired ticket and `verifyPossession` re-checks expiry at consumption; outdated threads: `require("ws")` replaced by `await import("ws")` in `fix(collaboration): gate direct sessions on control freshness, budgets and immediate revocation` (test "resolves the ws-backed control connector under ESM"), budget-before-authorization fixed in `fix(collaboration): charge direct actions after local authorization`.
- Gates: `collaboration-direct-sessions` 23/23 + `collaboration-wiring` 8/8 + `collaboration-database` 3/3 on real Postgres; gateway `tsc` clean; patterns 0 violations / 5 inherited warnings.

**#1804 (`124/s05-relay`)** — RED `test(platform): bound the relay socket registry and evict stale reservations`; GREEN `fix(platform): bound the relay socket registry and evict idle reservations`.
- Connection registries grow unbounded: every prepared socket is a reservation; distinct homes/actors are capped (4,096 / 16,384, a new key past the cap is refused), traffic in either direction `touch`es the reservation (wired in the platform upgrade listener on both the client and upstream sockets), a recurring sweep (started by direct wiring, stopped on shutdown) evicts reservations idle for 10 min, releases their counts and destroys the socket through the listener's `onEvict` hook; `release()` stays idempotent.
- "Tests were not test-first" (×2, receipt lines): the original relay suites were written alongside the implementation, as the receipt states; every change in this round and the earlier review round was test-first with RED/GREEN commits. No retroactive rewrite of that history is claimed.
- Outdated threads: session routes by runtime header and the protocol conditional-header names were fixed in the S05 review round 1 relay commit (tests "routes session lifecycle routes by the runtime header…" and "keeps the protocol's conditional DELETE headers…").
- Gates: relay + direct-upgrade + wiring + preview-terminal-flow + collaboration-websocket 29/29; platform `tsc` clean; patterns clean.

**#1802 (`124/s05`)** — RED `test(platform): expose non-atomic ticket issuance, leaked bootstrap timers, immortal retired keys and unbounded acks` (+ `test(platform): measure bootstrap timers against the fixture baseline`); GREEN `fix(platform): atomic ticket issuance, early origin check, retired-key expiry and bounded control acks`; integration `test(platform): prove the full direct control transport path on real PostgreSQL`.
- Ticket writes not atomic: `issueControlTicket` inserts and prunes in one transaction (RED used a `BEFORE DELETE` trigger raising on the table: the ticket had been committed despite the error; GREEN leaves no row).
- Invalid origin leaves timers running: the relay origin is validated before `createPlatformOrganizations`, so an invalid origin fails closed with the timer count unchanged from the fixture baseline.
- Retired signing keys never expire: `RETIRED_KEY_OVERLAP_MS` (15 min, above two 5 min re-registration intervals plus ticket TTL); retired keys carry a retirement time from `MATRIX_COLLABORATION_TICKET_RETIRED_AT` (JSON keyId → ISO, validated) or the keyring load time, and `publicKeys()` drops them after the overlap.
- Acknowledgement work unbounded: acknowledgement frames are applied one at a time per connection, `MAX_PENDING_FRAMES` (32) queued beyond which a frame is refused, and `shutdown()` awaits admitted frame work.
- Full transport path untested: new `collaboration-direct-transport-postgres.test.ts` (real Postgres) drives the registration route with runtime headers (401 without them), a one-use control upgrade over a real `ws` socket, ticket replay refused 401, a denial fenced by the real control authority and pushed through the stream transport, the acknowledgement persisted (`completed`, outbox `acknowledgedAt`, endpoint `lastControlAt`), and an oversized frame closing the socket.
- Already fixed on the current head (evidence): offline homes remain ticket-eligible — issuer answers `host_offline` unless `last_control_at` is within 60 s (test "reports host_offline for a home that never attached…"); healthy idle homes become offline — ws pong refreshes `last_control_at` and the stream's generation keepalive is acknowledged by the home (tests "keeps a pong-responsive idle home ticket-ready…", "keeps an idle attached home ticket-ready through generation keepalives…"); disconnected homes block delivery — `listDueDeliveries` filters by the stream's connected runtimes (`collaboration-control-delivery-postgres`); outdated threads (generation domains, instance-local control state, outbox retryability, concurrent registrations) were fixed in `fix(platform): bind resource generations, share control tickets and serialize registrations` and `fix(collaboration): refresh control liveness and select connected deliveries`.
- Gates: tickets + bootstrap + control-delivery-postgres + wiring + control-authority + direct-transport 35/35 on real Postgres; platform `tsc` clean; patterns 0 violations / 5 inherited warnings.

## Verdict round (2026-09-21, PRs #1802 / #1804)

Both PRs carried no unresolved inline thread; each was blocked by the Greptile summary
verdict alone. Fixes stay on the layer owning the file; the receipt stays on the top S05
layer so the three S05 layers do not conflict on restack.

**#1802 (`124/s05`, head `665886601`)** — verdict: *"The acknowledgement resource-management
requirement remains only partly satisfied and should be completed before merging."*

Two gaps remained in `packages/platform/src/collaboration/control-stream.ts`.

- *The drain was not the whole drain.* `receive()` checked only the frame size and the
  per-connection queue depth, so a frame arriving after `entry.close()` — or after
  `shutdown()` began — still chained new `controlAuthority.acknowledge` work. `shutdown()`
  captures a connection's chain at close, so that work was invisible to it: the stream
  reported shut down while acknowledgement transactions were still running against a
  database the caller was about to destroy. `receive()` now refuses once the connection is
  closed or the stream is shutting down, which makes the captured chain the complete drain.
- *The connection registry was capped but never swept.* `connections` shrank only through the
  socket's close handler. A half-open socket raises no close event and keeps accepting
  `send()` into the kernel buffer, so a home that is gone held its slot against the 4 096 cap
  and stayed in `connectedRuntimes()`, which is what the control authority filters due
  deliveries by — denials were repeatedly selected for a runtime nobody was holding. Each
  connection now carries a `lastTouched` refreshed at attach, on the upgrade handler's ws
  pong (`heartbeat()`) and on every acknowledgement; connections silent past
  `DEFAULT_CONNECTION_IDLE_TTL_MS` (60 s, the ticket issuer's `host_offline` window) are
  released and their sockets closed. The sweep runs before the cap can refuse a live home,
  on `connectedRuntimes()`, and on a 15 s interval that exists only while the registry holds
  a connection and is cleared by `shutdown()`.

RED `test(platform): expose unbounded post-close acks and unswept control connections`
(3 failures: the post-close frame hung the suite instead of rejecting, the cap refused a live
home behind a silent one, and the silent connection survived its own sweep). GREEN
`fix(platform): close post-close ack admission and sweep silent control connections`.

Gates: `collaboration-tickets` **22/22** on real Postgres (19/22 RED), plus
`collaboration-control-delivery-postgres`, `collaboration-direct-transport-postgres`,
`collaboration-wiring`, `collaboration-bootstrap` and `collaboration-authority` **9/9**.
`bun run typecheck` exit 0; `bun run check:patterns` 0 violations, 5 inherited warnings.

**#1804 (`124/s05-relay`, head `2ba8cc512`)** — verdict: *"The PR should not merge until the
relay drains active reservations during shutdown and the outstanding repository TDD
requirement is resolved."*

`CollaborationRelay.close()` cleared the idle sweep timer and nothing else. Every live socket
reservation kept its home and actor counts, its `onEvict` hook never ran so the platform
upgrade listener never destroyed the relayed socket, and `prepareSocket()` kept reserving
after the relay had shut down — reservations nothing would ever drain, pointing at a
directory and dispatcher that were about to be torn down. `close()` now releases every
reservation and runs its eviction hook before returning, logs a failing hook by `error.name`
and continues with the reservations behind it, clears the registry and both count maps,
leaves the sweep stopped for good, and refuses `prepareSocket()`. Closing twice is a no-op.
`direct-wiring.ts` already orders `relay.close()` ahead of `controlStream.shutdown()`, so the
sockets are gone before the control path is torn down.

RED `test(platform): expose relay reservations that survive shutdown`. GREEN
`fix(platform): drain relay socket reservations on shutdown`.

Gates: `collaboration-relay` **11/11** (10/11 RED), plus `collaboration-direct-upgrade`,
`collaboration-wiring`, `collaboration-websocket` and `preview-terminal-flow` — **30/30**.
`bun run typecheck` exit 0; `bun run check:patterns` 0 violations, 5 inherited warnings.

The second half of the #1804 verdict is the "tests were not test-first" receipt thread
answered in the Greptile round 2 section above: the original S05 relay suites were written
alongside the implementation, as this receipt has always stated, and every round since has
been RED → GREEN. That history is recorded, not rewritten; this round is test-first.

## Routed round (2026-09-21, two items found from higher layers)

Both defects were reported by workers on layers above and confirmed as owned here.

**Retired signing keys never expired across restarts (`124/s05`,
`packages/platform/src/collaboration/ticket-issuer.ts`, blocks #1802 and #1803).**
`RETIRED_KEY_OVERLAP_MS` was measured from `retiredAt` when
`MATRIX_COLLABORATION_TICKET_RETIRED_AT` carried an entry for the key and from the keyring
load time otherwise. The fallback made retirement a function of process uptime: every
platform restart reset the 15-minute overlap, so a retired key was republished to homes
indefinitely and its retirement never took effect.

Retirement is now configuration. The loader fails closed when any retired key is
configured without `MATRIX_COLLABORATION_TICKET_RETIRED_AT`, and requires exact
correspondence between the retired keys and their retirement times, so a missing entry
cannot silently never expire and a stray entry is caught as the typo it is. The issuer
refuses a retired key with no recorded retirement, and refuses a retirement dated further
ahead than the protocol's clock skew, which would never reach the end of its overlap. The
15-minute window is unchanged: it still covers two 5-minute re-registration intervals plus
the ticket TTL. The env var is read nowhere else in the repository and the route already
fails closed when the keyring does not load, so an operator who has retired keys configured
without retirement times gets an unavailable ticket route rather than a key that outlives
its rotation.

RED `test(platform): expose retired signing keys that outlive every restart`: the rotation
test had asserted the implicit load-time behavior and now supplies an explicit retirement
time; a new test constructs the issuer three times with the clock advanced past the overlap
on each restart and requires every one to be refused, then checks that a recorded retirement
keeps the key dropped across three further restarts. GREEN `fix(platform): require a
recorded retirement time for every retired signing key`.

Gates: `collaboration-tickets` **23/23** on real Postgres, plus bootstrap, wiring, routes,
direct-transport-postgres and control-delivery-postgres **16/16**. `bun run typecheck`
exit 0; `bun run check:patterns` 0 violations, 5 inherited warnings.

**Idle eviction leaked the upstream TLS socket (`124/s05-relay`,
`packages/platform/src/platform-websocket-upgrade.ts`).** A relayed direct socket is a pair,
but the relay's evict hook destroyed only the client half, and the upstream connection to the
home was torn down solely by the client socket's `error` handler. `socket.destroy()` emits
`close`, not `error`, so every idle eviction released the reservation's home and actor counts
while leaving a live TLS connection to the customer's VPS with nothing owning it; repeated
evictions accumulated them. The same hole applied to the shutdown drain added in the verdict
round above, and a teardown starting on the upstream side left the client half open.

The client socket's `close` now tears down the upstream alongside its `error`, and the
upstream's `close` destroys the client half, so a teardown beginning at the sweep, the drain,
the client or the upstream ends the whole pair. Counts still release through the client
socket's single `close`; `destroy()` and `release()` remain idempotent.

RED `test(platform): expose the upstream socket leaked by relay eviction` (3 failures).
GREEN `fix(platform): destroy both halves of a relayed direct socket pair`. The tests drive
the real upgrade listener with a real `CollaborationRelay` and a faked `node:tls` connect,
and cover eviction, `relay.close()` and an upstream-first teardown, asserting both halves
destroyed and the counts back at zero including after a repeated teardown.

Gates: `collaboration-direct-upgrade` **4/4** (1/4 RED), plus relay, websocket, wiring,
preview-terminal-flow and app-session-runtime-routing — **37/37**. `bun run typecheck`
exit 0; `bun run check:patterns` 0 violations, 5 inherited warnings.

## Greptile round 3 (2026-09-21, PR #1803)

**#1803 (`124/s05-gateway`)** — RED `test(collaboration): expose control frames applied after a terminated stream`; GREEN `fix(collaboration): drop queued control frames once the stream is terminated`.

- **Closed stream processed queued frames**: a failed frame closed the socket but resolved the shared `inbound` chain, so frames already queued behind it still ran `applyFrame` and could revoke sessions, advance the fence and acknowledge after the stream was terminated; the queue was also unbounded. A per-stream `terminated` flag now refuses every queued and later frame before `applyFrame`, set by a rejected frame, by a backlog overflow and by `close()`. Pending frames are capped at `MAX_PENDING_CONTROL_FRAMES` (128, exposed as a static for tests); overflow tears the stream down so the reconnect re-registers, and denials that were never acknowledged are redelivered by the platform. Tests: an invalid frame between two denials leaves only the first denial applied with exactly one acknowledgement, and frames arriving after termination are refused with no revoke, no fence move and no ack; a chain blocked on grant cleanup and filled to the cap refuses the next frame with a backlog error, closes the socket, and acknowledges only the frame already in flight.
- **Already fixed on the current head (evidence, no change)**: ordered application of control frames remains the round-2 behaviour at `control-client.ts:149-162` and its test "applies control frames in order: a later denial or keepalive never acknowledges before an earlier denial's cleanup finishes" still passes unchanged; the loopback-only plaintext origin check (`control-client.ts:101`) and the bounded ended-listener registry (`direct-sessions.ts:145`) are unchanged and still covered.
- **Gates**: `collaboration-direct-sessions` 25/25 + `collaboration-wiring` 8/8 + `collaboration-foundation` 7/7 + `collaboration-database` 3/3 on real Postgres; `bun run typecheck` exit 0; `bun run check:patterns` 0 violations, 5 inherited warnings.
- The verdict's retired-signing-key item was fixed separately on `124/s05`; see the routed round above.

## Operator note — retired ticket signing keys (2026-09-21)

The retired-key fix is **fail-closed by configuration**: if `MATRIX_COLLABORATION_TICKET_RETIRED_AT` does not carry a retirement timestamp for **every** configured retired key (and no stray entries), the keyring does not load and the ticket route answers unavailable rather than publishing a key that outlives its rotation. Operators rotating collaboration ticket signing keys must set that variable alongside the retired key. A retirement dated further ahead than the protocol clock skew is also refused, because it would never reach the end of its overlap.

## Verdict follow-up (2026-09-21, PRs #1805 / #1806 verdicts routed back to S05)

Two blocking findings on higher PRs were caused by S05 code. Both are follow-ups to the
"Routed round" above. Fixes stay on the layer that owns the file; both write-ups stay here.

**A mistimed key rotation stopped platform startup (`124/s05`,
`packages/platform/src/collaboration/ticket-issuer.ts`, from the #1802 thread on lines
160-162 and the #1805 verdict).** The routed-round fix made a retired signing key fail
closed, but split the rule across two places: `loadTicketSigningKeyring` checked only that a
retirement timestamp *parses*, while the `CollaborationTicketIssuer` constructor enforced the
clock-skew *deadline* by throwing. A future-dated `MATRIX_COLLABORATION_TICKET_RETIRED_AT`
therefore loaded and then threw, and nothing between the two caught it:
`createPlatformCollaborationDirect` built the issuer outside any catch, so
`bootstrapPlatformCollaboration` (which exists to return a fail-closed composition) never got
to answer and the unguarded `await` in `platform-startup.ts` took the whole platform process
down. Malformed JSON and an unparseable date were already refused inside the loader and
degraded correctly; only the parseable-but-future date reached the throwing constructor.

The loader now applies the issuer's own deadline and answers null, so a keyring that loads is
a keyring the issuer accepts and there is one definition of a valid retirement. A refused
keyring degrades through the path that already existed for absent signing keys: no issuer,
503 from `POST /api/collaboration/connections`, and `platformSigningKeys: []` at runtime
registration, so the key whose retirement could not be honoured is never handed to a home
while the control stream, the endpoint registry and every other collaboration surface start
normally. Time only moves forward, so a retirement the loader admits is still admitted when
the issuer re-checks it; the two cannot disagree. The constructor's throws stay as guards for
programmatic callers. The refusal logs the rule, never the configured timestamp or any seed.
The security properties are unchanged: a retired key is never published without a recorded
retirement, the retired-key set and the retirement map must still correspond exactly, there
is still no load-time fallback, and `RETIRED_KEY_OVERLAP_MS` is still 15 minutes. The failure
mode moved from "process will not start" to "ticket route unavailable", never to "key
silently published".

A first attempt caught the error at the construction site instead (`9f79784f9` /
`70791739c`); it is reverted inside `2e7f650f4` because it left the loader and the issuer
deciding validity separately. The branch's net diff carries only the loader change and its
tests.

RED `test(platform): require the keyring loader to refuse an unusable retirement time`
(`2e7f650f4`, 29/31). GREEN `fix(platform): refuse a future-dated retirement in the ticket
keyring loader` (`e0b36f5ba`). The bootstrap regression the review asked for drives the real
`bootstrapPlatformCollaboration` path with all three shapes -- future-dated retirement,
malformed JSON, unparseable date -- and requires a real composition with `direct.issuer` null
rather than a platform that will not start; the ticket suite covers the loader's own verdict
on each shape and the route/registration behaviour of a keyring that did not load.

Gates: `collaboration-tickets` **25/25** and `collaboration-bootstrap` **6/6** on real
Postgres, plus `collaboration-wiring`, `collaboration-routes`,
`collaboration-direct-transport-postgres` and `collaboration-control-delivery-postgres` --
**42/42** together. `bun run typecheck` exit 0; `bun run check:patterns` 0 violations, 5
inherited warnings.

**Relay shutdown leaked an upstream opened after eviction (`124/s05-relay`,
`packages/platform/src/platform-websocket-upgrade.ts`, from the #1806 verdict).** The routed
round made every teardown destroy both halves of a relayed pair, but only once the pair
existed. A direct socket reserves, then dials the home, and `activeUpstream` was assigned
inside the TLS connect callback. In the window between those two steps the reservation can be
evicted by the idle sweep or drained by `relay.close()`: `onEvict` destroys the client socket,
its `close` handler finds `activeUpstream` still null and destroys nothing, and the handshake
that completes afterwards installs its pipes into a dead pair. The connection to the
customer's VPS then outlived the relay with nothing owning it, and repeated evictions
accumulated them. `prepareSocket()` already refuses after shutdown, so the gap was only ever
the connect already under way.

Adoption is now explicit: a teardown marks the upstream disposed, and a connect callback that
finds the pair disposed or the client socket destroyed destroys the new connection
immediately and writes nothing to it, so a dead reservation cannot adopt it. The client
socket's single `close` still releases the reservation exactly once and `release()` stays
idempotent, so a late upstream never double-releases counts. The legacy container upstream
path adopts through the same check.

RED `test(platform): expose an upstream connection adopted after its reservation died`
(`087a2433d`, 4/6 — the late upstream survived both eviction and the drain). GREEN
`fix(platform): refuse an upstream that connects after the pair is gone` (`4f7145043`). The
new cases hold the faked TLS handshake open across `sweepStaleSockets()` and across
`relay.close()`, then complete it and require the upstream destroyed, unspoken-to, with the
counts still at zero.

Gates: `collaboration-direct-upgrade` **6/6** (4/6 RED), plus `collaboration-relay`,
`collaboration-websocket`, `collaboration-wiring`, `preview-terminal-flow` and
`app-session-runtime-routing` — **33/33**. `bun run typecheck` exit 0;
`bun run check:patterns` 0 violations, 5 inherited warnings.

## Review round (2026-09-21, PR #1804 threads on streamed bodies and early disconnect)

**Streamed request bodies were bounded, but not by the relay (`124/s05-relay`,
`packages/platform/src/collaboration/relay.ts`).** The thread on `routes.ts:84` reads the
declared-length check as the only bound and concludes an authenticated client can stream an
arbitrarily large body to a home. Measured end to end, that last step does not hold: the
mutating branch sits behind `bodyLimit` registered at `routes.ts:63-67`, and Hono's
implementation wraps a body with no `Content-Length` in a counting stream and replaces
`c.req.raw`, so the branch forwards an already-bounded stream. A 4 MiB chunked upload through
the real route is refused with the home reading at most the 96 KiB cap; a 48 KiB chunked body
is forwarded whole.

The structural half of the finding is real. The bound came entirely from outside the relay,
from `COLLABORATION_HTTP_BODY_LIMIT` in `@matrix-os/contracts`, while the relay's own
`requestBytes` was enforced only against a declared length. The two constants are equal today
by coincidence rather than construction, so a relay configured with a smaller `requestBytes`,
or reached from any path without that middleware, forwarded the whole stream. A 128 KiB
chunked body through a relay limited to 32 KiB reached the home complete.

`forward()` now passes a `ReadableStream` body through a counting stream capped at
`this.limits.requestBytes`. The overflowing chunk is never enqueued, the source is cancelled
and the stream errors, which aborts the upstream request mid-body, and the relay answers 413
with a `limit` outcome instead of reporting it as an upstream failure. The relay still parses
no body and logs no payload.

RED `test(platform): hold the relay's request limit against a chunked body` (`cbaf4b556`,
13/14 — the route-level case passes there and records that the route bound is real). GREEN
`fix(platform): bound a forwarded request body by the relay's own limit` (`ec0b846a4`).

**Upstream survives early disconnect: already closed, verified not changed (`124/s05-relay`,
`packages/platform/src/platform-websocket-upgrade.ts`).** The thread describes the window the
"Routed round" above closed, and proposes tracking the socket at attempt time instead. The
guarantee is already there by a different mechanism, so the code was not rewritten. Every
upstream is created at exactly two sites, `platform-websocket-upgrade.ts:454` (TLS) and `:499`
(legacy container), and both adopt through `adoptUpstream` at `:460` and `:501`; there is no
third connect path. `adoptUpstream` at `:373-380` refuses on either of two conditions: the
`upstreamDisposed` flag, set by the client socket's `error` and `close` handlers at `:363-365`,
or the client socket's own `destroyed` state. The second condition is what covers the narrowest
window, an eviction landing before those handlers are attached, since `destroy()` sets
`destroyed` synchronously. A refused upstream is destroyed unspoken-to.

A verification case now pins that narrowest window: it evicts the reservation while the
listener is still awaiting the entitlement decision, then completes the handshake, and requires
the upstream destroyed with no bytes written and the counts at zero. Removing `socket.destroyed`
from the guard fails that case and nothing else, so the check is load-bearing and now has a
test. `test(platform): pin the earliest teardown window for a dialled upstream` (`ac85346a6`).

One residual, out of scope for this thread and pre-existing for every platform WebSocket
proxy path: an upstream whose handshake never completes and never errors is bounded only by
the operating system's connect timeout, because `adoptUpstream` runs on success and the
`error` handler on failure. No reachable teardown path leaves a *connected* upstream
unowned.

Gates: `collaboration-relay` **14/14** (13/14 RED) and `collaboration-direct-upgrade` **7/7**,
plus `collaboration-websocket`, `collaboration-wiring`, `collaboration-routes`,
`preview-terminal-flow` and `app-session-runtime-routing` — **50/50** together.
`bun run typecheck` exit 0; `bun run check:patterns` 0 violations, 5 inherited warnings.

## Review round (2026-09-21, PR #1802 threads)

All four on `124/s05`; the receipt stays on the top S05 layer.

**1. Combined key cap aborted startup (`ticket-issuer.ts`). Real, and it disproves the
earlier "cannot disagree" argument.** The deadline fix argued that a keyring the loader
admits is one the issuer accepts, because both compare against now-plus-skew and the loader
runs first. That holds for the deadline and not for cardinality. `parseKeyMap` caps the
active map and the retired map at eight keys **each**, while the constructor counts the list
it publishes -- active plus retired, one entry per distinct key id -- against the same eight.
Five active plus five retired, every retirement recorded and in the past, loaded and then
threw "Too many ticket signing keys" out of `createPlatformCollaborationDirect`, through
collaboration bootstrap, and out of platform startup: the failure mode the deadline round
closed, reached by a second path.

The loader now applies the combined distinct-key cap on both of its return paths. The
contract comment above it no longer asserts a bare invariant; it lists each constructor
refusal the loader rules out, so the next person adding a constructor check can see what the
claim depends on.

**Constructor re-audit, as asked.** Every throw reachable from construction, and what rules
it out at load:

| Constructor refusal | Ruled out by |
| --- | --- |
| active key missing from the key map | loader rejects `!keys[activeKeyId]` |
| key id fails `KEY_ID` | `parseKeyMap`, applied to both maps |
| seed is not a 32-byte Ed25519 seed | `parseKeyMap` computes the identical byte length; `ed25519PrivateKeyFromSeed` throws only on that length, and a fixed PKCS8 prefix over 32 bytes is always well formed |
| retired key with no recorded retirement | loader requires exact correspondence, both directions |
| retirement unparseable | `parseRetiredAtMap` requires `Number.isFinite(Date.parse(...))` |
| retirement past the clock skew | loader deadline check |
| more keys than the issuer publishes | combined cap added this round |

No residual class remains that the loader cannot check, so no catch is restored at the
construction site. `issue()` throws are request-time and unrelated to construction.

**2. Retirement deadline thread: stale, verified, not re-fixed.** The loader applies the
deadline at `ticket-issuer.ts:119-123`, computing now-plus-`clockSkewSeconds` and returning
null for any retirement beyond it, which is why the bootstrap regression's future-dated shape
comes up with the ticket route unavailable rather than failing to start. The constructor's
matching refusal survives as a guard for programmatic callers and is documented as such in
the comment above it.

**3. Registration and its upgrade ticket committed separately (`direct-routes.ts`,
`runtime-endpoints.ts`, `control-stream.ts`). Real.** The route recorded the registration in
one transaction and issued the control upgrade ticket in another. A failed issuance answered
503 while the generation bump and the merged public keys stayed committed, so the home was
told nothing was recorded and re-registered against a generation that had already moved.
`CollaborationControlStream.prepareUpgradeTicket()` now mints a token and expiry without
storing it, and `register()` takes that ticket and writes it inside the registration
transaction. Issue-plus-prune moved into a shared private helper, so the standalone
`issueControlTicket` path keeps its own transaction and its prune semantics unchanged.

**4. Ticket query parameter validated by hand (`control-upgrade.ts`). Real, narrow.** The
upgrade route checked the `ticket` parameter with a length comparison and an inline regex. It
now parses it with a bounded Zod schema through `safeParse`, keeping the same generic
rejection and changing nothing else; the surrounding header checks were left alone, as the
thread asks.

RED `test(platform): expose the combined key cap and non-atomic runtime registration`
(`b994bc775`): the loader returned a keyring for five plus five, the bootstrap regression's
new shape failed to start, and the refused registration left the recorded generation at 4
instead of 1. GREEN `fix(platform): cap combined signing keys, commit registration
atomically, validate the ticket param` (`53b7a698d`).

Gates: `collaboration-tickets` **27/27** and `collaboration-bootstrap` **6/6** on real
Postgres, plus `collaboration-direct-transport-postgres`,
`collaboration-control-delivery-postgres`, `collaboration-wiring`, `collaboration-routes` and
`collaboration-control-authority` -- **52/52** together. `bun run typecheck` exit 0;
`bun run check:patterns` 0 violations, 5 inherited warnings.
