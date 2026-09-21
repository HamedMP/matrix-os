# S06 receipt — direct clients and resource discovery (T030–T034)

**Branch:** `124/s06`, parent `124/s08` @ f4c6d3297 (the S20 → S02 → S03 → S04 → S05 → S08 stack on main 5f45b108f). Single layer; the coordinator submits.

## Commits

| Commit | Task | Content |
| --- | --- | --- |
| 5db78054b | T030 | RED: `tests/ui/collaboration-direct-client.test.ts` (module not found) |
| 95303c31a | T031 | `packages/ui/src/collaboration/{direct-crypto,direct-client,direct-streams,direct-api}.ts`, discovery contract (optional `resource`, `home`, `organization_pending`), shared page tolerates metadata-only items |
| 8c3e761f4 | T032 | RED: platform discovery must be metadata-only and list organization-pending shares |
| f044debf3 | T032 | platform `listDiscovery` metadata-only (hydration removed), `collaboration_directory.audience`, `listOrganizationSharesForActor`, gateway outbox `audience` flag, wiring passes `listOrganizationIds` from the S03 projection repository |
| (this) | T033/T034 | shell + Electron factories use the direct client, session close on sign-out/auth change, hygiene tests |

## What the client does (T031)

- Per scope: Web Crypto Ed25519 proof key (non-extractable, in memory only) → `POST {platform}/api/collaboration/connections` (actor auth, purpose `direct_session`) → `POST {endpoint.origin}/api/collaboration/direct-sessions?scope=<id>` with possession proof and `clientOrigin`. The origin is the one the directory returned (the relay today); nothing is hardcoded.
- Every request is signed (`protocolVersion 2`, session id, method, canonical path, query, body digest, delete-conditions digest, nonce, issuedAt) and sent with `credentials: "omit"` and no actor token; a 401 triggers exactly one fresh ticket and retry (authority generation change / expiry); 426 → `upgrade_required` without retry; platform 404/503 → `host_offline`.
- Renewal before `renewAfter` with a fresh ticket on the same session and key; renewal failure falls back to a new session. Streams (`events`, `terminal`) open with a purpose ticket in the socket query, send the possession handshake as the first frame, and reconnect only with a new ticket (never a lease extension).
- `createCollaborationDirectApi` keeps the `CollaborationApi` shape: scope and invitation routes go direct (invitation → scope learned from discovery), discovery is fetched from the platform and hydrated from each home (concurrency 4; unreachable home → `home: "offline"`), owner-side create/preflight on the owner's own runtime keep the existing platform path until S18.

## Discovery (T032)

Platform `GET /api/collaboration/{inbox,shared}` return `{scopeId, runtimeId, ownerId, kind, authorityGeneration, status, invitationId?, organizationId?}` only; the proxy-based `hydrate` was deleted from `wiring.ts`/`routes.ts`. `collaboration_directory.audience` (additive column inside the locked bootstrap transaction) is set from the home's directory event `audience: "organization"`, which the gateway outbox derives from an active organization-wide grant (`collaboration_grants`). The inbox's first page appends `organization_pending` items for the actor's current organizations (S03 `listOrganizationsForActor`) that have no user-index row for the actor and are not owned by them.

Gap recorded: opening an `organization_pending` item still fails at the home until S12/S15 mount the S04 activation route and the platform ticket issuer admits organization-pending members (today `getScopeActorStatus` has no row → denied). The shared page renders the item with an Open control that will work once those land.

## Wiring (T033)

- `shell/src/lib/collaboration.ts`: `createShellCollaborationApi` → direct API (platform is same-origin as the shell; cookies via `same-origin` only on platform calls). `clearMatrixAppSession()` closes every direct session first.
- `desktop/src/renderer/src/lib/collaboration.ts`: same client; `clientOrigin` = platform origin (the renderer is `file://`/dev host, not https); `stores/connection.ts` closes sessions on `auth:changed`.
- Coordinator patches: none required. The Electron CSP `connect-src` already contains the gateway/platform origin and its `wss:` form, which is the relay origin in this release; if `MATRIX_COLLABORATION_RELAY_ORIGIN` is ever set to a different host, `buildRendererCsp` must add it (noted under Deferred scope). The gateway WS query-ticket allowlist already admits `/ws/collaboration/direct/...` (S05).

## Tests (observed)

- RED T030: `pnpm exec vitest run tests/ui/collaboration-direct-client.test.ts` → 1 failed file, module not found (5db78054b). GREEN: 9/9.
- RED T032: `tests/platform/collaboration-routes.test.ts` → 3 failed (8c3e761f4). GREEN: 7/7; wiring/outbox characterizations updated for metadata-only discovery and the audience flag (outbox expectation also gained `organizationId`, which S20 layer 3 seeds but had not asserted).
- T034: `tests/ui/collaboration-direct-hygiene.test.ts` 4/4, `tests/shell/collaboration-direct-wiring.test.ts` 2/2, `tests/desktop/collaboration-direct-wiring.test.ts` 2/2.
- Regression sweep (17 files / 144 tests): platform routes, wiring, bootstrap, relay, tickets, internal routes, proxy, websocket; gateway outbox, direct sessions; ui client/sharing/state/project sharing; desktop chat sharing runtime; contracts collaboration + direct.
- `bun run typecheck` exit 0; `bun run check:patterns` 0 violations (5 pre-existing warnings); react-doctor `packages/ui`: 44 pre-existing issues, none on the lines changed here (see PR body).
- Full `bun run test` not run (host-load rule); CI covers it after retarget.

## Evidence status

The shared page has current captures under `evidence/S06-direct-client/` for Web Canvas, Web Desktop, Web Mobile and Electron Desktop: pending, offline, denied and combined cards. The capture README records the mocked home/platform conditions, exact scripts and each screenshot. After review, pending cards show a truthful access message with no Open action while activation remains unavailable; pending and combined screenshots were refreshed from `e48126fbc` and visually inspected on Web Canvas and Electron Desktop. Web capture completed 12/12 scenarios; Electron capture completed 4/4 scenario tests from the built app. Native Mobile remains outside this packet's V1 scope.

## Ownership for later packets

- S12/S15: mount activation for `organization_pending` (home route + platform ticket admission), wire file/app routes through `createCollaborationDirectApi` (path-based, no client change needed).
- S18: delete the platform proxy path that owner-side create/preflight still uses; the direct client then covers every route.

## Review remediation (2026-09-21)

- **P1 stream revocation:** RED `tests/ui/collaboration-direct-client.test.ts -t "stops revoked|fences an exchange"` failed 2/2: unavailable events reopened a second socket, and an exchange completed after sign-out returned old content. GREEN 2/2 after terminating unavailable streams, draining subscriptions, fencing pending exchanges/requests by generation, and making full-client close permanent.
- **P1 pending pagination:** RED `tests/platform/collaboration-routes.test.ts -t "paginates organization-pending"` saw only 2 of 4 expected entries. GREEN 1/1 on PGlite and real Postgres with actor/status-bound indexed→pending phase cursors and stable keyset pagination.
- **P1 Open action:** RED `tests/ui/chat-collaboration-sharing.test.tsx -t "organization-pending cards"` found an enabled Open button; GREEN 1/1 with a pending access message. Screenshot inspection caught stale “opens when you join” copy; a second RED assertion and GREEN rerun are recorded in the test history.
- **P1 duplicate key:** Removed a duplicate `organizationId` assertion key in `tests/gateway/collaboration-directory-outbox.test.ts`.
- **P2 bounded cache/capture exit:** RED direct-client test retained the first of 129 scope keys; GREEN after limiting the scope cache to 128 and draining the oldest session. `capture-web.mjs` now exits nonzero on any missing scenario; `node --check` passed.
- **Final checks before recapture:** four focused suites, **46/46** passed; `bun run typecheck` exit 0; `bun run check:patterns` 0 violations and 5 pre-existing warnings. The added cache test and final copy test passed separately after this sweep. `npx react-doctor@latest --verbose --scope changed` exited 0, score 88/100; its 17 warnings were outside the changed React card. `pnpm --filter desktop build` exited 0 after the final copy change.

The review fixes are local commits until the coordinator restacks and submits #1806. The live S06 visual captures use a mocked platform/home and do not claim a real cross-host probe.

## Review round (2026-09-21)

Unresolved Greptile threads on #1806 at head `322a667d5`, worked bottom-up:

| Thread | Outcome |
| --- | --- |
| P1 `direct-streams.ts` unavailable streams reconnect (outdated) | Fixed by `359d3f13f`: `unavailable`/`terminal.unavailable` call `terminate()` (openStream `stop`, `closed = true`) so `onclose` never re-dials; terminal handlers check `stopped`. Locked by "stops revoked event and terminal streams without obtaining another ticket". |
| P1 `direct-client.ts` closed sessions can return | Fixed by `359d3f13f`: `closeScope` bumps `generation` and deletes the record; `ensure`/`request` fence on `active()` and `disposed`; an exchange that lands after close is deleted on the home and rejected. Locked by "fences an exchange completed after sign-out". Greptile kept the thread because the closed-over line still exists in the diff. |
| P1 `routes.ts` pending shares disappear (outdated) | Fixed by `4d22f5252`: indexed→pending phase cursors (`DiscoveryPageCursor`, version 2) with keyset pagination over pending shares. |
| P1 `ChatCollaboration.tsx` Open action always fails (outdated) | Fixed by `6ba4373c7` + `5f9be0075`: pending cards render an access message and no Open control. |
| P1 `collaboration-directory-outbox.test.ts` duplicate property (outdated) | Fixed by `6ba4373c7`: one `organizationId` key remains (line 78). |
| P2 `direct-client.ts` scope map grows forever | Fixed by `359d3f13f`: `MAX_SCOPE_RECORDS = 128`, oldest record closed at the cap, `scopes.delete` on close. Locked by "evicts old scope records when many resources are visited". |
| P2 `S06-receipt.md` visual evidence missing (outdated) | Fixed by `0aac7d7bb` + `322a667d5`: 16 captures under `evidence/S06-direct-client/` across Web Canvas, Web Desktop, Web Mobile, Electron Desktop. |
| P2 `capture-web.mjs` failures exit successfully | Fixed by `468e9f288`: `capture()` returns `false` on failure, the runner counts failures and sets `process.exitCode = 1`. |
| P2 `direct-streams.ts` closed scopes remain registered | The registered stop was already the self-removing `remove` (deleted its scope when empty), so the cap could not target a stopped entry. `328c024da` makes it explicit (`subscriptions.delete` in `closeScope`) and the eviction order is now least-recently-active. Locked by "forgets closed stream scopes…". |
| P2 `direct-streams.ts` stale streams consume limits | RED `d8fc378f0`: partitioned event socket never reconnected, stalled terminal socket kept, cap evicted by insertion order (3 failures + 1 lock). GREEN `328c024da`: per-stream `lastTouched` (open/inbound frame), a 15s sweep drops event sockets silent >45s (home heartbeats every 10s) and any socket whose `bufferedAmount` stops draining for >45s, re-dialling with a fresh ticket; the scope cap sweeps first and evicts the least-recently-active scope. |

Checks: `tests/ui/collaboration-direct-client.test.ts` 16/16, plus hygiene/shell/desktop wiring suites → **24/24**; `packages/ui` `tsc --noEmit` exit 0; `bun run check:patterns` 0 violations, 5 pre-existing warnings. No React file changed in this round.

## Verdict round (2026-09-21)

Greptile left no unresolved inline thread on #1806 at head `c1eef3a19`, but the summary
verdict blocked the merge: *"The PR should not merge until the explicit stale-connection
eviction requirement is fully satisfied for terminal streams."*

**Gap.** The previous round's sweep gated its silence rule on `purpose === "events"`
(`packages/ui/src/collaboration/direct-streams.ts`), so a terminal socket was only ever
dropped when its own sends stopped draining. A home that disappears without a close frame
therefore kept its terminal socket forever: the scope's event stream was dropped and
re-dialled while the terminal socket held a dead peer, a stream-registry slot and its
session's stream budget.

**Why terminal silence alone is not the rule.** The home pushes terminal frames only on
output or a state change, so an idle shared terminal is legitimately silent; the home's
terminal registry answers the client's 10 s heartbeat by touching the connection and sends
nothing back (`packages/gateway/src/collaboration/terminal-events.ts`). Copying the event
rule verbatim would re-dial every idle terminal every 45 s. The event stream reaches the
same home over the same connection and *is* heartbeated every 10 s, so its newest frame is
the peer's liveness for every stream on that scope.

**RED** `test(collaboration): expose terminal streams that survive a dead home`: one scope
with an event stream and a terminal stream, both silent past the window. The event socket
closes and re-dials; the terminal socket is never closed, never reconnects and takes no
second ticket.

**GREEN** `fix(collaboration): evict terminal streams whose scope lost the home`: the sweep
reads each scope's newest event-stream frame once, before any handle re-dials and resets its
own clock, and passes it to every handle on that scope. An event stream is still judged by
its own silence; a terminal stream is judged by that scope liveness and now falls to the same
45 s rule, closing and re-dialling with a fresh ticket. A scope with no event stream keeps
the undrained-send rule as its only silence signal, so the pre-existing
"drops a terminal stream whose sends stop draining" case (terminal-only scope, silent 120 s,
not closed) still passes unchanged.

**Gates.** `tests/ui/collaboration-direct-client.test.ts` 17/17 (RED 16/17 before the fix);
with `chat-collaboration-sharing`, shell/desktop direct wiring, platform routes and gateway
owner-source: **92/92**. `bun run typecheck` exit 0. `bun run check:patterns` 0 violations,
5 pre-existing warnings. No React (`.tsx`/`.jsx`) file changed in this round, so no
react-doctor run is required.

## Review round: terminal liveness on its own socket (2026-09-21, #1806 at `8479cc4ab`)

Greptile scored **3/5** and named two blockers: one thread on the stale sweep, and a
verdict-only relay item.

**P1 "Terminal liveness is masked" (`packages/ui/src/collaboration/direct-streams.ts`).** Valid.
The previous round made a terminal stream inherit the scope's event-stream liveness, but the two
are separate WebSocket connections that fail separately. With the event socket healthy,
`peerTouchedAt` stayed fresh and, on a partition that leaves sends buffering in the kernel,
`bufferedAmount` stayed zero, so neither the silence nor the stall rule fired and a dead terminal
socket could stay open indefinitely.

The inference is removed: every stream is swept on the frames that arrive on its own socket.
That is only correct if an idle shared terminal still hears from the home, so the home now keeps
it evidenced. `CollaborationTerminalEventRegistry.heartbeat` (already on a 10 s timer for
re-authorization) publishes the scope's state to any connection that has received nothing for
`KEEPALIVE_SILENCE_MS` (20 s), tracked per connection as `lastSentAt` and set in `send`. A
connection that just received output gets no keepalive, so a busy terminal carries no extra
frames. `heartbeat` takes an explicit time and is public so the keepalive is testable without
timers, matching `sweep(at)`. No contract changed: `terminal.state` is an existing frozen frame.

RED `50468e4a6`, GREEN `64e54cd6a`. Tests: a healthy event stream no longer vouches for the
terminal socket (event heartbeats every 10 s for a minute, terminal silent → terminal closed and
re-dialled with a second terminal ticket while the event stream keeps its first); an idle terminal
receiving the home keepalive every 20 s is never dropped and never re-ticketed; the home publishes
state to a silent connection on one heartbeat and nothing extra to a connection that just received
output. The pre-existing undrained-send case now feeds keepalives through both phases, so it
proves the stall rule independently of the silence rule.

**Verdict-only relay item: "relay shutdown can leak an upstream connection opened after
eviction".** Not this layer, and partly fixed below it. `packages/platform/src/platform-websocket-upgrade.ts`
(owned by `124/s05-relay`) now destroys the upstream on both `error` and `close` of the client
socket (`3378857c7`, lines 354-360), which covers eviction and the shutdown drain. One race
remains: `activeUpstream` is assigned only inside the TLS connect callback (line 440), so a client
socket destroyed while the handshake is still in flight runs `destroyUpstream` against `null`, and
the callback then writes the upgrade request and pipes into a destroyed socket. On an idle stream
no byte ever flows, so nothing raises the error that would tear the upstream down, and the
connection to the home leaks until TCP timeout. The fix belongs in that file: record that the
client is gone and, in the connect callback, destroy the upstream instead of writing when
`socket.destroyed` is already true (both the TLS and the legacy container connect). Routed to the
`124/s05-relay` owner.

**Gates.** `collaboration-direct-client`, `collaboration-direct-hygiene`, `collaboration-client`,
`shared-terminal-controls`, `chat-collaboration-sharing`, `collaboration-terminal-events`,
`collaboration-terminal-websocket`, `collaboration-terminal-control` → **67/67 across 8 files**.
`bun run typecheck` exit 0; `bun run check:patterns` 0 violations, 5 pre-existing warnings. No
React file changed, so react-doctor does not apply.
